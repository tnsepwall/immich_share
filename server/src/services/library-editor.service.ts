import { BadRequestException, Injectable } from '@nestjs/common';
import { AssetResponseDto, mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { LibraryAssetBulkUpdateDto, LibraryAssetUpdateDto } from 'src/dtos/library-editor.dto';
import {
  LibraryFaceAssignDto,
  LibraryFaceResponseDto,
  LibraryManualFaceDto,
  LibraryPeopleResponseDto,
  LibraryPeopleSearchDto,
  LibraryPersonCreateDto,
  LibraryPersonResponseDto,
  LibraryPersonUpdateDto,
  mapLibraryFace,
  mapLibraryPerson,
} from 'src/dtos/library-person.dto';
import { JobName, Permission } from 'src/enum';
import { LibraryAssetMetadataEdit } from 'src/repositories/asset.repository';
import { BaseService } from 'src/services/base.service';
import { JobItem } from 'src/types';
import { getDimensions } from 'src/utils/asset.util';
import { extractTimeZone } from 'src/utils/date';
import { Point, transformPoints } from 'src/utils/transform';

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

  // --- Person/face curation (Phase 4) ---
  // See FEATURE-PLAN-shared-external-libraries.md section 2 point 3: an Editor may list and curate
  // people/faces reachable only through this library's assets. A person's global thumbnailPath is
  // never exposed here (its source face may be outside the library) - callers get a thumbnailFace
  // {assetId, boundingBox, imageDimensions} instead and crop it client-side, exactly like the existing
  // zoomImageToBase64 face-crop path in the web app already does elsewhere.

  async getPeople(auth: AuthDto, libraryId: string, dto: LibraryPeopleSearchDto): Promise<LibraryPeopleResponseDto> {
    await this.requireAccess({ auth, permission: Permission.LibraryPersonRead, ids: [libraryId] });
    const { page, size } = dto;
    const { items, hasNextPage } = await this.personRepository.getAllForLibrary(libraryId, {
      take: size,
      skip: (page - 1) * size,
    });
    return { people: items.map((person) => mapLibraryPerson(person)), hasNextPage };
  }

  async getAssetFaces(auth: AuthDto, libraryId: string, assetId: string): Promise<LibraryFaceResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.LibraryPersonRead, ids: [libraryId] });
    // No separate "is this asset in the library" check needed: getFacesForLibraryAsset's join is
    // scoped to asset.libraryId = libraryId, so an assetId from outside the library yields [], never
    // another library's faces.
    const faces = await this.personRepository.getFacesForLibraryAsset(libraryId, assetId);
    return faces.map((face) => mapLibraryFace(face));
  }

  async createPerson(auth: AuthDto, libraryId: string, dto: LibraryPersonCreateDto): Promise<LibraryPersonResponseDto> {
    // Outer, fast-path check (owner ∪ Editor on this exact library). createPersonForLibrary re-runs the
    // equivalent role check, plus the face-scope check, INSIDE its own transaction - see that method's doc
    // comment for why both checks exist: this one fails fast for the common case, the inner one closes the
    // TOCTOU race and guarantees no empty owner-scoped person is left behind if a face turns out to be out
    // of scope mid-flight.
    await this.requireAccess({ auth, permission: Permission.LibraryPersonCreate, ids: [libraryId] });

    const result = await this.personRepository.createPersonForLibrary(libraryId, auth.user.id, dto.name, dto.faceIds);
    if (!result) {
      throw new BadRequestException(
        'Library not found, access no longer granted, or one or more faces are not in this library',
      );
    }

    await this.queueFeaturePhotoRefresh(result.needsFeaturePhoto);

    const created = await this.personRepository.getOneForLibrary(libraryId, result.personId);
    if (!created) {
      throw new BadRequestException('Failed to load created person');
    }
    return mapLibraryPerson(created);
  }

  async updatePersonName(
    auth: AuthDto,
    libraryId: string,
    personId: string,
    dto: LibraryPersonUpdateDto,
  ): Promise<LibraryPersonResponseDto> {
    await this.requireAccess({ auth, permission: Permission.LibraryPersonUpdate, ids: [libraryId] });

    const updated = await this.personRepository.updatePersonNameForLibrary(libraryId, auth.user.id, personId, dto.name);
    if (!updated) {
      throw new BadRequestException(
        'Library not found, access no longer granted, person not in this library, or this person has faces outside this library',
      );
    }

    const person = await this.personRepository.getOneForLibrary(libraryId, personId);
    if (!person) {
      throw new BadRequestException('Person not found in this library');
    }
    return mapLibraryPerson(person);
  }

  async assignFaces(auth: AuthDto, libraryId: string, dto: LibraryFaceAssignDto): Promise<LibraryFaceResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.LibraryFaceUpdate, ids: [libraryId] });

    const result = await this.personRepository.assignFacesForLibrary(
      libraryId,
      auth.user.id,
      dto.personId,
      dto.faceIds,
    );
    if (!result) {
      throw new BadRequestException(
        'Library not found, access no longer granted, one or more faces are not in this library, or the person is not reachable through this library',
      );
    }

    await this.queueFeaturePhotoRefresh(result.needsFeaturePhoto);

    const faces = await Promise.all(dto.faceIds.map((faceId) => this.personRepository.getFaceById(faceId)));
    return faces.map((face) =>
      mapLibraryFace({
        ...face,
        person: face.person && { id: face.person.id, name: face.person.name },
      }),
    );
  }

  async createManualFace(auth: AuthDto, libraryId: string, dto: LibraryManualFaceDto): Promise<LibraryFaceResponseDto> {
    await this.requireAccess({ auth, permission: Permission.LibraryFaceCreate, ids: [libraryId] });

    // Fetched only to compute the preview-to-original coordinate transform below - NOT the authorization
    // check. createManualFaceForLibrary re-verifies both the person and the asset (Timeline-visible,
    // non-deleted, genuinely in this library) fresh, inside its own transaction, immediately before writing.
    const asset = await this.assetRepository.getById(dto.assetId, { edits: true, exifInfo: true });
    if (!asset) {
      throw new BadRequestException('Asset not found');
    }

    // Mirrors PersonService.createFace's exact preview-to-original coordinate transform: the box the
    // editor drew is in the space of the (possibly cropped/rotated) preview image, but faces are
    // always stored in original-image coordinates.
    const edits = asset.edits || [];
    let topLeft: Point = { x: dto.x, y: dto.y };
    let bottomRight: Point = { x: dto.x + dto.width, y: dto.y + dto.height };
    let imageWidth = dto.imageWidth;
    let imageHeight = dto.imageHeight;

    if (edits.length > 0) {
      if (!asset.width || !asset.height || !asset.exifInfo?.exifImageWidth || !asset.exifInfo?.exifImageHeight) {
        throw new BadRequestException('Asset does not have valid dimensions');
      }

      const scaleFactor = asset.width / dto.imageWidth;
      topLeft = { x: topLeft.x * scaleFactor, y: topLeft.y * scaleFactor };
      bottomRight = { x: bottomRight.x * scaleFactor, y: bottomRight.y * scaleFactor };

      const {
        points: [invertedTopLeft, invertedBottomRight],
      } = transformPoints(
        [topLeft, bottomRight],
        edits,
        { width: asset.width, height: asset.height },
        { inverse: true },
      );

      topLeft = {
        x: Math.min(invertedTopLeft.x, invertedBottomRight.x),
        y: Math.min(invertedTopLeft.y, invertedBottomRight.y),
      };
      bottomRight = {
        x: Math.max(invertedTopLeft.x, invertedBottomRight.x),
        y: Math.max(invertedTopLeft.y, invertedBottomRight.y),
      };

      const originalDimensions = getDimensions(asset.exifInfo);
      imageWidth = originalDimensions.width;
      imageHeight = originalDimensions.height;
    }

    const result = await this.personRepository.createManualFaceForLibrary(
      libraryId,
      auth.user.id,
      dto.personId,
      dto.assetId,
      {
        imageWidth,
        imageHeight,
        boundingBoxX1: Math.round(topLeft.x),
        boundingBoxX2: Math.round(bottomRight.x),
        boundingBoxY1: Math.round(topLeft.y),
        boundingBoxY2: Math.round(bottomRight.y),
      },
    );
    if (!result) {
      throw new BadRequestException(
        'Library not found, access no longer granted, the person is not reachable through this library, or the asset is not in this library',
      );
    }

    await this.queueFeaturePhotoRefresh(result.needsFeaturePhoto);

    const person = await this.personRepository.getById(dto.personId);
    return mapLibraryFace({
      id: result.faceId,
      assetId: dto.assetId,
      imageWidth,
      imageHeight,
      boundingBoxX1: Math.round(topLeft.x),
      boundingBoxX2: Math.round(bottomRight.x),
      boundingBoxY1: Math.round(topLeft.y),
      boundingBoxY2: Math.round(bottomRight.y),
      person: person ? { id: person.id, name: person.name } : null,
    });
  }

  private async queueFeaturePhotoRefresh(personIds: string[]): Promise<void> {
    if (personIds.length === 0) {
      return;
    }
    const jobs: JobItem[] = personIds.map((id) => ({ name: JobName.PersonGenerateThumbnail, data: { id } }));
    await this.jobRepository.queueAll(jobs);
  }
}
