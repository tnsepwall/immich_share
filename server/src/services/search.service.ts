import { BadRequestException, Injectable } from '@nestjs/common';
import { LRUMap } from 'mnemonist';
import { AssetMapOptions, AssetResponseDto, MapAsset, mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { PersonResponseDto, mapPerson, redactPersonForNonOwner } from 'src/dtos/person.dto.js';
import {
  LargeAssetSearchDto,
  MetadataSearchDto,
  PlacesResponseDto,
  RandomSearchDto,
  SearchFilter,
  SearchPeopleDto,
  SearchPlacesDto,
  SearchResponseDto,
  SearchStatisticsResponseDto,
  SearchSuggestionRequestDto,
  SearchSuggestionType,
  SmartSearchDto,
  StatisticsSearchDto,
  isFullyAlbumConfined,
  isNewShapeRequest,
  mapPlaces,
} from 'src/dtos/search.dto.js';
import { AssetOrder, AssetVisibility, Permission } from 'src/enum.js';
import { AssetSearchScope } from 'src/repositories/search.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { requireElevatedPermission } from 'src/utils/access.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';
import { isSmartSearchEnabled } from 'src/utils/misc.js';
import { decodeSearchCursor, encodeSearchCursor } from 'src/utils/search-cursor.js';
import { applyLockedVisibilityPolicy, collectFilterIds } from 'src/utils/search-filter.js';

@Injectable()
export class SearchService extends BaseService {
  private embeddingCache = new LRUMap<string, string>(100);

  async searchPerson(auth: AuthDto, dto: SearchPeopleDto): Promise<PersonResponseDto[]> {
    // Phase 5 (§5.4): widened alongside person.service.ts#getAll - own persons plus persons reachable
    // through the caller's inTimeline-shared libraries, the latter always redacted and hidden-excluded.
    const sharedLibraryIds = await this.libraryRepository.getInTimelineSharedLibraryIds(auth.user.id);
    const people = await this.personRepository.getByNameWithSharedLibraries(auth.user.id, sharedLibraryIds, dto.name, {
      withHidden: dto.withHidden,
    });
    return people.map((person) =>
      person.ownerId === auth.user.id ? mapPerson(person) : redactPersonForNonOwner(mapPerson(person)),
    );
  }

  async searchPlaces(dto: SearchPlacesDto): Promise<PlacesResponseDto[]> {
    const places = await this.searchRepository.searchPlaces(dto.name);
    return places.map((place) => mapPlaces(place));
  }

  async getExploreData(auth: AuthDto) {
    const options = { maxFields: 12, minAssetsPerField: 5 };
    // Partner-free by design (§3.5) - Explore's shared-library widening is independent of partners,
    // which this method has never included.
    const sharedLibraryIds = await this.libraryRepository.getInTimelineSharedLibraryIds(auth.user.id);

    const cities = await this.assetRepository.getAssetIdByCity([auth.user.id], sharedLibraryIds, options);
    const cityAssets = await this.assetRepository.getByIdsWithAllRelationsButStacks(
      cities.items.map(({ data }) => data),
      auth.user.id,
    );
    const cityItems = cityAssets.map((asset) => ({ value: asset.exifInfo!.city!, data: mapAsset(asset, { auth }) }));

    const recents = await this.assetRepository.getRecentlyCreatedAssetIds(
      [auth.user.id],
      sharedLibraryIds,
      options.maxFields,
    );
    const recentAssets = await this.assetRepository.getByIdsWithAllRelationsButStacks(
      recents.items.map((item) => item.data),
      auth.user.id,
    );
    const recentItems = recentAssets.map((asset) => ({
      value: asset.createdAt.toISOString(),
      data: mapAsset(asset, { auth }),
    }));

    return [
      { fieldName: cities.fieldName, items: cityItems },
      { fieldName: recents.fieldName, items: recentItems },
    ];
  }

  async searchMetadata(auth: AuthDto, dto: MetadataSearchDto): Promise<SearchResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchMetadataV3(auth, dto);
    }

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }
    await this.requirePersonReadAccess(auth, dto.personIds);

    let checksum: Buffer | undefined;
    if (dto.checksum) {
      const encoding = dto.checksum.length === 28 ? 'base64' : 'hex';
      checksum = Buffer.from(dto.checksum, encoding);
    }

    let userIds: string[] | undefined;
    let sharedLibraryIds: string[] = [];

    if (dto.albumIds && dto.albumIds.length > 0) {
      await this.requireAccess({ auth, ids: dto.albumIds, permission: Permission.AlbumRead });
    } else if (auth.sharedLink) {
      throw new BadRequestException('Shared link access is only allowed in combination with an albumIds filter');
    } else {
      ({ userIds, sharedLibraryIds } = await this.getUserIdsToSearch(auth, dto.visibility));
      sharedLibraryIds = this.dropSharedLibraryProbe(sharedLibraryIds, dto);
    }

    const page = dto.page ?? 1;
    const size = dto.size;
    const { hasNextPage, items } = await this.searchRepository.searchMetadata(
      { page, size },
      {
        ...dto,
        checksum,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
        userIds,
        sharedLibraryIds,
        requestedBy: dto.albumIds && dto.albumIds.length > 0 ? (auth.sharedLink ? null : auth.user.id) : undefined,
        viewingUserId: auth.user.id,
        orderDirection: dto.order ?? AssetOrder.Desc,
      },
    );

    return this.mapResponse(items, { auth }, { nextPage: hasNextPage ? (page + 1).toString() : null });
  }

  async searchStatistics(auth: AuthDto, dto: StatisticsSearchDto): Promise<SearchStatisticsResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchStatisticsV3(auth, dto);
    }

    const { userIds, sharedLibraryIds } = await this.getUserIdsToSearch(auth, dto.visibility);
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }
    await this.requirePersonReadAccess(auth, dto.personIds);

    return await this.searchRepository.searchStatistics({
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      sharedLibraryIds: this.dropSharedLibraryProbe(sharedLibraryIds, dto),
      viewingUserId: auth.user.id,
    });
  }

  async searchRandom(auth: AuthDto, dto: RandomSearchDto): Promise<AssetResponseDto[]> {
    if (isNewShapeRequest(dto)) {
      return this.searchRandomV3(auth, dto);
    }

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }
    await this.requirePersonReadAccess(auth, dto.personIds);

    const { userIds, sharedLibraryIds } = await this.getUserIdsToSearch(auth, dto.visibility);
    const items = await this.searchRepository.searchRandom(dto.size, {
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      sharedLibraryIds: this.dropSharedLibraryProbe(sharedLibraryIds, dto),
      viewingUserId: auth.user.id,
    });
    return items.map((item) => mapAsset(item, { auth }));
  }

  async searchLargeAssets(auth: AuthDto, dto: LargeAssetSearchDto): Promise<AssetResponseDto[]> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }
    await this.requirePersonReadAccess(auth, dto.personIds);

    const { userIds, sharedLibraryIds } = await this.getUserIdsToSearch(auth, dto.visibility);
    const items = await this.searchRepository.searchLargeAssets(dto.size, {
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      sharedLibraryIds: this.dropSharedLibraryProbe(sharedLibraryIds, dto),
      viewingUserId: auth.user.id,
    });
    return items.map((item) => mapAsset(item, { auth }));
  }

  async searchSmart(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchSmartV3(auth, dto);
    }

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }
    await this.requirePersonReadAccess(auth, dto.personIds);

    const idsPromise = this.getUserIdsToSearch(auth, dto.visibility);
    const embedding = await this.resolveEmbedding(auth, dto, machineLearning);
    const page = dto.page ?? 1;
    const size = dto.size;
    const { userIds, sharedLibraryIds } = await idsPromise;
    const { hasNextPage, items } = await this.searchRepository.searchSmart(
      { page, size },
      {
        ...dto,
        userIds,
        sharedLibraryIds: this.dropSharedLibraryProbe(sharedLibraryIds, dto),
        viewingUserId: auth.user.id,
        embedding,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      },
    );

    return this.mapResponse(items, { auth }, { nextPage: hasNextPage ? (page + 1).toString() : null });
  }

  async getAssetsByCity(auth: AuthDto): Promise<AssetResponseDto[]> {
    const { userIds, sharedLibraryIds } = await this.getUserIdsToSearch(auth);
    const assets = await this.searchRepository.getAssetsByCity(userIds, sharedLibraryIds);
    return assets.map((asset) => mapAsset(asset, { auth }));
  }

  async getSearchSuggestions(auth: AuthDto, dto: SearchSuggestionRequestDto) {
    const { userIds, sharedLibraryIds } = await this.getUserIdsToSearch(auth);
    const suggestions = await this.getSuggestions(userIds, sharedLibraryIds, dto);
    if (dto.includeNull) {
      suggestions.push(null);
    }
    return suggestions;
  }

  private getSuggestions(
    userIds: string[],
    sharedLibraryIds: string[],
    dto: SearchSuggestionRequestDto,
  ): Promise<Array<string | null>> {
    switch (dto.type) {
      case SearchSuggestionType.COUNTRY: {
        return this.searchRepository.getCountries(userIds, sharedLibraryIds);
      }
      case SearchSuggestionType.STATE: {
        return this.searchRepository.getStates(userIds, sharedLibraryIds, dto);
      }
      case SearchSuggestionType.CITY: {
        return this.searchRepository.getCities(userIds, sharedLibraryIds, dto);
      }
      case SearchSuggestionType.CAMERA_MAKE: {
        return this.searchRepository.getCameraMakes(userIds, sharedLibraryIds, dto);
      }
      case SearchSuggestionType.CAMERA_MODEL: {
        return this.searchRepository.getCameraModels(userIds, sharedLibraryIds, dto);
      }
      case SearchSuggestionType.CAMERA_LENS_MODEL: {
        return this.searchRepository.getCameraLensModels(userIds, sharedLibraryIds, dto);
      }
      default: {
        return Promise.resolve([]);
      }
    }
  }

  private async searchMetadataV3(auth: AuthDto, dto: MetadataSearchDto): Promise<SearchResponseDto> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);

    const { offset } = decodeSearchCursor(dto.cursor);
    const size = dto.size;
    const { hasNextPage, items } = await this.searchRepository.searchMetadataV3(
      { take: size, skip: offset },
      {
        filter,
        withExif: dto.withExif,
        withPeople: dto.withPeople,
        withStacked: dto.withStacked,
        order: dto.orderBy,
      },
      scope,
    );

    return this.mapResponse(items, { auth }, { nextCursor: hasNextPage ? encodeSearchCursor(offset + size) : null });
  }

  private async searchStatisticsV3(auth: AuthDto, dto: StatisticsSearchDto): Promise<SearchStatisticsResponseDto> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);
    return this.searchRepository.searchStatisticsV3({ filter }, scope);
  }

  private async searchRandomV3(auth: AuthDto, dto: RandomSearchDto): Promise<AssetResponseDto[]> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);
    const items = await this.searchRepository.searchRandomV3(
      dto.size,
      {
        filter,
        withExif: dto.withExif,
        withPeople: dto.withPeople,
        withStacked: dto.withStacked,
      },
      scope,
    );
    return items.map((item) => mapAsset(item, { auth }));
  }

  private async searchSmartV3(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }

    const [{ filter, scope }, embedding] = await Promise.all([
      this.resolveSearchScopeV3(auth, dto),
      this.resolveEmbedding(auth, dto, machineLearning),
    ]);

    // no cursor until a rank-aware pagination strategy for smart search is decided
    const { items } = await this.searchRepository.searchSmartV3(
      { take: dto.size },
      { filter, withExif: dto.withExif, embedding },
      scope,
    );

    return this.mapResponse(items, { auth });
  }

  private async resolveSearchScopeV3(
    auth: AuthDto,
    dto: { filter?: SearchFilter },
  ): Promise<{ filter: SearchFilter; scope: AssetSearchScope }> {
    const filter = dto.filter ?? {};
    const effectiveFilter = applyLockedVisibilityPolicy(auth, filter);

    const fullyConfined = isFullyAlbumConfined(filter);
    // a shared link visitor does not have a universe, so there every branch must be confined
    if (auth.sharedLink && !fullyConfined) {
      throw new BadRequestException('Shared link access is only allowed in combination with an albumIds filter');
    }

    const albumIds = collectFilterIds(filter, 'albumIds');
    const [{ userIds, sharedLibraryIds }] = await Promise.all([
      // a fully confined filter searches albums only, so the unused universe can skip the partner lookup
      fullyConfined ? { userIds: [auth.user.id], sharedLibraryIds: [] } : this.getUserIdsToSearch(auth),
      albumIds.length > 0 ? this.requireAccess({ auth, ids: albumIds, permission: Permission.AlbumRead }) : undefined,
      // Phase 5 (§5.8) carried to Search V3: person ids must be readable by the caller.
      this.requirePersonReadAccess(auth, collectFilterIds(filter, 'personIds')),
    ]);

    return {
      filter: effectiveFilter,
      scope: {
        userIds,
        // Fork (shared libraries): in-timeline shared libraries widen the search universe alongside
        // own+partner assets, minus any filter that would probe owner-only data (plan §3.2).
        sharedLibraryIds: this.dropSharedLibraryProbeV3(sharedLibraryIds, filter),
        requestedBy: auth.sharedLink ? null : auth.user.id,
        lockedOwnerId: auth.user.id,
        viewingUserId: auth.user.id,
      },
    };
  }

  private async resolveEmbedding(
    auth: AuthDto,
    dto: SmartSearchDto,
    machineLearning: SystemConfig['machineLearning'],
  ): Promise<string> {
    if (dto.query) {
      const key = machineLearning.clip.modelName + dto.query + dto.language;
      let embedding = this.embeddingCache.get(key);
      if (!embedding) {
        embedding = await this.machineLearningRepository.encodeText(dto.query, {
          modelName: machineLearning.clip.modelName,
          language: dto.language,
        });
        this.embeddingCache.set(key, embedding);
      }
      return embedding;
    }

    if (dto.queryAssetId) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.queryAssetId] });
      const getEmbeddingResponse = await this.searchRepository.getEmbedding(dto.queryAssetId);
      const assetEmbedding = getEmbeddingResponse?.embedding;
      if (!assetEmbedding) {
        throw new BadRequestException(`Asset ${dto.queryAssetId} has no embedding`);
      }
      return assetEmbedding;
    }

    throw new BadRequestException('Either `query` or `queryAssetId` must be set');
  }

  private async getUserIdsToSearch(
    auth: AuthDto,
    visibility?: AssetVisibility,
  ): Promise<{ userIds: string[]; sharedLibraryIds: string[] }> {
    // Locked assets are personal. Never include partner IDs or shared-library assets, regardless of
    // A's elevated session (plan §0.3 - same branch that drops partners).
    if (visibility === AssetVisibility.Locked) {
      return { userIds: [auth.user.id], sharedLibraryIds: [] };
    }
    const partnerIds = await getMyPartnerIds({
      userId: auth.user.id,
      repository: this.partnerRepository,
      timelineEnabled: true,
    });
    const sharedLibraryIds = await this.libraryRepository.getInTimelineSharedLibraryIds(auth.user.id);
    return { userIds: [auth.user.id, ...partnerIds], sharedLibraryIds };
  }

  // Phase 5 (§5.8): personIds is an unauthorized filter today, bounded only by the caller's own result
  // scope - safe while that scope was owner+partner only, but now that shared-library assets can enter
  // scope, an explicitly-supplied person id becomes a probing oracle. Reject ids the caller can't read.
  private async requirePersonReadAccess(auth: AuthDto, personIds?: string[]): Promise<void> {
    await this.requirePersonGroupReadAccess(auth, personIds ?? []);
  }

  // Probe defenses (plan §3.2): a sharee filtering on the OWNER's isFavorite flag, or attempting to
  // probe the owner's filesystem strings (originalPath, and per review finding also the
  // server-internal generated previewPath/thumbnailPath/encodedVideoPath) or exact file checksum,
  // must never get an answer widened by a library they don't own - fall back to
  // owner(+partner)-arm-only results.
  private dropSharedLibraryProbe(
    sharedLibraryIds: string[],
    dto: {
      isFavorite?: boolean;
      originalPath?: string;
      checksum?: string;
      previewPath?: string;
      thumbnailPath?: string;
      encodedVideoPath?: string;
    },
  ): string[] {
    if (
      dto.isFavorite !== undefined ||
      dto.originalPath !== undefined ||
      dto.checksum !== undefined ||
      dto.previewPath !== undefined ||
      dto.thumbnailPath !== undefined ||
      dto.encodedVideoPath !== undefined
    ) {
      return [];
    }
    return sharedLibraryIds;
  }

  // Search V3 twin of dropSharedLibraryProbe: the same owner-only probes, looked up in every filter branch.
  private dropSharedLibraryProbeV3(sharedLibraryIds: string[], filter: SearchFilter): string[] {
    const branches = [filter, ...(filter.or ?? [])];
    const probes = branches.some(
      (branch) =>
        branch.isFavorite !== undefined ||
        branch.originalPath !== undefined ||
        branch.checksum !== undefined ||
        branch.encodedVideoPath !== undefined,
    );
    return probes ? [] : sharedLibraryIds;
  }

  private mapResponse(
    assets: MapAsset[],
    options: AssetMapOptions,
    page: { nextPage?: string | null; nextCursor?: string | null } = {},
  ): SearchResponseDto {
    return {
      albums: { total: 0, count: 0, items: [], facets: [] },
      assets: {
        total: assets.length,
        count: assets.length,
        items: assets.map((asset) => mapAsset(asset, options)),
        facets: [],
        nextPage: page.nextPage ?? null,
        nextCursor: page.nextCursor ?? null,
      },
    };
  }
}
