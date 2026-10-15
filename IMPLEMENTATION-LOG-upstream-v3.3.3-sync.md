# Implementation Log — Upstream v3.3.3 Sync

**Merged:** upstream `v3.3.3` (570 commits, ~2,500 files since `v3.1.0`) into the shared-libraries fork on
2026-10-15. Merge base was exactly `v3.1.0`, the fork's previous baseline. Merge commit `98719907b`.

This sync was much larger than v3.1.0's: 70 conflicted files / 120 hunks (v3.1.0 had 13 files), and three
upstream changes required real ports of fork code rather than conflict resolution.

## What upstream v3.2 / v3.3 bring (short version)

- **ESM + NestJS 12** (v3.2): the server is now an ES module; every relative and `src/...` import carries an
  explicit `.js` extension, and types used in decorated signatures must be `import type`.
- **Cluster groups + person sharing** (v3.2/v3.3): the person data model changed (see below). Users can join
  a cluster group, share people with each other (read/write/admin roles) and merge across users.
- **Search API v2 ("V3" in the code)** and a new web search UI: the filter engine that was dead code in
  v3.1.0 is now wired to `/search/metadata`, `/search/statistics`, `/search/random`, `/search/smart` whenever
  the request carries a `filter` object. The new web search modal uses it.
- **New config endpoints**: `src/config.ts`, `dtos/model-config.dto.ts`, `dtos/system-config.dto.ts` are gone;
  everything lives in `dtos/config.dto.ts`.
- **Sync backpressure**: `send()` in `sync.service.ts` is async and must be awaited.
- **Migration `ORDER` file** (`@immich/sql-tools`): migrations run in the order listed there.
- **Web Actions refactor**: most bulk/viewer toolbars are now `ActionItem`s from `$lib/services/*.service.ts`.
- Mobile OpenAPI Dart code was removed from the repo; birthday memories; higher-quality thumbnails (new ones
  only); optional ML model revision v2; OAuth claims (quota, role, username) can sync on every login.

## The three real ports

### 1. Person model (`1787148183729-ClusterGroups`, `1790616293884-PersonSharing`)

`person.id` no longer exists. A person row is keyed `(ownerId, personGroupId)`; `asset_face.personId` became
`asset_face.personGroupId` (FK to `person_group`). The migration reuses the old `person.id` as the group id, so
every existing id stays valid. The API's person id is the group id.

Rule applied to every fork person query: **library assets are owned by the library owner, so the person a
shared-library path resolves is the owner's row** — `person.ownerId = library.ownerId` (or `= asset.ownerId`),
`asset_face.personGroupId = person.personGroupId`. Without the owner constraint a cluster group would return one
row per member.

- `PersonRepository`: library helpers, `getAllForLibrary`/`getOneForLibrary` (now via a shared
  `libraryPeople()` builder), `getAllForSharedLibraries` (groups by `(ownerId, personGroupId)`),
  `getByNameWithSharedLibraries`, `isFeatureFaceInSharedLibrary`, `getFacesForLibraryAsset`, and the four
  editor transactions. `createPersonForLibrary` creates a `person_group` in the owner's cluster group first.
  The editor transactions now return `ownerId` so the service can queue `PersonGenerateThumbnail` with the new
  `{ ownerId, personGroupId }` job payload. "Exclusive to library" counts only the owner's assets.
- New `PersonRepository.getForSharedLibraryViewer(userId, personGroupId)`: the owner's row a recipient sees.
- `getFaces(..., { libraryOwnerId })` additionally selects the owner's row as `libraryPerson`; `mapFaces` shows
  the viewer's own row (upstream) or, failing that and only for an asset in a library shared with the viewer,
  the redacted `libraryPerson`.
- Access: upstream's `PersonAccess.checkAccess(Set<PersonId>)` stays as is. `PersonRead` additionally admits
  `checkSharedLibraryPersonAccess` (owner row, `inTimeline` share, not hidden), skipped entirely for ids whose
  `ownerId` is the caller. `PersonUpdate/Delete/Merge` are upstream's (owner + `person_user` roles) — never the
  library arm. New `checkSharedLibraryPersonGroupAccess` + `requirePersonGroupReadAccess` (BaseService) for
  person ids used as filters (search, timeline).
- `PersonService.getById` / `getThumbnail`: upstream path when the caller has a row of their own; otherwise
  the redacted library-owner row (with `renameLibraryId`; thumbnail only behind the feature-face gate).
  `getStatistics` and `createFace` stay on the caller's own row.
- `LibraryPersonResponseDto.id` / `LibraryFaceResponseDto.person.id` are group ids.

### 2. Search V3 shared-library arm

`AssetSearchScope` gained `sharedLibraryIds` and `requestedBy`. `searchAssetBuilder` ORs
`withSharedLibraryAssets(sharedLibraryIds)` into its ownership predicate (wherever upstream applies it: globally
or per unconfined branch). V3 `albumIds` filters apply `withAlbumAssetProvenance(requestedBy)`;
`hasAlbums` counts only ordinary (`sourceLibraryId IS NULL`) rows, like the legacy `isNotInAlbum`.
`resolveSearchScopeV3` supplies the in-timeline library ids, drops them when any branch filters on
`isFavorite`/`originalPath`/`checksum`/`encodedVideoPath` (`dropSharedLibraryProbeV3`), and checks
`personIds` with `requirePersonGroupReadAccess`. Shared links get `requestedBy: null`.

### 3. Config restructure

Video face settings (`videoEnabled`, `videoFrameInterval`, `videoMaxFrames`) and the `videoFaceDetection`
queue concurrency moved into `dtos/config.dto.ts` (`AdminConfigFacialRecognitionDto`, `AdminConfigJobDto`,
`defaults`).

## Other resolutions

- ESM: a codemod added `.js` to every fork import; decorator-referenced types switched to `import type`.
- `sync.service.ts`: every fork `send()` / `sendEntityBackfillCompleteAck()` awaited; the backfill-source sort
  uses a named comparator (`compareByCreateId`).
- Migration `ORDER`: the fork band (`1783648584743` … `1784127594099`, incl. the renamed
  `1783830000000-RestoreLivePhotoStillVisibility`) inserted after `1782414436633-AddPluginMethodAllowedHosts`,
  upstream's `1782500000000-RestoreLivePhotoStillVisibility` entry removed. Production's 95 applied migrations
  are an exact prefix of the new list; `migrations:verify-order` passes (107).
- `mobile/openapi/*` fork edits dropped (upstream deleted the generated Dart client).
- Web: `PeopleCard` and the person page rebuilt on upstream's versions with the fork's initials fallback,
  owner-only menus (now including Access / Edit) and Editor rename via `updateLibraryPerson`.
  `getAssetBulkActions().CreateSharedLink` is hidden unless every selected asset is the user's own (server
  `AssetShare` is owner-or-partner; the fork previously gated this per page). Viewer nav keeps the restricted
  AddToAlbum for library recipients.
- `test/fixtures/auth.stub.ts`: `user2` restored (upstream removed it; fork specs use it).
- Lint fixes in fork code for upstream's newer rules (Set methods, then/catch, eqeqeq).

## Generated artifacts

- `open-api/immich-openapi-specs.json` and `packages/sdk/src/fetch-client.ts` regenerated from the merged
  server; the SDK delta vs upstream is exactly the fork surface (431 lines, same size as at v3.1.0).
- `server/src/queries/*.sql` regenerated (`sync-sql`) against a fully migrated scratch database; only
  fork-touched repositories differ from upstream.
- `sql-tools migrations generate` against that database: **No changes detected** (code schema == migrations).

## Validation

All on Linux (Node 24.15 container), unlike previous syncs' Windows baseline:

- Server `tsc --noEmit`: 0 errors. `eslint --max-warnings 0` and prettier: clean.
- Server unit: **2509 passed, 1 expected fail, 0 failed** (109 files).
- Server medium (testcontainers Postgres): **900 / 900 passed** (75 files) — needs `e2e/test-assets`
  checked out, `ffmpeg` installed, and `packages/plugin-core/dist` built (copied out of the image build).
- New medium coverage: V3 metadata/statistics include in-timeline shared-library assets, exclude
  `inTimeline=false`, drop the arm for probing branches; group-id reachability; a sharee's own key of the
  owner's group is not granted through the library.
- Web: `svelte-check` 0 errors / 0 warnings; `tsc` clean; eslint clean; unit 560 passed.
- Full migration chain from empty: 107/107.
- Docker image build from the merge: succeeds.
- Rehearsal on a restored copy of production: migrations 38 s, 25/25 API checks (see the upgrade guide).

## Watch items for the next upstream sync

- Person sharing / cluster groups vs shared libraries are independent systems. A sharee in the same cluster
  group as a library owner may also have their own row for a group; they then see their own row (upstream),
  not the redacted owner row. Revisit if upstream starts sharing people automatically.
- The web person page passes both `withPartners` (upstream) and `withSharedLibraries` (fork) on the timeline.
- Video face recognition is still not upstream (no `timestampMs` in v3.3.3).
- `ParseMeUUIDPipe` remains fork-owned in `validation.ts`.
