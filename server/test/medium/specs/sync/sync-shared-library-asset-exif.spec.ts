import { Kysely } from 'kysely';
import { SyncEntityType, SyncRequestType } from 'src/enum';
import { DB } from 'src/schema';
import { SyncTestContext } from 'test/medium.factory';
import { getKyselyDB, wait } from 'test/utils';

// Phase 6: EXIF equivalent of sync-shared-library-asset.spec.ts, modeled on
// sync-partner-asset-exif.spec.ts. Rides the existing PartnerAssetExifV1/PartnerAssetExifBackfillV1
// wire types via sync.service.ts#syncPartnerAssetExifsV1.

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SyncRequestType.PartnerAssetExifsV1, () => {
  it('should sync exif for a flagged shared-library asset', async () => {
    const { auth, ctx } = await setup();
    const { user: owner } = await ctx.newUser();
    const { library } = await ctx.newLibrary({ ownerId: owner.id });
    const { asset } = await ctx.newAsset({ ownerId: owner.id, libraryId: library.id });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });
    await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

    // First-ever sync for this session -> plain PartnerAssetExifV1 upsert, not the backfill path (no
    // prior checkpoint exists yet to backfill relative to); the interleaved-backfill spec below
    // exercises PartnerAssetExifBackfillV1 properly.
    const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetExifsV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({ assetId: asset.id, make: 'Canon' }),
        type: SyncEntityType.PartnerAssetExifV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetExifsV1]);
  });

  it('should not sync exif for an asset in an unflagged library', async () => {
    const { auth, ctx } = await setup();
    const { user: owner } = await ctx.newUser();
    const { library } = await ctx.newLibrary({ ownerId: owner.id });
    const { asset } = await ctx.newAsset({ ownerId: owner.id, libraryId: library.id });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });
    await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: false });

    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetExifsV1]);
  });

  it('should backfill exif for a newly flagged share, interleaved with a real partner backfill', async () => {
    const { auth, ctx } = await setup();
    const { user: partnerUser } = await ctx.newUser();
    const { user: owner } = await ctx.newUser();
    const { asset: partnerAsset } = await ctx.newAsset({ ownerId: partnerUser.id });
    await ctx.newExif({ assetId: partnerAsset.id, make: 'PartnerCam' });
    await wait(2);
    const { library } = await ctx.newLibrary({ ownerId: owner.id });
    const { asset: libraryAsset } = await ctx.newAsset({ ownerId: owner.id, libraryId: library.id });
    await ctx.newExif({ assetId: libraryAsset.id, make: 'LibraryCam' });

    // Establish a REAL (non-empty) PartnerAssetExifV1 checkpoint first via an unrelated throwaway
    // partner - only once a checkpoint genuinely exists does a later-added relationship trigger the
    // true PartnerAssetExifBackfillV1 dance rather than the "no-upsert-checkpoint first-sync
    // short-circuit" plain-upsert path (see the comment on the first spec above).
    const { user: throwawayPartner } = await ctx.newUser();
    const { asset: throwawayAsset } = await ctx.newAsset({ ownerId: throwawayPartner.id });
    await ctx.newExif({ assetId: throwawayAsset.id, make: 'Throwaway' });
    await ctx.newPartner({ sharedById: throwawayPartner.id, sharedWithId: auth.user.id });

    const initial = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetExifsV1]);
    await ctx.syncAckAll(auth, initial);

    await ctx.newPartner({ sharedById: partnerUser.id, sharedWithId: auth.user.id });
    await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

    const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetExifsV1]);
    const backfills = response.filter((event: any) => event.type === SyncEntityType.PartnerAssetExifBackfillV1);
    expect(backfills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ assetId: partnerAsset.id }) }),
        expect.objectContaining({ data: expect.objectContaining({ assetId: libraryAsset.id }) }),
      ]),
    );

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetExifsV1]);
  });

  it('regression: byte-identical real-partner-only exif stream when no shares exist at all', async () => {
    const { auth, ctx } = await setup();
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });
    await ctx.newPartner({ sharedById: owner.id, sharedWithId: auth.user.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetExifsV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({ assetId: asset.id, make: 'Canon' }),
        type: SyncEntityType.PartnerAssetExifV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
});
