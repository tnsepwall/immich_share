import { BadRequestException, Injectable } from '@nestjs/common';
import { LRUMap } from 'mnemonist';
import { AssetMapOptions, AssetResponseDto, MapAsset, mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { mapPerson, PersonResponseDto, redactPersonForNonOwner } from 'src/dtos/person.dto';
import {
  LargeAssetSearchDto,
  mapPlaces,
  MetadataSearchDto,
  PlacesResponseDto,
  RandomSearchDto,
  SearchPeopleDto,
  SearchPlacesDto,
  SearchResponseDto,
  SearchStatisticsResponseDto,
  SearchSuggestionRequestDto,
  SearchSuggestionType,
  SmartSearchDto,
  StatisticsSearchDto,
} from 'src/dtos/search.dto';
import { AssetOrder, AssetVisibility, Permission } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { requireElevatedPermission } from 'src/utils/access';
import { getMyPartnerIds } from 'src/utils/asset.util';
import { isSmartSearchEnabled } from 'src/utils/misc';

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
    );
    const cityItems = cityAssets.map((asset) => ({ value: asset.exifInfo!.city!, data: mapAsset(asset, { auth }) }));

    const recents = await this.assetRepository.getRecentlyCreatedAssetIds(
      [auth.user.id],
      sharedLibraryIds,
      options.maxFields,
    );
    const recentAssets = await this.assetRepository.getByIdsWithAllRelationsButStacks(
      recents.items.map((item) => item.data),
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
    const size = dto.size || 250;
    const { hasNextPage, items } = await this.searchRepository.searchMetadata(
      { page, size },
      {
        ...dto,
        checksum,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
        userIds,
        sharedLibraryIds,
        requestedBy: dto.albumIds && dto.albumIds.length > 0 ? (auth.sharedLink ? null : auth.user.id) : undefined,
        orderDirection: dto.order ?? AssetOrder.Desc,
      },
    );

    return this.mapResponse(items, hasNextPage ? (page + 1).toString() : null, { auth });
  }

  async searchStatistics(auth: AuthDto, dto: StatisticsSearchDto): Promise<SearchStatisticsResponseDto> {
    const { userIds, sharedLibraryIds } = await this.getUserIdsToSearch(auth);
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }
    await this.requirePersonReadAccess(auth, dto.personIds);

    return await this.searchRepository.searchStatistics({
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      sharedLibraryIds: this.dropSharedLibraryProbe(sharedLibraryIds, dto),
    });
  }

  async searchRandom(auth: AuthDto, dto: RandomSearchDto): Promise<AssetResponseDto[]> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }
    await this.requirePersonReadAccess(auth, dto.personIds);

    const { userIds, sharedLibraryIds } = await this.getUserIdsToSearch(auth, dto.visibility);
    const items = await this.searchRepository.searchRandom(dto.size || 250, {
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      sharedLibraryIds: this.dropSharedLibraryProbe(sharedLibraryIds, dto),
    });
    return items.map((item) => mapAsset(item, { auth }));
  }

  async searchLargeAssets(auth: AuthDto, dto: LargeAssetSearchDto): Promise<AssetResponseDto[]> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }
    await this.requirePersonReadAccess(auth, dto.personIds);

    const { userIds, sharedLibraryIds } = await this.getUserIdsToSearch(auth, dto.visibility);
    const items = await this.searchRepository.searchLargeAssets(dto.size || 250, {
      ...dto,
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      userIds,
      sharedLibraryIds: this.dropSharedLibraryProbe(sharedLibraryIds, dto),
    });
    return items.map((item) => mapAsset(item, { auth }));
  }

  async searchSmart(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }
    await this.requirePersonReadAccess(auth, dto.personIds);

    const idsPromise = this.getUserIdsToSearch(auth, dto.visibility);
    let embedding;
    if (dto.query) {
      const key = machineLearning.clip.modelName + dto.query + dto.language;
      embedding = this.embeddingCache.get(key);
      if (!embedding) {
        embedding = await this.machineLearningRepository.encodeText(dto.query, {
          modelName: machineLearning.clip.modelName,
          language: dto.language,
        });
        this.embeddingCache.set(key, embedding);
      }
    } else if (dto.queryAssetId) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.queryAssetId] });
      const getEmbeddingResponse = await this.searchRepository.getEmbedding(dto.queryAssetId);
      const assetEmbedding = getEmbeddingResponse?.embedding;
      if (!assetEmbedding) {
        throw new BadRequestException(`Asset ${dto.queryAssetId} has no embedding`);
      }
      embedding = assetEmbedding;
    } else {
      throw new BadRequestException('Either `query` or `queryAssetId` must be set');
    }
    const page = dto.page ?? 1;
    const size = dto.size || 100;
    const { userIds, sharedLibraryIds } = await idsPromise;
    const { hasNextPage, items } = await this.searchRepository.searchSmart(
      { page, size },
      {
        ...dto,
        userIds,
        sharedLibraryIds: this.dropSharedLibraryProbe(sharedLibraryIds, dto),
        embedding,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      },
    );

    return this.mapResponse(items, hasNextPage ? (page + 1).toString() : null, { auth });
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
    if (!personIds || personIds.length === 0) {
      return;
    }
    await this.requireAccess({ auth, permission: Permission.PersonRead, ids: personIds });
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

  private mapResponse(assets: MapAsset[], nextPage: string | null, options: AssetMapOptions): SearchResponseDto {
    return {
      albums: { total: 0, count: 0, items: [], facets: [] },
      assets: {
        total: assets.length,
        count: assets.length,
        items: assets.map((asset) => mapAsset(asset, options)),
        facets: [],
        nextPage,
      },
    };
  }
}
