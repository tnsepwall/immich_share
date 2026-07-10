# Implementation Log — Phase 1: Direct Sharing + Safe Read

Tracks work against `FEATURE-PLAN-shared-external-libraries.md`, section 8 "Implementation order," Phase 1:
> **Direct sharing + safe read**: Steps 1–4 (minus album/exif schema extras), library share CRUD (Steps 6–9
> share-list parts), timeline browse (Step 10), path/stack/live-photo redaction (Step 7), read-surface matrix (Step 5).

Per the plan's own phase split, Phase 1 is **server-only** — Steps 12–14 (web UI) land in Phase 4 alongside the
role-aware editor surfaces, so there is no web work in this phase and nothing to browser-test.

Status: **complete**, pending the user's review. All server-side unit tests, typecheck, and lint pass (details below).

---

## 1. Scope decisions made explicit

The plan's Step 1 bundles all schema work (`library_user`/`library_user_audit` tables, **and** the `album_asset.sourceLibraryId`
column, **and** `asset_exif.sidecarWriteProperties`) into one step, but explicitly allows splitting it across phases
("minus album/exif schema extras if you want to split further"). This implementation takes that split:

- **Phase 1** adds only the `library_user` / `library_user_audit` schema (needed for direct sharing + read).
- `album_asset.sourceLibraryId` is deferred to Phase 2 ("Album provenance"), where it's actually used.
- `asset_exif.sidecarWriteProperties` is deferred to Phase 3 ("Editor metadata"), where it's actually used.

Consequences of this split, so later phases aren't surprised:
- **No "add to my album" capability yet.** The plan's Viewer description includes "add visible assets to their own
  albums," but that write path (`Permission.LibraryAssetAddToAlbum`, `checkSharedLibraryAlbumAddAccess`,
  `album.service.ts` centralization) depends on `sourceLibraryId` provenance tracking, which is Phase 2 work. Phase 1
  recipients can browse, view, and download; "add to album" arrives with Phase 2.
- Only `Permission.LibraryShare` was added to the `Permission` enum (`LibraryRead` already existed). The other
  Step 4 permissions (`LibraryAssetAddToAlbum`, `LibraryAssetUpdate`, `LibraryPersonRead/Create/Update`,
  `LibraryFaceCreate/Update`) are added in the phases that actually implement their endpoints, so the diff for each
  phase stays honest about what it delivers.
- `LibraryAccess.checkEditorAccess` and `PersonAccess`'s library-scoped checks are not added yet (Phase 3/4).

---

## 2. What changed, by file

### Schema
- `server/src/enum.ts` — `LibraryUserRole` (`Viewer`/`Editor`) + `LibraryUserRoleSchema`; `Permission.LibraryShare`.
- `server/src/schema/enums.ts` — `library_user_role_enum`.
- `server/src/schema/tables/library-user.table.ts` (new) — mirrors `album-user.table.ts`: composite PK
  (`libraryId`, `userId`), `role` (default Viewer), `createId`/`createdAt`/`updateId`/`updatedAt`, `UpdatedAtTrigger`,
  and an `AfterDeleteTrigger` (statement-level, `pg_trigger_depth() <= 1`) writing to `library_user_audit`.
- `server/src/schema/tables/library-user-audit.table.ts` (new) — mirrors `partner-audit.table.ts` (single audit
  table, unlike album_user's two-table split — library has no equivalent of `album_audit`).
- `server/src/schema/functions.ts` — `library_user_delete_audit` trigger function.
- `server/src/schema/index.ts` — registered the new tables/function/enum and `DB` interface entries.
- `server/src/database.ts` — `LibraryUser` type (mirrors `AlbumUser`/`Partner`); `SharedLibrary` type (`Library &
  { role, owner, assetCount }`, used by `getSharedWithUser`).
- `server/src/schema/migrations/1783648584743-AddSharedLibraryAccess.ts` (new, **hand-written** — see Limitations).

### Access control
- `server/src/repositories/access.repository.ts` — `AssetAccess.checkSharedLibraryAccess` (mirrors
  `checkPartnerAccess`: joins `library_user` → `library` (not deleted) → `user as owner` (not deleted) → `asset`
  (not deleted, `libraryId` match), visibility ∈ {Timeline, Hidden}). New `LibraryAccess` class with
  `checkOwnerAccess`/`checkSharedAccess`, wired into `AccessRepository`.
- `server/src/utils/access.ts` — `checkOtherAccess`: `AssetRead`/`AssetView`/`AssetDownload` each gained a 4th
  union member (`isSharedLibrary`, computed on the difference remaining after owner/album/partner); new
  `Permission.LibraryRead` (owner ∪ shared) and `Permission.LibraryShare` (owner only — admin bypass lives in the
  service layer) cases.

### Redaction (Step 7)
- `server/src/dtos/asset-response.dto.ts` — `mapAsset()` now redacts for any non-owner, non-admin viewer of a
  library asset: `originalPath` → `originalFileName` (basename only, since `originalPath` is a required schema
  field the web calls `.endsWith()`/`.includes()` on), `stack` → `null`, `livePhotoVideoId` → `null` unless the
  caller passes `sameLibraryLivePhoto: true` (see below).
- `server/src/services/asset.service.ts` — `AssetService.get()` resolves `sameLibraryLivePhoto` with one extra
  `getById` lookup on the motion asset, only when relevant (non-owner, non-admin, library asset with a live photo).
  This is the only call site that unlocks in-library live-photo playback for recipients; every other `mapAsset()`
  call site defaults to redacting the link, which is the safe default even though it's stricter than necessary.

### Read-surface audit (Step 5) — done by a background review pass
Broadening `AssetRead`/`AssetView`/`AssetDownload` opens every endpoint gated by those permissions, not just asset
viewing. A full audit (grep every use across `controllers/` and `services/`, judge each) found four endpoints that
needed to stay owner-only and added an explicit `requireOwnerAccess` guard (calls `checkOwnerAccess` directly,
bypassing the broadened union) instead of relying on the shared permission:
- `AssetService.getMetadata` / `getMetadataByKey` — arbitrary account-scoped key-value asset metadata.
- `AssetService.getOcr` — ML-derived OCR text.
- `AssetService.getAssetEdits` — switched to `Permission.AssetEditGet` (already owner-only), matching the
  controller's existing decorator.

Consciously accepted as already-safe without changes: smart-search-by-asset-id (results stay scoped to the
requester's own+partner assets regardless of the seed), and `GET /faces` (already returns `person: null` for
non-owned people, matching existing partner/album behavior).

Full endpoint-by-endpoint matrix is in the PR description / commit history for that pass.

### Share-list CRUD (Steps 6, 8, 9 — share-list parts only)
- `server/src/repositories/library.repository.ts` — `getSharedUsers`, `addUsers` (bulk insert, `onConflict
  doNothing` — service validates duplicates first for a clean error), `updateUserRole`, `removeUser`, `getOwned`,
  `getSharedWithUser` (includes a correlated-subquery `assetCount`: non-deleted Timeline assets only).
- `server/src/dtos/library.dto.ts` — `LibraryUserRoleSchema`-based DTOs (`LibraryUsersDto`, `LibraryUserUpdateDto`,
  `LibraryUserResponseDto`, `SharedLibraryResponseDto`), `LibraryResponseSchema.sharedUsers` (optional, owner/admin
  view only). `SharedLibraryResponseDto` has no `importPaths`/`exclusionPatterns` field at all.
- `server/src/services/library.service.ts` — `getMine` (attaches `sharedUsers` per owned library),
  `getSharedWithMe`, `addUsers` (owner or admin; rejects self-share, duplicate share, unknown user),
  `updateUserRole` (owner or admin; 400 if no existing share), `removeUser` (owner/admin for others; anyone can
  remove themselves via `'me'` without needing `LibraryShare` access — checked *before* the "is this user even
  shared" check, so a non-owner probing someone else's share status is rejected before that's revealed).
- `server/src/repositories/sync.repository.ts` / `server/src/services/sync.service.ts` — cleanup-only
  `LibraryUserSync` (mobile sync of shares is a Phase-2+ follow-up per the plan's "Out of scope" section, but the
  audit table this phase adds needs pruning regardless, or it grows forever).

### Controller (Step 9)
- `server/src/controllers/library.controller.ts` — `GET mine`, `GET shared-with-me` (declared *before* the
  existing `GET :id` route so they aren't captured by it), `PUT :id/users`, `PUT :id/users/:userId`,
  `DELETE :id/users/:userId` (accepts `'me'` via the existing `ParseMeUUIDPipe`). None of these use `admin: true` —
  regular users need to reach them; `@Authenticated`'s `permission` field only gates API-key-scoped requests (see
  `auth.service.ts#authenticate`), so the real owner/shared/admin authorization happens in the service via
  `requireAccess`.

### Timeline browse by library (Step 10)
- `server/src/dtos/time-bucket.dto.ts` — optional `libraryId`.
- `server/src/services/timeline.service.ts` — `timeBucketChecks` now resolves and returns the library (so
  `buildTimeBucketOptions` doesn't re-fetch it); rejects `libraryId` + `albumId` together; for a non-owner
  (Viewer or Editor), rejects `isTrashed`/`isFavorite`/non-Timeline-`visibility`/`withPartners` and forces
  `visibility = Timeline`, `withStacked = false`. Owners browsing their own library keep full filter freedom.
  Deliberately does **not** set `dto.userId` on the library path — that would route into the owner-∪-partner-only
  `TimelineRead` check below it, which a plain library share would fail.
- `server/src/repositories/asset.repository.ts` — `libraryId` added to `AssetBuilderOptions`, applied in both
  `getTimeBuckets` and `getTimeBucket` right alongside the existing `userIds` filter.

### Tests
- `server/src/services/library.service.spec.ts` — new `getMine`/`getSharedWithMe`/`addUsers`/`updateUserRole`/`removeUser`
  suites (owner/admin/stranger/self-leave/duplicate/unknown-user/missing-share cases).
- `server/src/services/timeline.service.spec.ts` — new `libraryId` suite (owner full freedom, recipient forced
  Timeline+no-stacks, stranger rejected, each restricted filter rejected, `libraryId`+`albumId` rejected).
- `server/src/services/asset.service.spec.ts` — 6 new tests from the read-surface audit pass (non-owner denial on
  the four newly-guarded endpoints even with shared-library/album/partner grants).
- `server/test/repositories/access.repository.mock.ts` — **had to be updated by hand**: this file is a
  hand-maintained mock (not auto-generated), so the new `LibraryAccess` methods and `AssetAccess.checkSharedLibraryAccess`
  would otherwise have been silently `undefined` in every test across the whole suite that uses
  `newAccessRepositoryMock()` — this was caught by running `tsc --noEmit`, not by inspection.

---

## 3. Verification performed

Ran in this environment (see Limitations for what couldn't be run):

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm --filter immich run check` (`tsc --noEmit`) | ✅ clean |
| Lint | `pnpm --filter immich run lint` (eslint, `--max-warnings 0`) | ✅ clean |
| New unit tests | `vitest -t "getMine\|getSharedWithMe\|addUsers\|updateUserRole\|removeUser\|libraryId"` | ✅ 23/23 pass |
| Full unit suite | `vitest run` (server) | 2189 passed / 76 failed / 2 skipped (2267 total) |

**On the 76 full-suite failures:** all 76 are in files this feature never touches (`storage.core`,
`storage.repository`, `process.repository`, `asset-media.service`, `auth.service`, `database-backup.service`,
`download.service`, `media.service`, `metadata.service`, `server.service`, `storage-template.service`,
`storage.service`, `transcoding.service`, `user.service`, plus 5 pre-existing failures in `library.service.spec.ts`'s
*existing* `handleSyncFiles`/`handleQueueSyncFiles`/`validate` tests that predate this work). Every failure sampled
in detail was a Windows-vs-POSIX path separator mismatch (e.g. expected `data/library/admin`, got
`\data\library\admin`) — this test suite assumes a POSIX environment (the plan itself notes running builds/tests
in Docker); it is not something Phase 1's code caused. None of the 76 involve access control, DTOs, sharing, or
timeline logic.

**Security review:** two independent background review passes.

1. Read-surface audit (section above) — found and fixed 4 endpoints needing owner-only guards.
2. A second, separate adversarial review specifically targeting the core access-control diff
   (`access.repository.ts`, `access.ts`, `asset-response.dto.ts` redaction, `timeline.service.ts` recipient
   restrictions, schema/triggers, share-CRUD ordering). Tried to construct concrete exploits for: cross-library/
   deleted-library/deleted-owner asset access, import-path/stack leakage through any code path, share-CRUD
   privilege escalation, timeline-filter bypass via unblocked params, revocation-not-taking-effect, and
   trigger/migration mismatches.

   **Result: zero confirmed vulnerabilities** — traced and verified correct: `checkSharedLibraryAccess`'s
   deleted-library/deleted-owner/deleted-asset/wrong-library/wrong-visibility exclusions; that `SharedLibraryResponseDto`
   and `mapAsset`'s redaction can't be bypassed via any reachable code path; that share-CRUD authorization can't be
   escalated (owner-only, admin bypass is intentional, owner has no `library_user` row so can't be targeted, `'me'`
   self-leave doesn't need `LibraryShare`); that the timeline recipient restrictions can't be bypassed by combining
   `libraryId` with other params; that access is re-checked per-request (no caching), so revocation takes effect
   immediately; that the trigger/function/migration all agree; and that no `setDifference`/`setUnion` argument order
   is swapped.

   Two low-severity, **non-security** findings, one fixed and one deferred:
   - **Fixed:** `LibraryService.updateUserRole` used a non-null assertion (`mapLibraryUser(user!)`) after
     re-fetching the share list, which would throw an unhandled `TypeError` instead of a clean 400 if the target
     user were soft-deleted in the narrow window between the update and the re-fetch. Now throws
     `BadRequestException('Library is not shared with user')` instead, matching the existing "missing share"
     error path.
   - **Deferred (documented, not fixed):** `asset.repository.ts#getTimeBucket` selects the raw `livePhotoVideoId`
     for every asset in a library-scoped bucket, including recipients, whereas `mapAsset` (the single-asset detail
     path) correctly nulls it for a cross-library motion asset. The reviewer confirmed this is **informational
     only** — a recipient could learn a motion asset's UUID, but not its content: the video playback endpoint
     independently re-runs `checkSharedLibraryAccess`, which denies a motion asset outside the shared library
     regardless of what the bucket response revealed. A correct fix needs a correlated `EXISTS` subquery (or an
     `isLibraryOwner` flag threaded from `timeline.service.ts` into `TimeBucketOptions`) inside an already-dense
     query-builder chain that this environment has no live Postgres to test against — see Limitations. Recommend
     fixing this alongside Phase 2, when a dev database is available to verify the new SQL.

---

## 4. Limitations of this environment (not gaps in the feature)

- **No Docker/Postgres available**, so the migration in `1783648584743-AddSharedLibraryAccess.ts` was
  **hand-written** (mirrors `1781089983296-CreateIntegrityReportTable.ts` and `1747664684909-AddAlbumAuditTables.ts`
  exactly) rather than generated via `pnpm --filter immich run migrations:generate`, which the plan calls the
  "strongly preferred" path specifically so decorators and DDL can't drift. **Recommend running the generator
  against a real dev Postgres and diffing against this file before merging**, per the plan's own fallback guidance.
- **No medium/e2e tests were run** (both require a live Postgres). The plan's Section 5 testing list includes
  medium specs for `AssetAccess.checkSharedLibraryAccess`/`LibraryAccess` and manual-verification steps 1–2 (owner
  creates library, Viewer browses) that are Phase-1-relevant — these still need to run against a real database.
- **OpenAPI spec / SDK were not regenerated** (`mise open-api` needs the NestJS app to actually boot, which needs
  Postgres). The new endpoints (`getMyLibraries`, `getLibrariesSharedWithMe`, add/update/remove-user, and the
  `libraryId` time-bucket param) exist in the server but **do not yet exist in `packages/sdk`** — anything
  consuming the generated client (including Phase 4's web work) needs this regenerated first.
- `mise`/Docker are not installed in this shell; `pnpm` was used via `npx pnpm@11.6.0` instead of corepack.

---

## 5. Not in Phase 1 (by design — see plan section 8)

- Album provenance (`sourceLibraryId`), "add to my album" from a shared library, shared-link guards, sync-stream
  exclusion → **Phase 2**.
- `sidecarWriteProperties` split, transactional metadata primitive, editor metadata endpoints → **Phase 3**.
- Person/face editor endpoints, all web UI (sharing hub, browse page, i18n, docs) → **Phase 4**.

## 6. Suggested next step

Phase 2 ("Album provenance") per the plan: `album_asset.sourceLibraryId` schema, the reusable provenance predicate
across every read surface enumerated in plan section 2, insertion precedence, `copyAlbums`, shared-link guards,
and sync-stream exclusion. Recommend running the deferred migration-generation and medium/e2e tests (previous
section) before or alongside starting Phase 2, since Phase 2 also needs a real Postgres for its own migration.
