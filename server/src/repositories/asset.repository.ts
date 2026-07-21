import { Injectable } from '@nestjs/common';
import {
  ExpressionBuilder,
  Insertable,
  Kysely,
  NotNull,
  Selectable,
  SelectQueryBuilder,
  ShallowDehydrateObject,
  sql,
  Updateable,
  UpdateResult,
} from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { isEmpty, isUndefined, omitBy } from 'lodash';
import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import { lockableProperties, LockableProperty, Stack } from 'src/database';
import { Chunked, ChunkedArray, DummyValue, GenerateSql } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  AssetFileType,
  AssetOrder,
  AssetOrderBy,
  AssetStatus,
  AssetType,
  AssetVisibility,
  CalendarHeatmapType,
  LibraryUserRole,
} from 'src/enum';
import { DB } from 'src/schema';
import { AssetAudioTable, AssetKeyframeTable, AssetVideoTable } from 'src/schema/tables/asset-av.table';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table';
import { AssetFileTable } from 'src/schema/tables/asset-file.table';
import { AssetJobStatusTable } from 'src/schema/tables/asset-job-status.table';
import { AssetMetadataTable } from 'src/schema/tables/asset-metadata.table';
import { AssetTable } from 'src/schema/tables/asset.table';
import {
  anyUuid,
  asUuid,
  hasPeople,
  removeUndefinedKeys,
  truncatedDate,
  unnest,
  withAlbumAssetProvenance,
  withDefaultVisibility,
  withEdits,
  withExif,
  withFaces,
  withFacesAndPeople,
  withFilePath,
  withFiles,
  withLibrary,
  withOwner,
  withSharedLibraryAssets,
  withSmartSearch,
  withTagId,
  withTags,
} from 'src/utils/database';
import { globToSqlPattern } from 'src/utils/misc';

export type AssetStats = Record<AssetType, number>;

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface AssetStatsOptions {
  isFavorite?: boolean;
  isTrashed?: boolean;
  visibility?: AssetVisibility;
}

interface LivePhotoSearchOptions {
  ownerId: string;
  libraryId?: string | null;
  livePhotoCID: string;
  otherAssetId: string;
  type: AssetType;
}

interface AssetBuilderOptions {
  isFavorite?: boolean;
  isTrashed?: boolean;
  isDuplicate?: boolean;
  albumId?: string;
  /** Requester identity for gating provenance-linked album_asset rows when albumId is set; null for shared-link visitors. */
  requestedBy?: string | null;
  libraryId?: string;
  tagId?: string;
  personId?: string;
  userIds?: string[];
  /**
   * Phase 5: opted-in shared-library ids (library_user.inTimeline = true) whose Timeline-visibility,
   * non-deleted assets should ALSO be included via a separate OR-branch on asset.libraryId - never by
   * adding the library owner's id to `userIds` (that would leak the owner's uploads and every other
   * library they have). See the shared-arm predicate applied in getTimeBuckets/getTimeBucket below;
   * the visibility/deletedAt clamp is pinned inside that branch and does not inherit
   * withDefaultVisibility. Only meaningful alongside `userIds` on the main-timeline path.
   */
  sharedLibraryIds?: string[];
  withStacked?: boolean;
  exifInfo?: boolean;
  status?: AssetStatus;
  assetType?: AssetType;
  visibility?: AssetVisibility;
  withCoordinates?: boolean;
  bbox?: BoundingBox;
}

// Resolved edit for the shared-library Editor's database-only metadata primitive - see updateLibraryAssetMetadata
// below. The caller (library-editor.service.ts) resolves incoming DTO strings (dateTimeOriginal, geocoding) to
// these already-parsed values before calling in; dateTimeOriginal and dateTimeRelative are mutually exclusive.
export type LibraryAssetMetadataEdit = {
  description?: string;
  rating?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  dateTimeOriginal?: Date;
  dateTimeRelative?: number;
  timeZone?: string;
};

export interface TimeBucketOptions extends AssetBuilderOptions {
  order?: AssetOrder;
  orderBy?: AssetOrderBy;
}

export interface TimeBucketItem {
  timeBucket: string;
  count: number;
}

export interface YearMonthDay {
  day: number;
  month: number;
  year: number;
}

interface AssetExploreFieldOptions {
  maxFields: number;
  minAssetsPerField: number;
}

interface AssetGetByChecksumOptions {
  ownerId: string;
  checksum: Buffer;
  libraryId?: string;
}

interface GetByIdsRelations {
  exifInfo?: boolean;
  faces?: { person?: boolean; withDeleted?: boolean };
  files?: boolean;
  library?: boolean;
  owner?: boolean;
  smartSearch?: boolean;
  stack?: { assets?: boolean };
  tags?: boolean;
  edits?: boolean;
}

type UpsertExifOptions = {
  exif: Insertable<AssetExifTable>;
  audio?: Insertable<AssetAudioTable>;
  video?: Insertable<AssetVideoTable>;
  keyframes?: Insertable<AssetKeyframeTable>;
  lockedPropertiesBehavior: 'override' | 'append' | 'skip';
};

const distinctLocked = <T extends LockableProperty[] | null>(eb: ExpressionBuilder<DB, 'asset_exif'>, columns: T) =>
  distinctUnion(eb, 'lockedProperties', columns);

// Same union-and-dedupe as distinctLocked, generalized to either of asset_exif's two property-list columns:
// lockedProperties (protected from metadata-extraction overwrite) and sidecarWriteProperties (still pending an
// XMP sidecar write - see FEATURE-PLAN-shared-external-libraries.md Step 5b).
const distinctUnion = <T extends LockableProperty[] | null>(
  eb: ExpressionBuilder<DB, 'asset_exif'>,
  column: 'lockedProperties' | 'sidecarWriteProperties',
  additions: T,
) => sql<T>`nullif(array(select distinct unnest(${eb.ref(`asset_exif.${column}`)} || ${additions})), '{}')`;

// Inverse of distinctUnion: removes `properties` from one of the two property-list columns.
const withoutProperties = (
  eb: ExpressionBuilder<DB, 'asset_exif'>,
  column: 'lockedProperties' | 'sidecarWriteProperties',
  properties: LockableProperty[],
) =>
  sql<
    LockableProperty[] | null
  >`nullif(array(select distinct property from unnest(${eb.ref(`asset_exif.${column}`)}) property where not property = any(${properties})), '{}')`;

const getBoundingCircle = (bbox: BoundingBox) => {
  const { west, south, east, north } = bbox;
  const eastUnwrapped = west <= east ? east : east + 360;
  const centerLongitude = (((west + eastUnwrapped) / 2 + 540) % 360) - 180;
  const centerLatitude = (south + north) / 2;
  const radius = sql<number>`greatest(
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${south}, ${west})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${south}, ${east})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${north}, ${west})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${north}, ${east}))
  )`;

  return { centerLatitude, centerLongitude, radius };
};

const withBoundingBox = <T>(qb: SelectQueryBuilder<DB, 'asset' | 'asset_exif', T>, bbox: BoundingBox) => {
  const { west, south, east, north } = bbox;
  const withLatitude = qb.where('asset_exif.latitude', '>=', south).where('asset_exif.latitude', '<=', north);

  if (west <= east) {
    return withLatitude.where('asset_exif.longitude', '>=', west).where('asset_exif.longitude', '<=', east);
  }

  return withLatitude.where((eb) =>
    eb.or([eb('asset_exif.longitude', '>=', west), eb('asset_exif.longitude', '<=', east)]),
  );
};

@Injectable()
export class AssetRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({
    params: [
      {
        exif: {
          dateTimeOriginal: DummyValue.DATE,
          lockedProperties: ['dateTimeOriginal'],
          sidecarWriteProperties: ['dateTimeOriginal'],
        },
        lockedPropertiesBehavior: 'append',
      },
    ],
  })
  async upsertExif({ exif, audio, video, keyframes, lockedPropertiesBehavior }: UpsertExifOptions): Promise<void> {
    let query = this.db;
    if (audio) {
      (query as any) = this.db.with('audio', (qb) =>
        qb
          .insertInto('asset_audio')
          .values(audio)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              bitrate: ref('asset_audio.bitrate'),
              index: ref('asset_audio.index'),
              profile: ref('asset_audio.profile'),
              codecName: ref('asset_audio.codecName'),
            })),
          ),
      );
    }

    if (video) {
      (query as any) = query.with('video', (qb) =>
        qb
          .insertInto('asset_video')
          .values(video)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              bitrate: ref('asset_video.bitrate'),
              timeBase: ref('asset_video.timeBase'),
              index: ref('asset_video.index'),
              profile: ref('asset_video.profile'),
              level: ref('asset_video.level'),
              colorPrimaries: ref('asset_video.colorPrimaries'),
              colorTransfer: ref('asset_video.colorTransfer'),
              colorMatrix: ref('asset_video.colorMatrix'),
              dvProfile: ref('asset_video.dvProfile'),
              dvLevel: ref('asset_video.dvLevel'),
              dvBlSignalCompatibilityId: ref('asset_video.dvBlSignalCompatibilityId'),
              codecName: ref('asset_video.codecName'),
              formatName: ref('asset_video.formatName'),
              formatLongName: ref('asset_video.formatLongName'),
              pixelFormat: ref('asset_video.pixelFormat'),
            })),
          ),
      );
    }

    if (keyframes) {
      (query as any) = query.with('keyframe', (qb) =>
        qb
          .insertInto('asset_keyframe')
          .values(keyframes)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              pts: ref('asset_keyframe.pts'),
              accDuration: ref('asset_keyframe.accDuration'),
              ownDuration: ref('asset_keyframe.ownDuration'),
              totalDuration: ref('asset_keyframe.totalDuration'),
              packetCount: ref('asset_keyframe.packetCount'),
              outputFrames: ref('asset_keyframe.outputFrames'),
            })),
          ),
      );
    }

    await query
      .insertInto('asset_exif')
      .values(exif)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet((eb) => {
          const updateLocked = <T extends keyof AssetExifTable>(col: T) => eb.ref(`excluded.${col}`);
          const skipLocked = <T extends keyof AssetExifTable>(col: T) =>
            eb
              .case()
              .when(sql`${col}`, '=', eb.fn.any('asset_exif.lockedProperties'))
              .then(eb.ref(`asset_exif.${col}`))
              .else(eb.ref(`excluded.${col}`))
              .end();
          const ref = lockedPropertiesBehavior === 'skip' ? skipLocked : updateLocked;
          return {
            ...removeUndefinedKeys(
              {
                description: ref('description'),
                exifImageWidth: ref('exifImageWidth'),
                exifImageHeight: ref('exifImageHeight'),
                fileSizeInByte: ref('fileSizeInByte'),
                orientation: ref('orientation'),
                dateTimeOriginal: ref('dateTimeOriginal'),
                modifyDate: ref('modifyDate'),
                timeZone: ref('timeZone'),
                latitude: ref('latitude'),
                longitude: ref('longitude'),
                projectionType: ref('projectionType'),
                city: ref('city'),
                livePhotoCID: ref('livePhotoCID'),
                autoStackId: ref('autoStackId'),
                state: ref('state'),
                country: ref('country'),
                make: ref('make'),
                model: ref('model'),
                lensModel: ref('lensModel'),
                fNumber: ref('fNumber'),
                focalLength: ref('focalLength'),
                iso: ref('iso'),
                exposureTime: ref('exposureTime'),
                profileDescription: ref('profileDescription'),
                colorspace: ref('colorspace'),
                bitsPerSample: ref('bitsPerSample'),
                rating: ref('rating'),
                fps: ref('fps'),
                tags: ref('tags'),
                lockedProperties:
                  lockedPropertiesBehavior === 'append'
                    ? distinctLocked(eb, exif.lockedProperties ?? null)
                    : ref('lockedProperties'),
                sidecarWriteProperties:
                  lockedPropertiesBehavior === 'append'
                    ? distinctUnion(eb, 'sidecarWriteProperties', exif.sidecarWriteProperties ?? null)
                    : ref('sidecarWriteProperties'),
              },
              exif,
            ),
          };
        }),
      )
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], { model: DummyValue.STRING }] })
  @Chunked()
  async updateAllExif(ids: string[], options: Updateable<AssetExifTable>): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db
      .updateTable('asset_exif')
      .set((eb) => ({
        ...options,
        lockedProperties: distinctLocked(eb, Object.keys(options) as LockableProperty[]),
        sidecarWriteProperties: distinctUnion(eb, 'sidecarWriteProperties', Object.keys(options) as LockableProperty[]),
      }))
      .where('assetId', 'in', ids)
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.NUMBER, DummyValue.STRING] })
  @Chunked()
  updateDateTimeOriginal(ids: string[], delta?: number, timeZone?: string) {
    return this.db
      .updateTable('asset_exif')
      .set((eb) => ({
        dateTimeOriginal: sql`"dateTimeOriginal" + ${(delta ?? 0) + ' minute'}::interval`,
        timeZone,
        lockedProperties: distinctLocked(eb, ['dateTimeOriginal', 'timeZone']),
        sidecarWriteProperties: distinctUnion(eb, 'sidecarWriteProperties', ['dateTimeOriginal', 'timeZone']),
      }))
      .where('assetId', 'in', ids)
      .returning(['assetId', 'dateTimeOriginal', 'timeZone'])
      .execute();
  }

  // Called only after handleSidecarWrite successfully writes `properties` to the XMP sidecar - clears them from
  // BOTH lockedProperties (extraction may overwrite them again) and sidecarWriteProperties (nothing left pending).
  // An editor's database-only lock (library-editor.service.ts) never touches sidecarWriteProperties in the first
  // place, so it is untouched by this call and stays locked forever - see Step 5b of the feature plan.
  @GenerateSql({ params: [DummyValue.UUID, ['description']] })
  unlockProperties(assetId: string, properties: LockableProperty[]) {
    return this.db
      .updateTable('asset_exif')
      .where('assetId', '=', assetId)
      .set((eb) => ({
        lockedProperties: withoutProperties(eb, 'lockedProperties', properties),
        sidecarWriteProperties: withoutProperties(eb, 'sidecarWriteProperties', properties),
      }))
      .execute();
  }

  /**
   * Transactional, database-only metadata primitive for the shared-library Editor role (Step 5b of
   * FEATURE-PLAN-shared-external-libraries.md). Re-verifies, INSIDE this same transaction, that `editorId` still
   * owns or holds an active Editor `library_user` row for `libraryId`, and that every id in `assetIds` still
   * belongs to that exact library as a non-deleted Timeline-visibility asset - closing the race where a role
   * downgrade/removal lands between the caller's outer permission check and this write. If either check fails,
   * nothing is written and this returns null (the whole batch is atomic: partial failure writes nothing).
   *
   * Only ever appends to `lockedProperties` (protects the value from a future metadata-extraction overwrite) -
   * NEVER to `sidecarWriteProperties` - and never queues SidecarWrite, so an editor's edit can never reach the
   * owner's original files. Compare to the owner-facing updateAllExif/updateDateTimeOriginal above, which lock
   * both columns and do queue a sidecar write.
   */
  async updateLibraryAssetMetadata(
    libraryId: string,
    editorId: string,
    assetIds: string[],
    edit: LibraryAssetMetadataEdit,
  ): Promise<string[] | null> {
    return this.db.transaction().execute(async (trx) => {
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

      let isAuthorized = library.ownerId === editorId;
      if (!isAuthorized) {
        const share = await trx
          .selectFrom('library_user')
          .select('role')
          .where('libraryId', '=', libraryId)
          .where('userId', '=', editorId)
          .executeTakeFirst();
        isAuthorized = share?.role === LibraryUserRole.Editor;
      }

      if (!isAuthorized) {
        return null;
      }

      const scoped = await trx
        .selectFrom('asset')
        .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .select(['asset.id as assetId', 'asset_exif.dateTimeOriginal', 'asset_exif.timeZone'])
        .where('asset.id', 'in', assetIds)
        .where('asset.libraryId', '=', libraryId)
        .where('asset.deletedAt', 'is', null)
        .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
        .execute();

      if (scoped.length !== assetIds.length) {
        // At least one id was outside this library, deleted, or not Timeline visibility - write nothing.
        return null;
      }

      const exifFieldsUpdate = removeUndefinedKeys(
        {
          description: edit.description,
          rating: edit.rating,
          latitude: edit.latitude,
          longitude: edit.longitude,
          city: edit.city,
          state: edit.state,
          country: edit.country,
        },
        edit,
      );
      const nonDateTouched = lockableProperties.filter((property) => property in exifFieldsUpdate);

      if (Object.keys(exifFieldsUpdate).length > 0) {
        // An upsert, not a plain UPDATE: a Timeline-visibility asset can genuinely have no asset_exif row yet
        // (metadata extraction hasn't completed, or failed) - a bare UPDATE would silently affect zero rows in
        // that case, and the caller would get back a false "success" with nothing actually written.
        await trx
          .insertInto('asset_exif')
          .values(assetIds.map((assetId) => ({ assetId, ...exifFieldsUpdate, lockedProperties: nonDateTouched })))
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet((eb) => ({
              // Only the value columns the caller actually set should be filtered by removeUndefinedKeys (against
              // `edit`, which is where these keys live) - lockedProperties/sidecarWriteProperties are NOT keys on
              // `edit` at all, so they must stay outside this call or removeUndefinedKeys strips them unconditionally.
              ...removeUndefinedKeys(
                {
                  description: eb.ref('excluded.description'),
                  rating: eb.ref('excluded.rating'),
                  latitude: eb.ref('excluded.latitude'),
                  longitude: eb.ref('excluded.longitude'),
                  city: eb.ref('excluded.city'),
                  state: eb.ref('excluded.state'),
                  country: eb.ref('excluded.country'),
                },
                edit,
              ),
              lockedProperties: distinctUnion(eb, 'lockedProperties', nonDateTouched),
              // A pending owner SidecarWrite job reads asset_exif's CURRENT value at run time, not a value
              // snapshotted at queue time. If the editor overwrites a property the owner already queued a write
              // for, that job would otherwise flush the editor's value to the XMP sidecar the moment it runs.
              // Cancelling the pending flag for exactly the properties just touched closes that window - nothing
              // valid is left to flush for the owner's now-superseded edit, and the editor's replacement value
              // must never reach disk regardless of who queued what first.
              sidecarWriteProperties: withoutProperties(eb, 'sidecarWriteProperties', nonDateTouched),
            })),
          )
          .execute();
      }

      const isDateEdit =
        edit.dateTimeOriginal !== undefined || edit.dateTimeRelative !== undefined || edit.timeZone !== undefined;
      if (isDateEdit) {
        for (const row of scoped) {
          const timeZone = edit.timeZone ?? row.timeZone ?? 'UTC';
          const base =
            edit.dateTimeOriginal ??
            DateTime.fromJSDate(row.dateTimeOriginal ?? new Date())
              .plus({ minutes: edit.dateTimeRelative ?? 0 })
              .toJSDate();
          // Reproduce the same instant -> zone -> "fake UTC" derivation metadata.service.ts#getDates uses, so an
          // editor's date/timezone edit moves the asset to the correct timeline bucket immediately, with no job.
          const dateTimeOriginal = DateTime.fromJSDate(base).setZone(timeZone);
          const localDateTime = dateTimeOriginal.setZone('UTC', { keepLocalTime: true });

          // Upsert, same reason as the non-date branch above: this asset may not have an asset_exif row yet.
          await trx
            .insertInto('asset_exif')
            .values({
              assetId: row.assetId,
              dateTimeOriginal: dateTimeOriginal.toJSDate(),
              timeZone,
              lockedProperties: ['dateTimeOriginal', 'timeZone'],
            })
            .onConflict((oc) =>
              oc.column('assetId').doUpdateSet((eb) => ({
                dateTimeOriginal: eb.ref('excluded.dateTimeOriginal'),
                timeZone: eb.ref('excluded.timeZone'),
                lockedProperties: distinctUnion(eb, 'lockedProperties', ['dateTimeOriginal', 'timeZone']),
                // Same pending-owner-write cancellation as the non-date branch above.
                sidecarWriteProperties: withoutProperties(eb, 'sidecarWriteProperties', [
                  'dateTimeOriginal',
                  'timeZone',
                ]),
              })),
            )
            .execute();

          await trx
            .updateTable('asset')
            .set({ localDateTime: localDateTime.toJSDate(), fileCreatedAt: dateTimeOriginal.toJSDate() })
            .where('id', '=', row.assetId)
            .execute();
        }
      }

      return assetIds;
    });
  }

  async upsertJobStatus(...jobStatus: Insertable<AssetJobStatusTable>[]): Promise<void> {
    if (jobStatus.length === 0) {
      return;
    }

    const values = jobStatus.map((row) => ({ ...row, assetId: asUuid(row.assetId) }));
    await this.db
      .insertInto('asset_job_status')
      .values(values)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet((eb) =>
          removeUndefinedKeys(
            {
              duplicatesDetectedAt: eb.ref('excluded.duplicatesDetectedAt'),
              facesRecognizedAt: eb.ref('excluded.facesRecognizedAt'),
              metadataExtractedAt: eb.ref('excluded.metadataExtractedAt'),
              ocrAt: eb.ref('excluded.ocrAt'),
              videoFacesRecognizedAt: eb.ref('excluded.videoFacesRecognizedAt'),
            },
            values[0],
          ),
        ),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getMetadata(assetId: string) {
    return this.db
      .selectFrom('asset_metadata')
      .select(['key', 'value', 'updatedAt'])
      .where('assetId', '=', assetId)
      .execute();
  }

  upsertMetadata(id: string, items: Array<{ key: string; value: Record<string, unknown> }>) {
    if (items.length === 0) {
      return [];
    }

    return this.db
      .insertInto('asset_metadata')
      .values(items.map((item) => ({ assetId: id, ...item })))
      .onConflict((oc) =>
        oc
          .columns(['assetId', 'key'])
          .doUpdateSet((eb) => ({ key: eb.ref('excluded.key'), value: eb.ref('excluded.value') })),
      )
      .returning(['key', 'value', 'updatedAt'])
      .execute();
  }

  upsertBulkMetadata(items: Insertable<AssetMetadataTable>[]) {
    return this.db
      .insertInto('asset_metadata')
      .values(items)
      .onConflict((oc) =>
        oc
          .columns(['assetId', 'key'])
          .doUpdateSet((eb) => ({ key: eb.ref('excluded.key'), value: eb.ref('excluded.value') })),
      )
      .returning(['assetId', 'key', 'value', 'updatedAt'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getMetadataByKey(assetId: string, key: string) {
    return this.db
      .selectFrom('asset_metadata')
      .select(['key', 'value', 'updatedAt'])
      .where('assetId', '=', assetId)
      .where('key', '=', key)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async deleteMetadataByKey(id: string, key: string) {
    await this.db.deleteFrom('asset_metadata').where('assetId', '=', id).where('key', '=', key).execute();
  }

  @GenerateSql({ params: [[{ assetId: DummyValue.UUID, key: DummyValue.STRING }]] })
  async deleteBulkMetadata(items: Array<{ assetId: string; key: string }>) {
    if (items.length === 0) {
      return;
    }

    await this.db.transaction().execute(async (tx) => {
      for (const { assetId, key } of items) {
        await tx.deleteFrom('asset_metadata').where('assetId', '=', assetId).where('key', '=', key).execute();
      }
    });
  }

  create(asset: Insertable<AssetTable>) {
    return this.db.insertInto('asset').values(asset).returningAll().executeTakeFirstOrThrow();
  }

  @ChunkedArray({ chunkSize: 4000 })
  async createAll(assets: Insertable<AssetTable>[]) {
    const ids = await this.db.insertInto('asset').values(assets).returning('id').execute();
    return ids.map(({ id }) => id);
  }

  @GenerateSql({ params: [DummyValue.UUID, { year: 2000, day: 1, month: 1 }] })
  getByDayOfYear(ownerIds: string[], { year, day, month }: YearMonthDay) {
    return this.db
      .with('res', (qb) =>
        qb
          .with('today', (qb) =>
            qb
              .selectFrom((eb) =>
                eb
                  .fn('generate_series', [
                    sql`(select date_part('year', min(("localDateTime" at time zone 'UTC')::date))::int from asset)`,
                    sql`${year - 1}`,
                  ])
                  .as('year'),
              )
              .select((eb) => eb.fn('make_date', [sql`year::int`, sql`${month}::int`, sql`${day}::int`]).as('date')),
          )
          .selectFrom('today')
          .innerJoinLateral(
            (qb) =>
              qb
                .selectFrom('asset')
                .select(['asset.id', 'asset.localDateTime'])
                .innerJoin('asset_job_status', 'asset.id', 'asset_job_status.assetId')
                .where(sql`(asset."localDateTime" at time zone 'UTC')::date`, '=', sql`today.date`)
                .where('asset.ownerId', '=', anyUuid(ownerIds))
                .where('asset.visibility', '=', AssetVisibility.Timeline)
                .where((eb) =>
                  eb.exists((qb) =>
                    qb
                      .selectFrom('asset_file')
                      .whereRef('assetId', '=', 'asset.id')
                      .where('asset_file.type', '=', AssetFileType.Preview),
                  ),
                )
                .where('asset.deletedAt', 'is', null)
                .orderBy(sql`(asset."localDateTime" at time zone 'UTC')::date`, 'desc')
                .limit(20)
                .as('a'),
            (join) => join.onTrue(),
          )
          .selectAll('a'),
      )
      .selectFrom('res')
      .select(sql<number>`date_part('year', ("localDateTime" at time zone 'UTC')::date)::int`.as('year'))
      .select((eb) => eb.fn.jsonAgg(eb.table('res')).as('assets'))
      .groupBy(sql`("localDateTime" at time zone 'UTC')::date`)
      .orderBy(sql`("localDateTime" at time zone 'UTC')::date`, 'desc')
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  getByIds(ids: string[]) {
    return this.db.selectFrom('asset').selectAll('asset').where('asset.id', '=', anyUuid(ids)).execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  getByIdsWithAllRelationsButStacks(ids: string[]) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .select(withFacesAndPeople)
      .select(withTags)
      .$call(withExif)
      .where('asset.id', '=', anyUuid(ids))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteAll(ownerId: string): Promise<void> {
    await this.db.deleteFrom('asset').where('ownerId', '=', ownerId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getByLibraryIdAndOriginalPath(libraryId: string, originalPath: string) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('libraryId', '=', asUuid(libraryId))
      .where('originalPath', '=', originalPath)
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getLivePhotoCount(motionId: string): Promise<number> {
    const [{ count }] = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('livePhotoVideoId', '=', asUuid(motionId))
      .execute();
    return count;
  }

  @GenerateSql()
  getFileSamples() {
    return this.db.selectFrom('asset_file').select(['assetId', 'path']).limit(sql.lit(3)).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForCopy(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'stackId', 'originalPath', 'isFavorite'])
      .select(withFiles)
      .where('id', '=', asUuid(id))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(
    id: string,
    { exifInfo, faces, files, library, owner, smartSearch, stack, tags, edits }: GetByIdsRelations = {},
  ) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('asset.id', '=', asUuid(id))
      .$if(!!exifInfo, withExif)
      .$if(!!faces, (qb) => qb.select(faces?.person ? withFacesAndPeople : withFaces).$narrowType<{ faces: NotNull }>())
      .$if(!!library, (qb) => qb.select(withLibrary))
      .$if(!!owner, (qb) => qb.select(withOwner))
      .$if(!!smartSearch, withSmartSearch)
      .$if(!!stack, (qb) =>
        qb
          .leftJoin('stack', 'stack.id', 'asset.stackId')
          .$if(!stack!.assets, (qb) =>
            qb.select((eb) => eb.fn.toJson(eb.table('stack')).$castTo<Stack | null>().as('stack')),
          )
          .$if(!!stack!.assets, (qb) =>
            qb
              .leftJoinLateral(
                (eb) =>
                  eb
                    .selectFrom('asset as stacked')
                    .selectAll('stack')
                    .select((eb) =>
                      eb
                        .fn<ShallowDehydrateObject<Selectable<AssetTable>>>('array_agg', [eb.table('stacked')])
                        .as('assets'),
                    )
                    .whereRef('stacked.stackId', '=', 'stack.id')
                    .whereRef('stacked.id', '!=', 'stack.primaryAssetId')
                    .where('stacked.deletedAt', 'is', null)
                    .where('stacked.visibility', '=', AssetVisibility.Timeline)
                    .groupBy('stack.id')
                    .as('stacked_assets'),
                (join) => join.on('stack.id', 'is not', null),
              )
              .select((eb) => eb.fn.toJson(eb.table('stacked_assets')).as('stack')),
          ),
      )
      .$if(!!files, (qb) => qb.select(withFiles))
      .$if(!!tags, (qb) => qb.select(withTags))
      .$if(!!edits, (qb) => qb.select(withEdits))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [[DummyValue.UUID], {}] })
  @Chunked()
  async updateAll(ids: string[], options: Updateable<AssetTable>): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db.updateTable('asset').set(options).where('id', '=', anyUuid(ids)).execute();
  }

  async updateByLibraryId(libraryId: string, options: Updateable<AssetTable>): Promise<void> {
    await this.db.updateTable('asset').set(options).where('libraryId', '=', asUuid(libraryId)).execute();
  }

  async update(asset: Updateable<AssetTable> & { id: string }) {
    const value = omitBy(asset, isUndefined);
    delete value.id;
    if (!isEmpty(value)) {
      return this.db
        .with('asset', (qb) => qb.updateTable('asset').set(asset).where('id', '=', asUuid(asset.id)).returningAll())
        .selectFrom('asset')
        .selectAll('asset')
        .$call(withExif)
        .$call((qb) => qb.select(withFacesAndPeople))
        .$call((qb) => qb.select(withEdits))
        .executeTakeFirst();
    }

    return this.getById(asset.id, { exifInfo: true, faces: { person: true }, edits: true });
  }

  async remove(asset: { id: string }): Promise<void> {
    await this.db.deleteFrom('asset').where('id', '=', asUuid(asset.id)).execute();
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, libraryId: DummyValue.UUID, checksum: DummyValue.BUFFER }] })
  getByChecksum({ ownerId, libraryId, checksum }: AssetGetByChecksumOptions) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('ownerId', '=', asUuid(ownerId))
      .where('checksum', '=', checksum)
      .$call((qb) => (libraryId ? qb.where('libraryId', '=', asUuid(libraryId)) : qb.where('libraryId', 'is', null)))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.BUFFER]] })
  getByChecksums(userId: string, checksums: Buffer[]) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'checksum', 'deletedAt'])
      .where('ownerId', '=', asUuid(userId))
      .where('checksum', 'in', checksums)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.BUFFER] })
  async getUploadAssetIdByChecksum(ownerId: string, checksum: Buffer): Promise<string | undefined> {
    const asset = await this.db
      .selectFrom('asset')
      .select('id')
      .where('ownerId', '=', asUuid(ownerId))
      .where('checksum', '=', checksum)
      .where('libraryId', 'is', null)
      .limit(1)
      .executeTakeFirst();

    return asset?.id;
  }

  findLivePhotoMatch(options: LivePhotoSearchOptions) {
    const { ownerId, otherAssetId, livePhotoCID, type } = options;
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId'])
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .where('id', '!=', asUuid(otherAssetId))
      .where('ownerId', '=', asUuid(ownerId))
      .where('type', '=', type)
      .where('asset_exif.livePhotoCID', '=', livePhotoCID)
      .limit(1)
      .executeTakeFirst();
  }

  getStatistics(ownerId: string, { visibility, isFavorite, isTrashed }: AssetStatsOptions): Promise<AssetStats> {
    return this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Audio).as(AssetType.Audio))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Image).as(AssetType.Image))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Video).as(AssetType.Video))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Other).as(AssetType.Other))
      .where('ownerId', '=', asUuid(ownerId))
      .$if(visibility === undefined, withDefaultVisibility)
      .$if(!!visibility, (qb) => qb.where('asset.visibility', '=', visibility!))
      .$if(isFavorite !== undefined, (qb) => qb.where('isFavorite', '=', isFavorite!))
      .$if(!!isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
      .where('deletedAt', isTrashed ? 'is not' : 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({
    params: [DummyValue.UUID, { from: DummyValue.DATE, to: DummyValue.DATE, type: CalendarHeatmapType.Upload }],
  })
  getCalendarHeatmap(ownerId: string, dto: { from: Date; to: Date; type: CalendarHeatmapType }) {
    const dateColumns: Record<CalendarHeatmapType, { order: AssetOrderBy; column: 'createdAt' | 'localDateTime' }> = {
      [CalendarHeatmapType.Upload]: { order: AssetOrderBy.CreatedAt, column: 'createdAt' },
      [CalendarHeatmapType.Taken]: { order: AssetOrderBy.TakenAt, column: 'localDateTime' },
    } as const;

    const { order, column } = dateColumns[dto.type];

    const date = truncatedDate<Date>(order, 'DAY');

    return this.db
      .selectFrom('asset')
      .select(date.as('date'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('ownerId', '=', asUuid(ownerId))
      .where(column, '>=', dto.from)
      .where(column, '<', dto.to)
      .where('deletedAt', 'is', null)
      .groupBy(date)
      .orderBy('date', 'asc')
      .execute();
  }

  @GenerateSql({ params: [{}] })
  async getTimeBuckets(options: TimeBucketOptions): Promise<TimeBucketItem[]> {
    return this.db
      .with('asset', (qb) =>
        qb
          .selectFrom('asset')
          .select(truncatedDate<Date>(options.orderBy).as('timeBucket'))
          .$if(!!options.isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
          .where('asset.deletedAt', options.isTrashed ? 'is not' : 'is', null)
          .$if(!!options.bbox, (qb) => {
            const bbox = options.bbox!;
            const circle = getBoundingCircle(bbox);

            const withBoundingCircle = qb
              .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
              .where(
                sql`earth_box(ll_to_earth_public(${circle.centerLatitude}, ${circle.centerLongitude}), ${circle.radius})`,
                '@>',
                sql`ll_to_earth_public(asset_exif.latitude, asset_exif.longitude)`,
              );

            return withBoundingBox(withBoundingCircle, bbox);
          })
          .$if(options.visibility === undefined, withDefaultVisibility)
          .$if(!!options.visibility, (qb) => qb.where('asset.visibility', '=', options.visibility!))
          .$if(!!options.albumId, (qb) =>
            qb
              .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
              .where('album_asset.albumId', '=', asUuid(options.albumId!))
              .where(withAlbumAssetProvenance(options.requestedBy ?? null)),
          )
          .$if(!!options.personId, (qb) => hasPeople(qb, [options.personId!]))
          .$if(!!options.withStacked, (qb) =>
            qb
              .leftJoin('stack', (join) =>
                join.onRef('stack.id', '=', 'asset.stackId').onRef('stack.primaryAssetId', '=', 'asset.id'),
              )
              .where((eb) =>
                eb.or([
                  eb('asset.stackId', 'is', null),
                  eb(eb.table('stack'), 'is not', null),
                  // Stacks are owner-only in v1 (plan §2.4/§0.2) - never collapse a shared-library
                  // asset away just because it happens to be a non-primary stack member in the
                  // OWNER's account; it must keep appearing to the sharee as an individual asset.
                  ...(options.sharedLibraryIds && options.sharedLibraryIds.length > 0
                    ? [eb('asset.libraryId', 'in', options.sharedLibraryIds)]
                    : []),
                ]),
              ),
          )
          .$if(!!options.userIds, (qb) =>
            qb.where((eb) => {
              const ownerArm = eb('asset.ownerId', '=', anyUuid(options.userIds!));
              return options.sharedLibraryIds && options.sharedLibraryIds.length > 0
                ? eb.or([ownerArm, withSharedLibraryAssets(options.sharedLibraryIds)(eb)])
                : ownerArm;
            }),
          )
          .$if(!!options.libraryId, (qb) => qb.where('asset.libraryId', '=', options.libraryId!))
          .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
          .$if(!!options.assetType, (qb) => qb.where('asset.type', '=', options.assetType!))
          .$if(options.isDuplicate !== undefined, (qb) =>
            qb.where('asset.duplicateId', options.isDuplicate ? 'is not' : 'is', null),
          )
          .$if(!!options.tagId, (qb) => withTagId(qb, options.tagId!)),
      )
      .selectFrom('asset')
      .select(sql<string>`("timeBucket" AT TIME ZONE 'UTC')::date::text`.as('timeBucket'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .groupBy('timeBucket')
      .orderBy('timeBucket', options.order ?? 'desc')
      .execute() as any as Promise<TimeBucketItem[]>;
  }

  @GenerateSql({
    params: [DummyValue.TIME_BUCKET, { withStacked: true }, { user: { id: DummyValue.UUID } }],
  })
  getTimeBucket(timeBucket: string, options: TimeBucketOptions, auth: AuthDto) {
    const order = options.order ?? 'desc';
    const query = this.db
      .with('cte', (qb) =>
        qb
          .selectFrom('asset')
          .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
          .select((eb) => [
            'asset.duration',
            'asset.id',
            'asset.visibility',
            sql`asset."isFavorite" and asset."ownerId" = ${auth.user.id}`.as('isFavorite'),
            sql`asset.type = 'IMAGE'`.as('isImage'),
            sql`asset."deletedAt" is not null`.as('isTrashed'),
            // Redacted for non-owner (shared-arm) rows, same shape as isFavorite above: a shared-library
            // asset's motion-part id must not leak to a sharee unless the motion asset itself passes the
            // same access check, which this endpoint doesn't verify - so it's simplest and safest to
            // just null it whenever the row isn't the caller's own asset (see plan §2.5).
            sql`case when asset."ownerId" = ${auth.user.id} then asset."livePhotoVideoId" else null end`.as(
              'livePhotoVideoId',
            ),
            sql`extract(epoch from (asset."localDateTime" AT TIME ZONE 'UTC' - asset."fileCreatedAt" at time zone 'UTC'))::real / 3600`.as(
              'localOffsetHours',
            ),
            'asset.ownerId',
            'asset.status',
            sql`asset."fileCreatedAt" at time zone 'utc'`.as('fileCreatedAt'),
            sql`asset."createdAt" at time zone 'utc'`.as('createdAt'),
            eb.fn('encode', ['asset.thumbhash', sql.lit('base64')]).as('thumbhash'),
            'asset_exif.projectionType',
            eb.fn
              .coalesce(
                eb
                  .case()
                  .when(sql`asset."height" = 0 or asset."width" = 0`)
                  .then(eb.lit(1))
                  .else(sql`round(asset."width"::numeric / asset."height"::numeric, 3)`)
                  .end(),
                eb.lit(1),
              )
              .as('ratio'),
          ])
          .$if(!auth.sharedLink || auth.sharedLink.showExif, (qb) =>
            qb.select(['asset_exif.city', 'asset_exif.country']),
          )
          .$if(!!options.withCoordinates, (qb) => qb.select(['asset_exif.latitude', 'asset_exif.longitude']))
          .where('asset.deletedAt', options.isTrashed ? 'is not' : 'is', null)
          .$if(options.visibility == undefined, withDefaultVisibility)
          .$if(!!options.visibility, (qb) => qb.where('asset.visibility', '=', options.visibility!))
          .$if(!!options.bbox, (qb) => {
            const bbox = options.bbox!;
            const circle = getBoundingCircle(bbox);

            const withBoundingCircle = qb.where(
              sql`earth_box(ll_to_earth_public(${circle.centerLatitude}, ${circle.centerLongitude}), ${circle.radius})`,
              '@>',
              sql`ll_to_earth_public(asset_exif.latitude, asset_exif.longitude)`,
            );

            return withBoundingBox(withBoundingCircle, bbox);
          })
          .where(truncatedDate(options.orderBy), '=', timeBucket.replace(/^[+-]/, ''))
          .$if(!!options.albumId, (qb) =>
            qb.where((eb) =>
              eb.exists(
                eb
                  .selectFrom('album_asset')
                  .whereRef('album_asset.assetId', '=', 'asset.id')
                  .where('album_asset.albumId', '=', asUuid(options.albumId!))
                  .where(withAlbumAssetProvenance(options.requestedBy ?? null)),
              ),
            ),
          )
          .$if(!!options.personId, (qb) => hasPeople(qb, [options.personId!]))
          .$if(!!options.userIds, (qb) =>
            qb.where((eb) => {
              const ownerArm = eb('asset.ownerId', '=', anyUuid(options.userIds!));
              return options.sharedLibraryIds && options.sharedLibraryIds.length > 0
                ? eb.or([ownerArm, withSharedLibraryAssets(options.sharedLibraryIds)(eb)])
                : ownerArm;
            }),
          )
          .$if(!!options.libraryId, (qb) => qb.where('asset.libraryId', '=', options.libraryId!))
          .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
          .$if(!!options.withStacked, (qb) =>
            qb
              .where((eb) =>
                eb.or([
                  eb.not(
                    eb.exists(
                      eb
                        .selectFrom('stack')
                        .whereRef('stack.id', '=', 'asset.stackId')
                        .whereRef('stack.primaryAssetId', '!=', 'asset.id'),
                    ),
                  ),
                  // Same bypass as getTimeBuckets above - stacks are owner-only in v1 (§2.4/§0.2); a
                  // shared-library asset must never be collapsed away just because it's a non-primary
                  // stack member in the owner's account.
                  ...(options.sharedLibraryIds && options.sharedLibraryIds.length > 0
                    ? [eb('asset.libraryId', 'in', options.sharedLibraryIds)]
                    : []),
                ]),
              )
              .leftJoinLateral(
                (eb) =>
                  eb
                    .selectFrom('asset as stacked')
                    .select(sql`array[stacked."stackId"::text, count('stacked')::text]`.as('stack'))
                    .whereRef('stacked.stackId', '=', 'asset.stackId')
                    .where('stacked.deletedAt', 'is', null)
                    .where('stacked.visibility', '=', AssetVisibility.Timeline)
                    // Never surface a stack tuple for a shared-library row (§2.4) - regardless of
                    // whether it's the stack's actual primary, a sharee must never see stack grouping
                    // info at all, since stacks are owner-only in v1. NULL-SAFE on purpose (review
                    // finding): uploaded assets have libraryId IS NULL, and a bare NOT IN evaluates to
                    // SQL NULL for them - which silently dropped the caller's own uploaded-asset stack
                    // tuples whenever they had any inTimeline shared library.
                    .$if(!!options.sharedLibraryIds && options.sharedLibraryIds.length > 0, (qb) =>
                      qb.where((eb) =>
                        eb.or([
                          eb('asset.libraryId', 'is', null),
                          eb('asset.libraryId', 'not in', options.sharedLibraryIds!),
                        ]),
                      ),
                    )
                    .groupBy('stacked.stackId')
                    .as('stacked_assets'),
                (join) => join.onTrue(),
              )
              .select('stack'),
          )
          .$if(!!options.assetType, (qb) => qb.where('asset.type', '=', options.assetType!))
          .$if(options.isDuplicate !== undefined, (qb) =>
            qb.where('asset.duplicateId', options.isDuplicate ? 'is not' : 'is', null),
          )
          .$if(!!options.isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
          .$if(!!options.tagId, (qb) => withTagId(qb, options.tagId!))
          .orderBy(
            options.orderBy == AssetOrderBy.CreatedAt
              ? sql`"createdAt"`
              : sql`(asset."localDateTime" AT TIME ZONE 'UTC')::date`,
            order,
          )
          .orderBy('asset.fileCreatedAt', order),
      )
      .with('agg', (qb) =>
        qb
          .selectFrom('cte')
          .select((eb) => [
            eb.fn.coalesce(eb.fn('array_agg', ['duration']), sql.lit('{}')).as('duration'),
            eb.fn.coalesce(eb.fn('array_agg', ['id']), sql.lit('{}')).as('id'),
            eb.fn.coalesce(eb.fn('array_agg', ['visibility']), sql.lit('{}')).as('visibility'),
            eb.fn.coalesce(eb.fn('array_agg', ['isFavorite']), sql.lit('{}')).as('isFavorite'),
            eb.fn.coalesce(eb.fn('array_agg', ['isImage']), sql.lit('{}')).as('isImage'),
            // TODO: isTrashed is redundant as it will always be all true or false depending on the options
            eb.fn.coalesce(eb.fn('array_agg', ['isTrashed']), sql.lit('{}')).as('isTrashed'),
            eb.fn.coalesce(eb.fn('array_agg', ['livePhotoVideoId']), sql.lit('{}')).as('livePhotoVideoId'),
            eb.fn.coalesce(eb.fn('array_agg', ['fileCreatedAt']), sql.lit('{}')).as('fileCreatedAt'),
            eb.fn.coalesce(eb.fn('array_agg', ['localOffsetHours']), sql.lit('{}')).as('localOffsetHours'),
            eb.fn.coalesce(eb.fn('array_agg', ['createdAt']), sql.lit('{}')).as('createdAt'),
            eb.fn.coalesce(eb.fn('array_agg', ['ownerId']), sql.lit('{}')).as('ownerId'),
            eb.fn.coalesce(eb.fn('array_agg', ['projectionType']), sql.lit('{}')).as('projectionType'),
            eb.fn.coalesce(eb.fn('array_agg', ['ratio']), sql.lit('{}')).as('ratio'),
            eb.fn.coalesce(eb.fn('array_agg', ['status']), sql.lit('{}')).as('status'),
            eb.fn.coalesce(eb.fn('array_agg', ['thumbhash']), sql.lit('{}')).as('thumbhash'),
          ])
          .$if(!auth.sharedLink || auth.sharedLink.showExif, (qb) =>
            qb.select((eb) => [
              eb.fn.coalesce(eb.fn('array_agg', ['city']), sql.lit('{}')).as('city'),
              eb.fn.coalesce(eb.fn('array_agg', ['country']), sql.lit('{}')).as('country'),
            ]),
          )
          .$if(!!options.withCoordinates, (qb) =>
            qb.select((eb) => [
              eb.fn.coalesce(eb.fn('array_agg', ['latitude']), sql.lit('{}')).as('latitude'),
              eb.fn.coalesce(eb.fn('array_agg', ['longitude']), sql.lit('{}')).as('longitude'),
            ]),
          )
          .$if(!!options.withStacked, (qb) =>
            qb.select((eb) => eb.fn.coalesce(eb.fn('json_agg', ['stack']), sql.lit('[]')).as('stack')),
          ),
      )
      .selectFrom('agg')
      .select(sql<string>`to_json(agg)::text`.as('assets'));

    return query.executeTakeFirstOrThrow();
  }

  // Phase 5 (§3.5): widened from a single ownerId to (userIds, sharedLibraryIds) with the OR-arm -
  // deliberately kept partner-free (as today; the caller passes just [auth.user.id], never partner
  // ids, so adding partners here stays out of scope).
  @GenerateSql({ params: [[DummyValue.UUID], [DummyValue.UUID], { minAssetsPerField: 5, maxFields: 12 }] })
  async getAssetIdByCity(
    userIds: string[],
    sharedLibraryIds: string[],
    { minAssetsPerField, maxFields }: AssetExploreFieldOptions,
  ) {
    const items = await this.db
      .with('cities', (qb) =>
        qb
          .selectFrom('asset_exif')
          .select('city')
          .where('city', 'is not', null)
          .groupBy('city')
          .having((eb) => eb.fn('count', [eb.ref('assetId')]), '>=', minAssetsPerField),
      )
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .innerJoin('cities', 'asset_exif.city', 'cities.city')
      .distinctOn('asset_exif.city')
      .select(['assetId as data', 'asset_exif.city as value'])
      .$narrowType<{ value: NotNull }>()
      .where((eb) => {
        const ownerArm = eb('asset.ownerId', '=', anyUuid(userIds));
        return sharedLibraryIds.length > 0
          ? eb.or([ownerArm, withSharedLibraryAssets(sharedLibraryIds)(eb)])
          : ownerArm;
      })
      .where('visibility', '=', AssetVisibility.Timeline)
      .where('type', '=', AssetType.Image)
      .where('deletedAt', 'is', null)
      .limit(maxFields)
      .execute();

    return { fieldName: 'exifInfo.city', items };
  }

  @GenerateSql({ params: [[DummyValue.UUID], [DummyValue.UUID], 12] })
  async getRecentlyCreatedAssetIds(userIds: string[], sharedLibraryIds: string[], maxAssets: number) {
    const items = await this.db
      .selectFrom('asset')
      .select(['id as data', 'createdAt as value'])
      .where((eb) => {
        const ownerArm = eb('asset.ownerId', '=', anyUuid(userIds));
        return sharedLibraryIds.length > 0
          ? eb.or([ownerArm, withSharedLibraryAssets(sharedLibraryIds)(eb)])
          : ownerArm;
      })
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('type', '=', AssetType.Image)
      .where('deletedAt', 'is', null)
      .orderBy('value', 'desc')
      .limit(maxAssets)
      .execute();

    return { fieldName: 'createdAt', items };
  }

  async upsertFile(
    file: Pick<
      Insertable<AssetFileTable>,
      'assetId' | 'path' | 'type' | 'isEdited' | 'isProgressive' | 'isTransparent'
    >,
  ): Promise<void> {
    await this.db
      .insertInto('asset_file')
      .values(file)
      .onConflict((oc) =>
        oc.columns(['assetId', 'type', 'isEdited']).doUpdateSet((eb) => ({
          path: eb.ref('excluded.path'),
        })),
      )
      .execute();
  }

  async upsertFiles(
    files: Pick<
      Insertable<AssetFileTable>,
      'assetId' | 'path' | 'type' | 'isEdited' | 'isProgressive' | 'isTransparent'
    >[],
  ): Promise<void> {
    if (files.length === 0) {
      return;
    }

    await this.db
      .insertInto('asset_file')
      .values(files)
      .onConflict((oc) =>
        oc.columns(['assetId', 'type', 'isEdited']).doUpdateSet((eb) => ({
          path: eb.ref('excluded.path'),
          isProgressive: eb.ref('excluded.isProgressive'),
          isTransparent: eb.ref('excluded.isTransparent'),
        })),
      )
      .execute();
  }

  async deleteFile({
    assetId,
    type,
    edited,
  }: {
    assetId: string;
    type: AssetFileType;
    edited?: boolean;
  }): Promise<void> {
    await this.db
      .deleteFrom('asset_file')
      .where('assetId', '=', asUuid(assetId))
      .where('type', '=', type)
      .$if(edited !== undefined, (qb) => qb.where('isEdited', '=', edited!))
      .execute();
  }

  async deleteFiles(files: Pick<Selectable<AssetFileTable>, 'id'>[]): Promise<void> {
    if (files.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('asset_file')
      .where('id', '=', anyUuid(files.map((file) => file.id)))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.STRING], [DummyValue.STRING]] })
  async detectOfflineExternalAssets(
    libraryId: string,
    importPaths: string[],
    exclusionPatterns: string[],
  ): Promise<UpdateResult> {
    const paths = importPaths.map((importPath) => `${importPath}%`);
    const exclusions = exclusionPatterns.map((pattern) => globToSqlPattern(pattern));

    return this.db
      .updateTable('asset')
      .set({
        isOffline: true,
        deletedAt: new Date(),
      })
      .where('isOffline', '=', false)
      .where('isExternal', '=', true)
      .where('libraryId', '=', asUuid(libraryId))
      .where((eb) =>
        eb.or([
          eb.not(eb.or(paths.map((path) => eb('originalPath', 'like', path)))),
          eb.or(exclusions.map((path) => eb('originalPath', 'like', path))),
        ]),
      )
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.STRING]] })
  async filterNewExternalAssetPaths(libraryId: string, paths: string[]): Promise<string[]> {
    const result = await this.db
      .selectFrom(unnest(paths).as('path'))
      .select('path')
      .where((eb) =>
        eb.not(
          eb.exists(
            this.db
              .selectFrom('asset')
              .select('originalPath')
              .whereRef('asset.originalPath', '=', eb.ref('path'))
              .where('libraryId', '=', asUuid(libraryId))
              .where('isExternal', '=', true),
          ),
        ),
      )
      .execute();

    return result.map((row) => row.path as string);
  }

  async getLibraryAssetCount(libraryId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('libraryId', '=', asUuid(libraryId))
      .executeTakeFirstOrThrow();

    return count;
  }

  private buildGetForOriginal(ids: string[], isEdited: boolean) {
    return this.db
      .selectFrom('asset')
      .select('asset.id')
      .select('originalFileName')
      .where('asset.id', 'in', ids)
      .$if(isEdited, (qb) =>
        qb
          .leftJoin('asset_file', (join) =>
            join
              .onRef('asset.id', '=', 'asset_file.assetId')
              .on('asset_file.isEdited', '=', true)
              .on('asset_file.type', '=', AssetFileType.FullSize),
          )
          .select('asset_file.path as editedPath'),
      )
      .select('originalPath');
  }

  @GenerateSql({ params: [DummyValue.UUID, true] })
  getForOriginal(id: string, isEdited: boolean) {
    return this.buildGetForOriginal([id], isEdited).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [[DummyValue.UUID], true] })
  getForOriginals(ids: string[], isEdited: boolean) {
    return this.buildGetForOriginal(ids, isEdited).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, AssetFileType.Preview, true] })
  async getForThumbnail(id: string, type: AssetFileType, isEdited: boolean) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', id)
      .leftJoin('asset_file', (join) =>
        join.onRef('asset.id', '=', 'asset_file.assetId').on('asset_file.type', '=', type),
      )
      .select(['asset.originalPath', 'asset.originalFileName', 'asset_file.path as path'])
      .orderBy('asset_file.isEdited', isEdited ? 'desc' : 'asc')
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForVideo(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.originalPath'])
      .select((eb) => withFilePath(eb, AssetFileType.EncodedVideo).as('encodedVideoPath'))
      .where('asset.id', '=', id)
      .where('asset.type', '=', AssetType.Video)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForOcr(id: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', id)
      .select(withEdits)
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select(['asset_exif.exifImageWidth', 'asset_exif.exifImageHeight', 'asset_exif.orientation'])
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForEdit(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.type', 'asset.livePhotoVideoId', 'asset.originalPath', 'asset.originalFileName'])
      .where('asset.id', '=', id)
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select([
        'asset_exif.exifImageWidth',
        'asset_exif.exifImageHeight',
        'asset_exif.orientation',
        'asset_exif.projectionType',
      ])
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForMetadataExtractionTags(id: string) {
    return this.db
      .selectFrom('asset_exif')
      .select('asset_exif.tags')
      .where('asset_exif.assetId', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForFaces(id: string) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select([
        'asset.ownerId',
        'asset.libraryId',
        'asset_exif.exifImageHeight',
        'asset_exif.exifImageWidth',
        'asset_exif.orientation',
      ])
      .select(withEdits)
      .where('asset.id', '=', id)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForUpdateTags(id: string) {
    return this.db
      .selectFrom('asset')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('tag')
            .select('tag.value')
            .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
            .whereRef('asset.id', '=', 'tag_asset.assetId')
            // Only the asset OWNER's tags feed the exif tag list (and from there the sidecar-write
            // pipeline). A shared-library Editor's tags are their own organization and must never
            // leak into the owner's metadata or originals.
            .whereRef('tag.userId', '=', 'asset.ownerId'),
        ).as('tags'),
      )
      .where('asset.id', '=', id)
      .executeTakeFirstOrThrow();
  }
}
