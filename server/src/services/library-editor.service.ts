import { BadRequestException, Injectable } from '@nestjs/common';
import { AssetResponseDto, mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { LibraryAssetBulkUpdateDto, LibraryAssetUpdateDto } from 'src/dtos/library-editor.dto';
import { Permission } from 'src/enum';
import { LibraryAssetMetadataEdit } from 'src/repositories/asset.repository';
import { BaseService } from 'src/services/base.service';
import { extractTimeZone } from 'src/utils/date';

@Injectable()
export class LibraryEditorService extends BaseService {
  async updateAsset(
    auth: AuthDto,
    libraryId: string,
    assetId: string,
    dto: LibraryAssetUpdateDto,
  ): Promise<AssetResponseDto> {
    const [asset] = await this.updateAssets(auth, libraryId, { ...dto, ids: [assetId] });
    return asset;
  }

  async updateAssets(auth: AuthDto, libraryId: string, dto: LibraryAssetBulkUpdateDto): Promise<AssetResponseDto[]> {
    // Outer, fast-path check (owner ∪ Editor on this exact library). The repository primitive re-runs the
    // equivalent check again INSIDE its transaction - see updateLibraryAssetMetadata's own doc comment for why
    // both checks exist: this one fails fast for the common case, the inner one closes the TOCTOU race.
    await this.requireAccess({ auth, permission: Permission.LibraryAssetUpdate, ids: [libraryId] });

    const edit = await this.resolveEdit(dto);
    const updatedIds = await this.assetRepository.updateLibraryAssetMetadata(libraryId, auth.user.id, dto.ids, edit);
    if (!updatedIds) {
      throw new BadRequestException(
        'Library not found, access no longer granted, or one or more assets are not in this library',
      );
    }

    return Promise.all(updatedIds.map((assetId) => this.getUpdatedAsset(auth, assetId)));
  }

  private async getUpdatedAsset(auth: AuthDto, assetId: string): Promise<AssetResponseDto> {
    const asset = await this.assetRepository.getById(assetId, {
      exifInfo: true,
      owner: true,
      faces: { person: true },
      stack: { assets: true },
      edits: true,
      tags: true,
    });
    if (!asset) {
      throw new BadRequestException('Asset not found');
    }

    // Mirrors AssetService.get()'s exact same-library-live-photo check, so an editor's post-edit response
    // redacts livePhotoVideoId identically to how a normal GET of the same asset would.
    let sameLibraryLivePhoto = false;
    if (asset.libraryId && asset.ownerId !== auth.user.id && !auth.user.isAdmin && asset.livePhotoVideoId) {
      const motion = await this.assetRepository.getById(asset.livePhotoVideoId, {});
      sameLibraryLivePhoto = motion?.libraryId === asset.libraryId;
    }

    const data = mapAsset(asset, { withStack: true, auth, sameLibraryLivePhoto });

    // mapAsset() itself doesn't redact people - AssetService.get() does it one layer up (the same reason it
    // exists there), so it must be repeated here. Person/face data is entirely out of scope for this Editor
    // endpoint (that's Phase 4), and a person's thumbnail can be cropped from an asset this caller can't access.
    if (data.ownerId !== auth.user.id) {
      data.people = [];
    }

    return data;
  }

  private async resolveEdit(dto: LibraryAssetBulkUpdateDto): Promise<LibraryAssetMetadataEdit> {
    const edit: LibraryAssetMetadataEdit = {
      description: dto.description,
      rating: dto.rating,
      dateTimeRelative: dto.dateTimeRelative,
      dateTimeOriginal: dto.dateTimeOriginal === undefined ? undefined : new Date(dto.dateTimeOriginal),
      timeZone: dto.timeZone ?? extractTimeZone(dto.dateTimeOriginal)?.name,
    };

    if (dto.latitude !== undefined && dto.longitude !== undefined) {
      edit.latitude = dto.latitude;
      edit.longitude = dto.longitude;

      if (dto.latitude === null || dto.longitude === null) {
        edit.city = null;
        edit.state = null;
        edit.country = null;
      } else {
        const { reverseGeocoding } = await this.getConfig({ withCache: true });
        const geo = reverseGeocoding.enabled
          ? await this.mapRepository.reverseGeocode({ latitude: dto.latitude, longitude: dto.longitude })
          : { city: null, state: null, country: null };
        edit.city = geo.city;
        edit.state = geo.state;
        edit.country = geo.country;
      }
    }

    return edit;
  }
}
