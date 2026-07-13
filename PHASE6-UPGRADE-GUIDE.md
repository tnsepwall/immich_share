# Phase 6 Upgrade Guide — Mobile Support via Server-Side Pseudo-Partner Projection

This walks through building this repo's modified `immich-server` image and deploying it over an
existing docker-compose-based Immich install. See `IMPLEMENTATION-LOG-phase6.md` for what actually
changed in the code.

## Read this first

- **This phase has a migration.** One new nullable column, `library_user.timelineEnabledId`. Step 4's
  log-watching below is the same shape as Phases 1, 3, and 5's migrations.
- **What changes**: sharees who already turned on Phase 5's "Show in Photos, Explore, Map & Search"
  toggle now ALSO see that shared library's photos and videos in the **stock Immich mobile app**
  (iOS/Android, store builds) — no app update, no new setting on the phone. The server presents the
  library owner as a "partner" to the phone's existing partner-sync machinery, and streams the
  flagged library's assets through it. Turning the web toggle off (or unsharing) removes them from the
  phone again.
- **Zero mobile app changes.** This is entirely server-side. The stock app already asks for partner
  data on every sync and already knows how to store, timeline, and display it — this phase only
  changes what the server decides to send.
- **Only `immich-server` is rebuilt**, same as every prior phase.
- **Test on a copy first if you can.**

## What you need

Same as before: shell access to the Docker host, ~5–10 GB free scratch space for the build, your
existing `docker-compose.yml` and `.env`, and (for step 5) a phone with the stock Immich app signed
into a sharee account.

---

## Step 0 — Back up first

```bash
# Postgres — adjust the container name if yours differs
docker exec immich_postgres pg_dumpall -U postgres > immich_pre_phase6_$(date +%Y%m%d).sql

# Uploaded photos/videos — adjust to your UPLOAD_LOCATION from .env
tar czf immich_library_pre_phase6_$(date +%Y%m%d).tar.gz -C /path/to/your/upload_location .

# Note your current image tag so rollback is a one-line change
docker inspect immich_server --format '{{.Config.Image}}'
```

## Step 1 — Get the code

```bash
cd immich_share
git pull
```

You should now have commits through the Phase 6 work, on top of Phase 5's global-surfaces commits.

## Step 2 — Build the custom image

From the repo root:

```bash
docker build -f server/Dockerfile -t immich-server:phase6-mobile-projection .
```

Same multi-stage build as every prior phase.

## Step 3 — Point compose at the new image

In your existing `docker-compose.yml`, change only the `immich-server` service's `image:` line:

```yaml
services:
  immich-server:
    container_name: immich_server
    # image: immich-server:phase5-global-surfaces
    image: immich-server:phase6-mobile-projection
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
   `1783820000000-AddLibraryUserTimelineEnabledId` (a single
   `ALTER TABLE "library_user" ADD "timelineEnabledId" uuid`, plus a one-time backfill statement
   stamping a fresh watermark on every row that's already flagged `inTimeline = true`), followed by
   **No schema drift detected**. Fast and non-blocking even on a large `library_user` table.
2. Normal Immich startup log lines, ending in the server listening on port 2283.

## Step 5 — Try it out

### 5a. Confirm the web toggle still works exactly as in Phase 5

Nothing on the web changed in this phase. If you haven't already, share a library and have the
sharee turn on **"Show in Photos, Explore, Map & Search"** on the Sharing page — this is still the
single switch that also now controls what reaches their phone.

### 5b. On your phone (the actual point of this phase) — Paul validates this step

This cannot be verified from a devcontainer session; there's no phone here. After deploying, please
walk through this on a real device with the stock Immich app, both a **fresh install** and an
**upgrade of an already-signed-in app** (the sync backfill path differs slightly between the two):

1. As the **sharee**, open the app and let it sync (pull down to refresh, or just wait — sync runs
   automatically). Go to **Photos**: the shared library's photos/videos should now appear, interleaved
   by date with your own and with any real partners' photos.
2. Go to **Account settings → Partners** (or wherever your app version surfaces the partner/sharing
   list). The library **owner's name** should appear there, exactly as a real partner would, with a
   "Show in timeline" switch already on.
3. Tap into that "partner" — you should see a per-person photo grid containing exactly that shared
   library's assets (and nothing else of the owner's, if they have other libraries not shared with
   you, or personal uploads outside this library).
4. As the **owner**, archive one of the photos that's visible on the sharee's phone (web or the
   owner's own app). Within one sync cycle (pull to refresh, or wait for the periodic background
   sync), that photo should **disappear** from the sharee's phone.
5. Unarchive it — it should **reappear** within one sync cycle.
6. As the **sharee**, turn the web toggle **off** for that library (Sharing page → the switch from
   step 5a). The next time the phone syncs, all of that library's photos should be **gone** from the
   phone, and the owner should disappear from the Partners list too (unless you're also real partners,
   or the sharee has another library from the same owner still flagged on — in which case only that
   library's photos should be gone, and the owner should remain a partner).
7. Have the owner **unshare** the library entirely (Sharing management, owner side) instead of the
   sharee toggling it off — same expected result as step 6 from the sharee's phone.
8. If you use real Immich "Partners" (the pre-existing feature, unrelated to libraries) with this same
   owner/sharee pair, confirm nothing about that changes: the real partner's own assets keep syncing
   normally throughout all of the above.

If step 1 shows nothing, first confirm on the web that the sharee's toggle is on and the library
actually has Timeline-visibility (not all-archived) assets, then confirm
`docker inspect immich_server --format '{{.Config.Image}}'` matches Step 2's tag, then force a manual
sync in the app (Settings → Backup/Sync → there is usually a manual "sync now" or a pull-to-refresh
on the main Photos tab).

### 5c. Over the API (sanity check without a phone)

Mobile sync requires a **session token** (from `/auth/login`), not an API key — `/api/sync/stream`
explicitly rejects api-key auth.

```bash
# Log in as the sharee to get a session-backed access token
SHAREE_EMAIL=sharee@example.com
SHAREE_PASSWORD=sharee-password
LOGIN=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"$SHAREE_EMAIL\",\"password\":\"$SHAREE_PASSWORD\"}" \
  "http://localhost:2283/api/auth/login")
TOKEN=$(echo "$LOGIN" | jq -r .accessToken)

# Ask for the partner + partner-asset sync types, exactly like the stock app does
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Accept: application/jsonlines+json" \
  -d '{"types":["PartnersV1","PartnerAssetsV2","PartnerAssetExifsV1"]}' \
  "http://localhost:2283/api/sync/stream"
```

**Expect**: a `PartnerV1` line for the library owner (`inTimeline: true`), followed by
`PartnerAssetV2` and `PartnerAssetExifV1` lines for the shared library's assets, ending in
`SyncCompleteV1`. (A fresh login is a brand-new session, and a session's first-ever sync for an
entity type streams plain upserts — the `PartnerAssetBackfillV2` wire type only appears when an
EXISTING session that already acked other partner data gains a new flagged library later, which is
what a real phone does. Both paths are covered in the medium specs.) See
`IMPLEMENTATION-LOG-phase6.md` §6a for a full annotated transcript from the devcontainer
verification session, including the archive/unarchive, reset, and revocation flows.

---

## Rollback

Nothing here is one-way as long as you did Step 0.

```bash
# Revert the image line in docker-compose.yml back to your prior tag
docker compose up -d
```

The migration (`ADD COLUMN "timelineEnabledId" uuid NULL` plus a backfill UPDATE) is additive and
harmless to leave in place even if you roll back the image — a prior-phase image simply won't read
the new column. If you need to fully revert the schema too:

```bash
docker exec -it immich_postgres psql -U postgres -d immich \
  -c 'ALTER TABLE "library_user" DROP COLUMN "timelineEnabledId";'
```

(Only do this if you're also rolling back to an image from before this phase.)

## What's next

See `IMPLEMENTATION-LOG-phase6.md` §8 for what's explicitly out of scope (mobile People/Memories
stay owner-only-and-Phase-2-scoped, per the plan's explicit non-goal; Search and Map already get
Phase 5's server-side widening "for free" on mobile without any Phase 6 code — Map because the mobile
app's map is a local-DB feature gated by the exact same partner list this phase now populates, Search
because it's a plain REST call to an endpoint Phase 5 already widened).
