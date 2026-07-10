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
  dto: { libraryId: string; userId: string; role: LibraryUserRole },
) => {
  await ctx.database.insertInto('library_user').values(dto).execute();
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
});
