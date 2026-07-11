import { Kysely } from 'kysely';
import { AssetVisibility, LibraryUserRole } from 'src/enum';
import { AlbumRepository } from 'src/repositories/album.repository';
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
  return { ctx, sut: ctx.get(AlbumRepository) };
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

// Regression coverage for a real bug found while manually smoke-testing Phase 2 against a live deployment:
// AlbumRepository#create()'s album_asset CTE is a bare INSERT ... SELECT with no explicit target column list,
// so Postgres maps the SELECT's outputs onto the table's columns BY PHYSICAL POSITION, not by name.
// sourceLibraryId was appended to album_asset by a later ALTER TABLE (Phase 2), so it lives after
// createdAt/updatedAt/updateId in physical column order - the 3rd selected value was silently landing in
// createdAt, producing "column createdAt is of type timestamp with time zone but expression is of type uuid"
// on every album creation (even with zero initial assets, since album_user's own insert still runs). A second,
// related bug: the CTE's own name shadows the real table for the rest of the query, so its RETURNING clause
// must expose every column any later reference in the same query needs (withAssets()/withAlbumAssetProvenance()
// reads album_asset.sourceLibraryId) or that reference fails with "column ... does not exist".
describe(`${AlbumRepository.name}.create`, () => {
  it('should create an album with zero initial assets (the exact case that was broken)', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();

    const album = await sut.create(
      { albumName: 'Empty album', albumThumbnailAssetId: null },
      [],
      [{ userId: owner.id, role: 'owner' as any }],
      owner.id,
    );

    expect(album.albumName).toBe('Empty album');
    expect(album.assets).toBeNull();
  });

  it('should create an album with an ordinary (null-provenance) asset', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });

    const album = await sut.create(
      { albumName: 'Ordinary album', albumThumbnailAssetId: asset.id },
      [{ assetId: asset.id, sourceLibraryId: null }],
      [{ userId: owner.id, role: 'owner' as any }],
      owner.id,
    );

    expect((album.assets ?? []).map((a: any) => a.id)).toEqual([asset.id]);

    const row = await ctx.database
      .selectFrom('album_asset')
      .selectAll()
      .where('albumId', '=', album.id)
      .executeTakeFirstOrThrow();
    expect(row.assetId).toBe(asset.id);
    expect(row.sourceLibraryId).toBeNull();
  });

  it('should create an album with a library-provenance asset, visible only while the share is active', async () => {
    const { ctx, sut } = setup();
    const { user: libraryOwner } = await ctx.newUser();
    const { user: recipient } = await ctx.newUser();
    const { library } = await newLibrary(ctx, { ownerId: libraryOwner.id });
    await ctx.database
      .insertInto('library_user')
      .values({
        libraryId: library.id,
        userId: recipient.id,
        role: LibraryUserRole.Viewer,
      })
      .execute();
    const { asset } = await ctx.newAsset({
      ownerId: libraryOwner.id,
      libraryId: library.id,
      visibility: AssetVisibility.Timeline,
    });

    const album = await sut.create(
      { albumName: 'Shared album', albumThumbnailAssetId: asset.id },
      [{ assetId: asset.id, sourceLibraryId: library.id }],
      [{ userId: recipient.id, role: 'owner' as any }],
      recipient.id,
    );

    // The row is written correctly with its real sourceLibraryId...
    const row = await ctx.database
      .selectFrom('album_asset')
      .selectAll()
      .where('albumId', '=', album.id)
      .executeTakeFirstOrThrow();
    expect(row.sourceLibraryId).toBe(library.id);

    // ...and is visible to the recipient while the share is active...
    expect((album.assets ?? []).map((a: any) => a.id)).toEqual([asset.id]);

    // ...but disappears the moment the share is revoked, even though the album_asset row still exists.
    await ctx.database.deleteFrom('library_user').where('userId', '=', recipient.id).execute();
    const afterRevocation = await sut.getById(album.id, { withAssets: true }, recipient.id);
    expect(afterRevocation?.assets ?? []).toEqual([]);
  });
});
