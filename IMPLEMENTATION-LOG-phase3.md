# Implementation Log — Phase 3: Editor Metadata

Tracks work against `FEATURE-PLAN-shared-external-libraries.md`, section 8 "Implementation order," Phase 3:
> **Editor metadata**: `sidecarWriteProperties` split, the transactional metadata primitive, extraction changes,
> editor endpoints for metadata only.

Builds on Phase 1 (`library_user` sharing, direct browse/view/download access) and Phase 2 (album provenance) — see
`IMPLEMENTATION-LOG-phase1.md` / `IMPLEMENTATION-LOG-phase2.md`. Status: **complete**, pending the user's review.

---

## 1. What this phase adds

A shared-library **Editor** (not Viewer) can now correct an asset's `description`, `dateTimeOriginal`,
`dateTimeRelative`, `timeZone`, `latitude`/`longitude`, and `rating` via two new endpoints:

- `PATCH /libraries/:libraryId/assets/:assetId` — single asset.
- `PATCH /libraries/:libraryId/assets` — up to 100 assets atomically (one shared edit applied to every id, or
  nothing written at all).

The edit is **database-only**: it never writes to the owner's original file or an XMP sidecar, and it never queues
the `SidecarWrite` job. This is the core guarantee the whole phase exists to protect, because a shared-library
grant is meant to stay fully revocable — a file written to disk isn't.

---

## 2. The core mechanism: splitting `lockedProperties`

Before this phase, `asset_exif.lockedProperties` did two unrelated jobs at once: (a) protect a column from being
overwritten by the next metadata extraction, and (b) mark it as pending an XMP sidecar write. An owner edit set
both meanings with one column. That conflation is exactly what would have let an Editor's "permanent" lock get
silently written to a file the next time the *owner* touched the same asset (tagging it, editing another field,
anything that queues `SidecarWrite`) — `handleSidecarWrite` would have picked up the Editor's locked value along
with everything else and written it out.

**Fix:** a new nullable `asset_exif.sidecarWriteProperties` column (migration
`1783780000000-AddAssetExifSidecarWriteProperties.ts`, backfilled to `= lockedProperties` for existing rows so no
already-queued owner write is lost on upgrade). From this phase on:

- `lockedProperties` means only "protected from extraction overwrite."
- `sidecarWriteProperties` means only "still pending an XMP write."
- **Owner edits** (`AssetService#updateExif` via `tag.service.ts`/`asset.service.ts`'s shared `updateLockedColumns`
  helper, plus `AssetRepository#updateAllExif`/`updateDateTimeOriginal`) lock **both** columns — unchanged
  end-user behavior, still queues `SidecarWrite`.
- **Editor edits** (`AssetRepository#updateLibraryAssetMetadata`, the new primitive below) lock **only**
  `lockedProperties` and never queue anything. `handleSidecarWrite` (`metadata.service.ts`) was switched to read
  `sidecarWriteProperties` (not `lockedProperties`) to decide what to pick, write, and then clear — so an
  Editor-locked value is invisible to every future sidecar write, permanently, regardless of what the owner does
  to the asset afterward.

---

## 3. The transactional metadata primitive

`AssetRepository#updateLibraryAssetMetadata(libraryId, editorId, assetIds, edit)` — one `db.transaction()`:

1. Re-verifies `editorId` owns the library, or holds an active Editor `library_user` row for it (library and its
   owner both non-deleted) — **inside** the transaction, not just via the service's outer `requireAccess` check,
   so a role downgrade or share removal committed between the two can't slip through.
2. Re-verifies every `assetId` genuinely belongs to `libraryId` (non-deleted, `Timeline` visibility) — same
   reasoning, same transaction.
3. If either check fails: returns `null`, writes nothing. The service surfaces this as a 400.
4. Otherwise, updates the allowlisted `asset_exif` columns for the whole id batch in one statement, locking
   exactly the touched properties (`lockedProperties` only).
5. For a date/timezone edit, loops per-asset (each asset's *current* stored date is the base for a relative
   shift) and derives `asset.localDateTime`/`fileCreatedAt` synchronously, reproducing the same
   instant → zone → "fake UTC" derivation `metadata.service.ts#getDates` uses for real extraction — since an
   Editor's asset never goes through extraction, this is the only place that derivation happens for their edits.

Three date-edit modes, mirroring the owner's own existing bulk-update semantics exactly:
- **Absolute** (`dateTimeOriginal` resolved to a `Date` by the service, optionally paired with an extracted or
  explicit `timeZone`) — replaces the stored instant outright.
- **Relative** (`dateTimeRelative` minutes, optional `timeZone`) — shifts each asset's own current instant by the
  delta, matching `AssetRepository#updateDateTimeOriginal`'s existing raw-interval approach.
- **Zone-only** (just `timeZone`, no date change) — re-projects the unchanged instant into the new zone, which
  moves `localDateTime` (the "fake UTC" wall-clock encoding) without moving `dateTimeOriginal`'s actual instant.

Latitude/longitude resolution (reverse geocoding, clearing city/state/country) happens in
`LibraryEditorService#resolveEdit` **before** calling the primitive — it's a pure read against the static
`geodata_places` table, so it doesn't need to be inside the write transaction.

---

## 4. Extraction fix: locked dates survive a re-scan

`asset_exif`'s columns were already protected from extraction overwrite via `lockedPropertiesBehavior: 'skip'` —
but `asset.localDateTime`/`fileCreatedAt` were not. Before this phase, `handleMetadataExtraction`
(`metadata.service.ts`) unconditionally wrote those two columns from the freshly re-parsed file tags on every
extraction run, regardless of any lock — so a later re-scan (a genuine "Refresh Metadata" job, or the file's mtime
changing for an unrelated reason) would have silently moved a curated asset back to its original timeline
position, undoing an Editor's (or owner's) date edit.

**Fix:** new `resolveTimelineDates` (private method, `metadata.service.ts`) — if `dateTimeOriginal`/`timeZone` are
locked (fetched via new `AssetJobRepository#getLockedDatesForMetadataExtraction`), it derives
`localDateTime`/`fileCreatedAt` from the current DB values instead of the freshly parsed ones, using the same
derivation math. When nothing is locked, it's a pass-through — zero behavior change for the overwhelming majority
of assets that were never edited this way.

`AssetJobRepository#getLockedPropertiesForMetadataExtraction` was renamed to `getSidecarWriteProperties` (its only
caller was already `handleSidecarWrite`, and it now selects the new column) rather than left as an orphaned,
misleadingly-named method.

---

## 5. Access control and API surface

- New `Permission.LibraryAssetUpdate` (`server/src/enum.ts`).
- `AccessRepository`: `LibraryAccess.checkEditorAccess` (active Editor-role share only — owner access is the
  existing, separate `checkOwnerAccess`) and `AssetAccess.checkLibraryAssetScope` (asset genuinely belongs to the
  given library, non-deleted, Timeline visibility — scope only, not a role check).
- `utils/access.ts`: `Permission.LibraryAssetUpdate` case treats its ids as **library ids**, owner ∪ Editor —
  mirrors the existing `Permission.LibraryRead` case's shape exactly. Viewer-only shares get neither branch.
- `dtos/library-editor.dto.ts`: `LibraryAssetUpdateDto` / `LibraryAssetBulkUpdateDto`, both `z.strictObject(...)`
  (unknown key → 400) covering only the allowlisted fields — every owner-only field (visibility, isFavorite,
  duplicateId, livePhotoVideoId, tags, arbitrary metadata) is structurally absent, not just unused. Refines:
  `dateTimeOriginal`/`dateTimeRelative` mutually exclusive, lat/long provided together and cleared together, at
  least one field required.
- `LibraryController`: the two new routes, gated by `Permission.LibraryAssetUpdate`, calling the new
  `LibraryEditorService`.
- `LibraryEditorService` (new): outer `requireAccess` check, DTO → repository-edit resolution (date parsing,
  timezone extraction, conditional geocoding respecting the server's `reverseGeocoding.enabled` config), calls the
  primitive, then re-fetches and maps each updated asset through the **same** `mapAsset(..., { withStack: true,
  auth, sameLibraryLivePhoto })` path and same-library-live-photo check that `AssetService.get()` already uses —
  so response redaction (paths, stack, live-photo links) is reused, not reimplemented.

The access-control/DTO/controller layer was built by a second AI agent (Fable 5) working from an exact method
contract I specified in advance, concurrently with my own work on the schema/repository/service layer — the same
split-by-file-ownership approach used in Phase 2, chosen specifically to avoid two writers touching the same file.

---

## 6. Deliberate scope decisions / minor follow-ups

- **No admin bypass for curation**, per the plan's own default (open question 6): admin status manages share
  lists but does not let an admin edit another user's library assets. `Permission.LibraryAssetUpdate` is owner ∪
  Editor only, with no admin branch — matches the plan's stated default exactly.
- **Person/face editing and all web UI are Phase 4**, per the plan's phase split — not touched here.
- **SQL snapshots are stale** for every new/changed `@GenerateSql` method in this phase — same standing
  `mise //:sql`-needs-live-Postgres limitation both prior phase logs already carry.
- **The new repository-level medium spec** (`test/medium/specs/repositories/asset.repository.library-editor.spec.ts`)
  typechecks but cannot run in this environment (no Postgres available) — same standing limitation. It pins the
  exact expected behavior (owner/editor/viewer/stranger, atomicity, scope exclusions, date derivation math) for
  whenever a dev DB is available to verify against.

---

## 7. Verification performed

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`), full project, both halves integrated | ✅ clean |
| Lint (eslint, `--max-warnings 0`), every touched file | ✅ clean |
| New/updated unit tests (`library-editor.service.spec.ts`, `library-editor.dto.spec.ts`, `access.spec.ts`, `metadata.service.spec.ts` additions, `asset.service.spec.ts`/`tag.service.spec.ts` stale-assertion fixes) | ✅ all pass |
| Full unit suite | 2236 passed / 72 failed / 2 skipped — all 72 reproduce the exact same pre-existing Windows-vs-POSIX path-separator issue documented in the Phase 1 and Phase 2 logs (storage/media/transcoding/backup/auth/user-management files; none touch libraries, sharing, or exif locking). Every file this phase actually changed passes 100%. |
| Adversarial security review (Fable 5) | Found 2 real High-severity issues (§8) — both fixed and regression-tested, not just noted. |

Two genuine (expected) regressions were found and fixed during verification, not pre-existing noise: dual-column
lock stamping changed the exact `exif` object `AssetService#update` and `TagService` pass to `upsertExif`, so
`asset.service.spec.ts` (2 tests) and `tag.service.spec.ts` (2 assertions, one of them a `not.toHaveBeenCalledWith`
whose literal-object match had gone silently vacuous) needed their expected `sidecarWriteProperties` key added.

---

## 8. Security review

An adversarial review pass specifically targeting the phase's central invariant — that an Editor's database-only
edit can never reach the owner's original files — plus the role/scope TOCTOU protection, field smuggling, response
redaction, atomicity, API-key scoping, the extraction fix's blast radius, and the migration backfill.

**Two real, high-severity findings, both fixed. One informational residual, accepted as a documented limitation.**

### Finding 1 (High, fixed) — an Editor's edit could ride a pending owner sidecar write to disk

`handleSidecarWrite` reads `asset_exif`'s **current** value for whatever properties are in `sidecarWriteProperties`
at the moment the job actually runs — not a value snapshotted when the job was queued. The original
`updateLibraryAssetMetadata` only ever *added* to `lockedProperties` and never touched `sidecarWriteProperties` at
all, including when a property it was about to overwrite already had a pending flag from an earlier **owner**
edit. Concrete sequence: owner edits `description` (queues `SidecarWrite`, marks `description` pending) → before
that job runs, an Editor edits `description` too (overwrites the value, but the pending flag survives untouched)
→ the job finally runs, reads the **Editor's** current value under the stale flag, and writes it into the XMP
sidecar next to the owner's original file. This defeated the phase's core guarantee outright, and the window
isn't microseconds — a paused, backlogged, or retrying sidecar queue leaves it open indefinitely, and a failed
write doesn't clear the pending flag either (only a success does).

**Fix:** `updateLibraryAssetMetadata` now also *removes* whatever properties it just touched from
`sidecarWriteProperties`, in both the non-date and the date-edit branches (new shared `withoutProperties` SQL
helper in `asset.repository.ts`, alongside the existing `distinctUnion`; `unlockProperties` was refactored onto
the same helper for consistency). This cancels the pending owner write for exactly the overwritten property —
correct, because nothing valid is left to flush for an edit that's just been superseded, and the Editor's
replacement value must never reach disk regardless of who queued what first. Regression test added:
`test/medium/specs/repositories/asset.repository.library-editor.spec.ts` — "should cancel a pending owner sidecar
write for a property the Editor overwrites."

### Finding 2 (High, fixed) — the editor's response leaked owner-account `people` data

`LibraryEditorService`'s post-edit response mirrored `AssetService.get()`'s path/stack/live-photo redaction
faithfully, but missed the one other redaction `get()` applies one layer above `mapAsset()`:
`if (data.ownerId !== auth.user.id) { data.people = []; }`. Because the response hydrates `faces: { person: true }`,
any Editor editing any asset with tagged faces would receive full person records — name, birth date, hidden/
favorite/color flags, and a `thumbnailPath` (a server filesystem path) — for people that may be tagged on other,
unshared assets entirely. This directly violated decision 5 ("recipients never see server filesystem paths") and
decision 3's warning about person thumbnails being croppable from unshared assets.

**Fix:** `LibraryEditorService#getUpdatedAsset` now applies the identical `people = []` redaction for any caller
who isn't the asset's owner, matching `AssetService.get()` exactly. Regression test added (both directions —
redacted for a non-owner Editor, not redacted for the owner) in `library-editor.service.spec.ts`.

### Informational — TOCTOU residual (accepted, not fixed)

The in-transaction role/scope re-check closes the meaningful race (the expensive reverse-geocode HTTP call runs
*before* the transaction, so only a tiny SELECT→UPDATE gap remains under default READ COMMITTED isolation). A role
downgrade or share removal committing inside that narrow gap could still let through one final metadata-only edit
from an editor whose access was revoked moments earlier. Consequence is minimal — no disk write, no privilege
escalation, at most one extra database-only edit — so this is left as a documented limitation rather than adding
`FOR UPDATE` row locking or SERIALIZABLE isolation, the same call Phase 2 made for its own non-transactional
shared-link/provenance race once confirmed to carry no actual exposure.

### Correctly blocked (verified, not just assumed)

Cross-library access (checked at both the outer `requireAccess` and the in-transaction scope re-check, independent
of which `libraryId` the caller puts in the URL); Viewer/stranger/shared-link access to either endpoint (`checkEditorAccess`
filters on Editor role specifically, the routes aren't `sharedLink: true`); field smuggling (both DTOs are
`z.strictObject`, and the repository writes a fixed literal column set — no `...dto` spread ever reaches a write);
atomicity (scope validation happens before any write, everything is inside one transaction, any thrown error —
including an invalid date/timezone that Postgres itself would reject — rolls back the whole batch); API-key
permission scoping (no Phase-2-style fallback exists — the editor endpoints are reachable only through
`Permission.LibraryAssetUpdate`, which has no sub-permission hierarchy); the extraction fix's blast radius
(`resolveTimelineDates` is a true no-op for any never-locked asset, and is queried per the exact asset being
extracted, not shared/stale state); and the migration backfill (copies, doesn't duplicate; NULL stays NULL; no
empty-array edge case).

### Ambiguous / underspecified (for awareness, not bugs)

- **Owner using the editor endpoints gets editor semantics** (database-only, no XMP write) instead of the normal
  owner path's semantics. Left as-is: `Permission.LibraryAssetUpdate` is owner ∪ Editor by the plan's own design,
  and an owner already has unrestricted access to their own assets through the pre-existing owner endpoints — this
  is an additional path, not a gap.
- **Editor-set `city`/`state`/`country` aren't independently lockable properties**, so a later re-scan can
  overwrite the reverse-geocoded place name from the file's raw GPS tags while the Editor's locked `latitude`/
  `longitude` stay put, producing a location/place-name mismatch. This exactly matches existing **owner** behavior
  (owner-set coordinates have the same gap today) — parity with a pre-existing limitation, not a Phase 3
  regression, so it wasn't engineered away.

---

## 9. Not in this phase (per the plan's phase split)

Person/face editor endpoints, all web UI (sharing hub, browse page, i18n, docs) → **Phase 4**. The OpenAPI
spec/SDK still haven't been regenerated (carried over from Phases 1–2's same limitation — no live server boot was
possible in this environment).

## 10. Suggested next step

Phase 4 ("Person/face editing + role-aware web UI") is the last phase per the plan: the remaining curation
endpoints (library-scoped person/face listing, create-and-assign, reassignment, manual face box, exclusive-rename
restriction) plus every piece of web UI (sharing hub additions, the shared-library browse route, role-aware asset
viewer/editor, i18n, docs). Recommend running the deferred migration generation and medium/e2e tests (all three
phases now have hand-written, DB-unverified migrations) before or alongside starting Phase 4.
