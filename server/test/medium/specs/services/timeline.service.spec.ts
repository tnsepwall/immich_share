import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AssetVisibility, LibraryUserRole, SharedLinkType } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { LibraryRepository } from 'src/repositories/library.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository';
import { DB } from 'src/schema';
import { TimelineService } from 'src/services/timeline.service';
import { MediumTestContext, newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(TimelineService, {
    database: db || defaultDatabase,
    real: [AssetRepository, AccessRepository, PartnerRepository, LibraryRepository],
    mock: [LoggingRepository],
  });
};

const newLibrary = async (ctx: MediumTestContext, dto: { ownerId: string }) => {
  const library = {
    id: factory.uuid(),
    name: 'Library',
    ownerId: dto.ownerId,
    importPaths: [],
    exclusionPatterns: [],
  };
  await ctx.database.insertInto('library').values(library).execute();
  return { library };
};

const newLibraryUser = async (
  ctx: MediumTestContext,
  dto: { libraryId: string; userId: string; role: LibraryUserRole; inTimeline?: boolean },
) => {
  await ctx.database
    .insertInto('library_user')
    .values({ inTimeline: false, ...dto })
    .execute();
  return { libraryUser: dto };
};

const setupShare = async (ctx: MediumTestContext, opts: { inTimeline: boolean }) => {
  const { user: owner } = await ctx.newUser();
  const { user: sharee } = await ctx.newUser();
  const { library } = await newLibrary(ctx, { ownerId: owner.id });
  await newLibraryUser(ctx, {
    libraryId: library.id,
    userId: sharee.id,
    role: LibraryUserRole.Viewer,
    inTimeline: opts.inTimeline,
  });
  return { owner, sharee, library };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(TimelineService.name, () => {
  describe('getTimeBuckets', () => {
    it('should get time buckets by month', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const dates = [new Date('1970-01-01'), new Date('1970-02-10'), new Date('1970-02-11'), new Date('1970-02-11')];
      for (const localDateTime of dates) {
        const { asset } = await ctx.newAsset({ ownerId: user.id, localDateTime });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      }

      const response = sut.getTimeBuckets(auth, {});
      await expect(response).resolves.toEqual([
        { count: 3, timeBucket: '1970-02-01' },
        { count: 1, timeBucket: '1970-01-01' },
      ]);
    });

    it('should return error if time bucket is requested with partners asset and archived', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response1 = sut.getTimeBuckets(auth, { withPartners: true, visibility: AssetVisibility.Archive });
      await expect(response1).rejects.toBeInstanceOf(BadRequestException);
      await expect(response1).rejects.toThrow(
        'withPartners/withSharedLibraries is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );

      const response2 = sut.getTimeBuckets(auth, { withPartners: true });
      await expect(response2).rejects.toBeInstanceOf(BadRequestException);
      await expect(response2).rejects.toThrow(
        'withPartners/withSharedLibraries is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
    });

    it('should return error if time bucket is requested with partners asset and favorite', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response1 = sut.getTimeBuckets(auth, { withPartners: true, isFavorite: false });
      await expect(response1).rejects.toBeInstanceOf(BadRequestException);
      await expect(response1).rejects.toThrow(
        'withPartners/withSharedLibraries is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );

      const response2 = sut.getTimeBuckets(auth, { withPartners: true, isFavorite: true });
      await expect(response2).rejects.toBeInstanceOf(BadRequestException);
      await expect(response2).rejects.toThrow(
        'withPartners/withSharedLibraries is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
    });

    it('should return error if time bucket is requested with partners asset and trash', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response = sut.getTimeBuckets(auth, { withPartners: true, isTrashed: true });
      await expect(response).rejects.toBeInstanceOf(BadRequestException);
      await expect(response).rejects.toThrow(
        'withPartners/withSharedLibraries is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
    });

    it('should return error if time bucket is requested with locked visibility for partner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      const auth = factory.auth({ user, session: { hasElevatedPermission: true } });

      const response = sut.getTimeBuckets(auth, { userId: partner.id, visibility: AssetVisibility.Locked });
      await expect(response).rejects.toThrow("You may not access another user's locked timeline");
    });

    it('should not allow access for unrelated shared links', async () => {
      const { sut } = setup();
      const auth = factory.auth({ sharedLink: {} });
      const response = sut.getTimeBuckets(auth, {});
      await expect(response).rejects.toBeInstanceOf(BadRequestException);
      await expect(response).rejects.toThrow('Not found or no timeline.read access');
    });
  });

  describe('getTimeBucket', () => {
    it('should return time bucket', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        localDateTime: new Date('1970-02-12'),
        deletedAt: new Date(),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      const auth = factory.auth({ user: { id: user.id } });
      const rawResponse = await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', isTrashed: true });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ isTrashed: [true] }));
    });

    it('should handle a bucket without any assets', async () => {
      const { sut } = setup();
      const rawResponse = await sut.getTimeBucket(factory.auth(), { timeBucket: '1970-02-01' });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual({
        city: [],
        country: [],
        createdAt: [],
        duration: [],
        id: [],
        visibility: [],
        isFavorite: [],
        isImage: [],
        isTrashed: [],
        livePhotoVideoId: [],
        fileCreatedAt: [],
        localOffsetHours: [],
        ownerId: [],
        projectionType: [],
        ratio: [],
        status: [],
        thumbhash: [],
      });
    });

    it('should handle 5 digit years', async () => {
      const { sut } = setup();
      const rawResponse = await sut.getTimeBucket(factory.auth(), { timeBucket: '012345-01-01' });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ id: [] }));
    });

    it('should return time bucket in trash', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        localDateTime: new Date('1970-02-12'),
        deletedAt: new Date(),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      const auth = factory.auth({ user: { id: user.id } });
      const rawResponse = await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', isTrashed: true });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ isTrashed: [true] }));
    });

    it('should return false for favorite status unless asset owner', async () => {
      const { sut, ctx } = setup();
      const [{ asset: asset1 }, { asset: asset2 }] = await Promise.all([
        ctx.newUser().then(async ({ user }) => {
          const result = await ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('1970-02-12'),
            localDateTime: new Date('1970-02-12'),
            isFavorite: true,
          });
          await ctx.newExif({ assetId: result.asset.id, make: 'Canon' });
          return result;
        }),

        ctx.newUser().then(async ({ user }) => {
          const result = await ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('1970-02-13'),
            localDateTime: new Date('1970-02-13'),
            isFavorite: true,
          });
          await ctx.newExif({ assetId: result.asset.id, make: 'Canon' });
          return result;
        }),
      ]);

      await Promise.all([
        ctx.newPartner({ sharedById: asset1.ownerId, sharedWithId: asset2.ownerId }),
        ctx.newPartner({ sharedById: asset2.ownerId, sharedWithId: asset1.ownerId }),
      ]);

      const auth1 = factory.auth({ user: { id: asset1.ownerId } });
      const rawResponse1 = await sut.getTimeBucket(auth1, {
        timeBucket: '1970-02-01',
        withPartners: true,
        visibility: AssetVisibility.Timeline,
      });
      const response1 = JSON.parse(rawResponse1);
      expect(response1).toEqual(expect.objectContaining({ id: [asset2.id, asset1.id], isFavorite: [false, true] }));

      const auth2 = factory.auth({ user: { id: asset2.ownerId } });
      const rawResponse2 = await sut.getTimeBucket(auth2, {
        timeBucket: '1970-02-01',
        withPartners: true,
        visibility: AssetVisibility.Timeline,
      });
      const response2 = JSON.parse(rawResponse2);
      expect(response2).toEqual(expect.objectContaining({ id: [asset2.id, asset1.id], isFavorite: [true, false] }));
    });
  });

  it('should strip geodata metadata if shared link without exif', async () => {
    const { sut, ctx } = setup();
    const sharedLinkRepo = ctx.get(SharedLinkRepository);

    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      localDateTime: new Date('1970-02-12'),
      deletedAt: new Date(),
    });
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

    const { id: sharedLinkId } = await sharedLinkRepo.create({
      allowUpload: false,
      key: Buffer.from('123'),
      type: SharedLinkType.Album,
      userId: user.id,
      albumId: album.id,
    });

    await ctx.newExif({ assetId: asset.id, city: 'Austin', country: 'USA' });
    const auth = factory.auth({ sharedLink: { id: sharedLinkId, showExif: false } });
    const rawResponse = await sut.getTimeBucket(auth, { albumId: album.id, timeBucket: '1970-02-01', isTrashed: true });
    const response = JSON.parse(rawResponse);
    expect(response).not.toEqual(expect.objectContaining({ city: expect.any(Array), country: expect.any(Array) }));
  });

  describe('withSharedLibraries (Phase 5, real Postgres)', () => {
    it('should include a shared-library asset in the main timeline only when inTimeline=true', async () => {
      const { sut, ctx } = setup();
      const { sharee, library } = await setupShare(ctx, { inTimeline: true });
      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
        localDateTime: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const auth = factory.auth({ user: { id: sharee.id } });
      const rawResponse = await sut.getTimeBucket(auth, {
        timeBucket: '1970-02-01',
        visibility: AssetVisibility.Timeline,
        withSharedLibraries: true,
      });
      const response = JSON.parse(rawResponse);
      expect(response.id).toEqual([asset.id]);
      // The owner's identity must never leak into the sharee's own-favorite computation.
      expect(response.ownerId).toEqual([library.ownerId]);
    });

    it('should exclude a shared-library asset from the main timeline when inTimeline=false', async () => {
      const { sut, ctx } = setup();
      const { sharee, library } = await setupShare(ctx, { inTimeline: false });
      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
        localDateTime: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const auth = factory.auth({ user: { id: sharee.id } });
      const rawResponse = await sut.getTimeBucket(auth, {
        timeBucket: '1970-02-01',
        visibility: AssetVisibility.Timeline,
        withSharedLibraries: true,
      });
      const response = JSON.parse(rawResponse);
      expect(response.id).toEqual([]);
    });

    it('should never include the owner archived/trashed/other-library assets via the shared arm', async () => {
      const { sut, ctx } = setup();
      const { owner, sharee, library } = await setupShare(ctx, { inTimeline: true });
      const { library: otherLibrary } = await newLibrary(ctx, { ownerId: owner.id });

      const { asset: archived } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Archive,
        localDateTime: new Date('1970-02-12'),
      });
      const { asset: trashed } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
        deletedAt: new Date(),
        localDateTime: new Date('1970-02-12'),
      });
      const { asset: otherLibraryAsset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: otherLibrary.id,
        visibility: AssetVisibility.Timeline,
        localDateTime: new Date('1970-02-12'),
      });
      const { asset: ownerPrivateAsset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: null,
        visibility: AssetVisibility.Timeline,
        localDateTime: new Date('1970-02-12'),
      });
      for (const asset of [archived, trashed, otherLibraryAsset, ownerPrivateAsset]) {
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      }

      const auth = factory.auth({ user: { id: sharee.id } });
      const rawResponse = await sut.getTimeBucket(auth, {
        timeBucket: '1970-02-01',
        visibility: AssetVisibility.Timeline,
        withSharedLibraries: true,
      });
      const response = JSON.parse(rawResponse);
      expect(response.id).toEqual([]);
    });

    it('should keep bucket counts (getTimeBuckets) and bucket assets (getTimeBucket) predicate-identical', async () => {
      const { sut, ctx } = setup();
      const { sharee, library } = await setupShare(ctx, { inTimeline: true });
      const { asset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
        localDateTime: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const auth = factory.auth({ user: { id: sharee.id } });
      const buckets = await sut.getTimeBuckets(auth, {
        visibility: AssetVisibility.Timeline,
        withSharedLibraries: true,
      });
      const rawBucket = await sut.getTimeBucket(auth, {
        timeBucket: '1970-02-01',
        visibility: AssetVisibility.Timeline,
        withSharedLibraries: true,
      });
      const bucket = JSON.parse(rawBucket);

      expect(buckets).toEqual([{ count: 1, timeBucket: '1970-02-01' }]);
      expect(bucket.id).toEqual([asset.id]);
    });

    it('should never surface stack info for a shared-library asset', async () => {
      const { sut, ctx } = setup();
      const { owner, sharee, library } = await setupShare(ctx, { inTimeline: true });
      const { asset: primary } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
        localDateTime: new Date('1970-02-12'),
      });
      const { asset: secondary } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
        localDateTime: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: primary.id, make: 'Canon' });
      await ctx.newExif({ assetId: secondary.id, make: 'Canon' });
      await ctx.newStack({ ownerId: owner.id }, [primary.id, secondary.id]);

      const auth = factory.auth({ user: { id: sharee.id } });
      const rawResponse = await sut.getTimeBucket(auth, {
        timeBucket: '1970-02-01',
        visibility: AssetVisibility.Timeline,
        withSharedLibraries: true,
        withStacked: true,
      });
      const response = JSON.parse(rawResponse);
      // Both members appear individually (never collapsed) and neither carries a stack tuple - the
      // `stack` array is present (withStacked=true always selects it) but every entry is null.
      expect(response.id.toSorted()).toEqual([primary.id, secondary.id].toSorted());
      expect(response.stack).toEqual([null, null]);
    });

    // Review finding: uploaded assets have libraryId IS NULL, and the shared-arm lateral guard used a
    // bare NOT IN - SQL NULL for those rows - which silently dropped the caller's OWN uploaded-asset
    // stack tuples the moment they had any inTimeline shared library.
    it('should keep the sharee own uploaded-asset stacks intact when a shared library is in the timeline', async () => {
      const { sut, ctx } = setup();
      const { sharee, library } = await setupShare(ctx, { inTimeline: true });
      const { asset: sharedAsset } = await ctx.newAsset({
        ownerId: library.ownerId,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
        localDateTime: new Date('1970-02-12'),
      });
      // the sharee's own UPLOADED (libraryId = null) stacked assets
      const { asset: primary } = await ctx.newAsset({
        ownerId: sharee.id,
        libraryId: null,
        visibility: AssetVisibility.Timeline,
        localDateTime: new Date('1970-02-12'),
      });
      const { asset: secondary } = await ctx.newAsset({
        ownerId: sharee.id,
        libraryId: null,
        visibility: AssetVisibility.Timeline,
        localDateTime: new Date('1970-02-12'),
      });
      for (const asset of [sharedAsset, primary, secondary]) {
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      }
      const { stack } = await ctx.newStack({ ownerId: sharee.id }, [primary.id, secondary.id]);

      const auth = factory.auth({ user: { id: sharee.id } });

      // bucket counts: the non-primary member stays collapsed (2 rows: shared asset + stack primary)
      const buckets = await sut.getTimeBuckets(auth, {
        visibility: AssetVisibility.Timeline,
        withSharedLibraries: true,
        withStacked: true,
      });
      expect(buckets).toEqual([{ count: 2, timeBucket: '1970-02-01' }]);

      // bucket assets: the primary must still carry its stack tuple [stackId, memberCount]
      const rawResponse = await sut.getTimeBucket(auth, {
        timeBucket: '1970-02-01',
        visibility: AssetVisibility.Timeline,
        withSharedLibraries: true,
        withStacked: true,
      });
      const response = JSON.parse(rawResponse);
      expect(response.id.toSorted()).toEqual([sharedAsset.id, primary.id].toSorted());
      const primaryIndex = response.id.indexOf(primary.id);
      const sharedIndex = response.id.indexOf(sharedAsset.id);
      expect(response.stack[primaryIndex]).toEqual([stack.id, '2']);
      expect(response.stack[sharedIndex]).toBeNull();
    });

    // Plan §5.9 verification (review finding): a sharee opening a shared person must see the shared
    // assets containing that person - personId filter combined with withSharedLibraries.
    it('should surface shared assets for a shared person via the personId filter', async () => {
      const { sut, ctx } = setup();
      const { owner, sharee, library } = await setupShare(ctx, { inTimeline: true });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
        localDateTime: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      const auth = factory.auth({ user: { id: sharee.id } });
      const rawResponse = await sut.getTimeBucket(auth, {
        timeBucket: '1970-02-01',
        visibility: AssetVisibility.Timeline,
        withSharedLibraries: true,
        personId: person.id,
      });
      const response = JSON.parse(rawResponse);
      expect(response.id).toEqual([asset.id]);
    });

    it('should redact livePhotoVideoId for a shared-library asset', async () => {
      const { sut, ctx } = setup();
      const { owner, sharee, library } = await setupShare(ctx, { inTimeline: true });
      const { asset: motion } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Hidden,
        localDateTime: new Date('1970-02-12'),
      });
      const { asset: still } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
        livePhotoVideoId: motion.id,
        localDateTime: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: still.id, make: 'Canon' });

      const auth = factory.auth({ user: { id: sharee.id } });
      const rawResponse = await sut.getTimeBucket(auth, {
        timeBucket: '1970-02-01',
        visibility: AssetVisibility.Timeline,
        withSharedLibraries: true,
      });
      const response = JSON.parse(rawResponse);
      expect(response.id).toEqual([still.id]);
      expect(response.livePhotoVideoId).toEqual([null]);
    });
  });
});
