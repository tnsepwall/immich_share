# Phase 1 Upgrade Guide — Shared External Libraries

This walks through building this repo's modified `immich-server` and deploying it over an existing
docker-compose-based Immich install. See `IMPLEMENTATION-LOG-phase1.md` for what actually changed in the code.

## Read this first

- **Nothing will look different.** Phase 1 is server-API-only — no web UI work has landed (that's Phase 4). After
  upgrading, the gallery looks and behaves exactly as before. The new capability exists only as API endpoints
  (`/api/libraries/mine`, `/api/libraries/shared-with-me`, share management routes, and a `libraryId` param on the
  timeline endpoints).
- **The database migration is unverified.** No Docker/Postgres was available in the environment this was built in,
  so the migration (`server/src/schema/migrations/1783648584743-AddSharedLibraryAccess.ts`) was hand-written to
  mirror existing migrations rather than generated and tested against a live database. It should match the schema
  the code expects — but "should" isn't "confirmed." Step 4 below tells you exactly how to check this the moment
  the container starts, and it's the most important step in this guide.
- **Test on a copy first if you can.** Only `immich-server` is rebuilt — `immich-machine-learning`, `redis`, and
  `database` (Postgres) stay on their existing official images, untouched.

## What you need

- Shell access to the Docker host running Immich (this build must run on that host, or on a machine with the same
  CPU architecture — see the note in Step 2 if not).
- Enough free disk for the build (~5–10 GB scratch space; it compiles the server, web, CLI, and plugin bundles).
- Your existing `docker-compose.yml` and `.env` for this Immich install.

---

## Step 0 — Back up first

```bash
# Postgres — adjust the container name if yours differs
docker exec immich_postgres pg_dumpall -U postgres > immich_pre_phase1_$(date +%Y%m%d).sql

# Uploaded photos/videos — adjust to your UPLOAD_LOCATION from .env
tar czf immich_library_pre_phase1_$(date +%Y%m%d).tar.gz -C /path/to/your/upload_location .

# Note your current image tag so rollback is a one-line change
docker inspect immich_server --format '{{.Config.Image}}'
```

Keep both files somewhere off the Docker host until you're confident in the upgrade.

## Step 1 — Get the code

```bash
git clone https://github.com/tnsepwall/immich_share.git
cd immich_share
```

(Already cloned? `git pull` instead.)

## Step 2 — Build the custom server image

From the repo root:

```bash
docker build -f server/Dockerfile -t immich-server:phase1-shared-libraries .
```

This runs the same multi-stage build Immich's official image uses (server + web + CLI + plugins bundled into one
image) — it just builds from this modified source instead of pulling from `ghcr.io`. Expect 10–20+ minutes
depending on hardware; it needs BuildKit, which is on by default in Docker 20.10+ (if you get a mount-syntax error,
prefix the command with `DOCKER_BUILDKIT=1`).

If you're building on a different CPU architecture than your Immich host (e.g., building on an amd64 workstation
for an ARM NAS), add `--platform linux/arm64` (or whichever applies) and expect it to take considerably longer via
emulation, or use `docker buildx` with a real remote builder for that architecture instead.

## Step 3 — Point your compose file at the new image

In your existing `docker-compose.yml`, change only the `immich-server` service's `image:` line:

```yaml
services:
  immich-server:
    container_name: immich_server
    # image: ghcr.io/immich-app/immich-server:${IMMICH_VERSION:-release}
    image: immich-server:phase1-shared-libraries
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

1. `Running migrations` — the new `library_user` / `library_user_audit` tables get created.
2. `Checking for schema drift`, then either:
   - **`No schema drift detected`** — the hand-written migration matches the code exactly. You're good.
   - **A drift warning listing specific items** — something in the migration doesn't match what the code expects.
     The server still starts (drift is a warning, not a hard failure), but **stop here and don't consider this
     done** — save the drift warning text and get it fixed before relying on this build. You can re-run the check
     any time with:
     ```bash
     docker exec immich_server immich-admin schema-check
     ```
3. The normal Immich startup log lines you're used to seeing, ending in the server listening on port 2283.

## Step 5 — Smoke-test the new API (there's no UI to click yet)

Get an API key the normal way: **Account Settings → API Keys** in the web UI (unaffected by this change), then:

```bash
# Should return [] or your existing owned external libraries — not a 404/500
curl -s -H "x-api-key: YOUR_API_KEY" http://localhost:2283/api/libraries/mine | jq

# Should return [] — nothing has been shared with this account yet
curl -s -H "x-api-key: YOUR_API_KEY" http://localhost:2283/api/libraries/shared-with-me | jq

# Sanity check: pre-existing admin-only endpoint still works unaffected (needs an admin API key)
curl -s -H "x-api-key: YOUR_ADMIN_API_KEY" http://localhost:2283/api/libraries | jq
```

A 200 with a JSON array (even an empty one) on the first two confirms the new routes, permissions, and DB tables
are wired up correctly end to end.

## Rollback

Nothing here is one-way as long as you did Step 0.

```bash
# Revert the image line in docker-compose.yml back to:
#   image: ghcr.io/immich-app/immich-server:${IMMICH_VERSION:-release}   (or whatever Step 0 showed you)
docker compose up -d
```

If the migration already ran and you need the schema back the way it was too (only necessary if something is
actually broken, not just as a precaution):

```bash
docker compose stop immich_server immich-machine-learning
docker exec -i immich_postgres psql -U postgres -c "DROP DATABASE immich;"
docker exec -i immich_postgres psql -U postgres -c "CREATE DATABASE immich;"
cat immich_pre_phase1_YYYYMMDD.sql | docker exec -i immich_postgres psql -U postgres
docker compose up -d
```

## What's next

Phases 2–4 (album provenance, editor metadata, and all of the web UI) aren't built yet — see
`IMPLEMENTATION-LOG-phase1.md` section 5. The OpenAPI spec and generated SDK also haven't been regenerated, so
nothing in `packages/sdk` knows about these endpoints yet either — that needs to happen before any UI work can
consume them.
