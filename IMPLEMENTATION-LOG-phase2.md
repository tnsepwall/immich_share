# Implementation Log — Phase 2: Album Provenance

Tracks work against `FEATURE-PLAN-shared-external-libraries.md`, section 8 "Implementation order," Phase 2:
> **Album provenance**: `album_asset.sourceLibraryId`, the reusable predicate on every §2 read surface, insertion
> precedence, `copyAlbums`, shared-link guards, and sync-stream exclusion.

Builds on Phase 1 (`library_user` sharing, `library_user_role`, direct browse/view/download access — see
`IMPLEMENTATION-LOG-phase1.md`). Status: **complete**, pending the user's review.

---

## 1. What this phase adds

A Viewer or Editor can now add a shared-library asset to **their own** album. The new nullable
`album_asset.sourceLibraryId` column records whether a given album membership row is an ordinary, durable share
(`null`) or a shared-library grant (the exact library id) that stays revocable — if the underlying `library_user`
share is removed, downgraded, or the library is deleted/archived, that specific album_asset row stops granting
access on the *next* request, even though the row itself isn't deleted (other authorized viewers, e.g. the library
owner, keep seeing it).

This is a library-authoritative policy (plan section 2, "Derived album/link access — v1 policy"): album membership
alone no longer implies visibility for a provenance-linked asset — every read surface that enumerates
`album_asset` directly has to re-check the source library, not just the album id.

---

## 2. The core mechanism

**`withAlbumAssetProvenance(userId: string | null)`** — `server/src/utils/database.ts`. A single reusable Kysely
predicate, applied via `.where(withAlbumAssetProvenance(requesterIdOrNull))` on any query that has the real
(unaliased) `album_asset` table in scope. Logic: keep `sourceLibraryId is null` rows unconditionally; for a
non-null row, keep it only when `userId` is the source library's owner or holds an active `library_user` row, the
library and its owner are non-deleted, the asset still belongs to that exact library, and the asset is non-deleted
Timeline visibility. Pass `userId: null` (anonymous shared-link visitors) to drop every non-null row outright —
this is what makes the shared-link defense-in-depth guard (section 5) a one-line call at each read site.

Self-contained by design: it only needs `album_asset` in the surrounding query's scope (correlates via
`album_asset.assetId`/`album_asset.sourceLibraryId`), not a pre-joined `asset`/`library`/`library_user`, so the
same function drops into very different query shapes (CTEs, EXISTS subqueries, lateral joins, plain joins)
without each call site needing its own bespoke version.

---

## 3. Read-side: every surface gated

A dedicated research pass (`grep -rn album_asset server/src`, every hit read and dispositioned — not just the
plan's own list) found **one surface the plan's list missed**: `MapRepository.getMapMarkers`'s `albumIds` branch
(the main map view, not just the per-album map). Every surface below now applies the predicate with the correct
requester identity — critically, **`null` whenever `auth.sharedLink` is set**, never the link creator's
`auth.user.id` (an early mistake here would have silently handed a shared-link visitor the *link creator's*
library access, not their own lack of any):

| Surface | File | Requester identity used |
|---|---|---|
| `checkAlbumAccess`, `checkSharedLinkAccess` (asset) | `access.repository.ts` | `userId` / `null` |
| Timeline album branches (`getTimeBuckets`, `getTimeBucket`) | `asset.repository.ts` | `dto.albumId ? (sharedLink ? null : auth.user.id) : undefined`, threaded via `timeline.service.ts` |
| `downloadAlbumId` | `download.repository.ts` | `auth.sharedLink ? null : auth.user.id`, via `download.service.ts` |
| `getAlbumMapMarkers`, `getMapMarkers` (albumIds branch) | `map.repository.ts` | same pattern, via `album.service.ts#getMapMarkers` / existing `authUserId` param |
| `get()` (public/owner asset+exif enumeration) | `shared-link.repository.ts` | `null` (always anonymous-safe here) |
| `withAssets`, `getMetadataForIds`, `getContributorCounts`, `getByAssetId`, `getByAssetIds` | `album.repository.ts` | `authUserId` / `requestedBy`, threaded via `album.service.ts` (`get`/`getAll` use `auth.sharedLink ? null : auth.user.id` where reachable via shared link, confirmed against the controller's `sharedLink: true` decorators — `getAll` isn't reachable that way, `get`/`getMapMarkers` are) |
| `updateThumbnailBuilder` (automatic cover selection) | `album.repository.ts` | scoped to `sourceLibraryId is null` only — this path has no single requester, so covers are restricted to durable assets rather than gated per-viewer (see section 6) |
| `inAlbums` (search-by-album filter) | `utils/database.ts` | new `requestedBy` field on `AssetSearchBuilderOptions`, set in `search.service.ts` |
| `isNotInAlbum` (search "assets not in any album") | `utils/database.ts` | scoped to `sourceLibraryId is null` so a recipient's own album entry doesn't affect the *owner's* view of their own unsorted assets |
| `AlbumAssetSync`, `AlbumAssetExifSync`, `AlbumToAssetSync` (8 methods total) | `sync.repository.ts` | exclusion, not the predicate — see section 5 |

Confirmed **not** needing a change: `AssetAccess.getAssetIds` (deliberately left unfiltered — see section 4);
Activity (flows through album access checks with no direct `album_asset` join; the FK cascade handles it when a
provenance row is actually deleted).

---

## 4. Write-side: insertion precedence

Three entry points can add an asset to an album (`AlbumService.addAssets` — single album; `addAssetsToAlbums` —
bulk multi-album; `create` — album creation with initial assets), each now split into an **ordinary** path
(`AssetShare`-backed, durable) and a **library-grant** path (`Permission.LibraryAssetAddToAlbum`-backed,
revocable), with one precedence rule enforced at the repository layer regardless of which entry point is used:

- **Ordinary insert always wins.** `addAssetIds` / `addAssetIdsToAlbums` now use
  `ON CONFLICT (albumId, assetId) DO UPDATE SET "sourceLibraryId" = null` — even if a row already exists with a
  library's id (i.e., someone else added it via a shared-library grant earlier), a genuine durable share upgrades
  it to `null` rather than leaving the weaker grant in place.
- **Library-grant insert never overwrites.** `addLibraryAssetIds` / `addLibraryAssetIdsToAlbums` (new) use
  `ON CONFLICT (albumId, assetId) DO NOTHING` — it only ever fills in a genuinely new row.
- **`create()`** takes `{ assetId, sourceLibraryId: string | null }[]` instead of a plain id array; the insert-select
  unnests `assetId` and `sourceLibraryId` as two parallel arrays in the same `SELECT` list (Postgres zips multiple
  `unnest()` calls row-wise — the exact pattern the file already used for the `album_user` insert's
  `userId`/`role` pair, just extended to a third table). No conflict-precedence concern here: a brand-new album has
  no pre-existing rows to collide with.
- **`copyAlbums`** now carries `sourceLibraryId` through its insert-select so duplicating an asset (e.g. RAW+JPEG
  pairing) preserves provenance on the copy instead of silently upgrading it to a durable grant.

**The subtlety a review pass caught before it shipped:** `AssetAccess`/`AlbumRepository#getAssetIds` — used by the
generic `addAssets()` util (shared with memories and tags, so it must **not** learn about provenance) to detect
"asset already in this album" — is deliberately left unfiltered. That's correct on its own, but it meant a genuine
new `AssetShare` grant arriving for an asset that's already present via someone *else's* library grant would get
marked `DUPLICATE` by the generic helper and skipped — the conflict-upgrade above never fires because no insert is
attempted. Fixed with a small, additive repair step in `AlbumService`: after the generic helper runs, any
`DUPLICATE`-marked id the requester has genuine `AssetShare` access to gets an explicit
`AlbumRepository.upgradeProvenanceGrants(albumId, ids)` call (a plain `UPDATE ... SET sourceLibraryId = null WHERE
sourceLibraryId IS NOT NULL`). Same fix applied in the bulk `addAssetsToAlbums` path.

**Ownership gate for the library-grant fallback**, enforced identically in both `addAssets` and
`addAssetsToAlbums`: a library-derived asset may only land in an album the requester **owns** — being an Editor of
the album is not enough — checked via `AccessRepository.album.checkOwnerAccess` directly (bypassing the broader
`AlbumShare`/`AlbumAssetCreate` permission unions, which include Editors). It's also blocked outright when the
target album already has a shared link (`album.sharedLinks.length > 0`), per the shared-link guard below.

**API-key nuance:** the existing album-add endpoints are guarded by `Permission.AlbumAssetCreate`. An API key
holding only that permission must not ride the new library-grant fallback. `AlbumService#resolveLibraryAlbumGrants`
(the shared helper both entry points call) checks `auth.apiKey` and requires the key's own permission list to
grant `Permission.LibraryAssetAddToAlbum` explicitly before even attempting the asset-level check.

---

## 5. Shared-link guards

Per the plan's "library-authoritative" policy, an album can have a shared link *or* provenance-linked assets, never
both — whichever exists first blocks the other:

- **Creating** an album shared link (`SharedLinkService#create`) now checks the new
  `AlbumRepository#hasProvenanceAssets(albumId)` and rejects with 400 if the album contains any non-null row.
- **Adding** a library-derived asset into an album that already has a shared link is blocked in
  `AlbumService#addAssets`/`#addAssetsToAlbums` (the `hasSharedLink` check alongside the ownership gate above) —
  reported the same way any other authorization failure in these bulk endpoints is: a per-asset `NO_PERMISSION`
  result rather than a request-level exception, consistent with how these endpoints already report every other
  per-id failure. The row is never written either way; this is a reporting-shape choice, not a security gap.
- **Defense in depth on the read side:** `SharedLinkRepository#get()` (the enumeration itself) additionally applies
  `withAlbumAssetProvenance(null)`, so even a hypothetical bug in the write-time guards above would still stop a
  provenance row from surfacing to an anonymous visitor.

---

## 6. Deliberate scope decisions / minor follow-ups

- **`updateThumbnailBuilder`** (automatic album-cover selection) is a background/requester-less operation, so it
  can't be gated per-viewer. Restricted its candidate pool to `sourceLibraryId is null` assets only — an album
  whose only content is library-derived shows no auto-selected cover until a durable asset exists or an owner
  manually picks one. This is a UX consequence (a very sparse shared-only album has no thumbnail), not a security
  issue; not fixing this would have risked a cover chosen from an asset most album members can't actually open.
- **`getByAssetId`/`getByAssetIds`** (album.repository.ts) got the predicate applied for consistency (an asset's
  "which albums is this in" listing), though these are lower-traffic, lower-severity surfaces than the others.
- Mobile sync for the album-provenance exclusion **is** in scope for v1 (per the plan's explicit carve-out) and is
  done — the follow-up that's still deferred is full sync *support* for shared libraries themselves (Phase 1's own
  "Out of scope" list), unaffected by this phase.

---

## 7. Verification performed

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | ✅ clean |
| Lint (eslint, `--max-warnings 0`) | ✅ clean |
| New/updated unit tests (album, shared-link, timeline share-CRUD + provenance) | ✅ all pass |
| Full unit suite | 2198 passed / 72 failed / 2 skipped — all 72 reproduce the same pre-existing Windows-vs-POSIX path-separator issue documented in `IMPLEMENTATION-LOG-phase1.md` §3, in the same class of files (storage/media/transcoding/backup/auth/user-management — none touch albums, libraries, or sharing). Every file Phase 2 actually changed passes 100%. |

Three implementation sub-tasks were originally delegated to parallel background agents (download/map surfaces,
album-repository write-path, sync-stream exclusion); two hit a session-wide API rate limit mid-task. The
download/map agent had already fully completed and verified its work before being cut off (confirmed via `git
diff` — clean, correct, matched the spec exactly) and needed no rework. The album-repository agent made zero file
changes before being cut off, so that work (the bulk of section 4 above) was implemented directly instead. The
sync-stream agent completed successfully end-to-end.

**Security review:** an adversarial review pass specifically targeting this phase's provenance access control —
the predicate itself, every read surface's requester-identity argument, the write-side precedence rules, the
ownership gate on the library-grant fallback, the API-key nuance, and the shared-link guards. It tried to
construct concrete exploits for: third-party album members or anonymous visitors seeing a provenance row through
any surface including aggregates; revocation not taking effect on the next request; access laundering via
re-sharing or shared-link creation; precedence bugs in either direction; `getAssetIds`'s deliberate lack of
filtering causing an incorrect authorization decision (not just a UX quirk); an Editor or an under-scoped API key
reaching the library-grant fallback; and a migration/decorator mismatch.

**Result: zero confirmed vulnerabilities** — every one of those was traced end-to-end and found correctly blocked.
Two informational (non-security) notes it raised:

- **SQL snapshots are stale** (`server/src/queries/*.sql` — e.g. `checkAlbumAccess.sql` still shows the
  pre-change query). This is the same category as Phase 1's known limitation: these snapshots are generated by
  `mise //:sql` against a live Postgres, which wasn't available in this environment. It doesn't affect runtime
  correctness (Kysely generates real SQL from the TypeScript that was actually reviewed), only CI, which will
  fail on this until the snapshots are regenerated.
- **The shared-link/provenance mutual exclusion is non-transactional.** `SharedLinkService.create` and the
  album-add path each read-then-write without a lock, so a concurrent "create a link" + "add a provenance asset"
  interleaving could leave an album holding both at once. The reviewer confirmed this causes **no actual data
  exposure**: every anonymous/public read path (`checkSharedLinkAccess`, `shared-link.repository.ts#get`, and
  `requestedBy: null` on the timeline) independently drops provenance rows regardless of this race, so the
  invariant is enforced redundantly on the read side even if the write-time race is lost. Left as a documented
  follow-up (a DB-level constraint or explicit transaction/row-lock would close the race itself) rather than fixed
  now, since it doesn't change what any user can actually see.

---

## 8. Not in this phase (per the plan's phase split)

`sidecarWriteProperties` split, the transactional metadata primitive, editor metadata endpoints → **Phase 3**.
Person/face editor endpoints, all web UI (sharing hub, browse page, i18n, docs) → **Phase 4**. The OpenAPI
spec/SDK still haven't been regenerated (carried over from Phase 1's same limitation — no live server boot was
possible in this environment).

## 9. Suggested next step

Phase 3 ("Editor metadata") per the plan: the `sidecarWriteProperties` column split, the transactional
database-only metadata-update primitive, metadata-extraction changes so locked date/timezone values survive a
re-scan, and the Editor's allowlisted metadata endpoints. Recommend running the deferred migration generation and
medium/e2e tests (both phases now have hand-written, DB-unverified migrations) before or alongside starting Phase
3.
