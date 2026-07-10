import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, Selectable, sql, Transaction, Updateable } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { AssetFace } from 'src/database';
import { Chunked, ChunkedArray, DummyValue, GenerateSql } from 'src/decorators';
import { AssetFileType, AssetVisibility, LibraryUserRole, SourceType, UserMetadataKey } from 'src/enum';
import { DB } from 'src/schema';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table';
import { FaceSearchTable } from 'src/schema/tables/face-search.table';
import { PersonTable } from 'src/schema/tables/person.table';
import { dummy, removeUndefinedKeys, withFilePath } from 'src/utils/database';
import { paginationHelper, PaginationOptions } from 'src/utils/pagination';

export interface PersonSearchOptions {
  withHidden: boolean;
  closestFaceAssetId?: string;
}

export interface PersonNameSearchOptions {
  withHidden?: boolean;
}

export interface PersonNameResponse {
  id: string;
  name: string;
}

export interface AssetFaceId {
  assetId: string;
  personId: string;
}

export interface UpdateFacesData {
  oldPersonId?: string;
  faceIds?: string[];
  newPersonId: string;
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
  personId?: string | null;
  assetId?: string;
  sourceType?: SourceType;
}

export type UnassignFacesOptions = DeleteFacesOptions;

export type SelectFaceOptions = (keyof Selectable<AssetFaceTable>)[];

const withPerson = (eb: ExpressionBuilder<DB, 'asset_face'>) => {
  return jsonObjectFrom(
    eb.selectFrom('person').selectAll('person').whereRef('person.id', '=', 'asset_face.personId'),
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
      .whereRef('asset_face.personId', '=', 'person.id')
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', '=', true)
      .limit(1),
  ).as('thumbnailFace');
};

// Re-verifies library role INSIDE a transaction - mirrors AssetRepository#updateLibraryAssetMetadata's own
// inline role check exactly (library must be non-deleted with a non-deleted owner; actor is the owner, or
// holds an active Editor library_user row). Returns the library row (for its ownerId) if authorized, else null.
const checkLibraryEditorAccessTx = async (trx: Transaction<DB>, libraryId: string, actorId: string) => {
  const library = await trx
    .selectFrom('library')
    .innerJoin('user as owner', (join) => join.onRef('owner.id', '=', 'library.ownerId').on('owner.deletedAt', 'is', null))
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

const getInScopeFaceIdsTx = async (trx: Transaction<DB>, libraryId: string, faceIds: string[]): Promise<Set<string>> => {
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

const isPersonInLibraryScopeTx = async (trx: Transaction<DB>, libraryId: string, personId: string): Promise<boolean> => {
  const result = await trx
    .selectFrom('person')
    .select('person.id')
    .where('person.id', '=', personId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('asset_face')
          .innerJoin('asset', joinLibraryAsset(libraryId))
          .whereRef('asset_face.personId', '=', 'person.id')
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
// count, via the WHERE clause below; the join itself carries no asset.deletedAt filter on either side.
const isPersonExclusiveToLibraryTx = async (
  trx: Transaction<DB>,
  libraryId: string,
  personId: string,
): Promise<boolean> => {
  const result = await trx
    .selectFrom('asset_face')
    .innerJoin('asset', 'asset.id', 'asset_face.assetId')
    .select((eb) => [
      eb.fn.countAll<number>().filterWhere('asset.libraryId', '=', libraryId).as('insideCount'),
      eb.fn
        .countAll<number>()
        .filterWhere((eb) => eb.or([eb('asset.libraryId', 'is', null), eb('asset.libraryId', '!=', libraryId)]))
        .as('outsideCount'),
    ])
    .where('asset_face.personId', '=', personId)
    .where('asset_face.deletedAt', 'is', null)
    .executeTakeFirst();

  return !!result && Number(result.insideCount) > 0 && Number(result.outsideCount) === 0;
};

// Shared face-reassignment + feature-photo bookkeeping, used by both createPersonForLibrary and
// assignFacesForLibrary. Mirrors PersonService.reassignFaces/createNewFeaturePhoto's exact bookkeeping: if a
// moved face was its old person's designated feature face, that person needs a replacement chosen from
// whatever faces remain (if none remain, mirrors the existing owner-flow behavior of leaving faceAssetId
// stale rather than clearing it, and not queuing a refresh job). Returns the set of personIds whose feature
// photo was actually updated, so the caller can queue JobName.PersonGenerateThumbnail for each AFTER this
// transaction commits (job queuing is an external side effect and must not run inside the DB transaction).
const reassignFacesTx = async (
  trx: Transaction<DB>,
  targetPersonId: string,
  faceIds: string[],
): Promise<Set<string>> => {
  const needsFeaturePhoto = new Set<string>();

  const target = await trx
    .selectFrom('person')
    .select(['id', 'faceAssetId'])
    .where('id', '=', targetPersonId)
    .executeTakeFirst();
  if (target && !target.faceAssetId) {
    needsFeaturePhoto.add(targetPersonId);
  }

  for (const faceId of faceIds) {
    const face = await trx
      .selectFrom('asset_face')
      .select(['id', 'personId'])
      .where('id', '=', faceId)
      .executeTakeFirst();

    if (face?.personId) {
      const oldPerson = await trx
        .selectFrom('person')
        .select(['id', 'faceAssetId'])
        .where('id', '=', face.personId)
        .executeTakeFirst();
      if (oldPerson && oldPerson.faceAssetId === faceId) {
        needsFeaturePhoto.add(oldPerson.id);
      }
    }

    await trx.updateTable('asset_face').set({ personId: targetPersonId }).where('id', '=', faceId).execute();
  }

  for (const personId of needsFeaturePhoto) {
    const replacement = await trx
      .selectFrom('asset_face')
      .select('id')
      .where('personId', '=', personId)
      .where('deletedAt', 'is', null)
      .where('isVisible', '=', true)
      .executeTakeFirst();

    if (replacement) {
      await trx.updateTable('person').set({ faceAssetId: replacement.id }).where('id', '=', personId).execute();
    } else {
      needsFeaturePhoto.delete(personId);
    }
  }

  return needsFeaturePhoto;
};

@Injectable()
export class PersonRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [{ oldPersonId: DummyValue.UUID, newPersonId: DummyValue.UUID }] })
  async reassignFaces({ oldPersonId, faceIds, newPersonId }: UpdateFacesData): Promise<number> {
    const result = await this.db
      .updateTable('asset_face')
      .set({ personId: newPersonId })
      .$if(!!oldPersonId, (qb) => qb.where('asset_face.personId', '=', oldPersonId!))
      .$if(!!faceIds, (qb) => qb.where('asset_face.id', 'in', faceIds!))
      .executeTakeFirst();

    return Number(result.numChangedRows ?? 0);
  }

  async unassignFaces({ sourceType }: UnassignFacesOptions): Promise<void> {
    await this.db
      .updateTable('asset_face')
      .set({ personId: null })
      .where('asset_face.sourceType', '=', sourceType)
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db.deleteFrom('person').where('person.id', 'in', ids).execute();
  }

  async deleteFaces({ sourceType }: DeleteFacesOptions): Promise<void> {
    await this.db.deleteFrom('asset_face').where('asset_face.sourceType', '=', sourceType).execute();
  }

  getAllFaces(options: GetAllFacesOptions = {}) {
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .$if(options.personId === null, (qb) => qb.where('asset_face.personId', 'is', null))
      .$if(!!options.personId, (qb) => qb.where('asset_face.personId', '=', options.personId!))
      .$if(!!options.sourceType, (qb) => qb.where('asset_face.sourceType', '=', options.sourceType!))
      .$if(!!options.assetId, (qb) => qb.where('asset_face.assetId', '=', options.assetId!))
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

  @GenerateSql()
  getFileSamples() {
    return this.db
      .selectFrom('person')
      .select(['id', 'thumbnailPath'])
      .where('thumbnailPath', '!=', sql.lit(''))
      .limit(sql.lit(3))
      .execute();
  }

  @GenerateSql({ params: [{ take: 1, skip: 0 }, DummyValue.UUID] })
  async getAllForUser(pagination: PaginationOptions, userId: string, options?: PersonSearchOptions) {
    const items = await this.db
      .selectFrom('person')
      .selectAll('person')
      .innerJoin('asset_face', 'asset_face.personId', 'person.id')
      .innerJoin('asset', (join) =>
        join
          .onRef('asset_face.assetId', '=', 'asset.id')
          .on('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
          .on('asset.deletedAt', 'is', null),
      )
      .where('person.ownerId', '=', userId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .orderBy('person.isHidden', 'asc')
      .orderBy('person.isFavorite', 'desc')
      .having((eb) =>
        eb.or([
          eb('person.name', '!=', ''),
          eb(
            (innerEb) => innerEb.fn.count('asset_face.assetId'),
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
      )
      .groupBy('person.id')
      .$if(!!options?.closestFaceAssetId, (qb) =>
        qb.orderBy((eb) =>
          eb(
            (eb) =>
              eb
                .selectFrom('face_search')
                .select('face_search.embedding')
                .whereRef('face_search.faceId', '=', 'person.faceAssetId'),
            '<=>',
            (eb) =>
              eb
                .selectFrom('face_search')
                .select('face_search.embedding')
                .where('face_search.faceId', '=', options!.closestFaceAssetId!),
          ),
        ),
      )
      .$if(!options?.closestFaceAssetId, (qb) =>
        qb
          .orderBy(sql`NULLIF(person.name, '') is null`, 'asc')
          .orderBy((eb) => eb.fn.count('asset_face.assetId'), 'desc')
          .orderBy(sql`NULLIF(person.name, '')`, (om) => om.asc().nullsLast())
          .orderBy('person.createdAt'),
      )
      .$if(!options?.withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .offset(pagination.skip ?? 0)
      .limit(pagination.take + 1)
      .execute();

    return paginationHelper(items, pagination.take);
  }

  // Only people with a visible face on a non-deleted Timeline asset in this exact library - the shared-library
  // Editor's people list must never surface someone represented only by assets outside the library. Each result
  // carries one representative library face (thumbnailFace) so the caller never needs the person's global
  // thumbnailPath, which may be cropped from an unshared asset (Phase 4 - see FEATURE-PLAN section 2/6).
  @GenerateSql({ params: [DummyValue.UUID, { take: 500 }] })
  async getAllForLibrary(libraryId: string, pagination: PaginationOptions) {
    const items = await this.db
      .selectFrom('person')
      .select(['person.id', 'person.name'])
      .select(withLibraryThumbnailFace(libraryId))
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_face')
            .innerJoin('asset', joinLibraryAsset(libraryId))
            .whereRef('asset_face.personId', '=', 'person.id')
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', '=', true),
        ),
      )
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
  getOneForLibrary(libraryId: string, personId: string) {
    return this.db
      .selectFrom('person')
      .select(['person.id', 'person.name'])
      .select(withLibraryThumbnailFace(libraryId))
      .where('person.id', '=', personId)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_face')
            .innerJoin('asset', joinLibraryAsset(libraryId))
            .whereRef('asset_face.personId', '=', 'person.id')
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', '=', true),
        ),
      )
      .executeTakeFirst();
  }

  @GenerateSql()
  getAllWithoutFaces() {
    return this.db
      .selectFrom('person')
      .selectAll('person')
      .leftJoin('asset_face', 'asset_face.personId', 'person.id')
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .having((eb) => eb.fn.count('asset_face.assetId'), '=', 0)
      .groupBy('person.id')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFaces(assetId: string, options?: { isVisible?: boolean }) {
    const isVisible = options === undefined ? true : options.isVisible;

    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson)
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.deletedAt', 'is', null)
      .$if(isVisible !== undefined, (qb) => qb.where('asset_face.isVisible', '=', isVisible!))
      .orderBy('asset_face.boundingBoxX1', 'asc')
      .execute();
  }

  // Editor face-labeling panel: the asset itself is re-confirmed in-library here (defense in depth on top of the
  // service-layer access check), and the nested person is deliberately a minimal {id, name} reference, not a full
  // library-person projection - the web already has the full list (with thumbnails) from getAllForLibrary above.
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getFacesForLibraryAsset(libraryId: string, assetId: string) {
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .innerJoin('asset', joinLibraryAsset(libraryId))
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('person')
            .select(['person.id', 'person.name'])
            .whereRef('person.id', '=', 'asset_face.personId'),
        ).as('person'),
      )
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', '=', true)
      .orderBy('asset_face.boundingBoxX1', 'asc')
      .execute();
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

  async createPersonForLibrary(
    libraryId: string,
    actorId: string,
    name: string,
    faceIds: string[],
  ): Promise<{ personId: string; needsFeaturePhoto: string[] } | null> {
    return this.db.transaction().execute(async (trx) => {
      const library = await checkLibraryEditorAccessTx(trx, libraryId, actorId);
      if (!library) {
        return null;
      }

      const inScope = await getInScopeFaceIdsTx(trx, libraryId, faceIds);
      if (inScope.size !== faceIds.length) {
        return null;
      }

      const person = await trx
        .insertInto('person')
        .values({ ownerId: library.ownerId, name })
        .returningAll()
        .executeTakeFirstOrThrow();
      const needsFeaturePhoto = await reassignFacesTx(trx, person.id, faceIds);

      return { personId: person.id, needsFeaturePhoto: [...needsFeaturePhoto] };
    });
  }

  async updatePersonNameForLibrary(
    libraryId: string,
    actorId: string,
    personId: string,
    name: string,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const library = await checkLibraryEditorAccessTx(trx, libraryId, actorId);
      if (!library) {
        return false;
      }

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

      await trx.updateTable('person').set({ name }).where('id', '=', personId).execute();
      return true;
    });
  }

  async assignFacesForLibrary(
    libraryId: string,
    actorId: string,
    personId: string,
    faceIds: string[],
  ): Promise<{ needsFeaturePhoto: string[] } | null> {
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
      const personInScope = await isPersonInLibraryScopeTx(trx, libraryId, personId);
      if (!personInScope) {
        return null;
      }

      const needsFeaturePhoto = await reassignFacesTx(trx, personId, faceIds);
      return { needsFeaturePhoto: [...needsFeaturePhoto] };
    });
  }

  async createManualFaceForLibrary(
    libraryId: string,
    actorId: string,
    personId: string,
    assetId: string,
    face: {
      imageWidth: number;
      imageHeight: number;
      boundingBoxX1: number;
      boundingBoxY1: number;
      boundingBoxX2: number;
      boundingBoxY2: number;
    },
  ): Promise<{ faceId: string; needsFeaturePhoto: string[] } | null> {
    return this.db.transaction().execute(async (trx) => {
      const library = await checkLibraryEditorAccessTx(trx, libraryId, actorId);
      if (!library) {
        return null;
      }

      const personInScope = await isPersonInLibraryScopeTx(trx, libraryId, personId);
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
        .values({ personId, assetId, sourceType: SourceType.Manual, ...face })
        .returningAll()
        .executeTakeFirstOrThrow();

      const target = await trx
        .selectFrom('person')
        .select(['id', 'faceAssetId'])
        .where('id', '=', personId)
        .executeTakeFirst();

      const needsFeaturePhoto = new Set<string>();
      if (target && !target.faceAssetId) {
        // The face just created is itself a valid, deterministic choice - no need for a separate random pick.
        await trx.updateTable('person').set({ faceAssetId: created.id }).where('id', '=', personId).execute();
        needsFeaturePhoto.add(personId);
      }

      return { faceId: created.id, needsFeaturePhoto: [...needsFeaturePhoto] };
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFaceById(id: string) {
    // TODO return null instead of find or fail
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson)
      .where('asset_face.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFaceForFacialRecognitionJob(id: string) {
    return this.db
      .selectFrom('asset_face')
      .select(['asset_face.id', 'asset_face.personId', 'asset_face.sourceType'])
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('asset')
            .select(['asset.ownerId', 'asset.visibility', 'asset.fileCreatedAt'])
            .whereRef('asset.id', '=', 'asset_face.assetId'),
        ).as('asset'),
      )
      .select(withFaceSearch)
      .where('asset_face.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getDataForThumbnailGenerationJob(id: string) {
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
        'asset.type',
        'asset.originalPath',
        'asset_exif.orientation as exifOrientation',
      ])
      .select((eb) => withFilePath(eb, AssetFileType.Preview).as('previewPath'))
      .where('person.id', '=', id)
      .where('asset_face.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async reassignFace(assetFaceId: string, newPersonId: string): Promise<number> {
    const result = await this.db
      .updateTable('asset_face')
      .set({ personId: newPersonId })
      .where('asset_face.id', '=', assetFaceId)
      .executeTakeFirst();

    return Number(result.numChangedRows ?? 0);
  }

  getById(personId: string) {
    return this.db //
      .selectFrom('person')
      .selectAll('person')
      .where('person.id', '=', personId)
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
      .select(['person.id', 'person.name'])
      .distinctOn((eb) => eb.fn('lower', ['person.name']))
      .where((eb) => eb.and([eb('person.ownerId', '=', userId), eb('person.name', '!=', '')]))
      .$if(!withHidden, (qb) => qb.where('person.isHidden', '=', false))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getStatistics(personId: string): Promise<PersonStatistics> {
    const result = await this.db
      .selectFrom('asset_face')
      .leftJoin('asset', (join) =>
        join
          .onRef('asset.id', '=', 'asset_face.assetId')
          .on('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
          .on('asset.deletedAt', 'is', null),
      )
      .select((eb) => eb.fn.count(eb.fn('distinct', ['asset.id'])).as('count'))
      .where('asset_face.deletedAt', 'is', null)
      .where('asset_face.isVisible', 'is', true)
      .where('asset_face.personId', '=', personId)
      .executeTakeFirst();

    return {
      assets: result ? Number(result.count) : 0,
    };
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getNumberOfPeople(userId: string) {
    const zero = sql.lit(0);
    return this.db
      .selectFrom('person')
      .where((eb) =>
        eb.exists((eb) =>
          eb
            .selectFrom('asset_face')
            .whereRef('asset_face.personId', '=', 'person.id')
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', '=', true)
            .where((eb) =>
              eb.exists((eb) =>
                eb
                  .selectFrom('asset')
                  .whereRef('asset.id', '=', 'asset_face.assetId')
                  .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
                  .where('asset.deletedAt', 'is', null),
              ),
            ),
        ),
      )
      .where('person.ownerId', '=', userId)
      .select((eb) => eb.fn.coalesce(eb.fn.countAll<number>(), zero).as('total'))
      .select((eb) => eb.fn.coalesce(eb.fn.countAll<number>().filterWhere('isHidden', '=', true), zero).as('hidden'))
      .executeTakeFirstOrThrow();
  }

  create(person: Insertable<PersonTable>) {
    return this.db.insertInto('person').values(person).returningAll().executeTakeFirstOrThrow();
  }

  async createAll(people: Insertable<PersonTable>[]): Promise<string[]> {
    if (people.length === 0) {
      return [];
    }

    const results = await this.db.insertInto('person').values(people).returningAll().execute();
    return results.map(({ id }) => id);
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

  async update(person: Updateable<PersonTable> & { id: string }) {
    return this.db
      .updateTable('person')
      .set(person)
      .where('person.id', '=', person.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateAll(people: Insertable<PersonTable>[]): Promise<void> {
    if (people.length === 0) {
      return;
    }

    await this.db
      .insertInto('person')
      .values(people)
      .onConflict((oc) =>
        oc.column('id').doUpdateSet((eb) =>
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

  @GenerateSql({ params: [[{ assetId: DummyValue.UUID, personId: DummyValue.UUID }]] })
  @ChunkedArray()
  getFacesByIds(ids: AssetFaceId[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    const assetIds: string[] = [];
    const personIds: string[] = [];
    for (const { assetId, personId } of ids) {
      assetIds.push(assetId);
      personIds.push(personId);
    }

    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .select(withPerson)
      .where('asset_face.assetId', 'in', assetIds)
      .where('asset_face.personId', 'in', personIds)
      .where('asset_face.deletedAt', 'is', null)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getRandomFace(personId: string) {
    return this.db
      .selectFrom('asset_face')
      .selectAll('asset_face')
      .where('asset_face.personId', '=', personId)
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

  async vacuum({ reindexVectors }: { reindexVectors: boolean }): Promise<void> {
    await sql`VACUUM ANALYZE asset_face, face_search, person`.execute(this.db);
    await sql`REINDEX TABLE asset_face`.execute(this.db);
    await sql`REINDEX TABLE person`.execute(this.db);
    if (reindexVectors) {
      await sql`REINDEX TABLE face_search`.execute(this.db);
    }
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  getForPeopleDelete(ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.db.selectFrom('person').select(['id', 'thumbnailPath']).where('id', 'in', ids).execute();
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

  @GenerateSql({ params: [{ personId: DummyValue.UUID, assetId: DummyValue.UUID }] })
  getForFeatureFaceUpdate({ personId, assetId }: { personId: string; assetId: string }) {
    return this.db
      .selectFrom('asset_face')
      .select('asset_face.id')
      .where('asset_face.assetId', '=', assetId)
      .where('asset_face.personId', '=', personId)
      .innerJoin('asset', (join) => join.onRef('asset.id', '=', 'asset_face.assetId').on('asset.isOffline', '=', false))
      .executeTakeFirst();
  }
}
