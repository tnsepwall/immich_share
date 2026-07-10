/**
 * TEMPORARY hand-written API client for the "shared external libraries" feature.
 *
 * WHY THIS FILE EXISTS: `packages/sdk` (the generated OpenAPI client) has NOT been regenerated
 * at any point during this engagement, so none of the shared-external-libraries endpoints added
 * across Phases 1, 3, and 4 exist in `@immich/sdk` yet. This file hand-writes typed wrappers for
 * exactly those endpoints, mirroring the exact calling convention `oazapfts` generates (see
 * `packages/sdk/src/fetch-client.ts`) so that a future real `mise open-api` run should be close to
 * a drop-in replacement for these same call sites.
 *
 * See IMPLEMENTATION-LOG-phase4.md for context.
 *
 * DELETE THIS FILE once `mise open-api` has been run for real against an updated OpenAPI spec that
 * includes these routes, and switch every importer below to `@immich/sdk` instead.
 *
 * Do NOT add anything to this file that isn't a shared-library (Phase 1/3/4) endpoint - everything
 * else should keep using `@immich/sdk` normally.
 */
import { defaults, type AssetResponseDto, type UserResponseDto } from '@immich/sdk';
import * as Oazapfts from '@oazapfts/runtime';
import * as QS from '@oazapfts/runtime/query';

const oazapfts = Oazapfts.runtime(defaults);

// ---------------------------------------------------------------------------
// Types (mirroring server DTOs)
// ---------------------------------------------------------------------------

// server/src/enum.ts
export enum LibraryUserRole {
  Viewer = 'viewer',
  Editor = 'editor',
}

// --- Phase 1: server/src/dtos/library.dto.ts ---------------------------------

export type LibraryUserResponseDto = {
  user: UserResponseDto;
  role: LibraryUserRole;
};

export type LibraryUsersDto = {
  /** Users to share the library with (1-64, unique user ids) */
  users: {
    /** User ID to share the library with */
    userId: string;
    role?: LibraryUserRole;
  }[];
};

export type LibraryUserUpdateDto = {
  role: LibraryUserRole;
};

export type SharedLibraryResponseDto = {
  /** Library ID */
  id: string;
  /** Library name */
  name: string;
  /** Owner user ID */
  ownerId: string;
  owner: UserResponseDto;
  role: LibraryUserRole;
  /** Creation date */
  createdAt: string;
  /** Last refresh date */
  refreshedAt: string | null;
  /** Number of assets visible to the recipient */
  assetCount: number;
};

export type LibraryResponseDto = {
  /** Library ID */
  id: string;
  /** Owner user ID */
  ownerId: string;
  /** Library name */
  name: string;
  /** Number of assets */
  assetCount: number;
  /** Import paths */
  importPaths: string[];
  /** Exclusion patterns */
  exclusionPatterns: string[];
  /** Creation date */
  createdAt: string;
  /** Last update date */
  updatedAt: string;
  /** Last refresh date */
  refreshedAt: string | null;
  /** Users this library is shared with */
  sharedUsers?: LibraryUserResponseDto[];
};

// --- Phase 3: server/src/dtos/library-editor.dto.ts --------------------------

export type LibraryAssetUpdateDto = {
  /** Asset description */
  description?: string;
  /** Original date and time */
  dateTimeOriginal?: string;
  /** Relative time offset in minutes */
  dateTimeRelative?: number;
  /** Time zone (IANA timezone) */
  timeZone?: string;
  /** Latitude coordinate */
  latitude?: number | null;
  /** Longitude coordinate */
  longitude?: number | null;
  /** Rating in range [1-5] (starred), -1 (rejected), or null (unrated) */
  rating?: number | null;
};

export type LibraryAssetBulkUpdateDto = LibraryAssetUpdateDto & {
  /** Asset IDs to update (max 100) */
  ids: string[];
};

// --- Phase 4: server/src/dtos/library-person.dto.ts --------------------------

export type LibraryThumbnailFace = {
  /** Face ID */
  faceId: string;
  /** Asset ID the face belongs to */
  assetId: string;
  /** Bounding box X1 coordinate */
  boundingBoxX1: number;
  /** Bounding box X2 coordinate */
  boundingBoxX2: number;
  /** Bounding box Y1 coordinate */
  boundingBoxY1: number;
  /** Bounding box Y2 coordinate */
  boundingBoxY2: number;
  /** Image width in pixels */
  imageWidth: number;
  /** Image height in pixels */
  imageHeight: number;
};

/** A person visible within this library share */
export type LibraryPersonResponseDto = {
  /** Person ID */
  id: string;
  /** Person name */
  name: string;
  /**
   * This person's global thumbnail is never returned here, since its source face may be outside
   * this library. Null when the person has no visible face within this library.
   */
  thumbnailFace: LibraryThumbnailFace | null;
};

/** Library people response */
export type LibraryPeopleResponseDto = {
  people: LibraryPersonResponseDto[];
  /** Whether there are more pages */
  hasNextPage: boolean;
};

export type LibraryFacePerson = {
  /** Person ID */
  id: string;
  /** Person name */
  name: string;
};

/** A face on a library asset */
export type LibraryFaceResponseDto = {
  /** Face ID */
  id: string;
  /** Asset ID the face belongs to */
  assetId: string;
  /** Image width in pixels */
  imageWidth: number;
  /** Image height in pixels */
  imageHeight: number;
  /** Bounding box X1 coordinate */
  boundingBoxX1: number;
  /** Bounding box X2 coordinate */
  boundingBoxX2: number;
  /** Bounding box Y1 coordinate */
  boundingBoxY1: number;
  /** Bounding box Y2 coordinate */
  boundingBoxY2: number;
  /** Assigned person, or null if unassigned */
  person: LibraryFacePerson | null;
};

export type LibraryPersonCreateDto = {
  /** Person name */
  name: string;
  /** Faces within this library to assign to the new person (1-64, unique) */
  faceIds: string[];
};

export type LibraryPersonUpdateDto = {
  /** Person name */
  name: string;
};

export type LibraryFaceAssignDto = {
  /** Person ID to assign the faces to */
  personId: string;
  /** Faces within this library to (re)assign (1-64, unique) */
  faceIds: string[];
};

export type LibraryManualFaceDto = {
  /** Asset ID within this library */
  assetId: string;
  /** Person ID to assign the new face to */
  personId: string;
  /** Image width in pixels */
  imageWidth: number;
  /** Image height in pixels */
  imageHeight: number;
  /** Face bounding box X coordinate */
  x: number;
  /** Face bounding box Y coordinate */
  y: number;
  /** Face bounding box width */
  width: number;
  /** Face bounding box height */
  height: number;
};

// ---------------------------------------------------------------------------
// Endpoints (server/src/controllers/library.controller.ts)
// ---------------------------------------------------------------------------

/**
 * Retrieve my libraries
 */
export function getMyLibraries(opts?: Oazapfts.RequestOpts) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 200;
      data: LibraryResponseDto[];
    }>('/libraries/mine', {
      ...opts,
    }),
  );
}

/**
 * Retrieve libraries shared with me
 */
export function getLibrariesSharedWithMe(opts?: Oazapfts.RequestOpts) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 200;
      data: SharedLibraryResponseDto[];
    }>('/libraries/shared-with-me', {
      ...opts,
    }),
  );
}

/**
 * Share a library
 */
export function addLibraryUsers(
  { id, libraryUsersDto }: { id: string; libraryUsersDto: LibraryUsersDto },
  opts?: Oazapfts.RequestOpts,
) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 200;
      data: LibraryUserResponseDto[];
    }>(
      `/libraries/${encodeURIComponent(id)}/users`,
      oazapfts.json({
        ...opts,
        method: 'PUT',
        body: libraryUsersDto,
      }),
    ),
  );
}

/**
 * Update a library user's role
 */
export function updateLibraryUserRole(
  { id, userId, libraryUserUpdateDto }: { id: string; userId: string; libraryUserUpdateDto: LibraryUserUpdateDto },
  opts?: Oazapfts.RequestOpts,
) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 200;
      data: LibraryUserResponseDto;
    }>(
      `/libraries/${encodeURIComponent(id)}/users/${encodeURIComponent(userId)}`,
      oazapfts.json({
        ...opts,
        method: 'PUT',
        body: libraryUserUpdateDto,
      }),
    ),
  );
}

/**
 * Remove a library user
 */
export function removeLibraryUser({ id, userId }: { id: string; userId: string }, opts?: Oazapfts.RequestOpts) {
  return oazapfts.ok(
    oazapfts.fetchText(`/libraries/${encodeURIComponent(id)}/users/${encodeURIComponent(userId)}`, {
      ...opts,
      method: 'DELETE',
    }),
  );
}

/**
 * Update a library asset
 */
export function updateLibraryAsset(
  {
    libraryId,
    assetId,
    libraryAssetUpdateDto,
  }: { libraryId: string; assetId: string; libraryAssetUpdateDto: LibraryAssetUpdateDto },
  opts?: Oazapfts.RequestOpts,
) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 200;
      data: AssetResponseDto;
    }>(
      `/libraries/${encodeURIComponent(libraryId)}/assets/${encodeURIComponent(assetId)}`,
      oazapfts.json({
        ...opts,
        method: 'PATCH',
        body: libraryAssetUpdateDto,
      }),
    ),
  );
}

/**
 * Update library assets
 */
export function updateLibraryAssets(
  { libraryId, libraryAssetBulkUpdateDto }: { libraryId: string; libraryAssetBulkUpdateDto: LibraryAssetBulkUpdateDto },
  opts?: Oazapfts.RequestOpts,
) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 200;
      data: AssetResponseDto[];
    }>(
      `/libraries/${encodeURIComponent(libraryId)}/assets`,
      oazapfts.json({
        ...opts,
        method: 'PATCH',
        body: libraryAssetBulkUpdateDto,
      }),
    ),
  );
}

/**
 * Retrieve library people
 */
export function getLibraryPeople(
  { libraryId, page, size }: { libraryId: string; page?: number; size?: number },
  opts?: Oazapfts.RequestOpts,
) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 200;
      data: LibraryPeopleResponseDto;
    }>(
      `/libraries/${encodeURIComponent(libraryId)}/people${QS.query(
        QS.explode({
          page,
          size,
        }),
      )}`,
      {
        ...opts,
      },
    ),
  );
}

/**
 * Create a library person
 */
export function createLibraryPerson(
  { libraryId, libraryPersonCreateDto }: { libraryId: string; libraryPersonCreateDto: LibraryPersonCreateDto },
  opts?: Oazapfts.RequestOpts,
) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 201;
      data: LibraryPersonResponseDto;
    }>(
      `/libraries/${encodeURIComponent(libraryId)}/people`,
      oazapfts.json({
        ...opts,
        method: 'POST',
        body: libraryPersonCreateDto,
      }),
    ),
  );
}

/**
 * Rename a library person
 */
export function updateLibraryPerson(
  {
    libraryId,
    personId,
    libraryPersonUpdateDto,
  }: { libraryId: string; personId: string; libraryPersonUpdateDto: LibraryPersonUpdateDto },
  opts?: Oazapfts.RequestOpts,
) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 200;
      data: LibraryPersonResponseDto;
    }>(
      `/libraries/${encodeURIComponent(libraryId)}/people/${encodeURIComponent(personId)}`,
      oazapfts.json({
        ...opts,
        method: 'PUT',
        body: libraryPersonUpdateDto,
      }),
    ),
  );
}

/**
 * Retrieve library asset faces
 */
export function getLibraryAssetFaces(
  { libraryId, assetId }: { libraryId: string; assetId: string },
  opts?: Oazapfts.RequestOpts,
) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 200;
      data: LibraryFaceResponseDto[];
    }>(`/libraries/${encodeURIComponent(libraryId)}/assets/${encodeURIComponent(assetId)}/faces`, {
      ...opts,
    }),
  );
}

/**
 * Create a manual library face
 */
export function createLibraryFace(
  { libraryId, libraryManualFaceDto }: { libraryId: string; libraryManualFaceDto: LibraryManualFaceDto },
  opts?: Oazapfts.RequestOpts,
) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 201;
      data: LibraryFaceResponseDto;
    }>(
      `/libraries/${encodeURIComponent(libraryId)}/faces`,
      oazapfts.json({
        ...opts,
        method: 'POST',
        body: libraryManualFaceDto,
      }),
    ),
  );
}

/**
 * Assign library faces
 */
export function assignLibraryFaces(
  { libraryId, libraryFaceAssignDto }: { libraryId: string; libraryFaceAssignDto: LibraryFaceAssignDto },
  opts?: Oazapfts.RequestOpts,
) {
  return oazapfts.ok(
    oazapfts.fetchJson<{
      status: 200;
      data: LibraryFaceResponseDto[];
    }>(
      `/libraries/${encodeURIComponent(libraryId)}/faces`,
      oazapfts.json({
        ...opts,
        method: 'PUT',
        body: libraryFaceAssignDto,
      }),
    ),
  );
}
