# Phase 4 Upgrade Guide — Person/Face Editing + Role-Aware Web UI

This walks through building this repo's modified `immich-server` image and deploying it over an existing
docker-compose-based Immich install. See `IMPLEMENTATION-LOG-phase4.md` for what actually changed in the code.

## Read this first

- **This is the first phase with anything to actually look at.** Phases 1–3 were server-API-only — no web UI
  existed yet, so upgrading changed behavior but not appearance. After this upgrade, sign in and check the
  **Sharing** page: there's a new "Shared libraries" section, a Share button on libraries you own, and — if you
  open a shared library — a role-aware asset viewer with a metadata editor and a face-labeling panel for Editors.
- **No new database migration.** Unlike every prior phase, Phase 4 adds no schema changes — it's built entirely
  on tables that already existed (`person`, `asset_face`, `library_user`). Step 4's log-watching is shorter this
  time; there's no migration step to wait on.
- **What an Editor can now do, on top of Phase 3's metadata editing**: see the people tagged in a shared
  library's photos, label an untagged face (create a new person or reassign to an existing one), draw a manual
  face box, and rename a person — but only if every one of that person's faces is inside this library. All of it
  is database-only, same guarantee as Phase 3: nothing here ever touches the owner's original files or writes an
  XMP sidecar, and a Viewer still can't do any of it (view-only, same as before).
- **This is the last phase.** The original plan scoped this work to four phases; there's no Phase 5 to follow
  this one. See `IMPLEMENTATION-LOG-phase4.md` §9 for the handful of things still explicitly left open (a real
  browser click-through with a connected extension, testing the face-labeling flow against real imported photos,
  the e2e suite) — none of them block this upgrade, they're follow-up polish.
- **Test on a copy first if you can**, same as every prior phase. Only `immich-server` is rebuilt — but note this
  image now also bundles a rebuilt **web** frontend (`server/Dockerfile`'s `web` stage always has, every prior
  phase just had nothing new in it). Machine learning, Redis, and Postgres stay on their existing images,
  untouched.

## What you need

Same as before: shell access to the Docker host, ~5–10 GB free scratch space for the build, your existing
`docker-compose.yml` and `.env`.

---

## Step 0 — Back up first

```bash
# Postgres — adjust the container name if yours differs
docker exec immich_postgres pg_dumpall -U postgres > immich_pre_phase4_$(date +%Y%m%d).sql

# Uploaded photos/videos — adjust to your UPLOAD_LOCATION from .env
tar czf immich_library_pre_phase4_$(date +%Y%m%d).tar.gz -C /path/to/your/upload_location .

# Note your current image tag so rollback is a one-line change
docker inspect immich_server --format '{{.Config.Image}}'
```

## Step 1 — Get the code

```bash
cd immich_share
git pull
```

You should now have commits through the Phase 4 work. `git log --oneline -3` should show `Phase 4 follow-up: real
SDK regeneration, and fix a live-verification blocker` at the top, with `Phase 4: Person/face editing +
role-aware web UI (shared external libraries)` just below it.

## Step 2 — Build the custom image

From the repo root:

```bash
docker build -f server/Dockerfile -t immich-server:phase4-people-faces .
```

Same multi-stage build as every prior phase (it was always building the web frontend too — this is just the
first time that half has anything new in it), tagged distinctly so you can roll back to any prior phase's image
specifically. Expect the same 10–20+ minute build time; same `--platform`/`buildx` note applies if cross-building
for a different CPU architecture than your Immich host.

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
    image: immich-server:phase4-people-faces
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

1. `Checking for schema drift`, then **No schema drift detected**. There's no new migration this phase, so this
   should be uneventful — if you see a drift warning anyway, something else changed underneath you; don't
   consider the upgrade done until it's resolved (same standing advice as every prior phase).
2. Normal Immich startup log lines, ending in the server listening on port 2283.

## Step 5 — Try it out

This is the first phase where the easiest way to check it is to just look at it.

### 5a. In the browser

1. Sign in as a user who **owns** an external library (or create one first: Administration → External
   Libraries, if you haven't already from an earlier phase).
2. Go to the **Sharing** page. You should see a new **Shared libraries** section. If you own a library, it has a
   **Share** button — open it and add a second account as **Editor**.
3. Sign in as that second account. The shared library now appears under "Shared libraries" on their Sharing page
   too — click into it to browse it.
4. Open a photo from that library as the Editor. You should see:
   - A metadata editor for description, date/time, time zone, GPS location, and rating (in place of the normal
     owner controls) — edit one field and confirm it saves.
   - A "People" panel scoped to this library only — if the photo has a detected, untagged face, label it (create
     a new person, or assign to an existing one if the library already has named people). Try renaming a person
     too.
5. As the **owner**, confirm none of the Editor's edits touched anything outside what you'd expect — the
   original file on disk is unchanged, and (if you have sidecar writing enabled) no XMP sidecar was written for
   the Editor's edits specifically.

If step 2 doesn't show a Share button, or step 4's Editor view falls back to the normal read-only viewer instead
of showing the metadata editor and People panel, the new image likely didn't get picked up — check
`docker inspect immich_server --format '{{.Config.Image}}'` matches Step 2's tag.

### 5b. Over the API (if you'd rather not click through, or don't have browser access to this host)

You'll need a library with at least one asset that has a detected face (scan it and let facial recognition finish
if you haven't already). Testing as the library **owner** is enough to confirm the endpoints work — owners have
the same access as Editors here.

```bash
LIBRARY_ID=your-library-id
ASSET_ID=an-asset-id-in-that-library-with-a-detected-face

# List people reachable through this library (probably empty the first time - faces exist, but nobody's named them yet)
curl -s -H "x-api-key: YOUR_API_KEY" \
  "http://localhost:2283/api/libraries/$LIBRARY_ID/people" | jq

# List the faces on that asset - grab a faceId from the response
curl -s -H "x-api-key: YOUR_API_KEY" \
  "http://localhost:2283/api/libraries/$LIBRARY_ID/assets/$ASSET_ID/faces" | jq
```

**Expect:** the first call returns `{"people": [], "hasNextPage": false}` (or existing named people, if any faces
in this library were already tagged before this upgrade). The second returns an array of face objects with
bounding boxes; note one `id` as `FACE_ID`.

```bash
FACE_ID=paste-a-face-id-from-above

# Create a person from that face
curl -s -X POST -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d "{\"name\": \"Upgrade Test\", \"faceIds\": [\"$FACE_ID\"]}" \
  "http://localhost:2283/api/libraries/$LIBRARY_ID/people" | jq
```

**Expect:** a 201 with the new person (`id`, `name: "Upgrade Test"`, and a `thumbnailFace` pointing at the asset
and bounding box you just used — note there's no `thumbnailPath` here, unlike the owner-only person endpoints;
that's deliberate, see `IMPLEMENTATION-LOG-phase4.md` §4).

```bash
PERSON_ID=paste-the-id-from-above

# Rename them
curl -s -X PUT -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"name": "Renamed via API"}' \
  "http://localhost:2283/api/libraries/$LIBRARY_ID/people/$PERSON_ID" | jq
```

**Expect:** a 200 with `name: "Renamed via API"`. If this same person has any face outside this library (unlikely
for one you just created from scratch, but worth knowing), you'd get a 400 instead — that's the rename
restriction working as intended, not a bug.

**Optional, more thorough test** (proves the Viewer/Editor role gate, not just that the endpoints work): share
the library with a second account as Viewer first, confirm their `GET .../people` still works (Viewers can read)
but a `POST .../people` from that account is rejected, then promote them to Editor and confirm the same `POST`
now succeeds.

---

## Rollback

Nothing here is one-way as long as you did Step 0. There's no migration to reverse this time.

```bash
# Revert the image line in docker-compose.yml back to your prior tag
docker compose up -d
```

## What's next

Nothing — this was the last phase. See `IMPLEMENTATION-LOG-phase4.md` §9 for the short list of things worth
doing before treating this as fully shipped (a real browser click-through, face-labeling tests against real
imported photos, the e2e suite) — all polish and verification, not missing functionality.
