import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, NotNull, sql, Updateable } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database';
import { DummyValue, GenerateSql } from 'src/decorators';
import { LibraryStatsResponseDto } from 'src/dtos/library.dto';
import { AssetType, AssetVisibility, LibraryUserRole } from 'src/enum';
import { DB } from 'src/schema';
import { LibraryTable } from 'src/schema/tables/library.table';
import { LibraryUserTable } from 'src/schema/tables/library-user.table';

export enum AssetSyncResult {
  DO_NOTHING,
  UPDATE,
  OFFLINE,
  CHECK_OFFLINE,
}

const withUser = (eb: ExpressionBuilder<DB, 'library_user'>) => {
  return jsonObjectFrom(
    eb.selectFrom('user').select(columns.user).whereRef('user.id', '=', 'library_user.userId'),
  ).as('user');
};

const withLibraryOwner = (eb: ExpressionBuilder<DB, 'library'>) => {
  return jsonObjectFrom(eb.selectFrom('user').select(columns.user).whereRef('user.id', '=', 'library.ownerId')).as(
    'owner',
  );
};

const withRecipientAssetCount = (eb: ExpressionBuilder<DB, 'library'>) => {
  return eb
    .selectFrom('asset')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .whereRef('asset.libraryId', '=', 'library.id')
    .where('asset.deletedAt', 'is', null)
    .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
    .as('assetCount');
};

@Injectable()
export class LibraryRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string, withDeleted = false) {
    return this.db
      .selectFrom('library')
      .selectAll('library')
      .where('library.id', '=', id)
      .$if(!withDeleted, (qb) => qb.where('library.deletedAt', 'is', null))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [] })
  getAll(withDeleted = false) {
    return this.db
      .selectFrom('library')
      .selectAll('library')
      .orderBy('createdAt', 'asc')
      .$if(!withDeleted, (qb) => qb.where('library.deletedAt', 'is', null))
      .execute();
  }

  @GenerateSql()
  getAllDeleted() {
    return this.db
      .selectFrom('library')
      .selectAll('library')
      .where('library.deletedAt', 'is not', null)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  create(library: Insertable<LibraryTable>) {
    return this.db.insertInto('library').values(library).returningAll().executeTakeFirstOrThrow();
  }

  async delete(id: string) {
    await this.db.deleteFrom('library').where('library.id', '=', id).execute();
  }

  async softDelete(id: string) {
    await this.db.updateTable('library').set({ deletedAt: new Date() }).where('library.id', '=', id).execute();
  }

  update(id: string, library: Updateable<LibraryTable>) {
    return this.db
      .updateTable('library')
      .set(library)
      .where('library.id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getStatistics(id: string): Promise<LibraryStatsResponseDto | undefined> {
    const stats = await this.db
      .selectFrom('library')
      .innerJoin('asset', 'asset.libraryId', 'library.id')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select((eb) =>
        eb.fn
          .countAll<number>()
          .filterWhere((eb) =>
            eb.and([eb('asset.type', '=', AssetType.Image), eb('asset.visibility', '!=', AssetVisibility.Hidden)]),
          )
          .as('photos'),
      )
      .select((eb) =>
        eb.fn
          .countAll<number>()
          .filterWhere((eb) =>
            eb.and([eb('asset.type', '=', AssetType.Video), eb('asset.visibility', '!=', AssetVisibility.Hidden)]),
          )
          .as('videos'),
      )
      .select((eb) => eb.fn.coalesce((eb) => eb.fn.sum('asset_exif.fileSizeInByte'), eb.val(0)).as('usage'))
      .groupBy('library.id')
      .where('library.id', '=', id)
      .executeTakeFirst();

    // possibly a new library with 0 assets
    if (!stats) {
      const zero = sql<number>`0::int`;
      return this.db
        .selectFrom('library')
        .select(zero.as('photos'))
        .select(zero.as('videos'))
        .select(zero.as('usage'))
        .select(zero.as('total'))
        .where('library.id', '=', id)
        .executeTakeFirst();
    }

    return {
      photos: stats.photos,
      videos: stats.videos,
      usage: stats.usage,
      total: stats.photos + stats.videos,
    };
  }

  streamAssetIds(libraryId: string) {
    return this.db.selectFrom('asset').select(['id']).where('libraryId', '=', libraryId).stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getSharedUsers(libraryId: string) {
    return this.db
      .selectFrom('library_user')
      .innerJoin('user', (join) => join.onRef('user.id', '=', 'library_user.userId').on('user.deletedAt', 'is', null))
      .selectAll('library_user')
      .select(withUser)
      .$narrowType<{ user: NotNull }>()
      .where('library_user.libraryId', '=', libraryId)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [{ userId: DummyValue.UUID, role: LibraryUserRole.Viewer }]] })
  async addUsers(libraryId: string, users: { userId: string; role: LibraryUserRole }[]) {
    if (users.length === 0) {
      return;
    }

    await this.db
      .insertInto('library_user')
      .values(users.map(({ userId, role }) => ({ libraryId, userId, role })))
      .onConflict((oc) => oc.columns(['libraryId', 'userId']).doNothing())
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, LibraryUserRole.Editor] })
  updateUserRole(libraryId: string, userId: string, role: LibraryUserRole) {
    return this.db
      .updateTable('library_user')
      .set({ role })
      .where('libraryId', '=', libraryId)
      .where('userId', '=', userId)
      .returningAll()
      .executeTakeFirst();
  }

  // Sharee's own self-service update (currently just `inTimeline`) - deliberately separate from
  // updateUserRole, which is owner/admin-only. The caller (LibraryService.updateMyShare) always pins
  // userId to auth.user.id; this method has no other authorization opinion of its own.
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, { inTimeline: true }] })
  updateUser(libraryId: string, userId: string, update: Updateable<LibraryUserTable>) {
    return this.db
      .updateTable('library_user')
      .set(update)
      .where('libraryId', '=', libraryId)
      .where('userId', '=', userId)
      .returningAll()
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async removeUser(libraryId: string, userId: string) {
    await this.db.deleteFrom('library_user').where('libraryId', '=', libraryId).where('userId', '=', userId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getOwned(ownerId: string) {
    return this.db
      .selectFrom('library')
      .selectAll('library')
      .where('library.ownerId', '=', ownerId)
      .where('library.deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getSharedWithUser(userId: string) {
    return this.db
      .selectFrom('library_user')
      .innerJoin('library', (join) =>
        join.onRef('library.id', '=', 'library_user.libraryId').on('library.deletedAt', 'is', null),
      )
      .innerJoin('user as owner', (join) =>
        join.onRef('owner.id', '=', 'library.ownerId').on('owner.deletedAt', 'is', null),
      )
      .selectAll('library')
      .select('library_user.role')
      .select('library_user.inTimeline')
      .select(withLibraryOwner)
      .select(withRecipientAssetCount)
      .$narrowType<{ owner: NotNull }>()
      .where('library_user.userId', '=', userId)
      .orderBy('library.createdAt', 'asc')
      .execute();
  }

  // Phase 5: the set of library ids the caller has opted into seeing in their main timeline/
  // explore/map/search (library_user.inTimeline = true), scoped to active (non-deleted) libraries
  // with a non-deleted owner - same live-share join shape as getSharedWithUser. Resolved fresh per
  // request, never cached, so a toggle change or share revocation takes effect on the very next
  // call (mirrors getMyPartnerIds).
  @GenerateSql({ params: [DummyValue.UUID] })
  getInTimelineSharedLibraryIds(userId: string): Promise<string[]> {
    return this.db
      .selectFrom('library_user')
      .innerJoin('library', (join) =>
        join.onRef('library.id', '=', 'library_user.libraryId').on('library.deletedAt', 'is', null),
      )
      .innerJoin('user as owner', (join) =>
        join.onRef('owner.id', '=', 'library.ownerId').on('owner.deletedAt', 'is', null),
      )
      .select('library.id')
      .where('library_user.userId', '=', userId)
      .where('library_user.inTimeline', '=', true)
      .execute()
      .then((rows) => rows.map((row) => row.id));
  }
}
