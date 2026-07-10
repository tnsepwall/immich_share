# Phase 3 Upgrade Guide — Editor Metadata (+ Phase 2 hotfix)

This walks through building this repo's modified `immich-server` and deploying it over an existing
docker-compose-based Immich install. See `IMPLEMENTATION-LOG-phase3.md` for what actually changed in the code,
and sections 9–11 of `IMPLEMENTATION-LOG-phase2.md` / `IMPLEMENTATION-LOG-phase3.md` for the two bug fixes this
build carries.

## Read this first

- **This build fixes the album-creation bug.** If you're upgrading from the Phase 2 image, `POST /api/albums`
  with no assets (or any album creation, really) was broken — a "Failed to create album" error on every attempt.
  That's fixed here. See "Testing the fixes" in Step 5 below — don't skip it.
- **Phase 3 itself adds one small, purely additive capability.** A shared-library Editor can now correct an
  asset's description/date/time/timezone/location/rating through two new endpoints, database-only — it's never
  written to the owner's original file or an XMP sidecar. Nothing about your existing album/library/timeline
  behavior changes; the new endpoints are inert until you call them.
- **The migration is verified this time.** Unlike Phase 1 and Phase 2, this migration
  (`1783780000000-AddAssetExifSidecarWriteProperties.ts`) — and in fact all three phases' migrations — were run
  end-to-end against a real Postgres instance while fixing the album-creation bug. Step 4's schema-drift check is
  still worth watching, but this is the first phase where "should work" has actually been confirmed, not just
  reasoned about.
- **Test on a copy first if you can.** Only `immich-server` is rebuilt — machine learning, Redis, and Postgres
  stay on their existing images, untouched.

## What you need

Same as before: shell access to the Docker host, ~5–10 GB free scratch space for the build, your existing
`docker-compose.yml` and `.env`.

---

## Step 0 — Back up first

```bash
# Postgres — adjust the container name if yours differs
docker exec immich_postgres pg_dumpall -U postgres > immich_pre_phase3_$(date +%Y%m%d).sql

# Uploaded photos/videos — adjust to your UPLOAD_LOCATION from .env
tar czf immich_library_pre_phase3_$(date +%Y%m%d).tar.gz -C /path/to/your/upload_location .

# Note your current image tag so rollback is a one-line change
docker inspect immich_server --format '{{.Config.Image}}'
```

## Step 1 — Get the code

```bash
cd immich_share
git pull
```

You should now have commits through the Phase 3 work and both bug fixes. `git log --oneline -6` should show
`Fix album creation broken by Phase 2, and a silent no-op in Phase 3's editor primitive` at the top.

## Step 2 — Build the custom server image

From the repo root:

```bash
docker build -f server/Dockerfile -t immich-server:phase3-editor-metadata .
```

Same multi-stage build as before, tagged distinctly so you can roll back to any prior phase's image specifically.
Expect the same 10–20+ minute build time; same `--platform`/`buildx` note applies if cross-building for a
different CPU architecture than your Immich host.

## Step 3 — Point compose at the new image

In your existing `docker-compose.yml`, change only the `immich-server` service's `image:` line:

```yaml
services:
  immich-server:
    container_name: immich_server
    # image: ghcr.io/immich-app/immich-server:${IMMICH_VERSION:-release}
    # image: immich-server:phase1-shared-libraries
    # image: immich-server:phase2-album-provenance
    image: immich-server:phase3-editor-metadata
    volumes:
      - ${UPLOAD_LOCATION}:/data
      - /etc/localtime:/etc/localtime:ro
    env_file:
      - .env
    ports:
      - '2283:2283'
    depends_on:
      - redis
      - database
    restart: always
```

Leave `immich-machine-learning`, `redis`, and `database` exactly as they are.

## Step 4 — Restart and watch the logs

```bash
docker compose up -d
docker compose logs -f immich_server
```

Watch for, in order:

1. `Running migrations` — the new nullable `sidecarWriteProperties` column gets added to `asset_exif`, backfilled
   from the existing `lockedProperties` column. This runs alongside every earlier migration if you're upgrading
   from further back — all are idempotent.
2. `Checking for schema drift`, then **No schema drift detected** (or a drift warning — same as before: the
   server still starts, but stop and get it fixed before relying on this build if you see one).
3. Normal Immich startup log lines, ending in the server listening on port 2283.

## Step 5 — Testing the fixes (don't skip this)

This build fixes two real bugs, plus adds new functionality. Test all three.

### 5a. The album-creation fix (this is the one that mattered most)

```bash
# Create an empty album — this is the exact request that used to fail
curl -s -X POST -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"albumName": "Upgrade test"}' \
  http://localhost:2283/api/albums | jq
```

**Expect:** a 200 with the full album object (an `id`, your album name, empty `assets`). If you get
`{"message": "Failed to create album"}` again, the new image didn't actually get picked up — check
`docker inspect immich_server --format '{{.Config.Image}}'` matches Step 2's tag.

Then confirm adding an asset to it still works (this exercises the same code path with the "album already has an
owner row" branch):

```bash
ALBUM_ID=paste-the-id-from-above
ASSET_ID=paste-a-real-asset-id
curl -s -X PUT -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d "{\"ids\": [\"$ASSET_ID\"]}" \
  "http://localhost:2283/api/albums/$ALBUM_ID/assets" | jq
```

**Expect:** a 200 with a per-asset `"success": true` result.

### 5b. Phase 3's new editor endpoints (first time these have run anywhere)

You'll need a library with at least one asset (`GET /api/libraries/mine`, scan it first if `assetCount` is 0).
Testing as the library **owner** is enough to confirm the endpoint works — owners have the same access as
Editors here, so this is the quickest check:

```bash
LIBRARY_ID=your-library-id
ASSET_ID=an-asset-id-in-that-library

curl -s -X PATCH -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"description": "Upgrade test edit", "rating": 4}' \
  "http://localhost:2283/api/libraries/$LIBRARY_ID/assets/$ASSET_ID" | jq
```

**Expect:** a 200 with the updated asset, `description` and `rating` reflecting your edit. This is the exact
code path that used to silently write nothing when an asset had no exif row yet (e.g., freshly imported, metadata
extraction not yet complete) — to specifically stress that case, try this immediately after scanning a brand-new
library, before waiting for extraction jobs to finish. Confirm the edit actually stuck with a plain GET
afterward:

```bash
curl -s -H "x-api-key: YOUR_API_KEY" "http://localhost:2283/api/assets/$ASSET_ID" | jq '.exifInfo.description, .exifInfo.rating'
```

**Expect:** `"Upgrade test edit"` and `4`. If this comes back unchanged despite the PATCH returning success, that
would mean the fix didn't take — worth reporting back immediately.

**Optional, more thorough test** (proves the Viewer/Editor role gate, not just that the endpoint works): share the
library with a second account as Viewer first (`PUT /api/libraries/{id}/users`), confirm that account's PATCH
attempt is rejected, then promote them to Editor (`PUT /api/libraries/{id}/users/{userId}`) and confirm the same
PATCH now succeeds.

### 5c. Bulk editor endpoint (optional)

```bash
curl -s -X PATCH -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d "{\"ids\": [\"$ASSET_ID\"], \"rating\": 5}" \
  "http://localhost:2283/api/libraries/$LIBRARY_ID/assets" | jq
```

**Expect:** a 200 with an array containing the one updated asset.

---

## Rollback

Nothing here is one-way as long as you did Step 0.

```bash
# Revert the image line in docker-compose.yml back to your prior tag
docker compose up -d
```

If the migration already ran and you need the schema back the way it was too:

```bash
docker compose stop immich_server immich-machine-learning
docker exec -i immich_postgres psql -U postgres -c "DROP DATABASE immich;"
docker exec -i immich_postgres psql -U postgres -c "CREATE DATABASE immich;"
cat immich_pre_phase3_YYYYMMDD.sql | docker exec -i immich_postgres psql -U postgres
docker compose up -d
```

## What's next

Phase 4 ("Person/face editing + role-aware web UI") is the last phase per the plan — the remaining curation
endpoints and all of the web UI (sharing hub, browse page, i18n, docs). See `IMPLEMENTATION-LOG-phase3.md`
section 10. The OpenAPI spec/SDK still haven't been regenerated, so nothing in `packages/sdk` knows about any of
this yet either.
