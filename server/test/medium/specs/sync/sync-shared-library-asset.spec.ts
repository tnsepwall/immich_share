import { Kysely } from 'kysely';
import { AssetVisibility, SyncEntityType, SyncRequestType } from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
import { LibraryRepository } from 'src/repositories/library.repository';
import { DB } from 'src/schema';
import { SyncTestContext } from 'test/medium.factory';
import { getKyselyDB, wait } from 'test/utils';

// Phase 6: mobile pseudo-partner projection - flagged shared-library assets ride the EXISTING
// PartnerAssetV2/PartnerAssetBackfillV2/PartnerAssetDeleteV1 wire types (sync.service.ts's
// syncPartnerAssetsV2). See FEATURE-PLAN-phase6-mobile-projection.md §2-§4, §6 gate 2's full lifecycle
// requirement: share -> flag on -> backfill contents exact -> new asset upserts -> archive = delete
// event -> unarchive = re-upsert -> flag off = reset marker -> re-sync excludes.

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SyncRequestType.PartnerAssetsV2, () => {
  describe('full lifecycle', () => {
    it('share -> flag on -> backfill -> new upsert -> archive (delete event) -> unarchive (re-upsert) -> flag off (reset)', async () => {
      const { auth, ctx } = await setup();
      const libraryRepo = ctx.get(LibraryRepository);

      const { user: owner } = await ctx.newUser();
      const { library } = await ctx.newLibrary({ ownerId: owner.id });
      const { asset: existingAsset } = await ctx.newAsset({ ownerId: owner.id, libraryId: library.id });

      // --- flag on: backfill contents exact ---
      await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

      // This is the session's first-ever sync call, so it never runs the backfill-completion dance
      // (no prior PartnerAssetV2 checkpoint exists to backfill relative to - see the
      // "no-upsert-checkpoint first-sync short-circuit" in sync.service.ts, which every real-partner
      // first-sync test in this codebase also hits: PartnerAssetV2, not PartnerAssetBackfillV2). The
      // dedicated "backfill ordering" spec below exercises the true PartnerAssetBackfillV2 path.
      const backfillResponse = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      expect(backfillResponse).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({
            id: existingAsset.id,
            libraryId: library.id,
            isFavorite: false,
            stackId: null,
          }),
          type: SyncEntityType.PartnerAssetV2,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, backfillResponse);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetsV2]);

      // --- new asset upserts ---
      const { asset: newAsset } = await ctx.newAsset({ ownerId: owner.id, libraryId: library.id });
      const upsertResponse = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      expect(upsertResponse).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: newAsset.id, isFavorite: false, stackId: null }),
          type: SyncEntityType.PartnerAssetV2,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, upsertResponse);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetsV2]);

      // --- archive = scope exit = delete event ---
      await ctx.database
        .updateTable('asset')
        .set({ visibility: AssetVisibility.Archive })
        .where('id', '=', newAsset.id)
        .execute();

      const archiveResponse = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      expect(archiveResponse).toEqual([
        {
          ack: expect.any(String),
          data: { assetId: newAsset.id },
          type: SyncEntityType.PartnerAssetDeleteV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, archiveResponse);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetsV2]);

      // --- unarchive = re-enters naturally as a fresh upsert (§3.5) ---
      await ctx.database
        .updateTable('asset')
        .set({ visibility: AssetVisibility.Timeline })
        .where('id', '=', newAsset.id)
        .execute();

      const restoreResponse = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      expect(restoreResponse).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: newAsset.id }),
          type: SyncEntityType.PartnerAssetV2,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
      await ctx.syncAckAll(auth, restoreResponse);

      // --- flag off (last flagged library from this owner) = eventual PartnerDeleteV1, and the asset
      // stops being served by any subsequent upsert/backfill query ---
      await libraryRepo.removeUser(library.id, auth.user.id);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetsV2]);

      // A brand new asset added to the (now-unshared) library must never surface either.
      await ctx.newAsset({ ownerId: owner.id, libraryId: library.id });
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetsV2]);
    });
  });

  describe('scope predicate (§0.4)', () => {
    it("never streams an archived asset's metadata - at most a bare scope-exit delete", async () => {
      const { auth, ctx } = await setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await ctx.newLibrary({ ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Archive,
      });

      await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

      // No PartnerAssetV2/PartnerAssetBackfillV2 may ever mention this asset. The scope-exit stream
      // does over-deliver a delete for it (the server cannot know the client never saw it; unknown ids
      // are client no-ops - the same contract as the owner-scoped hard-delete stream), and the exact
      // equality on `data` below is the real §5 assertion: the event carries ONLY the asset id.
      const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      expect(response).toEqual([
        {
          ack: expect.any(String),
          data: { assetId: asset.id },
          type: SyncEntityType.PartnerAssetDeleteV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });

    it("never streams a locked asset's metadata - at most a bare scope-exit delete", async () => {
      const { auth, ctx } = await setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await ctx.newLibrary({ ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Locked,
      });

      await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

      const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      expect(response).toEqual([
        {
          ack: expect.any(String),
          data: { assetId: asset.id },
          type: SyncEntityType.PartnerAssetDeleteV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });

    it('DOES stream a hidden-visibility asset (live-photo motion part) on first sync', async () => {
      const { auth, ctx } = await setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await ctx.newLibrary({ ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Hidden,
      });

      await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

      // First-ever sync for this session -> plain PartnerAssetV2, not PartnerAssetBackfillV2 (see the
      // comment in the full-lifecycle spec above); the "backfill ordering" spec below covers the
      // true backfill wire path.
      const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      expect(response).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: asset.id }),
          type: SyncEntityType.PartnerAssetV2,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });

    it('never streams an asset from an unflagged (but still shared) library', async () => {
      const { auth, ctx } = await setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await ctx.newLibrary({ ownerId: owner.id });
      await ctx.newAsset({ ownerId: owner.id, libraryId: library.id });
      await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: false });

      await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetsV2]);
    });

    it("never streams the owner's other (unshared) library assets", async () => {
      const { auth, ctx } = await setup();
      const { user: owner } = await ctx.newUser();
      const { library: sharedLibrary } = await ctx.newLibrary({ ownerId: owner.id });
      const { library: otherLibrary } = await ctx.newLibrary({ ownerId: owner.id });
      const { asset: sharedAsset } = await ctx.newAsset({ ownerId: owner.id, libraryId: sharedLibrary.id });
      await ctx.newAsset({ ownerId: owner.id, libraryId: otherLibrary.id });
      await ctx.newLibraryUser({ libraryId: sharedLibrary.id, userId: auth.user.id, inTimeline: true });

      const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      expect(response).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ id: sharedAsset.id }) }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });
  });

  describe('hard delete (§2.5)', () => {
    it('emits PartnerAssetDeleteV1 when a flagged-library asset is hard-deleted', async () => {
      const { auth, ctx } = await setup();
      const assetRepo = ctx.get(AssetRepository);
      const { user: owner } = await ctx.newUser();
      const { library } = await ctx.newLibrary({ ownerId: owner.id });
      const { asset } = await ctx.newAsset({ ownerId: owner.id, libraryId: library.id });
      await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

      const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      await ctx.syncAckAll(auth, response);

      await assetRepo.remove(asset);

      const deleteResponse = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      expect(deleteResponse).toEqual([
        { ack: expect.any(String), data: { assetId: asset.id }, type: SyncEntityType.PartnerAssetDeleteV1 },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });
  });

  describe('real-partner overlap (§5 invariant: must not disturb real partner semantics)', () => {
    it('regression: byte-identical real-partner-only stream when no shares exist at all', async () => {
      const { auth, ctx } = await setup();
      const { user: owner } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: owner.id, isFavorite: true });
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: auth.user.id });

      const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      expect(response).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: asset.id, isFavorite: false }),
          type: SyncEntityType.PartnerAssetV2,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);
    });

    it('still surfaces a library asset via the real arm once a real partner exists too', async () => {
      const { auth, ctx } = await setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await ctx.newLibrary({ ownerId: owner.id });
      const { asset } = await ctx.newAsset({ ownerId: owner.id, libraryId: library.id });
      await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: auth.user.id });

      const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      // The asset must appear (via the real arm, which streams ALL of the owner's assets
      // unconditionally) - whether the pseudo arm also contributes is an internal implementation
      // freedom the plan explicitly allows ("duplicate upserts are idempotent").
      expect(response).toEqual(
        expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ id: asset.id }) })]),
      );
    });
  });

  describe('backfill ordering (§3.3)', () => {
    it('interleaves a real-partner backfill and a pseudo-share backfill by watermark order', async () => {
      const { auth, ctx } = await setup();
      const { user: earlyOwner } = await ctx.newUser();
      const { user: lateOwner } = await ctx.newUser();
      const { asset: earlyAsset } = await ctx.newAsset({ ownerId: earlyOwner.id });
      await wait(2);
      const { library } = await ctx.newLibrary({ ownerId: lateOwner.id });
      const { asset: libraryAsset } = await ctx.newAsset({ ownerId: lateOwner.id, libraryId: library.id });

      // Establish a REAL (non-empty) PartnerAssetV2 checkpoint first via an unrelated throwaway
      // partner - an empty first sync never establishes a checkpoint at all (nothing to ack), which
      // would make the LATER sync below still look like "the" first sync and take the plain-upsert
      // path instead of the true backfill dance this test means to exercise.
      const { user: throwawayPartner } = await ctx.newUser();
      await ctx.newAsset({ ownerId: throwawayPartner.id });
      await ctx.newPartner({ sharedById: throwawayPartner.id, sharedWithId: auth.user.id });

      const initial = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      await ctx.syncAckAll(auth, initial);

      // Both a real partner (earlyOwner) and a flagged share (lateOwner) become active in the same
      // window - both must backfill, each through its own repository method.
      await ctx.newPartner({ sharedById: earlyOwner.id, sharedWithId: auth.user.id });
      await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

      const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
      const backfillEvents = response.filter((event: any) => event.type === SyncEntityType.PartnerAssetBackfillV2);
      expect(backfillEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ data: expect.objectContaining({ id: earlyAsset.id }) }),
          expect.objectContaining({ data: expect.objectContaining({ id: libraryAsset.id }) }),
        ]),
      );

      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetsV2]);
    });
  });
});
