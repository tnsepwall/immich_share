# Implementation Log — Editor Person Rename from People Page + Editor Tagging

Follow-up to the video face recognition rollout. Surfaced when a shared-library Editor opened a
person (created by video face detection) from the People page, hit
"Not found or no person.update access" on *Add a name*, and couldn't tag shared assets.

## Root cause (rename)

People belong to the library owner, and the People/person pages call the generic owner-only
`PUT /people/:id`. The fork already had the Editor rename capability
(`PUT /libraries/:libraryId/people/:personId`, Phase 4, scoped to people whose every face lives
inside the shared library) — but the web only wired it inside the asset viewer's face panel. A
person detected *only* from mid-video frames never appears in that panel, so those people had no
rename affordance anywhere.

## Changes

### Person rename routing (server)

- `PersonResponseDto` gains two optional fields:
  - `isOwner` — `true` from `mapPerson`, `false` from `redactPersonForNonOwner`.
  - `renameLibraryId` — filled only by `PersonService#getById` for non-owners: the shared library
    (if any) through which the caller may rename this person.
- New `PersonRepository.getEditorRenameLibraryId(actorId, personId)` — read-side twin of
  `updatePersonNameForLibrary`'s authorization chain (active Editor share on a live library +
  person reachable via a visible in-library face + person exclusive to that library, trashed
  outside-assets still counting). Purely a routing hint; the write path re-validates in its own
  transaction.

### Person rename routing (web)

- Person detail page: name saves route through `updateLibraryPerson` when `renameLibraryId` is
  set; merge suggestions are skipped for non-owned people; the name button is disabled when the
  caller can't rename; the owner-only context menu (feature photo, hide/show, birth date, merge,
  favorite) renders only for the owner.
- People index page: the card hover menu (hide/birth date/merge/favorite) is hidden and the inline
  name input disabled for people projected from shared libraries — Editors rename from the
  person's own page, where the routing hint exists.

### Editor tagging (server)

- New `Permission.LibraryAssetTag` + `AccessRepository.asset.checkSharedLibraryTagAccess` —
  same reachability shape as the Phase-5 album-add fallback but **Editor-role only**.
- `TagService.bulkTagAssets` unions the normal `AssetUpdate` grant with the Editor fallback;
  `TagService.addAssets` retries `NO_PERMISSION` results through it. API keys must hold
  `LibraryAssetTag` explicitly (mirrors the album-insertion fallback rule). Tag removal needed no
  change — a tag owner can always detach their own tag.
- **Owner-originals protection**: `AssetRepository.getForUpdateTags` now feeds only the *asset
  owner's* tags into the exif tag list (and thus the sidecar-write pipeline). A sharee's tag
  vocabulary never reaches the owner's metadata or files — consistent with the Phase 3 rule that
  Editor curation is database-only. (Side effect: a partner's tags also stop propagating into the
  owner's exif — intentional.)

### Editor tagging (web)

- `DetailPanelTags` shows for the owner **or** a shared-library Editor (`LibraryShareContext`
  flows in from the shared-library page); Viewers keep no tag section.
- Share dialog gains the bullet "Add their own tags to shared photos and videos"
  (`library_editor_can_tag`).

## Known behavior / limitations

- Tag chips on an asset are not user-scoped upstream (`withTags` has no user filter), so an
  Editor viewing a shared asset also sees the owner's tag chips (and vice versa); removing someone
  else's chip fails server-side. Pre-existing upstream semantics (partners have the same), left
  unchanged; caller-scoped tag visibility would be a clean follow-up.
- Bulk-selection tagging (`TagAction` in the multi-select bar) remains owner-only — the timeline
  selection model doesn't carry per-asset Editor context. Editors tag from the asset detail panel
  on the shared-library page.
- Editor rename remains scoped to people **exclusive** to the shared library (a person who also
  appears in the owner's other photos can't be renamed by a sharee) — unchanged Phase 4 rule, now
  reachable from the People page. The People page's inline card rename stays disabled for shared
  people (list responses skip the per-person hint query for cost).

## Tests

- Unit: `person.service.spec` (owner ⇒ `isOwner`, no hint query; editor ⇒ redaction + hint),
  `tag.service.spec` (bulk + per-tag Editor fallback).
- Medium: `person.repository.spec` `getEditorRenameLibraryId` (Editor+exclusive ⇒ library id;
  Viewer ⇒ null; outside face ⇒ null).
- Regenerated: SQL snapshots (new queries + owner-scoped `getForUpdateTags`), OpenAPI spec,
  TS SDK, i18n.

## Deploy

Server + web only, no migration. Same rebuild as
`VIDEO-FACE-RECOGNITION-UPGRADE-GUIDE.md` steps 2–3 (build the `immich-server` image, point
compose at it, `docker compose up -d immich-server`) — step 4's migration watch is a no-op here.
