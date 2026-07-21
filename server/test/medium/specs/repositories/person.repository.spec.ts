import { Kysely } from 'kysely';
import { AssetFileType, AssetVisibility, LibraryUserRole, SourceType } from 'src/enum';
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

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(PersonRepository.name, () => {
  describe('deleteFaces', () => {
    it('should not delete video-frame faces', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { assetFace: previewFace } = await ctx.newAssetFace({ assetId: asset.id });
      const { assetFace: videoFace } = await ctx.newAssetFace({ assetId: asset.id, timestampMs: 4000 });

      await sut.deleteFaces({ sourceType: SourceType.MachineLearning });

      const remaining = await ctx.database.selectFrom('asset_face').select(['id']).execute();
      expect(remaining.map((face) => face.id)).not.toContain(previewFace.id);
      expect(remaining.map((face) => face.id)).toContain(videoFace.id);
    });
  });

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

    it('should exclude video-frame faces, whose bounding boxes are frame-relative', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { assetFace: previewFace } = await ctx.newAssetFace({ assetId: asset.id });
      await ctx.newAssetFace({ assetId: asset.id, timestampMs: 4000 });

      const result = await sut.getFacesForLibraryAsset(library.id, asset.id);

      expect(result.map((face) => face.id)).toEqual([previewFace.id]);
    });
  });

  describe('getEditorRenameLibraryId', () => {
    it('should return the library for an Editor when the person is exclusive to it', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: editor } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, { libraryId: library.id, userId: editor.id, role: LibraryUserRole.Editor });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.getEditorRenameLibraryId(editor.id, person.id)).resolves.toBe(library.id);
    });

    it('should return null for a Viewer share', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, { libraryId: library.id, userId: viewer.id, role: LibraryUserRole.Viewer });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.getEditorRenameLibraryId(viewer.id, person.id)).resolves.toBeNull();
    });

    it('should return null when the person also has a face outside the library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: editor } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, { libraryId: library.id, userId: editor.id, role: LibraryUserRole.Editor });
      const { asset: inLibrary } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset: outside } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: inLibrary.id, personId: person.id });
      await ctx.newAssetFace({ assetId: outside.id, personId: person.id });

      await expect(sut.getEditorRenameLibraryId(editor.id, person.id)).resolves.toBeNull();
    });
  });

  describe('getAllForSharedLibraries (Phase 5)', () => {
    it('should return empty when no shared library ids are given', async () => {
      const { sut } = setup();
      await expect(sut.getAllForSharedLibraries([], { take: 500, skip: 0 }, 3)).resolves.toEqual({
        items: [],
        hasNextPage: false,
      });
    });

    it('should exclude a hidden person', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id, isHidden: true, name: 'Hidden Person' });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      const result = await sut.getAllForSharedLibraries([library.id], { take: 500, skip: 0 }, 3);
      expect(result.items).toEqual([]);
    });

    it('should count minimumFaces using ONLY in-shared-library faces', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: inLibrary } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      // Three more faces on assets OUTSIDE the shared library - must not count toward minimumFaces.
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: '' });
      await ctx.newAssetFace({ assetId: inLibrary.id, personId: person.id });
      for (let i = 0; i < 3; i++) {
        const { asset: outside } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
        await ctx.newAssetFace({ assetId: outside.id, personId: person.id });
      }

      const result = await sut.getAllForSharedLibraries([library.id], { take: 500, skip: 0 }, 3);
      // Only 1 in-library face and an empty name - below the minimumFaces=3 threshold, so excluded
      // even though the person has 4 faces globally.
      expect(result.items.map((p) => p.id)).not.toContain(person.id);
    });

    it('should include a named person with just one in-library face regardless of minimumFaces', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Named Person' });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      const result = await sut.getAllForSharedLibraries([library.id], { take: 500, skip: 0 }, 3);
      expect(result.items.map((p) => p.id)).toEqual([person.id]);
    });

    it('should count video-frame faces toward minimumFaces, matching owner-side counting', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: '' });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id, timestampMs: 2000 });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id, timestampMs: 4000 });

      const result = await sut.getAllForSharedLibraries([library.id], { take: 500, skip: 0 }, 3);
      expect(result.items.map((p) => p.id)).toEqual([person.id]);
    });
  });

  describe('getByNameWithSharedLibraries (Phase 5)', () => {
    it("should find the caller's own person by name", async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Alice Smith' });

      const result = await sut.getByNameWithSharedLibraries(owner.id, [], 'Alice', { withHidden: false });
      expect(result.map((p) => p.id)).toEqual([person.id]);
    });

    it('should find a person reachable via a shared library, excluding hidden persons', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: sharee } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person: visible } = await ctx.newPerson({ ownerId: owner.id, name: 'Bob Jones' });
      const { person: hidden } = await ctx.newPerson({ ownerId: owner.id, name: 'Bobby Hidden', isHidden: true });
      await ctx.newAssetFace({ assetId: asset.id, personId: visible.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: hidden.id });

      const result = await sut.getByNameWithSharedLibraries(sharee.id, [library.id], 'Bob', { withHidden: false });
      expect(result.map((p) => p.id)).toEqual([visible.id]);
    });

    it('should not find a stranger person with no shared library at all', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      await ctx.newPerson({ ownerId: owner.id, name: 'Charlie Brown' });

      const result = await sut.getByNameWithSharedLibraries(stranger.id, [], 'Charlie', { withHidden: false });
      expect(result).toEqual([]);
    });
  });

  describe('isFeatureFaceInSharedLibrary (Phase 5)', () => {
    it('should return true when the feature face is on an inTimeline-shared-library asset', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: sharee } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, {
        libraryId: library.id,
        userId: sharee.id,
        role: LibraryUserRole.Viewer,
        inTimeline: true,
      });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.isFeatureFaceInSharedLibrary(sharee.id, assetFace.id)).resolves.toBe(true);
    });

    it('should return false when the feature face is on an asset from an UNSHARED library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: sharee } = await ctx.newUser();
      const { library: sharedLibrary } = await newLibrary(ctx, { ownerId: owner.id });
      const { library: otherLibrary } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, {
        libraryId: sharedLibrary.id,
        userId: sharee.id,
        role: LibraryUserRole.Viewer,
        inTimeline: true,
      });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: otherLibrary.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.isFeatureFaceInSharedLibrary(sharee.id, assetFace.id)).resolves.toBe(false);
    });

    it('should return false when inTimeline=false even though the library is shared', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: sharee } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, {
        libraryId: library.id,
        userId: sharee.id,
        role: LibraryUserRole.Viewer,
        inTimeline: false,
      });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.isFeatureFaceInSharedLibrary(sharee.id, assetFace.id)).resolves.toBe(false);
    });

    // Review finding (plan §5.3): never serve the crop of a person the owner has hidden.
    it('should return false when the person is hidden, even on a fully shared asset', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: sharee } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, {
        libraryId: library.id,
        userId: sharee.id,
        role: LibraryUserRole.Viewer,
        inTimeline: true,
      });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id, isHidden: true });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.isFeatureFaceInSharedLibrary(sharee.id, assetFace.id)).resolves.toBe(false);

      // sanity check: un-hiding restores the gate, proving isHidden was the only blocker
      await ctx.database.updateTable('person').set({ isHidden: false }).where('id', '=', person.id).execute();
      await expect(sut.isFeatureFaceInSharedLibrary(sharee.id, assetFace.id)).resolves.toBe(true);
    });
  });
});
