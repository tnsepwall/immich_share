import { BadRequestException, Injectable } from '@nestjs/common';
import { Library } from 'src/database';
import { AuthDto } from 'src/dtos/auth.dto';
import { TimeBucketAssetDto, TimeBucketDto, TimeBucketsResponseDto } from 'src/dtos/time-bucket.dto';
import { AssetVisibility, Permission } from 'src/enum';
import { TimeBucketOptions } from 'src/repositories/asset.repository';
import { BaseService } from 'src/services/base.service';
import { requireElevatedPermission } from 'src/utils/access';
import { getMyPartnerIds } from 'src/utils/asset.util';

@Injectable()
export class TimelineService extends BaseService {
  async getTimeBuckets(auth: AuthDto, dto: TimeBucketDto): Promise<TimeBucketsResponseDto[]> {
    const library = await this.timeBucketChecks(auth, dto);
    const timeBucketOptions = await this.buildTimeBucketOptions(auth, dto, library);
    return await this.assetRepository.getTimeBuckets(timeBucketOptions);
  }

  // pre-jsonified response
  async getTimeBucket(auth: AuthDto, dto: TimeBucketAssetDto): Promise<string> {
    const library = await this.timeBucketChecks(auth, dto);
    const timeBucketOptions = await this.buildTimeBucketOptions(auth, { ...dto }, library);

    // TODO: use id cursor for pagination
    const bucket = await this.assetRepository.getTimeBucket(dto.timeBucket, timeBucketOptions, auth);
    return bucket.assets;
  }

  private async buildTimeBucketOptions(
    auth: AuthDto,
    dto: TimeBucketDto,
    library: Library | undefined,
  ): Promise<TimeBucketOptions> {
    const { userId, ...options } = dto;
    let userIds: string[] | undefined = undefined;

    if (dto.libraryId && library) {
      userIds = [library.ownerId];
    } else if (userId) {
      userIds = [userId];
      if (dto.withPartners) {
        const partnerIds = await getMyPartnerIds({
          userId: auth.user.id,
          repository: this.partnerRepository,
          timelineEnabled: true,
        });
        userIds.push(...partnerIds);
      }
    }

    return { ...options, userIds };
  }

  // Returns the loaded library when `dto.libraryId` is set, so callers don't re-fetch it in buildTimeBucketOptions.
  private async timeBucketChecks(auth: AuthDto, dto: TimeBucketDto): Promise<Library | undefined> {
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    if (dto.libraryId && dto.albumId) {
      throw new BadRequestException('libraryId cannot be combined with albumId');
    }

    let library: Library | undefined;

    if (dto.albumId) {
      await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [dto.albumId] });
    } else if (dto.libraryId) {
      await this.requireAccess({ auth, permission: Permission.LibraryRead, ids: [dto.libraryId] });

      library = await this.libraryRepository.get(dto.libraryId);
      if (!library) {
        throw new BadRequestException('Library not found');
      }

      // Recipients (Viewer or Editor) get a fixed, safe filter set; owners keep full filter freedom.
      if (library.ownerId !== auth.user.id) {
        const requestedNonTimelineVisibility = dto.visibility !== undefined && dto.visibility !== AssetVisibility.Timeline;
        if (requestedNonTimelineVisibility || dto.isFavorite !== undefined || dto.isTrashed === true || dto.withPartners) {
          throw new BadRequestException(
            'Shared libraries only support browsing non-archived, non-trashed, non-favorited Timeline assets',
          );
        }

        dto.visibility = AssetVisibility.Timeline;
        dto.withStacked = false;
      }
      // do NOT set dto.userId here — that would route into the TimelineRead/ArchiveRead check below, which
      // only owner ∪ partner can pass; shared-library access is authorized above, independently of TimelineRead.
    } else {
      dto.userId = dto.userId || auth.user.id;
    }

    if (dto.userId) {
      await this.requireAccess({ auth, permission: Permission.TimelineRead, ids: [dto.userId] });
      if (dto.visibility === AssetVisibility.Archive) {
        await this.requireAccess({ auth, permission: Permission.ArchiveRead, ids: [dto.userId] });
      }
    }

    if (dto.tagId) {
      await this.requireAccess({ auth, permission: Permission.TagRead, ids: [dto.tagId] });
    }

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      dto.withCoordinates = false;
    }

    if (dto.withPartners) {
      const requestedLocked = dto.visibility === AssetVisibility.Locked;
      const requestedArchived = dto.visibility === AssetVisibility.Archive || dto.visibility === undefined;
      const requestedFavorite = dto.isFavorite === true || dto.isFavorite === false;
      const requestedTrash = dto.isTrashed === true;

      if (requestedLocked || requestedArchived || requestedFavorite || requestedTrash) {
        throw new BadRequestException(
          'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
        );
      }
    }

    return library;
  }
}
