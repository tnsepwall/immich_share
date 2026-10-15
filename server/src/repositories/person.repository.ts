import { Injectable } from '@nestjs/common';
import {
  type Expression,
  type ExpressionBuilder,
  type Insertable,
  type Kysely,
  type Selectable,
  type ShallowDehydrateObject,
  type SqlBool,
  type Transaction,
  type Updateable,
  expressionBuilder,
  sql,
} from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { AssetFace, PersonUser, columns } from 'src/database.js';
import { Chunked, ChunkedArray, DummyValue, GenerateSql } from 'src/decorators.js';
import { PersonUserRole } from 'src/dtos/person.dto.js';
import {
  AssetFileType,
  AssetVisibility,
  LibraryUserRole,
  SharingDirection,
  SourceType,
  UserMetadataKey,
} from 'src/enum.js';
import { type YearMonthDay } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
import { FaceSearchTable } from 'src/schema/tables/face-search.table.js';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { PersonTable } from 'src/schema/tables/person.table.js';
import { anyUuid, dummy, inSharedAlbum, removeUndefinedKeys, withFilePath } from 'src/utils/database.js';
import { isLeapDayObserved } from 'src/utils/date.js';
import { type PaginationOptions, paginationHelper } from 'src/utils/pagination.js';

type PersonGroupRow = {
  ownedPerson: ShallowDehydrateObject<Selectable<PersonTable>>;
  otherPeople: { sharedById: string; role: PersonUserRole; name: string; birthDate: string | null }[];
  sharedBy: PersonUser[];
  sharedWith: PersonUser[];
};

export interface PersonFilterOptions {
  sharedById?: string;
  sharedWithId?: string;
  isFavorite?: boolean;
  isHidden?: boolean;
  name?: string;
}

export interface PersonCountOptions extends PersonFilterOptions {
  partnerIds: string[];
}

export interface PersonSearchOptions extends PersonCountOptions {
  withHidden: boolean;
  closestFaceAssetId?: string;
}

export interface PersonNameSearchOptions {
  withHidden?: boolean;
}

export interface PersonNameResponse {
  personGroupId: string;
  name: string;
}

export interface AssetFaceId {
  assetId: string;
  personGroupId: string;
}

export interface UpdateGroupIdData {
  oldPersonGroupId: string;
  ownerId: string;
  newPersonGroupId: string;
}

export interface UpdateFacesData {
  oldPersonGroupId?: string;
  faceIds?: string[];
  ownerId?: string;
  newPersonGroupId: string;
}

export interface PersonStatistics {
  assets: number;
}

export interface DeleteFacesOptions {
  sourceType: SourceType;
}

export interface GetAllPeopleOptions {
  ownerId?: string;
  thumbnailPath?: string;
  faceAssetId?: string | null;
  isHidden?: boolean;
}

export interface GetAllFacesOptions {
  personGroupId?: string | null;
  assetId?: string;
  sourceType?: SourceType;
  clusterGroupId?: string;
}

export type UnassignFacesOptions = DeleteFacesOptions & { clusterGroupId?: string };

export type GetFacesOptions = WithPersonOptions & {
  isVisible?: boolean;
  /** fork: also select the library owner's person row (`libraryPerson`) */
  libraryOwnerId?: string;
};

/** a person is identified by its owner and the group it belongs to */
export type PersonId = { ownerId: string; personGroupId: string };

export type ReassignCluster = { userId: string; newClusterId: string };

export type WithPersonOptions = {
  /** whose version of the person to select */
  viewingUserId: string;
};

const withOwnedPerson = (userId: string) => {
  return (eb: ExpressionBuilder<DB, 'person_group'>) =>
    jsonObjectFrom(
      eb
        .selectFrom('person')
        .selectAll('person')
        .whereRef('person.personGroupId', '=', 'person_group.id')
        .where('person.ownerId', '=', userId),
    )
      .$notNull()
      .as('ownedPerson');
};

const withOtherPeopleFor = (userId: string, personGroupId: Expression<string>) =>
  jsonArrayFrom(
    expressionBuilder<DB>()
      .selectFrom('person as other')
      .innerJoin('person_user', (join) =>
        join
          .onRef('person_user.personGroupId', '=', 'other.personGroupId')
          .onRef('person_user.sharedById', '=', 'other.ownerId')
          .on('person_user.sharedWithId', '=', userId),
      )
      .select(['person_user.sharedById', 'person_user.role', 'other.name', 'other.birthDate'])
      .where('other.personGroupId', '=', personGroupId),
  ).as('otherPeople');

const withPersonUsersFor = (userId: string, personGroupId: Expression<string>, direction: SharingDirection) => {
  const [userColumn, viewerColumn] =
    direction === SharingDirection.SharedBy
      ? (['person_user.sharedById', 'person_user.sharedWithId'] as const)
      : (['person_user.sharedWithId', 'person_user.sharedById'] as const);

  return jsonArrayFrom(
    expressionBuilder<DB>()
      .selectFrom('person_user')
      .innerJoin('user', (join) => join.onRef('user.id', '=', userColumn).on('user.deletedAt', 'is', null))
      .select(columns.user)
      .select('person_user.role')
      .where('person_user.personGroupId', '=', personGroupId)
      .where(viewerColumn, '=', userId)
      .orderBy('user.name'),
  )
    .$castTo<PersonUser[]>()
    .as(direction === SharingDirection.SharedBy ? 'sharedBy' : 'sharedWith');
};

const withSharing = (userId: string, personGroupId: Expression<string>) => [
  withOtherPeopleFor(userId, personGroupId),
  withPersonUsersFor(userId, personGroupId, SharingDirection.SharedBy),
  withPersonUsersFor(userId, personGroupId, SharingDirection.SharedWith),
];

const withOtherPeople = (userId: string) => {
  return (eb: ExpressionBuilder<DB, 'person_group'>) => withSharing(userId, eb.ref('person_group.id'));
};

const withOtherPeopleForPerson = (userId: string) => {
  return (eb: ExpressionBuilder<DB, 'person'>) => withSharing(userId, eb.ref('person.personGroupId'));
};

const withFilters = (userId: string, options: PersonFilterOptions = {}) => {
  const { sharedById, sharedWithId, isFavorite, isHidden, name } = options;
  return (
    eb: ExpressionBuilder<
      DB & { owned: DB['person']; similarity_threshold: unknown },
      'person_group' | 'owned' | 'similarity_threshold'
    >,
  ) => {
    const filters: Expression<SqlBool>[] = [];

    if (sharedById || sharedWithId) {
      filters.push(
        eb.exists(
          eb
            .selectFrom('person_user')
            .whereRef('person_user.personGroupId', '=', 'person_group.id')
            // only consider shares that involve the current user
            .where((eb) =>
              eb.or([eb('person_user.sharedById', '=', userId), eb('person_user.sharedWithId', '=', userId)]),
            )
            .$if(!!sharedById, (qb) => qb.where('person_user.sharedById', '=', sharedById!))
            .$if(!!sharedWithId, (qb) => qb.where('person_user.sharedWithId', '=', sharedWithId!)),
        ),
      );
    }

    if (isFavorite !== undefined) {
      filters.push(eb('owned.isFavorite', '=', isFavorite));
    }

    if (isHidden !== undefined) {
      filters.push(eb('owned.isHidden', '=', isHidden));
    }

    if (name !== undefined) {
      filters.push(sql`f_unaccent("owned"."name") %> f_unaccent(${name})`);
    }

    return eb.and(filters);
  };
};

const asPerson = ({ ownedPerson, otherPeople, sharedBy, sharedWith }: PersonGroupRow) => ({
  ...ownedPerson,
  otherPeople,
  sharedBy,
  sharedWith,
});

const withPerson = ({ viewingUserId }: WithPersonOptions) => {
  return (eb: ExpressionBuilder<DB, 'asset_face'>) =>
    jsonObjectFrom(
      eb
        .selectFrom('person')
        .selectAll('person')
        .select(withOtherPeopleForPerson(viewingUserId))
        .whereRef('person.personGroupId', '=', 'asset_face.personGroupId')
        .where('person.ownerId', '=', viewingUserId),
    ).as('person');
};

const withFaceSearch = (eb: ExpressionBuilder<DB, 'asset_face'>) => {
  return jsonObjectFrom(
    eb.selectFrom('face_search').selectAll('face_search').whereRef('face_search.faceId', '=', 'asset_face.id'),
  ).as('faceSearch');
};

// A face counts as "in this library" only through a non-deleted, Timeline-visibility asset that actually belongs
// to the library - the same visible/non-deleted rules Phase 1's checkSharedLibraryAccess already enforces for
// asset reads, applied here to face/person scoping instead.
//
// Upstream v3.3 person model: a person is (ownerId, personGroupId) and faces point at the group. Library assets
// are owned by the library owner, so every shared-library person path resolves the OWNER's row of the group
// (`person.ownerId = library.ownerId`); person ids exposed to the API are group ids, as upstream does.
const joinLibraryAsset = (libraryId: string) => (join: any) =>
  join
    .onRef('asset.id', '=', 'asset_face.assetId')
    .on('asset.libraryId', '=', libraryId)
    .on('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
    .on('asset.deletedAt', 'is', null);

const withLibraryThumbnailFace = (libraryId: string) => (eb: ExpressionBuilder<DB, 'person'>) => {
  return jsonObjectFrom(
    eb
      .selectFrom('asset_face')
      .innerJoin('asset', joinLibraryAsset(libraryId))
      .select([
        'asset_face.id as faceId',
        'asset_face.assetId',
        'asset_face.boundingBoxX1',
        'asset_face.boundingBoxY1',
        'asset_face.boundingBoxX2',
        'asset_face.boundingBoxY2',
        'asset_face.imageWidth',
        'asset_face.imageHeight',
      ])
      .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', '=', true)
      .limit(1),
  ).as('thumbnailFace');
};

// The library owner's people that have a visible face in the library: `person` rows joined to the library so
// the owner's row of each group is the one selected.
const libraryPeople = (db: Kysely<DB>, libraryId: string) =>
  db
    .selectFrom('person')
    .innerJoin('library', (join) =>
      join.onRef('library.ownerId', '=', 'person.ownerId').on('library.id', '=', libraryId),
    )
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('asset_face')
          .innerJoin('asset', joinLibraryAsset(libraryId))
          .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
          .where('asset_face.deletedAt', 'is', null)
          .where('asset_face.isVisible', '=', true),
      ),
    );

// Re-verifies library role INSIDE a transaction - mirrors AssetRepository#updateLibraryAssetMetadata's own
// inline role check exactly (library must be non-deleted with a non-deleted owner; actor is the owner, or
// holds an active Editor library_user row). Returns the library row (for its ownerId) if authorized, else null.
const checkLibraryEditorAccessTx = async (trx: Transaction<DB>, libraryId: string, actorId: string) => {
  const library = await trx
    .selectFrom('library')
    .innerJoin('user as owner', (join) =>
      join.onRef('owner.id', '=', 'library.ownerId').on('owner.deletedAt', 'is', null),
    )
    .select('library.ownerId')
    .where('library.id', '=', libraryId)
    .where('library.deletedAt', 'is', null)
    .executeTakeFirst();

  if (!library) {
    return null;
  }

  if (library.ownerId === actorId) {
    return library;
  }

  const share = await trx
    .selectFrom('library_user')
    .select('role')
    .where('libraryId', '=', libraryId)
    .where('userId', '=', actorId)
    .executeTakeFirst();

  return share?.role === LibraryUserRole.Editor ? library : null;
};

const getInScopeFaceIdsTx = async (
  trx: Transaction<DB>,
  libraryId: string,
  faceIds: string[],
): Promise<Set<string>> => {
  if (faceIds.length === 0) {
    return new Set();
  }

  const rows = await trx
    .selectFrom('asset_face')
    .select('asset_face.id')
    .innerJoin('asset', joinLibraryAsset(libraryId))
    .where('asset_face.id', 'in', faceIds)
    .where('asset_face.deletedAt', 'is', null)
    .where('asset_face.isVisible', '=', true)
    .execute();

  return new Set(rows.map((row) => row.id));
};

const isPersonInLibraryScopeTx = async (
  trx: Transaction<DB>,
  libraryId: string,
  { ownerId, personGroupId }: PersonId,
): Promise<boolean> => {
  const result = await trx
    .selectFrom('person')
    .select('person.personGroupId')
    .where('person.ownerId', '=', ownerId)
    .where('person.personGroupId', '=', personGroupId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('asset_face')
          .innerJoin('asset', joinLibraryAsset(libraryId))
          .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
          .where('asset_face.deletedAt', 'is', null)
          .where('asset_face.isVisible', '=', true),
      ),
    )
    .executeTakeFirst();

  return !!result;
};

const isAssetInLibraryScopeTx = async (trx: Transaction<DB>, libraryId: string, assetId: string): Promise<boolean> => {
  const result = await trx
    .selectFrom('asset')
    .select('asset.id')
    .where('asset.id', '=', assetId)
    .where('asset.libraryId', '=', libraryId)
    .where('asset.deletedAt', 'is', null)
    .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
    .executeTakeFirst();

  return !!result;
};

// "Exclusive" means zero non-deleted faces outside this library, counting trashed (soft-deleted) OUTSIDE
// assets as still present - a trashed asset is restorable, so a face on one is a real, if dormant, footprint
// elsewhere that must still block a rename. Only genuinely deleted (hard-removed) rows drop out of either
// count, via the WHERE clause below; the join itself carries no asset.deletedAt filter on either side. Only the
// owner's own assets count: in a cluster group other users' faces share the group id but not this person row.
const isPersonExclusiveToLibraryTx = async (
  trx: Transaction<DB>,
  libraryId: string,
  { ownerId, personGroupId }: PersonId,
): Promise<boolean> => {
  const result = await trx
    .selectFrom('asset_face')
    .innerJoin('asset', (join) => join.onRef('asset.id', '=', 'asset_face.assetId').on('asset.ownerId', '=', ownerId))
    .select((eb) => [
      eb.fn.countAll<number>().filterWhere('asset.libraryId', '=', libraryId).as('insideCount'),
      eb.fn
        .countAll<number>()
        .filterWhere((eb) => eb.or([eb('asset.libraryId', 'is', null), eb('asset.libraryId', '!=', libraryId)]))
        .as('outsideCount'),
    ])
    .where('asset_face.personGroupId', '=', personGroupId)
    .where('asset_face.deletedAt', 'is', null)
    .executeTakeFirst();

  return !!result && Number(result.insideCount) > 0 && Number(result.outsideCount) === 0;
};

// Shared face-reassignment + feature-photo bookkeeping, used by both createPersonForLibrary and
// assignFacesForLibrary. Mirrors PersonService.reassignFaces/createNewFeaturePhoto's exact bookkeeping: if a
// moved face was its old person's designated feature face, that person needs a replacement chosen from
// whatever faces remain (if none remain, mirrors the existing owner-flow behavior of leaving faceAssetId
// stale rather than clearing it, and not queuing a refresh job). Returns the person GROUP ids (all owned by
// `ownerId`) whose feature photo was actually updated, so the caller can queue JobName.PersonGenerateThumbnail
// for each AFTER this transaction commits (job queuing is an external side effect and must not run inside
// the DB transaction).
const reassignFacesTx = async (
  trx: Transaction<DB>,
  ownerId: string,
  targetPersonGroupId: string,
  faceIds: string[],
): Promise<Set<string>> => {
  const needsFeaturePhoto = new Set<string>();
  const ownerPerson = (personGroupId: string) =>
    trx
      .selectFrom('person')
      .select(['person.personGroupId', 'person.faceAssetId'])
      .where('person.ownerId', '=', ownerId)
      .where('person.personGroupId', '=', personGroupId)
      .executeTakeFirst();

  const target = await ownerPerson(targetPersonGroupId);
  if (target && !target.faceAssetId) {
    needsFeaturePhoto.add(targetPersonGroupId);
  }

  for (const faceId of faceIds) {
    const face = await trx
      .selectFrom('asset_face')
      .select(['id', 'personGroupId'])
      .where('id', '=', faceId)
      .executeTakeFirst();

    if (face?.personGroupId) {
      const oldPerson = await ownerPerson(face.personGroupId);
      if (oldPerson && oldPerson.faceAssetId === faceId) {
        needsFeaturePhoto.add(oldPerson.personGroupId);
      }
    }

    await trx.updateTable('asset_face').set({ personGroupId: targetPersonGroupId }).where('id', '=', faceId).execute();
  }

  for (const personGroupId of needsFeaturePhoto) {
    const replacement = await trx
      .selectFrom('asset_face')
      .innerJoin('asset', (join) => join.onRef('asset.id', '=', 'asset_face.assetId').on('asset.ownerId', '=', ownerId))
      .select('asset_face.id')
      .where('asset_face.personGroupId', '=', personGroupId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', '=', true)
      .executeTakeFirst();

    if (replacement) {
      await trx
        .updateTable('person')
        .set({ faceAssetId: replacement.id })
        .where('person.ownerId', '=', ownerId)
        .where('person.personGroupId', '=', personGroupId)
        .execute();
    } else {
      needsFeaturePhoto.delete(personGroupId);
    }
  }

  return needsFeaturePhoto;
};

@Injectable()
export class PersonRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [{ oldPersonGroupId: DummyValue.UUID, newPersonGroupId: DummyValue.UUID }] })
  async reassignFaces({ oldPersonGroupId, faceIds, ownerId, newPersonGroupId }: UpdateFacesData): Promise<number> {
    const result = await this.db
      .updateTable('asset_face')
      .from('asset')
      .whereRef('asset_face.assetId', '=', 'asset.id')
      .set({ personGroupId: newPersonGroupId })
      .$if(!!oldPersonGroupId, (qb) => qb.where('asset_face.personGroupId', '=', oldPersonGroupId!))
      .$if(!!faceIds, (qb) => qb.where('asset_face.id', 'in', faceIds!))
      .$if(!!ownerId, (qb) => qb.where('asset.ownerId', '=', ownerId!))
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0);
  }

  @GenerateSql({ params: [{ oldPersonGroupId: DummyValue.UUID, newPersonGroupId: DummyValue.UUID }] })
  updateGroupId({ oldPersonGroupId, ownerId, newPersonGroupId }: UpdateGroupIdData) {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('asset_face')
        .from('asset')
        .whereRef('asset_face.assetId', '=', 'asset.id')
        .set({ personGroupId: newPersonGroupId })
        .where('asset_face.personGroupId', '=', oldPersonGroupId)
        .where('asset.ownerId', '=', ownerId)
        .executeTakeFirst();

      return trx
        .updateTable('person')
        .set({ personGroupId: newPersonGroupId })
        .where('person.personGroupId', '=', oldPersonGroupId)
        .where('person.ownerId', '=', ownerId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  @GenerateSql({ params: [{ sourceType: SourceType.MachineLearning, clusterGroupId: DummyValue.UUID }] })
  async unassignFaces({ sourceType, clusterGroupId }: UnassignFacesOptions): Promise<void> {
    await this.db
      .updateTable('asset_face')
      .set({ personGroupId: null })
      .from('asset')
      .whereRef('asset_face.assetId', '=', 'asset.id')
      .where('asset_face.sourceType', '=', sourceType)
      .$if(!!clusterGroupId, (qb) =>
        qb.innerJoin('user', 'user.id', 'asset.ownerId').where('user.clusterGroupId', '=', clusterGroupId!),
      )
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.UUID] })
  @Chunked()
  async delete(personGroupIds: string[], ownerId?: string) {
    if (personGroupIds.length === 0) {
      return [];
    }

    return this.db
      .deleteFrom('person')
      .$if(!!ownerId, (qb) => qb.where('ownerId', '=', ownerId!))
      .where('person.personGroupId', 'in', personGroupIds)
      .returning(['personGroupId', 'ownerId', 'thumbnailPath'])
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  async deleteGroups(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db.deleteFrom('person_group').where('person_group.id', 'in', ids).execute();
  }

  @GenerateSql()
  async deleteEmptyGroups(): Promise<number> {
    const result = await this.db
      .deleteFrom('person_group')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('person')
              .whereRef('person.personGroupId', '=', 'person_group.id')
              .select('person.personGroupId'),
          ),
        ),
      )
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  @GenerateSql()
  async deleteOrphanedClusterGroups(): Promise<number> {
    const result = await this.db
      .deleteFrom('cluster_group')
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('user').whereRef('user.clusterGroupId', '=', 'cluster_group.id').select('user.id'))),
      )
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  async deleteFaces({ sourceType }: DeleteFacesOptions): Promise<void> {
    // Video-frame faces (timestampMs set) are owned by the video face detection pipeline, which
    // resets them itself; the (photo) face detection reset must not silently discard them.
    await this.db
      .deleteFrom('asset_face')
      .where('asset_face.sourceType', '=', sourceType)
      .where('asset_face.timestampMs', 'is', null)
      .execute();
  }

  // All machine-learning faces for an asset (the thumbnail-derived face with a null timestampMs
  // plus every sampled video-frame face), so clustering can deduplicate video faces against the
  // pre-existing single-frame face rather than leaving a near-duplicate behind.
  @GenerateSql({ params: [DummyValue.UUID] })
  getVideoFacesWithEmbeddings(assetId: string) {
    return (
      this.db
        .selectFrom('asset_face')
        .innerJoin('face_search', 'face_search.faceId', 'asset_face.id')
        .select([
          'asset_face.id',
          'asset_face.imageWidth',
          'asset_face.imageHeight',
          'asset_face.boundingBoxX1',
          'asset_face.boundingBoxY1',
          'asset_face.boundingBoxX2',
          'asset_face.boundingBoxY2',
          'asset_face.timestampMs',
          'face_search.embedding',
        ])
        .where('asset_face.assetId', '=', assetId)
        .where('asset_face.sourceType', '=', SourceType.MachineLearning)
        .where('asset_face.deletedAt', 'is', null)
        // stable ordering so equal-area cluster ties resolve the same way on every run
        .orderBy('asset_face.id')
        .execute()
    );
  }

  // People whose feature photo is anchored to one of the given faces; deleting those faces would
  // null person.faceAssetId (FK is SET NULL), so callers must re-pick a feature photo afterwards.
  @GenerateSql({ params: [[DummyValue.UUID]] })
  getPersonIdsByFaceAssetIds(faceIds: string[]) {
    return this.db
      .selectFrom('person')
      .select(['person.ownerId', 'person.personGroupId'])
      .where('person.faceAssetId', 'in', faceIds)
      .execute();
  }

  // Video-frame faces only (timestampMs set), used to clear a prior run before re-detecting so
  // repeated video face detection replaces rather than appends.
  @GenerateSql({ params: [DummyValue.UUID] })
  getVideoFaceIds(assetId: string) {
    return this.db
      .selectFrom('asset_face')
      .select(['asset_face.id'])
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.timestampMs', 'is not', null)
      .where('asset_face.sourceType', '=', SourceType.MachineLearning)
      .where('asset_face.deletedAt', 'is', null)
      .execute();
  }

  @GenerateSql({
    params: [{ personGroupId: null, sourceType: SourceType.MachineLearning, clusterGroupId: DummyValue.UUID }],
    stream: true,
  })
  getAllFaces(options: GetAllFacesOptions = {}) {
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .$if(options.personGroupId === null, (qb) => qb.where('asset_face.personGroupId', 'is', null))
      .$if(!!options.personGroupId, (qb) => qb.where('asset_face.personGroupId', '=', options.personGroupId!))
      .$if(!!options.sourceType, (qb) => qb.where('asset_face.sourceType', '=', options.sourceType!))
      .$if(!!options.assetId, (qb) => qb.where('asset_face.assetId', '=', options.assetId!))
      .$if(!!options.clusterGroupId, (qb) =>
        qb
          .innerJoin('asset', 'asset.id', 'asset_face.assetId')
          .innerJoin('user', 'user.id', 'asset.ownerId')
          .where('user.clusterGroupId', '=', options.clusterGroupId!),
      )
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .stream();
  }

  getAll(options: GetAllPeopleOptions = {}) {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .$if(!!options.ownerId, (qb) => qb.where('person.ownerId', '=', options.ownerId!))
      .$if(options.thumbnailPath !== undefined, (qb) => qb.where('person.thumbnailPath', '=', options.thumbnailPath!))
      .$if(options.faceAssetId === null, (qb) => qb.where('person.faceAssetId', 'is', null))
      .$if(!!options.faceAssetId, (qb) => qb.where('person.faceAssetId', '=', options.faceAssetId!))
      .$if(options.isHidden !== undefined, (qb) => qb.where('person.isHidden', '=', options.isHidden!))
      .stream();
  }

  @GenerateSql(
    { params: [DummyValue.UUID, { year: 2025, month: 1, day: 1 }] },
    { name: 'leap day fallback', params: [DummyValue.UUID, { year: 2025, month: 2, day: 28 }] },
  )
  async forBirthdayMemories(ownerId: string, { year, month, day }: YearMonthDay) {
    const isLeapDayBirthday = isLeapDayObserved({ year, month, day });

    const people = await this.db
      .selectFrom('person')
      .select(['person.personGroupId', 'person.name'])
      .select(sql<number>`date_part('year', person."birthDate")::int`.as('birthYear'))
      .select(sql<number>`date_part('month', person."birthDate")::int`.as('birthMonth'))
      .select(sql<number>`date_part('day', person."birthDate")::int`.as('birthDay'))
      .where('person.ownerId', '=', ownerId)
      .where('person.isHidden', '=', false)
      .where('person.name', '!=', '')
      .where('person.birthDate', 'is not', null)
      .where((eb) => {
        const bornOn = (month: number, day: number) =>
          eb.and([
            eb(sql`date_part('month', person."birthDate")::int`, '=', month),
            eb(sql`date_part('day', person."birthDate")::int`, '=', day),
          ]);

        return isLeapDayBirthday ? eb.or([bornOn(month, day), bornOn(2, 29)]) : bornOn(month, day);
      })
      .where(sql`date_part('year', person."birthDate")::int`, '<', year)
      .execute();

    return people.map(({ personGroupId, name, birthYear, birthMonth, birthDay }) => ({
      personGroupId,
      name,
      birthDate: { year: birthYear, month: birthMonth, day: birthDay },
    }));
  }

  @GenerateSql()
  getFileSamples() {
    return this.db
      .selectFrom('person')
      .select(['ownerId', 'personGroupId', 'thumbnailPath'])
      .where('thumbnailPath', '!=', sql.lit(''))
      .limit(sql.lit(3))
      .execute();
  }

  private getVisiblePeopleQuery(userId: string, partnerIds: string[]) {
    return this.db
      .with('similarity_threshold', (db) =>
        db.selectNoFrom(sql`set_config('pg_trgm.word_similarity_threshold', '0.5', true)`.as('thresh')),
      )
      .selectFrom(['similarity_threshold', 'person_group'])
      .innerJoin('person as owned', (join) =>
        join.onRef('owned.personGroupId', '=', 'person_group.id').on('owned.ownerId', '=', userId),
      )
      .innerJoin(
        (eb) =>
          eb
            .selectFrom('asset_face')
            .innerJoin('asset', (join) =>
              join
                .onRef('asset.id', '=', 'asset_face.assetId')
                .on('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
                .on('asset.deletedAt', 'is', null)
                .on((eb) =>
                  eb.or([eb('asset.ownerId', '=', anyUuid([userId, ...partnerIds])), inSharedAlbum(eb, userId)]),
                ),
            )
            .select('asset_face.personGroupId')
            .select((eb) => eb.fn.count<number>('asset.id').as('faceCount'))
            // an array instead of a join or `in`, which the planner may turn into a scan of every face in the instance
            .where('asset_face.personGroupId', '=', (eb) => {
              const ownedGroupIds = eb
                .selectFrom('person')
                .select('person.personGroupId')
                .where('person.ownerId', '=', userId);
              return eb.fn.any(eb.fn<string[]>('array', [ownedGroupIds]));
            })
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', 'is', true)
            .groupBy('asset_face.personGroupId')
            .as('faces'),
        (join) => join.onRef('faces.personGroupId', '=', 'person_group.id'),
      )
      .where((eb) =>
        eb.or([
          eb('owned.name', '!=', ''),
          eb(
            'faces.faceCount',
            '>=',
            sql<number>`COALESCE(
              (SELECT value -> 'people' ->> 'minimumFaces'
              FROM user_metadata
              WHERE "userId" = ${userId}
                AND key = ${sql.lit(UserMetadataKey.Preferences)}),
              '3'
            )::int `,
          ),
        ]),
      );
  }

  @GenerateSql({
    params: [{ take: 1, skip: 0 }, DummyValue.UUID, { withHidden: false, partnerIds: [DummyValue.UUID] }],
  })
  async getAllForUser(pagination: PaginationOptions, userId: string, options: PersonSearchOptions) {
    const items = await this.getVisiblePeopleQuery(userId, options.partnerIds)
      .select(withOwnedPerson(userId))
      .select(withOtherPeople(userId))
      .orderBy('owned.isHidden', 'asc')
      .orderBy('owned.isFavorite', 'desc')
      .$if(!!options.closestFaceAssetId, (qb) =>
        qb.orderBy((eb) =>
          eb(
            (eb) =>
              eb
                .selectFrom('face_search')
                .select('face_search.embedding')
                .whereRef('face_search.faceId', '=', 'owned.faceAssetId'),
            '<=>',
            (eb) =>
              eb
                .selectFrom('face_search')
                .select('face_search.embedding')
                .where('face_search.faceId', '=', options.closestFaceAssetId!),
          ),
        ),
      )
      .$if(!options.closestFaceAssetId, (qb) =>
        qb
          .orderBy(sql`NULLIF("owned"."name", '') is null`, 'asc')
          .orderBy('faces.faceCount', 'desc')
          .orderBy(sql`NULLIF("owned"."name", '')`, (om) => om.asc().nullsLast())
          .orderBy('owned.createdAt'),
      )
      // an explicit isHidden filter takes precedence over withHidden
      .$if(!options.withHidden && options.isHidden === undefined, (qb) => qb.where('owned.isHidden', '=', false))
      .where(withFilters(userId, options))
      .$if(!!options.name, (qb) => qb.orderBy(sql`f_unaccent("owned"."name") <->>> f_unaccent(${options.name!})`))
      .offset(pagination.skip ?? 0)
      .limit(pagination.take + 1)
      .execute();

    return paginationHelper(
      items.map((item) => asPerson(item)),
      pagination.take,
    );
  }

  // Only people with a visible face on a non-deleted Timeline asset in this exact library - the shared-library
  // Editor's people list must never surface someone represented only by assets outside the library. Each result
  // carries one representative library face (thumbnailFace) so the caller never needs the person's global
  // thumbnailPath, which may be cropped from an unshared asset (Phase 4 - see FEATURE-PLAN section 2/6).
  // `id` is the person group id (the library owner's row of the group).
  @GenerateSql({ params: [DummyValue.UUID, { take: 500 }] })
  async getAllForLibrary(libraryId: string, pagination: PaginationOptions) {
    const items = await libraryPeople(this.db, libraryId)
      .select(['person.personGroupId as id', 'person.name'])
      .select(withLibraryThumbnailFace(libraryId))
      .orderBy(sql`NULLIF(person.name, '') is null`, 'asc')
      .orderBy(sql`NULLIF(person.name, '')`, (om) => om.asc().nullsLast())
      .offset(pagination.skip ?? 0)
      .limit(pagination.take + 1)
      .execute();

    return paginationHelper(items, pagination.take);
  }

  // Single-row sibling of getAllForLibrary, for building a response after a create/rename/assign
  // mutation without re-querying (and re-shaping) the entire library person list.
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getOneForLibrary(libraryId: string, personGroupId: string) {
    return libraryPeople(this.db, libraryId)
      .select(['person.personGroupId as id', 'person.name'])
      .select(withLibraryThumbnailFace(libraryId))
      .where('person.personGroupId', '=', personGroupId)
      .executeTakeFirst();
  }

  // Phase 5 (§5.5): people listing widening - persons reachable through ANY of the caller's
  // inTimeline-shared libraries, unioned into the People page/Explore row alongside the caller's own
  // people (person.service.ts#getAll combines the two result sets). Always excludes hidden persons
  // (never gated by the caller's own `withHidden` preference - that flag is about the CALLER's own
  // people, never someone else's) and the minimumFaces threshold counts ONLY faces inside the shared
  // libraries - a person's global footprint size must never be advertised to a sharee. Returns the
  // library owner's row of each group (faces are matched on the owner's own assets).
  @GenerateSql({ params: [[DummyValue.UUID], { take: 500 }, 3] })
  async getAllForSharedLibraries(sharedLibraryIds: string[], pagination: PaginationOptions, minimumFaces: number) {
    if (sharedLibraryIds.length === 0) {
      return paginationHelper<Selectable<PersonTable>>([], pagination.take);
    }

    const items = await this.db
      .selectFrom('person')
      .selectAll('person')
      .innerJoin('asset_face', 'asset_face.personGroupId', 'person.personGroupId')
      .innerJoin('asset', (join) =>
        join
          .onRef('asset_face.assetId', '=', 'asset.id')
          .onRef('asset.ownerId', '=', 'person.ownerId')
          .on('asset.libraryId', 'in', sharedLibraryIds)
          .on('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
          .on('asset.deletedAt', 'is', null),
      )
      .where('person.isHidden', '=', false)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', '=', true)
      .groupBy(['person.ownerId', 'person.personGroupId'])
      .having((eb) =>
        eb.or([
          eb('person.name', '!=', ''),
          eb((innerEb) => innerEb.fn.count('asset_face.assetId'), '>=', minimumFaces),
        ]),
      )
      .orderBy(sql`NULLIF(person.name, '') is null`, 'asc')
      .orderBy(sql`NULLIF(person.name, '')`, (om) => om.asc().nullsLast())
      .orderBy('person.createdAt')
      .offset(pagination.skip ?? 0)
      .limit(pagination.take + 1)
      .execute();

    return paginationHelper(items, pagination.take);
  }

  // Phase 5 (§5.4): person NAME SEARCH widened alongside the owner's own persons - ORs
  // `person.ownerId = userId` with an EXISTS over the same reachability shape as
  // AccessRepository#checkSharedLibraryPersonAccess (§5.1). Deliberately a NEW method - getDistinctNames
  // keeps its owner-scoped semantics unchanged (metadata.service.ts depends on it for sidecar name
  // matching, which must never resolve to another user's person). Hidden persons are excluded from the
  // shared arm unconditionally; the owner arm still honors the caller's own `withHidden` preference.
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], DummyValue.STRING, { withHidden: true }] })
  getByNameWithSharedLibraries(
    userId: string,
    sharedLibraryIds: string[],
    personName: string,
    { withHidden }: PersonNameSearchOptions,
  ) {
    return this.db
      .with('similarity_threshold', (db) =>
        db.selectNoFrom(sql`set_config('pg_trgm.word_similarity_threshold', '0.5', true)`.as('thresh')),
      )
      .selectFrom(['similarity_threshold', 'person'])
      .selectAll('person')
      .where(() => sql`f_unaccent("person"."name") %> f_unaccent(${personName})`)
      .where((eb) => {
        const ownerArm = withHidden
          ? eb('person.ownerId', '=', userId)
          : eb.and([eb('person.ownerId', '=', userId), eb('person.isHidden', '=', false)]);

        if (sharedLibraryIds.length === 0) {
          return ownerArm;
        }

        const sharedArm = eb.and([
          eb('person.isHidden', '=', false),
          eb.exists(
            eb
              .selectFrom('asset_face')
              .innerJoin('asset', (join) =>
                join
                  .onRef('asset.id', '=', 'asset_face.assetId')
                  .onRef('asset.ownerId', '=', 'person.ownerId')
                  .on('asset.deletedAt', 'is', null),
              )
              .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
              .where('asset_face.deletedAt', 'is', null)
              .where('asset_face.isVisible', '=', true)
              .where('asset.libraryId', 'in', sharedLibraryIds)
              .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline)),
          ),
        ]);

        return eb.or([ownerArm, sharedArm]);
      })
      .orderBy(sql`f_unaccent("person"."name") <->>> f_unaccent(${personName})`)
      .limit(100)
      .execute();
  }

  // Phase 5 (§5.6): person thumbnail gate - the global thumbnailPath may be cropped from an asset
  // outside any library shared with this caller, so serving it to a non-owner is permitted ONLY when
  // the person's OWN feature face's source asset is itself in an inTimeline-shared library.
  // Reachability through some OTHER face is not sufficient (that's the whole point of this check).
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async isFeatureFaceInSharedLibrary(userId: string, faceId: string): Promise<boolean> {
    const result = await this.db
      .selectFrom('asset_face')
      .innerJoin('asset', (join) => join.onRef('asset.id', '=', 'asset_face.assetId').on('asset.deletedAt', 'is', null))
      .innerJoin('library', (join) =>
        join.onRef('library.id', '=', 'asset.libraryId').on('library.deletedAt', 'is', null),
      )
      .innerJoin('user as owner', (join) =>
        join.onRef('owner.id', '=', 'library.ownerId').on('owner.deletedAt', 'is', null),
      )
      .innerJoin('library_user', (join) =>
        join
          .onRef('library_user.libraryId', '=', 'library.id')
          .on('library_user.userId', '=', userId)
          .on('library_user.inTimeline', '=', true),
      )
      // Review finding fix (plan §5.3): never serve the crop of a person the owner has hidden -
      // hidden persons are excluded from every sharee-facing surface, this gate included.
      .innerJoin('person', (join) =>
        join
          .onRef('person.personGroupId', '=', 'asset_face.personGroupId')
          .onRef('person.ownerId', '=', 'asset.ownerId')
          .on('person.isHidden', '=', false),
      )
      .select('asset_face.id')
      .where('asset_face.id', '=', faceId)
      .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
      .executeTakeFirst();

    return !!result;
  }

  // Phase 5 (§5.3) on the v3.3 person model: the person row a shared-library recipient sees for a group they
  // have no row of their own in - the library OWNER's row, when the group has a visible face on a Timeline
  // asset of a library shared with the caller with inTimeline=true, and the owner has not hidden it.
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getForSharedLibraryViewer(userId: string, personGroupId: string) {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .where('person.personGroupId', '=', personGroupId)
      .where('person.isHidden', '=', false)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_face')
            .innerJoin('asset', (join) =>
              join
                .onRef('asset.id', '=', 'asset_face.assetId')
                .onRef('asset.ownerId', '=', 'person.ownerId')
                .on('asset.deletedAt', 'is', null)
                .on('asset.visibility', '=', sql.lit(AssetVisibility.Timeline)),
            )
            .innerJoin('library', (join) =>
              join.onRef('library.id', '=', 'asset.libraryId').on('library.deletedAt', 'is', null),
            )
            .innerJoin('user as owner', (join) =>
              join.onRef('owner.id', '=', 'library.ownerId').on('owner.deletedAt', 'is', null),
            )
            .innerJoin('library_user', (join) =>
              join
                .onRef('library_user.libraryId', '=', 'library.id')
                .on('library_user.userId', '=', userId)
                .on('library_user.inTimeline', '=', true),
            )
            .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', '=', true),
        ),
      )
      .orderBy('person.ownerId')
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql()
  getAllWithoutFaces() {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .leftJoin('asset_face', 'asset_face.personGroupId', 'person.personGroupId')
      .where('asset_face.deletedAt', 'is', null)
      .where((eb) => eb.or([eb('asset_face.isVisible', 'is', null), eb('asset_face.isVisible', '=', true)]))
      .having((eb) => eb.fn.count('asset_face.assetId'), '=', 0)
      .groupBy(['person.ownerId', 'person.personGroupId'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { viewingUserId: DummyValue.UUID, isVisible: true }] })
  getFaces(assetId: string, options: GetFacesOptions) {
    const { viewingUserId, isVisible, libraryOwnerId } = options;

    return (
      this.db
        .selectFrom('asset_face')
        .selectAll('asset_face')
        .select(withPerson({ viewingUserId }))
        // fork (Phase 5 §5.7): the library owner's row, for redacted display to a shared-library recipient
        .$if(!!libraryOwnerId, (qb) =>
          qb.select((eb) =>
            jsonObjectFrom(
              eb
                .selectFrom('person')
                .selectAll('person')
                .whereRef('person.personGroupId', '=', 'asset_face.personGroupId')
                .where('person.ownerId', '=', libraryOwnerId!),
            ).as('libraryPerson'),
          ),
        )
        .where('asset_face.assetId', '=', assetId)
        .where('asset_face.deletedAt', 'is', null)
        .$if(isVisible !== undefined, (qb) => qb.where('asset_face.isVisible', '=', isVisible!))
        .orderBy('asset_face.boundingBoxX1', 'asc')
        .execute()
    );
  }

  // Editor face-labeling panel: the asset itself is re-confirmed in-library here (defense in depth on top of the
  // service-layer access check), and the nested person is deliberately a minimal {id, name} reference, not a full
  // library-person projection - the web already has the full list (with thumbnails) from getAllForLibrary above.
  // The nested person is the asset owner's row of the face's group; `id` is the group id.
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getFacesForLibraryAsset(libraryId: string, assetId: string) {
    return (
      this.db
        .selectFrom('asset_face')
        .selectAll('asset_face')
        .innerJoin('asset', joinLibraryAsset(libraryId))
        .select((eb) =>
          jsonObjectFrom(
            eb
              .selectFrom('person')
              .select(['person.personGroupId as id', 'person.name'])
              .whereRef('person.personGroupId', '=', 'asset_face.personGroupId')
              .whereRef('person.ownerId', '=', 'asset.ownerId'),
          ).as('person'),
        )
        .where('asset_face.assetId', '=', assetId)
        .where('asset_face.deletedAt', 'is', null)
        .where('asset_face.isVisible', '=', true)
        // Video-frame faces (timestampMs set) have bounding boxes relative to a sampled frame, not the
        // preview the web renders, so they are excluded here just like the owner-side face panels do.
        .where('asset_face.timestampMs', 'is', null)
        .orderBy('asset_face.boundingBoxX1', 'asc')
        .execute()
    );
  }

  // --- Transactional primitives for the Editor's person/face curation (Phase 4) ---
  // Each mutation below re-verifies role + library scope INSIDE its own transaction, mirroring
  // AssetRepository#updateLibraryAssetMetadata's exact pattern (Phase 3): the service's outer requireAccess
  // check is a library-level fast-path only, and is NOT sufficient on its own - a role downgrade, share
  // removal, or the target entity moving out of scope between the outer check and the write must not let a
  // write through, and create-person-and-assign must never leave an orphaned, empty owner-scoped person if a
  // face turns out to be out of scope mid-flight. Returns null/false on any authorization failure; the
  // service surfaces that as a single generic 400 (no distinction that would help an attacker map scope).
  //
  // These predicates intentionally duplicate (rather than call out to) AccessRepository's equivalent
  // checkLibraryFaceScope/checkLibraryPersonScope/checkPersonExclusiveToLibrary methods, because those are
  // bound to their own injected `this.db` and cannot run against an arbitrary transaction handle - the same
  // tradeoff Phase 3 already made for checkLibraryAssetScope.
  //
  // Every person touched here is the LIBRARY OWNER's row (ownerId = library.ownerId); person ids are group ids.

  async createPersonForLibrary(
    libraryId: string,
    actorId: string,
    name: string,
    faceIds: string[],
  ): Promise<{ ownerId: string; personId: string; needsFeaturePhoto: string[] } | null> {
    return this.db.transaction().execute(async (trx) => {
      const library = await checkLibraryEditorAccessTx(trx, libraryId, actorId);
      if (!library) {
        return null;
      }

      const inScope = await getInScopeFaceIdsTx(trx, libraryId, faceIds);
      if (inScope.size !== faceIds.length) {
        return null;
      }

      // same shape as PersonRepository#createGroup: a new group in the owner's cluster group
      const group = await trx
        .insertInto('person_group')
        .columns(['clusterGroupId'])
        .expression((eb) => eb.selectFrom('user').select('user.clusterGroupId').where('user.id', '=', library.ownerId))
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('person').values({ ownerId: library.ownerId, personGroupId: group.id, name }).execute();
      const needsFeaturePhoto = await reassignFacesTx(trx, library.ownerId, group.id, faceIds);

      return { ownerId: library.ownerId, personId: group.id, needsFeaturePhoto: [...needsFeaturePhoto] };
    });
  }

  async updatePersonNameForLibrary(
    libraryId: string,
    actorId: string,
    personGroupId: string,
    name: string,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const library = await checkLibraryEditorAccessTx(trx, libraryId, actorId);
      if (!library) {
        return false;
      }

      const personId = { ownerId: library.ownerId, personGroupId };
      const inScope = await isPersonInLibraryScopeTx(trx, libraryId, personId);
      if (!inScope) {
        return false;
      }

      // Renaming reaches the person's whole catalog entry, so it's only allowed when every one of their
      // faces lives inside this library - see isPersonExclusiveToLibraryTx's own doc comment.
      const exclusive = await isPersonExclusiveToLibraryTx(trx, libraryId, personId);
      if (!exclusive) {
        return false;
      }

      await trx
        .updateTable('person')
        .set({ name })
        .where('person.ownerId', '=', library.ownerId)
        .where('person.personGroupId', '=', personGroupId)
        .execute();
      return true;
    });
  }

  // Read-side twin of updatePersonNameForLibrary's authorization chain: finds the shared library (if
  // any) through which `actorId` may rename this person. Mirrors checkLibraryEditorAccessTx (active
  // Editor share on a non-deleted library with a non-deleted owner) + isPersonInLibraryScopeTx (person
  // reachable via a visible in-library face) + isPersonExclusiveToLibraryTx (zero non-deleted faces
  // outside the library on the owner's assets, trashed assets included). Purely a UI routing hint - the
  // write path re-runs all three checks inside its own transaction.
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async getEditorRenameLibraryId(actorId: string, personGroupId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('library_user')
      .innerJoin('library', (join) =>
        join.onRef('library.id', '=', 'library_user.libraryId').on('library.deletedAt', 'is', null),
      )
      .innerJoin('user as owner', (join) =>
        join.onRef('owner.id', '=', 'library.ownerId').on('owner.deletedAt', 'is', null),
      )
      .innerJoin('person', (join) =>
        join.onRef('person.ownerId', '=', 'library.ownerId').on('person.personGroupId', '=', personGroupId),
      )
      .select('library_user.libraryId')
      .where('library_user.userId', '=', actorId)
      .where('library_user.role', '=', sql.lit(LibraryUserRole.Editor))
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_face')
            .innerJoin('asset', (join) =>
              join
                .onRef('asset.id', '=', 'asset_face.assetId')
                .onRef('asset.libraryId', '=', 'library_user.libraryId')
                .on('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
                .on('asset.deletedAt', 'is', null),
            )
            .where('asset_face.personGroupId', '=', personGroupId)
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', '=', true),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('asset_face')
              .innerJoin('asset', (join) =>
                join.onRef('asset.id', '=', 'asset_face.assetId').onRef('asset.ownerId', '=', 'library.ownerId'),
              )
              .where('asset_face.personGroupId', '=', personGroupId)
              .where('asset_face.deletedAt', 'is', null)
              .where((inner) =>
                inner.or([
                  inner('asset.libraryId', 'is', null),
                  inner('asset.libraryId', '!=', inner.ref('library_user.libraryId')),
                ]),
              ),
          ),
        ),
      )
      .limit(1)
      .executeTakeFirst();

    return row?.libraryId ?? null;
  }

  async assignFacesForLibrary(
    libraryId: string,
    actorId: string,
    personGroupId: string,
    faceIds: string[],
  ): Promise<{ ownerId: string; needsFeaturePhoto: string[] } | null> {
    return this.db.transaction().execute(async (trx) => {
      const library = await checkLibraryEditorAccessTx(trx, libraryId, actorId);
      if (!library) {
        return null;
      }

      const faceScope = await getInScopeFaceIdsTx(trx, libraryId, faceIds);
      if (faceScope.size !== faceIds.length) {
        return null;
      }

      // Can only target a person already reachable through this library (i.e. one getAllForLibrary would
      // already show) - not an arbitrary personId elsewhere in the owner's account.
      const personInScope = await isPersonInLibraryScopeTx(trx, libraryId, { ownerId: library.ownerId, personGroupId });
      if (!personInScope) {
        return null;
      }

      const needsFeaturePhoto = await reassignFacesTx(trx, library.ownerId, personGroupId, faceIds);
      return { ownerId: library.ownerId, needsFeaturePhoto: [...needsFeaturePhoto] };
    });
  }

  async createManualFaceForLibrary(
    libraryId: string,
    actorId: string,
    personGroupId: string,
    assetId: string,
    face: {
      imageWidth: number;
      imageHeight: number;
      boundingBoxX1: number;
      boundingBoxY1: number;
      boundingBoxX2: number;
      boundingBoxY2: number;
    },
  ): Promise<{ ownerId: string; faceId: string; needsFeaturePhoto: string[] } | null> {
    return this.db.transaction().execute(async (trx) => {
      const library = await checkLibraryEditorAccessTx(trx, libraryId, actorId);
      if (!library) {
        return null;
      }

      const personInScope = await isPersonInLibraryScopeTx(trx, libraryId, { ownerId: library.ownerId, personGroupId });
      if (!personInScope) {
        return null;
      }

      // The asset must genuinely be a live, Timeline-visibility member of this exact library at write time -
      // not just checked (possibly staled) before this transaction opened.
      const assetInScope = await isAssetInLibraryScopeTx(trx, libraryId, assetId);
      if (!assetInScope) {
        return null;
      }

      const created = await trx
        .insertInto('asset_face')
        .values({ personGroupId, assetId, sourceType: SourceType.Manual, ...face })
        .returningAll()
        .executeTakeFirstOrThrow();

      const target = await trx
        .selectFrom('person')
        .select(['person.personGroupId', 'person.faceAssetId'])
        .where('person.ownerId', '=', library.ownerId)
        .where('person.personGroupId', '=', personGroupId)
        .executeTakeFirst();

      const needsFeaturePhoto = new Set<string>();
      if (target && !target.faceAssetId) {
        // The face just created is itself a valid, deterministic choice - no need for a separate random pick.
        await trx
          .updateTable('person')
          .set({ faceAssetId: created.id })
          .where('person.ownerId', '=', library.ownerId)
          .where('person.personGroupId', '=', personGroupId)
          .execute();
        needsFeaturePhoto.add(personGroupId);
      }

      return { ownerId: library.ownerId, faceId: created.id, needsFeaturePhoto: [...needsFeaturePhoto] };
    });
  }

  @GenerateSql({ params: [DummyValue.UUID, { viewingUserId: DummyValue.UUID }] })
  getFaceById(id: string, { viewingUserId }: WithPersonOptions) {
    // TODO return null instead of find or fail
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson({ viewingUserId }))
      .where('asset_face.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFaceForFacialRecognitionJob(id: string) {
    return this.db
      .selectFrom('asset_face')
      .select(['asset_face.id', 'asset_face.personGroupId', 'asset_face.sourceType'])
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('asset')
            .innerJoin('user', 'user.id', 'asset.ownerId')
            .select(['asset.ownerId', 'asset.visibility', 'asset.fileCreatedAt', 'user.clusterGroupId'])
            .whereRef('asset.id', '=', 'asset_face.assetId'),
        ).as('asset'),
      )
      .select(withFaceSearch)
      .where('asset_face.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, personGroupId: DummyValue.UUID }] })
  getDataForThumbnailGenerationJob({ ownerId, personGroupId }: PersonId) {
    return this.db
      .selectFrom('person')
      .innerJoin('asset_face', 'asset_face.id', 'person.faceAssetId')
      .innerJoin('asset', 'asset_face.assetId', 'asset.id')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'person.ownerId',
        'asset_face.boundingBoxX1 as x1',
        'asset_face.boundingBoxY1 as y1',
        'asset_face.boundingBoxX2 as x2',
        'asset_face.boundingBoxY2 as y2',
        'asset_face.imageWidth as oldWidth',
        'asset_face.imageHeight as oldHeight',
        'asset_face.timestampMs',
        'asset.type',
        'asset.originalPath',
        'asset_exif.orientation as exifOrientation',
      ])
      .select((eb) => withFilePath(eb, AssetFileType.Preview).as('previewPath'))
      .where('person.ownerId', '=', ownerId)
      .where('person.personGroupId', '=', personGroupId)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async reassignFace(assetFaceId: string, newPersonGroupId: string): Promise<number> {
    const result = await this.db
      .updateTable('asset_face')
      .set({ personGroupId: newPersonGroupId })
      .where('asset_face.id', '=', assetFaceId)
      .executeTakeFirst();

    return Number(result.numChangedRows ?? 0);
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, personGroupId: DummyValue.UUID }] })
  async getForUser({ userId, personGroupId }: { userId: string; personGroupId: string }) {
    const group = await this.db
      .selectFrom('person_group')
      .select(withOwnedPerson(userId))
      .select(withOtherPeople(userId))
      .where('person_group.id', '=', personGroupId)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('person')
            .select('person.ownerId')
            .whereRef('person.personGroupId', '=', 'person_group.id')
            .where('person.ownerId', '=', userId),
        ),
      )
      .executeTakeFirst();

    return group && asPerson(group);
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, personGroupId: DummyValue.UUID }] })
  getByGroupId({ ownerId, personGroupId }: PersonId) {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .select(withOtherPeopleForPerson(ownerId))
      .where('person.personGroupId', '=', personGroupId)
      .where('person.ownerId', '=', ownerId)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, personGroupId: DummyValue.UUID }] })
  getForThumbnail({ ownerId, personGroupId }: PersonId) {
    return this.db
      .selectFrom('person_group')
      .select(({ selectFrom }) => [
        // TODO-DANIEL I would've done a left join of person_user and sorted by person.ownerId = ownerId desc.
        // should probably discuss with Mert which approach is more efficient.
        selectFrom('person')
          .select('person.thumbnailPath')
          .whereRef('person.personGroupId', '=', 'person_group.id')
          .where('person.ownerId', '=', ownerId)
          .as('thumbnailPath'),
        selectFrom('person')
          .innerJoin('person_user', (join) =>
            join
              .onRef('person_user.personGroupId', '=', 'person.personGroupId')
              .onRef('person_user.sharedById', '=', 'person.ownerId')
              .on('person_user.sharedWithId', '=', ownerId),
          )
          .select('person.thumbnailPath')
          .whereRef('person.personGroupId', '=', 'person_group.id')
          .where('person.thumbnailPath', '!=', '')
          .limit(1)
          .as('sharedThumbnailPath'),
      ])
      .where('person_group.id', '=', personGroupId)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING, { withHidden: true }] })
  getByName(userId: string, personName: string, { withHidden }: PersonNameSearchOptions) {
    return this.db
      .with('similarity_threshold', (db) =>
        db.selectNoFrom(sql`set_config('pg_trgm.word_similarity_threshold', '0.5', true)`.as('thresh')),
      )
      .selectFrom(['similarity_threshold', 'person'])
      .selectAll('person')
      .select(withOtherPeopleForPerson(userId))
      .where('person.ownerId', '=', userId)
      .where(() => sql`f_unaccent("person"."name") %> f_unaccent(${personName})`)
      .orderBy(sql`f_unaccent("person"."name") <->>> f_unaccent(${personName})`)
      .limit(100)
      .$if(!withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { withHidden: true }] })
  getDistinctNames(userId: string, { withHidden }: PersonNameSearchOptions): Promise<PersonNameResponse[]> {
    return this.db
      .selectFrom('person')
      .select(['person.personGroupId', 'person.name'])
      .distinctOn((eb) => eb.fn('lower', ['person.name']))
      .where((eb) => eb.and([eb('person.ownerId', '=', userId), eb('person.name', '!=', '')]))
      .$if(!withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async getStatistics(
    personGroupId: string,
    { ownerId, partnerIds }: { ownerId: string; partnerIds: string[] },
  ): Promise<PersonStatistics> {
    const result = await this.db
      .selectFrom('asset_face')
      .leftJoin('asset', (join) =>
        join
          .onRef('asset.id', '=', 'asset_face.assetId')
          .on('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
          .on('asset.deletedAt', 'is', null)
          .on((eb) => eb.or([eb('asset.ownerId', '=', anyUuid([ownerId, ...partnerIds])), inSharedAlbum(eb, ownerId)])),
      )
      .select((eb) => eb.fn.count(eb.fn('distinct', ['asset.id'])).as('count'))
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .where('asset_face.personGroupId', '=', personGroupId)
      .executeTakeFirst();

    return {
      assets: result ? Number(result.count) : 0,
    };
  }
  @GenerateSql({ params: [DummyValue.UUID, { partnerIds: [DummyValue.UUID] }] })
  getNumberOfPeople(userId: string, options: PersonCountOptions) {
    const zero = sql.lit(0);
    return this.db
      .selectFrom(
        this.getVisiblePeopleQuery(userId, options.partnerIds)
          .select('owned.isHidden')
          .where(withFilters(userId, options))
          .as('people'),
      )
      .select((eb) => eb.fn.coalesce(eb.fn.countAll<number>(), zero).as('total'))
      .select((eb) =>
        eb.fn.coalesce(eb.fn.countAll<number>().filterWhere('people.isHidden', '=', true), zero).as('hidden'),
      )
      .executeTakeFirstOrThrow();
  }

  create(person: Insertable<PersonTable>) {
    return this.db
      .insertInto('person')
      .values(person)
      .returningAll()
      .returning(withOtherPeopleForPerson(person.ownerId))
      .executeTakeFirstOrThrow();
  }

  async createAll(people: Insertable<PersonTable>[]) {
    if (people.length === 0) {
      return [];
    }

    return this.db.insertInto('person').values(people).returningAll().execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  createGroup(ownerId: string) {
    return this.db
      .insertInto('person_group')
      .columns(['clusterGroupId'])
      .expression((eb) => eb.selectFrom('user').select('user.clusterGroupId').where('user.id', '=', ownerId))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, newClusterId: DummyValue.UUID }] })
  async reassignCluster({ userId, newClusterId }: ReassignCluster): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // a group nobody else has people in moves across as it is
      await trx
        .updateTable('person_group')
        .set({ clusterGroupId: newClusterId })
        .where('person_group.id', 'in', (eb) =>
          eb.selectFrom('person').select('person.personGroupId').where('person.ownerId', '=', userId),
        )
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('person')
                .select('person.personGroupId')
                .whereRef('person.personGroupId', '=', 'person_group.id')
                .where('person.ownerId', '!=', userId),
            ),
          ),
        )
        .execute();

      // the rest is shared with someone else, so this user gets a group of their own for each
      const mapping = await trx
        .with('shared', (db) =>
          db
            .selectFrom('person')
            .select('person.personGroupId as oldId')
            .distinct()
            .where('person.ownerId', '=', userId)
            .where(({ exists, selectFrom }) =>
              exists(
                selectFrom('person as other')
                  .select('other.personGroupId')
                  .whereRef('other.personGroupId', '=', 'person.personGroupId')
                  .where('other.ownerId', '!=', userId),
              ),
            ),
        )
        .with(
          (cte) => cte('mapping').materialized(),
          (db) => db.selectFrom('shared').select(['shared.oldId', sql<string>`uuid_generate_v4()`.as('newId')]),
        )
        .with('created', (db) =>
          db
            .insertInto('person_group')
            .columns(['id', 'clusterGroupId'])
            .expression((eb) =>
              eb.selectFrom('mapping').select(['mapping.newId', sql.val(newClusterId).as('clusterGroupId')]),
            ),
        )
        .selectFrom('mapping')
        .select(['mapping.oldId', 'mapping.newId'])
        .execute();

      if (mapping.length === 0) {
        return;
      }

      const oldIds = mapping.map(({ oldId }) => oldId);
      const newIds = mapping.map(({ newId }) => newId);
      const remapped = sql<{
        oldId: string;
        newId: string;
      }>`(select unnest(${`{${oldIds}}`}::uuid[]) as "oldId", unnest(${`{${newIds}}`}::uuid[]) as "newId")`.as(
        'mapping',
      );

      await trx
        .updateTable('person')
        .from(remapped)
        .set((eb) => ({ personGroupId: eb.ref('mapping.newId') }))
        .whereRef('person.personGroupId', '=', 'mapping.oldId')
        .where('person.ownerId', '=', userId)
        .execute();

      await trx
        .updateTable('asset_face')
        .from(remapped)
        .set((eb) => ({ personGroupId: eb.ref('mapping.newId') }))
        .whereRef('asset_face.personGroupId', '=', 'mapping.oldId')
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom('asset')
              .select('asset.id')
              .whereRef('asset.id', '=', 'asset_face.assetId')
              .where('asset.ownerId', '=', userId),
          ),
        )
        .execute();
    });
  }

  @GenerateSql({ params: [DummyValue.UUID, 2] })
  async createGroups(personGroups: Insertable<PersonGroupTable>[]) {
    if (personGroups.length === 0) {
      return [];
    }

    return this.db.insertInto('person_group').values(personGroups).returningAll().execute();
  }

  @GenerateSql({ params: [[], [], [{ faceId: DummyValue.UUID, embedding: DummyValue.VECTOR }]] })
  async refreshFaces(
    facesToAdd: (Insertable<AssetFaceTable> & { assetId: string })[],
    faceIdsToRemove: string[],
    embeddingsToAdd?: Insertable<FaceSearchTable>[],
  ): Promise<void> {
    let query = this.db;
    if (facesToAdd.length > 0) {
      (query as any) = query.with('added', (db) => db.insertInto('asset_face').values(facesToAdd));
    }

    if (faceIdsToRemove.length > 0) {
      (query as any) = query.with('removed', (db) =>
        db.deleteFrom('asset_face').where('asset_face.id', '=', (eb) => eb.fn.any(eb.val(faceIdsToRemove))),
      );
    }

    if (embeddingsToAdd?.length) {
      (query as any) = query.with('added_embeddings', (db) => db.insertInto('face_search').values(embeddingsToAdd));
    }

    await query.selectFrom(dummy).execute();
  }

  async update(person: Updateable<PersonTable> & PersonId) {
    return this.db
      .updateTable('person')
      .set(person)
      .where('person.ownerId', '=', person.ownerId)
      .where('person.personGroupId', '=', person.personGroupId)
      .returningAll()
      .returning(withOtherPeopleForPerson(person.ownerId))
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, personGroupId: DummyValue.UUID }, { name: DummyValue.STRING }] })
  async updateForWritableOwners(
    { userId, personGroupId }: { userId: string; personGroupId: string },
    person: Pick<Updateable<PersonTable>, 'name' | 'birthDate'>,
  ): Promise<void> {
    await this.db
      .updateTable('person')
      .set(person)
      .where('person.personGroupId', '=', personGroupId)
      .where('person.ownerId', 'in', (eb) =>
        eb
          .selectFrom('person_user')
          .select('person_user.sharedById')
          .where('person_user.personGroupId', '=', personGroupId)
          .where('person_user.sharedWithId', '=', userId)
          .where('person_user.role', 'in', [PersonUserRole.Write, PersonUserRole.Admin]),
      )
      .execute();
  }

  async updateAll(people: Insertable<PersonTable>[]): Promise<void> {
    if (people.length === 0) {
      return;
    }

    await this.db
      .insertInto('person')
      .values(people)
      .onConflict((oc) =>
        oc.columns(['ownerId', 'personGroupId']).doUpdateSet((eb) =>
          removeUndefinedKeys(
            {
              name: eb.ref('excluded.name'),
              birthDate: eb.ref('excluded.birthDate'),
              thumbnailPath: eb.ref('excluded.thumbnailPath'),
              faceAssetId: eb.ref('excluded.faceAssetId'),
              isHidden: eb.ref('excluded.isHidden'),
              isFavorite: eb.ref('excluded.isFavorite'),
              color: eb.ref('excluded.color'),
            },
            people[0],
          ),
        ),
      )
      .execute();
  }

  @GenerateSql({
    params: [[{ assetId: DummyValue.UUID, personGroupId: DummyValue.UUID }], { viewingUserId: DummyValue.UUID }],
  })
  @ChunkedArray()
  getFacesByIds(ids: AssetFaceId[], { viewingUserId }: WithPersonOptions) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    const assetIds: string[] = [];
    const personGroupIds: string[] = [];
    for (const { assetId, personGroupId } of ids) {
      assetIds.push(assetId);
      personGroupIds.push(personGroupId);
    }

    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson({ viewingUserId }))
      .where('asset_face.assetId', 'in', assetIds)
      .where('asset_face.personGroupId', 'in', personGroupIds)
      .where('asset_face.deletedAt', 'is', null)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getRandomFace(personGroupId: string) {
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .where('asset_face.personGroupId', '=', personGroupId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .executeTakeFirst();
  }

  @GenerateSql()
  async getLatestFaceDate(): Promise<string | undefined> {
    const result = (await this.db
      .selectFrom('asset_job_status')
      .select((eb) => sql`${eb.fn.max('asset_job_status.facesRecognizedAt')}::text`.as('latestDate'))
      .executeTakeFirst()) as { latestDate: string } | undefined;

    return result?.latestDate;
  }

  async createAssetFace(face: Insertable<AssetFaceTable>) {
    return this.db.insertInto('asset_face').values(face).returningAll().executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteAssetFace(id: string): Promise<void> {
    await this.db.deleteFrom('asset_face').where('asset_face.id', '=', id).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async softDeleteAssetFaces(id: string): Promise<void> {
    await this.db.updateTable('asset_face').set({ deletedAt: new Date() }).where('asset_face.id', '=', id).execute();
  }

  @GenerateSql({ params: [[], []] })
  async updateVisibility(visible: AssetFace[], hidden: AssetFace[]): Promise<void> {
    if (visible.length === 0 && hidden.length === 0) {
      return;
    }

    await this.db.transaction().execute(async (trx) => {
      if (visible.length > 0) {
        await trx
          .updateTable('asset_face')
          .set({ isVisible: true })
          .where(
            'asset_face.id',
            'in',
            visible.map(({ id }) => id),
          )
          .execute();
      }

      if (hidden.length > 0) {
        await trx
          .updateTable('asset_face')
          .set({ isVisible: false })
          .where(
            'asset_face.id',
            'in',
            hidden.map(({ id }) => id),
          )
          .execute();
      }
    });
  }

  @GenerateSql({ params: [{ personGroupId: DummyValue.UUID, assetId: DummyValue.UUID }] })
  getForFeatureFaceUpdate({ personGroupId, assetId }: { personGroupId: string; assetId: string }) {
    return this.db
      .selectFrom('asset_face')
      .select('asset_face.id')
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.personGroupId', '=', personGroupId)
      .where('asset_face.deletedAt', 'is', null)
      .innerJoin('asset', (join) => join.onRef('asset.id', '=', 'asset_face.assetId').on('asset.isOffline', '=', false))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getForMergePerson(personGroupIds: string[]) {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .where('person.personGroupId', 'in', personGroupIds)
      .execute();
  }
}
