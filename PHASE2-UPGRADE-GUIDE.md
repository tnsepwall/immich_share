# Phase 2 Upgrade Guide — Album Provenance

This walks through building this repo's modified `immich-server` and deploying it over an existing
docker-compose-based Immich install that's already running the Phase 1 build. See `IMPLEMENTATION-LOG-phase2.md`
for what actually changed in the code.

## Read this first

- **Nothing new to look at either.** Like Phase 1, this is server-API-only — no web UI work has landed yet (that's
  Phase 4). After upgrading, the gallery looks and behaves exactly as before. What changes is *behavior* on
  endpoints that already exist: a Viewer or Editor of a shared library can now add a visible library asset to an
  album **they own**, and that album membership is revocable — if their library share is later downgraded, removed,
  or the library is archived/deleted, that specific asset silently stops showing up for them (timeline, downloads,
  map, thumbnails) on the next request. Nothing to click, but real access-control behavior to be aware of before you
  rely on it.
- **This build also includes a small Phase 1 fix**, bundled in because it hadn't been deployed yet either: the
  admin-only `GET /api/libraries` and `GET /api/libraries/:id` endpoints now include the `sharedUsers` list, matching
  what `GET /api/libraries/mine` already returned. Nothing to do differently in this guide for that — it's part of
  the same image.
- **The database migration is unverified**, same caveat as Phase 1: no Docker/Postgres was available in the
  environment this was built in, so `server/src/schema/migrations/1783693635932-AddAlbumAssetSourceLibrary.ts` was
  hand-written rather than generated and tested against a live database. Step 4 below is how you confirm it matches
  what the code expects the moment the container starts.
- **Test on a copy first if you can**, same as before. Only `immich-server` is rebuilt.

## What you need

Same as Phase 1: shell access to the Docker host, ~5–10 GB free scratch space for the build, your existing
`docker-compose.yml` and `.env`.

---

## Step 0 — Back up first

```bash
# Postgres — adjust the container name if yours differs
docker exec immich_postgres pg_dumpall -U postgres > immich_pre_phase2_$(date +%Y%m%d).sql

# Uploaded photos/videos — adjust to your UPLOAD_LOCATION from .env
tar czf immich_library_pre_phase2_$(date +%Y%m%d).tar.gz -C /path/to/your/upload_location .

# Note your current image tag so rollback is a one-line change
docker inspect immich_server --format '{{.Config.Image}}'
```

If you followed the Phase 1 guide, your `docker inspect` will currently show `immich-server:phase1-shared-libraries`
— that's the tag to roll back to if needed, not the original `ghcr.io` release.

## Step 1 — Get the code

```bash
cd immich_share
git pull
```

You should now have commits through the Phase 2 work (album provenance) and the executable-bit fix on top of
whatever Phase 1 tag you built before. `git log --oneline -5` should show recent commits referencing Phase 2.

## Step 2 — Build the custom server image

From the repo root:

```bash
docker build -f server/Dockerfile -t immich-server:phase2-album-provenance .
```

Same multi-stage build as Phase 1, just tagged differently so you can tell the two builds apart and roll back to
either one specifically. Expect the same 10–20+ minute build time; same `--platform`/`buildx` note applies if
you're cross-building for a different CPU architecture than your Immich host.

## Step 3 — Point your compose file at the new image

In your existing `docker-compose.yml`, change only the `immich-server` service's `image:` line:

```yaml
services:
  immich-server:
    container_name: immich_server
    # image: ghcr.io/immich-app/immich-server:${IMMICH_VERSION:-release}
    # image: immich-server:phase1-shared-libraries
    image: immich-server:phase2-album-provenance
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

## Step 4 — Restart and watch the logs (the step that matters most)

```bash
docker compose up -d
docker compose logs -f immich_server
```

Watch for, in order:

1. `Running migrations` — the new nullable `sourceLibraryId` column (plus its foreign key and index) gets added to
   `album_asset`. This migration runs in addition to Phase 1's `library_user`/`library_user_audit` migration if
   you're upgrading straight from the original release — both are idempotent and only apply once each.
2. `Checking for schema drift`, then either:
   - **`No schema drift detected`** — good, the hand-written migration matches the code.
   - **A drift warning** — same as Phase 1: the server still starts (it's a warning, not a hard failure), but save
     the warning text and don't consider the upgrade done until it's resolved. Re-check anytime with:
     ```bash
     docker exec immich_server immich-admin schema-check
     ```
3. Normal Immich startup log lines, ending in the server listening on port 2283.

## Step 5 — Smoke-test the behavior change (there's still no UI for this)

Unlike Phase 1, there's no brand-new endpoint to curl — Phase 2 changes how **existing** album endpoints behave for
shared-library assets. The real test needs two non-admin accounts and an already-shared library (if you haven't set
one up yet, do the Phase 1 share flow first: `PUT /api/libraries/{id}/users` from the owner's account).

With owner account **A** (owns a library) and recipient account **B** (shared as Viewer or Editor):

```bash
# As B: confirm the browse route works (Phase 1) and note an assetId from the response
curl -s -H "x-api-key: B_API_KEY" \
  "http://localhost:2283/api/timeline/bucket?libraryId=<LIBRARY_ID>&timeBucket=<YYYY-MM-01>" | jq

# As B: create an album B owns, then add that library asset to it
curl -s -X POST -H "x-api-key: B_API_KEY" -H "Content-Type: application/json" \
  -d '{"albumName": "Provenance test"}' \
  http://localhost:2283/api/albums | jq
# → note the returned "id" as ALBUM_ID

curl -s -X PUT -H "x-api-key: B_API_KEY" -H "Content-Type: application/json" \
  -d '{"ids": ["<ASSET_ID>"]}' \
  http://localhost:2283/api/albums/<ALBUM_ID>/assets | jq
# → should succeed (200) with a per-asset success result, not a permission error
```

Then confirm revocation actually works:

```bash
# As A (owner): remove B's share
curl -s -X DELETE -H "x-api-key: A_API_KEY" \
  http://localhost:2283/api/libraries/<LIBRARY_ID>/users/<B_USER_ID>

# As B: the album still exists, but this specific asset should no longer be visible in it
curl -s -H "x-api-key: B_API_KEY" \
  http://localhost:2283/api/albums/<ALBUM_ID> | jq '.assets'
# → the provenance-linked asset should be gone from this list; other assets B added normally remain
```

A 200 with the asset present in the first check and absent after the share is removed confirms the provenance
mechanism, insertion path, and revocation are all wired up correctly end to end. If you'd rather just confirm the
server boots cleanly without doing the full two-account walkthrough right away, Step 4's clean migration + no
schema-drift warning is already strong evidence the schema side is correct — the behavior above is what to verify
before you actually rely on sharing day to day.

## Rollback

Same as Phase 1 — nothing here is one-way as long as you did Step 0.

```bash
# Revert the image line in docker-compose.yml back to your prior tag (phase1-shared-libraries, or the
# original ghcr.io release — whatever Step 0's docker inspect showed you)
docker compose up -d
```

If the migration already ran and you need the schema back the way it was too:

```bash
docker compose stop immich_server immich-machine-learning
docker exec -i immich_postgres psql -U postgres -c "DROP DATABASE immich;"
docker exec -i immich_postgres psql -U postgres -c "CREATE DATABASE immich;"
cat immich_pre_phase2_YYYYMMDD.sql | docker exec -i immich_postgres psql -U postgres
docker compose up -d
```

## What's next

Phase 3 (editor metadata: description/date/location/rating curation for Editors, database-only, no XMP writes) and
Phase 4 (person/face editing + all web UI) aren't built yet — see `IMPLEMENTATION-LOG-phase2.md` section 9. The
OpenAPI spec and generated SDK still haven't been regenerated, so nothing in `packages/sdk` knows about any of this
yet either.
