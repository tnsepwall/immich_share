import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto';
import { mapFaces, mapPerson } from 'src/dtos/person.dto';
import { AssetFileType, AssetType, CacheControl, JobName, JobStatus, SourceType, SystemMetadataKey } from 'src/enum';
import { FaceSearchResult } from 'src/repositories/search.repository';
import { PersonService } from 'src/services/person.service';
import { ImmichFileResponse } from 'src/utils/file';
import { AssetFaceFactory } from 'test/factories/asset-face.factory';
import { AssetFactory } from 'test/factories/asset.factory';
import { AuthFactory } from 'test/factories/auth.factory';
import { PersonFactory } from 'test/factories/person.factory';
import { UserFactory } from 'test/factories/user.factory';
import { authStub } from 'test/fixtures/auth.stub';
import { systemConfigStub } from 'test/fixtures/system-config.stub';
import {
  getAsDetectedFace,
  getForAsset,
  getForAssetFace,
  getForDetectedFaces,
  getForFacialRecognitionJob,
} from 'test/mappers';
import { newDate, newUuid } from 'test/small.factory';
import { makeStream, newTestService, ServiceMocks } from 'test/utils';

const makeFace = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  embedding: number[],
  timestampMs: number | null = 0,
) => ({
  id,
  imageWidth: 100,
  imageHeight: 100,
  boundingBoxX1: x1,
  boundingBoxY1: y1,
  boundingBoxX2: x2,
  boundingBoxY2: y2,
  timestampMs,
  embedding: JSON.stringify(embedding),
});

describe(PersonService.name, () => {
  let sut: PersonService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PersonService));
    mocks.library.getInTimelineSharedLibraryIds.mockResolvedValue([]);
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('getAll', () => {
    it('should get all hidden and visible people with thumbnails', async () => {
      const auth = AuthFactory.create();
      const [person, hiddenPerson] = [PersonFactory.create(), PersonFactory.create({ isHidden: true })];

      mocks.person.getAllForUser.mockResolvedValue({
        items: [person, hiddenPerson],
        hasNextPage: false,
      });
      mocks.person.getNumberOfPeople.mockResolvedValue({ total: 2, hidden: 1 });
      await expect(sut.getAll(auth, { withHidden: true, page: 1, size: 10 })).resolves.toEqual({
        hasNextPage: false,
        total: 2,
        hidden: 1,
        people: [
          expect.objectContaining({ id: person.id, isHidden: false }),
          expect.objectContaining({
            id: hiddenPerson.id,
            isHidden: true,
          }),
        ],
      });
      expect(mocks.person.getAllForUser).toHaveBeenCalledWith({ skip: 0, take: 10 }, auth.user.id, {
        withHidden: true,
      });
    });

    it('should get all visible people and favorites should be first in the array', async () => {
      const auth = AuthFactory.create();
      const [isFavorite, person] = [PersonFactory.create({ isFavorite: true }), PersonFactory.create()];

      mocks.person.getAllForUser.mockResolvedValue({
        items: [isFavorite, person],
        hasNextPage: false,
      });
      mocks.person.getNumberOfPeople.mockResolvedValue({ total: 2, hidden: 1 });
      await expect(sut.getAll(auth, { withHidden: false, page: 1, size: 10 })).resolves.toEqual({
        hasNextPage: false,
        total: 2,
        hidden: 1,
        people: [
          expect.objectContaining({
            id: isFavorite.id,
            isFavorite: true,
          }),
          expect.objectContaining({ id: person.id, isFavorite: false }),
        ],
      });
      expect(mocks.person.getAllForUser).toHaveBeenCalledWith({ skip: 0, take: 10 }, auth.user.id, {
        withHidden: false,
      });
    });

    // Review finding: the shared-library batch must be appended exactly ONCE across the paginated
    // response - repeating it on every page duplicates person ids and breaks the web People page's
    // keyed {#each} during infinite scroll. `total` still counts it on every page (the web reads the
    // total from page 1 only).
    it('should not append shared-library persons on a non-final page', async () => {
      const auth = AuthFactory.create();
      const ownPerson = PersonFactory.create();
      const sharedPerson = PersonFactory.create();

      mocks.person.getAllForUser.mockResolvedValue({ items: [ownPerson], hasNextPage: true });
      mocks.person.getNumberOfPeople.mockResolvedValue({ total: 5, hidden: 0 });
      mocks.library.getInTimelineSharedLibraryIds.mockResolvedValue([newUuid()]);
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.person.getAllForSharedLibraries.mockResolvedValue({ items: [sharedPerson], hasNextPage: false });

      await expect(sut.getAll(auth, { withHidden: false, page: 1, size: 1 })).resolves.toEqual({
        hasNextPage: true,
        total: 6,
        hidden: 0,
        people: [expect.objectContaining({ id: ownPerson.id })],
      });
    });

    it('should append shared-library persons exactly once, on the final page', async () => {
      const auth = AuthFactory.create();
      const ownPerson = PersonFactory.create();
      const sharedPerson = PersonFactory.create({ birthDate: new Date('1990-01-01'), isFavorite: true });

      mocks.person.getAllForUser.mockResolvedValue({ items: [ownPerson], hasNextPage: false });
      mocks.person.getNumberOfPeople.mockResolvedValue({ total: 5, hidden: 0 });
      mocks.library.getInTimelineSharedLibraryIds.mockResolvedValue([newUuid()]);
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.person.getAllForSharedLibraries.mockResolvedValue({ items: [sharedPerson], hasNextPage: false });

      await expect(sut.getAll(auth, { withHidden: false, page: 2, size: 1 })).resolves.toEqual({
        hasNextPage: false,
        total: 6,
        hidden: 0,
        people: [
          expect.objectContaining({ id: ownPerson.id }),
          // redacted for the non-owner
          expect.objectContaining({
            id: sharedPerson.id,
            birthDate: null,
            thumbnailPath: '',
            isHidden: false,
            isFavorite: false,
          }),
        ],
      });
    });
  });

  describe('getById', () => {
    it('should require person.read permission', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create();
      mocks.person.getById.mockResolvedValue(person);
      await expect(sut.getById(auth, person.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should throw a bad request when person is not found', async () => {
      const auth = AuthFactory.create();
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set(['unknown']));
      await expect(sut.getById(auth, 'unknown')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set(['unknown']));
    });

    it('should get a person by id', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create();

      mocks.person.getById.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));
      await expect(sut.getById(auth, person.id)).resolves.toEqual(expect.objectContaining({ id: person.id }));
      expect(mocks.person.getById).toHaveBeenCalledWith(person.id);
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should mark an owned person as isOwner without querying the rename hint', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ ownerId: auth.user.id });

      mocks.person.getById.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));

      await expect(sut.getById(auth, person.id)).resolves.toEqual(
        expect.objectContaining({ id: person.id, isOwner: true }),
      );
      expect(mocks.person.getEditorRenameLibraryId).not.toHaveBeenCalled();
    });

    it('should include the rename routing hint for a shared-library editor', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ ownerId: newUuid() });
      const libraryId = newUuid();

      mocks.person.getById.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.person.checkSharedLibraryPersonAccess.mockResolvedValue(new Set([person.id]));
      mocks.person.getEditorRenameLibraryId.mockResolvedValue(libraryId);

      await expect(sut.getById(auth, person.id)).resolves.toEqual(
        expect.objectContaining({
          id: person.id,
          isOwner: false,
          renameLibraryId: libraryId,
          birthDate: null,
          thumbnailPath: '',
        }),
      );
      expect(mocks.person.getEditorRenameLibraryId).toHaveBeenCalledWith(auth.user.id, person.id);
    });
  });

  describe('getThumbnail', () => {
    it('should require person.read permission', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create();

      mocks.person.getById.mockResolvedValue(person);
      await expect(sut.getThumbnail(auth, person.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.storage.createReadStream).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should throw an error when personId is invalid', async () => {
      const auth = AuthFactory.create();

      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set(['unknown']));
      await expect(sut.getThumbnail(auth, 'unknown')).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.storage.createReadStream).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set(['unknown']));
    });

    it('should throw an error when person has no thumbnail', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ thumbnailPath: '' });

      mocks.person.getById.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));
      await expect(sut.getThumbnail(auth, person.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.storage.createReadStream).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should serve the thumbnail', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ ownerId: auth.user.id });

      mocks.person.getById.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));
      await expect(sut.getThumbnail(auth, person.id)).resolves.toEqual(
        new ImmichFileResponse({
          path: person.thumbnailPath,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithoutCache,
        }),
      );
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should serve a non-owned person thumbnail when the feature face is in a shared library (§5.6)', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ faceAssetId: newUuid() });

      mocks.person.getById.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.person.checkSharedLibraryPersonAccess.mockResolvedValue(new Set([person.id]));
      mocks.person.isFeatureFaceInSharedLibrary.mockResolvedValue(true);

      await expect(sut.getThumbnail(auth, person.id)).resolves.toEqual(
        new ImmichFileResponse({
          path: person.thumbnailPath,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithoutCache,
        }),
      );
      expect(mocks.person.isFeatureFaceInSharedLibrary).toHaveBeenCalledWith(auth.user.id, person.faceAssetId);
    });

    it('should reject a non-owned person thumbnail when the feature face is NOT in a shared library (§5.6)', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ faceAssetId: newUuid() });

      mocks.person.getById.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.person.checkSharedLibraryPersonAccess.mockResolvedValue(new Set([person.id]));
      mocks.person.isFeatureFaceInSharedLibrary.mockResolvedValue(false);

      await expect(sut.getThumbnail(auth, person.id)).rejects.toThrow();
      expect(mocks.storage.createReadStream).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should require person.write permission', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create();

      mocks.person.getById.mockResolvedValue(person);
      await expect(sut.update(auth, person.id, { name: 'Person 1' })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.person.update).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should throw an error when personId is invalid', async () => {
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.update(authStub.admin, 'person-1', { name: 'Person 1' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.person.update).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['person-1']));
    });

    it("should update a person's name", async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ name: 'Person 1' });

      mocks.person.update.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));

      await expect(sut.update(auth, person.id, { name: 'Person 1' })).resolves.toEqual(
        expect.objectContaining({ id: person.id, name: 'Person 1' }),
      );

      expect(mocks.person.update).toHaveBeenCalledWith({ id: person.id, name: 'Person 1' });
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it("should update a person's date of birth", async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ birthDate: new Date('1976-06-30') });

      mocks.person.update.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));

      await expect(sut.update(auth, person.id, { birthDate: '1976-06-30' })).resolves.toEqual({
        id: person.id,
        name: person.name,
        birthDate: '1976-06-30',
        thumbnailPath: person.thumbnailPath,
        isHidden: false,
        isFavorite: false,
        isOwner: true,
        updatedAt: expect.any(String),
      });
      expect(mocks.person.update).toHaveBeenCalledWith({ id: person.id, birthDate: '1976-06-30' });
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should update a person visibility', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ isHidden: true });

      mocks.person.update.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));

      await expect(sut.update(auth, person.id, { isHidden: true })).resolves.toEqual(
        expect.objectContaining({ isHidden: true }),
      );

      expect(mocks.person.update).toHaveBeenCalledWith({ id: person.id, isHidden: true });
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should update a person favorite status', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ isFavorite: true });

      mocks.person.update.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));

      await expect(sut.update(auth, person.id, { isFavorite: true })).resolves.toEqual(
        expect.objectContaining({ isFavorite: true }),
      );

      expect(mocks.person.update).toHaveBeenCalledWith({ id: person.id, isFavorite: true });
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it("should update a person's thumbnailPath", async () => {
      const face = AssetFaceFactory.create();
      const auth = AuthFactory.create();
      const person = PersonFactory.create();

      mocks.person.update.mockResolvedValue(person);
      mocks.person.getForFeatureFaceUpdate.mockResolvedValue(face);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([face.assetId]));
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));

      await expect(sut.update(auth, person.id, { featureFaceAssetId: face.assetId })).resolves.toEqual(
        expect.objectContaining({ id: person.id }),
      );

      expect(mocks.person.update).toHaveBeenCalledWith({ id: person.id, faceAssetId: face.id });
      expect(mocks.person.getForFeatureFaceUpdate).toHaveBeenCalledWith({
        assetId: face.assetId,
        personId: person.id,
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.PersonGenerateThumbnail,
        data: { id: person.id },
      });
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should throw an error when the face feature assetId is invalid', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create();

      mocks.person.getById.mockResolvedValue(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));

      await expect(sut.update(auth, person.id, { featureFaceAssetId: '-1' })).rejects.toThrow(BadRequestException);
      expect(mocks.person.update).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });
  });

  describe('updateAll', () => {
    it('should throw an error when personId is invalid', async () => {
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.updateAll(authStub.admin, { people: [{ id: 'person-1', name: 'Person 1' }] })).resolves.toEqual([
        { error: BulkIdErrorReason.UNKNOWN, id: 'person-1', success: false },
      ]);
      expect(mocks.person.update).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['person-1']));
    });
  });

  describe('reassignFaces', () => {
    it('should throw an error if user has no access to the person', async () => {
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(
        sut.reassignFaces(AuthFactory.create(), 'person-id', {
          data: [{ personId: 'asset-face-1', assetId: '' }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queue).not.toHaveBeenCalledWith();
      expect(mocks.job.queueAll).not.toHaveBeenCalledWith();
    });

    it('should reassign a face', async () => {
      const face = AssetFaceFactory.create();
      const auth = AuthFactory.create();
      const person = PersonFactory.create();

      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));
      mocks.person.getById.mockResolvedValue(person);
      mocks.access.person.checkFaceOwnerAccess.mockResolvedValue(new Set([face.id]));
      mocks.person.getFacesByIds.mockResolvedValue([getForAssetFace(face)]);
      mocks.person.reassignFace.mockResolvedValue(1);
      mocks.person.getRandomFace.mockResolvedValue(AssetFaceFactory.create());
      mocks.person.refreshFaces.mockResolvedValue();
      mocks.person.reassignFace.mockResolvedValue(5);
      mocks.person.update.mockResolvedValue(person);

      await expect(
        sut.reassignFaces(auth, person.id, {
          data: [{ personId: person.id, assetId: face.assetId }],
        }),
      ).resolves.toBeDefined();

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PersonGenerateThumbnail,
          data: { id: person.id },
        },
      ]);
    });
  });

  describe('handlePersonMigration', () => {
    it('should not move person files', async () => {
      await expect(sut.handlePersonMigration(PersonFactory.create())).resolves.toBe(JobStatus.Failed);
    });
  });

  describe('getFacesById', () => {
    it('should get the bounding boxes for an asset', async () => {
      const auth = AuthFactory.create();
      const face = AssetFaceFactory.create();
      const asset = AssetFactory.from({ id: face.assetId }).exif().build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.person.getFaces.mockResolvedValue([getForAssetFace(face)]);
      mocks.asset.getForFaces.mockResolvedValue({
        ownerId: auth.user.id,
        libraryId: null,
        edits: [],
        ...asset.exifInfo,
      });
      await expect(sut.getFacesById(auth, { id: face.assetId })).resolves.toStrictEqual([
        mapFaces(getForAssetFace(face), auth),
      ]);
    });

    it('should reject if the user has not access to the asset', async () => {
      const face = AssetFaceFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.person.getFaces.mockResolvedValue([getForAssetFace(face)]);
      await expect(sut.getFacesById(AuthFactory.create(), { id: face.assetId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should keep timestampMs on a video-frame face while redacting the person for a shared-library viewer', async () => {
      const auth = AuthFactory.create();
      const ownerId = newUuid();
      const libraryId = newUuid();
      const face = AssetFaceFactory.from({ timestampMs: 4000 })
        .person({ ownerId, isHidden: false, birthDate: new Date('1990-01-01') })
        .build();
      const asset = AssetFactory.from({ id: face.assetId }).exif().build();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.person.getFaces.mockResolvedValue([getForAssetFace(face)]);
      mocks.asset.getForFaces.mockResolvedValue({
        ownerId,
        libraryId,
        edits: [],
        ...asset.exifInfo,
      });
      mocks.access.library.checkSharedAccess.mockResolvedValue(new Set([libraryId]));

      await expect(sut.getFacesById(auth, { id: face.assetId })).resolves.toStrictEqual([
        expect.objectContaining({
          timestampMs: 4000,
          person: expect.objectContaining({
            id: face.person!.id,
            birthDate: null,
            thumbnailPath: '',
            isFavorite: false,
          }),
        }),
      ]);
      expect(mocks.access.library.checkSharedAccess).toHaveBeenCalledWith(auth.user.id, new Set([libraryId]));
    });
  });

  describe('createFace', () => {
    it('should create a manual face and initialize the person feature photo creation', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.create();
      const person = PersonFactory.create({ faceAssetId: null });
      const featureFace = AssetFaceFactory.create({
        assetId: asset.id,
        personId: person.id,
        sourceType: SourceType.Manual,
      });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.person.getById.mockResolvedValue(person);
      mocks.person.getRandomFace.mockResolvedValue(featureFace);
      mocks.person.update.mockResolvedValue({ ...person, faceAssetId: featureFace.id });

      await expect(
        sut.createFace(auth, {
          assetId: asset.id,
          personId: person.id,
          imageHeight: 500,
          imageWidth: 400,
          x: 10,
          y: 20,
          width: 100,
          height: 110,
        }),
      ).resolves.toBeUndefined();

      expect(mocks.asset.getById).toHaveBeenCalledWith(asset.id, { edits: true, exifInfo: true });
      expect(mocks.person.createAssetFace).toHaveBeenCalledWith({
        assetId: asset.id,
        personId: person.id,
        imageHeight: 500,
        imageWidth: 400,
        boundingBoxX1: 10,
        boundingBoxX2: 110,
        boundingBoxY1: 20,
        boundingBoxY2: 130,
        sourceType: SourceType.Manual,
      });
      expect(mocks.person.getRandomFace).toHaveBeenCalledWith(person.id);
      expect(mocks.person.update).toHaveBeenCalledWith({ id: person.id, faceAssetId: featureFace.id });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.PersonGenerateThumbnail, data: { id: person.id } },
      ]);
    });

    it('should not update the person feature photo if one already exists', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.create();
      const person = PersonFactory.create({ faceAssetId: newUuid() });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.person.getById.mockResolvedValue(person);

      await expect(
        sut.createFace(auth, {
          assetId: asset.id,
          personId: person.id,
          imageHeight: 500,
          imageWidth: 400,
          x: 10,
          y: 20,
          width: 100,
          height: 110,
        }),
      ).resolves.toBeUndefined();

      expect(mocks.person.createAssetFace).toHaveBeenCalledOnce();
      expect(mocks.person.getRandomFace).not.toHaveBeenCalled();
      expect(mocks.person.update).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should reject creating a face on an asset the user does not own', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.create();
      const person = PersonFactory.create({ faceAssetId: null });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));

      await expect(
        sut.createFace(auth, {
          assetId: asset.id,
          personId: person.id,
          imageHeight: 500,
          imageWidth: 400,
          x: 10,
          y: 20,
          width: 100,
          height: 110,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.person.createAssetFace).not.toHaveBeenCalled();
    });

    // Review finding: createFace is a mutation (attaches a face, can set the owner's person feature
    // photo), so the personId guard must be OWNER-only - shared-library reachability (which satisfies
    // the widened PersonRead) must never be enough, even on the sharee's own asset.
    it('should reject a person the user does not own even when reachable via a shared library', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.create();
      const person = PersonFactory.create({ faceAssetId: null });

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.person.checkSharedLibraryPersonAccess.mockResolvedValue(new Set([person.id]));

      await expect(
        sut.createFace(auth, {
          assetId: asset.id,
          personId: person.id,
          imageHeight: 500,
          imageWidth: 400,
          x: 10,
          y: 20,
          width: 100,
          height: 110,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.person.createAssetFace).not.toHaveBeenCalled();
      expect(mocks.person.update).not.toHaveBeenCalled();
      // PersonUpdate routes through checkOwnerAccess only - reachability must not even be consulted.
      expect(mocks.access.person.checkSharedLibraryPersonAccess).not.toHaveBeenCalled();
    });
  });

  describe('createNewFeaturePhoto', () => {
    it('should change person feature photo', async () => {
      const person = PersonFactory.create();

      mocks.person.getRandomFace.mockResolvedValue(AssetFaceFactory.create());
      await sut.createNewFeaturePhoto([person.id]);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PersonGenerateThumbnail,
          data: { id: person.id },
        },
      ]);
    });
  });

  describe('reassignFacesById', () => {
    it('should create a new person', async () => {
      const face = AssetFaceFactory.create();
      const person = PersonFactory.create();

      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));
      mocks.access.person.checkFaceOwnerAccess.mockResolvedValue(new Set([face.id]));
      mocks.person.getFaceById.mockResolvedValue(getForAssetFace(face));
      mocks.person.reassignFace.mockResolvedValue(1);
      mocks.person.getById.mockResolvedValue(person);
      await expect(sut.reassignFacesById(AuthFactory.create(), person.id, { id: face.id })).resolves.toEqual({
        birthDate: person.birthDate,
        isHidden: person.isHidden,
        isFavorite: person.isFavorite,
        isOwner: true,
        id: person.id,
        name: person.name,
        thumbnailPath: person.thumbnailPath,
        updatedAt: expect.any(String),
      });

      expect(mocks.job.queue).not.toHaveBeenCalledWith();
      expect(mocks.job.queueAll).not.toHaveBeenCalledWith();
    });

    it('should fail if user has not the correct permissions on the asset', async () => {
      const face = AssetFaceFactory.create();
      const person = PersonFactory.create();

      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));
      mocks.person.getFaceById.mockResolvedValue(getForAssetFace(face));
      mocks.person.reassignFace.mockResolvedValue(1);
      mocks.person.getById.mockResolvedValue(person);
      await expect(
        sut.reassignFacesById(AuthFactory.create(), person.id, {
          id: face.id,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.job.queue).not.toHaveBeenCalledWith();
      expect(mocks.job.queueAll).not.toHaveBeenCalledWith();
    });
  });

  describe('createPerson', () => {
    it('should create a new person', async () => {
      const auth = AuthFactory.create();

      mocks.person.create.mockResolvedValue(PersonFactory.create());
      await expect(sut.create(auth, {})).resolves.toBeDefined();

      expect(mocks.person.create).toHaveBeenCalledWith({ ownerId: auth.user.id });
    });
  });

  describe('handlePersonCleanup', () => {
    it('should delete people without faces', async () => {
      const person = PersonFactory.create();

      mocks.person.getAllWithoutFaces.mockResolvedValue([person]);

      await sut.handlePersonCleanup();

      expect(mocks.person.delete).toHaveBeenCalledWith([person.id]);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(person.thumbnailPath);
    });
  });

  describe('handleQueueDetectFaces', () => {
    it('should skip if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await expect(sut.handleQueueDetectFaces({})).resolves.toBe(JobStatus.Skipped);
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });

    it('should queue missing assets', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.streamForDetectFacesJob.mockReturnValue(makeStream([asset]));

      await sut.handleQueueDetectFaces({ force: false });

      expect(mocks.assetJob.streamForDetectFacesJob).toHaveBeenCalledWith(false);
      expect(mocks.person.vacuum).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetDetectFaces,
          data: { id: asset.id },
        },
      ]);
    });

    it('should queue all assets', async () => {
      const asset = AssetFactory.create();
      const person = PersonFactory.create();

      mocks.assetJob.streamForDetectFacesJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAllWithoutFaces.mockResolvedValue([person]);

      await sut.handleQueueDetectFaces({ force: true });

      expect(mocks.person.deleteFaces).toHaveBeenCalledWith({ sourceType: SourceType.MachineLearning });
      expect(mocks.person.delete).toHaveBeenCalledWith([person.id]);
      expect(mocks.person.vacuum).toHaveBeenCalledWith({ reindexVectors: true });
      expect(mocks.storage.unlink).toHaveBeenCalledWith(person.thumbnailPath);
      expect(mocks.assetJob.streamForDetectFacesJob).toHaveBeenCalledWith(true);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetDetectFaces,
          data: { id: asset.id },
        },
      ]);
    });

    it('should refresh all assets', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.streamForDetectFacesJob.mockReturnValue(makeStream([asset]));

      await sut.handleQueueDetectFaces({ force: undefined });

      expect(mocks.person.delete).not.toHaveBeenCalled();
      expect(mocks.person.deleteFaces).not.toHaveBeenCalled();
      expect(mocks.person.vacuum).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
      expect(mocks.assetJob.streamForDetectFacesJob).toHaveBeenCalledWith(undefined);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetDetectFaces,
          data: { id: asset.id },
        },
      ]);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.PersonCleanup });
    });

    it('should delete existing people and faces if forced', async () => {
      const asset = AssetFactory.create();
      const face = AssetFaceFactory.from().person().build();
      const person = PersonFactory.create();

      mocks.person.getAll.mockReturnValue(makeStream([face.person!, person]));
      mocks.person.getAllFaces.mockReturnValue(makeStream([face]));
      mocks.assetJob.streamForDetectFacesJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAllWithoutFaces.mockResolvedValue([person]);
      mocks.person.deleteFaces.mockResolvedValue();

      await sut.handleQueueDetectFaces({ force: true });

      expect(mocks.assetJob.streamForDetectFacesJob).toHaveBeenCalledWith(true);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetDetectFaces,
          data: { id: asset.id },
        },
      ]);
      expect(mocks.person.delete).toHaveBeenCalledWith([person.id]);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(person.thumbnailPath);
      expect(mocks.person.vacuum).toHaveBeenCalledWith({ reindexVectors: true });
    });
  });

  describe('handleQueueRecognizeFaces', () => {
    it('should skip if machine learning is disabled', async () => {
      mocks.job.getJobCounts.mockResolvedValue({
        active: 1,
        waiting: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      });
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await expect(sut.handleQueueRecognizeFaces({})).resolves.toBe(JobStatus.Skipped);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.get).toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should skip if recognition jobs are already queued', async () => {
      mocks.job.getJobCounts.mockResolvedValue({
        active: 1,
        waiting: 1,
        paused: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      });

      await expect(sut.handleQueueRecognizeFaces({})).resolves.toBe(JobStatus.Skipped);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should queue missing assets', async () => {
      const face = AssetFaceFactory.create();
      mocks.job.getJobCounts.mockResolvedValue({
        active: 1,
        waiting: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      });
      mocks.person.getAllFaces.mockReturnValue(makeStream([face]));
      mocks.person.getAllWithoutFaces.mockResolvedValue([]);

      await sut.handleQueueRecognizeFaces({});

      expect(mocks.person.getAllFaces).toHaveBeenCalledWith({
        personId: null,
        sourceType: SourceType.MachineLearning,
      });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.FacialRecognition,
          data: { id: face.id, deferred: false },
        },
      ]);
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.FacialRecognitionState, {
        lastRun: expect.any(String),
      });
      expect(mocks.person.vacuum).not.toHaveBeenCalled();
    });

    it('should queue all assets', async () => {
      const face = AssetFaceFactory.create();
      mocks.job.getJobCounts.mockResolvedValue({
        active: 1,
        waiting: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      });
      mocks.person.getAll.mockReturnValue(makeStream());
      mocks.person.getAllFaces.mockReturnValue(makeStream([face]));
      mocks.person.getAllWithoutFaces.mockResolvedValue([]);

      await sut.handleQueueRecognizeFaces({ force: true });

      expect(mocks.person.getAllFaces).toHaveBeenCalledWith(undefined);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.FacialRecognition,
          data: { id: face.id, deferred: false },
        },
      ]);
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.FacialRecognitionState, {
        lastRun: expect.any(String),
      });
      expect(mocks.person.vacuum).toHaveBeenCalledWith({ reindexVectors: false });
    });

    it('should run nightly if new face has been added since last run', async () => {
      const face = AssetFaceFactory.create();
      mocks.person.getLatestFaceDate.mockResolvedValue(new Date().toISOString());
      mocks.person.getAllFaces.mockReturnValue(makeStream([face]));
      mocks.job.getJobCounts.mockResolvedValue({
        active: 1,
        waiting: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      });
      mocks.person.getAll.mockReturnValue(makeStream());
      mocks.person.getAllFaces.mockReturnValue(makeStream([face]));
      mocks.person.getAllWithoutFaces.mockResolvedValue([]);
      mocks.person.unassignFaces.mockResolvedValue();

      await sut.handleQueueRecognizeFaces({ force: false, nightly: true });

      expect(mocks.systemMetadata.get).toHaveBeenCalledWith(SystemMetadataKey.FacialRecognitionState);
      expect(mocks.person.getLatestFaceDate).toHaveBeenCalledOnce();
      expect(mocks.person.getAllFaces).toHaveBeenCalledWith({
        personId: null,
        sourceType: SourceType.MachineLearning,
      });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.FacialRecognition,
          data: { id: face.id, deferred: false },
        },
      ]);
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.FacialRecognitionState, {
        lastRun: expect.any(String),
      });
      expect(mocks.person.vacuum).not.toHaveBeenCalled();
    });

    it('should skip nightly if no new face has been added since last run', async () => {
      const lastRun = new Date();

      mocks.systemMetadata.get.mockResolvedValue({ lastRun: lastRun.toISOString() });
      mocks.person.getLatestFaceDate.mockResolvedValue(new Date(lastRun.getTime() - 1).toISOString());
      mocks.person.getAllFaces.mockReturnValue(makeStream([AssetFaceFactory.create()]));
      mocks.person.getAllWithoutFaces.mockResolvedValue([]);

      await sut.handleQueueRecognizeFaces({ force: true, nightly: true });

      expect(mocks.systemMetadata.get).toHaveBeenCalledWith(SystemMetadataKey.FacialRecognitionState);
      expect(mocks.person.getLatestFaceDate).toHaveBeenCalledOnce();
      expect(mocks.person.getAllFaces).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.person.vacuum).not.toHaveBeenCalled();
    });

    it('should delete existing people if forced', async () => {
      const face = AssetFaceFactory.from().person().build();
      const person = PersonFactory.create();

      mocks.job.getJobCounts.mockResolvedValue({
        active: 1,
        waiting: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      });
      mocks.person.getAll.mockReturnValue(makeStream([face.person!, person]));
      mocks.person.getAllFaces.mockReturnValue(makeStream([face]));
      mocks.person.getAllWithoutFaces.mockResolvedValue([person]);
      mocks.person.unassignFaces.mockResolvedValue();

      await sut.handleQueueRecognizeFaces({ force: true });

      expect(mocks.person.deleteFaces).not.toHaveBeenCalled();
      expect(mocks.person.unassignFaces).toHaveBeenCalledWith({ sourceType: SourceType.MachineLearning });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.FacialRecognition,
          data: { id: face.id, deferred: false },
        },
      ]);
      expect(mocks.person.delete).toHaveBeenCalledWith([person.id]);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(person.thumbnailPath);
      expect(mocks.person.vacuum).toHaveBeenCalledWith({ reindexVectors: false });
    });
  });

  describe('handleDetectFaces', () => {
    it('should skip if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await expect(sut.handleDetectFaces({ id: 'foo' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.asset.getByIds).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });

    it('should skip when no resize path', async () => {
      const asset = AssetFactory.from().exif().build();
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      await sut.handleDetectFaces({ id: asset.id });
      expect(mocks.machineLearning.detectFaces).not.toHaveBeenCalled();
    });

    it('should handle no results', async () => {
      const start = Date.now();
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();

      mocks.machineLearning.detectFaces.mockResolvedValue({ imageHeight: 500, imageWidth: 400, faces: [] });
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      await sut.handleDetectFaces({ id: asset.id });
      expect(mocks.machineLearning.detectFaces).toHaveBeenCalledWith(
        asset.files[0].path,
        expect.objectContaining({ minScore: 0.7, modelName: 'buffalo_l' }),
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();

      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: asset.id,
        facesRecognizedAt: expect.any(Date),
      });
      const facesRecognizedAt = mocks.asset.upsertJobStatus.mock.calls[0][0].facesRecognizedAt as Date;
      expect(facesRecognizedAt.getTime()).toBeGreaterThan(start);
    });

    it('should create a face with no person and queue recognition job', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      const face = AssetFaceFactory.create({ assetId: asset.id });
      mocks.crypto.randomUUID.mockReturnValue(face.id);
      mocks.machineLearning.detectFaces.mockResolvedValue(getAsDetectedFace(face));
      mocks.search.searchFaces.mockResolvedValue([{ ...face, distance: 0.7 }]);
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      mocks.person.refreshFaces.mockResolvedValue();

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
        [expect.objectContaining({ id: face.id, assetId: asset.id })],
        [],
        [{ faceId: face.id, embedding: '[1, 2, 3, 4]' }],
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
        { name: JobName.FacialRecognition, data: { id: face.id } },
      ]);
      expect(mocks.person.reassignFace).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    });

    it('should delete an existing face not among the new detected faces', async () => {
      const asset = AssetFactory.from().face().file({ type: AssetFileType.Preview }).exif().build();
      mocks.machineLearning.detectFaces.mockResolvedValue({ faces: [], imageHeight: 500, imageWidth: 400 });
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.person.refreshFaces).toHaveBeenCalledWith([], [asset.faces[0].id], []);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.person.reassignFace).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    });

    it('should not delete video-frame faces when re-detecting preview faces', async () => {
      // The video-frame face (timestampMs set) never matches preview detections, but it belongs to
      // the video pipeline and must not be swept by the preview-based stale-face removal.
      const asset = AssetFactory.from({ type: AssetType.Video })
        .face()
        .face({ timestampMs: 4000 })
        .file({ type: AssetFileType.Preview })
        .exif()
        .build();
      mocks.machineLearning.detectFaces.mockResolvedValue({ faces: [], imageHeight: 500, imageWidth: 400 });
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));

      await sut.handleDetectFaces({ id: asset.id });

      const previewFace = asset.faces.find((face) => face.timestampMs === null);
      expect(mocks.person.refreshFaces).toHaveBeenCalledWith([], [previewFace!.id], []);
    });

    it('should add new face and delete an existing face not among the new detected faces', async () => {
      const assetId = newUuid();
      const face = AssetFaceFactory.create({
        assetId,
        boundingBoxX1: 200,
        boundingBoxX2: 300,
        boundingBoxY1: 200,
        boundingBoxY2: 300,
      });
      const asset = AssetFactory.from({ id: assetId }).face().file({ type: AssetFileType.Preview }).exif().build();
      mocks.machineLearning.detectFaces.mockResolvedValue(getAsDetectedFace(face));
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      mocks.crypto.randomUUID.mockReturnValue(face.id);
      mocks.person.refreshFaces.mockResolvedValue();

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
        [expect.objectContaining({ id: face.id, assetId: asset.id })],
        [asset.faces[0].id],
        [{ faceId: face.id, embedding: '[1, 2, 3, 4]' }],
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
        { name: JobName.FacialRecognition, data: { id: face.id } },
      ]);
      expect(mocks.person.reassignFace).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    });

    it('should add embedding to matching metadata face', async () => {
      const face = AssetFaceFactory.create({ sourceType: SourceType.Exif });
      const asset = AssetFactory.from().face(face).file({ type: AssetFileType.Preview }).exif().build();
      mocks.machineLearning.detectFaces.mockResolvedValue(getAsDetectedFace(face));
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      mocks.person.refreshFaces.mockResolvedValue();

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.person.refreshFaces).toHaveBeenCalledWith([], [], [{ faceId: face.id, embedding: '[1, 2, 3, 4]' }]);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.person.reassignFace).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    });

    it('should not add embedding to non-matching metadata face', async () => {
      const assetId = newUuid();
      const face = AssetFaceFactory.create({ assetId, sourceType: SourceType.Exif });
      const asset = AssetFactory.from({ id: assetId }).file({ type: AssetFileType.Preview }).exif().build();
      mocks.machineLearning.detectFaces.mockResolvedValue(getAsDetectedFace(face));
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      mocks.crypto.randomUUID.mockReturnValue(face.id);

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
        [expect.objectContaining({ id: face.id, assetId: asset.id })],
        [],
        [{ faceId: face.id, embedding: '[1, 2, 3, 4]' }],
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
        { name: JobName.FacialRecognition, data: { id: face.id } },
      ]);
      expect(mocks.person.reassignFace).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    });
  });

  describe('handleDetectFaces — video queue trigger', () => {
    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { videoEnabled: true } } });
    });

    it('should queue video face detection for video assets', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video }).file({ type: AssetFileType.Preview }).exif().build();
      mocks.machineLearning.detectFaces.mockResolvedValue({ imageHeight: 500, imageWidth: 400, faces: [] });
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetVideoDetectFaces, data: { id: asset.id } });
    });

    it('should not queue video face detection by default (opt-in)', async () => {
      mocks.systemMetadata.get.mockResolvedValue({});
      const asset = AssetFactory.from({ type: AssetType.Video }).file({ type: AssetFileType.Preview }).exif().build();
      mocks.machineLearning.detectFaces.mockResolvedValue({ imageHeight: 500, imageWidth: 400, faces: [] });
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.job.queue).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: JobName.AssetVideoDetectFaces }),
      );
    });

    it('should not queue video face detection when video face detection is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { videoEnabled: false } } });
      const asset = AssetFactory.from({ type: AssetType.Video }).file({ type: AssetFileType.Preview }).exif().build();
      mocks.machineLearning.detectFaces.mockResolvedValue({ imageHeight: 500, imageWidth: 400, faces: [] });
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.job.queue).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: JobName.AssetVideoDetectFaces }),
      );
    });

    it('should not queue video face detection for image assets', async () => {
      const asset = AssetFactory.from({ type: AssetType.Image }).file({ type: AssetFileType.Preview }).exif().build();
      mocks.machineLearning.detectFaces.mockResolvedValue({ imageHeight: 500, imageWidth: 400, faces: [] });
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.job.queue).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: JobName.AssetVideoDetectFaces }),
      );
    });
  });

  describe('handleQueueVideoDetectFaces', () => {
    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { videoEnabled: true } } });
    });

    it('should skip if facial recognition is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await expect(sut.handleQueueVideoDetectFaces({})).resolves.toBe(JobStatus.Skipped);
      expect(mocks.assetJob.streamForVideoDetectFacesJob).not.toHaveBeenCalled();
    });

    it('should skip if video face detection is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { videoEnabled: false } } });

      await expect(sut.handleQueueVideoDetectFaces({})).resolves.toBe(JobStatus.Skipped);
      expect(mocks.assetJob.streamForVideoDetectFacesJob).not.toHaveBeenCalled();
    });

    it('should queue video assets that need processing', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.streamForVideoDetectFacesJob.mockReturnValue(makeStream([asset]));

      await sut.handleQueueVideoDetectFaces({ force: false });

      expect(mocks.assetJob.streamForVideoDetectFacesJob).toHaveBeenCalledWith(false);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetVideoDetectFaces, data: { id: asset.id } },
      ]);
    });
  });

  describe('handleVideoDetectFaces', () => {
    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { videoEnabled: true } } });
      mocks.person.getVideoFaceIds.mockResolvedValue([]);
      mocks.person.getPersonIdsByFaceAssetIds.mockResolvedValue([]);
    });

    it('should skip if facial recognition is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await expect(sut.handleVideoDetectFaces({ id: 'foo' })).resolves.toBe(JobStatus.Skipped);
    });

    it('should skip if video face detection is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { videoEnabled: false } } });

      await expect(sut.handleVideoDetectFaces({ id: 'foo' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.media.extractVideoFrames).not.toHaveBeenCalled();
    });

    it('should fail if asset not found', async () => {
      mocks.assetJob.getForVideoDetectFacesJob.mockResolvedValue(void 0);

      await expect(sut.handleVideoDetectFaces({ id: 'foo' })).resolves.toBe(JobStatus.Failed);
    });

    it('should skip hidden assets', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, visibility: 'hidden' as any }).build();
      mocks.assetJob.getForVideoDetectFacesJob.mockResolvedValue({
        id: asset.id,
        originalPath: '/videos/test.mp4',
        visibility: 'hidden' as any,
      });

      await expect(sut.handleVideoDetectFaces({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.media.extractVideoFrames).not.toHaveBeenCalled();
    });

    it('should succeed with no frames extracted', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video }).build();
      mocks.assetJob.getForVideoDetectFacesJob.mockResolvedValue({
        id: asset.id,
        originalPath: '/videos/test.mp4',
        visibility: asset.visibility,
      });
      mocks.storage.createTempDir.mockResolvedValue('/tmp/test-frames');
      mocks.media.extractVideoFrames.mockResolvedValue([]);

      await expect(sut.handleVideoDetectFaces({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.storage.unlinkDir).toHaveBeenCalledWith('/tmp/test-frames', { recursive: true, force: true });
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: asset.id,
        videoFacesRecognizedAt: expect.any(Date),
      });
    });

    it('should detect faces across frames and queue recognition', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video }).build();
      const face = AssetFaceFactory.create({ assetId: asset.id });

      mocks.assetJob.getForVideoDetectFacesJob.mockResolvedValue({
        id: asset.id,
        originalPath: '/videos/test.mp4',
        visibility: asset.visibility,
      });
      mocks.storage.createTempDir.mockResolvedValue('/tmp/test-frames');
      mocks.media.extractVideoFrames.mockResolvedValue([
        { path: '/tmp/test-frames/frame_0001.jpg', timestampMs: 0 },
        { path: '/tmp/test-frames/frame_0002.jpg', timestampMs: 2000 },
      ]);
      mocks.machineLearning.detectFaces
        .mockResolvedValueOnce({
          imageHeight: 500,
          imageWidth: 400,
          faces: [{ boundingBox: { x1: 10, y1: 10, x2: 50, y2: 50 }, embedding: '[1,2,3]', score: 0.9 }],
        })
        .mockResolvedValueOnce({ imageHeight: 500, imageWidth: 400, faces: [] });
      mocks.crypto.randomUUID.mockReturnValue(face.id);
      mocks.person.refreshFaces.mockResolvedValue();

      await expect(sut.handleVideoDetectFaces({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.detectFaces).toHaveBeenCalledTimes(2);
      expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
        [expect.objectContaining({ assetId: asset.id, timestampMs: 0 })],
        [],
        [{ faceId: face.id, embedding: '[1,2,3]' }],
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetVideoClusterFaces, data: { id: asset.id } });
      expect(mocks.storage.unlinkDir).toHaveBeenCalledWith('/tmp/test-frames', { recursive: true, force: true });
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: asset.id,
        videoFacesRecognizedAt: expect.any(Date),
      });
    });

    it('should set correct timestampMs per frame', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video }).build();
      mocks.assetJob.getForVideoDetectFacesJob.mockResolvedValue({
        id: asset.id,
        originalPath: '/videos/test.mp4',
        visibility: asset.visibility,
      });
      mocks.storage.createTempDir.mockResolvedValue('/tmp/test-frames');
      mocks.media.extractVideoFrames.mockResolvedValue([
        { path: '/tmp/test-frames/frame_0001.jpg', timestampMs: 0 },
        { path: '/tmp/test-frames/frame_0002.jpg', timestampMs: 2000 },
        { path: '/tmp/test-frames/frame_0003.jpg', timestampMs: 4000 },
      ]);
      const faceResult = {
        imageHeight: 100,
        imageWidth: 100,
        faces: [{ boundingBox: { x1: 0, y1: 0, x2: 10, y2: 10 }, embedding: '[1]', score: 0.9 }],
      };
      mocks.machineLearning.detectFaces.mockResolvedValue(faceResult);
      mocks.crypto.randomUUID.mockReturnValue(newUuid());
      mocks.person.refreshFaces.mockResolvedValue();

      await sut.handleVideoDetectFaces({ id: asset.id });

      const addedFaces = mocks.person.refreshFaces.mock.calls[0][0] as Array<{ timestampMs: number }>;
      // default videoFrameInterval is 2s
      expect(addedFaces[0].timestampMs).toBe(0);
      expect(addedFaces[1].timestampMs).toBe(2000);
      expect(addedFaces[2].timestampMs).toBe(4000);
    });

    it('should stamp faces with the exact timestamps reported by frame extraction', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video }).build();
      mocks.assetJob.getForVideoDetectFacesJob.mockResolvedValue({
        id: asset.id,
        originalPath: '/videos/test.mp4',
        visibility: asset.visibility,
      });
      mocks.storage.createTempDir.mockResolvedValue('/tmp/test-frames');
      // The frame cap widened the sampling to 3s spacing even though videoFrameInterval defaults to 2s.
      mocks.media.extractVideoFrames.mockResolvedValue([
        { path: '/tmp/test-frames/frame_0001.jpg', timestampMs: 0 },
        { path: '/tmp/test-frames/frame_0002.jpg', timestampMs: 3000 },
        { path: '/tmp/test-frames/frame_0003.jpg', timestampMs: 6000 },
      ]);
      mocks.machineLearning.detectFaces.mockResolvedValue({
        imageHeight: 100,
        imageWidth: 100,
        faces: [{ boundingBox: { x1: 0, y1: 0, x2: 10, y2: 10 }, embedding: '[1]', score: 0.9 }],
      });
      mocks.crypto.randomUUID.mockReturnValue(newUuid());
      mocks.person.refreshFaces.mockResolvedValue();

      await sut.handleVideoDetectFaces({ id: asset.id });

      const addedFaces = mocks.person.refreshFaces.mock.calls[0][0] as Array<{ timestampMs: number }>;
      expect(addedFaces.map((f) => f.timestampMs)).toEqual([0, 3000, 6000]);
    });

    it('should remove faces from a previous run before adding new ones', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video }).build();
      const newFace = AssetFaceFactory.create({ assetId: asset.id });
      mocks.assetJob.getForVideoDetectFacesJob.mockResolvedValue({
        id: asset.id,
        originalPath: '/videos/test.mp4',
        visibility: asset.visibility,
      });
      mocks.storage.createTempDir.mockResolvedValue('/tmp/test-frames');
      mocks.media.extractVideoFrames.mockResolvedValue([{ path: '/tmp/test-frames/frame_0001.jpg', timestampMs: 0 }]);
      mocks.person.getVideoFaceIds.mockResolvedValue([{ id: 'stale-1' }, { id: 'stale-2' }] as any);
      mocks.machineLearning.detectFaces.mockResolvedValue({
        imageHeight: 100,
        imageWidth: 100,
        faces: [{ boundingBox: { x1: 0, y1: 0, x2: 10, y2: 10 }, embedding: '[1]', score: 0.9 }],
      });
      mocks.crypto.randomUUID.mockReturnValue(newFace.id);
      mocks.person.refreshFaces.mockResolvedValue();

      await sut.handleVideoDetectFaces({ id: asset.id });

      expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
        [expect.objectContaining({ id: newFace.id })],
        ['stale-1', 'stale-2'],
        [{ faceId: newFace.id, embedding: '[1]' }],
      );
    });

    it('should re-pick a feature photo for people anchored to a removed stale face', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video }).build();
      const newFace = AssetFaceFactory.create({ assetId: asset.id });
      const replacementFace = AssetFaceFactory.create({ assetId: asset.id });
      mocks.assetJob.getForVideoDetectFacesJob.mockResolvedValue({
        id: asset.id,
        originalPath: '/videos/test.mp4',
        visibility: asset.visibility,
      });
      mocks.storage.createTempDir.mockResolvedValue('/tmp/test-frames');
      mocks.media.extractVideoFrames.mockResolvedValue([{ path: '/tmp/test-frames/frame_0001.jpg', timestampMs: 0 }]);
      mocks.person.getVideoFaceIds.mockResolvedValue([{ id: 'stale-1' }] as any);
      // 'stale-1' anchors person-1's feature photo; deleting it nulls person.faceAssetId
      mocks.person.getPersonIdsByFaceAssetIds.mockResolvedValue([{ id: 'person-1' }] as any);
      mocks.person.getRandomFace.mockResolvedValue(replacementFace);
      mocks.machineLearning.detectFaces.mockResolvedValue({
        imageHeight: 100,
        imageWidth: 100,
        faces: [{ boundingBox: { x1: 0, y1: 0, x2: 10, y2: 10 }, embedding: '[1]', score: 0.9 }],
      });
      mocks.crypto.randomUUID.mockReturnValue(newFace.id);
      mocks.person.refreshFaces.mockResolvedValue();

      await sut.handleVideoDetectFaces({ id: asset.id });

      expect(mocks.person.getPersonIdsByFaceAssetIds).toHaveBeenCalledWith(['stale-1']);
      expect(mocks.person.update).toHaveBeenCalledWith({ id: 'person-1', faceAssetId: replacementFace.id });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.PersonGenerateThumbnail, data: { id: 'person-1' } },
      ]);
    });

    it('should keep faces from successful frames when one frame fails detection', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video }).build();
      const face = AssetFaceFactory.create({ assetId: asset.id });
      mocks.assetJob.getForVideoDetectFacesJob.mockResolvedValue({
        id: asset.id,
        originalPath: '/videos/test.mp4',
        visibility: asset.visibility,
      });
      mocks.storage.createTempDir.mockResolvedValue('/tmp/test-frames');
      mocks.media.extractVideoFrames.mockResolvedValue([
        { path: '/tmp/test-frames/frame_0001.jpg', timestampMs: 0 },
        { path: '/tmp/test-frames/frame_0002.jpg', timestampMs: 2000 },
      ]);
      mocks.machineLearning.detectFaces.mockRejectedValueOnce(new Error('ML hiccup')).mockResolvedValueOnce({
        imageHeight: 100,
        imageWidth: 100,
        faces: [{ boundingBox: { x1: 0, y1: 0, x2: 10, y2: 10 }, embedding: '[1]', score: 0.9 }],
      });
      mocks.crypto.randomUUID.mockReturnValue(face.id);
      mocks.person.refreshFaces.mockResolvedValue();

      await expect(sut.handleVideoDetectFaces({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
        [expect.objectContaining({ id: face.id, timestampMs: 2000 })],
        [],
        [{ faceId: face.id, embedding: '[1]' }],
      );
    });

    it('should clean up temp dir even if detection fails', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video }).build();
      mocks.assetJob.getForVideoDetectFacesJob.mockResolvedValue({
        id: asset.id,
        originalPath: '/videos/test.mp4',
        visibility: asset.visibility,
      });
      mocks.storage.createTempDir.mockResolvedValue('/tmp/test-frames');
      mocks.media.extractVideoFrames.mockResolvedValue([{ path: '/tmp/test-frames/frame_0001.jpg', timestampMs: 0 }]);
      mocks.machineLearning.detectFaces.mockRejectedValue(new Error('ML error'));

      await expect(sut.handleVideoDetectFaces({ id: asset.id })).rejects.toThrow('ML error');
      expect(mocks.storage.unlinkDir).toHaveBeenCalledWith('/tmp/test-frames', { recursive: true, force: true });
    });
  });

  describe('handleVideoClusterFaces', () => {
    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { videoEnabled: true } } });
      mocks.person.getPersonIdsByFaceAssetIds.mockResolvedValue([]);
    });

    it('should skip if facial recognition is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await expect(sut.handleVideoClusterFaces({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.person.getVideoFacesWithEmbeddings).not.toHaveBeenCalled();
    });

    it('should skip if video face detection is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { videoEnabled: false } } });

      await expect(sut.handleVideoClusterFaces({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.person.getVideoFacesWithEmbeddings).not.toHaveBeenCalled();
    });

    it('should succeed with no faces', async () => {
      mocks.person.getVideoFacesWithEmbeddings.mockResolvedValue([]);

      await expect(sut.handleVideoClusterFaces({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);
      expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should queue recognition for a single face without clustering', async () => {
      const face = makeFace('face-1', 10, 10, 50, 50, [1, 0, 0]);
      mocks.person.getVideoFacesWithEmbeddings.mockResolvedValue([face]);

      await expect(sut.handleVideoClusterFaces({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);
      expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
        { name: JobName.FacialRecognition, data: { id: 'face-1' } },
      ]);
    });

    it('should keep distinct faces and remove duplicates', async () => {
      // face-1 and face-2 are very similar (same person), face-3 is different
      const faceA1 = makeFace('face-1', 10, 10, 60, 60, [1, 0, 0]); // area 0.25, person A
      const faceA2 = makeFace('face-2', 10, 10, 40, 40, [0.99, 0.01, 0]); // area 0.09, person A (duplicate)
      const faceB = makeFace('face-3', 10, 10, 50, 50, [0, 1, 0]); // area 0.16, person B

      mocks.person.getVideoFacesWithEmbeddings.mockResolvedValue([faceA1, faceA2, faceB]);
      mocks.person.refreshFaces.mockResolvedValue();

      await expect(sut.handleVideoClusterFaces({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      // face-2 is the duplicate — same cluster as face-1 (largest area representative)
      expect(mocks.person.refreshFaces).toHaveBeenCalledWith([], ['face-2'], []);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
        { name: JobName.FacialRecognition, data: { id: 'face-1' } },
        { name: JobName.FacialRecognition, data: { id: 'face-3' } },
      ]);
    });

    it('should keep all faces when all are distinct', async () => {
      const faceA = makeFace('face-1', 0, 0, 50, 50, [1, 0, 0]);
      const faceB = makeFace('face-2', 0, 0, 50, 50, [0, 1, 0]);
      const faceC = makeFace('face-3', 0, 0, 50, 50, [0, 0, 1]);

      mocks.person.getVideoFacesWithEmbeddings.mockResolvedValue([faceA, faceB, faceC]);
      mocks.person.refreshFaces.mockResolvedValue();

      await expect(sut.handleVideoClusterFaces({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
        { name: JobName.FacialRecognition, data: { id: 'face-1' } },
        { name: JobName.FacialRecognition, data: { id: 'face-2' } },
        { name: JobName.FacialRecognition, data: { id: 'face-3' } },
      ]);
    });

    it('should pick the largest face as cluster representative', async () => {
      // face-2 has larger area but face-1 comes first in array — sorted by area descending
      const faceSmall = makeFace('face-1', 10, 10, 20, 20, [1, 0, 0]); // area 0.01
      const faceLarge = makeFace('face-2', 10, 10, 80, 80, [0.99, 0.01, 0]); // area 0.49, same cluster

      mocks.person.getVideoFacesWithEmbeddings.mockResolvedValue([faceSmall, faceLarge]);
      mocks.person.refreshFaces.mockResolvedValue();

      await expect(sut.handleVideoClusterFaces({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      // face-2 (larger) is kept, face-1 (smaller) is removed
      expect(mocks.person.refreshFaces).toHaveBeenCalledWith([], ['face-1'], []);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
        { name: JobName.FacialRecognition, data: { id: 'face-2' } },
      ]);
    });

    it('should never remove the thumbnail face even when a video face is larger, and not re-queue it', async () => {
      // The thumbnail face (null timestamp) is smaller than the duplicate video face, but it anchors
      // person.faceAssetId and must survive; the video duplicate must be the one removed instead.
      const thumbnail = makeFace('thumb', 10, 10, 30, 30, [1, 0, 0], null); // area 0.04, no timestamp
      const videoDuplicate = makeFace('vid-1', 10, 10, 80, 80, [0.99, 0.01, 0]); // area 0.49, same person
      const videoDistinct = makeFace('vid-2', 10, 10, 50, 50, [0, 1, 0]); // different person

      mocks.person.getVideoFacesWithEmbeddings.mockResolvedValue([videoDuplicate, thumbnail, videoDistinct]);
      mocks.person.refreshFaces.mockResolvedValue();

      await expect(sut.handleVideoClusterFaces({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      // The video duplicate is removed; the thumbnail face is preserved.
      expect(mocks.person.refreshFaces).toHaveBeenCalledWith([], ['vid-1'], []);
      // Only the surviving video face is re-queued for recognition — the thumbnail face is not.
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
        { name: JobName.FacialRecognition, data: { id: 'vid-2' } },
      ]);
    });

    it('should re-pick a feature photo for people anchored to a removed duplicate face', async () => {
      const replacementFace = AssetFaceFactory.create();
      const faceLarge = makeFace('face-1', 10, 10, 80, 80, [1, 0, 0]);
      const faceSmall = makeFace('face-2', 10, 10, 30, 30, [0.99, 0.01, 0]); // duplicate, anchors person-1

      mocks.person.getVideoFacesWithEmbeddings.mockResolvedValue([faceLarge, faceSmall]);
      mocks.person.getPersonIdsByFaceAssetIds.mockResolvedValue([{ id: 'person-1' }] as any);
      mocks.person.getRandomFace.mockResolvedValue(replacementFace);
      mocks.person.refreshFaces.mockResolvedValue();

      await expect(sut.handleVideoClusterFaces({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.person.getPersonIdsByFaceAssetIds).toHaveBeenCalledWith(['face-2']);
      expect(mocks.person.update).toHaveBeenCalledWith({ id: 'person-1', faceAssetId: replacementFace.id });
    });

    it('should keep every thumbnail face when a preview contains multiple people', async () => {
      // Two people detected in the preview frame (two null-timestamp faces); each has a video
      // duplicate. Both thumbnail faces must survive; both video duplicates are removed.
      const thumbA = makeFace('thumb-a', 0, 0, 30, 30, [1, 0, 0], null);
      const thumbB = makeFace('thumb-b', 40, 40, 70, 70, [0, 1, 0], null);
      const videoA = makeFace('vid-a', 0, 0, 80, 80, [0.99, 0.01, 0]); // duplicate of thumbA
      const videoB = makeFace('vid-b', 40, 40, 90, 90, [0.01, 0.99, 0]); // duplicate of thumbB

      mocks.person.getVideoFacesWithEmbeddings.mockResolvedValue([videoA, thumbA, videoB, thumbB]);
      mocks.person.refreshFaces.mockResolvedValue();

      await expect(sut.handleVideoClusterFaces({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.person.refreshFaces).toHaveBeenCalledWith([], ['vid-a', 'vid-b'], []);
      // Both thumbnail faces survive and neither is re-queued for recognition.
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
      ]);
    });
  });

  describe('handleRecognizeFaces', () => {
    it('should fail if face does not exist', async () => {
      expect(await sut.handleRecognizeFaces({ id: 'unknown-face' })).toBe(JobStatus.Failed);

      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
      expect(mocks.person.create).not.toHaveBeenCalled();
    });

    it('should fail if face does not have asset', async () => {
      const face = AssetFaceFactory.create();
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(face, null));

      expect(await sut.handleRecognizeFaces({ id: face.id })).toBe(JobStatus.Failed);

      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
      expect(mocks.person.create).not.toHaveBeenCalled();
    });

    it('should skip if face already has an assigned person', async () => {
      const asset = AssetFactory.create();
      const face = AssetFaceFactory.from({ assetId: asset.id }).person().build();
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(face, asset));

      expect(await sut.handleRecognizeFaces({ id: face.id })).toBe(JobStatus.Skipped);

      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
      expect(mocks.person.create).not.toHaveBeenCalled();
    });

    it('should match existing person', async () => {
      const asset = AssetFactory.create();

      const [noPerson1, noPerson2, primaryFace, face] = [
        AssetFaceFactory.create({ assetId: asset.id }),
        AssetFaceFactory.create(),
        AssetFaceFactory.from().person().build(),
        AssetFaceFactory.from().person().build(),
      ];

      const faces = [
        { ...noPerson1, distance: 0 },
        { ...primaryFace, distance: 0.2 },
        { ...noPerson2, distance: 0.3 },
        { ...face, distance: 0.4 },
      ] as FaceSearchResult[];

      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { minFaces: 1 } } });
      mocks.search.searchFaces.mockResolvedValue(faces);
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(noPerson1, asset));
      mocks.person.create.mockResolvedValue(primaryFace.person!);

      await sut.handleRecognizeFaces({ id: noPerson1.id });

      expect(mocks.person.create).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).toHaveBeenCalledTimes(1);
      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        faceIds: expect.arrayContaining([noPerson1.id]),
        newPersonId: primaryFace.person!.id,
      });
      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        faceIds: expect.not.arrayContaining([face.id]),
        newPersonId: primaryFace.person!.id,
      });
    });

    it('should match existing person if their birth date is unknown', async () => {
      const asset = AssetFactory.create();
      const [noPerson, face, faceWithBirthDate] = [
        AssetFaceFactory.create({ assetId: asset.id }),
        AssetFaceFactory.from().person().build(),
        AssetFaceFactory.from().person({ birthDate: newDate() }).build(),
      ];

      const faces = [
        { ...noPerson, distance: 0 },
        { ...face, distance: 0.2 },
        { ...faceWithBirthDate, distance: 0.3 },
      ] as FaceSearchResult[];

      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { minFaces: 1 } } });
      mocks.search.searchFaces.mockResolvedValue(faces);
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(noPerson, asset));
      mocks.person.create.mockResolvedValue(face.person!);

      await sut.handleRecognizeFaces({ id: noPerson.id });

      expect(mocks.person.create).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).toHaveBeenCalledTimes(1);
      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        faceIds: expect.arrayContaining([noPerson.id]),
        newPersonId: face.person!.id,
      });
      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        faceIds: expect.not.arrayContaining([face.id]),
        newPersonId: face.person!.id,
      });
    });

    it('should match existing person if their birth date is before file creation', async () => {
      const asset = AssetFactory.create();
      const [noPerson, face, faceWithBirthDate] = [
        AssetFaceFactory.create({ assetId: asset.id }),
        AssetFaceFactory.from().person().build(),
        AssetFaceFactory.from().person({ birthDate: newDate() }).build(),
      ];

      const faces = [
        { ...noPerson, distance: 0 },
        { ...faceWithBirthDate, distance: 0.2 },
        { ...face, distance: 0.3 },
      ] as FaceSearchResult[];

      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { minFaces: 1 } } });
      mocks.search.searchFaces.mockResolvedValue(faces);
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(noPerson, asset));
      mocks.person.create.mockResolvedValue(face.person!);

      await sut.handleRecognizeFaces({ id: noPerson.id });

      expect(mocks.person.create).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).toHaveBeenCalledTimes(1);
      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        faceIds: expect.arrayContaining([noPerson.id]),
        newPersonId: faceWithBirthDate.person!.id,
      });
      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        faceIds: expect.not.arrayContaining([face.id]),
        newPersonId: faceWithBirthDate.person!.id,
      });
    });

    it('should create a new person if the face is a core point with no person', async () => {
      const asset = AssetFactory.create();
      const [noPerson1, noPerson2] = [AssetFaceFactory.create({ assetId: asset.id }), AssetFaceFactory.create()];
      const person = PersonFactory.create();

      const faces = [
        { ...noPerson1, distance: 0 },
        { ...noPerson2, distance: 0.3 },
      ] as FaceSearchResult[];

      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { minFaces: 1 } } });
      mocks.search.searchFaces.mockResolvedValue(faces);
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(noPerson1, asset));
      mocks.person.create.mockResolvedValue(person);

      await sut.handleRecognizeFaces({ id: noPerson1.id });

      expect(mocks.person.create).toHaveBeenCalledWith({
        ownerId: asset.ownerId,
        faceAssetId: noPerson1.id,
      });
      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        faceIds: [noPerson1.id],
        newPersonId: person.id,
      });
    });

    it('should not queue face with no matches', async () => {
      const asset = AssetFactory.create();
      const face = AssetFaceFactory.create({ assetId: asset.id });
      const faces = [{ ...face, distance: 0 }] as FaceSearchResult[];

      mocks.search.searchFaces.mockResolvedValue(faces);
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(face, asset));
      mocks.person.create.mockResolvedValue(PersonFactory.create());

      await sut.handleRecognizeFaces({ id: face.id });

      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.search.searchFaces).toHaveBeenCalledTimes(1);
      expect(mocks.person.create).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    });

    it('should defer non-core faces to end of queue', async () => {
      const asset = AssetFactory.create();
      const [noPerson1, noPerson2] = [AssetFaceFactory.create({ assetId: asset.id }), AssetFaceFactory.create()];

      const faces = [
        { ...noPerson1, distance: 0 },
        { ...noPerson2, distance: 0.4 },
      ] as FaceSearchResult[];

      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { minFaces: 3 } } });
      mocks.search.searchFaces.mockResolvedValue(faces);
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(noPerson1, asset));
      mocks.person.create.mockResolvedValue(PersonFactory.create());

      await sut.handleRecognizeFaces({ id: noPerson1.id });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FacialRecognition,
        data: { id: noPerson1.id, deferred: true },
      });
      expect(mocks.search.searchFaces).toHaveBeenCalledTimes(1);
      expect(mocks.person.create).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    });

    it('should not assign person to deferred non-core face with no matching person', async () => {
      const asset = AssetFactory.create();
      const [noPerson1, noPerson2] = [AssetFaceFactory.create({ assetId: asset.id }), AssetFaceFactory.create()];

      const faces = [
        { ...noPerson1, distance: 0 },
        { ...noPerson2, distance: 0.4 },
      ] as FaceSearchResult[];

      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { minFaces: 3 } } });
      mocks.search.searchFaces.mockResolvedValueOnce(faces).mockResolvedValueOnce([]);
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(noPerson1, asset));
      mocks.person.create.mockResolvedValue(PersonFactory.create());

      await sut.handleRecognizeFaces({ id: noPerson1.id, deferred: true });

      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.search.searchFaces).toHaveBeenCalledTimes(2);
      expect(mocks.person.create).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    });
  });

  describe('mergePerson', () => {
    it('should require person.write and person.merge permission', async () => {
      const auth = AuthFactory.create();
      const [person, mergePerson] = [PersonFactory.create(), PersonFactory.create()];

      mocks.person.getById.mockResolvedValueOnce(person);
      mocks.person.getById.mockResolvedValueOnce(mergePerson);

      await expect(sut.mergePerson(auth, person.id, { ids: [mergePerson.id] })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();

      expect(mocks.person.delete).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should merge two people without smart merge', async () => {
      const auth = AuthFactory.create();
      const [person, mergePerson] = [PersonFactory.create(), PersonFactory.create()];

      mocks.person.getById.mockResolvedValueOnce(person);
      mocks.person.getById.mockResolvedValueOnce(mergePerson);
      mocks.access.person.checkOwnerAccess.mockResolvedValueOnce(new Set([person.id]));
      mocks.access.person.checkOwnerAccess.mockResolvedValueOnce(new Set([mergePerson.id]));

      await expect(sut.mergePerson(auth, person.id, { ids: [mergePerson.id] })).resolves.toEqual([
        { id: mergePerson.id, success: true },
      ]);

      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        newPersonId: person.id,
        oldPersonId: mergePerson.id,
      });

      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should merge two people with smart merge', async () => {
      const auth = AuthFactory.create();
      const [person, mergePerson] = [
        PersonFactory.create({ name: undefined }),
        PersonFactory.create({ name: 'Merge person' }),
      ];

      mocks.person.getById.mockResolvedValueOnce(person);
      mocks.person.getById.mockResolvedValueOnce(mergePerson);
      mocks.person.update.mockResolvedValue({ ...person, name: mergePerson.name });
      mocks.access.person.checkOwnerAccess.mockResolvedValueOnce(new Set([person.id]));
      mocks.access.person.checkOwnerAccess.mockResolvedValueOnce(new Set([mergePerson.id]));

      await expect(sut.mergePerson(auth, person.id, { ids: [mergePerson.id] })).resolves.toEqual([
        { id: mergePerson.id, success: true },
      ]);

      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        newPersonId: person.id,
        oldPersonId: mergePerson.id,
      });

      expect(mocks.person.update).toHaveBeenCalledWith({
        id: person.id,
        name: mergePerson.name,
      });

      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should throw an error when the primary person is not found', async () => {
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set(['person-1']));

      await expect(sut.mergePerson(authStub.admin, 'person-1', { ids: ['person-2'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.person.delete).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['person-1']));
    });

    it('should handle invalid merge ids', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create();

      mocks.person.getById.mockResolvedValueOnce(person);
      mocks.access.person.checkOwnerAccess.mockResolvedValueOnce(new Set([person.id]));
      mocks.access.person.checkOwnerAccess.mockResolvedValueOnce(new Set(['unknown']));

      await expect(sut.mergePerson(auth, person.id, { ids: ['unknown'] })).resolves.toEqual([
        { id: 'unknown', success: false, error: BulkIdErrorReason.NOT_FOUND },
      ]);

      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
      expect(mocks.person.delete).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should handle an error reassigning faces', async () => {
      const auth = AuthFactory.create();
      const [person, mergePerson] = [PersonFactory.create(), PersonFactory.create()];

      mocks.person.getById.mockResolvedValueOnce(person);
      mocks.person.getById.mockResolvedValueOnce(mergePerson);
      mocks.person.reassignFaces.mockRejectedValue(new Error('update failed'));
      mocks.access.person.checkOwnerAccess.mockResolvedValueOnce(new Set([person.id]));
      mocks.access.person.checkOwnerAccess.mockResolvedValueOnce(new Set([mergePerson.id]));

      await expect(sut.mergePerson(auth, person.id, { ids: [mergePerson.id] })).resolves.toEqual([
        { id: mergePerson.id, success: false, error: BulkIdErrorReason.UNKNOWN },
      ]);

      expect(mocks.person.delete).not.toHaveBeenCalled();
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });
  });

  describe('getStatistics', () => {
    it('should get correct number of person', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create();

      mocks.person.getById.mockResolvedValue(person);
      mocks.person.getStatistics.mockResolvedValue({ assets: 3 });
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.id]));
      await expect(sut.getStatistics(auth, person.id)).resolves.toEqual({ assets: 3 });
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });

    it('should require person.read permission', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create();

      mocks.person.getById.mockResolvedValue(person);
      await expect(sut.getStatistics(auth, person.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([person.id]));
    });
  });

  describe('mapFace', () => {
    it('should map a face', () => {
      const user = UserFactory.create();
      const auth = AuthFactory.create({ id: user.id });
      const person = PersonFactory.create({ ownerId: user.id });
      const face = AssetFaceFactory.from().person(person).build();

      expect(mapFaces(getForAssetFace(face), auth)).toEqual({
        boundingBoxX1: 100,
        boundingBoxX2: 200,
        boundingBoxY1: 100,
        boundingBoxY2: 200,
        id: face.id,
        imageHeight: 500,
        imageWidth: 400,
        sourceType: SourceType.MachineLearning,
        person: mapPerson(person),
      });
    });

    it('should not map person if person is null', () => {
      expect(mapFaces(getForAssetFace(AssetFaceFactory.create()), AuthFactory.create()).person).toBeNull();
    });

    it('should not map person if person does not match auth user id', () => {
      expect(
        mapFaces(getForAssetFace(AssetFaceFactory.from().person().build()), AuthFactory.create()).person,
      ).toBeNull();
    });
  });
});
