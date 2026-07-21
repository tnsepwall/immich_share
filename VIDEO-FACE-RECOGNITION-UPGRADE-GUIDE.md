# Video Face Recognition Upgrade Guide

This walks through building this repo's modified `immich-server` image and deploying it over an
existing docker-compose-based Immich install. See `IMPLEMENTATION-LOG-video-face-recognition.md`
for what actually changed in the code.

## Read this first

- **This change has a migration.** Two new nullable columns: `asset_face.timestampMs` and
  `asset_job_status.videoFacesRecognizedAt`. Both are instant adds with no backfill — the same
  log-watching shape as the Phase 1/3/5/6 migrations.
- **What changes**: nothing, until you turn it on. The feature is **disabled by default**. Once
  enabled (Administration → Settings → Machine Learning → Facial Recognition → *Video face
  detection*), Immich samples frames from each video (default 1 frame per 2 seconds, at most 50
  frames spread across the video), detects faces on those frames with the existing ML service,
  dedups them within the video, and feeds them into normal facial recognition. People who appear
  only in videos start showing up on the People page, with person thumbnails cropped from the
  exact video frame.
- **The Python machine-learning container is untouched** — no ML model changes, no
  `immich-machine-learning` rebuild. Only `immich-server` is rebuilt (the image bundles the web
  UI, as in every prior phase).
- **Shared libraries interaction**: video faces attach to their video asset, so all Phase 1–6
  access control and redaction applies automatically. Sharee-facing face lists exclude
  video-frame faces (their bounding boxes only make sense on the sampled frame). A person who
  appears only in a shared library's videos can now surface to sharees once they cross the
  owner's `minimumFaces` threshold — same rule photos already follow.
- **Test on a copy first if you can.**

## What you need

Same as before: shell access to the Docker host, ~5–10 GB free scratch space for the build, and
your existing `docker-compose.yml` and `.env`.

---

## Step 0 — Back up first

```bash
# Postgres — adjust the container name if yours differs
docker exec immich_postgres pg_dumpall -U postgres > immich_pre_videofaces_$(date +%Y%m%d).sql

# Note your current image tag so rollback is a one-line change
docker inspect immich_server --format '{{.Config.Image}}'
```

## Step 1 — Get the code

```bash
cd immich_share
git pull
```

You should now have the `feat: video face recognition` commit on top of the Phase 6 work.

## Step 2 — Build the custom image

From the repo root:

```bash
docker build -f server/Dockerfile -t immich-server:video-face-recognition .
```

## Step 3 — Point compose at the new image and restart

In your `docker-compose.yml`, set the `immich-server` service image to
`immich-server:video-face-recognition`, then:

```bash
docker compose up -d immich-server
```

## Step 4 — Watch the migration run

```bash
docker logs -f immich_server 2>&1 | grep -i migration
```

You should see `Migration "1784127594099-AddVideoFaceColumns" succeeded` followed by
`Finished running migrations`. Both columns are nullable adds — this takes well under a second.

## Step 5 — Enable and try it

1. Web → **Administration → Settings → Machine Learning → Facial Recognition**: turn on
   **Video face detection**. Leave the frame interval (2 s) and max frames (50) at their
   defaults unless you have a reason not to.
2. **Administration → Jobs**: run the new **Video face detection** job to process existing
   videos (new uploads are handled automatically; the nightly maintenance sweep also picks up
   any stragglers). The force/"all" variant reprocesses every video; the normal run only
   processes videos that haven't been done yet.
3. Watch the queue drain on the Jobs page (`videoFaceDetection`, concurrency 2). Frame
   extraction is ffmpeg work on the server container — expect CPU load proportional to your
   video library size on the first full run.
4. When facial recognition finishes afterward, check the People page: people who only appear in
   videos should now be present. Opening a video asset should show **no** face boxes from video
   frames (that's intentional — the boxes only exist on sampled frames).

## Rollback

Point `docker-compose.yml` back at your previous image tag and `docker compose up -d
immich-server`. The two new columns are nullable and ignored by older builds — no schema
rollback needed. If you also want the data gone, delete video-frame faces first:

```sql
DELETE FROM asset_face WHERE "timestampMs" IS NOT NULL;
```

(Then optionally re-run the *Refresh faces* job.)

## Tuning notes

- `videoFrameInterval` (1–300 s): smaller = more frames = better recall, more CPU.
- `videoMaxFrames` (1–500): hard cap per video; when a video is long enough that the interval
  would exceed the cap, frames are spread evenly across the whole duration instead.
- Long videos at defaults: a 2-hour video samples 50 frames total, not 3600.
