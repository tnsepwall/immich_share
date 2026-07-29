import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthSharedLink } from 'src/database';
import { AuthDto } from 'src/dtos/auth.dto';
import { AlbumUserRole, Permission } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { areSetsEqual, isSetSuperset, setDifference, setUnion } from 'src/utils/set';

export type GrantedRequest = {
  requested: Permission[];
  current: Permission[];
};

export const isGranted = ({ requested, current }: GrantedRequest) => {
  if (current.includes(Permission.All)) {
    return true;
  }

  return isSetSuperset(new Set(current), new Set(requested));
};

export type AccessRequest = {
  auth: AuthDto;
  permission: Permission;
  ids: Set<string> | string[];
};

type SharedLinkAccessRequest = { sharedLink: AuthSharedLink; permission: Permission; ids: Set<string> };
type OtherAccessRequest = { auth: AuthDto; permission: Permission; ids: Set<string> };

export const requireUploadAccess = (auth: AuthDto | null): AuthDto => {
  if (!auth || (auth.sharedLink && !auth.sharedLink.allowUpload)) {
    throw new UnauthorizedException();
  }
  return auth;
};

export const requireAccess = async (access: AccessRepository, request: AccessRequest) => {
  const allowedIds = await checkAccess(access, request);
  if (!areSetsEqual(new Set(request.ids), allowedIds)) {
    throw new BadRequestException(`Not found or no ${request.permission} access`);
  }
};

export const checkAccess = async (
  access: AccessRepository,
  { ids, auth, permission }: AccessRequest,
): Promise<Set<string>> => {
  const idSet = Array.isArray(ids) ? new Set(ids) : ids;
  if (idSet.size === 0) {
    return new Set<string>();
  }

  return auth.sharedLink
    ? checkSharedLinkAccess(access, { sharedLink: auth.sharedLink, permission, ids: idSet })
    : checkOtherAccess(access, { auth, permission, ids: idSet });
};

const checkSharedLinkAccess = async (
  access: AccessRepository,
  request: SharedLinkAccessRequest,
): Promise<Set<string>> => {
  const { sharedLink, permission, ids } = request;
  const sharedLinkId = sharedLink.id;

  switch (permission) {
    case Permission.AssetRead: {
      return await access.asset.checkSharedLinkAccess(sharedLinkId, ids);
    }

    case Permission.AssetView: {
      return await access.asset.checkSharedLinkAccess(sharedLinkId, ids);
    }

    case Permission.AssetDownload: {
      return sharedLink.allowDownload ? await access.asset.checkSharedLinkAccess(sharedLinkId, ids) : new Set();
    }

    case Permission.AssetUpload: {
      return sharedLink.allowUpload ? ids : new Set();
    }

    case Permission.AlbumRead: {
      return await access.album.checkSharedLinkAccess(sharedLinkId, ids);
    }

    case Permission.AlbumDownload: {
      return sharedLink.allowDownload ? await access.album.checkSharedLinkAccess(sharedLinkId, ids) : new Set();
    }

    case Permission.AlbumAssetCreate: {
      return sharedLink.allowUpload ? await access.album.checkSharedLinkAccess(sharedLinkId, ids) : new Set();
    }

    default: {
      return new Set<string>();
    }
  }
};

const checkOtherAccess = async (access: AccessRepository, request: OtherAccessRequest): Promise<Set<string>> => {
  const { auth, permission, ids } = request;

  switch (permission) {
    // uses album id
    case Permission.ActivityCreate: {
      return await access.activity.checkCreateAccess(auth.user.id, ids);
    }

    // uses activity id
    case Permission.ActivityDelete: {
      const isOwner = await access.activity.checkOwnerAccess(auth.user.id, ids);
      const isAlbumOwner = await access.activity.checkAlbumOwnerAccess(auth.user.id, setDifference(ids, isOwner));
      return setUnion(isOwner, isAlbumOwner);
    }

    case Permission.AssetRead: {
      const isOwner = await access.asset.checkOwnerAccess(auth.user.id, ids, auth.session?.hasElevatedPermission);
      const isAlbum = await access.asset.checkAlbumAccess(auth.user.id, setDifference(ids, isOwner));
      const isPartner = await access.asset.checkPartnerAccess(auth.user.id, setDifference(ids, isOwner, isAlbum));
      const isSharedLibrary = await access.asset.checkSharedLibraryAccess(
        auth.user.id,
        setDifference(ids, isOwner, isAlbum, isPartner),
      );
      return setUnion(isOwner, isAlbum, isPartner, isSharedLibrary);
    }

    case Permission.AssetShare: {
      const isOwner = await access.asset.checkOwnerAccess(auth.user.id, ids, false);
      const isPartner = await access.asset.checkPartnerAccess(auth.user.id, setDifference(ids, isOwner));
      return setUnion(isOwner, isPartner);
    }

    case Permission.AssetView: {
      const isOwner = await access.asset.checkOwnerAccess(auth.user.id, ids, auth.session?.hasElevatedPermission);
      const isAlbum = await access.asset.checkAlbumAccess(auth.user.id, setDifference(ids, isOwner));
      const isPartner = await access.asset.checkPartnerAccess(auth.user.id, setDifference(ids, isOwner, isAlbum));
      const isSharedLibrary = await access.asset.checkSharedLibraryAccess(
        auth.user.id,
        setDifference(ids, isOwner, isAlbum, isPartner),
      );
      return setUnion(isOwner, isAlbum, isPartner, isSharedLibrary);
    }

    case Permission.AssetDownload: {
      const isOwner = await access.asset.checkOwnerAccess(auth.user.id, ids, auth.session?.hasElevatedPermission);
      const isAlbum = await access.asset.checkAlbumAccess(auth.user.id, setDifference(ids, isOwner));
      const isPartner = await access.asset.checkPartnerAccess(auth.user.id, setDifference(ids, isOwner, isAlbum));
      const isSharedLibrary = await access.asset.checkSharedLibraryAccess(
        auth.user.id,
        setDifference(ids, isOwner, isAlbum, isPartner),
      );
      return setUnion(isOwner, isAlbum, isPartner, isSharedLibrary);
    }

    case Permission.AssetUpdate: {
      return await access.asset.checkOwnerAccess(auth.user.id, ids, auth.session?.hasElevatedPermission);
    }

    case Permission.AssetDelete: {
      return await access.asset.checkOwnerAccess(auth.user.id, ids, auth.session?.hasElevatedPermission);
    }

    case Permission.AssetCopy: {
      return await access.asset.checkOwnerAccess(auth.user.id, ids, auth.session?.hasElevatedPermission);
    }

    case Permission.AssetEditGet: {
      return await access.asset.checkOwnerAccess(auth.user.id, ids, auth.session?.hasElevatedPermission);
    }

    case Permission.AssetEditCreate: {
      return await access.asset.checkOwnerAccess(auth.user.id, ids, auth.session?.hasElevatedPermission);
    }

    case Permission.AssetEditDelete: {
      return await access.asset.checkOwnerAccess(auth.user.id, ids, auth.session?.hasElevatedPermission);
    }

    case Permission.AlbumRead: {
      const isOwner = await access.album.checkOwnerAccess(auth.user.id, ids);
      const isShared = await access.album.checkSharedAlbumAccess(
        auth.user.id,
        setDifference(ids, isOwner),
        AlbumUserRole.Viewer,
      );
      return setUnion(isOwner, isShared);
    }

    case Permission.AlbumAssetCreate: {
      const isOwner = await access.album.checkOwnerAccess(auth.user.id, ids);
      const isShared = await access.album.checkSharedAlbumAccess(
        auth.user.id,
        setDifference(ids, isOwner),
        AlbumUserRole.Editor,
      );
      return setUnion(isOwner, isShared);
    }

    case Permission.AlbumUpdate: {
      const isOwner = await access.album.checkOwnerAccess(auth.user.id, ids);
      const isShared = await access.album.checkSharedAlbumAccess(
        auth.user.id,
        setDifference(ids, isOwner),
        AlbumUserRole.Editor,
      );
      return setUnion(isOwner, isShared);
    }

    case Permission.AlbumDelete: {
      return await access.album.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.AlbumShare: {
      const isOwner = await access.album.checkOwnerAccess(auth.user.id, ids);
      const isShared = await access.album.checkSharedAlbumAccess(
        auth.user.id,
        setDifference(ids, isOwner),
        AlbumUserRole.Editor,
      );
      return setUnion(isOwner, isShared);
    }

    case Permission.AlbumDownload: {
      const isOwner = await access.album.checkOwnerAccess(auth.user.id, ids);
      const isShared = await access.album.checkSharedAlbumAccess(
        auth.user.id,
        setDifference(ids, isOwner),
        AlbumUserRole.Viewer,
      );
      return setUnion(isOwner, isShared);
    }

    case Permission.AlbumAssetDelete: {
      const isOwner = await access.album.checkOwnerAccess(auth.user.id, ids);
      const isShared = await access.album.checkSharedAlbumAccess(
        auth.user.id,
        setDifference(ids, isOwner),
        AlbumUserRole.Editor,
      );
      return setUnion(isOwner, isShared);
    }

    case Permission.AssetUpload: {
      return ids.has(auth.user.id) ? new Set([auth.user.id]) : new Set<string>();
    }

    case Permission.ArchiveRead: {
      return ids.has(auth.user.id) ? new Set([auth.user.id]) : new Set();
    }

    case Permission.DuplicateRead:
    case Permission.DuplicateDelete: {
      return access.duplicate.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.AuthDeviceDelete: {
      return await access.authDevice.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.FaceDelete: {
      return access.person.checkFaceOwnerAccess(auth.user.id, ids);
    }

    // uses library id
    case Permission.LibraryRead: {
      const isOwner = await access.library.checkOwnerAccess(auth.user.id, ids);
      const isShared = await access.library.checkSharedAccess(auth.user.id, setDifference(ids, isOwner));
      return setUnion(isOwner, isShared);
    }

    // uses library id; owner (or admin, handled before reaching checkOtherAccess) only
    case Permission.LibraryShare: {
      return access.library.checkOwnerAccess(auth.user.id, ids);
    }

    // uses library id; the recipient's OWN share row only (any role) - a sharee setting their own
    // inTimeline preference. Deliberately NOT owner ∪ shared like LibraryRead: the owner has no
    // library_user row and has no business setting a sharee's personal view preference.
    case Permission.LibraryUserSelfUpdate: {
      return access.library.checkSelfShareAccess(auth.user.id, ids);
    }

    // uses asset ids; backs the provenance-aware album-insertion fallback only, never shared-link creation
    case Permission.LibraryAssetAddToAlbum: {
      return access.asset.checkSharedLibraryAlbumAddAccess(auth.user.id, ids);
    }

    // uses asset ids; Editor-only fallback for attaching the caller's OWN tags to shared-library
    // assets - a Viewer share must not grant it, and it never widens the generic AssetUpdate check.
    case Permission.LibraryAssetTag: {
      return access.asset.checkSharedLibraryTagAccess(auth.user.id, ids);
    }

    // uses library ids; owner ∪ Editor — a Viewer share must not grant this. The library-editor service
    // separately scope-checks the asset ids against the same route library id.
    case Permission.LibraryAssetUpdate: {
      const isOwner = await access.library.checkOwnerAccess(auth.user.id, ids);
      const isEditor = await access.library.checkEditorAccess(auth.user.id, setDifference(ids, isOwner));
      return setUnion(isOwner, isEditor);
    }

    // uses library ids; owner ∪ any shared role (Viewer included) - reading who's tagged in a photo is
    // part of viewing the photo itself, same as LibraryRead above.
    case Permission.LibraryPersonRead: {
      const isOwner = await access.library.checkOwnerAccess(auth.user.id, ids);
      const isShared = await access.library.checkSharedAccess(auth.user.id, setDifference(ids, isOwner));
      return setUnion(isOwner, isShared);
    }

    // uses library ids; owner ∪ Editor only, same shape as LibraryAssetUpdate above - curating people/faces
    // is a write action. The library-editor service separately scope-checks the person/face ids against
    // the same route library id via access.person.checkLibraryPersonScope/checkLibraryFaceScope.
    case Permission.LibraryPersonCreate:
    case Permission.LibraryPersonUpdate:
    case Permission.LibraryFaceCreate:
    case Permission.LibraryFaceUpdate: {
      const isOwner = await access.library.checkOwnerAccess(auth.user.id, ids);
      const isEditor = await access.library.checkEditorAccess(auth.user.id, setDifference(ids, isOwner));
      return setUnion(isOwner, isEditor);
    }

    case Permission.NotificationRead:
    case Permission.NotificationUpdate:
    case Permission.NotificationDelete: {
      return access.notification.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.TagAsset:
    case Permission.TagRead:
    case Permission.TagUpdate:
    case Permission.TagDelete: {
      return await access.tag.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.TimelineRead: {
      const isOwner = ids.has(auth.user.id) ? new Set([auth.user.id]) : new Set<string>();
      const isPartner = await access.timeline.checkPartnerAccess(auth.user.id, setDifference(ids, isOwner));
      return setUnion(isOwner, isPartner);
    }

    case Permission.TimelineDownload: {
      return ids.has(auth.user.id) ? new Set([auth.user.id]) : new Set();
    }

    case Permission.MemoryRead: {
      return access.memory.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.MemoryUpdate: {
      return access.memory.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.MemoryDelete: {
      return access.memory.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.PersonCreate: {
      return access.person.checkFaceOwnerAccess(auth.user.id, ids);
    }

    // Phase 5 (§5, SECURITY PREREQUISITE): PersonRead is split from PersonUpdate/Delete/Merge below -
    // this is the ONLY person permission a shared-library recipient may ever satisfy, and only for
    // persons reachable through a library shared with them with inTimeline=true (§5.1). Widening this
    // case must never be merged back with the mutation cases below.
    case Permission.PersonRead: {
      const isOwner = await access.person.checkOwnerAccess(auth.user.id, ids);
      const isSharedLibraryReachable = await access.person.checkSharedLibraryPersonAccess(
        auth.user.id,
        setDifference(ids, isOwner),
      );
      return setUnion(isOwner, isSharedLibraryReachable);
    }

    // Owner-only, deliberately NOT widened to shared-library reachability - rename/delete/merge remain
    // account-owner actions regardless of how a sharee reached this person via PersonRead above.
    case Permission.PersonUpdate:
    case Permission.PersonDelete:
    case Permission.PersonMerge: {
      return await access.person.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.PersonReassign: {
      return access.person.checkFaceOwnerAccess(auth.user.id, ids);
    }

    case Permission.PartnerUpdate: {
      return await access.partner.checkUpdateAccess(auth.user.id, ids);
    }

    case Permission.SessionRead:
    case Permission.SessionUpdate:
    case Permission.SessionDelete:
    case Permission.SessionLock: {
      return access.session.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.StackRead: {
      return access.stack.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.StackUpdate: {
      return access.stack.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.StackDelete: {
      return access.stack.checkOwnerAccess(auth.user.id, ids);
    }

    case Permission.WorkflowRead:
    case Permission.WorkflowUpdate:
    case Permission.WorkflowDelete: {
      return access.workflow.checkOwnerAccess(auth.user.id, ids);
    }

    default: {
      return new Set<string>();
    }
  }
};

export const requireElevatedPermission = (auth: AuthDto) => {
  if (!auth.session?.hasElevatedPermission) {
    throw new UnauthorizedException('Elevated permission is required');
  }
};
