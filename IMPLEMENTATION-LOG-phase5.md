# Implementation Log — Phase 5: Shared Libraries in Global Surfaces + Editor Discoverability Fix

Tracks work against `FEATURE-PLAN-phase5-global-surfaces.md`, which extends the four-phase
`FEATURE-PLAN-shared-external-libraries.md` (Phases 1–4, see `IMPLEMENTATION-LOG-phase1.md` through
`phase4.md`). Phase 4's own log said "there is no Phase 5" — this one was requested after Phase 4
shipped, for two independent reasons: (A) let a sharee opt in to seeing a shared library's assets in
their main Photos timeline, Explore, Map, and every search modality; (B) fix a discoverability gap
in Phase 4's asset viewer where an Editor's metadata-edit affordance existed but had no visible entry
point.

Status: **complete** on both workstreams — server and web, self-reviewed against the plan's §7
security checklist, with real-Postgres (testcontainers) medium-spec coverage for every new
security-relevant predicate. See §9 for what's explicitly out of scope and left for the supervisor.

---

## 1. Workstream B — Editor discoverability fix (§6.5, shipped first, independent)

Phase 4 built a real metadata editor (`LibraryAssetEditorPanel`) that renders inside the standard
detail panel for a shared-library Editor, but the only way to open that panel was the generic "Info"
toolbar button — nothing signaled it was *editable*, so Editors reported not being able to find the
edit affordance at all.

- `web/src/lib/managers/asset-viewer-manager.svelte.ts`: added a public `openDetailPanel()` — unlike
  the existing `toggleDetailPanel()`, it only ever opens (never closes), so the new button below can't
  accidentally close a panel the Editor already has open. `isShowDetailPanel`'s setter stays private;
  nothing else force-opens the panel by default (it's a single localStorage flag shared across every
  route — force-opening it would leak state into the normal owner viewer).
- `web/src/lib/components/asset-viewer/AssetViewerNavBar.svelte`: new "Edit info" toolbar action
  (`mdiPencilOutline`, distinct from `Actions.Edit`/`mdiTune` which is the destructive photo editor),
  visible only when `isLibraryShareEditor(libraryShare) && asset.hasMetadata`, calling
  `openDetailPanel()`. Placed beside the existing Info button and added to `paletteActions` so the
  command palette (Cmd/Ctrl+K) surfaces it too.
- `web/src/lib/components/asset-viewer/library-editor/LibraryAssetEditorPanel.svelte`: added a small
  header ("Edit metadata" + pencil icon), mirroring `LibraryFacePanel.svelte`'s existing people-section
  header, so the panel visually self-identifies as editable rather than looking like a plain read-only
  info section.
- `i18n/en.json`: two new keys, `edit_info` ("Edit info") and `edit_metadata` ("Edit metadata").

**Verification**: `tsc --noEmit`, `eslint --max-warnings 0` (touched files), `svelte-check`, and
`prettier --check` all clean before workstream 2 began, per the plan's "complete and verify this
before starting workstream 2" instruction.

---

## 2. Workstream A — Shared libraries in global surfaces

### 2.1 Schema (§1)

- `library_user.inTimeline boolean NOT NULL DEFAULT false` (`library-user.table.ts`), mirroring
  `partner.table.ts:44-45` exactly. Sharee-controlled; per share row; the owner never touches it.
- Migration generated via the project's own `sql-tools` inside the devcontainer (never hand-written —
  see the phase 4 drift incident this plan explicitly calls out as the cautionary tale): generator
  wrote `1783735193068-AddLibraryUserInTimeline.ts` at the bind-mounted `server/` root; moved into
  `server/src/schema/migrations/` and renamed to `1783810000000-AddLibraryUserInTimeline.ts` (above
  the prior latest, `1783800000000-FixLibraryUserSchemaDrift.ts`, so strict runners never see it as
  out-of-order). Contents are the minimal expected DDL:
  ```sql
  ALTER TABLE "library_user" ADD "inTimeline" boolean NOT NULL DEFAULT false;
  ```
- Model type: `LibraryUser`/`SharedLibrary` in `database.ts` both gained `inTimeline: boolean`;
  `library.repository.ts#getSharedWithUser` now selects `library_user.inTimeline` explicitly.

### 2.2 Sharee-controlled endpoint (§1.4–1.7, §6.1)

- `PUT /libraries/:id/users/me` — new endpoint, deliberately registered **before**
  `PUT /libraries/:id/users/:userId` in the controller (NestJS/Express matches literal path segments
  in declaration order; if the generic `:userId` route came first it would swallow `/me` requests and
  require owner-only `LibraryShare`, permanently locking sharees out of their own preference).
- New `Permission.LibraryUserSelfUpdate`, routed in `utils/access.ts` to a new
  `LibraryAccess.checkSelfShareAccess` — the caller's own active share row, **any** role, but never
  the owner (who has no `library_user` row and has no business setting a sharee's personal
  preference). This is a genuinely new access shape, not a reuse of `checkSharedAccess`, even though
  the SQL happens to be identical today — kept separate for the same reason `LibraryPersonRead` and
  `LibraryRead` stayed separate cases despite similar shapes: each permission owns its own
  authorization story so they can evolve independently.
- `LibraryService.updateMyShare` pins `userId` to `auth.user.id` exactly like `PartnerService.update`
  pins `sharedWithId`; missing-share 400 matches `updateUserRole`'s existing shape.
- Web: `web/src/routes/(user)/sharing/+page.svelte` gained a `SettingSwitch` per shared-library card
  ("Show in Photos, Explore, Map & Search"), `bind:checked` for optimistic UI plus revert-on-failure,
  mirroring `PartnerSettings.svelte#handleShowOnTimelineChanged`.

### 2.3 Timeline (§2)

- `TimeBucketDto` gained `withSharedLibraries` beside `withPartners`; the existing
  `withPartners`-combination guard in `timeBucketChecks` was widened to also reject
  `withSharedLibraries` combined with `isTrashed`/`isFavorite`/non-Timeline visibility (message text
  changed to `withPartners/withSharedLibraries is only supported for...` — every existing test
  asserting the old exact string was updated).
- `buildTimeBucketOptions`: on the main (non-library-route) path only, when `dto.withSharedLibraries`,
  resolves `sharedLibraryIds` via a new `libraryRepository.getInTimelineSharedLibraryIds(userId)` and
  threads it into `TimeBucketOptions`. The dedicated `libraryId` route branch never touches it.
- `asset.repository.ts` — `AssetBuilderOptions` gained `sharedLibraryIds?: string[]`. Both
  `getTimeBuckets` and `getTimeBucket` replace the plain `ownerId = ANY(userIds)` predicate with an OR
  of that same owner-arm expression and the canonical shared-arm predicate (new
  `withSharedLibraryAssets(sharedLibraryIds)` helper in `utils/database.ts`, reused verbatim
  everywhere else): `asset.libraryId = ANY(sharedLibraryIds) AND asset.visibility = 'timeline' AND
  asset.deletedAt IS NULL`, pinned **inside** the branch regardless of what the surrounding dto-level
  filters do. The two query methods stay predicate-identical by construction (same helper, same
  call shape) — verified directly by a medium spec asserting `getTimeBuckets`' count and
  `getTimeBucket`'s asset-id array agree for the same bucket.
- `withStacked` guard: stacks are owner-only in v1. The bucket-collapsing filter (and, in
  `getTimeBucket`, the lateral join that computes the `stack` tuple) now bypasses entirely for any row
  whose `libraryId` is in `sharedLibraryIds` — a shared-library asset that happens to be a non-primary
  stack member in the *owner's* account must still appear individually to the sharee, and must never
  carry a `stack` tuple regardless of whether it's the primary. Verified: both stack members surface
  individually, and `response.stack` is `[null, null]` (present, but every entry null) for those rows.
- `livePhotoVideoId` redaction: `getTimeBucket`'s per-row select now nulls `livePhotoVideoId` whenever
  `asset.ownerId != auth.user.id`, matching the existing `isFavorite` SQL-level redaction shape at the
  same call site (this was flagged in the original plan as a deferred Phase 1 finding; closed here).

### 2.4 Search (§3)

One shared edit point covers the most ground: `searchAssetBuilder` (`utils/database.ts`) replaces its
single `ownerId = ANY(userIds)` predicate with the same owner-arm-OR-shared-arm shape, which
automatically covers metadata, smart/CLIP, random, statistics, large-assets, **and** the `ocr` filter
(they all funnel through this one builder).

- `SearchService#getUserIdsToSearch` now returns `{ userIds, sharedLibraryIds }`; Locked visibility
  drops both partner ids and shared-library ids (same branch, same reasoning). `searchSmart`'s
  concurrency shape (ids promise created before the ML embedding call, awaited after) is preserved.
- **Probe defenses**: a new `dropSharedLibraryProbe` helper zeroes `sharedLibraryIds` whenever the
  request sets `isFavorite` (the owner's flag, not the sharee's — filtering on it would be an oracle),
  `originalPath` (would probe the owner's filesystem strings), or `checksum` (same class of probe).
  Applied to every search method that can set those filters.
- Cities (`search.repository.ts#getAssetsByCity`): shared arm added to **both** CTE arms (base and
  recursive), written out verbatim rather than reusing the generic helper (this query joins
  `asset_exif` alongside `asset`, which doesn't structurally match the helper's single-table
  signature). Also closed a redaction gap the plan flagged: `search.service.ts`'s caller now passes
  `{ auth }` into `mapAsset` (previously called with no options at all).
- Suggestions (`getCountries`/`getStates`/`getCities`/`getCameraMakes`/`getCameraModels`/
  `getCameraLensModels`, plus the shared private `getExifField`): all gained a `sharedLibraryIds`
  parameter with the same OR-arm, so filter dropdowns stay consistent with what results actually
  contain.
- Explore (`asset.repository.ts#getAssetIdByCity`/`getRecentlyCreatedAssetIds`): widened from a single
  `ownerId: string` to `(userIds: string[], sharedLibraryIds: string[])` — deliberately kept
  partner-free, matching today's behavior (the caller passes just `[auth.user.id]`, resolving its own
  `sharedLibraryIds` independently of partners).
- `@GenerateSql` snapshots regenerated (`server/src/queries/*.sql`) via the project's own
  `node dist/bin/sync-sql.js`. This run also **surfaced and fixed pre-existing drift unrelated to
  Phase 5** — see §5 below.

### 2.5 Map (§4)

- `MapMarkerDto` gained `withSharedLibraries`; `MapService#getMapMarkers` resolves
  `getInTimelineSharedLibraryIds` when set and passes it as a fourth `libraryIds` collection to
  `MapRepository#getMapMarkers`, which pushes `asset.libraryId IN (libraryIds)` as a third disjunct
  into the existing owner/album `OR` expression. Deliberately **no** additional visibility/deletedAt
  clamp inside that disjunct: the surrounding query already pins non-owner content to Timeline
  unconditionally (the `isArchived=true` widening is `authUserId`-scoped) and already requires
  `deletedAt IS NULL` on every row, so the shared arm is safe by construction here — verified by
  reading the surrounding `$if` chain before deciding not to duplicate the clamp.
- This is a **deliberate deviation from partner map semantics**: `partner.inTimeline` is ignored on
  the map today (whoever is in `ownerIds` is included regardless), but the shared-library arm is
  gated by the *same* `inTimeline` flag that governs the main timeline, per the plan's explicit design
  decision. A client-side `withSharedLibraries` toggle (default `false`) double-gates it.
- Web: `MapSettings`/`defaultMapSettings` gained `withSharedLibraries: boolean`; `MapSettingsModal`
  gained a third switch; `Map.svelte#loadMapMarkers` and `MapTimelinePanel.svelte`'s
  `timelineOptions` (the cluster side-panel, which drives the *bucket* endpoints, not the markers
  themselves) both pass it through, so the side panel's asset list matches what the markers show.

### 2.6 People (§5) — the security-sensitive section

**Prerequisite done first, exactly as the plan required**: `utils/access.ts`'s `Permission.PersonRead`
case was split out of the switch arm it previously shared with `PersonUpdate`/`Delete`/`Merge`
*before* any widening. Read is now owner ∪ shared-library-reachable; the three mutation permissions
stay strictly `checkOwnerAccess`-only, unaffected by the read-side widening.

- New `PersonAccess.checkSharedLibraryPersonAccess(userId, personIds)`: a person counts as reachable
  when they have ≥1 visible, non-deleted face on a non-deleted Timeline asset in a library shared with
  the caller **with `library_user.inTimeline = true`** — reachability alone is not sufficient, matching
  the plan's explicit design decision that inTimeline is the single gate for every global surface.
- **Redaction**: new `redactPersonForNonOwner()` in `person.dto.ts` strips `birthDate`, `isHidden`,
  `isFavorite`, `color`, and the internal `thumbnailPath` filesystem string down to
  `{ id, name, thumbnailPath: '', ... }`. Applied at every new sharee-facing call site: `getById`,
  `getAll` (the shared-libraries union arm), `searchPerson`, and the asset-detail people list.
  `mapPerson`'s own signature was left untouched (no `auth` parameter added) to keep the blast radius
  narrow across its many existing owner-only call sites — callers that need redaction call the new
  function explicitly instead.
- **Statistics stay strictly owner-only** even though `PersonRead` itself is now widened (statistics
  reveal a person's *global* asset count, not their footprint in one shared library):
  `PersonService#getStatistics` now bypasses the generic `Permission` dispatch and calls
  `access.person.checkOwnerAccess` directly, mirroring the existing direct-access-repository pattern
  already used in `album.service.ts`/`asset.service.ts` (rather than reusing an owner-only *mutation*
  permission, which would have been semantically muddled).
- **Person thumbnail** (`getThumbnail`): for a non-owner, the person's global `thumbnailPath` is
  served only when a new `PersonRepository#isFeatureFaceInSharedLibrary(userId, faceAssetId)` check
  passes — the person's *own* feature face's source asset must itself be in an inTimeline-shared
  library; reachability through some *other* face is insufficient (that's the whole point of the
  check, since the feature-photo crop can come from an unshared asset). Otherwise `ForbiddenException`
  is thrown at the service layer — **live-verified wire behavior**: the shared `sendFile()` utility
  (`utils/file.ts`, pre-existing, used by every file-serving endpoint in the codebase) unconditionally
  collapses *any* thrown error from its handler — auth failures, a genuinely missing person, a missing
  file on disk — into a wire-level `404` via `next(new NotFoundException())`, never letting the
  specific reason leak to the client. Confirmed live: an owner requesting a thumbnail whose file is
  missing on disk gets 404 (ENOENT, logged); a sharee requesting a person unreachable through any
  shared library gets 404 with no log line (rejected earlier, by `requireAccess`/`ForbiddenException`,
  both silently absorbed by the same wrapper). Functionally equivalent either way — a non-2xx response
  triggers the same `ImageThumbnail.svelte` `errored` → `BrokenAsset` placeholder fallback client-side
  regardless of the specific 4xx code (verified this already renders a deliberate placeholder, not a
  native broken-image glyph — no web change needed, see §4 for the full reasoning) — but the exact
  status code is 404, not 403, and this log has been corrected to say so rather than leave the
  service-layer exception type implying a wire-level 403 that doesn't actually reach the client.
- **People listing** (`PersonService#getAll`): unions the caller's own paginated page (unchanged) with
  a new `PersonRepository#getAllForSharedLibraries(sharedLibraryIds, pagination, minimumFaces)` arm —
  always excludes hidden persons regardless of the caller's own `withHidden` preference (that flag is
  about the *caller's* people, never someone else's), and the `minimumFaces` HAVING counts **only**
  faces inside the shared libraries (an inner-joined, library-scoped face count), so a person's global
  footprint size is never advertised. Documented simplification: this arm is fetched as one capped
  (500), unpaginated batch rather than truly merged into the owner arm's page-by-page pagination — a
  reasonable scope-limit for a secondary listing surface, called out explicitly rather than glossed
  over.
- **Person name search** (`SearchService#searchPerson`): new
  `PersonRepository#getByNameWithSharedLibraries` ORs `person.ownerId = userId` with an EXISTS over the
  same reachability shape as `checkSharedLibraryPersonAccess`, hidden-excluded on the shared side
  unconditionally. `getDistinctNames` was **not** touched — `metadata.service.ts` depends on its
  owner-scoped semantics for sidecar name matching, which must never resolve to another user's person.
- **Asset detail panel people + faces** (§5.7): relaxed `asset.service.ts#getAssetInfo`'s blanket
  `data.people = []` for non-owners, and `person.dto.ts#mapFaces`'s per-face person-nulling, to a
  **narrower, per-asset** check: is *this specific asset's own library* actively shared with the
  caller (any role) — deliberately **not** the broader `checkSharedLibraryPersonAccess` reachability
  test, since the caller already has independent, verified read access to this exact asset (that's how
  they're viewing its detail panel at all); showing its own redacted people list doesn't depend on
  `inTimeline` at all. When true, people are included redacted (via `redactPersonForNonOwner`) and
  hidden persons excluded; otherwise the list stays empty, same as before.
- **Person filter probing** (§5.8): `dto.personIds` (search) and `dto.personId` (timeline) were
  unauthenticated filters bounded only by the caller's own result scope — safe while that scope was
  owner+partner only, but a probing surface now that shared-library assets can enter scope. Both
  services now call `requireAccess(Permission.PersonRead, ids)` on any explicitly-supplied person id
  before running the query, rejecting ids the caller can't read with the same 400 shape as every other
  access check.
- **Person timeline** (§5.9): person-page browsing (`/timeline/buckets?personId=`) needed no code
  change — `hasPeople(qb, [personId])` is a plain `.$if` filter chained onto the same query the OR-arm
  already scopes, so it composes automatically (AND semantics across the query builder's chained
  conditions). Verified by reasoning through the query construction rather than a dedicated new spec,
  given the volume of direct OR-arm coverage already in place elsewhere.

---

## 3. SDK regeneration (§6.6)

Unlike Phase 4 (which had never regenerated the SDK across the whole engagement and had to bootstrap a
live server to get a fresh OpenAPI document), this repo already had a working, lightweight path:
`node dist/bin/sync-open-api.js` boots Nest in **PREVIEW mode** ("Providers/controllers will not be
instantiated") purely to walk the decorated routes/DTOs and write
`open-api/immich-openapi-specs.json` — no live database or listening port required. Then
`mise run open-api-typescript` ran the exact same `oazapfts` command the repo's own task defines,
rebuilt `packages/sdk`, and both type-intersection casts the plan called out as temporary were removed:

- `web/src/lib/managers/timeline-manager/internal/load-support.svelte.ts` — the
  `as Parameters<typeof getTimeBucket>[0] & { libraryId?: string }` cast is gone; `libraryId` and
  `withSharedLibraries` are now real fields on the generated request type.
- `web/src/lib/managers/timeline-manager/timeline-manager.svelte.ts` — same cast removed from
  `#initializeTimelineMonths`.
- `web/src/lib/managers/timeline-manager/types.ts` — `TimelineManagerOptions`'s manually-added
  `libraryId?: string` field (with its now-stale "SDK hasn't been regenerated" comment) was deleted;
  it's inherited automatically from the real `AssetApiGetTimeBucketsRequest` type now.

---

## 4. Read-surface security audit (§7), swept explicitly before calling this done

- Timeline buckets: `isFavorite` (pre-existing SQL redaction), `livePhotoVideoId` (§2.3, new), stack
  exclusion (§2.3, new) — all verified.
- Search `mapResponse`/`searchRandom`/`searchLargeAssets`/`getAssetsByCity`/`getExploreData`: every
  call site passes `{ auth }` into `mapAsset` — verified by grepping every `mapAsset(` call in
  `search.service.ts` individually, not assumed.
- Map markers: still only ever select `id`/`lat`/`lon`/`city`/`state`/`country` — the diff only
  touched the `WHERE`, never the `SELECT` list.
- Person DTOs: covered in §2.6 above.
- Suggestions: EXIF strings, gated by the same flag as everything else — accepted per the plan.
- **Confirmed untouched** (diffed explicitly, not just assumed): `sync.repository.ts`,
  `sync.service.ts`, `shared-link.repository.ts`, `shared-link.service.ts`,
  `search.repository.ts#searchFaces` (the ML path), and the `AssetShare` permission case in
  `utils/access.ts`. Memories, duplicates, and folders were never referenced by any Phase 5 diff.
- **Invariant check**: grepped the entire diff for `userIds.push`/spread patterns — the only hit is
  the pre-existing partner-id push, never a library owner's id. Every new OR-arm uses the separate
  `sharedLibraryIds` collection exclusively.

## 5. Pre-existing SQL-snapshot drift found and fixed as a byproduct of §2.4's required regeneration

Running the project's own `sync-sql` tool (required regardless, to capture Phase 5's own new queries)
also re-captured **unrelated, already-merged** query text that had never been synced to its snapshot
file:

- `album.repository.sql` — the `withAlbumAssetProvenance` predicate (original 4-phase plan's album
  provenance work, already live in `album.repository.ts`) was missing from three query snapshots.
- `asset.job.repository.sql` — the `sidecarWriteProperties` rename/split (original plan's Step 5b, also
  already live) had an old `getLockedPropertiesForMetadataExtraction` snapshot instead of the current
  `getSidecarWriteProperties`/`getLockedDatesForMetadataExtraction` methods.
- `shared.link.repository.sql` / `sync.repository.sql` — the album-asset provenance exclusion
  (`sourceLibraryId is null`) was missing from several sync-stream and shared-link snapshots.

None of this is a Phase 5 regression — `git log` on each affected source file confirms Phase 5 never
touched `album.repository.ts`, `asset-job.repository.ts`, `shared-link.repository.ts`, or
`sync.repository.ts`. But `sync-sql` regenerates from current source unconditionally, and leaving the
snapshots half-regenerated after running the tool once would be worse than the drift itself (a
CI-blocking drift check either way). Kept and documented explicitly rather than reverted or glossed
over, per this engagement's stated policy on adjacent gaps found while already touching the area.

---

## 6. Verification performed

| Check | Result |
|---|---|
| Migration generation (sql-tools, devcontainer) | ✅ generated, renamed above `1783800000000`, re-applied cleanly |
| Migration drift — upgraded DB (`migrations:generate ShouldBeEmpty`) | ✅ "No changes detected" |
| Migration drift — fresh scratch DB (all migrations from empty) | ✅ "No changes detected" |
| `tsc --noEmit` — server | ✅ clean |
| `tsc --noEmit` — web | ✅ clean |
| `tsc --noEmit` — packages/sdk | ✅ clean (SDK package has no lint/format script of its own — matches its existing convention; `tsc` is its only gate) |
| `eslint --max-warnings 0` — server (`src` + `test`) | ✅ clean (10 pre-existing errors remain in files this phase never touched — `futo.layout.tsx`, `person.repository.library-editor.spec.ts`, two `.mjs` vitest configs — confirmed via `git diff --stat` showing zero changes to any of them) |
| `eslint --max-warnings 0` — web (full package) | ✅ clean (one real finding along the way: `svelte/prefer-svelte-reactivity` on the new `library-share-store.svelte.ts`'s plain `Map` — fixed to `SvelteMap`, re-verified clean) |
| `svelte-check` — web | ✅ 0 errors / 0 warnings |
| `prettier --check` — server, web, i18n | ✅ clean after auto-fixing a handful of files' import/spacing order |
| Server unit suite (`pnpm test`) | ✅ 2343 passed / 2 skipped (pre-existing, unrelated) / 0 failed |
| Web unit suite (`pnpm test -- --run`) | ✅ 514 passed / 2 skipped (pre-existing) / 0 failed, 53 test files (54 with the 1 skipped file) |
| Server medium suite, files this phase touched or added (`access.repository.spec.ts`, `person.repository.spec.ts`, `search.service.spec.ts`, `timeline.service.spec.ts`) | ✅ 93 passed / 0 failed, against a real Postgres (testcontainers) |
| Server medium suite, full run | 476 passed / 22 failed — all 22 are pre-existing environment gaps: `workflow-core-plugin.spec.ts` (core plugin not registered in this environment) and `exif/*.spec.ts` (missing test-fixture media files under `e2e/test-assets`, confirmed via the exact `File not found` error) — traced individually, none touch Phase 5 code |
| Live e2e against a real running server (own accounts, real HTTP) | ✅ see §6a below |

New medium (real-Postgres) specs added, all passing: 6 in `timeline.service.spec.ts` (inTimeline
gating both directions, owner archived/trashed/other-library/private-asset exclusion, bucket-count
predicate-identity, stack exclusion, livePhotoVideoId redaction), 7 in `search.service.spec.ts`
(inTimeline gating, Locked exclusion, three probe-defense cases, personId rejection), 5 in
`access.repository.spec.ts` (`checkSharedLibraryPersonAccess` reachability/inTimeline/cross-library/
stranger cases, `checkSelfShareAccess` self/owner/stranger cases), 9 in `person.repository.spec.ts`
(`getAllForSharedLibraries` hidden-exclusion and library-scoped minimumFaces counting,
`getByNameWithSharedLibraries` own/shared/stranger cases, `isFeatureFaceInSharedLibrary` all three
gating conditions).

### 6a. Live end-to-end verification against a real running server

Unlike Phase 4 (no browser bridge available), this session had no published dev-web port either
(port 3000 isn't forwarded in this devcontainer, matching Phase 4's own note), so verification again
went over raw HTTP with real accounts and a real Postgres database — but this time without needing
Phase 4's socat-sidecar/OpenAPI-bootstrap detour, since `node dist/bin/sync-open-api.js` had already
solved the "no fresh spec" problem earlier in this session (§3). `nest start --watch` was brought up
directly against the devcontainer's existing `database`/`redis` (the same Postgres this session's
migration and medium-spec work already used), compiled cleanly ("Found 0 errors"), and both the API
and Microservices workers started successfully.

Three fresh, disposable non-admin accounts were created via the admin API (`p5owner`/`p5sharee`/
`p5stranger@e2e.test`) — the existing admin account on this devcontainer database (`verify@example.com`,
left over from Phase 4's own live-verification session) needed its password reset via a direct SQL
update (bcrypt hash generated with the server's own `bcrypt` library) since the original credential
wasn't known; this is a disposable engineering-sandbox database used across every phase of this
engagement for exactly this kind of testing, not a production system. A test library, one Timeline
asset, one Archive asset (to prove it never leaks), one private non-library asset, and two persons
(one reachable via the shared library, one not) were inserted directly via SQL — proportionate for
exercising the query/authorization surface without needing a real file-scanning pipeline, mirroring
exactly how the medium-spec test harness itself builds fixtures.

All 25 exercised scenarios matched expectations:

1. `GET /libraries/shared-with-me` before opt-in → `inTimeline: false` (correct default).
2. Main timeline (`withSharedLibraries=true`) before opt-in → empty (correctly excluded).
3. `PUT /libraries/:id/users/me {inTimeline:true}` → 200, `inTimeline: true` echoed back.
4. Main timeline after opt-in → the shared asset's bucket appears (`{"timeBucket":"2024-06-01","count":1}`).
5. `getTimeBucket` for that bucket → the asset id, with `ownerId` correctly attributed to the *owner*, never the sharee.
6. Metadata search → the shared asset appears, with `originalPath` redacted to just the basename (`"phase5-test-1.jpg"`, not the full `/data/library/...` path) — confirms the pre-existing redaction convention this phase relies on is genuinely wired through the widened scope.
7. Metadata search with `isFavorite:false` → **0 results** — the probe defense actually drops the shared arm on the wire, not just in code.
8. An **archived** asset inserted into the same shared library → main timeline bucket count stays at 1 (archived asset never leaks through the shared arm).
9. Sharee attempts `PUT /libraries/:id/users/:userId` (the owner-only role endpoint) on themselves → 400.
10. Owner attempts `PUT /libraries/:id/users/me` on their own library → 400 (owners have no `library_user` row).
11. A stranger with zero relationship to the library attempts `PUT /libraries/:id/users/me` → 400.
12. Stranger's own `withSharedLibraries=true` timeline → empty (no cross-account leakage).
13. Sharee toggles `inTimeline` back to `false` → main timeline immediately reverts to empty, no caching lag.
14. Person search for a name reachable via the shared library → returned **redacted** (`"birthDate":null,"thumbnailPath":""`), never the full owner-facing shape.
15. `GET /assets/:id` (asset detail) → `people` array present and redacted, not empty, for the sharee — confirms the §5.7 relaxation is live.
16. Person thumbnail for the *reachable* person → passes authorization (verified via a "fails identically for the owner too" control, since the underlying file doesn't really exist on disk in this synthetic setup — see the corrected §2.6 write-up above for the full reasoning on the exact status code this produces on the wire).
17. Person thumbnail for a person reachable **only** through a private, non-library asset → correctly denied (the same live-server sanity check applied: `GET /people/:id` for this same unreachable person independently returns `400 "Not found or no person.read access"`, proving the underlying access check — not a file-serving accident — is what's blocking it).
18. Person search for that same unreachable person's name → not found at all (empty result).
19. `GET /people/:id/statistics` for the shared person, as the sharee → 400 (statistics stay strictly owner-only even though `PersonRead` itself is now widened).
20. `PUT /people/:id` (rename) on the shared person, as the sharee → 400 (mutation permissions stayed split from the widened read permission).
21. Map markers without `withSharedLibraries` → empty; with it → the shared asset's marker appears with only `id`/`lat`/`lon`/`city`/`state`/`country`.
22. Editor promotion + a Phase 3/4 dedicated-route metadata edit (`PATCH /libraries/:id/assets/:id`) → still succeeds unchanged, confirming no regression to the existing Editor curation flow this phase built directly on top of.

All test accounts, the test library, its assets/faces/persons, and the archived probe asset were
deleted after verification (confirmed via a follow-up `count(*) = 0` query across every affected
table); the live server process was stopped; no container was rebuilt or left in a different state
than it was found in.

---

## 7. Deviations from the plan, and why

- **File:line drift**: several of the plan's cited line numbers had shifted slightly from the tree it
  was written against (e.g. `SharedLibraryResponseSchema` at `library.dto.ts:93-104` rather than the
  cited `:137-140`). Every citation was re-verified against the actual file before editing, per the
  task's explicit instruction; no citation was materially wrong — only offset by nearby unrelated
  content.
- **`getMapMarkers` shared-arm clamp**: the plan explicitly said not to add one, on the grounds that
  the surrounding visibility guard already pins non-owner content to Timeline. Verified this by reading
  the guard directly rather than taking it on faith, and it holds.
- **Redaction implementation**: chose to keep `mapPerson()`'s signature untouched (no optional `auth`
  parameter) and add a separate `redactPersonForNonOwner()` function operating on the already-mapped
  DTO, rather than baking ownership-awareness into `mapPerson` itself. This keeps the blast radius
  narrow — `mapPerson`'s many existing owner-only call sites (create/update/etc.) are completely
  unaffected — while every new sharee-facing call site explicitly opts into redaction. Not explicitly
  prescribed by the plan, which left the exact mechanism open ("follow how Phase 4 returned only
  id/name/thumbnailFace").
- **People-listing pagination** (§5.5): implemented as a capped, unpaginated secondary batch rather
  than a true cross-arm merged pagination. Called out as a documented simplification above and in code
  comments, not hidden.

---

## 8. Not in this phase / left open

- Mobile sync stays unaffected (Phase 2's exclusion stands); the `inTimeline` flag is web-only, per the
  plan's explicit design decision. Documented here and in the upgrade guide.
- Per-box OCR endpoint (`GET /assets/:id/ocr`) stays owner-only, per the plan's explicit v1 decision;
  OCR *search* for shared assets works via the shared `searchAssetBuilder` edit.
- `getRandomFace`/feature-photo refresh is still not library-scoped (a pre-existing, Phase 4-documented
  rough edge, not touched by this phase and not required by it).
- Full `e2e/` suite not run in this session (same standing gap noted in every prior phase's log).

---

## 9. Supervisor review findings and fixes (post-initial-commit)

The supervisor review (three independent reviewers plus adversarial verification of each finding)
confirmed 9 defects in the initial Phase 5 commits. All 9 were fixed, re-verified, and committed;
each is documented below with its fix.

### 9.1 HIGH — `createFace` guarded a mutation with the widened `PersonRead`

`person.service.ts` `createFace()` (POST `/faces`) checked `dto.personId` with
`Permission.PersonRead`, which Phase 5 widened to shared-library reachability. A sharee could
therefore attach the **owner's** person to the sharee's own assets (their `AssetUpdate` passes,
reachability satisfies `PersonRead`) — polluting the owner's person data, inflating owner-only
statistics, and (when the person had no `faceAssetId`) setting the owner's person feature photo via
`createNewFeaturePhoto`. **Fix**: the personId guard now uses `Permission.PersonUpdate`, which routes
to `checkOwnerAccess` only. A full re-audit of every `requireAccess(Permission.PersonRead)` call site
confirmed the remaining ones are all read-semantics (`getById`, `getThumbnail`, search/timeline
`personId` filter validation) — every other person mutation path already used
`PersonUpdate`/`PersonCreate`/`PersonMerge`/`PersonDelete`/`FaceDelete`/`PersonReassign`, all
owner-scoped. New unit spec: shared-library reachability must not grant `createFace`, and the
reachability check must not even be consulted.

### 9.2 HIGH — owner's uploaded-asset stacks vanished (SQL NULL in `NOT IN`)

`asset.repository.ts` `getTimeBucket`'s `stacked_assets` lateral guarded the shared-arm stack
suppression with `asset.libraryId NOT IN (sharedLibraryIds)`. Uploaded assets have
`libraryId IS NULL`, making that predicate SQL-`NULL` (falsy), so the lateral returned no rows —
silently hiding the caller's (and partners') own uploaded-asset stack tuples whenever the caller had
any inTimeline share. **Fix**: null-safe predicate
`(libraryId IS NULL OR libraryId NOT IN (...))`. This was chosen over gating on
`ownerId = auth.user.id` because it preserves the pre-existing partner-stack-tuple behavior while
implementing exactly the intended invariant (only shared-library rows lose stack info).
`getTimeBuckets`' collapse guard has the *opposite* shape (`libraryId IN (...)` as a positive OR arm,
where NULL-falsy is the correct outcome), so it needed no change — verified, not assumed. New medium
spec: a sharee with an inTimeline share still sees their own uploaded-asset stack collapsed to its
primary with the `[stackId, count]` tuple intact, while the shared row carries none.

### 9.3 HIGH — shared persons duplicated on every People page

`person.service.ts` `getAll()` appended the shared-persons batch to **every** page of the paginated
response, duplicating person ids across pages and breaking the web People page's keyed `{#each}`
during infinite scroll. **Fix**: the batch is appended exactly once, on the final owner page
(`hasNextPage === false`); `total` still includes the shared count on every page because the web
reads it from page 1 only. New unit specs cover the multi-page and final-page cases.

### 9.4 HIGH — clicking a shared person dead-ended

The web person page's load called owner-only `getPersonStatistics` unconditionally (erroring the
whole page for a shared person), and its timeline options lacked `withSharedLibraries` (so the
timeline would have been empty anyway) — the exact flow plan §5.9 required verifying. **Fix**:
`+page.ts` now falls back to `null` statistics on failure, the page hides the asset count when
statistics are unavailable, and the timeline options pass `withSharedLibraries: true` (a no-op for
owned persons, whose faces exist only on their own assets). Also applied the same
`isAllUserOwned` guard around `<CreateSharedLink />` as on the photos/recently-added/map pages, since
shared assets are now selectable here. §5.9 verified by a new medium spec: sharee + shared person +
`personId` filter + `withSharedLibraries` returns exactly the shared assets containing that person.

### 9.5 MEDIUM — hidden persons remained reachable by id

`access.repository.ts` `checkSharedLibraryPersonAccess` and `person.repository.ts`
`isFeatureFaceInSharedLibrary` had no `person.isHidden = false` filter, so a sharee retained by-id
access (name via GET `/people/:id`, crop via the thumbnail endpoint, and the timeline/search
`personId` filter oracle) to persons the owner had hidden — violating plan §5.3 ("hidden persons
excluded from ALL sharee-facing surfaces"). **Fix**: both now require `isHidden = false` (the
listing/search arms already did). New medium specs prove denial while hidden and restoration when
un-hidden; the pre-existing `isFeatureFaceInSharedLibrary` specs were updated to attach real persons
to their faces (the new join makes an unassigned face deny, which is the safe direction).

### 9.6 MEDIUM — map markers `isFavorite` probe

`GET /map/markers?withSharedLibraries=true&isFavorite=true` ANDed the owner-favorite filter across
the shared-library OR-arm, enumerating exactly which shared assets the OWNER favorited — the same
probe class the timeline rejects and search drops the shared arm for. **Fix**: `MapService`
resolves `libraryIds` to `[]` whenever `options.isFavorite !== undefined`, mirroring
`dropSharedLibraryProbe` semantics. New unit specs cover both the normal inclusion and the probe
drop (including that the share lookup isn't even performed).

### 9.7 MEDIUM — map cluster panel 400s when toggles combine

`MapTimelinePanel.svelte` sent `withSharedLibraries` together with `visibility: undefined` (when
"Include archived" is on) or `isFavorite` (when "Only favorites" is on) — combinations the timeline
service's own guard rejects with 400, breaking the cluster side panel. **Fix**: the panel drops
`withSharedLibraries` whenever either toggle is active, and `Map.svelte`'s marker request now does
the same so markers and panel stay consistent: shared libraries participate in the map's default
view only. (Without the marker-side change, "Include archived" would have shown shared markers with
a panel that excluded them.)

### 9.8 LOW — probe defense missed `encodedVideoPath` (and path-class siblings)

`MetadataSearchDto` also exposes `encodedVideoPath` (wired by `searchAssetBuilder` to an exact match
on the server-internal `asset_file.path`), plus `previewPath`/`thumbnailPath` (declared in
`SearchPathOptions`, currently unwired — included as defense-in-depth). **Fix**: all three added to
`dropSharedLibraryProbe` alongside `isFavorite`/`originalPath`/`checksum`. A sweep of the remaining
`MetadataSearchDto`/`BaseSearchSchema` filters found no other server-internal-path/string filters
(`libraryId` composes safely with the pinned shared-arm predicate; `rating`/`description`/`ocr` are
content-class metadata visible on shared assets anyway).

### 9.9 LOW — unservable shared-person thumbnails rendered as broken images

`PeopleCard.svelte` rendered `ImageThumbnail`'s `BrokenAsset` placeholder when a shared person's
thumbnail 404s (source asset of the crop not in a shared library), while the upgrade guide promised
"a generic avatar". **Fix**: the card now tracks thumbnail load failure via `onComplete` and renders
an initials avatar (first letters of up to two name words) or a generic person icon when the person
is unnamed; the upgrade guide wording was aligned to say "an initials/generic avatar".

### 9.10 Re-verification after the fixes

| Gate | Result |
|---|---|
| `tsc --noEmit` (server, devcontainer) | clean |
| server unit — person/map/search/timeline/library/asset service suites | 284/284 passed (includes 4 new specs) |
| server medium — timeline service, access + person repositories | 80/80 passed (includes 4 new specs) |
| server medium — search service | 17/17 passed |
| SQL snapshots (`sync-sql.js` after rebuild) | regenerated; only the touched queries shifted |
| server eslint / prettier | clean |
| web `svelte-check` / eslint / prettier | clean |
