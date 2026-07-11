# Implementation Log — Phase 4: Person/Face Editing + Role-Aware Web UI

Tracks work against `FEATURE-PLAN-shared-external-libraries.md`, section 8 "Implementation order," Phase 4 (the
last phase):
> **Person/face editing + role-aware web UI**: the remaining curation endpoints and the web editor surfaces
> (Steps 12–14 finish here).

Builds on Phase 1 (`library_user` sharing), Phase 2 (album provenance), and Phase 3 (Editor metadata) — see
`IMPLEMENTATION-LOG-phase1.md` / `phase2.md` / `phase3.md`. Status: **complete** — server and web, reviewed and
verified. This is the last phase per the plan; there is no Phase 5.

---

## 1. What this phase adds

A shared-library **Editor** can now view and curate the people/faces reachable through a shared library, in
addition to Phase 3's metadata editing:

- List people visible through this library (`GET /libraries/:libraryId/people`, paginated).
- List faces on a specific library asset (`GET /libraries/:libraryId/assets/:assetId/faces`).
- Create a new person from a set of in-library faces (`POST /libraries/:libraryId/people`).
- Rename a person, but **only** if every one of their faces is inside this library (`PUT
  /libraries/:libraryId/people/:personId`).
- Reassign existing faces to a person already visible through this library (`PUT /libraries/:libraryId/faces`).
- Draw a new manual face box and assign it (`POST /libraries/:libraryId/faces`).

A **Viewer** can do the two read operations above (seeing who's tagged in a photo they can already view) but
none of the four mutations.

The central guarantee, same spirit as Phase 3's "never write to the owner's files": an Editor must never see or
affect a person's data, faces, or thumbnail from **outside** the shared library. A person's global
`thumbnailPath` is never returned to a library-scoped caller — responses carry a `thumbnailFace` (asset id +
bounding box + image dimensions) instead, cropped from an in-library asset, for the client to crop client-side.

---

## 2. Access control: five new permissions, two access models

`server/src/enum.ts`: `Permission.LibraryPersonRead`, `LibraryPersonCreate`, `LibraryPersonUpdate`,
`LibraryFaceCreate`, `LibraryFaceUpdate`.

`server/src/utils/access.ts`'s `checkOtherAccess` switch treats all five ids as **library ids**, but resolves
them differently by read/write:

- `LibraryPersonRead` → owner ∪ **any** shared role (`checkSharedAccess`) — identical shape to the existing
  `Permission.LibraryRead` case. Seeing who's tagged in a photo is part of viewing the photo; a Viewer share
  already grants that.
- `LibraryPersonCreate` / `LibraryPersonUpdate` / `LibraryFaceCreate` / `LibraryFaceUpdate` → owner ∪ **Editor
  only** (`checkEditorAccess`), same shape as Phase 3's `LibraryAssetUpdate`.

**A real bug caught during this session's own review** (not the later adversarial pass): `LibraryPersonRead` was
initially written into the *same* switch case as the four mutation permissions, which would have silently denied
Viewers the two read endpoints entirely, contradicting the controller's own documented "Editor/Viewer role"
description on those routes. Caught and fixed by rereading the access-resolution code against what the routes
actually claimed to allow, before any external review ran.

`server/src/repositories/access.repository.ts`'s `PersonAccess` class gained three standalone scope predicates —
used by both the (kept for testability, matching Phase 3's `checkLibraryAssetScope` precedent) `AccessRepository`
copies and, separately, by inline duplicates inside the actual write-path transactions (§3), since
`AccessRepository`'s methods are bound to their own injected `this.db` and can't run inside an arbitrary
transaction:

- `checkLibraryFaceScope(libraryId, faceIds)` — a face counts as in-scope only via a non-deleted, visible face on
  a non-deleted, Timeline-visibility asset that genuinely belongs to the library.
- `checkLibraryPersonScope(libraryId, personIds)` — a person counts as in-scope only if they have at least one
  such in-scope face.
- `checkPersonExclusiveToLibrary(libraryId, personId)` — true only when the person has zero non-deleted faces
  **outside** this library (required before a rename). A trashed (soft-deleted) *outside* asset still counts as
  a real footprint — it's restorable — so the join carries no `asset.deletedAt` filter on either side; only a
  hard-deleted `asset_face` row (via the `WHERE` clause) drops out of either count. This asymmetry versus the
  scope predicates above (which *do* require Timeline + non-deleted) is deliberate: scope answers "can this be
  reached via a normal browse," exclusivity answers "does this person have *any* footprint elsewhere, even
  dormant," and the latter must be the more conservative of the two.

---

## 3. Transactional primitives: create-and-assign is atomic, every mutation re-verifies scope at write time

Mirroring Phase 3's `AssetRepository#updateLibraryAssetMetadata` pattern exactly, `PersonRepository` gained four
methods that each open their **own** `this.db.transaction()`, re-verify role and every referenced entity's
library scope **inside** that transaction, and only then write:

- `createPersonForLibrary(libraryId, actorId, name, faceIds)` — inserts the person (owned by the library owner,
  not the editor), reassigns every face to it, and picks a feature photo, all in one transaction. If any face
  turns out to be out of scope, **nothing is written at all** — no orphaned, empty, owner-scoped person is left
  behind.
- `updatePersonNameForLibrary(libraryId, actorId, personId, name)` — re-checks scope and exclusivity, then
  renames.
- `assignFacesForLibrary(libraryId, actorId, personId, faceIds)` — re-checks face scope and that the target
  person is already reachable through this library (not an arbitrary personId elsewhere in the owner's
  account), then reassigns.
- `createManualFaceForLibrary(libraryId, actorId, personId, assetId, box)` — re-checks person scope **and** asset
  scope (Timeline-visibility, non-deleted, genuinely this library — not just `libraryId` equality), then inserts
  the face.

All four share a private `reassignFacesTx` helper for face-reassignment bookkeeping, mirroring
`PersonService.reassignFaces`/`createNewFeaturePhoto`'s exact existing behavior: if a moved face was its old
person's designated feature face, that person needs a replacement chosen from their remaining faces; if none
remain, the old behavior is preserved exactly — the stale `faceAssetId` is left as-is and no refresh job is
queued (mirrors what the owner-facing flow already does when `getRandomFace` finds nothing). Job queuing
(`JobName.PersonGenerateThumbnail`) happens in the **service**, after the transaction commits — an external side
effect (Redis/BullMQ) has no place inside a DB transaction.

Coordinate-transform logic for a manually drawn face box (converting preview-image coordinates to
original-image coordinates when the asset has pending crop/rotate edits) stays in the **service**
(`LibraryEditorService#createManualFace`), mirroring `PersonService.createFace`'s existing preview-to-original
transform almost verbatim — it's pure geometry, not a scope decision, and repositories in this codebase don't
carry that kind of business logic.

`server/src/repositories/person.repository.ts`'s existing `createAssetFace` was changed from returning
`Promise<void>` to returning the inserted row (`.returningAll().executeTakeFirstOrThrow()`) — a backward-compatible
signature tightening (its one existing caller, the owner-facing `PersonService#createFace`, already just awaits
the call without using a return value) needed so the new manual-face primitive can report back the created face's
real id.

---

## 4. Pagination and API surface

`getAllForLibrary(libraryId, pagination)` now takes and honors a `PaginationOptions` (page/size, same
`paginationHelper` convention as `PersonRepository#getAllForUser`) — the original plan text specified this
signature explicitly and it was missed on the first pass, caught by the adversarial review (§8, informational
finding). `GET /libraries/:libraryId/people` accepts `page`/`size` query params and returns `{ people,
hasNextPage }`.

New DTOs (`server/src/dtos/library-person.dto.ts`): `LibraryPersonResponseDto`, `LibraryPeopleResponseDto`,
`LibraryFaceResponseDto`, `LibraryPersonCreateDto`, `LibraryPersonUpdateDto`, `LibraryFaceAssignDto`,
`LibraryManualFaceDto`, plus params DTOs. All mutation schemas are `z.strictObject` (unknown key → 400);
`faceIds` arrays are capped at 64 unique entries; the manual-face box is refined to stay within the given image
dimensions.

Six new routes on `LibraryController`, all under `/libraries/:libraryId/...`, gated by the five permissions
above.

**Deliberate simplification**: no dedicated "get person thumbnail" binary-image endpoint exists. The
`thumbnailFace` a person response carries (asset id + bounding box + image dimensions) is enough for the web
client to fetch that asset's ordinary thumbnail (`GET /api/assets/:id/thumbnail`, already accessible to any
Viewer/Editor of the library via Phase 1's `checkSharedLibraryAccess`, confirmed by reading its access-control
wiring directly rather than assuming) and crop it client-side — exactly the pattern the web app already uses
elsewhere (`zoomImageToBase64` in `web/src/lib/utils/people-utils.ts`). Verified, not just assumed, before
committing to this design.

---

## 5. Verification performed

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`), full project | ✅ clean |
| Lint (eslint), every touched file | ✅ clean |
| New unit tests (`library-editor.service.spec.ts` additions) | ✅ 34 tests, all pass |
| New medium (real-Postgres) tests | ✅ 45 tests, all pass — `person.repository.spec.ts` additions (11), `access.repository.spec.ts` additions (17), new `person.repository.library-editor.spec.ts` (16, covering the four transactional primitives directly) |
| Regression: Phase 2/3's own medium specs re-run against a fresh database | ✅ still pass (`album.repository.create.spec.ts`, `asset.repository.library-editor.spec.ts`) |
| Full unit suite | 2256 passed / 72 failed / 2 skipped — all 72 reproduce the exact same pre-existing Windows-vs-POSIX path-separator issue documented in every prior phase log (storage/media/transcoding/backup/auth/user-management files; confirmed via `git log` that none of these files have been touched at any point in this engagement). Every file this phase actually changed passes 100%. |
| Full medium suite | 444 passed / 22 failed — all 22 are a pre-existing, unrelated gap (`workflow-core-plugin.spec.ts`: a core plugin isn't registered in this environment's manually-migrated database; confirmed via `git log` this file was last touched in the initial commit, before any phase of this feature existed) |
| Adversarial security review (Fable 5) | Found 1 High, 1 Medium, 1 Low, 2 Informational (§8) — all fixed except the two Informational items, which were accepted as documented, low-consequence tradeoffs. |

The real-Postgres verification this time used a fresh, isolated, throwaway Postgres container (a different port
than the one already running on this machine for what appears to be the user's own separate local Immich dev
stack — that stack was never touched), mirroring the same methodology Phase 2's bug hunt established. All
migrations (all 88, across all 4 phases) applied cleanly from scratch.

---

## 6. Security review

An adversarial review targeting cross-library data leakage (the exact bug class found in Phases 2 and 3 —
a CTE column-position bug, a `removeUndefinedKeys` scoping bug), authorization bypass, the two-layer
outer-check/inner-recheck pattern, and the exclusivity predicate's edge cases.

### Finding 1 (High, fixed) — `createManualFace` had no visibility/soft-delete scope check on the asset

The original check was `asset.libraryId !== libraryId` only — no requirement that the asset be Timeline-visible
or non-deleted. Concrete exploit: an Editor identifies a valid in-library person, then targets an
**archived, hidden, locked, or trashed** asset that's still nominally in the same library — all of which Phase
3's own metadata primitive and this phase's own scope predicates correctly exclude, but this one endpoint did
not. Worse: a newly-created manual face on such an asset becomes a valid candidate for that person's *feature
photo* (`getRandomFace`/the shared reassignment helper don't filter by visibility either — by design, since a
person's global feature photo isn't library-scoped), meaning a **locked** asset — which normally requires
elevated permission even for the owner — could end up cropped into a person's account-wide thumbnail via a
partially-trusted Editor's action.

**Fix**: `createManualFaceForLibrary`'s transaction now re-verifies the asset via `isAssetInLibraryScopeTx`
(Timeline-visibility, non-deleted, genuinely this library) immediately before writing — the same predicate shape
as every other scope check in this phase. Regression tests added (`person.repository.library-editor.spec.ts`):
archived asset rejected, trashed asset rejected, cross-library asset rejected — all verified against a real
Postgres.

### Finding 2 (Medium, fixed) — person/face mutations weren't transactional; create-person-and-assign wasn't atomic

The plan itself says explicitly (Step 6): *"create-person + initial face assignment runs in one transaction so
no empty owner-scoped person is left behind."* The first-pass implementation didn't do this — `createPerson`
called `personRepository.create()` and then a separate `reassignFacesToPerson()` as two independent operations,
and none of the four mutations re-verified role/scope at write time, only via a separate outer service-level
check with an unavoidable TOCTOU gap (a role downgrade, share removal, or the target moving out of scope between
the check and the write could still let a write through).

**Fix**: the four transactional primitives described in §3 replace the previous two-step, non-transactional
service logic entirely. `createPersonForLibrary` in particular is now provably atomic — verified directly: a
test creates two faces (one in-library, one deliberately out of scope), calls the primitive, and asserts **zero**
new `person` rows exist afterward and the in-scope face was never touched. `LibraryEditorService`'s four public
methods were simplified accordingly: each now does only the outer, fast-path `requireAccess` check (matching
Phase 3's exact division of responsibility) and calls the corresponding primitive, which returns `null`/`false`
on any authorization failure — collapsing "library not found," "access revoked," and "entity out of scope" into
the same generic 400, exactly as Phase 3's `updateLibraryAssetMetadata` already does.

### Finding 3 (Low, fixed) — the exclusivity check ignored faces on trashed assets outside the library

`checkPersonExclusiveToLibrary`'s original join filtered `asset.deletedAt is null`, so a face on a **trashed**
external asset was excluded from both the inside and outside counts — meaning a person with one in-library face
and one trashed-but-restorable external face would be judged "exclusive" and become renameable by an Editor.
Concrete (if narrow) sequence: owner trashes a private photo containing a person who also appears in the shared
library → Editor renames that person → owner restores the trashed photo → the rename has already silently
touched account-wide identity data the Editor never had real access to.

**Fix**: removed the join's `asset.deletedAt is null` filter (in both `AccessRepository`'s standalone copy and
the transactional primitive's inline copy) — a trashed external face now still counts as "elsewhere." Regression
test added and verified against a real Postgres: a person with an in-library face and a trashed external face is
correctly rejected for rename.

### Informational (not fixed) — `getRandomFace`/feature-photo refresh is not library-scoped

When an Editor's reassignment causes some *other*, unrelated person to lose their feature photo, the
replacement is picked from **any** of that person's remaining faces, not just in-library ones — this exactly
mirrors the existing owner-facing `PersonService.createNewFeaturePhoto` behavior (itself not library-aware, since
libraries didn't exist when it was written) and is a necessary consequence of allowing cross-person face
reassignment at all, which the plan explicitly permits. No information is disclosed to the Editor either way
(they never see which face was picked, or any data about the affected person, through this action) — only a
data-integrity nudge to a person the Editor otherwise can't see. Accepted as parity with pre-existing behavior,
not a Phase 4 regression.

### Informational (fixed) — `getAllForLibrary` was unbounded (dropped pagination)

Covered in §4 — the plan's own signature (`getAllForLibrary(libraryId, pagination)`) was not followed on the
first pass. Fixed by adding real pagination rather than an arbitrary cap.

### Correctly blocked (verified, not just assumed)

Cross-library access to every new query (each JOIN/WHERE traced individually — no query returns another
library's or another user's face/person data); Viewer write attempts (all four mutation permissions resolve to
owner ∪ Editor only); response shape leaks (`mapLibraryFace`/`mapLibraryPerson` build explicit minimal
projections even though the underlying queries `selectAll`/fully hydrate — no `ownerId`/`thumbnailPath`/
`birthDate` ever reaches the client); DTO strictness and array-size bounds; the person-thumbnail access
reasoning (§4, independently confirmed by reading `checkSharedLibraryAccess`'s actual predicate before relying on
it); `createAssetFace`'s signature change (all call sites, including the test factory, checked individually —
none relied on the old `void` return).

---

## 7. Web UI (Steps 12–14)

Built via a delegated, five-stage agent pipeline (API client shim → sharing hub → browse route + role-aware
viewer + face-labeling panel → i18n/docs → parallel adversarial verification), since the surface area (a new
route, a role-aware asset viewer, a face-labeling panel, a sharing-hub modal, i18n, docs) was too large for a
single-shot delegation to hold reliably, unlike Phase 3's much narrower split.

**Known gap at build time, closed during this session's live verification (§7.4a)**: the OpenAPI spec /
`packages/sdk` had never been regenerated at any point across all 4 phases of this engagement, so the pipeline
initially built a small, clearly-labeled temporary typed client at `web/src/lib/api/library-share.ts` covering
every Phase 1/3/4 library-sharing endpoint, mirroring the real generated SDK's exact `oazapfts` calling
convention. While bringing up a live backend for end-to-end verification (§7.4), that backend's own OpenAPI
document generation wrote a fresh, accurate spec to `open-api/immich-openapi-specs.json` covering all 4 phases -
which made a real SDK regeneration possible without a bigger, separate infrastructure effort. It was done: the
temporary client was deleted, `packages/sdk/src/fetch-client.ts` was regenerated for real (`oazapfts`) and
rebuilt, and all 12 consuming web files now import from `@immich/sdk` directly. See §7.4a for the full account.
This recommendation from the original plan is no longer a follow-up - it's done.

### 7.1 What was built

- **API access**: initially a temporary hand-written client (`web/src/lib/api/library-share.ts`, 13 functions
  covering every Phase 1/3/4 endpoint plus every request/response type mirrored from the server DTOs), later
  fully replaced by the real generated `@immich/sdk` once a fresh OpenAPI spec became available (§7.4a) - every
  consuming file below now imports directly from `@immich/sdk`, and the temporary file no longer exists.
- **Sharing hub** (`sharing/+page.ts`/`+page.svelte`, new `LibraryShareModal.svelte`, `route.ts` addition) — a
  "Shared libraries" section listing libraries shared with me (linking to the browse route) and, for libraries I
  own, a management modal (add/remove/change-role) mirroring the existing album-sharing UI's conventions.
- **Browse route + role-aware viewer + face-labeling panel** (`shared-libraries/[libraryId]/...`, a new
  `LibraryShareContext`/role concept threaded through the asset viewer, `LibraryAssetEditorPanel.svelte` +
  `LibraryAssetChangeDateModal.svelte` for the Phase 3 metadata fields, and a four-component face-labeling stack
  — `LibraryFacePanel`/`LibraryFaceEditSidePanel`/`LibraryFaceAssignSidePanel`/`LibraryManualFaceEditor`) — by far
  the largest piece: an Editor sees a "People" section sourced only from `getLibraryAssetFaces`, can reassign a
  face to any person from `getLibraryPeople`, create-and-assign a new person, draw a new manual face box
  (reusing the owner UI's existing fabric.js box-drawing interaction), and rename a person in place (the server
  rejects it if the person has any face outside the library). No merge/delete/hide/favorite/feature-photo
  controls exist anywhere in this panel. Person thumbnails are cropped client-side from `thumbnailFace` via a new
  `cropFaceThumbnail` helper mirroring the existing `zoomImageToBase64` pattern, never from a raw `thumbnailPath`.
  Album-add from this view is restricted to albums the current user owns with no existing shared link (mirrors
  the server's provenance rule from Phase 2) via a new `restrictToOwnedAlbums` prop on the existing
  `AssetAddToAlbumModal`/`AlbumPickerModal`.
- **i18n + docs** — 22 new `i18n/en.json` keys (English only, per the plan), and a new "Sharing a Library"
  section in `docs/docs/features/libraries.md` covering roles, the Editor allowlist/denylist, the database-only
  metadata guarantee, person/face scoping, and revocation behavior.

### 7.2 Verification

| Check | Result |
|---|---|
| `tsc --noEmit` (whole `web` package) | ✅ clean |
| `eslint . --max-warnings 0` (whole `web` package) | ✅ clean |
| `svelte-check` (project's exact configured flags) | ✅ clean, 0 errors / 0 warnings — after fixing one real regression (§7.3) |
| `prettier --check` | ✅ clean |
| Adversarial security review (independent agent, read every touched file) | No confirmed authorization/data-exposure bug. One informational finding, fixed (§7.3). |
| Consistency/code-quality review (independent agent, read every touched file) | Two low-severity findings; one fixed (§7.3), one accepted as a deliberate, working simplification. |

### 7.3 Findings from the pipeline's own verification stage, and what was fixed

The build stages' self-reported "all clean" claims were **not** taken at face value — each was checked against
an independent reviewer or a rerun of the actual command, the same discipline applied to the server-side work.

1. **A real regression the build agent misdiagnosed as pre-existing (fixed).** The build-check agent found
   `web/src/lib/components/SchemaAlbumPicker.svelte:17` failing to typecheck (`modalManager.show(AlbumPickerModal)`
   missing its now-required second argument). The agent that built the browse route/face-labeling panel had
   reported this same error but called it "pre-existing and unrelated" since it hadn't directly edited that
   file. Checking `git log` showed `SchemaAlbumPicker.svelte` was never touched by any phase of this engagement
   — but the file it calls into, `AlbumPickerModal.svelte`, *was* modified by this phase (a new
   `restrictToOwnedAlbums` prop), and that change is what broke the pre-existing call site (an optional new prop
   on a modal's `Props` type can still force `@immich/ui`'s `modalManager.show` generic to require an explicit
   second argument). Fixed by passing `{}` at that one call site, matching the pattern already used everywhere
   else `AlbumPickerModal` is opened. Re-verified: `svelte-check` now reports 0 errors / 0 warnings.
2. **Security review, informational (fixed).** `AssetViewer.svelte`'s `refresh()` unconditionally called the
   global, non-library-scoped `getFaces` endpoint for every asset it opens, including inside the shared-library
   viewer — no prior stage had added a guard to skip it in that context. Not currently exploitable (the response
   is separately redacted by the server's existing, feature-unaware `mapFaces()`, and the one component that
   reads this cached data is already gated to owners only) — but the safety was coincidental, not something this
   feature deliberately relied on, and it was a wasted network call regardless. Fixed by skipping the call when
   a `libraryShare` context is present, mirroring the existing `if (!sharedLink)` guard immediately above it.
3. **Consistency review, low severity (fixed).** `LibraryAssetEditorPanel.svelte` unconditionally requested
   `timeZoneName: 'longOffset'` when formatting a date, whereas the sibling component it mirrors
   (`DetailPanelDate.svelte`) only does so when a time zone is actually recorded. Fixed to match.
4. **Consistency review, low severity (accepted, not changed).** `LibraryShareModal.svelte` merges "manage
   existing shares" and "add new people" into one modal, rather than the two-modal pattern
   (`AlbumOptionsModal`/`AlbumAddUsersModal`) used by album sharing. The reviewer characterized this as a
   deliberate, working, well-commented simplification rather than a bug, and it was left as-is.

### 7.4 Live end-to-end verification against a real running server

A VS Code devcontainer for this exact repo (bind-mounting the live source tree) was already present on this
machine, stopped. It was resumed (`docker start`, which only reattaches existing containers/volumes — nothing
destructive) to get genuine end-to-end verification beyond static analysis and review.

**Blocker found and fixed**: the backend's `nest start --watch` dev compiler initially failed to bring the API up
because of a pre-existing TypeScript error in `src/services/workflow-execution.service.ts:337`
(`const asset = changes.asset` — `'changes' is of type 'unknown'`), unrelated to this feature (confirmed via
`git log`: never touched by any phase of this engagement) and not present in a plain `tsc --noEmit` run (specific
to this devcontainer's webpack/ts-loader dev build). Fixed with a one-line cast (`(changes as any).asset`),
mirroring the exact same `as any` pattern already used five lines above it in the same function for the same
generic-narrowing limitation — not a new workaround invented for this fix.

**With that fixed, both the backend (`nest start --watch`) and the frontend (`vite dev`) were brought up for
real** against a fresh Postgres, exercising this session's actual compiled code (the container bind-mounts the
live source tree). The frontend's dev port isn't published to the host in this devcontainer (VS Code normally
port-forwards it on attach; this session didn't go through that flow), so a small sidecar `socat` proxy
container was added on the same Docker network to publish it — the running `immich_server`/`immich_postgres`/
etc. containers were never modified.

Visual/interactive browser verification was attempted but blocked: the Chrome extension bridge wasn't connected
in this session (no fallback browser-automation path was available). In its place, the full **API surface** was
exercised over raw HTTP against the live server with real accounts, real authentication, and a real Postgres
database (all created fresh on this throwaway instance):

- Created an admin (library owner) and a second user (editor) via the real signup/admin-user-creation endpoints.
- Created a real library and shared it with the editor (`PUT /libraries/:id/users`) — confirmed `GET
  /libraries/mine` (owner) shows `sharedUsers` with the correct role, and `GET /libraries/shared-with-me`
  (editor) shows the owner and role correctly (Phase 1, still correct end-to-end).
- `GET /libraries/:id/people` as the editor → `{"people":[],"hasNextPage":false}`, the exact shape built in §4.
- `POST /libraries/:id/people` with a well-formed but nonexistent `faceId` → clean `400` with the exact scope-
  rejection message the transactional primitive returns — not a crash, confirming `createPersonForLibrary`'s
  rejection path is live and correct against a real database, not just the throwaway medium-test instance.
- The same read, attempted by a third user with **no relationship** to the library at all → `400 "Not found or
  no libraryPerson.read access"` — correctly denied.
- The SPA itself: `/`, `/sharing`, and `/shared-libraries/:id` (a real, made-up UUID) all serve `200` from the
  live Vite dev server, confirming the new route compiles and is servable, not just that `svelte-check` is happy
  with it in isolation.

Testing the metadata editor and face-labeling flows specifically would need real image assets imported and face
detection to run (a fuller seed-data effort than was proportionate here) — that remains an open item, alongside
the still-unattempted **visual** click-through, both listed in §9. Once confirmed working, the devcontainer and
all ad-hoc test data (the throwaway users/library above) were torn down, and every container was returned to the
exact stopped state it was found in.

### 7.4a The SDK regeneration gap, closed for real

Bringing up the live backend in §7.4 had a side effect worth its own section: NestJS's Swagger document
generation wrote a fresh, accurate OpenAPI spec to `open-api/immich-openapi-specs.json` on boot — the first time
in this entire engagement a live server had been running to produce one. Rather than let that spec sit unused
next to a temporary hand-written client (a confusing, half-finished state), the regeneration was completed:

1. Ran `oazapfts --optimistic --argumentStyle=object --useEnumType --allSchemas open-api/immich-openapi-specs.json
   packages/sdk/src/fetch-client.ts` directly (the exact command `mise.toml`'s `open-api-typescript` task runs) -
   no live server needed for this step since the spec file was already fresh on disk. This regenerated
   `fetch-client.ts` with every Phase 1/3/4 function and type, under the exact same names the temporary client
   had already used (having been hand-written to mirror the real convention) - only one name differed
   (`updateLibraryUser`, not the temporary client's guessed `updateLibraryUserRole`).
2. Rebuilt the `@immich/sdk` package itself (`packages/sdk`'s own `"build": "tsc"` script) - the package resolves
   to compiled `build/` output, not `src/` directly, so this step was necessary for the web app to actually see
   the new exports.
3. Deleted `web/src/lib/api/library-share.ts` and updated all 12 consuming files to import from `@immich/sdk`
   instead, fixing the one renamed function at its single call site (`LibraryShareModal.svelte`). Reverted the
   `@oazapfts/runtime` direct dependency that had been added to `web/package.json` for the temporary client (no
   longer needed - `web` only needs `@immich/sdk`, which carries its own dependency on that runtime).
4. Re-verified clean: `tsc --noEmit`, `eslint --max-warnings 0`, `svelte-check` (same flags as before), and
   `prettier --check` all pass across both `web/` and `packages/sdk/`, with zero errors or warnings.

**Correction (post-deployment):** this section originally claimed the resulting `pnpm-lock.yaml`/`web/package.json`
mismatch (the lockfile still listing `@oazapfts/runtime` as a direct `web` dependency after it was dropped from
`package.json`) was a "trivial, harmless loose end" that "will self-correct on the next real `pnpm install`." That
was wrong, and it broke a real production build: `server/Dockerfile`'s `web` stage runs
`pnpm install --frozen-lockfile`, which treats any lockfile/`package.json` mismatch as a hard failure rather than
something it silently reconciles. The build got past the earlier plugin-sdk cache issue (§ below) only to fail here
with `[ERR_PNPM_OUTDATED_LOCKFILE]`. Fixed by fetching `pnpm@11.6.0` (the exact version this repo's
`packageManager` field pins) via `npx` and running `pnpm install --lockfile-only` at the repo root, which
regenerated `pnpm-lock.yaml` to match the current `package.json` files - a 20-line diff, entirely the
`@oazapfts/runtime` removal from `web` plus a handful of `file:` → `link:` workspace-reference representation
changes for `@immich/sdk` (functionally identical, just how this pnpm version records local workspace links).
Verified with `pnpm install --frozen-lockfile --lockfile-only`, which now passes. Lesson: don't characterize a
lockfile/manifest mismatch as harmless just because it doesn't break in dev - `--frozen-lockfile` in CI/production
build paths makes it a hard blocker.

**Second correction (post-deployment, worse):** the Phase 4 lockfile regeneration on Windows introduced a second,
subtler production breakage that the fix above preserved. The repo's `.pnpmfile.cjs` had a **platform-dependent**
`readPackage` hook: it promoted only the *current platform's* exiftool binary package from `optionalDependencies`
to `dependencies` (`exiftool-vendored.exe` when run on Windows, `exiftool-vendored.pl` otherwise) so it survives
`server/Dockerfile`'s `pnpm --prod --no-optional deploy`. Because that hook rewrites the dependency graph at
lockfile-generation time, the lockfile's contents depend on which OS last regenerated it. The repo's original
lockfile (initial commit, upstream's) was Linux-flavored: `.pl` regular, `.exe` optional - correct for Docker.
Phase 4's Windows-side regeneration (commit `af1b99d`) silently flipped it: `.exe` regular, `.pl` optional. The
resulting production image therefore contained the Windows exiftool binary and **no Linux exiftool at all**.

Observed impact on the deployed Phase 4 image: `exiftool-vendored`'s `ExifTool.version()` neither resolves nor
rejects when its binary is missing (reproduced in a clean `node:24-bookworm-slim` container against the deployed
output - the promise simply never settles). `GET /api/server/about` awaits it inside a `Promise.all` with no
timeout (`server-info.repository.ts` `getBuildVersions`), so that endpoint hangs forever; the web app's
`auth-manager.refresh()` awaits `getAboutInfo()` before emitting `AuthUserLoaded`, so every signed-in page load
hung on the splash spinner indefinitely. (Its `.catch(() => {})` is no protection against a promise that never
settles.) Metadata extraction and Phase 3's sidecar writing would also have been broken on that image for any
newly scanned assets. Phases 1-3 images were built from the original Linux-flavored lockfile and were unaffected.

Fix (commit after this one): made the `.pnpmfile.cjs` hook platform-independent - it now promotes **both**
`exiftool-vendored.exe` and `exiftool-vendored.pl` to regular dependencies, so the lockfile comes out identical no
matter which OS regenerates it, at the cost of a few MB of unused Windows exiftool in the Linux image. Lockfile
regenerated (8-line diff: the `.pl` promotion plus the `pnpmfileChecksum`), `--frozen-lockfile` re-verified, and
the full failure chain re-verified fixed on real Linux: the same `pnpm --prod --no-optional deploy` in a
`node:24-bookworm-slim` container now includes `exiftool-vendored.pl`'s binary, and a live `ExifTool.version()`
call against the deployed output resolves. Lesson: a lockfile whose generation is platform-dependent is a
production incident waiting for the first contributor on a different OS; hooks that rewrite dependency graphs
must be deterministic across platforms.

**Follow-up migration (schema drift from Phase 1):** production startup logs also surfaced six pre-existing schema
drift warnings for `library_user`, unrelated to the exiftool issue. Phase 1's hand-written migration created the
tables, function, and triggers, but missed the two foreign-key indexes (`library_user_libraryId_idx`,
`library_user_userId_idx`) and never inserted the three `migration_overrides` registry rows that Immich's drift
checker uses to track function/trigger definitions (it reads those from the registry, not from Postgres
introspection - so even the objects that existed were reported "missing"). Fixed by
`1783800000000-FixLibraryUserSchemaDrift.ts`, generated with `sql-tools migrations generate` (the same tool that
reports the drift) against the devcontainer database, which was in the identical drifted state as production. The
timestamp is deliberately above Phase 3's future-dated `1783780000000-*` so the runner never sees it as
out-of-order. Verified both paths on real Postgres: upgrade (drifted DB + this migration → "No changes detected")
and fresh install (empty DB + all migrations → "No changes detected").

This closes what was the #1 recommended follow-up in every earlier draft of this log. The temporary API client
pattern used throughout Phase 4's build (and the reasoning for it) remains documented above and in git history
for context, even though the file itself is gone.

---

## 8. Not in this phase

Weblate-managed non-English locale strings. Full e2e test coverage (`mise //e2e:test`). Visual/interactive
browser click-through (§7.4) — the Chrome extension bridge wasn't connected in this session, so the full API
surface was exercised over raw HTTP with real accounts and a real database instead, but nobody has looked at the
rendered UI with their own eyes yet. Testing the metadata editor and face-labeling flows specifically also needs
real imported image assets with face detection run against them, which wasn't set up. (SDK regeneration - the
recommendation that used to live here - was completed during this session; see §7.4a.)

## 9. Suggested next steps

This is the last phase of the plan (`FEATURE-PLAN-shared-external-libraries.md` §8 explicitly scopes the work to
four phases) — there is no Phase 5. Before this feature is considered ready to ship:

1. Actually look at the rendered UI: connect a Chrome-extension-backed (or equivalent) browser session and click
   through the sharing hub, browse route, metadata editor, and face-labeling panel against a real backend. The
   backend itself is confirmed working end-to-end (§7.4), it's now backed by a real generated SDK rather than a
   temporary client (§7.4a), and the devcontainer's own dev-build blocker is already fixed
   (`workflow-execution.service.ts`, unrelated to this feature) — this is now just a rendering/interaction check,
   not an infrastructure problem.
2. Import real image assets into a shared library and run face detection, then exercise create-person,
   reassign-face, manual-face-box, and rename through the actual UI (or the API directly) to verify the
   face-labeling flows beyond the empty-library checks done in §7.4.
3. Run the full `e2e/` suite against a real browser + server once available.
4. Consider whether `getRandomFace`'s feature-photo selection should become library-aware in a future pass (§6,
   informational finding) — not required for this feature to be correct or safe, but would tighten an existing,
   pre-Phase-4 rough edge now that libraries are a first-class access boundary.
