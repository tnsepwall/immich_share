# Phase 6 — Mobile support via server-side pseudo-partner projection

Goal: shared-library photos appear in the **stock** Immich mobile apps (iOS + Android, store builds,
zero app modifications) for sharees who enabled the Phase 5 "Show in Photos, Explore, Map & Search"
flag. Mechanism: the server's v2 sync stream presents each (library owner → sharee) relationship as a
**pseudo-partner** and streams the flagged libraries' assets through the existing partner sync entity
types, which the stock app already knows how to store, timeline, and display.

All file:line references verified against HEAD (`33bbe4f`). Read `IMPLEMENTATION-LOG-phase5.md` and
`FEATURE-PLAN-phase5-global-surfaces.md` §0/§7 first — every Phase 1-5 security invariant binds here.

---

## 0. Settled design decisions (do not relitigate)

1. **Zero mobile-app changes.** Everything happens in `server/src/services/sync.service.ts` +
   `server/src/repositories/sync.repository.ts` (+ one small schema addition). Users keep store apps.
2. **Pseudo-partner identity**: for each library owner O with ≥1 library shared to user U where
   `library_user.inTimeline = true`, the sync stream emits a `SyncPartnerV1`
   `{ sharedById: O, sharedWithId: U, inTimeline: true }` — unless a REAL partner row (O→U) exists
   (real partner supersedes; see §4 matrix). The owner's user record already reaches clients via the
   existing users sync (verify: `UserSync`/`UsersV1` in sync.repository.ts streams all non-deleted
   users — confirm the owner appears for sharees; if users sync is scoped, extend it to include
   pseudo-partner owners the same way it includes real partners).
3. **Flag semantics = web contract**: ONLY `inTimeline = true` libraries stream to the phone. The
   Phase 5 toggle is the single switch for "photos on my phone" too. Flag-off/unshare removes them
   (via §4). Pseudo `PartnerV1.inTimeline` is always `true`.
4. **Asset scope** (the projection's canonical predicate, mirroring Phase 1's
   `checkSharedLibraryAccess`, access.repository.ts:253-278): asset in a flagged shared library,
   `asset.deletedAt IS NULL`, `asset.visibility IN ('timeline','hidden')` — Hidden admitted ONLY
   because live-photo motion parts are visibility=hidden and the stock app needs them for playback
   (it already hides visibility=hidden from timelines for real partner data; verify in mobile — §7.1).
   Archived and locked NEVER stream. Trashed = scope exit.
5. **Field masking in projected asset rows** (columns list `syncPartnerAsset`, database.ts:441-461):
   `isFavorite` already masked false by the existing partner queries (sync.repository.ts:645,665) —
   keep; `stackId` → **null** (stacks are owner-only in this feature, Phase 5 §2.4); `libraryId`
   passes through unchanged; `livePhotoVideoId` passes through (motion part streams per §0.4).
   EXIF rows (`syncAssetExif` columns) stream as-is, matching web behavior (sharees see EXIF).
6. **Scope exits become deletes, not stale data**: when an in-library asset stops matching §0.4
   (archived, trashed, moved out of the library) the sharee's phone must DELETE it, not keep a stale
   copy and not receive the new state. See §3.4.
7. **No other sync surface changes**: Phase 2's album exclusions stay byte-identical
   (`album_asset.sourceLibraryId IS NULL` filters at sync.repository.ts:343 and siblings);
   PersonSync/MemorySync/StackSync/AlbumSync untouched; `PartnerStackSync` NOT extended (stacks
   owner-only). Mobile people/search surfaces that call server REST APIs get Phase 5 behavior for
   free — the implementer documents (not changes) which mobile surfaces those are (§7.2).
8. **Editors are Viewers on mobile.** No editing of shared assets from the phone in v1 (the stock
   app treats partner assets read-only, which matches).

## 1. Schema: one new column for backfill keying

`library_user.timelineEnabledId uuid NULL` — set to `immich_uuid_v7()` every time `inTimeline`
transitions false→true, cleared to NULL on true→false. Why: the partner backfill loop is keyed on a
uuidv7 "created" watermark (`PartnerSync.getCreatedAfter`, sync.repository.ts:606-615, compared
against the backfill checkpoint in sync.service.ts:310-349). A share whose flag turns on LATER than
row creation must still trigger a backfill, so the backfill key must be the flag-enable moment, not
`createId`.

- Table class: `server/src/schema/tables/library-user.table.ts` (+ `server/src/database.ts` model).
- Set/clear in `LibraryService.updateMyShare` (library.service.ts, the Phase 5 sharee endpoint) —
  inside the same repository update, not a second write.
- Migration via the proven sql-tools devcontainer flow (Phase 5 plan §1.2 has the exact commands);
  RENAME the generated timestamp above `1783810000000` (e.g. `1783820000000-AddLibraryUserTimelineEnabledId.ts`);
  drift-check "No changes detected" on upgraded AND fresh DBs. Backfill existing flagged rows in the
  migration: `UPDATE library_user SET "timelineEnabledId" = immich_uuid_v7() WHERE "inTimeline"`.

## 2. Repository layer (`sync.repository.ts`)

Extend `LibraryUserSync` (currently cleanup-only, :431-436) — or add a sibling `SharedLibrarySync`
class — with, all `@GenerateSql`-decorated and modeled on `PartnerSync`/`PartnerAssetsSync`
(:604-700):

2.1 `getFlaggedShares(userId)`: library_user rows for U with `inTimeline = true`, joined to live
    library + live owner (shape of `getSharedWithUser`, library.repository.ts:201-218), returning
    `{ libraryId, ownerId, timelineEnabledId, updateId }`. Used by the service for pseudo-partner
    emission, suppression checks, and backfill enumeration.
2.2 `getBackfill(options, libraryId)`: `backfillQuery('asset', options)` + `syncPartnerAsset`
    columns + masks (§0.5) + `WHERE asset.libraryId = :libraryId AND deletedAt IS NULL AND
    visibility IN ('timeline','hidden')`.
2.3 `getUpserts(options, userId)`: `upsertQuery('asset', options)` + same columns/masks + `WHERE
    asset.libraryId IN (SELECT libraryId FROM library_user WHERE userId = :userId AND inTimeline)`
    + the §0.4 scope predicate.
2.4 `getScopeExits(options, userId)`: assets with `updateId` in the same window whose library is
    flagged-shared to U but which FAIL the scope predicate (deletedAt set OR visibility NOT IN
    (timeline, hidden)) → emitted as deletes (§3.4). Select only `id, updateId` — never metadata.
2.5 `getHardDeletes(options, userId)`: `auditQuery('asset_audit', options)` where `ownerId IN
    (owners of U's flagged shares)` — over-broad by owner exactly like `PartnerAssetsSync.getDeletes`
    (:651-659; unknown ids are client no-ops). asset_audit has no libraryId (asset-audit.table.ts:4-16),
    so owner-scope is the available granularity.
2.6 Exif equivalents of 2.2/2.3 modeled on `PartnerAssetExifsSync` (:674-700), with the same
    library + scope predicate via the asset join.
2.7 `getShareDeletes(options, userId)`: `auditQuery('library_user_audit', options)` where
    `userId = :userId` → drives §4 revocation handling.

## 3. Service layer (`sync.service.ts`)

The projection rides the EXISTING request/entity types — `SyncRequestType.PartnersV1` and
`PartnerAssetsV2`/`PartnerAssetExifsV1` handlers (`syncPartnerAssetsV2` :298-355,
`syncPartnerAssetExifsV1` :380-425, and the partners handler) get a projection arm after the real
arm. New entity types are NOT introduced (stock app wouldn't know them).

3.1 **PartnerV1 projection**: after real partner upserts, emit `SyncPartnerV1` for each §2.1 share
    pair NOT covered by a real partner row, `inTimeline: true`, ack id = `library_user.updateId`.
    Dedupe multiple libraries from one owner to a single record (highest updateId wins the ack).
3.2 **PartnerDeleteV1 projection**: from §2.7 audit rows, emit ONLY when, post-delete, the (O→U)
    pair has no remaining flagged libraries AND no real partner row — otherwise §4 handles it.
3.3 **Asset + exif projection**: inside the same handlers, after the real-partner streams: backfill
    per newly-flagged share (key = `timelineEnabledId`, merged into the same backfill checkpoint
    stream the partner arm uses — both keys are uuidv7 so the shared high-watermark ordering holds;
    follow the exact loop shape at :310-349 including `isEntityBackfillComplete` /
    `sendEntityBackfillCompleteAck` / the no-upsert-checkpoint first-sync short-circuit), then
    upserts (§2.3) under the same `PartnerAssetV2` upsert checkpoint.
3.4 **Scope exits** (§2.4) are emitted as `PartnerAssetDeleteV1` with ack id = the asset's
    `updateId` (NOT an audit id). They must be sent BEFORE the upsert stream in the handler, in
    updateId order. Rationale: audit-id acks and updateId acks are both uuidv7 and the delete
    checkpoint only needs monotonicity, but VERIFY the checkpoint compare logic
    (`fromAck`/checkpoint update path) tolerates interleaving the two id sources; if it compares
    strictly per-type (it does — one ack per entity type), keep hard-delete (§2.5) and scope-exit
    (§2.4) ordered together by their id before sending. Fallback if verification disproves this:
    emit scope exits as `PartnerAssetV2` upserts carrying `deletedAt = now` and all other
    scope-sensitive fields nulled (a tombstone the app treats as trashed) — but ONLY adopt the
    fallback after confirming in `mobile/lib` that a deletedAt-bearing partner asset is hidden from
    every mobile surface (§7.1 verification item).
3.5 **Restores re-enter naturally**: unarchive/untrash bumps `asset.updateId`, so the §2.3 upsert
    stream re-sends the row — no backfill needed. Add a medium spec proving delete→restore round-trip.

## 4. The hard edge cases (decision matrix — implement exactly this)

| Event | No real partner (O→U) | Real partner exists |
|---|---|---|
| First library flagged on | Pseudo PartnerV1 + backfill via timelineEnabledId | Nothing (real partner already streams all owner assets) |
| Additional library flagged on | Backfill that library (same pseudo partner) | Nothing |
| Flag off / unshare, other flagged libraries of O remain | **Session reset** for U (see below) | Nothing |
| Flag off / unshare, LAST flagged library of O | PartnerDeleteV1 (app wipes O's assets locally) | Nothing |
| Real partner (O→U) deleted, flagged shares remain | n/a | **Session reset** for U |
| Real partner created while projection active | Real arm takes over; duplicate upserts are idempotent; stop emitting pseudo PartnerV1 (real one, with the OWNER's real inTimeline flag, wins) | n/a |
| Library soft-deleted / owner deleted | Same as unshare (flagged shares stop matching §2.1's live joins) — covered by reset-or-delete per the rows above; add explicit spec | Nothing |

**Session reset** = `sessionRepository.resetSyncProgress(sessionId)` for each of U's sessions — the
existing mechanism (sync.service.ts:138-147): the next stream sends `SyncResetV1` and the app
performs a clean full re-sync (idempotent, correct, acceptable for these rare transitions). Trigger
points live in the SERVICES that perform the transition: `LibraryService.updateMyShare` (flag-off),
`LibraryService.removeUser` (unshare), `PartnerService.remove` (real-partner delete — only when
flagged shares exist for the pair), library delete path. Add a small
`SharedLibraryProjectionService` (or utility) owning the "does this transition require reset?"
decision so the rule lives in ONE place, with unit specs per matrix row. NOTE: resetting on
unshare also cleanly guarantees the revoked user's phone drops the assets even in webhook-less
scenarios — call `resetSyncProgress` in the same transaction/flow as the share mutation.

## 5. Security invariants (review bar — the §7 sweep of the Phase 5 plan applies)

- Never stream archived/locked/trashed asset rows or their EXIF to a sharee — the §0.4 predicate is
  pinned INSIDE every projection query; scope exits carry id+timestamp only (§2.4 selects no metadata).
- Never widen `PartnerStackSync`, album sync classes, PersonSync, MemorySync. Phase 2 provenance
  exclusions untouched.
- `isFavorite` masked false; `stackId` nulled.
- The projection must not disturb REAL partner semantics in any way when no shares exist (regression
  specs: partner-only fixtures produce byte-identical streams before/after this phase).
- Sharee revocation must provably remove assets from the phone (reset or PartnerDeleteV1 — matrix
  rows all covered by medium specs).
- Sync requires session auth (`throwSessionRequired`, sync.service.ts:134-136) — no api-key surface.

## 6. Verification gates

1. Unit: matrix-row decision specs for the reset/delete logic; service specs for suppression
   (real-partner overlap) and dedupe.
2. Medium (real Postgres, the existing sync medium-spec harness — find it under
   `server/test/medium/specs/` sync specs and follow its stream-consumption pattern): full
   lifecycle spec — share → flag on → backfill contents exact → new asset upserts → archive =
   delete event → unarchive = re-upsert → flag off = reset marker → re-sync excludes; plus
   real-partner overlap and revocation rows of the matrix; plus the regression spec of §5.
3. Live protocol verification against the devcontainer server (Phase 4/5 curl pattern, but sync
   needs a SESSION token from /auth/login, not an api key): consume /api/sync/stream as a fake
   device for a sharee account, ack checkpoints, assert the projected entities and the
   archive→delete flow end-to-end. Save transcripts in the implementation log.
4. Standard gates: server tsc/eslint/prettier, SQL snapshot regen (`node ./dist/bin/sync-sql.js`
   after build — the queries are @GenerateSql'd), unit + medium suites, migration drift checks.
5. NOT verifiable here: an actual phone. Document explicitly that Paul validates with the stock app
   post-deploy (install-fresh + upgrade-in-place both; the PHASE6-UPGRADE-GUIDE.md must include a
   "on your phone" checklist: sharee sees photos after enabling the web toggle; owner name appears
   as a partner under Sharing; archived photo disappears from phone within a sync cycle; unshare
   empties them).

## 7. Explicit verify-first items (do these BEFORE coding, adjust plan if disproven)

7.1 `mobile/lib` (read-only recon, cite files): how `SyncPartnerV1.inTimeline` reaches the timeline
    query (user.model.dart:46 carries it; find the Drift timeline filter); that visibility='hidden'
    and deletedAt-set partner assets are excluded from all mobile surfaces; what `PartnerDeleteV1`
    deletes locally (partner row + assets?); what happens on `SyncResetV1` (full wipe+resync).
7.2 Which mobile surfaces call server REST (search? map? memories?) vs local DB — document the
    "free" Phase 5 coverage in the implementation log.
7.3 The users-sync scoping question from §0.2.
7.4 The checkpoint-interleaving question from §3.4.
7.5 Whether the app requests `PartnersV1`/`PartnerAssetsV2`/`PartnerAssetExifsV1` unconditionally
    (grep mobile sync request construction) — projection is useless if a request type isn't asked for.

## 8. Delivery

- `IMPLEMENTATION-LOG-phase6.md` (mirror phase 5's structure; include the §7 recon findings, the
  matrix with spec pointers, live-protocol transcripts) + `PHASE6-UPGRADE-GUIDE.md` (migration
  watch step + the on-your-phone checklist).
- Logical local commits, `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`, NEVER touch
  `.devcontainer/devcontainer.json` / `mise.lock` / `.devcontainer/devcontainer-lock.json`, DO NOT
  push (supervisor reviews and pushes).
- Environment: all Phase 5 plan §10 notes apply verbatim (devcontainer commands, MSYS_NO_PATHCONV,
  npx pnpm@11.6.0, migration rename discipline, stray generator files).
