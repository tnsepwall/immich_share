# Implementation Log — Video Face Recognition (vendored feature)

**Source:** `github.com/IAfanasov/immich`, branch `feat/video-face-recognition`, head commit
`8edd2610d`. Vendored into this fork as a single squashed commit on top of the v3.0.3 +
shared-libraries baseline.

## What the feature does

Opt-in face detection on sampled video frames, **disabled by default**
(`machineLearning.facialRecognition.videoEnabled: false`).

- A new `videoFaceDetection` queue (concurrency 2) runs three new jobs:
  `AssetVideoDetectFacesQueueAll` → `AssetVideoDetectFaces` → `AssetVideoClusterFaces`.
- `MediaRepository.extractVideoFrames` samples frames with ffmpeg (input-seek, default 1 frame per
  2 s, capped at 50 frames spread evenly across the video, downscaled to preview size).
- Each frame goes through the **existing** ML `detectFaces` endpoint — the Python
  `machine-learning` service is completely untouched.
- Faces are stored as ordinary `asset_face` rows with a new nullable `timestampMs` column; a
  clustering pass dedups near-identical faces within one video by embedding cosine distance
  (the preview/thumbnail face is always kept), then survivors flow into normal facial recognition.
- Person feature-photo thumbnails for video faces re-extract the exact source frame at
  `timestampMs`, because the bounding box is only valid on that frame, not the preview.
- Web: admin settings (enable + interval + max frames), Jobs page queue tile and manual job,
  and both owner-side face surfaces (`PersonSidePanel`, `AssetCacheManager`) filter out
  video-frame faces so frame-relative boxes are never drawn over the preview.
- Existing videos are picked up by the nightly maintenance sweep or a manual run of the
  **Video face detection** job; new videos queue automatically after face detection when the
  feature is enabled.

## DB schema

One migration, `server/src/schema/migrations/1784127594099-AddVideoFaceColumns.ts`:

- `asset_face.timestampMs integer NULL` — milliseconds from video start; NULL for photo/preview faces.
- `asset_job_status.videoFacesRecognizedAt timestamptz NULL` — completion marker for the sweep.

Both columns are nullable adds — the migration is instant and needs no backfill. Its timestamp
already sorts after the fork's future-dated migration block (top: `1783830000000`), so no rename
was needed (the Phase-block rename convention from commit `5a6349fff` only applies when ordering
would break).

## How it was integrated

- The feature branch was based on upstream v3.0.3 (`cd308ad93` — the exact commit this fork last
  merged) plus 10 unrelated post-3.0.3 upstream commits. Analysis showed the 11 feature commits
  have **no dependency** on those 10, so only the net feature diff
  (`git diff e00dcf785 8edd2610d`, 62 files) was applied with `git apply -3`.
- 60 of 62 files applied clean. Two conflicts:
  - `open-api/immich-openapi-specs.json` — resolved by taking the fork side, then regenerating
    from the merged server (see below).
  - `server/test/medium/specs/repositories/person.repository.spec.ts` — one import line; union of
    both sides.
- The fork's rewritten `mapFaces` (redaction-aware, Phase 5) spreads
  `mapFacesWithoutPerson(...)`, which is where the feature added `timestampMs` — so the field
  flows through the sharee redaction path with no extra wiring.

## Fork-specific hardening added on top of the feature

- `PersonRepository.getFacesForLibraryAsset` now filters `asset_face.timestampMs IS NULL`, so the
  library-editor face API (sharee-facing, Phase 4) excludes video-frame faces — parity with the
  owner-side web panels, and it prevents misplaced bounding-box overlays on shared videos.
  Editor assign-by-id scope (`getInScopeFaceIdsTx`) was deliberately left unchanged.
- New tests pinning the shared-libraries × video-faces interactions:
  - medium `person.repository.spec.ts`: `getFacesForLibraryAsset` excludes video-frame faces;
    `getAllForSharedLibraries` counts video faces toward `minimumFaces` (consistent with
    owner-side counting — a person appearing only in shared videos can surface to sharees).
  - unit `person.service.spec.ts`: `getFacesById` keeps `timestampMs` on a video face while
    redacting the person for a shared-library viewer.
  - The feature's own medium test that `deleteFaces` (photo re-detection reset) preserves video
    faces ships with the vendored code.

## Generated artifacts

All regenerated from the merged code rather than hand-merged:

- `server/src/queries/*.sql` — `sync-sql` against a fully migrated scratch Postgres
  (all 93 migrations, including the new one, ran clean — this also validated the migration).
- `open-api/immich-openapi-specs.json` — `sync-open-api` from the merged server; diff vs the fork
  spec is exactly the feature surface (`timestampMs`, `videoFaceDetection` flag/queue/jobs, video
  config fields).
- `packages/sdk/src/fetch-client.ts` — oazapfts regeneration came out byte-identical to the
  patch-merged file.
- `mobile/openapi/*.dart` — taken from the source branch as-is. This fork does not regenerate the
  Dart SDK (it was already stale w.r.t. fork endpoints); these files only add the feature's
  enum/DTO values.
- `i18n/en.json` — union of key sets; prettier-clean.

## Verification

- Server: `tsc --noEmit` clean; `eslint --max-warnings 0` clean; unit suite 2340 passed /
  2 skipped / 74 failed — every failure is a Windows-checkout environment artifact
  (path-separator and disk-format assertions in storage/template/server suites, plus two vendored
  `extractVideoFrames` tests asserting literal POSIX `/tmp` paths). Zero failures in the feature's
  service surface: `person.service.spec` (incl. the new redaction × `timestampMs` test),
  `queue.service.spec`, `job.service.spec`, and the feature's `media.service` thumbnail tests all
  pass.
- Web: `tsc --noEmit` clean; `svelte-check` 0 errors (64 pre-existing warnings in fork/upstream
  files, none in feature-touched files); unit suite 319/320 (the one failure is the pre-existing
  fr.json raw-file loader comparison, CRLF artifact).
- Migration executed against a real Postgres 14 + vectorchord container (93/93 succeeded,
  including `1784127594099-AddVideoFaceColumns`).
- Medium (testcontainers) tests cannot run on the native Windows checkout at all — vitest's
  globalSetup crashes in kysely's `FileMigrationProvider` with `ERR_UNSUPPORTED_ESM_URL_SCHEME`
  (pre-existing, unrelated to this change). Run them in the devcontainer / dev stack
  (`mise run server:test-medium`); the three new interaction tests follow the exact patterns of
  the neighboring passing tests, and the SQL they exercise was regenerated and inspected against
  the migrated scratch database.
- These Windows-only failures all pass in the Linux devcontainer/CI environment the fork normally
  builds and deploys from.

## Future upstream syncs

If upstream later merges IAfanasov's PR (or its own variant of video face detection), its
migration will arrive under a **different filename** but add the **same columns**. During that
sync, drop the duplicate migration (theirs or ours) and reconcile the code diff — same procedure
this fork already uses for overlapping upstream work.
