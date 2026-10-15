# Upstream v3.3.3 Upgrade Guide

This walks through deploying the v3.3.3 sync onto the production immich host. See
`IMPLEMENTATION-LOG-upstream-v3.3.3-sync.md` for what changed in the code and how the merge was resolved.
All fork features (shared external libraries Phases 1–6, video face recognition, editor person
rename/tagging) carry forward.

## Read this first

- **12 upstream migrations, and two of them are heavy.** `1787148183729-ClusterGroups` rewrites the person
  model: it creates a `person_group` per person, renames and re-points `asset_face.personId` to
  `personGroupId` (every face row is updated) and rebuilds the person primary key and face indexes.
  `1790616293884-PersonSharing` adds `person_user`. v3.2.1+ also vacuums after migrations and reindexes
  concurrently. Measured on a restored copy of production (194,275 people, 1,533,491 faces, 345,042 assets) all 12 migrations took **38 s** and the API was listening **~70 s** after container start. **Do not restart the container while it bootstraps.**
- **Person ids do not change.** The migration reuses each old `person.id` as its group id, so bookmarked
  person pages, shared-library person links and the web's cached ids keep working.
- **Postgres image unchanged.** Valkey moves to the v3.3.3-pinned digest (9.1.2). The machine-learning
  container moves to v3.3.3; `.env` now pins `IMMICH_VERSION=v3.3.3` so a later `docker compose pull` can't
  move ML ahead of the custom server.
- **Upstream person sharing and cluster groups are new and independent of shared libraries.** Users can now
  share people with each other (Sharing settings → cluster group / Manage access). Joining a cluster group asks
  every member to reset facial recognition for that group (names and birthdates are lost) — warn users before
  they press it.
- **OAuth.** Role sync from the claim (`roleClaim` = `roles` here) already happened on every login in 3.1.
  New in 3.3: if the IdP sends the quota claim (`immich_quota`), the user's quota is updated on every login.
  Nothing changes if it doesn't send that claim.
- **New web search UI** uses the new search API. Shared-library assets are included exactly as in the legacy
  search (in-timeline shares only, never for owner-only filters like favorites/paths/checksum).
- Thumbnails/previews generated from now on use better resampling; run "Generate thumbnails → All" only if
  you want existing ones redone (long, I/O heavy — not needed).
- Optional: `MACHINE_LEARNING_MODEL_REVISION=v2` on the ML container for faster models. Not enabled.

## Deploying (standard procedure)

On the immich host as `tnseit`, from the `immich_share` clone:

```bash
git pull
docker build -f server/Dockerfile -t immich-server:v3.3.3-fork .
```

Then from `/opt/docker/compose/immich-app` (compose image updated to `immich-server:v3.3.3-fork`):

```bash
docker compose pull immich-machine-learning redis
docker compose up -d
docker logs -f immich_server
```

Expected: the 12 migrations log one by one, then the vacuum/reindex lines, then the API worker comes up.
Verify with `curl -s 127.0.0.1:2283/api/server/ping` and Administration → About showing **v3.3.3**.

## Post-deploy spot checks

1. **Shared library still visible to a sharee** — log in as a "Moose Production" recipient: library timeline
   loads, and the NEW search modal (filter search) returns shared assets.
2. **People page** — owner sees the same people as before; a sharee sees library people (no menu on them).
3. **Person page as Editor** — rename a library person from its page; it sticks.
4. **Video faces** — a video with detected faces still shows face chips for the owner, hidden for sharees.
5. **OAuth admin** — an admin logs in via OAuth and still sees Administration.

## Rollback

Rolling back the image alone is NOT enough after this upgrade: the person model migration is not reversible
in practice. To roll back:

1. `docker compose down`
2. Restore the pre-upgrade dump into a fresh database directory
   (`immich_pre_v3.3.3_20261015.sql`, next to the compose file).
3. Point the compose file back at `immich-server:v3.1.0-fork-rollback`,
   `immich-machine-learning:v3.0.2-rollback` and the previous Valkey digest, restore `.env`
   (`IMMICH_VERSION=v3`), and `docker compose up -d`.

The compose file and `.env` from before the upgrade are kept as `docker-compose.yml.pre-v3.3.3` and
`.env.pre-v3.3.3`.

## Validation performed before this was deployed

- Server: tsc 0 errors, eslint/prettier clean, unit 2509 passed (0 failed), medium 900/900.
- Web: svelte-check 0/0, tsc clean, eslint clean, unit 560 passed.
- Migration chain from empty: 107/107; `migrations generate` against it: no changes (no schema drift).
- Production `kysely_migrations` (95) is an exact prefix of the new `ORDER`.
- Rehearsal on a copy of production (dump restored into a scratch vectorchord Postgres, candidate image on an
  isolated network, API worker only): 12/12 migrations in 38 s, API up in ~70 s. 25/25 API checks passed as an
  in-timeline Editor recipient and as the library owner — shared-with-me, legacy and V3 search (incl.
  statistics, probe drop, personIds check), timeline widening, library timeline, redacted library people,
  editor people list and face panel, person page with rename hint, owner-only statistics, owner people and
  statistics, video-face config read back (`videoEnabled: true`), version v3.3.3.
