# Implementation Log — Phase 6: Mobile Support via Server-Side Pseudo-Partner Projection

Tracks work against `FEATURE-PLAN-phase6-mobile-projection.md`. Goal: shared-library photos appear in
the **stock** Immich mobile apps (iOS + Android, store builds, zero app modifications) for sharees who
enabled Phase 5's "Show in Photos, Explore, Map & Search" flag, by presenting each (library owner →
sharee) relationship as a pseudo-partner through the existing v2 sync protocol.

Status: **complete**, server-side only, per the plan's explicit "zero mobile app changes" scope. All
work verified against HEAD `33bbe4f`.

---

## 1. §7 verify-first recon (done BEFORE writing any server code, per the plan's explicit instruction)

### 1.1 `mobile/lib` recon (§7.1)

- **`SyncPartnerV1.inTimeline` → timeline query path**: `mobile/lib/infrastructure/repositories/timeline.repository.dart#watchTimelineUserIds` (`:39-49`) selects `partner_entity.sharedById` where `partner_entity.inTimeline = true AND partner_entity.sharedWithId = :userId`, appends the caller's own id, and is wrapped in a `.watch()` reactive stream consumed by `timelineUsersProvider` (`mobile/lib/providers/infrastructure/timeline.provider.dart:37-49`). The resulting `userIds` list is the sole gate for `mergedAsset`/`mergedBucket` (`mobile/lib/infrastructure/entities/merged_asset.drift:36-43,110-117`: `rae.owner_id IN :user_ids`) and for the per-partner detail page's own query (`timeline.repository.dart:314-319`: `row.ownerId.equals(ownerId)`, reached only when the partner row still exists in local listings).
- **visibility=hidden and deletedAt-set exclusion**: confirmed directly in `merged_asset.drift` (`rae.deleted_at IS NULL AND rae.visibility = 0 -- timeline visibility`, both the `mergedAsset` and `mergedBucket` queries) and in `timeline.repository.ts#remote` (`row.deletedAt.isNull() & row.visibility.equalsValue(AssetVisibility.timeline)`, used by the per-partner detail page). **Both hard-code visibility=timeline only** — Hidden (motion parts) and any deletedAt-set row are excluded from every mobile timeline/grid surface, confirming plan §0.4's assumption exactly. The map surface (`infrastructure/repositories/map.repository.ts#remote`, see §1.2) independently confirms the same exclusion.
- **`PartnerDeleteV1` locally**: `sync_stream.repository.dart#deletePartnerV1` (`:150-164`) deletes ONLY the `partner_entity` row (`WHERE sharedById = ? AND sharedWithId = ?`) — it does **not** touch `remote_asset_entity`. Because the main timeline and per-partner queries are reactive on `partner_entity` (previous bullet), removing that one row **instantly and correctly excludes the owner's assets from every gated surface** — this satisfies "the phone empties" as a *visibility* guarantee. The underlying asset rows are not physically deleted; `pruneAssets()` exists (`sync_stream.repository.dart:899-931`) but its only call site is commented out (`sync_stream.service.dart:291`), so it never runs in a stock app. This is a **pre-existing characteristic of how real-partner data already behaves** (not a Phase 6 regression) and does not weaken the security bar, since visibility (not literal SQLite row deletion) is the actual requirement.
- **`SyncResetV1` locally**: `sync_stream.repository.dart#reset` (`:43-85`) does a full transactional wipe of every remote-derived table (asset_face, memory/memory_asset, partner, person, remote album/album_asset/album_user, remote_asset, remote_exif, stack, auth_user/user, user_metadata, remote_asset_cloud_id, asset_edit, asset_ocr), matching plan's "full wipe+resync" assumption.

### 1.2 Which mobile surfaces call server REST vs. local DB (§7.2)

| Surface | Mechanism | Gets Phase 6 projection? |
|---|---|---|
| Main Photos timeline | Local DB (`merged_asset.drift`, gated by `watchTimelineUserIds`) | Yes — the point of this phase |
| Per-partner detail page ("Partners" list → tap a name) | Local DB (`timeline.repository.dart#remote`, gated by the partner row existing) | Yes |
| Map | **Local DB** (`infrastructure/repositories/map.repository.dart#remote`, queries `remote_exif_entity` JOIN `remote_asset_entity`, gated by `mapServiceProvider`'s `users` list which is `timelineUsersProvider` — the SAME reactive partner list as the main timeline, when the mobile "with partners" map toggle is on) | Yes, automatically, no Phase 6 map-specific code needed — confirms plan §0's framing that this is purely a sync-stream projection. Requires EXIF to be synced too (already covered by §2.6's exif backfill/upserts). |
| Search | **REST** (`domain/services/search.service.dart` → `SearchApiRepository` → `POST /search/...`) | Gets Phase 5's server-side widening "for free" — no Phase 6 code touches it, nothing to verify here beyond confirming it's REST-backed (done). |
| Memories | Local DB (`domain/services/memory.service.dart#DriftMemoryService`, driven by `MemorySync`) | **No** — `MemorySync` stays untouched per plan §0.7's explicit non-goal. Documented gap, not a bug. |
| People | Local DB (`PersonSync`) | **No** — `PersonSync` stays untouched per plan §0.7. Documented gap. |

### 1.3 Users-sync scoping (§7.3 / plan §0.2)

`UserSync.getUpserts` (`sync.repository.ts` — unchanged) has **no per-user WHERE clause at all**:
`this.upsertQuery('user', options).select(columns.syncUser).stream()`. It already streams every
non-deleted user's `{id, name, email, avatarColor, deletedAt, updateId, profileImagePath,
profileChangedAt}` to every client unconditionally (confirmed by reading `upsertQuery`'s generic
shape — no implicit filter is added anywhere for this specific call). **The owner's user record
already reaches every sharee today, with zero extension needed.** No new information is disclosed by
this projection: the owner's basic profile was already visible to literally any user in the system.

### 1.4 Checkpoint-interleaving (§7.4 / plan §3.4)

Confirmed `CheckpointMap = Partial<Record<SyncEntityType, SyncAck>>` (`sync.service.ts`) — **one ack
per `SyncEntityType`, full stop**, the same constraint every other entity type already lives with.
This means both `PartnerDeleteV1` (real partner_audit deletes ∪ resolved pseudo share-deletes) and
`PartnerAssetDeleteV1` (real asset_audit deletes ∪ pseudo hard-deletes ∪ pseudo scope-exits) share a
single checkpoint across sources with **different underlying id spaces** (different audit tables /
`asset.updateId`). Since every id space in this codebase is uuidv7 (time-ordered) and every query is
bounded by the same `nowId` watermark obtained once per `stream()` call, merging multiple sources by
ascending id is safe — but only if actually implemented as a **merge**, not "drain source A then
source B" (which could hand the client an ack lower than an already-delivered item, forcing avoidable
— though harmless/idempotent — re-sends on resume). Implemented via a generic lazy `mergeById`
async-generator (`sync.service.ts`) for the two/three-source asset-level merges, and an equivalent
small array-sort for the (always-small) relationship-level merges in `syncPartnersV1`. This confirms
(does not disprove) the plan's primary design — the fallback tombstone approach in §3.4 was **not
needed**.

### 1.5 Unconditional request types (§7.5)

`mobile/lib/infrastructure/repositories/sync_api.repository.dart#streamChanges` (`:42-80`) requests
`SyncRequestType.partnersV1` and `SyncRequestType.partnerAssetExifsV1` **unconditionally**, and
`partnerAssetsV2` whenever `serverVersion >= 3.0.0` (true for this server) — no per-user feature flag
gate on the client side. The projection is exercised by every stock client hitting this server
version.

### 1.6 A plan-cited mechanism that needed correcting (not a design change)

Plan §4 cites `sessionRepository.resetSyncProgress(sessionId)` as the "session reset" mechanism.
Reading `session.repository.ts` and its only two call sites in `sync.service.ts` shows this method
does the **opposite** of what's needed when called from outside the live `stream()`/`setAcks()` request
flow: it sets `isPendingSyncReset: false` and clears checkpoints — it's the "the reset has already been
agreed and is happening in THIS request" cleanup step, not a way to flag some OTHER session (e.g. a
sharee's phone, next time it happens to sync on its own schedule) to reset. The actual mechanism
`stream()` checks **unconditionally on every call**, regardless of `dto.reset`, is the
`session.isPendingSyncReset` column read via `sessionRepository.isPendingSyncReset(id)`
(`sync.service.ts:142-147`). There was no existing "set this flag to true for a user's sessions"
repository method, so this phase adds `SessionRepository.markPendingSyncReset(userId)` (mirrors the
existing `lockAll(userId)` shape) and uses that instead. The overall design (use the existing
reset-flag + `SyncResetV1` signal mechanism) is unchanged and confirmed correct; only the specific
method invoked was corrected after reading the actual code, per the plan's own instruction to verify
before coding.

---

## 2. Schema (§1)

- `library_user.timelineEnabledId uuid NULL` (`server/src/schema/tables/library-user.table.ts`,
  `server/src/database.ts#LibraryUser`). Set to a fresh `immich_uuid_v7()` exactly on a false→true
  `inTimeline` transition, cleared to NULL on true→false, left untouched on a false→false or true→true
  no-op — all computed **atomically in one SQL statement** via a new
  `LibraryRepository.updateMyShare(libraryId, userId, inTimeline)` method: a `CASE WHEN "inTimeline" =
  false THEN immich_uuid_v7() ELSE "timelineEnabledId" END` in the same `SET` list as the plain
  `inTimeline` assignment. Standard SQL semantics guarantee every expression in one `UPDATE`'s `SET`
  list reads the pre-update row image, so this is race-free without a separate read-then-write.
  `LibraryService.updateMyShare` calls this new method instead of the old generic `updateUser`.
- Migration: generated via the project's own `sql-tools` inside the devcontainer (see §6 below for the
  drift-check results), renamed above `1783810000000` per the established
  convention: `1783820000000-AddLibraryUserTimelineEnabledId.ts`. Backfills existing flagged rows:
  `UPDATE library_user SET "timelineEnabledId" = immich_uuid_v7() WHERE "inTimeline"`.

---

## 3. Repository layer (§2) — `server/src/repositories/sync.repository.ts`

Three new classes, mirroring `PartnerSync`/`PartnerAssetsSync`/`PartnerAssetExifsSync` 1:1 (kept as
siblings of the pre-existing cleanup-only `LibraryUserSync`, left untouched, rather than repurposing
it, to keep the blast radius on already-working code at zero):

- **`SharedLibrarySync`** (relationship-level): `getFlaggedShares(userId)` — the RAW flagged set,
  joined to live library + live owner, `{libraryId, ownerId, timelineEnabledId, updateId}`,
  deliberately NOT pre-suppressed by real-partner overlap (some callers need the raw truth; the
  service layer applies suppression against the real-partner list it already has). `getShareDeletes`
  — audit rows from `library_user_audit`, left-joined to `library` to resolve `ownerId` (null when the
  library itself is also gone — those hard-delete-cascade cases are covered immediately and
  independently by the explicit reset hooks in §4, not by this audit path).
- **`SharedLibraryAssetsSync`** (asset-level): `getBackfill(options, libraryId)`,
  `getUpserts(options, userId)` — both with the §0.4 scope predicate
  (`SHARED_LIBRARY_ASSET_VISIBILITY = [Timeline, Hidden]`, `deletedAt IS NULL`) pinned inside the
  query, `isFavorite` forced false and `stackId` forced null via literal selects. These two queries
  select from a dedicated `columns.syncSharedLibraryAsset` list (`database.ts` — `syncPartnerAsset`
  minus `asset.stackId`) so the NULL literal is the ONLY `stackId` output column: the same
  exclusion-plus-literal technique upstream already uses for `isFavorite`, rather than selecting the
  real column plus a same-alias override and relying on the driver's duplicate-column overwrite
  order (an earlier draft did exactly that; caught during SQL-snapshot review, §6 gate 4). Verified on
  the wire: streamed `PartnerAssetV2` events carry `"isFavorite":false,"stackId":null` (§6a, SYNC B).
  `getScopeExits(options, userId)` — assets whose library is still flagged-shared but
  which now fail the scope predicate, selecting `asset.updateId AS id, asset.id AS assetId` (the
  sortable watermark, not the asset's own unordered uuid) — id + assetId only, never metadata.
  `getHardDeletes(options, userId)` — over-broad by owner, exactly like the existing
  `PartnerAssetsSync.getDeletes`, since `asset_audit` has no `libraryId`.
- **`SharedLibraryAssetExifsSync`**: exif equivalents of the above two, scope predicate applied via
  the `asset` join/subquery.

All `@GenerateSql`-decorated; SQL snapshots regenerated (§6 gate 4).

---

## 4. Service layer (§3) — `server/src/services/sync.service.ts`

Projection arms added to the three existing handlers (`syncPartnersV1`, `syncPartnerAssetsV2`,
`syncPartnerAssetExifsV1`); no new `SyncRequestType`/`SyncEntityType`.

- **`syncPartnersV1`**: real and pseudo `PartnerV1` upserts are collected (not sent immediately),
  merged with the pseudo set (deduped per owner, highest `updateId` wins per §3.1), sorted by id, and
  emitted together — same treatment for `PartnerDeleteV1` deletes (real `partner_audit` ∪ resolved
  pseudo share-deletes). Pseudo-partner suppression uses the FULL current real-partner set (not just
  ack-gated freshly-changed ones — a long-established real partner must still suppress the pseudo arm
  even though it wouldn't appear in this cycle's real upserts).
- **`syncPartnerAssetsV2`** / **`syncPartnerAssetExifsV1`**: a new shared private helper,
  `getAssetBackfillSources`, computes the merged, suppressed, checkpoint-windowed list of backfill
  "sources" (real partners keyed by `createId`, flagged shares keyed by `timelineEnabledId`), reused by
  both handlers so the enumeration logic exists in exactly one place. The per-entry backfill query
  still differs (`partnerAsset`/`partnerAssetExif`.getBackfill(options, sharedById)` vs.
  `sharedLibraryAsset`/`sharedLibraryAssetExif`.getBackfill(options, libraryId)`), dispatched via a
  discriminated union (`'sharedById' in source`). Upserts and (for assets) deletes are merged lazily
  via `mergeById`, a small generic k-way-merge async generator, so no potentially-large asset stream is
  ever eagerly materialized.
- Real-partner overlap (matrix row "real partner created while projection active"): the backfill
  enumeration suppresses shares whose owner already has a real partner (the real arm's own backfill,
  keyed by `partner.createId`, already covers that owner's assets — including library-scoped ones —
  so a fresh pseudo backfill would be pure waste); the ONGOING per-cycle upsert stream does **not**
  suppress (matching the plan's explicit "duplicate upserts are idempotent" — harmless overlap, and
  cheaper than adding suppression logic to a hot path that's naturally idempotent anyway).

---

## 5. Transition matrix (§4) — centralized in `server/src/utils/shared-library-sync.ts`

`resolveSharedLibraryTransition({partnerRepository, syncRepository}, {ownerId, userId})` is the single
function every trigger point calls; it returns one of `'none' | 'reset' | 'delete'`. Deliberately
**sequential, not `Promise.all`**: checks the real partner first and short-circuits to `'none'`
without ever touching `syncRepository.sharedLibrary` — both a minor efficiency win (most callers of
this function, e.g. a plain real-partner removal with no library involvement, never need the second
query) and, more importantly, keeps the function safe to call from contexts (existing unit tests) that
haven't been updated to stub the shared-library sync repository. `maybeResetForSharedLibraryTransition`
wraps it and calls `sessionRepository.markPendingSyncReset(userId)` only on `'reset'`.

| Matrix row | Outcome | Covered by |
|---|---|---|
| First library flagged on | Pseudo `PartnerV1` + backfill via `timelineEnabledId` | `sync-shared-library-partner.spec.ts` ("should project a flagged library share…"), `sync-shared-library-asset.spec.ts` (full lifecycle) |
| Additional library flagged on (same owner) | Backfill that library, same pseudo partner (dedup) | `sync-shared-library-partner.spec.ts` ("should dedupe multiple flagged libraries…") |
| Flag off / unshare, other flagged libraries of O remain | **`'reset'`** — `LibraryService.updateMyShare`/`removeUser` | `shared-library-sync.spec.ts` (unit), `library.service.spec.ts` (`updateMyShare`, `removeUser` new tests), `sync-shared-library-partner.spec.ts` ("should NOT emit PartnerDeleteV1 when another flagged library…") |
| Flag off / unshare, LAST flagged library of O | **`'delete'`** → `PartnerDeleteV1` on next sync | `sync-shared-library-partner.spec.ts` ("should emit PartnerDeleteV1 once the last flagged library…"), full lifecycle spec |
| Real partner (O→U) deleted, flagged shares remain | **`'reset'`** — `PartnerService.remove` | `shared-library-sync.spec.ts`, `partner.service.spec.ts` (new tests), `sync-shared-library-partner.spec.ts` ("matrix row: real partner deleted…") |
| Real partner created while projection active | Real arm takes over; pseudo `PartnerV1` suppressed; asset upserts may harmlessly duplicate | `sync-shared-library-partner.spec.ts` ("should suppress the pseudo partner…"), `sync-shared-library-asset.spec.ts` ("still surfaces a library asset via the real arm…") |
| Library soft-deleted / owner deleted | Same as unshare, for every previously-flagged sharee — `LibraryService.delete` / `UserService.handleUserDelete` explicit hooks (added; the audit trail alone would lag until the async hard-delete job/cascade eventually runs) | `library.service.spec.ts` (`delete` new tests), `sync-shared-library-partner.spec.ts` ("library soft-deleted while it was the only flagged share…") |

---

## 6. Verification gates

| Gate | Result |
|---|---|
| Migration generation (sql-tools, devcontainer) | **PASS** — generated via `pnpm run build && pnpm run migrations:run && pnpm run migrations:generate AddLibraryUserTimelineEnabledId` inside `immich_server`, moved+renamed to `1783820000000-…` |
| Migration drift — upgraded DB | **PASS** — `migrations:generate ShouldBeEmpty` → “No changes detected” |
| Migration drift — fresh scratch DB | **PASS** — all migrations onto empty scratch DB, then `ShouldBeEmpty` → “No changes detected” |
| Server `tsc --noEmit` (full project incl. tests) | **PASS** (exit 0) |
| Server `eslint --max-warnings 0` | **PASS** — 0 errors, 0 warnings (17 findings during development, all fixed: 13 `unicorn/no-useless-undefined` → the codebase’s `mockResolvedValue(void 0)` idiom, 4 `unicorn/consistent-function-scoping` → hoisted to module scope) |
| `prettier --check` | **PASS** on all 19 created/modified server files (repo was format-clean at the phase-5 baseline, so the scoped check is equivalent to the tree check) |
| Server unit suite | **PASS** — 95 files, **2367 passed**, 2 pre-existing skips, 0 failures (`vitest run --config test/vitest.config.mjs`) |
| Server medium suite | **PASS** — full `test/medium/specs/sync/`: 28 files, **153 passed**, 0 failures (includes the three new specs AND the pre-existing `sync-partner`, `sync-partner-asset`, `sync-partner-asset-exif`, `sync-reset` regression specs); plus `services/sync.service`, `services/user.service`, `services/audit.database`: **32 passed** (testcontainers Postgres, all migrations incl. the new one) |
| SQL snapshots (`sync-sql.js`) | **PASS** — `Wrote 51 files / Generated 418 queries / Done`; exactly the 3 expected snapshots changed (`library.repository.sql`, `session.repository.sql`, `sync.repository.sql`); scope predicate visible inside every new projection query |
| Live protocol verification (fake device, session token) | **PASS** — full transcript in §6a |

### 6a. Live protocol verification transcript

Run 2026-07-13 against a `node ./dist/main.js` API worker (final built source) inside the
devcontainer, DB = the sandbox `immich` database, driven from the host as a fake mobile device: plain
`/auth/login` **session** token (never an API key), `POST /api/sync/stream` with
`{"types":["PartnersV1","PartnerAssetsV2","PartnerAssetExifsV1"]}`, acks posted to `/api/sync/ack`
after every stream exactly like the stock app. Scenario: owner with TWO shared external libraries
(one fixture asset + exif each), sharee flags both, then archive → unarchive → revoke one (reset
path) → revoke the last (delete path), plus no-share and owner-side regression checks.

What each step proves:

- **SYNC A** (shares exist, `inTimeline=false`): `SyncCompleteV1` only — no projection before opt-in.
- **SYNC B** (both flagged): exactly ONE pseudo `PartnerV1 {sharedById: owner, sharedWithId: sharee,
  inTimeline: true}` for two libraries (per-owner dedup), both `PartnerAssetV2` + both
  `PartnerAssetExifV1`; asset events carry `"isFavorite":false,"stackId":null` (sanitization literals
  on the wire). First-ever sync of the session ⇒ plain upserts, not `PartnerAssetBackfillV2` — the
  checkpoint short-circuit semantics confirmed in §7 recon (the true backfill wire path is covered by
  the “backfill ordering” medium specs).
- **SYNC C** (owner archives asset1): `PartnerAssetDeleteV1 {assetId}` only — scope exit, no metadata.
- **SYNC D** (un-archives): full `PartnerAssetV2` re-upsert; exif correctly NOT re-sent (untouched row).
- **STEP 9 / SYNC E–F** (revoke lib2, lib1 remains — the `'reset'` matrix row): session
  `isPendingSyncReset` flipped to `t` by the mutation hook; stream answers `SyncResetV1` only; the
  `reset:true` resync rebuilds PartnerV1 + asset1 + exif1 with **asset2 provably absent** and **no
  PartnerDeleteV1** (owner still a valid pseudo-partner via lib1); flag cleared (`f`) afterwards.
- **STEP 10 / SYNC G** (revoke lib1, the last one — the `'delete'` matrix row): no reset marked (`f`);
  `PartnerDeleteV1 {sharedById: owner, sharedWithId: sharee}` emitted — twice, once per audit row
  (lib2’s older row re-resolves to `'delete'` now that no flagged share remains; idempotent client
  no-op, the documented §7-deviation-3 re-evaluation behavior) — and zero asset/exif events. The phone
  empties via the partner-cascade.
- **SYNC H**: steady state `SyncCompleteV1` only.
- **STEP 11** (fresh user, no shares): `SyncCompleteV1` only — no pseudo artifacts for share-less users.
- **STEP 12** (the owner’s own stream): `SyncCompleteV1` only — the projection is strictly
  sharee-directional.

```text
=== STEP 0: admin login ===
admin token ok (dLK3kk3x...)
=== STEP 1: create owner + sharee ===
owner=76e0aff9-b986-4cd1-9d04-c8948c7df792 sharee=ed8eb307-aa6a-4aa2-ac43-db279d944693
=== STEP 2: create two libraries owned by owner ===
lib1=23ad0ac8-7621-463c-9c25-8b1558ebb1e6 lib2=2ab26eb5-8ac9-45e0-ba09-55a81410958d
=== STEP 3: share both libraries with sharee (viewer) ===
share lib1 http=200
share lib2 http=200
=== STEP 4: insert fixture asset+exif into each library (direct SQL) ===
asset1=0c9ce8a7-1ea1-4040-8e50-0f609b4ef9ae (lib1) asset2=02744749-d9fe-4963-bb8d-454f27f84ed9 (lib2)
=== STEP 5: sharee login (session token - the fake mobile device) ===
sharee token ok (Dbr6axt8...)
=== SYNC A: shares exist but inTimeline=false -> expect SyncCompleteV1 ONLY ===
{"type":"SyncCompleteV1","data":{},"ack":"SyncCompleteV1|019f5a2f-9b2f-7648-9114-1ab79530fc60"}
  (ack http=204 acks=["SyncCompleteV1|019f5a2f-9b2f-7648-9114-1ab79530fc60"])
=== STEP 6: sharee flags BOTH libraries into their timeline (self-service route) ===
flag lib1 http=200
flag lib2 http=200
=== SYNC B: expect pseudo PartnerV1(owner->sharee,inTimeline:true) + 2x PartnerAssetV2 + 2x PartnerAssetExifV1 ===
{"type":"PartnerV1","data":{"sharedById":"76e0aff9-b986-4cd1-9d04-c8948c7df792","sharedWithId":"ed8eb307-aa6a-4aa2-ac43-db279d944693","inTimeline":true},"ack":"PartnerV1|019f5a2f-9d6e-7c2f-b330-7e37cc1e3f6c"}
{"type":"PartnerAssetV2","data":{"id":"0c9ce8a7-1ea1-4040-8e50-0f609b4ef9ae","ownerId":"76e0aff9-b986-4cd1-9d04-c8948c7df792","originalFileName":"one.jpg","fileCreatedAt":"2026-07-13T06:34:54.806Z","fileModifiedAt":"2026-07-13T06:34:54.806Z","localDateTime":"2026-07-13T06:34:54.806Z","createdAt":"2026-07-13T06:34:54.806Z","type":"IMAGE","deletedAt":null,"visibility":"timeline","duration":null,"livePhotoVideoId":null,"libraryId":"23ad0ac8-7621-463c-9c25-8b1558ebb1e6","width":null,"height":null,"isEdited":false,"isFavorite":false,"stackId":null,"checksum":"XykS5i+iiiob0nO3TRkrcQ==","thumbhash":null},"ack":"PartnerAssetV2|019f5a2f-91d8-7a59-825a-41f745d82701"}
{"type":"PartnerAssetV2","data":{"id":"02744749-d9fe-4963-bb8d-454f27f84ed9","ownerId":"76e0aff9-b986-4cd1-9d04-c8948c7df792","originalFileName":"two.jpg","fileCreatedAt":"2026-07-13T06:34:56.051Z","fileModifiedAt":"2026-07-13T06:34:56.051Z","localDateTime":"2026-07-13T06:34:56.051Z","createdAt":"2026-07-13T06:34:56.051Z","type":"IMAGE","deletedAt":null,"visibility":"timeline","duration":null,"livePhotoVideoId":null,"libraryId":"2ab26eb5-8ac9-45e0-ba09-55a81410958d","width":null,"height":null,"isEdited":false,"isFavorite":false,"stackId":null,"checksum":"RpN8WygrHQAvXueRhbc4uQ==","thumbhash":null},"ack":"PartnerAssetV2|019f5a2f-96b4-77ab-8764-f876243031f5"}
{"type":"PartnerAssetExifV1","data":{"assetId":"0c9ce8a7-1ea1-4040-8e50-0f609b4ef9ae","description":"","exifImageWidth":null,"exifImageHeight":null,"fileSizeInByte":null,"orientation":null,"dateTimeOriginal":null,"modifyDate":null,"timeZone":null,"latitude":null,"longitude":null,"projectionType":null,"city":null,"state":null,"country":null,"make":"Phase6Cam","model":"ModelOne","lensModel":null,"fNumber":null,"focalLength":null,"iso":null,"exposureTime":null,"profileDescription":null,"rating":null,"fps":null},"ack":"PartnerAssetExifV1|019f5a2f-9447-7d08-b81a-7d0438abfada"}
{"type":"PartnerAssetExifV1","data":{"assetId":"02744749-d9fe-4963-bb8d-454f27f84ed9","description":"","exifImageWidth":null,"exifImageHeight":null,"fileSizeInByte":null,"orientation":null,"dateTimeOriginal":null,"modifyDate":null,"timeZone":null,"latitude":null,"longitude":null,"projectionType":null,"city":null,"state":null,"country":null,"make":"Phase6Cam","model":"ModelTwo","lensModel":null,"fNumber":null,"focalLength":null,"iso":null,"exposureTime":null,"profileDescription":null,"rating":null,"fps":null},"ack":"PartnerAssetExifV1|019f5a2f-9931-7b01-bd2b-9fbfe25eb8ff"}
{"type":"SyncCompleteV1","data":{},"ack":"SyncCompleteV1|019f5a2f-9dd4-75fe-90b1-57d2bc163da7"}
  (ack http=204 acks=["PartnerV1|019f5a2f-9d6e-7c2f-b330-7e37cc1e3f6c","PartnerAssetV2|019f5a2f-96b4-77ab-8764-f876243031f5","PartnerAssetExifV1|019f5a2f-9931-7b01-bd2b-9fbfe25eb8ff","SyncCompleteV1|019f5a2f-9dd4-75fe-90b1-57d2bc163da7"])
=== STEP 7: owner archives asset1 (scope exit) ===
=== SYNC C: expect PartnerAssetDeleteV1(asset1) ONLY - no metadata ===
{"type":"PartnerAssetDeleteV1","data":{"assetId":"0c9ce8a7-1ea1-4040-8e50-0f609b4ef9ae"},"ack":"PartnerAssetDeleteV1|019f5a2f-a107-7f5f-af7e-4021ce76e294"}
{"type":"SyncCompleteV1","data":{},"ack":"SyncCompleteV1|019f5a2f-a1e3-736b-a9a6-efda76653c81"}
  (ack http=204 acks=["PartnerAssetDeleteV1|019f5a2f-a107-7f5f-af7e-4021ce76e294","SyncCompleteV1|019f5a2f-a1e3-736b-a9a6-efda76653c81"])
=== STEP 8: owner un-archives asset1 (scope re-entry) ===
=== SYNC D: expect PartnerAssetV2(asset1) upsert again (+ its exif row is NOT re-sent: exif untouched) ===
{"type":"PartnerAssetV2","data":{"id":"0c9ce8a7-1ea1-4040-8e50-0f609b4ef9ae","ownerId":"76e0aff9-b986-4cd1-9d04-c8948c7df792","originalFileName":"one.jpg","fileCreatedAt":"2026-07-13T06:34:54.806Z","fileModifiedAt":"2026-07-13T06:34:54.806Z","localDateTime":"2026-07-13T06:34:54.806Z","createdAt":"2026-07-13T06:34:54.806Z","type":"IMAGE","deletedAt":null,"visibility":"timeline","duration":null,"livePhotoVideoId":null,"libraryId":"23ad0ac8-7621-463c-9c25-8b1558ebb1e6","width":null,"height":null,"isEdited":false,"isFavorite":false,"stackId":null,"checksum":"XykS5i+iiiob0nO3TRkrcQ==","thumbhash":null},"ack":"PartnerAssetV2|019f5a2f-a520-7a4c-b161-9ab7f95ad3f5"}
{"type":"SyncCompleteV1","data":{},"ack":"SyncCompleteV1|019f5a2f-a61e-7f96-901f-5ba47259b54e"}
  (ack http=204 acks=["PartnerAssetV2|019f5a2f-a520-7a4c-b161-9ab7f95ad3f5","SyncCompleteV1|019f5a2f-a61e-7f96-901f-5ba47259b54e"])
=== STEP 9: owner revokes the LIB2 share; lib1 stays flagged -> transition 'reset' ===
unshare lib2 http=204
-- session isPendingSyncReset for sharee (expect t):
t
=== SYNC E: expect SyncResetV1 ONLY (server demands the reset dance) ===
{"type":"SyncResetV1","data":{},"ack":"SyncResetV1|reset"}
=== SYNC F (reset:true): full resync. Expect PartnerV1 + asset1 + exif1; asset2/lib2 MUST be absent; NO PartnerDeleteV1 ===
{"type":"PartnerV1","data":{"sharedById":"76e0aff9-b986-4cd1-9d04-c8948c7df792","sharedWithId":"ed8eb307-aa6a-4aa2-ac43-db279d944693","inTimeline":true},"ack":"PartnerV1|019f5a2f-9d0c-7e6a-85e3-dfcbe9ee71a5"}
{"type":"PartnerAssetV2","data":{"id":"0c9ce8a7-1ea1-4040-8e50-0f609b4ef9ae","ownerId":"76e0aff9-b986-4cd1-9d04-c8948c7df792","originalFileName":"one.jpg","fileCreatedAt":"2026-07-13T06:34:54.806Z","fileModifiedAt":"2026-07-13T06:34:54.806Z","localDateTime":"2026-07-13T06:34:54.806Z","createdAt":"2026-07-13T06:34:54.806Z","type":"IMAGE","deletedAt":null,"visibility":"timeline","duration":null,"livePhotoVideoId":null,"libraryId":"23ad0ac8-7621-463c-9c25-8b1558ebb1e6","width":null,"height":null,"isEdited":false,"isFavorite":false,"stackId":null,"checksum":"XykS5i+iiiob0nO3TRkrcQ==","thumbhash":null},"ack":"PartnerAssetV2|019f5a2f-a520-7a4c-b161-9ab7f95ad3f5"}
{"type":"PartnerAssetExifV1","data":{"assetId":"0c9ce8a7-1ea1-4040-8e50-0f609b4ef9ae","description":"","exifImageWidth":null,"exifImageHeight":null,"fileSizeInByte":null,"orientation":null,"dateTimeOriginal":null,"modifyDate":null,"timeZone":null,"latitude":null,"longitude":null,"projectionType":null,"city":null,"state":null,"country":null,"make":"Phase6Cam","model":"ModelOne","lensModel":null,"fNumber":null,"focalLength":null,"iso":null,"exposureTime":null,"profileDescription":null,"rating":null,"fps":null},"ack":"PartnerAssetExifV1|019f5a2f-9447-7d08-b81a-7d0438abfada"}
{"type":"SyncCompleteV1","data":{},"ack":"SyncCompleteV1|019f5a2f-ab23-700a-a859-e0f3f96e21d8"}
  (ack http=204 acks=["PartnerV1|019f5a2f-9d0c-7e6a-85e3-dfcbe9ee71a5","PartnerAssetV2|019f5a2f-a520-7a4c-b161-9ab7f95ad3f5","PartnerAssetExifV1|019f5a2f-9447-7d08-b81a-7d0438abfada","SyncCompleteV1|019f5a2f-ab23-700a-a859-e0f3f96e21d8"])
-- session isPendingSyncReset after reset sync (expect f):
f
=== STEP 10: owner revokes the LIB1 share too (last flagged) -> transition 'delete', no reset ===
unshare lib1 http=204
-- session isPendingSyncReset for sharee (expect f):
f
=== SYNC G: expect PartnerDeleteV1(owner->sharee) and NO asset/exif events -> phone empties via partner cascade ===
{"type":"PartnerDeleteV1","data":{"sharedById":"76e0aff9-b986-4cd1-9d04-c8948c7df792","sharedWithId":"ed8eb307-aa6a-4aa2-ac43-db279d944693"},"ack":"PartnerDeleteV1|019f5a2f-a7e1-7b7e-a12a-03dc38d132c1"}
{"type":"PartnerDeleteV1","data":{"sharedById":"76e0aff9-b986-4cd1-9d04-c8948c7df792","sharedWithId":"ed8eb307-aa6a-4aa2-ac43-db279d944693"},"ack":"PartnerDeleteV1|019f5a2f-af58-78fd-b98f-34862d62f715"}
{"type":"SyncCompleteV1","data":{},"ack":"SyncCompleteV1|019f5a2f-b229-778f-a5e0-05ddf3fa17bd"}
  (ack http=204 acks=["PartnerDeleteV1|019f5a2f-af58-78fd-b98f-34862d62f715","SyncCompleteV1|019f5a2f-b229-778f-a5e0-05ddf3fa17bd"])
=== SYNC H: steady state after full revocation -> SyncCompleteV1 only ===
{"type":"SyncCompleteV1","data":{},"ack":"SyncCompleteV1|019f5a2f-b3cd-70c5-b190-156e24f53305"}
=== STEP 11: regression - user with NO library shares sees a byte-plain stream ===
create stranger http=201
{"type":"SyncCompleteV1","data":{},"ack":"SyncCompleteV1|019f5a2f-b5cd-759d-a1f8-32168df63261"}
=== STEP 12: asymmetry - the OWNER's own stream must contain no pseudo events either ===
{"type":"SyncCompleteV1","data":{},"ack":"SyncCompleteV1|019f5a2f-b740-7bea-a417-63a8e565d1f2"}
=== DONE ===
OWNER_ID=76e0aff9-b986-4cd1-9d04-c8948c7df792 SHAREE_ID=ed8eb307-aa6a-4aa2-ac43-db279d944693 LIB1=23ad0ac8-7621-463c-9c25-8b1558ebb1e6 LIB2=2ab26eb5-8ac9-45e0-ba09-55a81410958d ASSET1=0c9ce8a7-1ea1-4040-8e50-0f609b4ef9ae ASSET2=02744749-d9fe-4963-bb8d-454f27f84ed9
```

Cleanup after the run: all `p6*@e2e.test` users deleted (cascading libraries, shares, assets,
sessions), their `library_user_audit`/`asset_audit`/`user_audit` rows purged, the verification server
process stopped, and the container temp logs removed. Fixture assets were metadata-only SQL rows
(no files on disk).

---

## 7. Deviations from the plan, and why

1. **§4's cited `resetSyncProgress` corrected to a new `markPendingSyncReset`** — see §1.6 above. Same
   overall mechanism (the `isPendingSyncReset` flag + `SyncResetV1` signal), corrected method.
2. **`resolveSharedLibraryTransition` is sequential, not `Promise.all`** — a deliberate efficiency +
   test-safety choice (§5 above), not a plan deviation in outcome.
3. **`getShareDeletes`/`PartnerDeleteV1` "reset"/"none"-outcome rows are not proactively acked** — a
   `library_user_audit` row whose transition currently resolves to `'reset'` or `'none'` is simply not
   emitted as a delete; it is re-evaluated fresh on every subsequent sync for that user until it
   resolves to `'delete'` or ages out of the 30-day audit-cleanup window
   (`SyncService.onAuditTableCleanup`). This is a bounded, low-cost simplification (re-evaluation is two
   cheap indexed lookups) rather than inventing a new "advance the checkpoint without emitting a wire
   event" mechanism that doesn't exist elsewhere in this codebase. Documented, not hidden.
4. **Explicit reset hooks added to `LibraryService.delete` and `UserService.handleUserDelete`** for the
   "library soft-deleted / owner deleted" matrix row, beyond what the plan's wording strictly required
   ("covered by reset-or-delete per the rows above; add explicit spec"). Verified that a bare
   soft-delete never touches `library_user` rows (so no audit trail exists for the audit-driven path to
   consume) — the async job that eventually hard-deletes an emptied library (and cascades the
   `library_user` rows) could take arbitrarily long for a large library. Added explicit, immediate hooks
   rather than relying on that eventual cascade, for a tighter “revocation provably empties the phone”
   guarantee. Both existing services already had every dependency needed (no new DI wiring).
5. **Existing unit tests updated for new unconditional repository calls**: `user.service.spec.ts`
   (`handleUserDelete`, 3 tests) and `library.service.spec.ts` (`delete`, 3 tests) now stub
   `mocks.library.getOwned` / `mocks.library.getSharedUsers` respectively, since these methods are now
   called unconditionally as part of computing which sharees might need a reset. No test's asserted
   *behavior* changed, only its mock setup.
6. **`SyncTestContext` (`test/medium.factory.ts`) now constructs `SyncService` with a real
   `PartnerRepository`** — the new `PartnerDeleteV1` projection arm consults the real partner table
   (`resolveSharedLibraryTransition`), and the medium specs insert real partner rows precisely to test
   suppression, so a real repository (not a mock) is semantically required. Test-infrastructure-only
   change; caught by the first medium-suite run.
7. **Two of the new medium "scope predicate" specs had their expectations corrected during
   verification**: an asset that is out-of-scope from birth (created archived/locked in a flagged
   library) is NOT met with total stream silence — the scope-exit stream over-delivers a bare
   `PartnerAssetDeleteV1` for it, because the server cannot know whether the client ever saw the asset
   (deviation 3's documented over-delivery contract; unknown ids are client no-ops). The specs now
   assert the *stronger* invariant instead: the only permitted mention is a delete whose `data` is
   **exactly** `{assetId}` — proving no metadata field rides along — followed by `SyncCompleteV1`.
   The code was right; the initial test expectation was stricter than the design.
8. **The live run surfaced double `PartnerDeleteV1` emission after the final revocation** (SYNC G in
   §6a): each of the two `library_user_audit` rows independently re-resolved to `'delete'` once no
   flagged share remained, producing two identical delete events. This is deviation 3's re-evaluation
   design behaving as documented (idempotent client no-op), recorded here so nobody later mistakes it
   for a bug.

---

## 8. Not in this phase / left open

- Mobile People and Memories stay unaffected (`PersonSync`/`MemorySync` untouched), per the plan's
  explicit non-goal (§0.7). Documented in the upgrade guide.
- Mobile Search and Map get Phase 5's server-side widening automatically (Search: plain REST; Map:
  local DB gated by the same partner list this phase populates) — no Phase 6 code required, confirmed
  via recon (§1.2), not additionally "implemented."
- An actual phone was not available in this session — Paul validates post-deploy per the upgrade
  guide's step 5b checklist (plan §6 gate 5's explicit acknowledgment that this isn't verifiable here).
- Full `e2e/` suite not run in this session (same standing gap noted in every prior phase's log).
