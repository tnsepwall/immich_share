import { Selectable } from 'kysely';
import { createZodDto } from 'nestjs-zod';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table';
import { PersonTable } from 'src/schema/tables/person.table';
import z from 'zod';

// Library Editor person/face curation surface. Scoped so an Editor can only ever see or touch
// people and faces reachable through faces on assets inside the library they're editing - never
// the global thumbnailPath (its source face may live outside the library) and never a person's
// faces in other libraries. See FEATURE-PLAN-shared-external-libraries.md section 2 point 3.

const LibraryPersonParamsSchema = z
  .object({
    libraryId: z.uuidv4().describe('Library ID'),
  })
  .meta({ id: 'LibraryPersonParams' });

const LibraryPersonIdParamsSchema = z
  .object({
    libraryId: z.uuidv4().describe('Library ID'),
    personId: z.uuidv4().describe('Person ID'),
  })
  .meta({ id: 'LibraryPersonIdParams' });

export class LibraryPersonParams extends createZodDto(LibraryPersonParamsSchema) {}
export class LibraryPersonIdParams extends createZodDto(LibraryPersonIdParamsSchema) {}

const LibraryPeopleSearchSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).describe('Page number for pagination'),
    size: z.coerce.number().int().min(1).max(1000).default(500).describe('Number of items per page'),
  })
  .meta({ id: 'LibraryPeopleSearchDto' });

export class LibraryPeopleSearchDto extends createZodDto(LibraryPeopleSearchSchema) {}

const LibraryThumbnailFaceSchema = z
  .object({
    faceId: z.uuidv4().describe('Face ID'),
    assetId: z.uuidv4().describe('Asset ID the face belongs to'),
    boundingBoxX1: z.int().describe('Bounding box X1 coordinate'),
    boundingBoxX2: z.int().describe('Bounding box X2 coordinate'),
    boundingBoxY1: z.int().describe('Bounding box Y1 coordinate'),
    boundingBoxY2: z.int().describe('Bounding box Y2 coordinate'),
    imageWidth: z.int().min(0).describe('Image width in pixels'),
    imageHeight: z.int().min(0).describe('Image height in pixels'),
  })
  .describe('A representative face within this library, for the client to crop as a thumbnail')
  .meta({ id: 'LibraryThumbnailFace' });

export const LibraryPersonResponseSchema = z
  .object({
    id: z.uuidv4().describe('Person ID'),
    name: z.string().describe('Person name'),
    thumbnailFace: LibraryThumbnailFaceSchema.nullable().describe(
      "This person's global thumbnail is never returned here, since its source face may be outside " +
        'this library. Null when the person has no visible face within this library.',
    ),
  })
  .describe('A person visible within this library share')
  .meta({ id: 'LibraryPersonResponseDto' });

export class LibraryPersonResponseDto extends createZodDto(LibraryPersonResponseSchema) {}

export const LibraryPeopleResponseSchema = z
  .object({
    people: z.array(LibraryPersonResponseSchema),
    hasNextPage: z.boolean().describe('Whether there are more pages'),
  })
  .describe('Library people response')
  .meta({ id: 'LibraryPeopleResponseDto' });

export class LibraryPeopleResponseDto extends createZodDto(LibraryPeopleResponseSchema) {}

const LibraryFacePersonSchema = z
  .object({
    id: z.uuidv4().describe('Person ID'),
    name: z.string().describe('Person name'),
  })
  .meta({ id: 'LibraryFacePerson' });

export const LibraryFaceResponseSchema = z
  .object({
    id: z.uuidv4().describe('Face ID'),
    assetId: z.uuidv4().describe('Asset ID the face belongs to'),
    imageWidth: z.int().min(0).describe('Image width in pixels'),
    imageHeight: z.int().min(0).describe('Image height in pixels'),
    boundingBoxX1: z.int().describe('Bounding box X1 coordinate'),
    boundingBoxX2: z.int().describe('Bounding box X2 coordinate'),
    boundingBoxY1: z.int().describe('Bounding box Y1 coordinate'),
    boundingBoxY2: z.int().describe('Bounding box Y2 coordinate'),
    person: LibraryFacePersonSchema.nullable().describe('Assigned person, or null if unassigned'),
  })
  .describe('A face on a library asset')
  .meta({ id: 'LibraryFaceResponseDto' });

export class LibraryFaceResponseDto extends createZodDto(LibraryFaceResponseSchema) {}

const LibraryPersonCreateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).describe('Person name'),
    faceIds: z
      .array(z.uuidv4())
      .min(1)
      .max(64)
      .refine((ids) => new Set(ids).size === ids.length, 'Face ids must be unique')
      .describe('Faces within this library to assign to the new person'),
  })
  .meta({ id: 'LibraryPersonCreateDto' });

export class LibraryPersonCreateDto extends createZodDto(LibraryPersonCreateSchema) {}

const LibraryPersonUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).describe('Person name'),
  })
  .meta({ id: 'LibraryPersonUpdateDto' });

export class LibraryPersonUpdateDto extends createZodDto(LibraryPersonUpdateSchema) {}

const LibraryFaceAssignSchema = z
  .strictObject({
    personId: z.uuidv4().describe('Person ID to assign the faces to'),
    faceIds: z
      .array(z.uuidv4())
      .min(1)
      .max(64)
      .refine((ids) => new Set(ids).size === ids.length, 'Face ids must be unique')
      .describe('Faces within this library to (re)assign'),
  })
  .meta({ id: 'LibraryFaceAssignDto' });

export class LibraryFaceAssignDto extends createZodDto(LibraryFaceAssignSchema) {}

const boundingBoxWithinImage = (data: {
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
}) => data.x + data.width <= data.imageWidth && data.y + data.height <= data.imageHeight;

const LibraryManualFaceSchema = z
  .strictObject({
    assetId: z.uuidv4().describe('Asset ID within this library'),
    personId: z.uuidv4().describe('Person ID to assign the new face to'),
    imageWidth: z.int().positive().describe('Image width in pixels'),
    imageHeight: z.int().positive().describe('Image height in pixels'),
    x: z.int().min(0).describe('Face bounding box X coordinate'),
    y: z.int().min(0).describe('Face bounding box Y coordinate'),
    width: z.int().positive().describe('Face bounding box width'),
    height: z.int().positive().describe('Face bounding box height'),
  })
  .refine(boundingBoxWithinImage, { error: 'Bounding box must be within the image dimensions' })
  .meta({ id: 'LibraryManualFaceDto' });

export class LibraryManualFaceDto extends createZodDto(LibraryManualFaceSchema) {}

type LibraryPersonRow = Pick<Selectable<PersonTable>, 'id' | 'name'> & {
  thumbnailFace: {
    faceId: string;
    assetId: string;
    boundingBoxX1: number;
    boundingBoxY1: number;
    boundingBoxX2: number;
    boundingBoxY2: number;
    imageWidth: number;
    imageHeight: number;
  } | null;
};

export function mapLibraryPerson(person: LibraryPersonRow): LibraryPersonResponseDto {
  return {
    id: person.id,
    name: person.name,
    thumbnailFace: person.thumbnailFace,
  };
}

type LibraryFaceRow = Pick<
  Selectable<AssetFaceTable>,
  | 'id'
  | 'assetId'
  | 'imageWidth'
  | 'imageHeight'
  | 'boundingBoxX1'
  | 'boundingBoxX2'
  | 'boundingBoxY1'
  | 'boundingBoxY2'
> & {
  person: { id: string; name: string } | null;
};

export function mapLibraryFace(face: LibraryFaceRow): LibraryFaceResponseDto {
  return {
    id: face.id,
    assetId: face.assetId,
    imageWidth: face.imageWidth,
    imageHeight: face.imageHeight,
    boundingBoxX1: face.boundingBoxX1,
    boundingBoxX2: face.boundingBoxX2,
    boundingBoxY1: face.boundingBoxY1,
    boundingBoxY2: face.boundingBoxY2,
    person: face.person,
  };
}
