# Upstream v3.1.0 Upgrade Guide

This walks through deploying the v3.1.0 sync onto the production immich host. See
`IMPLEMENTATION-LOG-upstream-v3.1.0-sync.md` for what changed in the code and how the merge was
resolved. All fork features (shared external libraries Phases 1–6, video face recognition,
editor person rename/tagging) carry forward unchanged.

## Read this first

- **This upgrade has two migrations, both instant.**
  - `AddOAuthBearerTokenToSession` — one nullable `ALTER TABLE session ADD COLUMN`.
  - `MinFacePreferenceMigration` — one upsert into `user_metadata` per user (seeds each user's
    `people.minimumFaces` from the current system ML `minFaces` value, skipping users who
    already set their own). At our user count this is milliseconds.
- **No vector index changes, no Postgres image change, no ML container change.** This deploy
  should NOT trigger a vectorchord reindex — expect a normal bootstrap, not the ~10-minute
  clustering downtime from the face-index rebuild on 2026-07-21. As always, don't restart the
  container mid-bootstrap.
- **People-page threshold is now per-user.** Until now, "hide people with fewer than N faces"
  came from the admin ML setting (`minFaces`, ours effectively default). After the migration
  each user owns that threshold in their account settings; changing the admin ML value no
  longer affects existing users' People pages. With video face detection enabled, users who
  want a stricter/looser People page can now tune it themselves.
- **OIDC behavior change — read if you manage the IdP.** v3.1.0 syncs admin status from the
  OAuth role claim on **every login** (previously only at account creation). The claim key is
  the `oauth.roleClaim` setting, default `immich_role`. **If the IdP does not send that claim,
  nothing changes** — no claim means no promotion/demotion, so our manually-granted admins
  (e.g. Austin Day) keep their status. Before deploying, confirm our OAuth provider isn't
  sending `immich_role` (or whatever `roleClaim` is set to in Administration → Settings →
  OAuth) with a non-admin value for current admins; if it is, either fix the IdP claim or
  clear the `roleClaim` setting first.
- **Password reset via admin CLI can now invalidate sessions** (`--invalidate-sessions`) —
  useful the next time someone loses a device.
- **Mobile drops iOS 14** — anyone on an iPhone 6/6s-era device stops getting app updates.
- **Search V3 note:** upstream shipped inert plumbing for a new search engine. It is not
  reachable in 3.1.0 and has no shared-library support yet; that lands on our side when
  upstream wires the endpoints (tracked in the implementation log watch list).

## Deploying (standard procedure)

On the immich host as `tnseit`, from the `immich_share` clone:

```bash
git pull
docker build -f server/Dockerfile -t immich-server:video-face-recognition .
```

Then from `/opt/docker/compose/immich-app`:

```bash
docker compose up -d immich-server
```

Watch bootstrap:

```bash
docker logs -f immich_server
```

Expected: the two new migrations log and complete immediately, no reindex lines, API worker up
within the usual window. Verify with:

```bash
curl -s 127.0.0.1:2283/api/server/ping
```

and check the web UI reports **v3.1.0** under Administration → About.

## Post-deploy spot checks

1. **Shared library still visible to a sharee** — log in as any "Moose Production" recipient,
   confirm the library timeline loads and search returns shared assets.
2. **People page** — as the library owner, confirm People page loads with the same people as
   before (the seeded per-user threshold preserves current behavior).
3. **OAuth login** — have one OAuth admin log in and confirm they still see the
   Administration menu (role-claim sync check).
4. **Video faces** — open a video with detected faces; confirm face chips still show for the
   owner and stay hidden from sharees.
5. **Editor rename** — as an Editor on the shared library, rename a person from the People
   page; confirm it sticks.

## Rollback

The new columns/rows are additive and harmless to older code, but the safe rollback is the same
as always: retag the previous image build and `docker compose up -d immich-server`. Do NOT
attempt `migrations revert` (`MinFacePreferenceMigration` has no down path). If a rollback past
a completed migration is ever needed, restore the Postgres backup from before the deploy.

## Validation performed before this was pushed

- Full migration chain executed from scratch on a disposable vectorchord Postgres (production
  order) — green.
- Server build clean; unit suite at the exact native-Windows baseline (74 known
  path-separator failures, everything else green including upstream's new tests).
- Web `svelte-check`/`tsc` clean (0 errors).
- Dockerized medium suite (real Postgres): 537/537 passed.
- OpenAPI spec, SDK client, and en.json regenerate byte-identical; SQL snapshots regenerated
  with the shared-library arms intact.
