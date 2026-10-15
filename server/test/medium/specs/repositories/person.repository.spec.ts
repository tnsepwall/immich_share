import { Kysely } from 'kysely';
import { PersonUserRole } from 'src/dtos/person.dto.js';
import { AssetFileType, AssetVisibility, LibraryUserRole, SourceType } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonUserRepository } from 'src/repositories/person-user.repository.js';
import { PersonRepository, type PersonSearchOptions } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(PersonRepository) };
};

const listFor = async (sut: PersonRepository, userId: string, options?: Partial<PersonSearchOptions>) => {
  const { items } = await sut.getAllForUser({ take: 100, skip: 0 }, userId, {
    withHidden: false,
    partnerIds: [],
    ...options,
  });
  return items;
};

// a named person with at least one visible face clears the minimum-faces rule
const newNamedPerson = async (ctx: MediumTestContext, ownerId: string, name: string) => {
  const { result: person } = await ctx.newPerson({ ownerId, name });
  const { asset } = await ctx.newAsset({ ownerId });
  await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
  return person;
};

const otherPeopleOf = async (
  sut: PersonRepository,
  ctx: MediumTestContext,
  userId: string,
  groupId: string,
  partnerIds: string[],
) => {
  const listItems = await listFor(sut, userId, { partnerIds });
  const listed = listItems.find((item) => item.personGroupId === groupId);
  const forUser = await sut.getForUser({ userId, personGroupId: groupId });
  const byGroupId = await sut.getByGroupId({ ownerId: userId, personGroupId: groupId });
  return {
    getAllForUser: listed?.otherPeople,
    getForUser: forUser?.otherPeople,
    getByGroupId: byGroupId?.otherPeople,
  };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

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
  describe('createAll', () => {
    it('should create people in the groups they were given', async () => {
      const { ctx, sut } = setup();
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];

      const [group1, group2] = await sut.createGroups([
        { clusterGroupId: user1.clusterGroupId },
        { clusterGroupId: user1.clusterGroupId },
      ]);
      const group3 = await sut.createGroup(user2.id);

      const people = await sut.createAll([
        { ownerId: user1.id, name: 'Alice', personGroupId: group1.id },
        { ownerId: user1.id, name: 'Bob', personGroupId: group2.id },
        { ownerId: user2.id, name: 'Carol', personGroupId: group3.id },
      ]);

      expect(people.map(({ personGroupId }) => personGroupId)).toEqual([group1.id, group2.id, group3.id]);

      const groups = await ctx.database
        .selectFrom('person')
        .innerJoin('person_group', 'person_group.id', 'person.personGroupId')
        .innerJoin('user', 'user.id', 'person.ownerId')
        .select(['person.name', 'person_group.clusterGroupId', 'user.clusterGroupId as ownerClusterGroupId'])
        .where(
          'person.personGroupId',
          'in',
          people.map(({ personGroupId }) => personGroupId),
        )
        .execute();

      expect(groups).toHaveLength(3);
      for (const group of groups) {
        expect(group.clusterGroupId).toBe(group.ownerClusterGroupId);
      }
    });
  });

  describe('createGroup', () => {
    it('should create a group in the owner cluster group', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const group = await sut.createGroup(user.id);

      const owner = await ctx.database
        .selectFrom('person_group')
        .innerJoin('user', 'user.clusterGroupId', 'person_group.clusterGroupId')
        .select('user.id')
        .where('person_group.id', '=', group.id)
        .executeTakeFirstOrThrow();

      expect(owner.id).toBe(user.id);
    });

    it('should put people created with the same group into that group', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];

      const group = await sut.createGroup(user1.id);
      const person1 = await sut.create({ ownerId: user1.id, name: 'Alice', personGroupId: group.id });
      const person2 = await sut.create({ ownerId: user2.id, name: 'Alice', personGroupId: group.id });

      expect(person1.personGroupId).toBe(group.id);
      expect(person2.personGroupId).toBe(group.id);

      const groups = await ctx.database.selectFrom('person_group').select('person_group.id').execute();
      expect(groups.map(({ id }) => id)).toEqual([group.id]);
    });
  });

  describe('getByGroupId', () => {
    it('should not return a person owned by another user', async () => {
      const { ctx, sut } = setup();
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];
      const group = await sut.createGroup(user1.id);

      const person1 = await sut.create({ ownerId: user1.id, name: 'Alice', personGroupId: group.id });
      const person2 = await ctx.database
        .insertInto('person')
        .values({ ownerId: user2.id, name: 'Alice', personGroupId: person1.personGroupId })
        .returningAll()
        .executeTakeFirstOrThrow();

      await expect(sut.getByGroupId({ ownerId: user1.id, personGroupId: person1.personGroupId })).resolves.toEqual(
        expect.objectContaining({ personGroupId: person1.personGroupId, ownerId: user1.id }),
      );
      await expect(sut.getByGroupId({ ownerId: user2.id, personGroupId: person1.personGroupId })).resolves.toEqual(
        expect.objectContaining({ personGroupId: person2.personGroupId, ownerId: user2.id }),
      );
    });

    it('should return nothing when the group belongs to another user', async () => {
      const { ctx, sut } = setup();
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];
      const group = await sut.createGroup(user1.id);

      const person = await sut.create({ ownerId: user1.id, name: 'Alice', personGroupId: group.id });

      await expect(
        sut.getByGroupId({ ownerId: user2.id, personGroupId: person.personGroupId }),
      ).resolves.toBeUndefined();
    });
  });

  describe('otherPeople', () => {
    it('should report the person shared with the user from every lookup', async () => {
      const { ctx, sut } = setup();
      const [{ user: owner }, { user: recipient }] = [await ctx.newUser(), await ctx.newUser()];
      const person = await newNamedPerson(ctx, owner.id, 'Alice');

      await ctx.get(PersonUserRepository).createAll([
        {
          personGroupId: person.personGroupId,
          sharedById: owner.id,
          sharedWithId: recipient.id,
          role: PersonUserRole.Write,
        },
      ]);

      const expected = [{ sharedById: owner.id, role: PersonUserRole.Write, name: 'Alice', birthDate: null }];
      const results = await otherPeopleOf(sut, ctx, recipient.id, person.personGroupId, [owner.id]);

      expect(results.getAllForUser).toEqual(expected);
      expect(results.getForUser).toEqual(expected);
      expect(results.getByGroupId).toEqual(expected);
    });

    it('should not report a share pointed at a different user', async () => {
      const { ctx, sut } = setup();
      const [{ user: owner }, { user: first }, { user: second }] = [
        await ctx.newUser(),
        await ctx.newUser(),
        await ctx.newUser(),
      ];
      const person = await newNamedPerson(ctx, owner.id, 'Alice');

      await ctx.get(PersonUserRepository).createAll([
        {
          personGroupId: person.personGroupId,
          sharedById: owner.id,
          sharedWithId: first.id,
          role: PersonUserRole.Read,
        },
        {
          personGroupId: person.personGroupId,
          sharedById: owner.id,
          sharedWithId: second.id,
          role: PersonUserRole.Read,
        },
      ]);

      const expected = [{ sharedById: owner.id, role: PersonUserRole.Read, name: 'Alice', birthDate: null }];
      const results = await otherPeopleOf(sut, ctx, first.id, person.personGroupId, [owner.id]);

      expect(results.getAllForUser).toEqual(expected);
      expect(results.getForUser).toEqual(expected);
      expect(results.getByGroupId).toEqual(expected);
    });

    it('should be empty for a group the user was never shared into', async () => {
      const { ctx, sut } = setup();
      const [{ user: owner }, { user: other }] = [await ctx.newUser(), await ctx.newUser()];
      const person = await newNamedPerson(ctx, owner.id, 'Alice');

      await ctx.database
        .insertInto('person')
        .values({ ownerId: other.id, name: 'Alice', personGroupId: person.personGroupId })
        .execute();

      const results = await otherPeopleOf(sut, ctx, other.id, person.personGroupId, [owner.id]);

      expect(results.getForUser).toEqual([]);
      expect(results.getByGroupId).toEqual([]);
    });
  });
  describe('deleteEmptyGroups', () => {
    it('should delete groups that no longer have any people', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const [keptGroup, emptiedGroup] = await sut.createGroups([
        { clusterGroupId: user.clusterGroupId },
        { clusterGroupId: user.clusterGroupId },
      ]);

      const kept = await sut.create({ ownerId: user.id, name: 'Alice', personGroupId: keptGroup.id });
      const emptied = await sut.create({ ownerId: user.id, name: 'Bob', personGroupId: emptiedGroup.id });
      await ctx.database
        .deleteFrom('person')
        .where('person.ownerId', '=', emptied.ownerId)
        .where('person.personGroupId', '=', emptied.personGroupId)
        .execute();

      await expect(sut.deleteEmptyGroups()).resolves.toBe(1);

      const groups = await ctx.database.selectFrom('person_group').select('person_group.id').execute();
      expect(groups.map(({ id }) => id)).toEqual([kept.personGroupId]);
    });
  });

  describe('deleteOrphanedClusterGroups', () => {
    it('should delete cluster groups that no longer belong to a user, along with their people', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: kept }, { user: removed }] = [await ctx.newUser(), await ctx.newUser()];
      const keptGroup = await sut.createGroup(kept.id);
      const removedGroup = await sut.createGroup(removed.id);

      const keptPerson = await sut.create({ ownerId: kept.id, name: 'Alice', personGroupId: keptGroup.id });
      await sut.create({ ownerId: removed.id, name: 'Bob', personGroupId: removedGroup.id });
      const { clusterGroupId } = await ctx.database
        .selectFrom('user')
        .select('user.clusterGroupId')
        .where('user.id', '=', kept.id)
        .executeTakeFirstOrThrow();
      await ctx.database.deleteFrom('user').where('user.id', '=', removed.id).execute();

      await expect(sut.deleteOrphanedClusterGroups()).resolves.toBe(1);

      const clusterGroups = await ctx.database.selectFrom('cluster_group').select('cluster_group.id').execute();
      expect(clusterGroups.map(({ id }) => id)).toEqual([clusterGroupId]);

      const groups = await ctx.database.selectFrom('person_group').select('person_group.id').execute();
      expect(groups.map(({ id }) => id)).toEqual([keptPerson.personGroupId]);
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
        personGroupId: person.personGroupId,
        boundingBoxX1: 10,
        boundingBoxY1: 10,
        boundingBoxX2: 90,
        boundingBoxY2: 90,
      });

      // there's a circular dependency between assetFace and person, so we need to update the person after creating the assetFace
      await ctx.database
        .updateTable('person')
        .set({ faceAssetId: assetFace.id })
        .where('ownerId', '=', person.ownerId)
        .where('personGroupId', '=', person.personGroupId)
        .execute();

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

      const result = await sut.getDataForThumbnailGenerationJob({
        ownerId: person.ownerId,
        personGroupId: person.personGroupId,
      });

      expect(result).toEqual(
        expect.objectContaining({
          previewPath: 'preview_unedited.jpg',
        }),
      );
    });
  });

  describe('forBirthdayMemories', () => {
    const target = { year: 2025, month: 6, day: 13 };

    it('should return people with a birthday on the given day', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Alice', birthDate: '1990-06-13' });
      await ctx.newPerson({ ownerId: user.id, name: 'Bob', birthDate: '1990-06-14' });

      const people = await sut.forBirthdayMemories(user.id, target);

      expect(people).toEqual([
        { personGroupId: person.personGroupId, name: 'Alice', birthDate: { year: 1990, month: 6, day: 13 } },
      ]);
    });

    it('should not return hidden people, unnamed people, or people without a birth date', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await ctx.newPerson({ ownerId: user.id, name: 'Alice', birthDate: '1990-06-13', isHidden: true });
      await ctx.newPerson({ ownerId: user.id, name: '', birthDate: '1990-06-13' });
      await ctx.newPerson({ ownerId: user.id, name: 'Carol', birthDate: null });

      const people = await sut.forBirthdayMemories(user.id, target);

      expect(people).toEqual([]);
    });

    it('should not return people belonging to another user', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      await ctx.newPerson({ ownerId: otherUser.id, name: 'Alice', birthDate: '1990-06-13' });

      const people = await sut.forBirthdayMemories(user.id, target);

      expect(people).toEqual([]);
    });

    it('should not return people born in the target year', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await ctx.newPerson({ ownerId: user.id, name: 'Alice', birthDate: '2025-06-13' });

      const people = await sut.forBirthdayMemories(user.id, target);

      expect(people).toEqual([]);
    });

    it('should include leap-day birthdays on february 28th of non-leap years', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Alice', birthDate: '1992-02-29' });

      const people = await sut.forBirthdayMemories(user.id, { year: 2025, month: 2, day: 28 });

      expect(people.map(({ personGroupId }) => personGroupId)).toEqual([person.personGroupId]);
    });

    it('should include people born on february 28th on february 28th of non-leap years', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Alice', birthDate: '1991-02-28' });

      const people = await sut.forBirthdayMemories(user.id, { year: 2025, month: 2, day: 28 });

      expect(people.map(({ personGroupId }) => personGroupId)).toEqual([person.personGroupId]);
    });

    it('should not include leap-day birthdays on february 28th of leap years', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await ctx.newPerson({ ownerId: user.id, name: 'Alice', birthDate: '1992-02-29' });

      const people = await sut.forBirthdayMemories(user.id, { year: 2024, month: 2, day: 28 });

      expect(people).toEqual([]);
    });

    it('should include leap-day birthdays on february 29th of leap years', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Alice', birthDate: '1992-02-29' });

      const people = await sut.forBirthdayMemories(user.id, { year: 2024, month: 2, day: 29 });

      expect(people.map(({ personGroupId }) => personGroupId)).toEqual([person.personGroupId]);
    });
  });

  describe('getForFeatureFaceUpdate', () => {
    it('should ignore soft deleted faces', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: asset.id, deletedAt: new Date(), personGroupId: person.personGroupId });

      await expect(
        sut.getForFeatureFaceUpdate({ personGroupId: person.personGroupId, assetId: asset.id }),
      ).resolves.toEqual(undefined);
    });
  });

  describe('getAllForUser', () => {
    it('should return the user own people', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const person = await newNamedPerson(ctx, user.id, 'Alice');

      await expect(listFor(sut, user.id)).resolves.toEqual([
        expect.objectContaining({ ownerId: user.id, personGroupId: person.personGroupId, name: 'Alice' }),
      ]);
    });

    it('should not return people belonging to another user', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];
      await newNamedPerson(ctx, user1.id, 'Alice');

      await expect(listFor(sut, user2.id)).resolves.toEqual([]);
    });

    it('should return a person shared with the user', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: owner }, { user: sharedWith }] = [await ctx.newUser(), await ctx.newUser()];
      const person = await newNamedPerson(ctx, owner.id, 'Alice');

      await ctx.get(PersonUserRepository).createAll([
        {
          personGroupId: person.personGroupId,
          sharedById: owner.id,
          sharedWithId: sharedWith.id,
          role: PersonUserRole.Read,
        },
      ]);

      await expect(listFor(sut, sharedWith.id, { partnerIds: [owner.id] })).resolves.toEqual([
        expect.objectContaining({
          ownerId: sharedWith.id,
          personGroupId: person.personGroupId,
          // the trigger seeds the name from the sharer
          name: 'Alice',
          otherPeople: [expect.objectContaining({ sharedById: owner.id, name: 'Alice' })],
        }),
      ]);
    });

    it('should not return a shared person without any visible faces', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: owner }, { user: sharedWith }] = [await ctx.newUser(), await ctx.newUser()];
      const { result: person } = await ctx.newPerson({ ownerId: owner.id, name: 'Alice' });

      await ctx.get(PersonUserRepository).createAll([
        {
          personGroupId: person.personGroupId,
          sharedById: owner.id,
          sharedWithId: sharedWith.id,
          role: PersonUserRole.Read,
        },
      ]);

      await expect(listFor(sut, sharedWith.id, { partnerIds: [owner.id] })).resolves.toEqual([]);
    });

    it('should not return a shared person whose faces are only on assets the user cannot see', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: owner }, { user: sharedWith }] = [await ctx.newUser(), await ctx.newUser()];
      const person = await newNamedPerson(ctx, owner.id, 'Alice');

      await ctx.get(PersonUserRepository).createAll([
        {
          personGroupId: person.personGroupId,
          sharedById: owner.id,
          sharedWithId: sharedWith.id,
          role: PersonUserRole.Read,
        },
      ]);

      await expect(listFor(sut, sharedWith.id)).resolves.toEqual([]);
    });

    it('should count faces on partner assets', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: owner }, { user: partner }] = [await ctx.newUser(), await ctx.newUser()];
      const { result: person } = await ctx.newPerson({ ownerId: owner.id, name: '' });
      for (let i = 0; i < 3; i++) {
        const { asset } = await ctx.newAsset({ ownerId: partner.id });
        await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      }

      await expect(listFor(sut, owner.id)).resolves.toEqual([]);
      await expect(listFor(sut, owner.id, { partnerIds: [partner.id] })).resolves.toEqual([
        expect.objectContaining({ ownerId: owner.id, personGroupId: person.personGroupId }),
      ]);
    });

    it('should count people with the same rules as the list', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: owner }, { user: partner }] = [await ctx.newUser(), await ctx.newUser()];
      const named = await newNamedPerson(ctx, owner.id, 'Alice');
      await ctx.database
        .updateTable('person')
        .set({ isHidden: true })
        .where('personGroupId', '=', named.personGroupId)
        .execute();
      await ctx.newPerson({ ownerId: owner.id, name: '' });
      const { result: onPartnerAssets } = await ctx.newPerson({ ownerId: owner.id, name: '' });
      for (let i = 0; i < 3; i++) {
        const { asset } = await ctx.newAsset({ ownerId: partner.id });
        await ctx.newAssetFace({ assetId: asset.id, personGroupId: onPartnerAssets.personGroupId });
      }

      await expect(sut.getNumberOfPeople(owner.id, { partnerIds: [] })).resolves.toEqual({ total: 1, hidden: 1 });
      await expect(sut.getNumberOfPeople(owner.id, { partnerIds: [partner.id] })).resolves.toEqual({
        total: 2,
        hidden: 1,
      });
    });

    it('should require unnamed people to meet the minimum face count', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { result: person } = await ctx.newPerson({ ownerId: user.id, name: '' });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      await expect(listFor(sut, user.id)).resolves.toEqual([]);
    });

    it('should stop returning a shared person once the user deletes their copy', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: owner }, { user: sharedWith }] = [await ctx.newUser(), await ctx.newUser()];
      const person = await newNamedPerson(ctx, owner.id, 'Alice');

      await ctx.get(PersonUserRepository).createAll([
        {
          personGroupId: person.personGroupId,
          sharedById: owner.id,
          sharedWithId: sharedWith.id,
          role: PersonUserRole.Read,
        },
      ]);
      await expect(listFor(sut, sharedWith.id, { partnerIds: [owner.id] })).resolves.toHaveLength(1);

      await sut.delete([person.personGroupId], sharedWith.id);

      await expect(listFor(sut, sharedWith.id, { partnerIds: [owner.id] })).resolves.toEqual([]);
      // the owner still has theirs
      await expect(listFor(sut, owner.id)).resolves.toHaveLength(1);
    });

    it('should exclude hidden people unless asked for them', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const visible = await newNamedPerson(ctx, user.id, 'Alice');
      const hidden = await newNamedPerson(ctx, user.id, 'Bob');
      await ctx.database
        .updateTable('person')
        .set({ isHidden: true })
        .where('personGroupId', '=', hidden.personGroupId)
        .execute();

      await expect(listFor(sut, user.id)).resolves.toEqual([
        expect.objectContaining({ personGroupId: visible.personGroupId }),
      ]);
      await expect(listFor(sut, user.id, { withHidden: true })).resolves.toHaveLength(2);
    });
  });

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
        personGroupId: person.personGroupId,
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
            id: person.personGroupId,
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
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

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
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: blank.personGroupId });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: zed.personGroupId });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: alice.personGroupId });

      const { items } = await sut.getAllForLibrary(library.id, { take: 500 });

      expect(items.map((p) => p.id)).toEqual([alice.personGroupId, zed.personGroupId, blank.personGroupId]);
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
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: alice.personGroupId });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: bob.personGroupId });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: cara.personGroupId });

      const firstPage = await sut.getAllForLibrary(library.id, { take: 2 });
      expect(firstPage.items.map((p) => p.id)).toEqual([alice.personGroupId, bob.personGroupId]);
      expect(firstPage.hasNextPage).toBe(true);

      const secondPage = await sut.getAllForLibrary(library.id, { take: 2, skip: 2 });
      expect(secondPage.items.map((p) => p.id)).toEqual([cara.personGroupId]);
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
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      await expect(sut.getOneForLibrary(library.id, person.personGroupId)).resolves.toEqual(
        expect.objectContaining({ id: person.personGroupId, name: 'Alice' }),
      );
    });

    it('should return undefined for a person not reachable through this library', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { library } = await newLibrary(ctx, { ownerId: owner.id });
      const { person } = await ctx.newPerson({ ownerId: owner.id });

      await expect(sut.getOneForLibrary(library.id, person.personGroupId)).resolves.toBeUndefined();
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
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      const result = await sut.getFacesForLibraryAsset(library.id, asset.id);

      expect(result).toEqual([
        expect.objectContaining({
          id: assetFace.id,
          assetId: asset.id,
          person: { id: person.personGroupId, name: 'Alice' },
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
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      await expect(sut.getEditorRenameLibraryId(editor.id, person.personGroupId)).resolves.toBe(library.id);
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
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      await expect(sut.getEditorRenameLibraryId(viewer.id, person.personGroupId)).resolves.toBeNull();
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
      await ctx.newAssetFace({ assetId: inLibrary.id, personGroupId: person.personGroupId });
      await ctx.newAssetFace({ assetId: outside.id, personGroupId: person.personGroupId });

      await expect(sut.getEditorRenameLibraryId(editor.id, person.personGroupId)).resolves.toBeNull();
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
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

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
      await ctx.newAssetFace({ assetId: inLibrary.id, personGroupId: person.personGroupId });
      for (let i = 0; i < 3; i++) {
        const { asset: outside } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Timeline });
        await ctx.newAssetFace({ assetId: outside.id, personGroupId: person.personGroupId });
      }

      const result = await sut.getAllForSharedLibraries([library.id], { take: 500, skip: 0 }, 3);
      // Only 1 in-library face and an empty name - below the minimumFaces=3 threshold, so excluded
      // even though the person has 4 faces globally.
      expect(result.items.map((p) => p.personGroupId)).not.toContain(person.personGroupId);
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
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      const result = await sut.getAllForSharedLibraries([library.id], { take: 500, skip: 0 }, 3);
      expect(result.items.map((p) => p.personGroupId)).toEqual([person.personGroupId]);
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
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId, timestampMs: 2000 });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId, timestampMs: 4000 });

      const result = await sut.getAllForSharedLibraries([library.id], { take: 500, skip: 0 }, 3);
      expect(result.items.map((p) => p.personGroupId)).toEqual([person.personGroupId]);
    });
  });

  describe('getByNameWithSharedLibraries (Phase 5)', () => {
    it("should find the caller's own person by name", async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Alice Smith' });

      const result = await sut.getByNameWithSharedLibraries(owner.id, [], 'Alice', { withHidden: false });
      expect(result.map((p) => p.personGroupId)).toEqual([person.personGroupId]);
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
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: visible.personGroupId });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: hidden.personGroupId });

      const result = await sut.getByNameWithSharedLibraries(sharee.id, [library.id], 'Bob', { withHidden: false });
      expect(result.map((p) => p.personGroupId)).toEqual([visible.personGroupId]);
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
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

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
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

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
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

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
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      await expect(sut.isFeatureFaceInSharedLibrary(sharee.id, assetFace.id)).resolves.toBe(false);

      // sanity check: un-hiding restores the gate, proving isHidden was the only blocker
      await ctx.database
        .updateTable('person')
        .set({ isHidden: false })
        .where('personGroupId', '=', person.personGroupId)
        .execute();
      await expect(sut.isFeatureFaceInSharedLibrary(sharee.id, assetFace.id)).resolves.toBe(true);
    });
  });
});
