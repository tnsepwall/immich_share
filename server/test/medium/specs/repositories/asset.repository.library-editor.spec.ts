import { Kysely } from 'kysely';
import { AssetVisibility, LibraryUserRole } from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
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
  return { ctx, sut: ctx.get(AssetRepository) };
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

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

// This mirrors updateLibraryAssetMetadata's own doc comment: it re-verifies role AND asset scope INSIDE the
// transaction so a downgrade/removal racing the caller's outer permission check can never write anything.
// Needs a live Postgres instance - see FEATURE-PLAN-shared-external-libraries.md Step 5b and both prior phase
// logs' "migration is unverified" limitation. Not runnable in this environment; typechecks and documents intent.
describe(`${AssetRepository.name}.updateLibraryAssetMetadata`, () => {
  it('should let the owner update and lock only the touched properties (never sidecarWriteProperties)', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { library } = await newLibrary(ctx, { ownerId: owner.id });
    const { asset } = await ctx.newAsset({
      ownerId: owner.id,
      libraryId: library.id,
      visibility: AssetVisibility.Timeline,
    });
    await ctx.newExif({ assetId: asset.id, lockedProperties: null, sidecarWriteProperties: null });

    const result = await sut.updateLibraryAssetMetadata(library.id, owner.id, [asset.id], {
      description: 'Editor note',
    });

    expect(result).toEqual([asset.id]);
    const exif = await ctx.database
      .selectFrom('asset_exif')
      .selectAll()
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(exif.description).toBe('Editor note');
    expect(exif.lockedProperties).toEqual(['description']);
    expect(exif.sidecarWriteProperties).toBeNull();
  });

  it('should cancel a pending owner sidecar write for a property the Editor overwrites, so the Editor value can never reach an XMP file', async () => {
    // Regression test for a real finding from the Phase 3 adversarial security review: handleSidecarWrite
    // (metadata.service.ts) reads asset_exif's CURRENT value for whatever is in sidecarWriteProperties at the
    // moment the job actually runs, not a value snapshotted when the job was queued. Without this cancellation,
    // an owner edit (which queues SidecarWrite and marks the property pending) followed by an Editor edit of the
    // SAME property - before that job runs - would let the job flush the Editor's database-only value to disk.
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
    // Simulate the state right after an owner edit queued (but has not yet run) a SidecarWrite for `description`.
    await ctx.newExif({
      assetId: asset.id,
      description: "owner's queued value",
      lockedProperties: ['description'],
      sidecarWriteProperties: ['description'],
    });

    await sut.updateLibraryAssetMetadata(library.id, editor.id, [asset.id], { description: "editor's value" });

    const exif = await ctx.database
      .selectFrom('asset_exif')
      .select(['description', 'lockedProperties', 'sidecarWriteProperties'])
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(exif.description).toBe("editor's value");
    expect(exif.lockedProperties).toEqual(['description']);
    // The critical assertion: the pending flag for `description` must be gone, or a later handleSidecarWrite
    // run would pick up and write the editor's value.
    expect(exif.sidecarWriteProperties).toBeNull();
  });

  it('should let an Editor update but reject a Viewer', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: editor } = await ctx.newUser();
    const { user: viewer } = await ctx.newUser();
    const { library } = await newLibrary(ctx, { ownerId: owner.id });
    await newLibraryUser(ctx, { libraryId: library.id, userId: editor.id, role: LibraryUserRole.Editor });
    await newLibraryUser(ctx, { libraryId: library.id, userId: viewer.id, role: LibraryUserRole.Viewer });
    const { asset } = await ctx.newAsset({
      ownerId: owner.id,
      libraryId: library.id,
      visibility: AssetVisibility.Timeline,
    });

    await expect(
      sut.updateLibraryAssetMetadata(library.id, editor.id, [asset.id], { rating: 3 }),
    ).resolves.toEqual([asset.id]);

    await expect(sut.updateLibraryAssetMetadata(library.id, viewer.id, [asset.id], { rating: 1 })).resolves.toBeNull();

    // Viewer's rejected call must not have written anything - the Editor's 3 must still stand.
    const exif = await ctx.database
      .selectFrom('asset_exif')
      .select('rating')
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(exif.rating).toBe(3);
  });

  it('should reject a stranger with no owner or editor access', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: stranger } = await ctx.newUser();
    const { library } = await newLibrary(ctx, { ownerId: owner.id });
    const { asset } = await ctx.newAsset({
      ownerId: owner.id,
      libraryId: library.id,
      visibility: AssetVisibility.Timeline,
    });

    await expect(
      sut.updateLibraryAssetMetadata(library.id, stranger.id, [asset.id], { description: 'hijacked' }),
    ).resolves.toBeNull();
  });

  it('should write nothing when any one asset in the batch is out of scope (atomic all-or-nothing)', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { library } = await newLibrary(ctx, { ownerId: owner.id });
    const { asset: inScope } = await ctx.newAsset({
      ownerId: owner.id,
      libraryId: library.id,
      visibility: AssetVisibility.Timeline,
    });
    const { asset: outOfScope } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
    await ctx.newExif({ assetId: inScope.id, description: 'original' });

    await expect(
      sut.updateLibraryAssetMetadata(library.id, owner.id, [inScope.id, outOfScope.id], { description: 'edited' }),
    ).resolves.toBeNull();

    const exif = await ctx.database
      .selectFrom('asset_exif')
      .select('description')
      .where('assetId', '=', inScope.id)
      .executeTakeFirstOrThrow();
    expect(exif.description).toBe('original');
  });

  it('should reject a trashed or non-Timeline visibility asset', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { library } = await newLibrary(ctx, { ownerId: owner.id });
    const { asset: archived } = await ctx.newAsset({
      ownerId: owner.id,
      libraryId: library.id,
      visibility: AssetVisibility.Archive,
    });

    await expect(
      sut.updateLibraryAssetMetadata(library.id, owner.id, [archived.id], { rating: 2 }),
    ).resolves.toBeNull();
  });

  it('should reject when the library is soft-deleted, even for its former owner', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { library } = await newLibrary(ctx, { ownerId: owner.id });
    const { asset } = await ctx.newAsset({
      ownerId: owner.id,
      libraryId: library.id,
      visibility: AssetVisibility.Timeline,
    });
    await ctx.database.updateTable('library').set({ deletedAt: new Date() }).where('id', '=', library.id).execute();

    await expect(
      sut.updateLibraryAssetMetadata(library.id, owner.id, [asset.id], { rating: 2 }),
    ).resolves.toBeNull();
  });

  it('should derive localDateTime/fileCreatedAt from an absolute dateTimeOriginal edit', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { library } = await newLibrary(ctx, { ownerId: owner.id });
    const { asset } = await ctx.newAsset({
      ownerId: owner.id,
      libraryId: library.id,
      visibility: AssetVisibility.Timeline,
    });
    await ctx.newExif({ assetId: asset.id });

    await sut.updateLibraryAssetMetadata(library.id, owner.id, [asset.id], {
      dateTimeOriginal: new Date('2020-06-15T12:00:00.000Z'),
      timeZone: 'UTC-5',
    });

    const updated = await ctx.database
      .selectFrom('asset')
      .select(['localDateTime', 'fileCreatedAt'])
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    const exif = await ctx.database
      .selectFrom('asset_exif')
      .select(['dateTimeOriginal', 'timeZone', 'lockedProperties'])
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();

    expect(exif.dateTimeOriginal).toEqual(new Date('2020-06-15T12:00:00.000Z'));
    expect(exif.timeZone).toBe('UTC-5');
    expect(exif.lockedProperties).toEqual(expect.arrayContaining(['dateTimeOriginal', 'timeZone']));
    expect(updated.fileCreatedAt).toEqual(new Date('2020-06-15T12:00:00.000Z'));
    expect(updated.localDateTime).toEqual(new Date('2020-06-15T07:00:00.000Z'));
  });

  it('should shift the existing date by dateTimeRelative without needing an absolute value', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { library } = await newLibrary(ctx, { ownerId: owner.id });
    const { asset } = await ctx.newAsset({
      ownerId: owner.id,
      libraryId: library.id,
      visibility: AssetVisibility.Timeline,
    });
    await ctx.newExif({ assetId: asset.id, dateTimeOriginal: new Date('2020-06-15T12:00:00.000Z'), timeZone: 'UTC' });

    await sut.updateLibraryAssetMetadata(library.id, owner.id, [asset.id], { dateTimeRelative: -30 });

    const exif = await ctx.database
      .selectFrom('asset_exif')
      .select('dateTimeOriginal')
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(exif.dateTimeOriginal).toEqual(new Date('2020-06-15T11:30:00.000Z'));
  });
});
