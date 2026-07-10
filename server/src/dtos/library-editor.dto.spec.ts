import { LibraryAssetBulkUpdateSchema, LibraryAssetUpdateSchema } from 'src/dtos/library-editor.dto';
import { factory } from 'test/small.factory';

const ids = [factory.uuid()];

describe('LibraryAssetUpdateSchema', () => {
  it('should accept each allowlisted field on its own', () => {
    expect(LibraryAssetUpdateSchema.safeParse({ description: 'a description' }).success).toBe(true);
    expect(LibraryAssetUpdateSchema.safeParse({ dateTimeOriginal: '2024-01-01T00:00:00.000Z' }).success).toBe(true);
    expect(LibraryAssetUpdateSchema.safeParse({ dateTimeRelative: 90 }).success).toBe(true);
    expect(LibraryAssetUpdateSchema.safeParse({ timeZone: 'America/Winnipeg' }).success).toBe(true);
    expect(LibraryAssetUpdateSchema.safeParse({ rating: 5 }).success).toBe(true);
    expect(LibraryAssetUpdateSchema.safeParse({ latitude: 49.89, longitude: -97.14 }).success).toBe(true);
  });

  it('should reject an empty update', () => {
    expect(LibraryAssetUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('should reject unknown keys instead of stripping them', () => {
    expect(LibraryAssetUpdateSchema.safeParse({ description: 'ok', visibility: 'archive' }).success).toBe(false);
    expect(LibraryAssetUpdateSchema.safeParse({ description: 'ok', isFavorite: true }).success).toBe(false);
    expect(LibraryAssetUpdateSchema.safeParse({ description: 'ok', duplicateId: null }).success).toBe(false);
    expect(LibraryAssetUpdateSchema.safeParse({ description: 'ok', livePhotoVideoId: factory.uuid() }).success).toBe(
      false,
    );
  });

  it('should reject dateTimeOriginal combined with dateTimeRelative', () => {
    expect(
      LibraryAssetUpdateSchema.safeParse({ dateTimeOriginal: '2024-01-01T00:00:00.000Z', dateTimeRelative: 90 })
        .success,
    ).toBe(false);
  });

  it('should require latitude and longitude together', () => {
    expect(LibraryAssetUpdateSchema.safeParse({ latitude: 49.89 }).success).toBe(false);
    expect(LibraryAssetUpdateSchema.safeParse({ longitude: -97.14 }).success).toBe(false);
    expect(LibraryAssetUpdateSchema.safeParse({ latitude: null, longitude: null }).success).toBe(true);
    expect(LibraryAssetUpdateSchema.safeParse({ latitude: 49.89, longitude: null }).success).toBe(false);
    expect(LibraryAssetUpdateSchema.safeParse({ latitude: null, longitude: -97.14 }).success).toBe(false);
  });

  it('should validate coordinate ranges', () => {
    expect(LibraryAssetUpdateSchema.safeParse({ latitude: 91, longitude: 0 }).success).toBe(false);
    expect(LibraryAssetUpdateSchema.safeParse({ latitude: 0, longitude: 181 }).success).toBe(false);
  });

  it('should validate the rating range and reject 0', () => {
    expect(LibraryAssetUpdateSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(LibraryAssetUpdateSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(LibraryAssetUpdateSchema.safeParse({ rating: -2 }).success).toBe(false);
    expect(LibraryAssetUpdateSchema.safeParse({ rating: -1 }).success).toBe(true);
    expect(LibraryAssetUpdateSchema.safeParse({ rating: null }).success).toBe(true);
  });

  it('should not accept an ids field (single-asset route)', () => {
    expect(LibraryAssetUpdateSchema.safeParse({ description: 'ok', ids }).success).toBe(false);
  });
});

describe('LibraryAssetBulkUpdateSchema', () => {
  it('should accept a valid bulk update', () => {
    const result = LibraryAssetBulkUpdateSchema.safeParse({ ids, description: 'a description' });
    expect(result.success).toBe(true);
  });

  it('should require ids', () => {
    expect(LibraryAssetBulkUpdateSchema.safeParse({ description: 'ok' }).success).toBe(false);
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids: [], description: 'ok' }).success).toBe(false);
  });

  it('should reject more than 100 ids', () => {
    const tooMany = Array.from({ length: 101 }, () => factory.uuid());
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids: tooMany, description: 'ok' }).success).toBe(false);

    const exactlyOneHundred = Array.from({ length: 100 }, () => factory.uuid());
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids: exactlyOneHundred, description: 'ok' }).success).toBe(true);
  });

  it('should reject duplicate ids', () => {
    const id = factory.uuid();
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids: [id, id], description: 'ok' }).success).toBe(false);
  });

  it('should reject non-uuid ids', () => {
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids: ['not-a-uuid'], description: 'ok' }).success).toBe(false);
  });

  it('should reject an update with ids but no fields', () => {
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids }).success).toBe(false);
  });

  it('should reject unknown keys instead of stripping them', () => {
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids, description: 'ok', visibility: 'archive' }).success).toBe(
      false,
    );
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids, description: 'ok', isFavorite: true }).success).toBe(false);
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids, description: 'ok', duplicateId: null }).success).toBe(false);
  });

  it('should reject dateTimeOriginal combined with dateTimeRelative', () => {
    expect(
      LibraryAssetBulkUpdateSchema.safeParse({
        ids,
        dateTimeOriginal: '2024-01-01T00:00:00.000Z',
        dateTimeRelative: 90,
      }).success,
    ).toBe(false);
  });

  it('should require latitude and longitude together', () => {
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids, latitude: 49.89 }).success).toBe(false);
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids, latitude: 49.89, longitude: -97.14 }).success).toBe(true);
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids, latitude: null, longitude: null }).success).toBe(true);
    expect(LibraryAssetBulkUpdateSchema.safeParse({ ids, latitude: 49.89, longitude: null }).success).toBe(false);
  });
});
