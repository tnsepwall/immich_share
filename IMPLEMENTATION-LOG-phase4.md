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

**Known, deliberate gap this pipeline had to work around**: the OpenAPI spec / `packages/sdk` has never been
regenerated at any point across all 4 phases of this engagement. Phase 4's web UI is the first point this
actually blocks natural, idiomatic code, since it's the first phase to write web code that calls these endpoints
at all. Rather than attempt a full multi-container live-stack boot to regenerate the SDK for real (a large,
uncertain-duration side quest orthogonal to the feature itself), the pipeline built a small, clearly-labeled
temporary typed client at `web/src/lib/api/library-share.ts`, covering every Phase 1/3/4 library-sharing
endpoint, mirroring the real generated SDK's exact `oazapfts` calling convention (reusing its shared
`defaults`/runtime) so a future real `mise open-api` regeneration is close to a drop-in replacement for these
call sites. **Recommended follow-up before shipping**: run a real SDK regeneration and retire this file.

### 7.1 What was built

- **`web/src/lib/api/library-share.ts`** (new) — the temporary client above: 13 functions covering every Phase
  1/3/4 endpoint (`getMyLibraries`, `getLibrariesSharedWithMe`, `addLibraryUsers`, `updateLibraryUserRole`,
  `removeLibraryUser`, `updateLibraryAsset(s)`, `getLibraryPeople`, `createLibraryPerson`, `updateLibraryPerson`,
  `getLibraryAssetFaces`, `createLibraryFace`, `assignLibraryFaces`), plus every request/response type mirrored
  from the server DTOs. Required one dependency fix: `@oazapfts/runtime` was a transitive dependency of
  `packages/sdk` only and wasn't resolvable from `web/` under this repo's strict pnpm hoisting — added directly
  to `web/package.json` (matching the sdk's own semver range) and reinstalled.
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

### 7.4 Live browser verification: attempted, blocked by an unrelated pre-existing issue

A VS Code devcontainer for this exact repo (bind-mounting the live source tree) was already present on this
machine, stopped. It was resumed (`docker start`, which only reattaches existing containers/volumes — nothing
destructive) specifically to attempt genuine end-to-end browser verification of the web UI against a real
backend, rather than relying on static analysis and review alone. The backend's `nest start --watch` dev
compiler failed to bring the API up because of a pre-existing TypeScript error in
`src/services/workflow-execution.service.ts:337` (`'changes' is of type 'unknown'`) — confirmed via `git log`
that this file has never been touched by any phase of this engagement, and confirmed this repo's own
`tsc --noEmit` passes cleanly on the exact same `tsconfig.json`, so this is specific to that devcontainer's
webpack/ts-loader dev-build configuration, not a real type error. Fixing it was out of scope (unrelated feature,
no context on its correct fix) and not attempted. The devcontainer was returned to its original stopped state
once this was confirmed. **Net result: the web UI was not exercised in a live browser this session** — its
correctness rests on the static analysis and independent review in §7.2, not a manual click-through. This is
disclosed rather than glossed over.

---

## 8. Not in this phase

SDK regeneration (see §7 — now a concrete, actionable follow-up rather than a documentation footnote, since
Phase 4's web UI is built against a temporary hand-written stand-in). Weblate-managed non-English locale strings.
Full e2e test coverage (`mise //e2e:test`) and manual browser click-through (§7.4) — a working dev environment
was available this session but its dev build was blocked by an unrelated pre-existing issue; static analysis and
independent review were relied on instead, and this is disclosed as a real gap, not silently skipped.

## 9. Suggested next steps

This is the last phase of the plan (`FEATURE-PLAN-shared-external-libraries.md` §8 explicitly scopes the work to
four phases) — there is no Phase 5. Before this feature is considered ready to ship:

1. Fix the pre-existing `src/services/workflow-execution.service.ts:337` type error blocking this devcontainer's
   dev build (unrelated to this feature, not attempted here), then actually click through the sharing hub,
   browse route, metadata editor, and face-labeling panel in a live browser against a real backend — this has
   not been done yet for any phase of this engagement.
2. Regenerate the OpenAPI spec/SDK for real (boot a live server, run `mise open-api`) and retire
   `web/src/lib/api/library-share.ts`, switching all its call sites to `@immich/sdk` directly.
3. Run the full `e2e/` suite against a real browser + server once available.
4. Consider whether `getRandomFace`'s feature-photo selection should become library-aware in a future pass (§6,
   informational finding) — not required for this feature to be correct or safe, but would tighten an existing,
   pre-Phase-4 rough edge now that libraries are a first-class access boundary.
