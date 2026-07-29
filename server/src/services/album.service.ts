import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AddUsersDto,
  AlbumResponseDto,
  AlbumsAddAssetsDto,
  AlbumsAddAssetsResponseDto,
  AlbumStatisticsResponseDto,
  CreateAlbumDto,
  GetAlbumsDto,
  mapAlbum,
  UpdateAlbumDto,
  UpdateAlbumUserDto,
} from 'src/dtos/album.dto';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { MapMarkerResponseDto } from 'src/dtos/map.dto';
import { AlbumUserRole, Permission } from 'src/enum';
import { AlbumAssetCount, AlbumInfoOptions } from 'src/repositories/album.repository';
import { BaseService } from 'src/services/base.service';
import { isGranted } from 'src/utils/access';
import { addAssets, removeAssets } from 'src/utils/asset.util';
import { asDateTimeString } from 'src/utils/date';
import { getPreferences } from 'src/utils/preferences';

@Injectable()
export class AlbumService extends BaseService {
  async getStatistics(auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getAll(auth.user.id, { isOwned: true }),
      this.albumRepository.getAll(auth.user.id, { isShared: true }),
      this.albumRepository.getAll(auth.user.id, { isOwned: true, isShared: false }),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll({ user: { id: ownerId } }: AuthDto, { assetId, ...rest }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    await this.albumRepository.updateThumbnails();

    const albums = assetId
      ? await this.albumRepository.getByAssetId(ownerId, assetId)
      : await this.albumRepository.getAll(ownerId, rest);

    if (albums.length === 0) {
      return [];
    }

    // Get asset count for each album. Then map the result to an object:
    // { [albumId]: assetCount }
    const results = await this.albumRepository.getMetadataForIds(
      albums.map((album) => album.id),
      ownerId,
    );
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }

    return albums.map((album) => ({
      ...mapAlbum(album),
      sharedLinks: undefined,
      startDate: asDateTimeString(albumMetadata[album.id]?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadata[album.id]?.endDate ?? undefined),
      assetCount: albumMetadata[album.id]?.assetCount ?? 0,
      // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadata[album.id]?.lastModifiedAssetTimestamp ?? undefined),
    }));
  }

  async get(auth: AuthDto, id: string): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await this.albumRepository.updateThumbnails();
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    const requestedBy = auth.sharedLink ? null : auth.user.id;
    const [albumMetadataForIds] = await this.albumRepository.getMetadataForIds([album.id], requestedBy);

    const hasSharedUsers = album.albumUsers && album.albumUsers.length > 1;
    const hasSharedLink = album.sharedLinks && album.sharedLinks.length > 0;
    const isShared = hasSharedUsers || hasSharedLink;

    return {
      ...mapAlbum(album),
      startDate: asDateTimeString(albumMetadataForIds?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadataForIds?.endDate ?? undefined),
      assetCount: albumMetadataForIds?.assetCount ?? 0,
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined),
      contributorCounts: isShared ? await this.albumRepository.getContributorCounts(album.id, requestedBy) : undefined,
    };
  }

  async getMapMarkers(auth: AuthDto, id: string): Promise<MapMarkerResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      return [];
    }

    return this.mapRepository.getAlbumMapMarkers(id, auth.sharedLink ? null : auth.user.id);
  }

  async create(auth: AuthDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    const albumUsers = (dto.albumUsers || []).filter(({ userId }) => userId !== auth.user.id);

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        this.logger.debug('Album creation failed: user not found');
        throw new BadRequestException('Invalid user');
      }
    }

    const requestedAssetIds = dto.assetIds || [];
    const assetShareIds = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: requestedAssetIds });
    const remainingAssetIds = requestedAssetIds.filter((assetId) => !assetShareIds.has(assetId));
    // A brand-new album is always owned by its creator, so a shared-library grant is always eligible here.
    const libraryGrants =
      remainingAssetIds.length > 0
        ? await this.resolveLibraryAlbumGrants(auth, remainingAssetIds)
        : new Map<string, string>();

    const assets: { assetId: string; sourceLibraryId: string | null }[] = [
      ...[...assetShareIds].map((assetId) => ({ assetId, sourceLibraryId: null })),
      ...[...libraryGrants].map(([assetId, sourceLibraryId]) => ({ assetId, sourceLibraryId })),
    ];

    const userMetadata = await this.userRepository.getMetadata(auth.user.id);

    const album = await this.albumRepository.create(
      {
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: assets[0]?.assetId || null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
      },
      assets,
      [{ userId: auth.user.id, role: AlbumUserRole.Owner }, ...albumUsers],
      auth.user.id,
    );

    for (const { userId } of albumUsers) {
      await this.eventRepository.emit('AlbumInvite', { id: album.id, userId, senderName: auth.user.name });
    }

    return mapAlbum(album);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: true });

    if (dto.albumThumbnailAssetId) {
      const results = await this.albumRepository.getAssetIds(id, [dto.albumThumbnailAssetId]);
      if (results.size === 0) {
        throw new BadRequestException('Invalid album thumbnail');
      }
    }
    const updatedAlbum = await this.albumRepository.update(
      album.id,
      {
        id: album.id,
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: dto.albumThumbnailAssetId,
        isActivityEnabled: dto.isActivityEnabled,
        order: dto.order,
      },
      auth.user.id,
    );

    return mapAlbum({ ...updatedAlbum, assets: album.assets });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });

    const results = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids },
    );

    // Precedence upgrade: an asset already in the album via a library grant, for which the requester now has
    // genuine durable AssetShare access, gets upgraded to a durable (null-provenance) grant.
    const duplicateIds = results
      .filter(({ success, error }) => !success && error === BulkIdErrorReason.DUPLICATE)
      .map(({ id }) => id);
    if (duplicateIds.length > 0) {
      const hasAssetShare = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: duplicateIds });
      if (hasAssetShare.size > 0) {
        await this.albumRepository.upgradeProvenanceGrants(id, [...hasAssetShare]);
      }
    }

    // Library-grant fallback: assets that failed even AssetShare may still be insertable via a shared-library
    // grant, but only into an album the requester OWNS (being an Editor is insufficient), and never into an
    // album that already has a shared link.
    const deniedIds = results
      .filter(({ success, error }) => !success && error === BulkIdErrorReason.NO_PERMISSION)
      .map(({ id }) => id);
    if (deniedIds.length > 0) {
      const isOwner = await this.accessRepository.album.checkOwnerAccess(auth.user.id, new Set([id]));
      const hasSharedLink = (album.sharedLinks?.length ?? 0) > 0;
      if (isOwner.has(id) && !hasSharedLink) {
        const libraryGrants = await this.resolveLibraryAlbumGrants(auth, deniedIds);
        if (libraryGrants.size > 0) {
          await this.albumRepository.addLibraryAssetIds(
            id,
            [...libraryGrants].map(([assetId, sourceLibraryId]) => ({ assetId, sourceLibraryId })),
          );
          for (const assetId of libraryGrants.keys()) {
            const index = results.findIndex((result) => result.id === assetId);
            if (index !== -1) {
              results[index] = { id: assetId, success: true };
            }
          }
        }
      }
    }

    const { id: firstNewAssetId } = results.find(({ success }) => success) || {};
    if (firstNewAssetId) {
      await this.albumRepository.update(
        id,
        {
          id,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? firstNewAssetId,
        },
        auth.user.id,
      );

      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      await this.eventRepository.emit('AlbumUpdate', { id, userIds, recipientIds });
    }

    return results;
  }

  async addAssetsToAlbums(auth: AuthDto, dto: AlbumsAddAssetsDto): Promise<AlbumsAddAssetsResponseDto> {
    const results: AlbumsAddAssetsResponseDto = {
      success: false,
      error: BulkIdErrorReason.DUPLICATE,
    };

    const allowedAlbumIds = await this.checkAccess({
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: dto.albumIds,
    });
    if (allowedAlbumIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const assetShareIds = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
    const remainingAssetIds = dto.assetIds.filter((assetId) => !assetShareIds.has(assetId));
    const libraryGrants =
      remainingAssetIds.length > 0
        ? await this.resolveLibraryAlbumGrants(auth, remainingAssetIds)
        : new Map<string, string>();

    if (assetShareIds.size === 0 && libraryGrants.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    // Library grants may only land in albums the requester OWNS (being an Editor is insufficient).
    const ownedAlbumIds =
      libraryGrants.size > 0
        ? await this.accessRepository.album.checkOwnerAccess(auth.user.id, allowedAlbumIds)
        : new Set<string>();

    const albumAssetValues: { albumId: string; assetId: string }[] = [];
    const libraryAlbumAssetValues: { albumId: string; assetId: string; sourceLibraryId: string }[] = [];
    const events: { id: string; userIds: string[]; recipientIds: string[] }[] = [];
    for (const albumId of allowedAlbumIds) {
      const album = await this.findOrFail(albumId, auth.user.id, { withAssets: false });
      const hasSharedLink = (album.sharedLinks?.length ?? 0) > 0;
      const canUseLibraryGrants = ownedAlbumIds.has(albumId) && !hasSharedLink;

      const candidateAssetIds = new Set([...assetShareIds, ...(canUseLibraryGrants ? libraryGrants.keys() : [])]);
      if (candidateAssetIds.size === 0) {
        continue;
      }

      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...candidateAssetIds]);
      const notPresentAssetIds = [...candidateAssetIds].filter((assetId) => !existingAssetIds.has(assetId));

      // Precedence upgrade: an asset already in this album via a library grant, for which the requester now has
      // genuine durable AssetShare access, gets upgraded to a durable (null-provenance) grant.
      const alreadyPresentDurableCandidates = [...assetShareIds].filter((assetId) => existingAssetIds.has(assetId));
      if (alreadyPresentDurableCandidates.length > 0) {
        await this.albumRepository.upgradeProvenanceGrants(albumId, alreadyPresentDurableCandidates);
      }

      if (notPresentAssetIds.length === 0) {
        continue;
      }

      results.error = undefined;
      results.success = true;

      for (const assetId of notPresentAssetIds) {
        if (assetShareIds.has(assetId)) {
          albumAssetValues.push({ albumId, assetId });
        } else {
          const sourceLibraryId = libraryGrants.get(assetId);
          if (sourceLibraryId) {
            libraryAlbumAssetValues.push({ albumId, assetId, sourceLibraryId });
          }
        }
      }
      await this.albumRepository.update(
        albumId,
        {
          id: albumId,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? notPresentAssetIds[0],
        },
        auth.user.id,
      );
      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      events.push({ id: albumId, userIds, recipientIds });
    }

    if (albumAssetValues.length > 0) {
      await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    }
    if (libraryAlbumAssetValues.length > 0) {
      await this.albumRepository.addLibraryAssetIdsToAlbums(libraryAlbumAssetValues);
    }
    for (const event of events) {
      await this.eventRepository.emit('AlbumUpdate', event);
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });
    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.AlbumDelete },
    );

    const removedIds = results.filter(({ success }) => success).map(({ id }) => id);
    if (removedIds.length > 0) {
      if (album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
        await this.albumRepository.updateThumbnails();
      }

      await this.eventRepository.emit('AlbumUpdate', {
        id,
        userIds: album.albumUsers.map(({ user }) => user.id),
        recipientIds: [],
      });
    }

    return results;
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });

    for (const { userId, role } of albumUsers) {
      if (role === AlbumUserRole.Owner) {
        throw new BadRequestException('Cannot add another owner');
      }

      const exists = album.albumUsers.some(({ user: { id } }) => id === userId);
      if (exists) {
        continue;
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        this.logger.debug('Adding user to album failed: user not found');
        throw new BadRequestException('Invalid user');
      }

      await this.albumUserRepository.create({ userId, albumId: id, role });
      await this.eventRepository.emit('AlbumInvite', { id, userId, senderName: auth.user.name });
    }

    return mapAlbum(await this.findOrFail(id, auth.user.id, { withAssets: true }));
  }

  async removeUser(auth: AuthDto, id: string, userId: string | 'me'): Promise<void> {
    if (userId === 'me') {
      userId = auth.user.id;
    }

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false });

    const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
    if (!exists) {
      throw new BadRequestException('Album not shared with user');
    }

    if (
      exists.role === AlbumUserRole.Owner &&
      album.albumUsers.filter(({ role }) => role === AlbumUserRole.Owner).length === 1
    ) {
      throw new BadRequestException('Cannot remove the last album owner');
    }

    // non-admin can remove themselves
    if (auth.user.id !== userId) {
      await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    }

    await this.albumUserRepository.delete({ albumId: id, userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, userId, { withAssets: false });
    const owner = album.albumUsers[0];

    if (owner.user.id === userId) {
      throw new BadRequestException('User is owner');
    }

    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
  }

  /**
   * Resolves which of the given asset ids may be added to one of the requester's own albums via a shared-library
   * grant (never a shared-link fallback), mapped to the exact library each came from. An API key must hold
   * `LibraryAssetAddToAlbum` explicitly — `AlbumAssetCreate` alone does not grant this fallback.
   */
  private async resolveLibraryAlbumGrants(auth: AuthDto, assetIds: string[]): Promise<Map<string, string>> {
    const grants = new Map<string, string>();
    if (assetIds.length === 0) {
      return grants;
    }

    if (
      auth.apiKey &&
      !isGranted({ requested: [Permission.LibraryAssetAddToAlbum], current: auth.apiKey.permissions })
    ) {
      return grants;
    }

    const allowedIds = await this.checkAccess({ auth, permission: Permission.LibraryAssetAddToAlbum, ids: assetIds });
    if (allowedIds.size === 0) {
      return grants;
    }

    const assets = await this.assetRepository.getByIds([...allowedIds]);
    for (const asset of assets) {
      if (allowedIds.has(asset.id) && asset.libraryId) {
        grants.set(asset.id, asset.libraryId);
      }
    }

    return grants;
  }

  private async findOrFail(id: string, authUserId: string, options: AlbumInfoOptions) {
    const album = await this.albumRepository.getById(id, options, authUserId);
    if (!album) {
      throw new BadRequestException('Album not found');
    }
    return album;
  }
}
