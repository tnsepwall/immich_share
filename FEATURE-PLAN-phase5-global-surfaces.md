# Phase 5 — Shared libraries in the main surfaces (Photos, Explore, Map, Search) + Editor discoverability

Extends `FEATURE-PLAN-shared-external-libraries.md` (which scoped Phases 1–4). Phase 5 was requested after
Phase 4 deployed: (A) let a sharee OPT IN to seeing a shared library's assets in their main Photos timeline,
Explore, Map, and every search modality (metadata, smart/CLIP, OCR, person) — leveraging the facial-recognition,
OCR, and CLIP data the owner's server has already computed; (B) fix the "missing edit button" report — a
confirmed discoverability gap in the Phase 4 asset viewer, not a bug.

Everything below is grounded in a code-reconnaissance pass over the actual v3.0.2 + Phases 1–4 source; all
file:line references were verified against the working tree at commit `e2bbeaa`.

---

## 0. Design decisions (settled — do not relitigate)

1. **Opt-in flag**: `inTimeline boolean NOT NULL DEFAULT false` on `library_user`, mirroring
   `partner.inTimeline` (`server/src/schema/tables/partner.table.ts:44-45`). Sharee-controlled; per share row.
2. **Inclusion mechanism**: a separate OR-branch on `asset.libraryId`, NEVER by adding the library owner's
   userId to any `userIds` array — that would leak the owner's uploads and all their other libraries. The
   canonical shared-arm predicate, used verbatim on every surface:
   `(asset."libraryId" = ANY(:sharedLibraryIds) AND asset.visibility = 'timeline' AND asset."deletedAt" IS NULL)`
   The visibility/deletedAt clamp is pinned INSIDE the branch, ignoring dto-level visibility/trash/favorite
   filters (matches the recipient clamp precedent at `server/src/services/timeline.service.ts:78-89`).
3. **Locked visibility**: shared-library inclusion is dropped entirely when the request is for
   `AssetVisibility.Locked` (same branch that drops partners, `search.service.ts:231-233`).
4. **Map semantics**: the per-share `inTimeline` flag governs the map too (deliberate deviation from partner
   map semantics, which ignore partner.inTimeline — `map.service.ts:12`). A separate client-side map toggle
   (`withSharedLibraries`, default false) double-gates it, mirroring `withPartners`/`withSharedAlbums`.
5. **People**: person NAME SEARCH, People listing, person filter chips, and the asset detail panel's people
   section gain shared-library persons (read-only, redacted). Person STATISTICS and all person mutations stay
   owner-only. Person thumbnails are served to sharees ONLY when the person's feature face's SOURCE ASSET is in
   a library shared with the caller — reachability alone is insufficient (the crop can come from an unshared
   photo). Where the thumbnail is not servable, the web falls back to its initials avatar.
6. **Per-box OCR endpoint** (`GET /assets/:id/ocr`) stays owner-only in v1 (`asset.service.ts:395-398` comment
   documents this as deliberate). OCR SEARCH for shared assets works regardless — it's a filter inside
   `searchAssetBuilder`, not that endpoint. Optional follow-up, not Phase 5.
7. **Mobile sync**: unchanged. Phase 2's exclusion stands (`sync.repository.ts:216,237,261,274` and ownerId
   scoping at :402,415); the flag is web-only. Document the web/mobile asymmetry in the log and upgrade guide.
8. **Owner preview**: owners keep the standard owner UI in the shared-library route. Do NOT show the library
   editor panel to role 'owner' — `LibraryAssetEditorPanel` writes via the recipient-scoped endpoint.
9. **Edit affordance**: add a visible "Edit info" toolbar button for Editors (details §6). Do not reuse
   `Actions.Edit` (mdiTune) — that's the destructive photo editor, a different surface.

## 1. Schema + share-row plumbing

1.1 `server/src/schema/tables/library-user.table.ts`: add
    `@Column({ type: 'boolean', default: false }) inTimeline!: Generated<boolean>;` (copy partner.table.ts:44-45).
1.2 Migration: generate with the project's own generator (`sql-tools`), NOT by hand — the drift incident
    (IMPLEMENTATION-LOG-phase4.md, task #44 / commit e2bbeaa) is the cautionary tale. Working flow, proven
    this session: start `immich_postgres` + `immich_server` devcontainers, then from Windows:
    `MSYS_NO_PATHCONV=1 docker exec -w /usr/src/app/server -e DB_URL="postgres://postgres:postgres@database:5432/immich" immich_server sh -c 'pnpm run build && pnpm run migrations:run && pnpm run migrations:generate AddLibraryUserInTimeline'`
    The file lands at `server/` root (bind mount) — move it into `server/src/schema/migrations/` and RENAME its
    timestamp ABOVE `1783800000000` (e.g. `1783810000000-AddLibraryUserInTimeline.ts`): generator timestamps are
    current-epoch (~17837xxxxxxxx) which sorts BEFORE the already-applied future-dated Phase 3/drift migrations
    and strict runners reject out-of-order. Then re-run `pnpm run build && pnpm run migrations:run` and verify
    `pnpm run migrations:generate ShouldBeEmpty` prints "No changes detected" (also against a fresh scratch DB:
    `CREATE DATABASE`, run all migrations, re-check).
1.3 Model type: add `inTimeline` to the LibraryUser model in `server/src/schema/index.ts` /
    `server/src/database.ts` (wherever LibraryUser is typed — follow how `role` is declared).
1.4 DTOs (`server/src/dtos/library.dto.ts`): add `inTimeline: boolean` to `SharedLibraryResponseSchema`
    (:137-140) so the Sharing page can render toggle state; new `LibraryUserSelfUpdateSchema = { inTimeline: z.boolean() }`
    (mirror `PartnerUpdateSchema`, `partner.dto.ts:14-18`). Do NOT add inTimeline to the owner-facing
    `LibraryUserUpdateSchema` — the owner has no business setting a sharee's personal view preference.
1.5 Authorization split (mirror the partner pattern exactly):
    - New `Permission` enum value, e.g. `LibraryUserSelfUpdate` (`server/src/enum.ts`, near the other Library* values).
    - New `LibraryAccess.checkSelfShareAccess(userId, libraryIds)` in
      `server/src/repositories/access.repository.ts` (model on `PartnerAccess.checkUpdateAccess` :689-706:
      `selectFrom('library_user').where('libraryId','in',ids).where('userId','=',userId)` joined to non-deleted
      library + owner as `getSharedWithUser` does, `library.repository.ts:201-218`).
    - `server/src/utils/access.ts`: new case routing the new permission to `checkSelfShareAccess`. Keep
      `Permission.LibraryShare` owner-only (:272-274, do not touch).
1.6 Endpoint: `PUT /libraries/:id/users/me` on `library.controller.ts` (near :176-221), body
    `LibraryUserSelfUpdateDto`, `@Authenticated({ permission: Permission.LibraryUserSelfUpdate })`. Service
    method `LibraryService.updateMyShare(auth, libraryId, dto)`: requireAccess on the LIBRARY id, then
    `libraryRepository.updateUser(libraryId, auth.user.id, { inTimeline: dto.inTimeline })` — pin userId to
    `auth.user.id` exactly as `PartnerService.update` pins sharedWithId (:42-56); if no row updated, throw the
    same `BadRequestException('Library is not shared with user')` shape as `updateUserRole` (:278-297).
1.7 Repository helper: `libraryRepository.getInTimelineSharedLibraryIds(userId): Promise<string[]>` — variant
    of `getSharedWithUser` (:201-218) with `.where('library_user.inTimeline','=',true)`, returning bare library
    ids; keeps the live-library + live-owner joins. Resolve FRESH per request (no caching), like getMyPartnerIds.

## 2. Timeline (main Photos grid)

2.1 `server/src/dtos/time-bucket.dto.ts` (:7-71): add `withSharedLibraries` (stringToBool, optional), beside
    `withPartners` (:23).
2.2 `server/src/services/timeline.service.ts`:
    - `timeBucketChecks` (:57-125): extend the withPartners param-combination guard (:111-122) to also reject
      `withSharedLibraries` combined with isTrashed/isFavorite/visibility Archive|Locked. Do not touch the
      libraryId (dedicated-route) branch; `withSharedLibraries` is only meaningful on the main path.
    - `buildTimeBucketOptions` (:29-54): on the non-library branch, when `dto.withSharedLibraries`, resolve
      `sharedLibraryIds = await libraryRepository.getInTimelineSharedLibraryIds(auth.user.id)` and thread it
      through the options.
2.3 `server/src/repositories/asset.repository.ts`: add `sharedLibraryIds?: string[]` to `AssetBuilderOptions`
    (:84-102). In BOTH `getTimeBuckets` (:995-996) and `getTimeBucket` (:1083-1084) replace the plain
    `$if(userIds) where ownerId = ANY(...)` with an OR of the owner arm and the shared arm (§0.2 predicate) when
    sharedLibraryIds is non-empty. THE TWO QUERIES MUST STAY PREDICATE-IDENTICAL — the web console.errors and the
    scrubber breaks if month counts diverge (`web/src/lib/managers/timeline-manager/internal/load-support.svelte.ts:52-60`).
    The shared arm must NOT inherit `withDefaultVisibility` (`utils/database.ts:82-84`) — its visibility clamp is
    its own.
2.4 `withStacked` guard: the main page always sends withStacked=true, and the stack lateral join
    (:1086-1111) would surface stack tuples for shared assets. Condition the stack expansion on
    `asset.ownerId = auth.user.id` (or exclude shared-arm rows from the join) — stacks are owner-only in v1.
2.5 Fix the deferred Phase 1 informational finding while exposure widens: `getTimeBucket` selects raw
    `livePhotoVideoId` into bucket JSON (:1029, :1137). Null it in SQL for rows where
    `asset.ownerId != auth.user.id` (same shape as the isFavorite SQL redaction at :1026). Note the fix in the log.
2.6 Unit specs (`timeline.service.spec.ts`): flag resolves ids only on main path; guard combos rejected;
    library route unaffected. Medium specs (real Postgres): shared assets appear in buckets+bucket only when
    inTimeline=true; owner's archived/trashed/locked/other-library assets never appear; month counts match
    between buckets and bucket; stack tuples absent for shared rows; livePhotoVideoId null for shared rows.

## 3. Search (one builder covers most modalities)

3.1 `server/src/services/search.service.ts` — `getUserIdsToSearch` (:229-240): restructure to return
    `{ userIds, sharedLibraryIds }` (sharedLibraryIds = [] when visibility === Locked). Preserve the
    concurrency shape in `searchSmart` (:150, :179 — promise created before the ML call, awaited after).
3.2 `server/src/utils/database.ts` — `searchAssetBuilder` (:411-540): add `sharedLibraryIds?: string[]` to the
    options (`SearchUserIdOptions`, `search.repository.ts:18-21`; do NOT overload the existing singular
    `libraryId` AND-filter at :475). Replace the :476 ownerId predicate with the owner-arm OR shared-arm
    combination. This single edit covers metadata, smart/CLIP, random, statistics, large-assets AND the `ocr`
    filter (:502-506).
    Probe defenses — drop the shared arm (owner arm only) when the dto sets any of:
    - `isFavorite` (asset.isFavorite is the OWNER's flag; a sharee filtering on it is an oracle — :508)
    - `originalPath` (filter would probe the owner's filesystem strings even though the DTO redacts — :487-489)
    - `checksum` (same class of probe — :473)
3.3 Cities (`search.repository.ts` `getAssetsByCity` :383-431): add the shared arm to BOTH the base (:390) and
    recursive (:406) CTE arms. Fix the redaction gap in the same change: `search.service.ts:191` currently calls
    `mapAsset(asset)` WITHOUT auth — pass `{ auth }`.
3.4 Suggestions (`getExifField` :495-506 and its six callers :441-493): thread sharedLibraryIds with the same
    OR-arm, so filter dropdowns stay consistent with results.
3.5 Explore (`asset.repository.ts` `getAssetIdByCity` :1170-1194, `getRecentlyCreatedAssetIds` :1197-1210):
    widen the single-ownerId signatures to `(userIds, sharedLibraryIds)` with the OR-arm. Keep them
    partner-free (they are today; adding partners is out of scope). `getExploreData` already maps with `{auth}`.
3.6 `@GenerateSql` decorators exist on several touched repository methods — regenerate SQL
    snapshots per the repo's existing task (`server/package.json` scripts, look for sync:sql / sql:generate)
    and commit them, or CI drift checks fail.
3.7 Unit + medium specs: metadata/smart/ocr search include shared assets only when flag on; Locked excludes;
    isFavorite/originalPath/checksum probes return owner-only results; suggestions include shared EXIF values;
    cities include shared assets with redacted mapping.

## 4. Map

4.1 `server/src/dtos/map.dto.ts` (:20-29): add `withSharedLibraries` (stringToBool, optional).
4.2 `server/src/services/map.service.ts` (:9-19): when set, resolve `getInTimelineSharedLibraryIds(auth.user.id)`
    and pass as a 4th collection.
4.3 `server/src/repositories/map.repository.ts` `getMapMarkers` (:83-127): push
    `eb('asset.libraryId','in',libraryIds)` as a third expression into the existing `eb.or([...])` (:105-124).
    Do NOT touch the visibility guard (:91-101) — it already pins non-owner content to Timeline (the
    isArchived=true widening is ownerId-scoped).
4.4 Cluster-panel consistency: `MapTimelinePanel.svelte` (:79-94) drives the main bucket endpoints — pass
    `withSharedLibraries: $mapSettings.withSharedLibraries` there so cluster side panels include the same assets
    as the markers.
4.5 Web: `MapSettings` + `defaultMapSettings` (`web/src/lib/stores/preferences.store.ts:22-50`) gain
    `withSharedLibraries: boolean` (default false); `MapSettingsModal.svelte` (:29-38) third switch (new i18n
    key `include_shared_library_assets`); `Map.svelte` `loadMapMarkers()` (:220-242) passes the param.

## 5. People (facial recognition surfaces)

SECURITY PREREQUISITE FIRST: `server/src/utils/access.ts:344-357` routes PersonRead, PersonUpdate,
PersonDelete, PersonMerge through ONE case → checkOwnerAccess. SPLIT PersonRead into its own case before
widening anything, or sharees gain rename/delete/merge.

5.1 New `PersonAccess.checkSharedLibraryPersonAccess(userId, personIds)` in access.repository.ts: person has a
    visible (`isVisible = true`), non-deleted face on a non-deleted Timeline asset whose `libraryId` is in a
    library shared with userId **with `library_user.inTimeline = true`** — reuse Phase 4's join shape
    (`checkLibraryPersonScope` :607-661 / `person.repository.ts` `joinLibraryAsset` :80-85). Union into the
    (now split) PersonRead case only.
5.2 Person STATISTICS stays owner-only: `person.service.ts:158-161` checks PersonRead for getStatistics —
    change that call site to a strictly owner-scoped check (statistics reveal the person's GLOBAL asset count,
    not just shared-library assets). Same review for any other service method that would inherit the widened
    PersonRead unintentionally (`getById` is fine once the DTO is redacted; audit each call site of
    `Permission.PersonRead` in person.service.ts :51-175).
5.3 Redacted person DTO for non-owners: `mapPerson` (`person.dto.ts:174-185`) exposes birthDate, isHidden,
    isFavorite, color, thumbnailPath (an internal path string). Add a redacted variant for
    `person.ownerId !== auth.user.id`: `{ id, name, thumbnailPath: '' }`-class output (follow how Phase 4
    returned only id/name/thumbnailFace). Respect the owner's `person.isHidden` — hidden persons are excluded
    from all sharee-facing surfaces.
5.4 Person name search (`GET /search/person` → `personRepository.getByName` :751-764): add a NEW method (do not
    change `getDistinctNames` — `metadata.service.ts:921` depends on its owner-scoped semantics) that ORs
    `person.ownerId = userId` with an EXISTS over the §5.1 reachability shape. Wire through
    `search.service.searchPerson` (:31-34).
5.5 People listing (People page + Explore People row; `getAllForUser` :352-415 + `getNumberOfPeople`): union
    owner persons with shared-reachable persons. For shared persons, the minimumFaces HAVING must count ONLY
    in-shared-library faces (do not advertise a person's global footprint size). Hidden persons excluded.
5.6 Person thumbnail (`GET /people/:id/thumbnail`, service :163-175): for non-owners, permit ONLY when the
    person's `faceAssetId` face's SOURCE ASSET is itself in an inTimeline library shared with the caller
    (check `asset_face.id = person.faceAssetId → asset.libraryId ∈ shared set`, Timeline visibility,
    deletedAt null). Otherwise 403; web falls back to the initials avatar (verify the web person components
    render a fallback on thumbnail 403/error — adjust if they render broken images).
5.7 Asset detail panel people + faces: relax `asset.service.ts` `getAssetInfo` (:94-96, currently
    `data.people = []` for all non-owners) and `person.dto.ts` `mapFaces` (:218, nulls non-owned persons) to
    include persons whose reachability is through THE ASSET'S OWN library when that library is shared with the
    caller (per-face check against `asset.libraryId` — NOT global reachability). Read-only; redacted DTO.
5.8 Person filter chips / personId filters: `dto.personIds` (search :33) and `dto.personId` (timeline :12) are
    unauthorized filters today, bounded by result scope. Once shared assets enter scope they become a probing
    oracle — add a `checkAccess(Permission.PersonRead)` validation on explicitly-supplied person ids in
    search.service/timeline.service (reject ids the caller can't read).
5.9 Person timeline (person page drives `/timeline/buckets?personId=`): works automatically once §2's OR-arm
    lands (personId is a pure filter via `hasPeople`). Verify with a medium spec.
5.10 Tests: access split regression (sharee CANNOT rename/merge/delete/statistics), reachability honors
    inTimeline flag + isHidden, thumbnail gate on source asset, redacted DTO fields, filter-id validation.

## 6. Web UI

6.1 Sharing page toggle: `web/src/routes/(user)/sharing/+page.svelte` (:84-118) — per shared-library card, add
    a `SettingSwitch` ("Show in Photos, Explore, Map & Search" — one i18n key) calling the new
    `PUT /libraries/:id/users/me` SDK function; optimistic update + toast, mirror
    `PartnerSettings.svelte` `handleShowOnTimelineChanged` (:109-117, :172-185).
6.2 Photos page: `web/src/routes/(user)/photos/[[assetId=id]]/+page.svelte` (:44-45) — add
    `withSharedLibraries: true` to the options (server-side flag is the real gate, mirroring withPartners).
    Same for `recently-added/+page.svelte` (:50).
6.3 Main-viewer role context (the piece that makes Phase 4's role-aware viewer work OUTSIDE the dedicated
    route): a small session cache of the sharee's libraries — e.g. `library-share-store.svelte.ts` loading
    `getLibrariesSharedWithMe()` once on demand (invalidate on toggle changes). In `TimelineAssetViewer.svelte`
    (or where `libraryShare` is currently absent on the main route), derive
    `libraryShare = { libraryId: asset.libraryId, role }` when `asset.ownerId !== me` and the store has that
    library. Phase 4's DetailPanel/LibraryAssetEditorPanel/LibraryFacePanel then light up identically in the
    main timeline. The dedicated route keeps passing its explicit context (owner preview differs there).
6.4 Multi-select polish: `photos/+page.svelte` (:114-171) renders CreateSharedLink unconditionally and the
    server rejects it for shared assets with a raw 400 — hide it when `!isAllUserOwned`
    (`asset-multi-select-manager.svelte.ts:24-32`), keeping Download + AddToAlbum.
6.5 Editor discoverability (feature B — do this FIRST, it's independent and immediately user-visible):
    a. `asset-viewer-manager.svelte.ts` (:193-200): add public `openDetailPanel()` (setter is private :135-137).
    b. `AssetViewerNavBar.svelte`: new ActionItem "Edit info" (mdiPencilOutline), shown when
       `isLibraryShareEditor(libraryShare) && asset.hasMetadata`, calling `openDetailPanel()`; place beside the
       Info button (:157); add to `paletteActions` (:119-121) so the command palette sees it.
    c. `LibraryAssetEditorPanel.svelte`: add a small header ("Edit metadata" + pencil, mirror
       `LibraryFacePanel.svelte:62-74`) before the first section (:115) so the panel self-identifies as editable.
    d. Do NOT auto-open the panel by default: `isShowDetailPanel` is persisted localStorage shared across ALL
       routes (:21) — force-opening leaks state into the normal viewer. The explicit button is the fix.
    e. New i18n strings in `i18n/en.json` only (engagement precedent).
6.6 SDK regeneration: after all server DTO/endpoint changes, regenerate the OpenAPI spec + typed SDK (the
    Phase 4 flow: live devcontainer server writes `open-api/immich-openapi-specs.json`, then the
    `open-api-typescript` mise task / oazapfts → `packages/sdk/src/fetch-client.ts`, then `tsc` build). Then
    REMOVE the two type-intersection casts that carried `libraryId` while the SDK was stale
    (`timeline-manager.svelte.ts:248-256`, `load-support.svelte.ts:19-28`) and type `withSharedLibraries`
    properly (`timeline-manager/types.ts:6-23`).

## 7. Read-surface audit (engagement standard)

Before declaring done, sweep every query that will now emit shared-library rows and confirm each row passes
through redaction with auth: timeline buckets (SQL-level: isFavorite ✅ existing, livePhotoVideoId §2.5,
stack §2.4), search mapResponse/searchRandom/searchLargeAssets (auth passed ✅), getAssetsByCity (§3.3 fix),
explore (auth ✅), map markers (id/lat/lon/city only ✅), person DTOs (§5.3), suggestions (EXIF strings — gated
by the flag, accepted). Confirm NO change to: sync streams, shared-link paths, memories (owner-scoped),
duplicates (owner-scoped), folders view (owner-scoped), `searchFaces` ML path (`search.repository.ts:318-353`
— do NOT widen; it would cross-link recognition between users), `AssetShare` permission (owner+partner only —
sharees must never create shared links / memories / tags on shared assets).

## 8. Verification gates (all must pass before commit)

1. `tsc --noEmit`, `eslint --max-warnings 0`, `svelte-check`, `prettier --check` — server, web, packages/sdk.
2. Unit suites: `pnpm --filter immich test` (server), web tests as applicable. New specs per §2.6/§3.7/§5.10.
3. Medium specs against real Postgres (devcontainer `database`): the Phase 4 medium-spec harness pattern
   (`server/test/medium/specs/...`) — new spec files for timeline OR-arm, search scoping, person reachability.
4. Migration: sql-tools generate → apply → "No changes detected" on BOTH upgraded and fresh DBs (§1.2).
5. Live e2e (devcontainer server + real HTTP, 2 accounts owner/sharee like Phase 4 §7.4): toggle flag on/off →
   buckets/search/map include/exclude; negative probes (archived owner asset invisible; isFavorite/originalPath
   probe returns owner-only; sharee cannot set role via new endpoint; owner cannot set sharee's inTimeline;
   sharee cannot rename/merge/delete/statistics a shared person; person thumbnail 403 when feature face is
   from an unshared asset).
6. Self security review sweep of the diff against §7 before finishing.

## 9. Delivery

- Documentation: `IMPLEMENTATION-LOG-phase5.md` (structure mirrors phase 4's log: what changed, §-numbered,
  security decisions, verification evidence, known gaps) + `PHASE5-UPGRADE-GUIDE.md` (mirrors Phase 4's guide:
  no new... — note: this phase HAS a migration, so include the migration-watch step like Phases 1-3 guides).
- Commit locally in logical commits (schema+endpoint / timeline / search+map+explore / people / web / sdk-regen
  / docs are fine as one or several — but keep the working tree clean and exclude
  `.devcontainer/devcontainer.json`, `mise.lock`, `.devcontainer/devcontainer-lock.json` which are pre-existing
  unrelated local modifications). DO NOT push — the supervisor reviews and pushes.

## 10. Environment notes for the implementer

- Windows host; repo under OneDrive. Shell: Git Bash or PowerShell. `pnpm` is NOT on PATH — use
  `npx --yes pnpm@11.6.0 <cmd>` on the host, or the devcontainer's pnpm (preferred for build/test).
- Devcontainers exist (stopped): `immich_postgres`, `immich_server`, `immich_redis`. `docker start` them; the
  repo root is bind-mounted at `/usr/src/app` inside `immich_server`, node_modules live in container volumes.
  ALWAYS prefix `docker exec` with `MSYS_NO_PATHCONV=1` when using `-w /absolute/paths` from Git Bash.
- Run server checks inside the container: `MSYS_NO_PATHCONV=1 docker exec -w /usr/src/app/server immich_server sh -c 'pnpm run build && npx tsc --noEmit && npx eslint src --max-warnings 0 && pnpm test -- --run'`
  (adapt to the actual script names in server/package.json; web equivalents under /usr/src/app/web).
- Medium tests need `DB_URL=postgres://postgres:postgres@database:5432/immich` (or the harness's own env; check
  `server/test/medium` setup for how Phase 4's specs connect).
- `.pnpmfile.cjs` is now platform-independent (both exiftool binaries promoted) — if you must touch
  `pnpm-lock.yaml`, regenerate with `npx --yes pnpm@11.6.0 install --lockfile-only` and verify
  `--frozen-lockfile --lockfile-only` passes; never hand-edit the lockfile, and never characterize a
  lockfile/manifest mismatch as harmless (see IMPLEMENTATION-LOG-phase4.md corrections).
- i18n: add new keys to `i18n/en.json` only.
- The `1783730178844-ShouldBeEmpty.ts` filename pattern means a stray generated file at `server/` root —
  always delete strays after generator runs.
