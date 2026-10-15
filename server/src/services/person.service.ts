import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Insertable } from 'kysely';
import { isUndefined, omitBy } from 'lodash-es';
import type { JobItem, JobOf } from 'src/types.js';
import { JOBS_ASSET_PAGINATION_SIZE } from 'src/constants.js';
import { Chunked, OnJob } from 'src/decorators.js';
import { BulkIdErrorReason, BulkIdResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AssetFaceCreateDto,
  AssetFaceDeleteDto,
  AssetFaceResponseDto,
  AssetFaceUpdateDto,
  FaceDto,
  MergePersonDto,
  PeopleDeleteDto,
  PeopleResponseDto,
  PeopleUpdateDto,
  PeopleUsersUpsertDto,
  PersonCreateDto,
  PersonDeleteDto,
  PersonResponseDto,
  PersonSearchDto,
  PersonStatisticsResponseDto,
  PersonUpdateDto,
  PersonUsersDeleteDto,
  PersonUsersResponseDto,
  PersonUsersSearchDto,
  mapFaces,
  mapPerson,
  mapPersonUsers,
  redactPersonForNonOwner,
} from 'src/dtos/person.dto.js';
import {
  AssetType,
  AssetVisibility,
  CacheControl,
  JobName,
  JobStatus,
  Permission,
  PersonPathType,
  QueueName,
  SourceType,
  SystemMetadataKey,
  VectorIndex,
} from 'src/enum.js';
import { BoundingBox } from 'src/repositories/machine-learning.repository.js';
import { PersonId } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
import { FaceSearchTable } from 'src/schema/tables/face-search.table.js';
import { PersonUserTable } from 'src/schema/tables/person-user.table.js';
import { BaseService } from 'src/services/base.service.js';
import { getDimensions, getMyPartnerIds } from 'src/utils/asset.util.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { isHttpException } from 'src/utils/logger.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { batched, findOrFail, hasSomeDefined, isFacialRecognitionEnabled } from 'src/utils/misc.js';
import { getPreferences } from 'src/utils/preferences.js';
import { Point, transformPoints } from 'src/utils/transform.js';

const personKey = ({ ownerId, personGroupId }: PersonId) => `${ownerId}/${personGroupId}`;

@Injectable()
export class PersonService extends BaseService {
  async getAll(auth: AuthDto, dto: PersonSearchDto): Promise<PeopleResponseDto> {
    const { withHidden = false, closestAssetId, closestPersonId, page, size, ...filters } = dto;
    let closestFaceAssetId = closestAssetId;
    const pagination = {
      take: size,
      skip: (page - 1) * size,
    };

    if (closestPersonId) {
      const person = await this.personRepository.getByGroupId({
        ownerId: auth.user.id,
        personGroupId: closestPersonId,
      });
      if (!person?.faceAssetId) {
        throw new NotFoundException('Person not found');
      }
      closestFaceAssetId = person.faceAssetId;
    }
    const partnerIds = await getMyPartnerIds({
      userId: auth.user.id,
      repository: this.partnerRepository,
    });
    const { items, hasNextPage } = await this.personRepository.getAllForUser(pagination, auth.user.id, {
      withHidden,
      partnerIds,
      closestFaceAssetId,
      ...filters,
    });
    const { total, hidden } = await this.personRepository.getNumberOfPeople(auth.user.id, { partnerIds, ...filters });

    // Phase 5 (§5.5): union in persons reachable through the caller's inTimeline-shared libraries.
    // Always redacted, always excluding hidden persons regardless of `withHidden` (that's the OWNER's
    // own preference, never a sharee's), with the minimumFaces threshold counting ONLY in-shared-
    // library faces. Simplification: this arm is fetched as one capped, unpaginated batch rather than
    // truly merged into the owner arm's page-by-page pagination - acceptable for a secondary listing
    // surface, but noted here rather than glossed over.
    //
    // Review finding fix: the shared batch is APPENDED exactly once - on the final owner page
    // (hasNextPage=false) - never on every page, since duplicated person ids across pages break the
    // web People page's keyed {#each} during infinite scroll. `total` still includes the shared count
    // on EVERY page because the web reads it from page 1 only.
    let sharedPeople: PersonResponseDto[] = [];
    const sharedLibraryIds = await this.libraryRepository.getInTimelineSharedLibraryIds(auth.user.id);
    if (sharedLibraryIds.length > 0) {
      const metadata = await this.userRepository.getMetadata(auth.user.id);
      const minimumFaces = getPreferences(metadata).people.minimumFaces;
      const shared = await this.personRepository.getAllForSharedLibraries(
        sharedLibraryIds,
        { take: 500, skip: 0 },
        minimumFaces,
      );
      sharedPeople = shared.items.map((person) => redactPersonForNonOwner(mapPerson(person)));
    }

    return {
      people: [...items.map((person) => mapPerson(person)), ...(hasNextPage ? [] : sharedPeople)],
      hasNextPage,
      total: total + sharedPeople.length,
      hidden,
    };
  }

  async reassignFaces(auth: AuthDto, personGroupId: string, dto: AssetFaceUpdateDto): Promise<PersonResponseDto[]> {
    const ids = dto.data.map((item) => ({ personGroupId: item.personId, ownerId: item.userId ?? auth.user.id }));

    await this.requirePersonAccess({
      auth,
      permission: Permission.PersonUpdate,
      ids: [{ personGroupId, ownerId: auth.user.id }, ...ids],
    });

    const person = await this.findOrFail(auth, personGroupId);

    const result: PersonResponseDto[] = [];
    const changeFeaturePhoto = new Map<string, PersonId>();
    for (const data of dto.data) {
      const faces = await this.personRepository.getFacesByIds(
        [{ personGroupId: data.personId, assetId: data.assetId }],
        { viewingUserId: auth.user.id },
      );

      for (const face of faces) {
        const ids = await this.checkAccess({ auth, permission: Permission.PersonCreate, ids: [face.id] });

        if (ids.size !== 1) {
          continue;
        }

        if (person.faceAssetId === null) {
          changeFeaturePhoto.set(personKey(person), person);
        }
        if (face.person && face.person.faceAssetId === face.id) {
          changeFeaturePhoto.set(personKey(face.person), face.person);
        }

        await this.personRepository.reassignFace(face.id, person.personGroupId);
      }

      result.push(mapPerson(person));
    }
    if (changeFeaturePhoto.size > 0) {
      await this.createNewFeaturePhoto(changeFeaturePhoto.values().toArray());
    }
    return result;
  }

  async reassignFacesById(auth: AuthDto, personGroupId: string, dto: FaceDto): Promise<PersonResponseDto> {
    await this.requirePersonAccess({
      auth,
      permission: Permission.PersonUpdate,
      ids: [{ personGroupId, ownerId: auth.user.id }],
    });
    await this.requireAccess({ auth, permission: Permission.PersonCreate, ids: [dto.id] });
    const face = await this.personRepository.getFaceById(dto.id, { viewingUserId: auth.user.id });
    const person = await this.findOrFail(auth, personGroupId);

    await this.personRepository.reassignFace(face.id, person.personGroupId);
    if (person.faceAssetId === null) {
      await this.createNewFeaturePhoto([person]);
    }
    if (face.person && face.person.faceAssetId === face.id) {
      await this.createNewFeaturePhoto([face.person]);
    }

    return mapPerson(await this.findOrFail(auth, personGroupId));
  }

  async getFacesById(auth: AuthDto, dto: FaceDto): Promise<AssetFaceResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.id] });
    const asset = await this.assetRepository.getForFaces(dto.id);
    const assetDimensions = getDimensions(asset);

    // Phase 5 (§5.7): per-face redaction, not global reachability - is THIS asset's own library
    // actively shared with the caller (any role)? See mapFaces' doc comment for why this differs
    // from checkSharedLibraryPersonAccess.
    let assetLibraryShared = false;
    if (asset.libraryId && asset.ownerId !== auth.user.id) {
      const sharedLibraryIds = await this.accessRepository.library.checkSharedAccess(
        auth.user.id,
        new Set([asset.libraryId]),
      );
      assetLibraryShared = sharedLibraryIds.size > 0;
    }

    const faces = await this.personRepository.getFaces(dto.id, {
      viewingUserId: auth.user.id,
      isVisible: true,
      libraryOwnerId: assetLibraryShared ? asset.ownerId : undefined,
    });
    return faces.map((face) => mapFaces(face, asset.edits, assetDimensions, assetLibraryShared));
  }

  async createNewFeaturePhoto(changeFeaturePhoto: PersonId[]) {
    this.logger.debug(
      `Changing feature photos for ${changeFeaturePhoto.length} ${changeFeaturePhoto.length > 1 ? 'people' : 'person'}`,
    );

    const jobs: JobItem[] = [];
    for (const { ownerId, personGroupId } of changeFeaturePhoto) {
      const assetFace = await this.personRepository.getRandomFace(personGroupId);

      if (!assetFace) {
        continue;
      }

      await this.personRepository.update({ ownerId, personGroupId, faceAssetId: assetFace.id });
      jobs.push({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } });
    }

    await this.jobRepository.queueAll(jobs);
  }

  async getById(auth: AuthDto, personGroupId: string): Promise<PersonResponseDto> {
    const ownId = { personGroupId, ownerId: auth.user.id };
    const ownAccess = await this.checkPersonAccess({ auth, permission: Permission.PersonRead, ids: [ownId] });
    if (ownAccess.size > 0) {
      return mapPerson(
        await findOrFail(() => this.personRepository.getForUser({ userId: auth.user.id, personGroupId }), 'Person'),
      );
    }

    // Fork (Phase 5 §5.3): no row of the caller's own for this person group - fall back to the library
    // OWNER's person when it is reachable through a library shared with the caller, redacted rather than
    // returning the owner's account-wide projection.
    const libraryPerson = await this.personRepository.getForSharedLibraryViewer(auth.user.id, personGroupId);
    await this.requirePersonAccess({
      auth,
      permission: Permission.PersonRead,
      ids: [{ personGroupId, ownerId: libraryPerson?.ownerId ?? auth.user.id }],
    });
    const redacted = redactPersonForNonOwner(mapPerson(libraryPerson!));
    // Routing hint for the web: which shared library (if any) lets this caller rename the person via
    // the library-editor endpoint. The write path re-validates, so a stale hint only costs an error toast.
    redacted.renameLibraryId = await this.personRepository.getEditorRenameLibraryId(auth.user.id, personGroupId);
    return redacted;
  }

  // Fork note (Phase 5 §5.2): statistics reveal the person's GLOBAL asset count, so they stay on the caller's
  // own person row - the shared-library PersonRead arm never matches `ownerId: auth.user.id`.
  async getStatistics(auth: AuthDto, personGroupId: string): Promise<PersonStatisticsResponseDto> {
    await this.requirePersonAccess({
      auth,
      permission: Permission.PersonRead,
      ids: [{ personGroupId, ownerId: auth.user.id }],
    });

    const partnerIds = await getMyPartnerIds({
      userId: auth.user.id,
      repository: this.partnerRepository,
    });
    return this.personRepository.getStatistics(personGroupId, { ownerId: auth.user.id, partnerIds });
  }

  async getThumbnail(auth: AuthDto, personGroupId: string): Promise<ImmichFileResponse> {
    const ownId = { personGroupId, ownerId: auth.user.id };
    const ownAccess = await this.checkPersonAccess({ auth, permission: Permission.PersonRead, ids: [ownId] });

    let thumbnailPath: string | undefined;
    if (ownAccess.size > 0) {
      const personGroup = await this.personRepository.getForThumbnail(ownId);
      thumbnailPath = personGroup?.thumbnailPath || personGroup?.sharedThumbnailPath || undefined;
    } else {
      // Fork (Phase 5 §5.6): a shared-library recipient reaches the library OWNER's person. Its thumbnail may
      // be cropped from an asset outside any library shared with this caller - serve it only when the person's
      // OWN feature face's source asset is itself in an inTimeline-shared library. The web falls back to the
      // initials avatar on 403.
      const libraryPerson = await this.personRepository.getForSharedLibraryViewer(auth.user.id, personGroupId);
      await this.requirePersonAccess({
        auth,
        permission: Permission.PersonRead,
        ids: [{ personGroupId, ownerId: libraryPerson?.ownerId ?? auth.user.id }],
      });
      const servable =
        !!libraryPerson?.faceAssetId &&
        (await this.personRepository.isFeatureFaceInSharedLibrary(auth.user.id, libraryPerson.faceAssetId));
      if (!servable) {
        throw new ForbiddenException();
      }
      thumbnailPath = libraryPerson.thumbnailPath || undefined;
    }

    if (!thumbnailPath) {
      throw new NotFoundException();
    }

    return new ImmichFileResponse({
      path: thumbnailPath,
      contentType: mimeTypes.lookup(thumbnailPath),
      cacheControl: CacheControl.PrivateWithoutCache,
    });
  }

  async create(auth: AuthDto, dto: PersonCreateDto): Promise<PersonResponseDto> {
    const group = await this.personRepository.createGroup(auth.user.id);
    const person = await this.personRepository.create({
      ownerId: auth.user.id,
      personGroupId: group.id,
      name: dto.name,
      birthDate: dto.birthDate,
      isHidden: dto.isHidden,
      isFavorite: dto.isFavorite,
      color: dto.color,
    });

    return mapPerson(person);
  }

  async update(auth: AuthDto, personGroupId: string, dto: PersonUpdateDto): Promise<PersonResponseDto> {
    const { userId: userIdOverride, name, birthDate, isHidden, featureFaceAssetId: assetId, isFavorite, color } = dto;
    const targetOwnerId = userIdOverride ?? auth.user.id;
    const hasSharedProperties = hasSomeDefined([name, birthDate]);
    const hasPersonalProperties = hasSomeDefined([isHidden, isFavorite, color, assetId]);

    if (targetOwnerId !== auth.user.id && hasPersonalProperties) {
      throw new BadRequestException('Only name and birthDate can be updated for other users');
    }

    await this.requirePersonAccess({
      auth,
      permission: Permission.PersonUpdate,
      ids: [{ personGroupId, ownerId: targetOwnerId }],
    });

    if (!userIdOverride && hasSharedProperties) {
      await this.personRepository.updateForWritableOwners({ userId: auth.user.id, personGroupId }, { name, birthDate });
    }

    let faceId: string | undefined;

    if (assetId) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
      const face = await this.personRepository.getForFeatureFaceUpdate({ personGroupId, assetId });
      if (!face) {
        throw new BadRequestException('Invalid assetId for feature face or asset is offline');
      }

      faceId = face.id;
    }

    const person = await this.personRepository.update({
      ownerId: targetOwnerId,
      personGroupId,
      faceAssetId: faceId,
      name,
      birthDate,
      isHidden,
      isFavorite,
      color,
    });

    if (assetId) {
      await this.jobRepository.queue({
        name: JobName.PersonGenerateThumbnail,
        data: { ownerId: targetOwnerId, personGroupId },
      });
    }

    return mapPerson(person);
  }

  delete(auth: AuthDto, id: string, dto: PersonDeleteDto): Promise<void> {
    return this.deleteAll(auth, { ids: [id], ...dto });
  }

  async updateAll(auth: AuthDto, dto: PeopleUpdateDto): Promise<BulkIdResponseDto[]> {
    const results: BulkIdResponseDto[] = [];
    for (const person of dto.people) {
      try {
        await this.update(auth, person.id, {
          isHidden: person.isHidden,
          name: person.name,
          birthDate: person.birthDate,
          featureFaceAssetId: person.featureFaceAssetId,
          isFavorite: person.isFavorite,
          userId: person.userId,
        });
        results.push({ id: person.id, success: true });
      } catch (error: Error | any) {
        if (!isHttpException(error)) {
          this.logger.error(`Unable to update ${person.id} : ${error}`, error?.stack);
        }
        results.push({ id: person.id, success: false, error: BulkIdErrorReason.UNKNOWN });
      }
    }
    return results;
  }

  async deleteAll(auth: AuthDto, { ids, userId }: PeopleDeleteDto): Promise<void> {
    const ownerId = userId ?? auth.user.id;
    await this.requirePersonAccess({
      auth,
      permission: Permission.PersonDelete,
      ids: ids.map((id) => ({ personGroupId: id, ownerId })),
    });
    await this.removeAllPersonGroups(ids, ownerId);
    await this.personRepository.deleteEmptyGroups();
  }

  @Chunked()
  private async removeAllPersonGroups(groupIds: string[], ownerId?: string) {
    if (groupIds.length === 0) {
      return;
    }

    const people = await this.personRepository.delete(groupIds, ownerId);
    await Promise.all(people.map((person) => this.storageRepository.unlink(person.thumbnailPath)));
    this.logger.debug(`Deleted ${groupIds.length} people`);
  }

  @OnJob({ name: JobName.PersonCleanup, queue: QueueName.BackgroundTask })
  async handlePersonCleanup(): Promise<JobStatus> {
    // each step can leave the next one something to clean up, so the order matters
    const people = await this.personRepository.getAllWithoutFaces();
    await this.removeAllPersonGroups(people.map((person) => person.personGroupId));

    const personGroups = await this.personRepository.deleteEmptyGroups();
    const clusterGroups = await this.personRepository.deleteOrphanedClusterGroups();

    this.logger.debug(`Deleted ${personGroups} empty person groups and ${clusterGroups} orphaned cluster groups`);

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetDetectFacesQueueAll, queue: QueueName.FaceDetection })
  async handleQueueDetectFaces({ force }: JobOf<JobName.AssetDetectFacesQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    if (force) {
      await this.personRepository.deleteFaces({ sourceType: SourceType.MachineLearning });
      await this.handlePersonCleanup();
      await this.vacuum('asset_face', 'person', 'face_search');
    }

    for await (const assets of batched(this.assetJobRepository.streamForDetectFacesJob(force))) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetDetectFaces, data: { id: asset.id } })),
      );
    }

    if (force === undefined) {
      await this.jobRepository.queue({ name: JobName.PersonCleanup });
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetDetectFaces, queue: QueueName.FaceDetection })
  async handleDetectFaces({ id }: JobOf<JobName.AssetDetectFaces>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForDetectFacesJob(id);
    const previewFile = asset?.previewFile;
    if (!asset || !previewFile) {
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    const { imageHeight, imageWidth, faces } = await this.machineLearningRepository.detectFaces(
      previewFile.path,
      machineLearning.facialRecognition,
    );
    this.logger.debug(`${faces.length} faces detected in ${previewFile.path}`);

    const facesToAdd: (Insertable<AssetFaceTable> & { id: string })[] = [];
    const embeddings: FaceSearchTable[] = [];
    const mlFaceIds = new Set<string>();

    // Faces with a timestampMs come from sampled video frames and are owned by the video face
    // detection pipeline (which replaces them itself); the preview-based sweep below must only
    // consider preview-derived faces, or re-running detection on a video would delete them all.
    const previewFaces = asset.faces.filter((face) => face.timestampMs === null);

    for (const face of previewFaces) {
      if (face.sourceType === SourceType.MachineLearning) {
        mlFaceIds.add(face.id);
      }
    }

    const heightScale = imageHeight / (previewFaces[0]?.imageHeight || 1);
    const widthScale = imageWidth / (previewFaces[0]?.imageWidth || 1);
    for (const { boundingBox, embedding } of faces) {
      const scaledBox = {
        x1: boundingBox.x1 * widthScale,
        y1: boundingBox.y1 * heightScale,
        x2: boundingBox.x2 * widthScale,
        y2: boundingBox.y2 * heightScale,
      };
      const match = previewFaces.find((face) => this.iou(face, scaledBox) > 0.5);

      if (match && !mlFaceIds.delete(match.id)) {
        embeddings.push({ faceId: match.id, embedding });
      } else if (!match) {
        const faceId = this.cryptoRepository.randomUUID();
        facesToAdd.push({
          id: faceId,
          assetId: asset.id,
          imageHeight,
          imageWidth,
          boundingBoxX1: boundingBox.x1,
          boundingBoxY1: boundingBox.y1,
          boundingBoxX2: boundingBox.x2,
          boundingBoxY2: boundingBox.y2,
        });
        embeddings.push({ faceId, embedding });
      }
    }
    const faceIdsToRemove = [...mlFaceIds];

    if (facesToAdd.length > 0 || faceIdsToRemove.length > 0 || embeddings.length > 0) {
      await this.personRepository.refreshFaces(facesToAdd, faceIdsToRemove, embeddings);
    }

    if (faceIdsToRemove.length > 0) {
      this.logger.log(`Removed ${faceIdsToRemove.length} faces below detection threshold in asset ${id}`);
    }

    if (facesToAdd.length > 0) {
      this.logger.log(`Detected ${facesToAdd.length} new faces in asset ${id}`);
      const jobs = facesToAdd.map((face) => ({ name: JobName.FacialRecognition, data: { id: face.id } }) as const);
      await this.jobRepository.queueAll([{ name: JobName.FacialRecognitionQueueAll, data: { force: false } }, ...jobs]);
    } else if (embeddings.length > 0) {
      this.logger.log(`Added ${embeddings.length} face embeddings for asset ${id}`);
    }

    await this.assetRepository.upsertJobStatus({ assetId: asset.id, facesRecognizedAt: new Date() });

    if (asset.type === AssetType.Video && machineLearning.facialRecognition.videoEnabled) {
      await this.jobRepository.queue({ name: JobName.AssetVideoDetectFaces, data: { id: asset.id } });
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetVideoDetectFacesQueueAll, queue: QueueName.VideoFaceDetection })
  async handleQueueVideoDetectFaces({ force }: JobOf<JobName.AssetVideoDetectFacesQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isFacialRecognitionEnabled(machineLearning) || !machineLearning.facialRecognition.videoEnabled) {
      return JobStatus.Skipped;
    }

    let jobs: JobItem[] = [];
    const assets = this.assetJobRepository.streamForVideoDetectFacesJob(force);
    for await (const asset of assets) {
      jobs.push({ name: JobName.AssetVideoDetectFaces, data: { id: asset.id } });

      if (!(jobs.length >= JOBS_ASSET_PAGINATION_SIZE)) {
        continue;
      }

      await this.jobRepository.queueAll(jobs);
      jobs = [];
    }

    await this.jobRepository.queueAll(jobs);

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetVideoDetectFaces, queue: QueueName.VideoFaceDetection })
  async handleVideoDetectFaces({ id }: JobOf<JobName.AssetVideoDetectFaces>): Promise<JobStatus> {
    const { machineLearning, image } = await this.getConfig({ withCache: true });
    if (!isFacialRecognitionEnabled(machineLearning) || !machineLearning.facialRecognition.videoEnabled) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForVideoDetectFacesJob(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    const { videoFrameInterval, videoMaxFrames } = machineLearning.facialRecognition;
    let tempDir: string | undefined;
    try {
      tempDir = await this.storageRepository.createTempDir('immich-video-faces-');
      const framePaths = await this.mediaRepository.extractVideoFrames(
        asset.originalPath,
        tempDir,
        videoFrameInterval,
        videoMaxFrames,
        image.preview.size,
      );

      if (framePaths.length === 0) {
        this.logger.debug(`No frames extracted for video ${id}`);
        await this.assetRepository.upsertJobStatus({ assetId: id, videoFacesRecognizedAt: new Date() });
        return JobStatus.Success;
      }

      // Remove any faces from a previous run so re-detection replaces rather than appends.
      const staleVideoFaces = await this.personRepository.getVideoFaceIds(asset.id);
      const staleVideoFaceIds = staleVideoFaces.map((face) => face.id);

      const facesToAdd: (Insertable<AssetFaceTable> & { id: string })[] = [];
      const embeddings: FaceSearchTable[] = [];

      let detectedFrames = 0;
      let lastError: Error | undefined;
      for (const { path: framePath, timestampMs } of framePaths) {
        let imageHeight: number;
        let imageWidth: number;
        let faces: Awaited<ReturnType<typeof this.machineLearningRepository.detectFaces>>['faces'];
        try {
          // One failed frame should not discard the others; if every frame fails, the job fails.
          ({ imageHeight, imageWidth, faces } = await this.machineLearningRepository.detectFaces(
            framePath,
            machineLearning.facialRecognition,
          ));
        } catch (error: Error | any) {
          this.logger.warn(`Face detection failed for frame at ${timestampMs}ms of video ${id}: ${error.message}`);
          lastError = error;
          continue;
        }
        detectedFrames++;

        for (const { boundingBox, embedding } of faces) {
          const faceId = this.cryptoRepository.randomUUID();
          facesToAdd.push({
            id: faceId,
            assetId: asset.id,
            imageHeight,
            imageWidth,
            boundingBoxX1: boundingBox.x1,
            boundingBoxY1: boundingBox.y1,
            boundingBoxX2: boundingBox.x2,
            boundingBoxY2: boundingBox.y2,
            timestampMs,
          });
          embeddings.push({ faceId, embedding });
        }
      }

      if (detectedFrames === 0 && lastError) {
        throw lastError;
      }

      if (facesToAdd.length > 0 || staleVideoFaceIds.length > 0) {
        // Deleting a face that anchors a person's feature photo nulls person.faceAssetId, so
        // those people need a new feature photo picked from their remaining faces.
        const anchoredPeople =
          staleVideoFaceIds.length > 0 ? await this.personRepository.getPersonIdsByFaceAssetIds(staleVideoFaceIds) : [];
        await this.personRepository.refreshFaces(facesToAdd, staleVideoFaceIds, embeddings);
        if (anchoredPeople.length > 0) {
          await this.createNewFeaturePhoto(anchoredPeople);
        }
      }

      if (facesToAdd.length > 0) {
        this.logger.log(`Detected ${facesToAdd.length} faces across ${detectedFrames} frames in video ${id}`);
        await this.jobRepository.queue({ name: JobName.AssetVideoClusterFaces, data: { id } });
      }
    } finally {
      if (tempDir) {
        await this.storageRepository.unlinkDir(tempDir, { recursive: true, force: true });
      }
    }

    await this.assetRepository.upsertJobStatus({ assetId: id, videoFacesRecognizedAt: new Date() });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetVideoClusterFaces, queue: QueueName.VideoFaceDetection })
  async handleVideoClusterFaces({ id }: JobOf<JobName.AssetVideoClusterFaces>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isFacialRecognitionEnabled(machineLearning) || !machineLearning.facialRecognition.videoEnabled) {
      return JobStatus.Skipped;
    }

    const faces = await this.personRepository.getVideoFacesWithEmbeddings(id);

    if (faces.length === 0) {
      return JobStatus.Success;
    }

    const { maxDistance } = machineLearning.facialRecognition;

    // A face with no timestamp is the asset's pre-existing thumbnail-derived face; it may anchor
    // person.faceAssetId, so it must never be removed. Rank thumbnail faces first (forcing them to
    // be cluster representatives), then larger — more frontal — faces. Video-frame duplicates then
    // collapse into the thumbnail face rather than the other way around.
    const ranked = faces
      .map((face) => ({
        ...face,
        isThumbnail: face.timestampMs === null,
        area:
          ((face.boundingBoxX2 - face.boundingBoxX1) * (face.boundingBoxY2 - face.boundingBoxY1)) /
          (face.imageWidth * face.imageHeight || 1),
        vec: JSON.parse(face.embedding) as number[],
      }))
      .sort((a, b) => Number(b.isThumbnail) - Number(a.isThumbnail) || b.area - a.area);

    const processed = new Set<string>();
    const faceIdsToRemove: string[] = [];
    const survivors: typeof ranked = [];

    // Greedy clustering: each unvisited face becomes a cluster representative; subsequent video-frame
    // faces within maxDistance are marked as duplicates. Thumbnail faces are never removed. Greedy
    // single-link can leave transitively-close faces (A~B, B~C, but not A~C) unmerged — an accepted
    // trade-off; the recognition stage clusters such survivors into the same person anyway.
    // O(n²) in the number of detected faces (faces per frame × sampled frames); the yield below keeps
    // a dense-crowd worst case from stalling the job worker's event loop.
    for (const face of ranked) {
      await new Promise(setImmediate);
      if (processed.has(face.id)) {
        continue;
      }
      processed.add(face.id);
      survivors.push(face);

      for (const other of ranked) {
        if (processed.has(other.id) || other.isThumbnail) {
          continue;
        }
        if (!(this.cosineDistance(face.vec, other.vec) <= maxDistance)) {
          continue;
        }

        processed.add(other.id);
        faceIdsToRemove.push(other.id);
      }
    }

    if (faceIdsToRemove.length > 0) {
      // As above: re-pick feature photos for people anchored to a face that is about to be removed.
      const anchoredPeople = await this.personRepository.getPersonIdsByFaceAssetIds(faceIdsToRemove);
      await this.personRepository.refreshFaces([], faceIdsToRemove, []);
      if (anchoredPeople.length > 0) {
        await this.createNewFeaturePhoto(anchoredPeople);
      }
      this.logger.log(
        `Removed ${faceIdsToRemove.length} duplicate video faces in asset ${id}, kept ${survivors.length}`,
      );
    }

    // Only surviving video-frame faces need recognition; thumbnail faces were already queued by the
    // initial face-detection pass.
    const jobs = survivors
      .filter((face) => !face.isThumbnail)
      .map((face) => ({ name: JobName.FacialRecognition, data: { id: face.id } }) as const);
    await this.jobRepository.queueAll([{ name: JobName.FacialRecognitionQueueAll, data: { force: false } }, ...jobs]);

    return JobStatus.Success;
  }

  // Returns cosine distance (1 − cosine similarity). 0 = identical direction, 1 = orthogonal.
  // Zero-magnitude vectors are treated as maximally distant to avoid division by zero.
  private cosineDistance(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 1 : 1 - dot / denom;
  }

  private iou(
    face: { boundingBoxX1: number; boundingBoxY1: number; boundingBoxX2: number; boundingBoxY2: number },
    newBox: BoundingBox,
  ): number {
    const x1 = Math.max(face.boundingBoxX1, newBox.x1);
    const y1 = Math.max(face.boundingBoxY1, newBox.y1);
    const x2 = Math.min(face.boundingBoxX2, newBox.x2);
    const y2 = Math.min(face.boundingBoxY2, newBox.y2);

    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const area1 = (face.boundingBoxX2 - face.boundingBoxX1) * (face.boundingBoxY2 - face.boundingBoxY1);
    const area2 = (newBox.x2 - newBox.x1) * (newBox.y2 - newBox.y1);
    const union = area1 + area2 - intersection;

    return intersection / union;
  }

  @OnJob({ name: JobName.FacialRecognitionQueueAll, queue: QueueName.FacialRecognition })
  async handleQueueRecognizeFaces({
    force,
    nightly,
    clusterGroupId,
  }: JobOf<JobName.FacialRecognitionQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    await this.jobRepository.waitForQueueCompletion(QueueName.ThumbnailGeneration, QueueName.FaceDetection);

    if (nightly) {
      const [state, latestFaceDate] = await Promise.all([
        this.systemMetadataRepository.get(SystemMetadataKey.FacialRecognitionState),
        this.personRepository.getLatestFaceDate(),
      ]);

      if (state?.lastRun && latestFaceDate && state.lastRun > latestFaceDate) {
        this.logger.debug('Skipping facial recognition nightly since no face has been added since the last run');
        return JobStatus.Skipped;
      }
    }

    const { waiting } = await this.jobRepository.getJobCounts(QueueName.FacialRecognition);

    if (force) {
      await this.personRepository.unassignFaces({ clusterGroupId, sourceType: SourceType.MachineLearning });
      await this.handlePersonCleanup();
      await this.vacuum('asset_face', 'person');
    } else if (waiting) {
      this.logger.debug(
        `Skipping facial recognition queueing because ${waiting} job${waiting > 1 ? 's are' : ' is'} already queued`,
      );
      return JobStatus.Skipped;
    }

    await this.databaseRepository.prewarm(VectorIndex.Face);

    const lastRun = new Date().toISOString();

    const faces = this.personRepository.getAllFaces(
      force
        ? { clusterGroupId, sourceType: clusterGroupId ? SourceType.MachineLearning : undefined }
        : { personGroupId: null, clusterGroupId, sourceType: SourceType.MachineLearning },
    );
    for await (const batch of batched(faces)) {
      await this.jobRepository.queueAll(
        batch.map((face) => ({ name: JobName.FacialRecognition, data: { id: face.id, deferred: false } })),
      );
    }

    await this.systemMetadataRepository.set(SystemMetadataKey.FacialRecognitionState, { lastRun });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.FacialRecognition, queue: QueueName.FacialRecognition })
  async handleRecognizeFaces({ id, deferred }: JobOf<JobName.FacialRecognition>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const face = await this.personRepository.getFaceForFacialRecognitionJob(id);
    if (!face || !face.asset) {
      this.logger.warn(`Face ${id} not found`);
      return JobStatus.Failed;
    }

    if (face.sourceType !== SourceType.MachineLearning) {
      this.logger.warn(`Skipping face ${id} due to source ${face.sourceType}`);
      return JobStatus.Skipped;
    }

    if (!face.faceSearch?.embedding) {
      this.logger.warn(`Face ${id} does not have an embedding`);
      return JobStatus.Failed;
    }

    if (face.personGroupId) {
      this.logger.debug(`Face ${id} already has a person assigned`);
      return JobStatus.Skipped;
    }

    const { ownerId, clusterGroupId } = face.asset;
    const matches = await this.searchRepository.searchFaces({
      clusterGroupId,
      embedding: face.faceSearch.embedding,
      maxDistance: machineLearning.facialRecognition.maxDistance,
      numResults: machineLearning.facialRecognition.minFaces,
      minBirthDate: new Date(face.asset.fileCreatedAt),
    });

    // `matches` also includes the face itself
    if (machineLearning.facialRecognition.minFaces > 1 && matches.length <= 1) {
      this.logger.debug(`Face ${id} only matched the face itself, skipping`);
      return JobStatus.Skipped;
    }

    this.logger.debug(`Face ${id} has ${matches.length} matches`);

    const isCore =
      matches.length >= machineLearning.facialRecognition.minFaces &&
      face.asset.visibility === AssetVisibility.Timeline;
    if (!isCore && !deferred) {
      this.logger.debug(`Deferring non-core face ${id} for later processing`);
      await this.jobRepository.queue({ name: JobName.FacialRecognition, data: { id, deferred: true } });
      return JobStatus.Skipped;
    }

    let personGroupId = matches.find((match) => match.personGroupId)?.personGroupId;
    if (!personGroupId) {
      const [matchWithPerson] = await this.searchRepository.searchFaces({
        clusterGroupId,
        embedding: face.faceSearch.embedding,
        maxDistance: machineLearning.facialRecognition.maxDistance,
        numResults: 1,
        hasPerson: true,
        minBirthDate: new Date(face.asset.fileCreatedAt),
      });

      personGroupId = matchWithPerson?.personGroupId ?? undefined;
    }

    if (!personGroupId && isCore) {
      const group = await this.personRepository.createGroup(ownerId);
      personGroupId = group.id;
      this.logger.log(`Created person group ${personGroupId} for face ${id}`);
    }

    if (personGroupId) {
      const person = await this.personRepository.getByGroupId({ ownerId, personGroupId });
      if (person) {
        this.logger.debug(`Face ${id} matched person ${person.personGroupId}`);
      } else {
        await this.personRepository.create({ ownerId, faceAssetId: face.id, personGroupId });
        this.logger.log(`Created person for face ${id} in group ${personGroupId}`);
        await this.jobRepository.queue({
          name: JobName.PersonGenerateThumbnail,
          data: { ownerId, personGroupId },
        });
      }

      this.logger.debug(`Assigning face ${id} to person group ${personGroupId}`);
      await this.personRepository.reassignFaces({ faceIds: [id], newPersonGroupId: personGroupId });
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.PersonFileMigration, queue: QueueName.Migration })
  async handlePersonMigration({ ownerId, personGroupId }: JobOf<JobName.PersonFileMigration>): Promise<JobStatus> {
    const person = await this.personRepository.getByGroupId({ ownerId, personGroupId });
    if (!person) {
      return JobStatus.Failed;
    }

    await this.storageCore.movePersonFile(person, PersonPathType.Face);

    return JobStatus.Success;
  }

  async mergePeople(auth: AuthDto, { ids }: MergePersonDto): Promise<BulkIdResponseDto[]> {
    if (ids.length < 2) {
      throw new BadRequestException('At least two people are required for merging');
    }

    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Cannot merge a person into themselves');
    }

    const allowed = await this.checkPersonAccess({
      auth,
      permission: Permission.PersonMerge,
      ids: ids.map((id) => ({ personGroupId: id, ownerId: auth.user.id })),
    });
    const allowedIds = new Set(allowed.values().map((item) => item.personGroupId));
    const results = new Map<string, BulkIdResponseDto>(
      ids.map((id) => [
        id,
        {
          id,
          success: false,
          error: allowedIds.has(id) ? BulkIdErrorReason.NOT_FOUND : BulkIdErrorReason.NO_PERMISSION,
        },
      ]),
    );

    const orderedIds = ids.filter((id) => allowedIds.has(id));
    const [targetId, ...sourceIds] = orderedIds;
    const people = targetId ? await this.personRepository.getForMergePerson(orderedIds) : [];
    const lookup = new Map(people.map((person) => [personKey(person), person]));
    const ownerIds = new Set([auth.user.id, ...people.map((person) => person.ownerId)]);
    const targets = new Map(
      people.filter((person) => person.personGroupId === targetId).map((person) => [person.ownerId, person]),
    );

    if (targets.has(auth.user.id)) {
      results.set(targetId, { id: targetId, success: true });
    }

    for (const id of sourceIds) {
      for (const ownerId of ownerIds) {
        const isAuthUser = ownerId === auth.user.id;
        const source = lookup.get(personKey({ ownerId, personGroupId: id }));
        let target = targets.get(ownerId);
        if (!source) {
          continue;
        }

        // skip other users when there are conflicts
        if (!isAuthUser && target && ((target.name && source.name) || (target.birthDate && source.birthDate))) {
          continue;
        }

        try {
          if (!target) {
            // user has no person in the target group yet, so this one is updated to it
            targets.set(
              ownerId,
              await this.personRepository.updateGroupId({ ownerId, oldPersonGroupId: id, newPersonGroupId: targetId }),
            );
            continue;
          }

          const changes = omitBy(
            {
              name: source.name && !target.name ? source.name : undefined,
              birthDate: source.birthDate && !target.birthDate ? source.birthDate : undefined,
            },
            isUndefined,
          );
          if (Object.keys(changes).length > 0) {
            target = await this.personRepository.update({ ownerId, personGroupId: targetId, ...changes });
            targets.set(ownerId, target);
          }

          await this.personRepository.reassignFaces({ oldPersonGroupId: id, newPersonGroupId: targetId, ownerId });
          await this.removeAllPersonGroups([id], ownerId);
          this.logger.log(`Merged ${source.name || id} into ${target.name || targetId}`);

          if (isAuthUser) {
            results.set(id, { id, success: true });
          }
        } catch (error: any) {
          this.logger.error(`Unable to merge ${id} into ${targetId}: ${error}`, error?.stack);
          if (isAuthUser) {
            results.set(id, { id, success: false, error: BulkIdErrorReason.UNKNOWN });
          }
        }
      }
    }

    await this.personRepository.deleteEmptyGroups();

    return results.values().toArray();
  }

  private findOrFail(auth: AuthDto, personGroupId: string) {
    return findOrFail(() => this.personRepository.getByGroupId({ ownerId: auth.user.id, personGroupId }), 'Person');
  }

  // TODO return a asset face response
  async createFace(auth: AuthDto, dto: AssetFaceCreateDto): Promise<void> {
    await Promise.all([
      this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [dto.assetId] }),
      this.requirePersonAccess({
        auth,
        permission: Permission.PersonRead,
        ids: [{ personGroupId: dto.personId, ownerId: auth.user.id }],
      }),
    ]);

    const [asset, person] = await Promise.all([
      this.assetRepository.getById(dto.assetId, { edits: true, exifInfo: true }),
      this.findOrFail(auth, dto.personId),
    ]);

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    const edits = asset.edits || [];

    let topLeft: Point = { x: dto.x, y: dto.y };
    let bottomRight: Point = { x: dto.x + dto.width, y: dto.y + dto.height };

    // the coordinates received from the client are based on the edited preview image
    // we need to convert them to the coordinate space of the original unedited image
    if (edits.length > 0) {
      if (!asset.width || !asset.height || !asset.exifInfo?.exifImageWidth || !asset.exifInfo?.exifImageHeight) {
        throw new BadRequestException('Asset does not have valid dimensions');
      }

      // convert from preview to full dimensions
      const scaleFactor = asset.width / dto.imageWidth;
      topLeft = { x: topLeft.x * scaleFactor, y: topLeft.y * scaleFactor };
      bottomRight = { x: bottomRight.x * scaleFactor, y: bottomRight.y * scaleFactor };
      const [invertedTopLeft, invertedBottomRight] = transformPoints(
        [topLeft, bottomRight],
        edits,
        { width: asset.width, height: asset.height },
        { inverse: true },
      ).points;

      // make sure topLeft is top-left and bottomRight is bottom-right
      topLeft = {
        x: Math.min(invertedTopLeft.x, invertedBottomRight.x),
        y: Math.min(invertedTopLeft.y, invertedBottomRight.y),
      };
      bottomRight = {
        x: Math.max(invertedTopLeft.x, invertedBottomRight.x),
        y: Math.max(invertedTopLeft.y, invertedBottomRight.y),
      };

      // now coordinates are in original image space
      const originalDimensions = getDimensions(asset.exifInfo);
      dto.imageWidth = originalDimensions.width;
      dto.imageHeight = originalDimensions.height;
    }

    await this.personRepository.createAssetFace({
      personGroupId: person.personGroupId,
      assetId: dto.assetId,
      imageHeight: dto.imageHeight,
      imageWidth: dto.imageWidth,
      boundingBoxX1: Math.round(topLeft.x),
      boundingBoxX2: Math.round(bottomRight.x),
      boundingBoxY1: Math.round(topLeft.y),
      boundingBoxY2: Math.round(bottomRight.y),
      sourceType: SourceType.Manual,
    });

    if (!person.faceAssetId) {
      await this.createNewFeaturePhoto([person]);
    }
  }

  async deleteFace(auth: AuthDto, id: string, dto: AssetFaceDeleteDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.FaceDelete, ids: [id] });

    return dto.force ? this.personRepository.deleteAssetFace(id) : this.personRepository.softDeleteAssetFaces(id);
  }

  async getUsersForPeople(auth: AuthDto, dto: PersonUsersSearchDto): Promise<PersonUsersResponseDto> {
    const sharedUsers = await this.personUserRepository.searchPeopleUsers(auth.user.id, dto);

    return mapPersonUsers(sharedUsers);
  }

  async upsertPeopleUsers(auth: AuthDto, dto: PeopleUsersUpsertDto) {
    if (dto.sharedWithIds.includes(auth.user.id)) {
      throw new BadRequestException('Cannot share a person with yourself');
    }

    if (dto.personIds) {
      await this.requirePersonAccess({
        auth,
        permission: Permission.PersonUpdate,
        ids: dto.personIds.map((item) => ({ personGroupId: item, ownerId: auth.user.id })),
      });
    }

    const user = await findOrFail(() => this.userRepository.get(auth.user.id, {}), 'User');
    const clusterGroupUsers = await this.clusterGroupRepository.getUsers({
      clusterGroupId: user.clusterGroupId,
      userId: user.id,
    });
    const clusterGroupUserIds = new Set(clusterGroupUsers.map(({ id }) => id));

    for (const sharedWithId of dto.sharedWithIds) {
      if (!clusterGroupUserIds.has(sharedWithId)) {
        throw new BadRequestException('All users must be in the same cluster group');
      }
    }

    const sharedById = auth.user.id;

    if (dto.personIds) {
      const items: Insertable<PersonUserTable>[] = [];
      for (const sharedWithId of dto.sharedWithIds) {
        for (const personGroupId of dto.personIds) {
          items.push({ personGroupId, sharedById, sharedWithId, role: dto.role });
        }
      }

      await this.personUserRepository.createAll(items);
    } else {
      await this.personUserRepository.createAllForOwner({
        ownerId: sharedById,
        sharedWithIds: dto.sharedWithIds,
        role: dto.role,
      });
    }
  }

  async removeUsersFromPeople(auth: AuthDto, dto: PersonUsersDeleteDto) {
    await this.requirePersonAccess({
      auth,
      permission: Permission.PersonUpdate,
      ids: dto.map((item) => ({ personGroupId: item.personId, ownerId: item.sharedById ?? auth.user.id })),
    });
    await this.personUserRepository.deleteAll(auth.user.id, dto);
  }

  private vacuum(...tables: (keyof DB)[]): Promise<unknown> {
    return Promise.all(
      tables.map((table) =>
        this.databaseRepository
          .vacuum({ analyze: true, table })
          .then(() => this.databaseRepository.reindex(table, { concurrently: true })),
      ),
    );
  }
}
