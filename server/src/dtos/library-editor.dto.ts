import { createZodDto } from 'nestjs-zod';
import { IsNotSiblingOf, latitudeSchema, longitudeSchema } from 'src/validation';
import z from 'zod';

// The Editor curation allowlist. These validators are copied from UpdateAssetBaseSchema /
// AssetBulkUpdateBaseSchema in src/dtos/asset.dto.ts on purpose — same semantics, narrower surface.
// Owner-only fields (visibility, isFavorite, duplicateId, livePhotoVideoId, ...) are deliberately
// absent AND the schemas are strict, so an unknown key is a 400 instead of being silently stripped.
const libraryAssetUpdateFields = {
  description: z.string().optional().describe('Asset description'),
  dateTimeOriginal: z.string().optional().describe('Original date and time'),
  dateTimeRelative: z.int().optional().describe('Relative time offset in minutes'),
  timeZone: z.string().optional().describe('Time zone (IANA timezone)'),
  latitude: latitudeSchema.nullish().describe('Latitude coordinate'),
  longitude: longitudeSchema.nullish().describe('Longitude coordinate'),
  rating: z
    .int()
    .min(-1)
    .max(5)
    .nullish()
    .refine((v) => v !== 0, {
      error: 'Rating must be -1 (rejected), 1–5 (starred), or null (unrated); 0 is not valid',
    })
    .describe('Rating in range [1-5] (starred), -1 (rejected), or null (unrated)'),
};

const updatableFields = Object.keys(libraryAssetUpdateFields) as (keyof typeof libraryAssetUpdateFields)[];

type CoordinateFields = { latitude?: number | null; longitude?: number | null };

const coordinatesProvidedTogether = (data: CoordinateFields) =>
  (data.latitude === undefined && data.longitude === undefined) ||
  (data.latitude !== undefined && data.longitude !== undefined);

const coordinatesClearedTogether = (data: CoordinateFields) => (data.latitude === null) === (data.longitude === null);

const hasAtLeastOneUpdatableField = (data: Partial<Record<keyof typeof libraryAssetUpdateFields, unknown>>) =>
  updatableFields.some((field) => data[field] !== undefined);

const LibraryAssetUpdateBaseSchema = z
  .strictObject(libraryAssetUpdateFields)
  .refine(coordinatesProvidedTogether, { message: 'Latitude and longitude must be provided together' })
  .refine(coordinatesClearedTogether, { message: 'Latitude and longitude must be cleared together' })
  .refine(hasAtLeastOneUpdatableField, { message: 'At least one field must be provided' });

export const LibraryAssetUpdateSchema = LibraryAssetUpdateBaseSchema.pipe(
  IsNotSiblingOf(LibraryAssetUpdateBaseSchema, 'dateTimeRelative', ['dateTimeOriginal']),
).meta({ id: 'LibraryAssetUpdateDto' });

const LibraryAssetBulkUpdateBaseSchema = z
  .strictObject({
    ...libraryAssetUpdateFields,
    ids: z
      .array(z.uuidv4())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Asset ids must be unique')
      .describe('Asset IDs to update (max 100)'),
  })
  .refine(coordinatesProvidedTogether, { message: 'Latitude and longitude must be provided together' })
  .refine(coordinatesClearedTogether, { message: 'Latitude and longitude must be cleared together' })
  .refine(hasAtLeastOneUpdatableField, { message: 'At least one field must be provided' });

export const LibraryAssetBulkUpdateSchema = LibraryAssetBulkUpdateBaseSchema.pipe(
  IsNotSiblingOf(LibraryAssetBulkUpdateBaseSchema, 'dateTimeRelative', ['dateTimeOriginal']),
).meta({ id: 'LibraryAssetBulkUpdateDto' });

const LibraryAssetUpdateParamsSchema = z
  .object({
    libraryId: z.uuidv4().describe('Library ID'),
    assetId: z.uuidv4().describe('Asset ID'),
  })
  .meta({ id: 'LibraryAssetUpdateParams' });

const LibraryAssetBulkUpdateParamsSchema = z
  .object({
    libraryId: z.uuidv4().describe('Library ID'),
  })
  .meta({ id: 'LibraryAssetBulkUpdateParams' });

export class LibraryAssetUpdateDto extends createZodDto(LibraryAssetUpdateSchema) {}
export class LibraryAssetBulkUpdateDto extends createZodDto(LibraryAssetBulkUpdateSchema) {}
export class LibraryAssetUpdateParams extends createZodDto(LibraryAssetUpdateParamsSchema) {}
export class LibraryAssetBulkUpdateParams extends createZodDto(LibraryAssetBulkUpdateParamsSchema) {}
