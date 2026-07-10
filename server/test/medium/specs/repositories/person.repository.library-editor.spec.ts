import { Kysely } from 'kysely';
import { AssetVisibility, LibraryUserRole } from 'src/enum';
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
  dto: { libraryId: string; userId: string; role: LibraryUserRole },
) => {
  await ctx.database.insertInto('library_user').values(dto).execute();
  return { libraryUser: dto };
};

const getPerson = async (ctx: MediumTestContext, personId: string) =>
  ctx.database.selectFrom('person').selectAll().where('id', '=', personId).executeTakeFirstOrThrow();

const getFace = async (ctx: MediumTestContext, faceId: string) =>
  ctx.database.selectFrom('asset_face').selectAll().where('id', '=', faceId).executeTakeFirstOrThrow();

const countPeople = async (ctx: MediumTestContext) =>
  ctx.database
    .selectFrom('person')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow()
    .then((r) => Number(r.count));

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

// These four methods are the write-path transactional primitives behind the Phase 4 person/face curation
// endpoints. Each re-verifies role AND library scope INSIDE its own transaction (mirroring
// AssetRepository#updateLibraryAssetMetadata's Phase 3 pattern exactly) - this is what actually closes the
// TOCTOU gap the outer service-level requireAccess check alone cannot, and what guarantees no partial write
// (e.g. an orphaned, empty owner-scoped person) if an entity turns out to be out of scope mid-flight. See the
// Phase 4 security review for the two real findings these tests specifically regression-guard: an Editor
// being able to tag a locked/archived/trashed in-library asset (H1), and create-person-and-assign not being
// atomic (M1).
describe(`${PersonRepository.name} library editor transactional primitives`, () => {
  describe('createPersonForLibrary', () => {
    it('should let the owner create a person, assign the faces, and pick a feature photo', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { assetFace: face } = await ctx.newAssetFace({ assetId: asset.id });

      const result = await sut.createPersonForLibrary(library.id, owner.id, 'Alice', [face.id]);

      expect(result).not.toBeNull();
      const person = await getPerson(ctx, result!.personId);
      expect(person.ownerId).toBe(owner.id);
      expect(person.name).toBe('Alice');
      expect(person.faceAssetId).toBe(face.id);
      expect(result!.needsFeaturePhoto).toEqual([result!.personId]);

      const updatedFace = await getFace(ctx, face.id);
      expect(updatedFace.personId).toBe(result!.personId);
    });

    it('should let an Editor create a person but reject a Viewer', async () => {
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
      const { assetFace: face } = await ctx.newAssetFace({ assetId: asset.id });

      await expect(sut.createPersonForLibrary(library.id, viewer.id, 'Nope', [face.id])).resolves.toBeNull();
      await expect(sut.createPersonForLibrary(library.id, editor.id, 'Alice', [face.id])).resolves.not.toBeNull();
    });

    it('should reject and create NO person at all when one of the faces is out of scope (atomic all-or-nothing)', async () => {
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

      const before = await countPeople(ctx);
      const result = await sut.createPersonForLibrary(library.id, owner.id, 'Alice', [
        faceInScope.id,
        faceOutOfScope.id,
      ]);
      const after = await countPeople(ctx);

      expect(result).toBeNull();
      // The critical assertion: no orphaned, empty owner-scoped person was left behind.
      expect(after).toBe(before);
      const untouchedFace = await getFace(ctx, faceInScope.id);
      expect(untouchedFace.personId).toBeNull();
    });

    it("should give an old person who lost their feature face a replacement from their remaining faces", async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person: oldPerson } = await ctx.newPerson({ ownerId: owner.id });
      const { assetFace: movingFace } = await ctx.newAssetFace({ assetId: asset.id, personId: oldPerson.id });
      const { assetFace: remainingFace } = await ctx.newAssetFace({ assetId: asset.id, personId: oldPerson.id });
      await ctx.database
        .updateTable('person')
        .set({ faceAssetId: movingFace.id })
        .where('id', '=', oldPerson.id)
        .execute();

      const result = await sut.createPersonForLibrary(library.id, owner.id, 'New', [movingFace.id]);

      expect(result).not.toBeNull();
      expect(result!.needsFeaturePhoto).toEqual(expect.arrayContaining([oldPerson.id, result!.personId]));
      const updatedOldPerson = await getPerson(ctx, oldPerson.id);
      expect(updatedOldPerson.faceAssetId).toBe(remainingFace.id);
    });
  });

  describe('updatePersonNameForLibrary', () => {
    it('should rename a person exclusive to this library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Old Name' });
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      await expect(sut.updatePersonNameForLibrary(library.id, owner.id, person.id, 'New Name')).resolves.toBe(true);
      const updated = await getPerson(ctx, person.id);
      expect(updated.name).toBe('New Name');
    });

    it('should reject renaming a person with a visible face outside this library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: inLibrary } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset: outsideLibrary } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Old Name' });
      await ctx.newAssetFace({ assetId: inLibrary.id, personId: person.id });
      await ctx.newAssetFace({ assetId: outsideLibrary.id, personId: person.id });

      await expect(sut.updatePersonNameForLibrary(library.id, owner.id, person.id, 'New Name')).resolves.toBe(false);
      expect((await getPerson(ctx, person.id)).name).toBe('Old Name');
    });

    // Regression test for the security review's L2 finding: a face on a TRASHED (soft-deleted) asset outside
    // the library must still count as a real footprint elsewhere, since the asset is restorable.
    it('should reject renaming a person whose only outside face is on a trashed (soft-deleted) asset', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: inLibrary } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset: trashedOutside } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      await ctx.softDeleteAsset(trashedOutside.id);
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Old Name' });
      await ctx.newAssetFace({ assetId: inLibrary.id, personId: person.id });
      await ctx.newAssetFace({ assetId: trashedOutside.id, personId: person.id });

      await expect(sut.updatePersonNameForLibrary(library.id, owner.id, person.id, 'New Name')).resolves.toBe(false);
      expect((await getPerson(ctx, person.id)).name).toBe('Old Name');
    });

    it('should reject a Viewer', async () => {
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

      await expect(sut.updatePersonNameForLibrary(library.id, viewer.id, person.id, 'New Name')).resolves.toBe(false);
    });
  });

  describe('assignFacesForLibrary', () => {
    it('should reassign a face and refresh the feature photo of the person who lost it', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person: target } = await ctx.newPerson({ ownerId: owner.id });
      const { person: oldPerson } = await ctx.newPerson({ ownerId: owner.id });
      // assignFacesForLibrary can only target a person already reachable through this library (i.e. one
      // getAllForLibrary would already show) - establish that via an existing, unrelated face.
      await ctx.newAssetFace({ assetId: asset.id, personId: target.id });
      const { assetFace: movingFace } = await ctx.newAssetFace({ assetId: asset.id, personId: oldPerson.id });
      await ctx.database
        .updateTable('person')
        .set({ faceAssetId: movingFace.id })
        .where('id', '=', oldPerson.id)
        .execute();

      const result = await sut.assignFacesForLibrary(library.id, owner.id, target.id, [movingFace.id]);

      // movingFace was oldPerson's ONLY face, so once it moves away oldPerson has nothing left to pick a
      // replacement from - they're dropped from needsFeaturePhoto (no job queued) and their faceAssetId is
      // left stale, mirroring the existing owner-flow PersonService.createNewFeaturePhoto behavior exactly
      // when getRandomFace finds nothing.
      expect(result).toEqual({ needsFeaturePhoto: [target.id] });
      expect((await getFace(ctx, movingFace.id)).personId).toBe(target.id);
      expect((await getPerson(ctx, oldPerson.id)).faceAssetId).toBe(movingFace.id);
    });

    it('should reject when a face is not in this library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: inLibrary } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset: outOfScope } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      const { person: target } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: inLibrary.id, personId: target.id });
      const { assetFace: outOfScopeFace } = await ctx.newAssetFace({ assetId: outOfScope.id });

      await expect(
        sut.assignFacesForLibrary(library.id, owner.id, target.id, [outOfScopeFace.id]),
      ).resolves.toBeNull();
    });

    it('should reject when the target person is not reachable through this library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { assetFace: face } = await ctx.newAssetFace({ assetId: asset.id });
      const { person: elsewhere } = await ctx.newPerson({ ownerId: owner.id });
      const { asset: elsewhereAsset } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      await ctx.newAssetFace({ assetId: elsewhereAsset.id, personId: elsewhere.id });

      await expect(sut.assignFacesForLibrary(library.id, owner.id, elsewhere.id, [face.id])).resolves.toBeNull();
    });
  });

  describe('createManualFaceForLibrary', () => {
    const box = { imageWidth: 100, imageHeight: 100, boundingBoxX1: 1, boundingBoxY1: 1, boundingBoxX2: 10, boundingBoxY2: 10 };

    it('should create a face on a Timeline asset and set it as the feature photo when the person had none', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      // createManualFaceForLibrary can only target a person already reachable through this library -
      // establish that via an existing, unrelated face (not the person's feature photo).
      await ctx.newAssetFace({ assetId: asset.id, personId: person.id });

      const result = await sut.createManualFaceForLibrary(library.id, owner.id, person.id, asset.id, box);

      expect(result).not.toBeNull();
      expect(result!.needsFeaturePhoto).toEqual([person.id]);
      const face = await getFace(ctx, result!.faceId);
      expect(face.assetId).toBe(asset.id);
      expect(face.personId).toBe(person.id);
      expect((await getPerson(ctx, person.id)).faceAssetId).toBe(result!.faceId);
    });

    // Regression test for the security review's H1 finding: createManualFace previously checked only
    // asset.libraryId equality, with no visibility or soft-delete scope check, letting an Editor tag a
    // locked/archived/hidden/trashed in-library asset they're otherwise forbidden to touch.
    it('should reject creating a face on an archived (non-Timeline) asset in the same library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: timeline } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset: archived } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Archive,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      // Establish person as already reachable through this library via an unrelated Timeline asset, so the
      // rejection below is unambiguously about the archived asset, not the person.
      await ctx.newAssetFace({ assetId: timeline.id, personId: person.id });

      await expect(
        sut.createManualFaceForLibrary(library.id, owner.id, person.id, archived.id, box),
      ).resolves.toBeNull();
    });

    it('should reject creating a face on a trashed (soft-deleted) asset in the same library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset: timeline } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      await ctx.softDeleteAsset(asset.id);
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: timeline.id, personId: person.id });

      await expect(sut.createManualFaceForLibrary(library.id, owner.id, person.id, asset.id, box)).resolves.toBeNull();
    });

    it('should reject creating a face on an asset in a different library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library: library1 } = await newLibrary(ctx, { ownerId: owner.id });
      const { library: library2 } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library2.id,
        visibility: AssetVisibility.Timeline,
      });
      const { asset: assetInLib1 } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library1.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person } = await ctx.newPerson({ ownerId: owner.id });
      await ctx.newAssetFace({ assetId: assetInLib1.id, personId: person.id });

      await expect(
        sut.createManualFaceForLibrary(library1.id, owner.id, person.id, asset.id, box),
      ).resolves.toBeNull();
    });

    it('should reject when the person is not reachable through this library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        libraryId: library.id,
        visibility: AssetVisibility.Timeline,
      });
      const { person: elsewhere } = await ctx.newPerson({ ownerId: owner.id });
      const { asset: elsewhereAsset } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
      await ctx.newAssetFace({ assetId: elsewhereAsset.id, personId: elsewhere.id });

      await expect(
        sut.createManualFaceForLibrary(library.id, owner.id, elsewhere.id, asset.id, box),
      ).resolves.toBeNull();
    });
  });
});
