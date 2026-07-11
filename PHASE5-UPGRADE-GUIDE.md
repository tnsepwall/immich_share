# Phase 5 Upgrade Guide — Shared Libraries in Global Surfaces + Editor Discoverability Fix

This walks through building this repo's modified `immich-server` image and deploying it over an
existing docker-compose-based Immich install. See `IMPLEMENTATION-LOG-phase5.md` for what actually
changed in the code.

## Read this first

- **This phase has a migration.** Unlike Phase 4, this one adds a single boolean column
  (`library_user.inTimeline`). Step 4's log-watching below is the same length as Phases 1–3's — don't
  skip it.
- **Two independent, separately-visible changes**:
  1. A small discoverability fix: shared-library Editors now see a visible **"Edit info"** button in
     the asset viewer toolbar (and in the command palette), instead of relying on the generic "Info"
     button to happen to open an editable panel. No settings, no opt-in — this just works after the
     upgrade for any existing Editor share.
  2. The bigger feature: on the **Sharing** page, each library shared *with you* now has a toggle
     ("Show in Photos, Explore, Map & Search"). Turning it on surfaces that library's assets in your
     main Photos timeline, Explore, Map, and every search mode (metadata, smart search, OCR, person
     search) — on top of the dedicated browse view from Phase 1, which still works exactly as before
     regardless of this toggle. **Default is off** — nothing changes in anyone's main timeline until a
     sharee explicitly opts in.
- **Mobile app is unaffected.** This toggle is web-only, per the original design decision that scoped
  mobile sync out of the whole shared-libraries feature. A sharee's phone will not show shared-library
  assets in its own timeline even after they enable this on the web.
- **Only `immich-server` is rebuilt**, same as every prior phase — this image also bundles the
  rebuilt web frontend. Machine learning, Redis, and Postgres stay on their existing images,
  untouched.
- **Test on a copy first if you can**, same as every prior phase.

## What you need

Same as before: shell access to the Docker host, ~5–10 GB free scratch space for the build, your
existing `docker-compose.yml` and `.env`.

---

## Step 0 — Back up first

```bash
# Postgres — adjust the container name if yours differs
docker exec immich_postgres pg_dumpall -U postgres > immich_pre_phase5_$(date +%Y%m%d).sql

# Uploaded photos/videos — adjust to your UPLOAD_LOCATION from .env
tar czf immich_library_pre_phase5_$(date +%Y%m%d).tar.gz -C /path/to/your/upload_location .

# Note your current image tag so rollback is a one-line change
docker inspect immich_server --format '{{.Config.Image}}'
```

## Step 1 — Get the code

```bash
cd immich_share
git pull
```

You should now have commits through the Phase 5 work, on top of Phase 4's
`Phase 4 follow-up: real SDK regeneration, and fix a live-verification blocker` and the schema-drift
follow-up `Add migration closing library_user schema drift from Phase 1`.

## Step 2 — Build the custom image

From the repo root:

```bash
docker build -f server/Dockerfile -t immich-server:phase5-global-surfaces .
```

Same multi-stage build as every prior phase. Expect the same 10–20+ minute build time; same
`--platform`/`buildx` note applies if cross-building for a different CPU architecture than your
Immich host.

## Step 3 — Point compose at the new image

In your existing `docker-compose.yml`, change only the `immich-server` service's `image:` line:

```yaml
services:
  immich-server:
    container_name: immich_server
    # image: ghcr.io/immich-app/immich-server:${IMMICH_VERSION:-release}
    # image: immich-server:phase1-shared-libraries
    # image: immich-server:phase2-album-provenance
    # image: immich-server:phase3-editor-metadata
    # image: immich-server:phase4-people-faces
    image: immich-server:phase5-global-surfaces
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

1. `Checking for schema drift`, then a migration log line for
   `1783810000000-AddLibraryUserInTimeline` (a single `ALTER TABLE "library_user" ADD "inTimeline"
   boolean NOT NULL DEFAULT false`), followed by **No schema drift detected**. This is a fast,
   single-column, non-blocking migration — it should complete in well under a second even on a large
   `library_user` table, since the new column has a constant default. If you see a *different* drift
   warning after this, something else changed underneath you — don't consider the upgrade done until
   it's resolved, same standing advice as every prior phase.
2. Normal Immich startup log lines, ending in the server listening on port 2283.

## Step 5 — Try it out

### 5a. The Editor discoverability fix (no setup needed if you already have a shared library)

1. Sign in as an existing library Editor (or set one up: owner shares a library, promotes the
   recipient to Editor — see Phase 4's guide if you need a refresher on that flow).
2. Open any photo from that shared library, either through the dedicated shared-library browse route
   or (once you've also turned on the Step 5b toggle) the main timeline.
3. Look at the asset viewer's toolbar: next to the existing "Info" (ⓘ) button, there's now a pencil
   icon labeled **"Edit info"**. Click it — it opens the same metadata editor Phase 4 already built,
   just with a real button pointing at it instead of relying on you to guess that "Info" happened to
   be editable. The panel itself now also shows a small "Edit metadata" header at the top so it's
   obvious you're in an editable view, not a read-only one.

### 5b. Shared libraries in your main timeline

1. Sign in as a user who has a library shared with them (any role — Viewer or Editor both get the
   toggle).
2. Go to the **Sharing** page. Each card under "Shared libraries" now has a switch: **"Show in
   Photos, Explore, Map & Search"**. Turn it on.
3. Go to your main **Photos** page. Assets from that shared library should now appear interleaved
   with your own, in date order, alongside anything shared by partners.
4. Check **Explore** and **Search** (try a metadata search, or a smart/CLIP search if you have it
   enabled) — shared-library assets should appear there too.
5. Check **Map**: open the map settings (gear icon) and turn on the new **"Include shared library
   assets"** switch — shared-library photos with GPS data should now show markers.
6. Try the **People** page and person search — people who appear in the shared library (and nowhere
   in your own account) should now show up too, with a generic avatar (not the owner's private photo
   crop) unless the specific photo their thumbnail is cropped from is itself in the shared library.
7. Turn the Sharing-page switch back off and confirm all of the above reverts — the assets disappear
   from your main timeline/explore/map/search immediately (no cache to clear).
8. As the **owner**, confirm nothing about *your* view of your own library changed, and confirm your
   *other* libraries, your archived/trashed/locked assets, and your regular non-library uploads never
   appeared in the sharee's view at any point above.

If step 2's switch doesn't appear, or step 3 doesn't show any new assets after turning it on, check
`docker inspect immich_server --format '{{.Config.Image}}'` matches Step 2's tag.

### 5c. Over the API (if you'd rather not click through)

```bash
LIBRARY_ID=your-library-id
SHAREE_API_KEY=sharee-account-api-key

# Turn on the main-surfaces toggle for this share
curl -s -X PUT -H "x-api-key: $SHAREE_API_KEY" -H "Content-Type: application/json" \
  -d '{"inTimeline": true}' \
  "http://localhost:2283/api/libraries/$LIBRARY_ID/users/me" | jq
```

**Expect**: a 200 with the updated `SharedLibraryResponseDto`, now including `"inTimeline": true`.

```bash
# Confirm the main timeline now includes the shared library's assets
curl -s -G -H "x-api-key: $SHAREE_API_KEY" \
  --data-urlencode "withSharedLibraries=true" \
  --data-urlencode "visibility=timeline" \
  "http://localhost:2283/api/timeline/buckets" | jq
```

**Expect**: bucket counts that include the shared library's asset dates, alongside your own.

```bash
# Owner attempting to set a sharee's preference on their behalf - must be rejected
OWNER_API_KEY=owner-account-api-key
curl -s -o /dev/null -w "%{http_code}\n" -X PUT -H "x-api-key: $OWNER_API_KEY" \
  -H "Content-Type: application/json" -d '{"inTimeline": true}' \
  "http://localhost:2283/api/libraries/$LIBRARY_ID/users/me"
```

**Expect**: `400` — the owner has no `library_user` row of their own, so this endpoint always rejects
them (they manage sharing through the existing `PUT /libraries/:id/users/:userId` role endpoint
instead, which is unchanged).

---

## Rollback

Nothing here is one-way as long as you did Step 0.

```bash
# Revert the image line in docker-compose.yml back to your prior tag
docker compose up -d
```

The migration itself (`ADD COLUMN ... DEFAULT false`) is additive and harmless to leave in place even
if you roll back the image — a prior-phase image simply won't read the new column. If you need to
fully revert the schema too:

```bash
docker exec -it immich_postgres psql -U postgres -d immich \
  -c 'ALTER TABLE "library_user" DROP COLUMN "inTimeline";'
```

(Only do this if you're also rolling back to an image from before this phase — a Phase-5-or-later
image will fail if the column is missing.)

## What's next

See `IMPLEMENTATION-LOG-phase5.md` §8 for the short list of things intentionally left out of scope
(mobile sync, the per-box OCR endpoint staying owner-only, the full `e2e/` suite) — none of them block
this upgrade.
