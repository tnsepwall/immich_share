import { Kysely } from 'kysely';
import { SearchSuggestionType } from 'src/dtos/search.dto';
import { AlbumUserRole, AssetVisibility, LibraryUserRole } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { LibraryRepository } from 'src/repositories/library.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { SearchRepository } from 'src/repositories/search.repository';
import { DB } from 'src/schema';
import { SearchService } from 'src/services/search.service';
import { MediumTestContext, newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(SearchService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AssetRepository,
      DatabaseRepository,
      SearchRepository,
      PartnerRepository,
      PersonRepository,
      // Phase 5: SearchService now resolves the caller's inTimeline-shared library ids on every
      // search call - real (not mocked) so this exercises the actual query against the test DB,
      // which naturally returns [] for these pre-Phase-5 tests' users (no shares created).
      LibraryRepository,
    ],
    mock: [LoggingRepository],
  });
};

const setupShare = async (ctx: MediumTestContext, opts: { inTimeline: boolean }) => {
  const { user: owner } = await ctx.newUser();
  const { user: sharee } = await ctx.newUser();
  const library = {
    id: factory.uuid(),
    name: 'Library',
    ownerId: owner.id,
    importPaths: [],
    exclusionPatterns: [],
  };
  await ctx.database.insertInto('library').values(library).execute();
  await ctx.database
    .insertInto('library_user')
    .values({ libraryId: library.id, userId: sharee.id, role: LibraryUserRole.Viewer, inTimeline: opts.inTimeline })
    .execute();
  return { owner, sharee, library };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SearchService.name, () => {
  it('should work', () => {
    const { sut } = setup();
    expect(sut).toBeDefined();
  });

  it('should return assets', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();

    const assets = [];
    const sizes = [12_334, 599, 123_456];

    for (let i = 0; i < sizes.length; i++) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: sizes[i] });
      assets.push(asset);
    }

    const auth = factory.auth({ user: { id: user.id } });

    await expect(sut.searchLargeAssets(auth, {})).resolves.toEqual([
      expect.objectContaining({ id: assets[2].id }),
      expect.objectContaining({ id: assets[0].id }),
      expect.objectContaining({ id: assets[1].id }),
    ]);
  });

  describe('searchStatistics', () => {
    it('should return statistics when filtering by personIds', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      const auth = factory.auth({ user: { id: user.id } });

      const result = await sut.searchStatistics(auth, { personIds: [person.id] });

      expect(result).toEqual({ total: 1 });
    });

    it('should return zero when no assets match the personIds filter', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });

      const auth = factory.auth({ user: { id: user.id } });

      const result = await sut.searchStatistics(auth, { personIds: [person.id] });

      expect(result).toEqual({ total: 0 });
    });
  });

  describe('withStacked option', () => {
    it('should exclude stacked assets when withStacked is false', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const { asset: primaryAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: stackedAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unstackedAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newStack({ ownerId: user.id }, [primaryAsset.id, stackedAsset.id]);

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchMetadata(auth, { withStacked: false });

      expect(response.assets.items.length).toBe(1);
      expect(response.assets.items[0].id).toBe(unstackedAsset.id);
    });

    describe('visibility', () => {
      it('should filter out locked assets in a default session', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();

        await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

        const auth = factory.auth({ user: { id: user.id } });

        const response = await sut.searchMetadata(auth, { withStacked: false });

        expect(response.assets.items.length).toBe(0);
      });

      it('should return locked assets in an elevated session', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();

        await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

        const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

        const response = await sut.searchMetadata(auth, { withStacked: false });

        expect(response.assets.items.length).toBe(1);
      });
    });
  });

  describe('albumIds option', () => {
    it('should return assets from shared album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: user.id, role: AlbumUserRole.Editor });

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchMetadata(auth, { albumIds: [album.id] });

      expect(response.assets.items.length).toBe(1);
    });

    it('should not return assets for album, a user is not in, when partner sharing is enabled', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      await ctx.newPartner({ sharedById: otherUser.id, sharedWithId: user.id });

      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });

      await expect(sut.searchMetadata(auth, { albumIds: [album.id] })).rejects.toThrow(
        'Not found or no album.read access',
      );
    });
  });

  describe('getSearchSuggestions', () => {
    it('should filter out empty search suggestions', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const { asset: assetWithEmptyMake } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: assetWithEmptyMake.id, make: '' });

      const auth = factory.auth({ user: { id: user.id } });
      const suggestions = await sut.getSearchSuggestions(auth, {
        type: SearchSuggestionType.CAMERA_MAKE,
        includeNull: true,
      });

      expect(suggestions).toEqual(['Canon', null]);
    });
  });

  describe('shared libraries (Phase 5, real Postgres)', () => {
    it('should include a shared-library asset in metadata search only when inTimeline=true', async () => {
      const { sut, ctx } = setup();
      const { owner, sharee, library } = await setupShare(ctx, { inTimeline: true });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const auth = factory.auth({ user: { id: sharee.id } });
      const response = await sut.searchMetadata(auth, {});
      expect(response.assets.items.map((item) => item.id)).toEqual([asset.id]);
    });

    it('should exclude a shared-library asset from metadata search when inTimeline=false', async () => {
      const { sut, ctx } = setup();
      const { owner, sharee, library } = await setupShare(ctx, { inTimeline: false });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const auth = factory.auth({ user: { id: sharee.id } });
      const response = await sut.searchMetadata(auth, {});
      expect(response.assets.items).toEqual([]);
    });

    it('should never resolve shared library ids for Locked visibility', async () => {
      const { sut, ctx } = setup();
      const { owner, sharee, library } = await setupShare(ctx, { inTimeline: true });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const auth = factory.auth({ user: { id: sharee.id }, session: { hasElevatedPermission: true } });
      const response = await sut.searchMetadata(auth, { visibility: AssetVisibility.Locked });
      expect(response.assets.items).toEqual([]);
    });

    it.each([{ isFavorite: true }, { originalPath: '/etc/passwd' }, { checksum: 'aa'.repeat(20) }])(
      'should drop the shared arm for a probe-prone filter: %j',
      async (filter) => {
        const { sut, ctx } = setup();
        const { owner, sharee, library } = await setupShare(ctx, { inTimeline: true });
        const { asset } = await ctx.newAsset({
          ownerId: owner.id,
          libraryId: library.id,
          visibility: AssetVisibility.Timeline,
        });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });

        const auth = factory.auth({ user: { id: sharee.id } });
        const response = await sut.searchMetadata(auth, filter as any);
        // The shared-library asset must never appear when probing on an owner-only field.
        expect(response.assets.items.map((item) => item.id)).not.toContain(asset.id);
      },
    );

    it('should reject a personId the caller cannot read even though shared assets are in scope', async () => {
      const { sut, ctx } = setup();
      const { owner, sharee } = await setupShare(ctx, { inTimeline: true });
      const { person: strangerPerson } = await ctx.newPerson({ ownerId: owner.id });

      const auth = factory.auth({ user: { id: sharee.id } });
      await expect(sut.searchMetadata(auth, { personIds: [strangerPerson.id] })).rejects.toThrow(
        'Not found or no person.read access',
      );
    });
  });
});
