import { Kysely } from 'kysely';
import { AssetFileType, AssetVisibility } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { DB } from 'src/schema';
import { BaseService } from 'src/services/base.service';
import { MediumTestContext, newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(PersonRepository) };
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

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(PersonRepository.name, () => {
  describe('getDataForThumbnailGenerationJob', () => {
    it('should not return the edited preview path', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });

      const { assetFace } = await ctx.newAssetFace({
        assetId: asset.id,
        personId: person.id,
        boundingBoxX1: 10,
        boundingBoxY1: 10,
        boundingBoxX2: 90,
        boundingBoxY2: 90,
      });

      // theres a circular dependency between assetFace and person, so we need to update the person after creating the assetFace
      await ctx.database.updateTable('person').set({ faceAssetId: assetFace.id }).where('id', '=', person.id).execute();

      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_edited.jpg',
        isEdited: true,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_unedited.jpg',
        isEdited: false,
      });

      const result = await sut.getDataForThumbnailGenerationJob(person.id);

      expect(result).toEqual(
        expect.objectContaining({
          previewPath: 'preview_unedited.jpg',
        }),
      );
    });
  });

  describe('getAllForLibrary', () => {
    it('should return a person with a visible in-library face and its thumbnail bounding box', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Alice' });
      const { assetFace } = await ctx.newAssetFace({
        assetId: asset.id,
        personId: person.id,
        boundingBoxX1: 1,
        boundingBoxY1: 2,
        boundingBoxX2: 3,
        boundingBoxY2: 4,
        imageWidth: 100,
        imageHeight: 200,
      });

      const result = await sut.getAllForLibrary(library.id, { take: 500 });

      expect(result).toEqual({
        hasNextPage: false,
        items: [
          {
            id: person.id,
            name: 'Alice',
            thumbnailFace: {
              faceId: assetFace.id,
              assetId: asset.id,
              boundingBoxX1: 1,
              boundingBoxY1: 2,
              boundingBoxX2: 3,
              boundingBoxY2: 4,
              imageWidth: 100,
              imageHeight: 200,
            },
          },
        ],
      });
    });

    it('should exclude a person whose only faces are outside this library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.getAllForLibrary(library.id, { take: 500 })).resolves.toEqual({
        hasNextPage: false,
        items: [],
      });
    });

    it('should order people alphabetically by name, with blank names last', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person: blank } = await ctx.newPerson({ ownerId: owner.id, name: '' });
      const { person: zed } = await ctx.newPerson({ ownerId: owner.id, name: 'Zed' });
      const { person: alice } = await ctx.newPerson({ ownerId: owner.id, name: 'Alice' });
      await ctx.newAssetFace({ assetId: asset.id, personId: blank.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: zed.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: alice.id });

      const { items } = await sut.getAllForLibrary(library.id, { take: 500 });

      expect(items.map((p) => p.id)).toEqual([alice.id, zed.id, blank.id]);
    });

    it('should paginate results and report hasNextPage', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person: alice } = await ctx.newPerson({ ownerId: owner.id, name: 'Alice' });
      const { person: bob } = await ctx.newPerson({ ownerId: owner.id, name: 'Bob' });
      const { person: cara } = await ctx.newPerson({ ownerId: owner.id, name: 'Cara' });
      await ctx.newAssetFace({ assetId: asset.id, personId: alice.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: bob.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: cara.id });

      const firstPage = await sut.getAllForLibrary(library.id, { take: 2 });
      expect(firstPage.items.map((p) => p.id)).toEqual([alice.id, bob.id]);
      expect(firstPage.hasNextPage).toBe(true);

      const secondPage = await sut.getAllForLibrary(library.id, { take: 2, skip: 2 });
      expect(secondPage.items.map((p) => p.id)).toEqual([cara.id]);
      expect(secondPage.hasNextPage).toBe(false);
    });
  });

  describe('getOneForLibrary', () => {
    it('should return a person reachable through this library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Alice' });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.getOneForLibrary(library.id, person.id)).resolves.toEqual(
        expect.objectContaining({ id: person.id, name: 'Alice' }),
      );
    });

    it('should return undefined for a person not reachable through this library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { person } = await ctx.newPerson({ ownerId: owner.id });

      await expect(sut.getOneForLibrary(library.id, person.id)).resolves.toBeUndefined();
    });
  });

  describe('getFacesForLibraryAsset', () => {
    it('should return faces on an in-library asset with their minimal person reference', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Alice' });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      const result = await sut.getFacesForLibraryAsset(library.id, asset.id);

      expect(result).toEqual([
        expect.objectContaining({
          id: assetFace.id,
          assetId: asset.id,
          person: { id: person.id, name: 'Alice' },
        }),
      ]);
    });

    it('should return an empty array for an asset outside this library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      await ctx.newAssetFace({ assetId: asset.id });

      await expect(sut.getFacesForLibraryAsset(library.id, asset.id)).resolves.toEqual([]);
    });

    it('should return an unassigned face with a null person', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      await ctx.newAssetFace({ assetId: asset.id });

      const result = await sut.getFacesForLibraryAsset(library.id, asset.id);

      expect(result).toEqual([expect.objectContaining({ person: null })]);
    });
  });
});
