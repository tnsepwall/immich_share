import { createZodDto } from 'nestjs-zod';
import { Library, LibraryUser, SharedLibrary } from 'src/database';
import { UserResponseSchema, mapUser } from 'src/dtos/user.dto';
import { LibraryUserRole, LibraryUserRoleSchema } from 'src/enum';
import { isoDatetimeToDate } from 'src/validation';
import z from 'zod';

const stringArrayMax128 = z
  .array(z.string())
  .max(128)
  .refine((arr) => arr.every((s) => s.trim() !== ''), 'Array items must not be empty')
  .refine((arr) => new Set(arr).size === arr.length, 'Array must have unique items');

const CreateLibrarySchema = z
  .object({
    ownerId: z.uuidv4().describe('Owner user ID'),
    name: z.string().min(1).optional().describe('Library name'),
    importPaths: stringArrayMax128.optional().describe('Import paths (max 128)'),
    exclusionPatterns: stringArrayMax128.optional().describe('Exclusion patterns (max 128)'),
  })
  .meta({ id: 'CreateLibraryDto' });

const UpdateLibrarySchema = z
  .object({
    name: z.string().min(1).optional().describe('Library name'),
    importPaths: stringArrayMax128.optional().describe('Import paths (max 128)'),
    exclusionPatterns: stringArrayMax128.optional().describe('Exclusion patterns (max 128)'),
  })
  .meta({ id: 'UpdateLibraryDto' });

export interface CrawlOptionsDto {
  pathsToCrawl: string[];
  includeHidden?: boolean;
  exclusionPatterns?: string[];
}

export interface WalkOptionsDto extends CrawlOptionsDto {
  take: number;
}

const ValidateLibrarySchema = z
  .object({
    importPaths: stringArrayMax128.optional().describe('Import paths to validate (max 128)'),
    exclusionPatterns: stringArrayMax128.optional().describe('Exclusion patterns (max 128)'),
  })
  .meta({ id: 'ValidateLibraryDto' });

const ValidateLibraryImportPathResponseSchema = z
  .object({
    importPath: z.string().describe('Import path'),
    isValid: z.boolean().describe('Is valid'),
    message: z.string().optional().describe('Validation message'),
  })
  .meta({ id: 'ValidateLibraryImportPathResponseDto' });

const ValidateLibraryResponseSchema = z
  .object({
    importPaths: z
      .array(ValidateLibraryImportPathResponseSchema)
      .optional()
      .describe('Validation results for import paths'),
  })
  .meta({ id: 'ValidateLibraryResponseDto' });

const LibraryUserResponseSchema = z
  .object({
    user: UserResponseSchema,
    role: LibraryUserRoleSchema,
  })
  .meta({ id: 'LibraryUserResponseDto' });

const LibraryUsersSchema = z
  .object({
    users: z
      .array(
        z.object({
          userId: z.uuidv4().describe('User ID to share the library with'),
          role: LibraryUserRoleSchema.default(LibraryUserRole.Viewer),
        }),
      )
      .min(1)
      .max(64)
      .refine((users) => new Set(users.map(({ userId }) => userId)).size === users.length, 'User ids must be unique'),
  })
  .meta({ id: 'LibraryUsersDto' });

const LibraryUserUpdateSchema = z
  .object({
    role: LibraryUserRoleSchema,
  })
  .meta({ id: 'LibraryUserUpdateDto' });

const SharedLibraryResponseSchema = z
  .object({
    id: z.uuidv4().describe('Library ID'),
    name: z.string().describe('Library name'),
    ownerId: z.uuidv4().describe('Owner user ID'),
    owner: UserResponseSchema,
    role: LibraryUserRoleSchema,
    createdAt: isoDatetimeToDate.describe('Creation date'),
    refreshedAt: isoDatetimeToDate.nullable().describe('Last refresh date'),
    assetCount: z.int().describe('Number of assets visible to the recipient'),
  })
  .meta({ id: 'SharedLibraryResponseDto' });

const LibraryResponseSchema = z
  .object({
    id: z.uuidv4().describe('Library ID'),
    ownerId: z.uuidv4().describe('Owner user ID'),
    name: z.string().describe('Library name'),
    assetCount: z.int().describe('Number of assets'),
    importPaths: z.array(z.string()).describe('Import paths'),
    exclusionPatterns: z.array(z.string()).describe('Exclusion patterns'),
    createdAt: isoDatetimeToDate.describe('Creation date'),
    updatedAt: isoDatetimeToDate.describe('Last update date'),
    refreshedAt: isoDatetimeToDate.nullable().describe('Last refresh date'),
    sharedUsers: z.array(LibraryUserResponseSchema).optional().describe('Users this library is shared with'),
  })
  .meta({ id: 'LibraryResponseDto' });

const LibraryStatsResponseSchema = z
  .object({
    photos: z.int().describe('Number of photos'),
    videos: z.int().describe('Number of videos'),
    total: z.int().describe('Total number of assets'),
    usage: z.int().describe('Storage usage in bytes'),
  })
  .meta({ id: 'LibraryStatsResponseDto' });

export class CreateLibraryDto extends createZodDto(CreateLibrarySchema) {}
export class UpdateLibraryDto extends createZodDto(UpdateLibrarySchema) {}
export class ValidateLibraryDto extends createZodDto(ValidateLibrarySchema) {}
export class ValidateLibraryResponseDto extends createZodDto(ValidateLibraryResponseSchema) {}
export class ValidateLibraryImportPathResponseDto extends createZodDto(ValidateLibraryImportPathResponseSchema) {}
export class LibraryResponseDto extends createZodDto(LibraryResponseSchema) {}
export class LibraryStatsResponseDto extends createZodDto(LibraryStatsResponseSchema) {}
export class LibraryUsersDto extends createZodDto(LibraryUsersSchema) {}
export class LibraryUserUpdateDto extends createZodDto(LibraryUserUpdateSchema) {}
export class LibraryUserResponseDto extends createZodDto(LibraryUserResponseSchema) {}
export class SharedLibraryResponseDto extends createZodDto(SharedLibraryResponseSchema) {}

export function mapLibrary(entity: Library, options: { sharedUsers?: LibraryUserResponseDto[] } = {}): LibraryResponseDto {
  let assetCount = 0;
  if (entity.assets) {
    assetCount = entity.assets.length;
  }
  return {
    id: entity.id,
    ownerId: entity.ownerId,
    name: entity.name,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    refreshedAt: entity.refreshedAt,
    assetCount,
    importPaths: entity.importPaths,
    exclusionPatterns: entity.exclusionPatterns,
    sharedUsers: options.sharedUsers,
  };
}

export function mapLibraryUser(entity: LibraryUser): LibraryUserResponseDto {
  return {
    user: mapUser(entity.user),
    role: entity.role,
  };
}

export function mapSharedLibrary(entity: SharedLibrary): SharedLibraryResponseDto {
  return {
    id: entity.id,
    name: entity.name,
    ownerId: entity.ownerId,
    owner: mapUser(entity.owner),
    role: entity.role,
    createdAt: entity.createdAt,
    refreshedAt: entity.refreshedAt,
    assetCount: entity.assetCount ?? 0,
  };
}
