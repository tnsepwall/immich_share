import { Injectable } from '@nestjs/common';
import { Kysely, NotNull, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetVisibility } from 'src/enum';
import { DB } from 'src/schema';
import { SyncAck } from 'src/types';

// Phase 6 (mobile pseudo-partner projection) - the canonical "in scope" visibility values, applied as
// `.where('asset.visibility', 'in', SHARED_LIBRARY_ASSET_VISIBILITY)` inside every projection query
// alongside `.where('asset.deletedAt', 'is', null)` (§0.4/§5: the predicate is pinned INSIDE every
// query, never left to a caller to remember). Mirrors Phase 1's checkSharedLibraryAccess
// (access.repository.ts). Hidden is admitted ONLY because live-photo motion parts are
// visibility=hidden and the stock mobile app already excludes visibility=hidden (and deletedAt-set)
// rows from every local timeline/map surface (verified against mobile/lib's merged_asset.drift and
// timeline.repository.ts#remote), so it never actually surfaces to a sharee. Archived and Locked never
// stream; trashed is a scope exit (SharedLibraryAssetsSync.getScopeExits).
const SHARED_LIBRARY_ASSET_VISIBILITY = [sql.lit(AssetVisibility.Timeline), sql.lit(AssetVisibility.Hidden)];

export type SyncBackfillOptions = {
  nowId: string;
  afterUpdateId?: string;
  beforeUpdateId: string;
};

const dummyBackfillOptions = {
  nowId: DummyValue.UUID,
  beforeUpdateId: DummyValue.UUID,
  afterUpdateId: DummyValue.UUID,
};

export type SyncCreatedAfterOptions = {
  nowId: string;
  userId: string;
  afterCreateId?: string;
};

const dummyCreateAfterOptions = {
  nowId: DummyValue.UUID,
  userId: DummyValue.UUID,
  afterCreateId: DummyValue.UUID,
};

export type SyncQueryOptions = {
  nowId: string;
  userId: string;
  ack?: SyncAck;
};

const dummyQueryOptions = {
  nowId: DummyValue.UUID,
  userId: DummyValue.UUID,
  ack: {
    updateId: DummyValue.UUID,
  },
};

@Injectable()
export class SyncRepository {
  album: AlbumSync;
  albumAsset: AlbumAssetSync;
  albumAssetExif: AlbumAssetExifSync;
  albumToAsset: AlbumToAssetSync;
  albumUser: AlbumUserSync;
  asset: AssetSync;
  assetExif: AssetExifSync;
  assetEdit: AssetEditSync;
  assetFace: AssetFaceSync;
  assetMetadata: AssetMetadataSync;
  assetOcr: AssetOcrSync;
  authUser: AuthUserSync;
  libraryUser: LibraryUserSync;
  memory: MemorySync;
  memoryToAsset: MemoryToAssetSync;
  partner: PartnerSync;
  partnerAsset: PartnerAssetsSync;
  partnerAssetExif: PartnerAssetExifsSync;
  partnerStack: PartnerStackSync;
  person: PersonSync;
  sharedLibrary: SharedLibrarySync;
  sharedLibraryAsset: SharedLibraryAssetsSync;
  sharedLibraryAssetExif: SharedLibraryAssetExifsSync;
  stack: StackSync;
  user: UserSync;
  userMetadata: UserMetadataSync;

  constructor(@InjectKysely() private db: Kysely<DB>) {
    this.album = new AlbumSync(this.db);
    this.albumAsset = new AlbumAssetSync(this.db);
    this.albumAssetExif = new AlbumAssetExifSync(this.db);
    this.albumToAsset = new AlbumToAssetSync(this.db);
    this.albumUser = new AlbumUserSync(this.db);
    this.asset = new AssetSync(this.db);
    this.assetExif = new AssetExifSync(this.db);
    this.assetEdit = new AssetEditSync(this.db);
    this.assetFace = new AssetFaceSync(this.db);
    this.assetMetadata = new AssetMetadataSync(this.db);
    this.assetOcr = new AssetOcrSync(this.db);
    this.authUser = new AuthUserSync(this.db);
    this.libraryUser = new LibraryUserSync(this.db);
    this.memory = new MemorySync(this.db);
    this.memoryToAsset = new MemoryToAssetSync(this.db);
    this.partner = new PartnerSync(this.db);
    this.partnerAsset = new PartnerAssetsSync(this.db);
    this.partnerAssetExif = new PartnerAssetExifsSync(this.db);
    this.partnerStack = new PartnerStackSync(this.db);
    this.person = new PersonSync(this.db);
    this.sharedLibrary = new SharedLibrarySync(this.db);
    this.sharedLibraryAsset = new SharedLibraryAssetsSync(this.db);
    this.sharedLibraryAssetExif = new SharedLibraryAssetExifsSync(this.db);
    this.stack = new StackSync(this.db);
    this.user = new UserSync(this.db);
    this.userMetadata = new UserMetadataSync(this.db);
  }
}

export class BaseSync {
  constructor(protected db: Kysely<DB>) {}

  protected backfillQuery<T extends keyof DB>(t: T, { nowId, beforeUpdateId, afterUpdateId }: SyncBackfillOptions) {
    const { table, ref } = this.db.dynamic;
    const updateIdRef = ref(`${t}.updateId`);

    return this.db
      .selectFrom(table(t).as(t))
      .where(updateIdRef, '<', nowId)
      .where(updateIdRef, '<=', beforeUpdateId)
      .$if(!!afterUpdateId, (qb) => qb.where(updateIdRef, '>', afterUpdateId!))
      .orderBy(updateIdRef, 'asc');
  }

  protected auditQuery<T extends keyof DB>(t: T, { nowId, ack }: SyncQueryOptions) {
    const { table, ref } = this.db.dynamic;
    const idRef = ref(`${t}.id`);

    return this.db
      .selectFrom(table(t).as(t))
      .where(idRef, '<', nowId)
      .$if(!!ack, (qb) => qb.where(idRef, '>', ack!.updateId))
      .orderBy(idRef, 'asc');
  }

  protected auditCleanup<T extends keyof DB>(t: T, days: number) {
    const { table, ref } = this.db.dynamic;

    return this.db
      .deleteFrom(table(t).as(t))
      .where(ref(`${t}.deletedAt`), '<', sql.raw(`now() - interval '${days} days'`))
      .execute();
  }

  protected upsertQuery<T extends keyof DB>(t: T, { nowId, ack }: SyncQueryOptions) {
    const { table, ref } = this.db.dynamic;
    const updateIdRef = ref(`${t}.updateId`);

    return this.db
      .selectFrom(table(t).as(t))
      .where(updateIdRef, '<', nowId)
      .$if(!!ack, (qb) => qb.where(updateIdRef, '>', ack!.updateId))
      .orderBy(updateIdRef, 'asc');
  }
}

class AlbumSync extends BaseSync {
  @GenerateSql({ params: [dummyCreateAfterOptions] })
  getCreatedAfter({ nowId, userId, afterCreateId }: SyncCreatedAfterOptions) {
    return this.db
      .selectFrom('album_user')
      .select(['albumId as id', 'createId'])
      .where('userId', '=', userId)
      .$if(!!afterCreateId, (qb) => qb.where('createId', '>=', afterCreateId!))
      .where('createId', '<', nowId)
      .orderBy('createId', 'asc')
      .execute();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('album_audit', options)
      .select(['id', 'albumId'])
      .where('userId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('album_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album', options)
      .distinctOn(['album.id', 'album.updateId'])
      .leftJoin('album_user as album_users', 'album.id', 'album_users.albumId')
      .where('album_users.userId', '=', userId)
      .select([
        'album.id',
        'album.albumName as name',
        'album.description',
        'album.createdAt',
        'album.updatedAt',
        'album.albumThumbnailAssetId as thumbnailAssetId',
        'album.isActivityEnabled',
        'album.order',
        'album.updateId',
      ])
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getAlbumUsers(albumId: string) {
    return this.db.selectFrom('album_user').select(['userId', 'role']).where('albumId', '=', albumId).execute();
  }
}

class AlbumAssetSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string, userId: string) {
    return this.backfillQuery('album_asset', options)
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select(columns.syncAlbumAsset)
      .select((eb) =>
        eb
          .case()
          .when('asset.ownerId', '=', userId)
          .then(eb.ref('asset.isFavorite'))
          .else(eb.val(false))
          .end()
          .as('isFavorite'),
      )
      .select('album_asset.updateId')
      .where('album_asset.albumId', '=', albumId)
      .where('album_asset.sourceLibraryId', 'is', null)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions, { updateId: DummyValue.UUID }], stream: true })
  getUpdates(options: SyncQueryOptions, albumToAssetAck: SyncAck) {
    const userId = options.userId;
    return this.upsertQuery('asset', options)
      .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
      .select(columns.syncAlbumAsset)
      .select((eb) =>
        eb
          .case()
          .when('asset.ownerId', '=', userId)
          .then(eb.ref('asset.isFavorite'))
          .else(eb.val(false))
          .end()
          .as('isFavorite'),
      )
      .select('asset.updateId')
      .where('album_asset.updateId', '<=', albumToAssetAck.updateId) // Ensure we only send updates for assets that the client already knows about
      .where('album_asset.sourceLibraryId', 'is', null)
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getCreates(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_asset', options)
      .select('album_asset.updateId')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select(columns.syncAlbumAsset)
      .select((eb) =>
        eb
          .case()
          .when('asset.ownerId', '=', userId)
          .then(eb.ref('asset.isFavorite'))
          .else(eb.val(false))
          .end()
          .as('isFavorite'),
      )
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .where('album_asset.sourceLibraryId', 'is', null)
      .stream();
  }
}

class AlbumAssetExifSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string) {
    return this.backfillQuery('album_asset', options)
      .innerJoin('asset_exif', 'asset_exif.assetId', 'album_asset.assetId')
      .select(columns.syncAssetExif)
      .select('album_asset.updateId')
      .where('album_asset.albumId', '=', albumId)
      .where('album_asset.sourceLibraryId', 'is', null)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions, { updateId: DummyValue.UUID }], stream: true })
  getUpdates(options: SyncQueryOptions, albumToAssetAck: SyncAck) {
    const userId = options.userId;
    return this.upsertQuery('asset_exif', options)
      .innerJoin('album_asset', 'album_asset.assetId', 'asset_exif.assetId')
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .where('album_asset.updateId', '<=', albumToAssetAck.updateId) // Ensure we only send exif updates for assets that the client already knows about
      .where('album_asset.sourceLibraryId', 'is', null)
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getCreates(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_asset', options)
      .select('album_asset.updateId')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'album_asset.assetId')
      .select(columns.syncAssetExif)
      .innerJoin('album', 'album.id', 'album_asset.albumId')
      .leftJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .where('album_asset.sourceLibraryId', 'is', null)
      .stream();
  }
}

class AlbumToAssetSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string) {
    return this.backfillQuery('album_asset', options)
      .select(['album_asset.assetId as assetId', 'album_asset.albumId as albumId', 'album_asset.updateId'])
      .where('album_asset.albumId', '=', albumId)
      .where('album_asset.sourceLibraryId', 'is', null)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.auditQuery('album_asset_audit', options)
      .select(['id', 'assetId', 'albumId'])
      .where((eb) =>
        eb(
          'albumId',
          'in',
          eb.selectFrom('album_user').select(['album_user.albumId as id']).where('album_user.userId', '=', userId),
        ),
      )
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('album_asset_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_asset', options)
      .select(['album_asset.assetId as assetId', 'album_asset.albumId as albumId', 'album_asset.updateId'])
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .where('album_asset.sourceLibraryId', 'is', null)
      .stream();
  }
}

class AlbumUserSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string) {
    return this.backfillQuery('album_user', options)
      .select(columns.syncAlbumUser)
      .select('album_user.updateId')
      .where('albumId', '=', albumId)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.auditQuery('album_user_audit', options)
      .select(['id', 'userId', 'albumId'])
      .where((eb) =>
        eb(
          'albumId',
          'in',
          eb.selectFrom('album_user').select(['album_user.albumId as id']).where('album_user.userId', '=', userId),
        ),
      )
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('album_user_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_user', options)
      .select(columns.syncAlbumUser)
      .select('album_user.updateId')
      .where((eb) =>
        eb(
          'album_user.albumId',
          'in',
          eb
            .selectFrom('album_user as albumUsers')
            .select(['albumUsers.albumId as id'])
            .where('albumUsers.userId', '=', userId),
        ),
      )
      .stream();
  }
}

class AssetSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('asset_audit', options)
      .select(['id', 'assetId'])
      .where('ownerId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset', options)
      .select(columns.syncAsset)
      .select('asset.updateId')
      .where('ownerId', '=', options.userId)
      .stream();
  }
}

class AuthUserSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('user', options)
      .select(columns.syncUser)
      .select(['isAdmin', 'pinCode', 'oauthId', 'storageLabel', 'quotaSizeInBytes', 'quotaUsageInBytes'])
      .where('id', '=', options.userId)
      .stream();
  }
}

// Cleanup-only. Phase 6's mobile pseudo-partner projection (the "v1 follow-up" this comment used to
// refer to) lives in the sibling SharedLibrarySync/SharedLibraryAssetsSync/SharedLibraryAssetExifsSync
// classes below, not here - kept separate so this class's one existing, working responsibility
// (pruning library_user_audit) never has to change.
class LibraryUserSync extends BaseSync {
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('library_user_audit', daysAgo);
  }
}

class PersonSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('person_audit', options)
      .select(['id', 'personId'])
      .where('ownerId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('person_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('person', options)
      .select([
        'id',
        'createdAt',
        'updatedAt',
        'ownerId',
        'name',
        'birthDate',
        'isHidden',
        'isFavorite',
        'color',
        'updateId',
        'faceAssetId',
      ])
      .where('ownerId', '=', options.userId)
      .stream();
  }
}

class AssetFaceSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('asset_face_audit', options)
      .select(['asset_face_audit.id', 'assetFaceId'])
      .leftJoin('asset', 'asset.id', 'asset_face_audit.assetId')
      .where('asset.ownerId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_face_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset_face', options)
      .select([
        'asset_face.id',
        'assetId',
        'personId',
        'imageWidth',
        'imageHeight',
        'boundingBoxX1',
        'boundingBoxY1',
        'boundingBoxX2',
        'boundingBoxY2',
        'sourceType',
        'isVisible',
        'asset_face.deletedAt',
        'asset_face.updateId',
      ])
      .leftJoin('asset', 'asset.id', 'asset_face.assetId')
      .where('asset.ownerId', '=', options.userId)
      .stream();
  }
}

class AssetExifSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset_exif', options)
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .where('assetId', 'in', (eb) => eb.selectFrom('asset').select('id').where('ownerId', '=', options.userId))
      .stream();
  }
}

class AssetEditSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('asset_edit_audit', options)
      .select(['asset_edit_audit.id', 'editId'])
      .innerJoin('asset', 'asset.id', 'asset_edit_audit.assetId')
      .where('asset.ownerId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_edit_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset_edit', options)
      .select([...columns.syncAssetEdit, 'asset_edit.updateId'])
      .innerJoin('asset', 'asset.id', 'asset_edit.assetId')
      .where('asset.ownerId', '=', options.userId)
      .stream();
  }
}

class MemorySync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('memory_audit', options)
      .select(['id', 'memoryId'])
      .where('userId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('memory_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('memory', options)
      .select([
        'id',
        'createdAt',
        'updatedAt',
        'deletedAt',
        'ownerId',
        'type',
        'data',
        'isSaved',
        'memoryAt',
        'seenAt',
        'showAt',
        'hideAt',
      ])
      .select('updateId')
      .where('ownerId', '=', options.userId)
      .stream();
  }
}

class MemoryToAssetSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('memory_asset_audit', options)
      .select(['id', 'memoryId', 'assetId'])
      .where('memoryId', 'in', (eb) => eb.selectFrom('memory').select('id').where('ownerId', '=', options.userId))
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('memory_asset_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('memory_asset', options)
      .select(['memoriesId as memoryId', 'assetId as assetId'])
      .select('updateId')
      .where('memoriesId', 'in', (eb) => eb.selectFrom('memory').select('id').where('ownerId', '=', options.userId))
      .stream();
  }
}

class PartnerSync extends BaseSync {
  @GenerateSql({ params: [dummyCreateAfterOptions] })
  getCreatedAfter({ nowId, userId, afterCreateId }: SyncCreatedAfterOptions) {
    return this.db
      .selectFrom('partner')
      .select(['sharedById', 'createId'])
      .where('sharedWithId', '=', userId)
      .$if(!!afterCreateId, (qb) => qb.where('createId', '>=', afterCreateId!))
      .where('createId', '<', nowId)
      .orderBy('partner.createId', 'asc')
      .execute();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.auditQuery('partner_audit', options)
      .select(['id', 'sharedById', 'sharedWithId'])
      .where((eb) => eb.or([eb('sharedById', '=', userId), eb('sharedWithId', '=', userId)]))
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('partner_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('partner', options)
      .select(['sharedById', 'sharedWithId', 'inTimeline', 'updateId'])
      .where((eb) => eb.or([eb('sharedById', '=', userId), eb('sharedWithId', '=', userId)]))
      .stream();
  }
}

class PartnerAssetsSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, partnerId: string) {
    return this.backfillQuery('asset', options)
      .select(columns.syncPartnerAsset)
      .select(sql.val(false).as('isFavorite'))
      .select('asset.updateId')
      .where('ownerId', '=', partnerId)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('asset_audit', options)
      .select(['id', 'assetId'])
      .where('ownerId', 'in', (eb) =>
        eb.selectFrom('partner').select(['sharedById']).where('sharedWithId', '=', options.userId),
      )
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset', options)
      .select(columns.syncPartnerAsset)
      .select(sql.val(false).as('isFavorite'))
      .select('asset.updateId')
      .where('ownerId', 'in', (eb) =>
        eb.selectFrom('partner').select(['sharedById']).where('sharedWithId', '=', options.userId),
      )
      .stream();
  }
}

class PartnerAssetExifsSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, partnerId: string) {
    return this.backfillQuery('asset_exif', options)
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
      .where('asset.ownerId', '=', partnerId)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset_exif', options)
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .where('assetId', 'in', (eb) =>
        eb
          .selectFrom('asset')
          .select('id')
          .where('ownerId', 'in', (eb) =>
            eb.selectFrom('partner').select(['sharedById']).where('sharedWithId', '=', options.userId),
          ),
      )
      .stream();
  }
}

// Phase 6: mobile pseudo-partner projection. For each library owner O with >=1 library shared to user U
// where library_user.inTimeline = true, the sync stream presents (O -> U) as a pseudo-partner through
// the EXISTING PartnersV1/PartnerAssetsV2/PartnerAssetExifsV1 wire types (sync.service.ts owns the
// projection arms; see utils/shared-library-sync.ts for the reset/delete transition decision). No new
// sync entity or request types are introduced - the stock mobile app already asks for, and already
// knows how to store and display, all three.

// Relationship-level: which shares are flagged, and which shares were revoked. Mirrors PartnerSync.
class SharedLibrarySync extends BaseSync {
  // Deliberately the RAW flagged set - NOT pre-suppressed by real-partner overlap. Some callers need
  // exactly that raw truth (resolveSharedLibraryTransition checks the real partner separately, and the
  // "true false" polarity matters for the transition matrix); sync.service.ts's projection arms apply
  // suppression themselves against the real-partner list they already fetch for the existing arm, so
  // there is no wasted query either way. Live library + live owner only (a soft-deleted library or a
  // deleted owner must stop counting as flagged immediately, before any hard-delete cascade completes).
  @GenerateSql({ params: [DummyValue.UUID] })
  getFlaggedShares(userId: string) {
    return this.db
      .selectFrom('library_user')
      .innerJoin('library', (join) =>
        join.onRef('library.id', '=', 'library_user.libraryId').on('library.deletedAt', 'is', null),
      )
      .innerJoin('user as owner', (join) =>
        join.onRef('owner.id', '=', 'library.ownerId').on('owner.deletedAt', 'is', null),
      )
      .select(['library_user.libraryId', 'library.ownerId', 'library_user.timelineEnabledId', 'library_user.updateId'])
      .where('library_user.userId', '=', userId)
      .where('library_user.inTimeline', '=', true)
      .$narrowType<{ timelineEnabledId: NotNull }>()
      .execute();
  }

  // Drives the PartnerDeleteV1 projection (sync.service.ts). library_user_audit only records
  // (libraryId, userId) - not ownerId - so this resolves ownerId via a left join to the still-live
  // library row. When the library itself is gone too (a hard-delete cascade deleted both in the same
  // transaction), ownerId comes back null and the service layer skips the row: those cases are already
  // covered immediately and independently by the explicit reset hooks in LibraryService.delete and
  // UserService.handleUserDelete, which run BEFORE the cascade removes the library row.
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getShareDeletes(options: SyncQueryOptions) {
    return this.auditQuery('library_user_audit', options)
      .leftJoin('library', 'library.id', 'library_user_audit.libraryId')
      .select(['library_user_audit.id', 'library_user_audit.userId', 'library.ownerId'])
      .where('library_user_audit.userId', '=', options.userId)
      .stream();
  }
}

// Asset-level: the flagged libraries' assets, projected through the PartnerAssetV2/
// PartnerAssetBackfillV2/PartnerAssetDeleteV1 wire types. Mirrors PartnerAssetsSync, with the §0.4 scope
// predicate (SHARED_LIBRARY_ASSET_VISIBILITY, above) pinned inside every query.
class SharedLibraryAssetsSync extends BaseSync {
  // `syncSharedLibraryAsset` = syncPartnerAsset minus `asset.stackId`; the NULL literal below is the
  // ONLY stackId column, so the sharee never receives the owner's stack grouping (stacks are not
  // projected - same exclusion technique upstream uses for `isFavorite`).
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, libraryId: string) {
    return this.backfillQuery('asset', options)
      .select(columns.syncSharedLibraryAsset)
      .select(sql.val(false).as('isFavorite'))
      .select(sql.val(null).as('stackId'))
      .select('asset.updateId')
      .where('asset.libraryId', '=', libraryId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', SHARED_LIBRARY_ASSET_VISIBILITY)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('asset', options)
      .select(columns.syncSharedLibraryAsset)
      .select(sql.val(false).as('isFavorite'))
      .select(sql.val(null).as('stackId'))
      .select('asset.updateId')
      .where('asset.libraryId', 'in', (eb) =>
        eb
          .selectFrom('library_user')
          .select('library_user.libraryId')
          .where('library_user.userId', '=', userId)
          .where('library_user.inTimeline', '=', true),
      )
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', SHARED_LIBRARY_ASSET_VISIBILITY)
      .stream();
  }

  // Scope exits (plan §2.4/§3.4): an asset that stops matching the scope predicate (archived, trashed,
  // moved out of visibility scope) while its library is STILL flagged-shared to U. Emitted by
  // sync.service.ts as PartnerAssetDeleteV1 - id + updateId ONLY, never metadata, matching the security
  // invariant that a scope-exit event must not leak the asset's new (out-of-scope) state to the sharee.
  // Aliased to the SAME {id, assetId} shape getHardDeletes/the real-partner getDeletes use - `id` here
  // is asset.updateId (the sortable uuidv7 ack/merge key), NOT asset.id (a random, unordered uuid) -
  // so sync.service.ts can merge all three delete sources by a single ascending `id` comparison.
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getScopeExits(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('asset', options)
      .select(['asset.updateId as id', 'asset.id as assetId'])
      .where('asset.libraryId', 'in', (eb) =>
        eb
          .selectFrom('library_user')
          .select('library_user.libraryId')
          .where('library_user.userId', '=', userId)
          .where('library_user.inTimeline', '=', true),
      )
      .where((eb) =>
        eb.or([
          eb('asset.deletedAt', 'is not', null),
          eb('asset.visibility', 'not in', SHARED_LIBRARY_ASSET_VISIBILITY),
        ]),
      )
      .stream();
  }

  // Over-broad by owner exactly like PartnerAssetsSync.getDeletes - asset_audit has no libraryId
  // (asset-audit.table.ts), so owner-scope is the finest available granularity. Unknown ids are
  // client no-ops, matching the existing real-partner precedent.
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getHardDeletes(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.auditQuery('asset_audit', options)
      .select(['id', 'assetId'])
      .where('ownerId', 'in', (eb) =>
        eb
          .selectFrom('library_user')
          .innerJoin('library', 'library.id', 'library_user.libraryId')
          .select('library.ownerId')
          .where('library_user.userId', '=', userId)
          .where('library_user.inTimeline', '=', true),
      )
      .stream();
  }
}

// Exif-level: equivalents of 2.2/2.3, modeled on PartnerAssetExifsSync, with the same library + scope
// predicate applied via the asset join/subquery.
class SharedLibraryAssetExifsSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, libraryId: string) {
    return this.backfillQuery('asset_exif', options)
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
      .where('asset.libraryId', '=', libraryId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', SHARED_LIBRARY_ASSET_VISIBILITY)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('asset_exif', options)
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .where('assetId', 'in', (eb) =>
        eb
          .selectFrom('asset')
          .select('id')
          .where('asset.libraryId', 'in', (eb) =>
            eb
              .selectFrom('library_user')
              .select('library_user.libraryId')
              .where('library_user.userId', '=', userId)
              .where('library_user.inTimeline', '=', true),
          )
          .where('asset.deletedAt', 'is', null)
          .where('asset.visibility', 'in', SHARED_LIBRARY_ASSET_VISIBILITY),
      )
      .stream();
  }
}

class StackSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('stack_audit', options)
      .select(['id', 'stackId'])
      .where('userId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('stack_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('stack', options)
      .select(columns.syncStack)
      .select('updateId')
      .where('ownerId', '=', options.userId)
      .stream();
  }
}

class PartnerStackSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('stack_audit', options)
      .select(['id', 'stackId'])
      .where('userId', 'in', (eb) =>
        eb.selectFrom('partner').select(['sharedById']).where('sharedWithId', '=', options.userId),
      )
      .stream();
  }

  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, partnerId: string) {
    return this.backfillQuery('stack', options)
      .select(columns.syncStack)
      .select('updateId')
      .where('ownerId', '=', partnerId)
      .stream();
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('stack', options)
      .select(columns.syncStack)
      .select('updateId')
      .where('ownerId', 'in', (eb) =>
        eb.selectFrom('partner').select(['sharedById']).where('sharedWithId', '=', options.userId),
      )
      .stream();
  }
}

class UserSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('user_audit', options).select(['id', 'userId']).stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('user_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('user', options).select(columns.syncUser).stream();
  }
}

class UserMetadataSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('user_metadata_audit', options)
      .select(['id', 'userId', 'key'])
      .where('userId', '=', options.userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('user_metadata_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('user_metadata', options)
      .select(['userId', 'key', 'value', 'updateId'])
      .where('userId', '=', options.userId)
      .stream();
  }
}

class AssetMetadataSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getDeletes(options: SyncQueryOptions, userId: string) {
    return this.auditQuery('asset_metadata_audit', options)
      .select(['asset_metadata_audit.id', 'assetId', 'key'])
      .leftJoin('asset', 'asset.id', 'asset_metadata_audit.assetId')
      .where('asset.ownerId', '=', userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_metadata_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getUpserts(options: SyncQueryOptions, userId: string) {
    return this.upsertQuery('asset_metadata', options)
      .select(['assetId', 'key', 'value', 'asset_metadata.updateId'])
      .innerJoin('asset', 'asset.id', 'asset_metadata.assetId')
      .where('asset.ownerId', '=', userId)
      .stream();
  }
}

class AssetOcrSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getDeletes(options: SyncQueryOptions, userId: string) {
    return this.auditQuery('asset_ocr_audit', options)
      .select(['asset_ocr_audit.id', 'asset_ocr_audit.assetId', 'asset_ocr_audit.deletedAt'])
      .leftJoin('asset', 'asset.id', 'asset_ocr_audit.assetId')
      .where('asset.ownerId', '=', userId)
      .stream();
  }

  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_ocr_audit', daysAgo);
  }

  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getUpserts(options: SyncQueryOptions, userId: string) {
    return this.upsertQuery('asset_ocr', options)
      .select(columns.syncAssetOcr)
      .innerJoin('asset', 'asset.id', 'asset_ocr.assetId')
      .where('asset.ownerId', '=', userId)
      .stream();
  }
}
