import { Kysely } from 'kysely';
import { AssetVisibility, LibraryUserRole } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
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
  return { ctx, sut: ctx.get(AccessRepository) };
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

const softDeleteLibrary = async (ctx: MediumTestContext, libraryId: string) => {
  await ctx.database.updateTable('library').set({ deletedAt: new Date() }).where('id', '=', libraryId).execute();
};

const softDeleteUser = async (ctx: MediumTestContext, userId: string) => {
  await ctx.database.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', userId).execute();
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AccessRepository.name, () => {
  describe('library.checkEditorAccess', () => {
    it('should return an empty set for empty input', async () => {
      const { sut } = setup();
      await expect(sut.library.checkEditorAccess(factory.uuid(), new Set())).resolves.toEqual(new Set());
    });

    it('should allow an Editor share', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: editor } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, { libraryId: library.id, userId: editor.id, role: LibraryUserRole.Editor });

      await expect(sut.library.checkEditorAccess(editor.id, new Set([library.id]))).resolves.toEqual(
        new Set([library.id]),
      );
    });

    it('should not allow a Viewer share', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, { libraryId: library.id, userId: viewer.id, role: LibraryUserRole.Viewer });

      await expect(sut.library.checkEditorAccess(viewer.id, new Set([library.id]))).resolves.toEqual(new Set());
    });

    it('should not allow a user without a share', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });

      await expect(sut.library.checkEditorAccess(stranger.id, new Set([library.id]))).resolves.toEqual(new Set());
    });

    it('should not allow the owner through the editor check (owner has no library_user row)', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });

      await expect(sut.library.checkEditorAccess(owner.id, new Set([library.id]))).resolves.toEqual(new Set());
    });

    it('should not allow an Editor share on a soft-deleted library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: editor } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, { libraryId: library.id, userId: editor.id, role: LibraryUserRole.Editor });
      await softDeleteLibrary(ctx, library.id);

      await expect(sut.library.checkEditorAccess(editor.id, new Set([library.id]))).resolves.toEqual(new Set());
    });

    it('should not allow an Editor share when the library owner is soft-deleted', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: editor } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, { libraryId: library.id, userId: editor.id, role: LibraryUserRole.Editor });
      await softDeleteUser(ctx, owner.id);

      await expect(sut.library.checkEditorAccess(editor.id, new Set([library.id]))).resolves.toEqual(new Set());
    });

    it('should only return the requested library ids', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: editor } = await ctx.newUser();
      const { library: library1 } = await newLibrary(ctx, { ownerId: owner.id });
      const { library: library2 } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, { libraryId: library1.id, userId: editor.id, role: LibraryUserRole.Editor });
      await newLibraryUser(ctx, { libraryId: library2.id, userId: editor.id, role: LibraryUserRole.Editor });

      await expect(sut.library.checkEditorAccess(editor.id, new Set([library1.id]))).resolves.toEqual(
        new Set([library1.id]),
      );
    });
  });

  describe('asset.checkLibraryAssetScope', () => {
    it('should return an empty set for empty input', async () => {
      const { sut } = setup();
      await expect(sut.asset.checkLibraryAssetScope(factory.uuid(), new Set())).resolves.toEqual(new Set());
    });

    it('should return timeline assets that belong to the exact library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });

      await expect(sut.asset.checkLibraryAssetScope(library.id, new Set([asset.id]))).resolves.toEqual(
        new Set([asset.id]),
      );
    });

    it('should exclude assets that belong to a different library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library: library1 } = await newLibrary(ctx, { ownerId: owner.id });
      const { library: library2 } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library2.id,
        visibility: AssetVisibility.Timeline,
      });

      await expect(sut.asset.checkLibraryAssetScope(library1.id, new Set([asset.id]))).resolves.toEqual(new Set());
    });

    it('should exclude assets without a library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });

      await expect(sut.asset.checkLibraryAssetScope(library.id, new Set([asset.id]))).resolves.toEqual(new Set());
    });

    it('should exclude trashed assets', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      await ctx.softDeleteAsset(asset.id);

      await expect(sut.asset.checkLibraryAssetScope(library.id, new Set([asset.id]))).resolves.toEqual(new Set());
    });

    it('should exclude non-timeline visibility assets', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: hidden } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Hidden,
      });
      const { asset: archived } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Archive,
      });
      const { asset: locked } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Locked,
      });

      await expect(
        sut.asset.checkLibraryAssetScope(library.id, new Set([hidden.id, archived.id, locked.id])),
      ).resolves.toEqual(new Set());
    });

    it('should return only the matching subset of a mixed request', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: inScope } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset: outOfScope } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });

      await expect(sut.asset.checkLibraryAssetScope(library.id, new Set([inScope.id, outOfScope.id]))).resolves.toEqual(
        new Set([inScope.id]),
      );
    });
  });

  describe('person.checkLibraryFaceScope', () => {
    it('should return an empty set for empty input', async () => {
      const { sut } = setup();
      await expect(sut.person.checkLibraryFaceScope(factory.uuid(), new Set())).resolves.toEqual(new Set());
    });

    it('should return a face on a timeline asset that belongs to the exact library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });

      await expect(sut.person.checkLibraryFaceScope(library.id, new Set([assetFace.id]))).resolves.toEqual(
        new Set([assetFace.id]),
      );
    });

    it('should exclude a face on an asset in a different library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library: library1 } = await newLibrary(ctx, { ownerId: owner.id });
      const { library: library2 } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library2.id,
        visibility: AssetVisibility.Timeline,
      });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });

      await expect(sut.person.checkLibraryFaceScope(library1.id, new Set([assetFace.id]))).resolves.toEqual(new Set());
    });

    it('should exclude a soft-deleted face', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
      await ctx.database
        .updateTable('asset_face')
        .set({ deletedAt: new Date() })
        .where('id', '=', assetFace.id)
        .execute();

      await expect(sut.person.checkLibraryFaceScope(library.id, new Set([assetFace.id]))).resolves.toEqual(new Set());
    });

    it('should exclude a hidden (isVisible=false) face', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, isVisible: false });

      await expect(sut.person.checkLibraryFaceScope(library.id, new Set([assetFace.id]))).resolves.toEqual(new Set());
    });

    it('should return only the matching subset of a mixed request', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: inScope } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset: outOfScope } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      const { assetFace: faceInScope } = await ctx.newAssetFace({ assetId: inScope.id });
      const { assetFace: faceOutOfScope } = await ctx.newAssetFace({ assetId: outOfScope.id });

      await expect(
        sut.person.checkLibraryFaceScope(library.id, new Set([faceInScope.id, faceOutOfScope.id])),
      ).resolves.toEqual(new Set([faceInScope.id]));
    });
  });

  describe('person.checkLibraryPersonScope', () => {
    it('should return an empty set for empty input', async () => {
      const { sut } = setup();
      await expect(sut.person.checkLibraryPersonScope(factory.uuid(), new Set())).resolves.toEqual(new Set());
    });

    it('should return a person with a visible face on a library timeline asset', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.person.checkLibraryPersonScope(library.id, new Set([person.id]))).resolves.toEqual(
        new Set([person.id]),
      );
    });

    it('should exclude a person whose only faces are outside this library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.person.checkLibraryPersonScope(library.id, new Set([person.id]))).resolves.toEqual(new Set());
    });

    it('should exclude a person with no faces at all', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { person } = await ctx.newPerson({ ownerId: owner.id });

      await expect(sut.person.checkLibraryPersonScope(library.id, new Set([person.id]))).resolves.toEqual(new Set());
    });

    it('should exclude a person whose only library face is on a non-timeline (archived) asset', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Archive,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.person.checkLibraryPersonScope(library.id, new Set([person.id]))).resolves.toEqual(new Set());
    });
  });

  describe('person.checkPersonExclusiveToLibrary', () => {
    it('should return true when every face of the person is inside the library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: assetA } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset: assetB } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: assetA.id, personId: person.id });
      await ctx.newAssetFace({ assetId: assetB.id, personId: person.id });

      await expect(sut.person.checkPersonExclusiveToLibrary(library.id, person.id)).resolves.toBe(true);
    });

    it('should return false when the person also has a face outside the library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: inLibrary } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset: outsideLibrary } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: inLibrary.id, personId: person.id });
      await ctx.newAssetFace({ assetId: outsideLibrary.id, personId: person.id });

      await expect(sut.person.checkPersonExclusiveToLibrary(library.id, person.id)).resolves.toBe(false);
    });

    it('should return false when the person has no faces in this library at all', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: outsideLibrary } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: outsideLibrary.id, personId: person.id });

      await expect(sut.person.checkPersonExclusiveToLibrary(library.id, person.id)).resolves.toBe(false);
    });

    it('should ignore a soft-deleted face outside the library when deciding exclusivity', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: inLibrary } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset: outsideLibrary } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: inLibrary.id, personId: person.id });
      const { assetFace: deletedOutsideFace } = await ctx.newAssetFace({
        assetId: outsideLibrary.id,
        personId: person.id,
      });
      await ctx.database
        .updateTable('asset_face')
        .set({ deletedAt: new Date() })
        .where('id', '=', deletedOutsideFace.id)
        .execute();

      await expect(sut.person.checkPersonExclusiveToLibrary(library.id, person.id)).resolves.toBe(true);
    });
  });

  describe('person.checkSharedLibraryPersonAccess (Phase 5)', () => {
    it('should return an empty set for empty input', async () => {
      const { sut } = setup();
      await expect(sut.person.checkSharedLibraryPersonAccess(factory.uuid(), new Set())).resolves.toEqual(new Set());
    });

    it('should return a person reachable via an inTimeline=true share', async () => {
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
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.person.checkSharedLibraryPersonAccess(sharee.id, new Set([person.id]))).resolves.toEqual(
        new Set([person.id]),
      );
    });

    it('should exclude a person reachable only via an inTimeline=false share', async () => {
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
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.person.checkSharedLibraryPersonAccess(sharee.id, new Set([person.id]))).resolves.toEqual(
        new Set(),
      );
    });

    it('should exclude a person reachable through a DIFFERENT library not shared with this caller', async () => {
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
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.person.checkSharedLibraryPersonAccess(sharee.id, new Set([person.id]))).resolves.toEqual(
        new Set(),
      );
    });

    it('should exclude a stranger with no share at all', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.person.checkSharedLibraryPersonAccess(stranger.id, new Set([person.id]))).resolves.toEqual(
        new Set(),
      );
    });

    // Review finding (plan §5.3): a person the owner has HIDDEN must be excluded from every
    // sharee-facing surface - including this by-id reachability check, which backs GET /people/:id,
    // the person thumbnail, and the timeline/search personId filters.
    it('should exclude a person the owner has hidden, even when otherwise reachable', async () => {
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
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.person.checkSharedLibraryPersonAccess(sharee.id, new Set([person.id]))).resolves.toEqual(
        new Set(),
      );

      // sanity check: un-hiding the person restores reachability, proving isHidden was the only gate
      await ctx.database.updateTable('person').set({ isHidden: false }).where('id', '=', person.id).execute();
      await expect(sut.person.checkSharedLibraryPersonAccess(sharee.id, new Set([person.id]))).resolves.toEqual(
        new Set([person.id]),
      );
    });
  });

  describe('library.checkSelfShareAccess (Phase 5)', () => {
    it('should return an empty set for empty input', async () => {
      const { sut } = setup();
      await expect(sut.library.checkSelfShareAccess(factory.uuid(), new Set())).resolves.toEqual(new Set());
    });

    it("should return the library for the recipient's own share row (any role)", async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: sharee } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      await newLibraryUser(ctx, { libraryId: library.id, userId: sharee.id, role: LibraryUserRole.Viewer });

      await expect(sut.library.checkSelfShareAccess(sharee.id, new Set([library.id]))).resolves.toEqual(
        new Set([library.id]),
      );
    });

    it('should exclude the library for its OWNER (owner has no library_user row)', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });

      await expect(sut.library.checkSelfShareAccess(owner.id, new Set([library.id]))).resolves.toEqual(new Set());
    });

    it('should exclude the library for an unrelated third party', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });

      await expect(sut.library.checkSelfShareAccess(stranger.id, new Set([library.id]))).resolves.toEqual(new Set());
    });
  });
});
