import { BadRequestException } from '@nestjs/common';
import { JobName } from 'src/enum';
import { LibraryEditorService } from 'src/services/library-editor.service';
import { AssetFactory } from 'test/factories/asset.factory';
import { AssetFaceFactory } from 'test/factories/asset-face.factory';
import { authStub } from 'test/fixtures/auth.stub';
import { getForAsset } from 'test/mappers';
import { factory } from 'test/small.factory';
import { newTestService, ServiceMocks } from 'test/utils';

describe(LibraryEditorService.name, () => {
  let sut: LibraryEditorService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(LibraryEditorService));
    mocks.systemMetadata.get.mockResolvedValue({ reverseGeocoding: { enabled: true } });
  });

  describe('updateAssets', () => {
    it('should reject a caller with neither owner nor editor access', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkEditorAccess.mockResolvedValue(new Set());

      await expect(
        sut.updateAssets(authStub.user1, 'library-id', { ids: ['asset-1'], description: 'hello' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.asset.updateLibraryAssetMetadata).not.toHaveBeenCalled();
    });

    it('should allow the library owner', async () => {
      const asset = AssetFactory.create();
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      const result = await sut.updateAssets(authStub.user1, 'library-id', {
        ids: [asset.id],
        description: 'hello',
      });

      // checkEditorAccess still runs on the difference (mirrors the existing LibraryRead owner-union pattern),
      // but with nothing left to check since the owner check already covers this id.
      expect(mocks.access.library.checkEditorAccess).toHaveBeenCalledWith(authStub.user1.user.id, new Set());
      expect(result).toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should allow an Editor who does not own the library', async () => {
      const asset = AssetFactory.create();
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkEditorAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await expect(
        sut.updateAssets(authStub.user2, 'library-id', { ids: [asset.id], rating: 3 }),
      ).resolves.toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should throw when the repository primitive finds nothing to write (revoked mid-flight or out-of-scope asset)', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue(null);

      await expect(
        sut.updateAssets(authStub.user1, 'library-id', { ids: ['asset-1'], description: 'hello' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should pass an absolute dateTimeOriginal through as a resolved Date and extract a fixed offset as timeZone', async () => {
      const asset = AssetFactory.create();
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.updateAssets(authStub.user1, 'library-id', {
        ids: [asset.id],
        dateTimeOriginal: '2023-11-21T22:56:12.196-06:00',
      });

      expect(mocks.asset.updateLibraryAssetMetadata).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        [asset.id],
        expect.objectContaining({
          dateTimeOriginal: new Date('2023-11-21T22:56:12.196-06:00'),
          timeZone: 'UTC-6',
        }),
      );
    });

    it('should let an explicit timeZone override the one extracted from dateTimeOriginal', async () => {
      const asset = AssetFactory.create();
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.updateAssets(authStub.user1, 'library-id', {
        ids: [asset.id],
        dateTimeOriginal: '2023-11-21T22:56:12.196-06:00',
        timeZone: 'America/Winnipeg',
      });

      expect(mocks.asset.updateLibraryAssetMetadata).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        [asset.id],
        expect.objectContaining({ timeZone: 'America/Winnipeg' }),
      );
    });

    it('should pass dateTimeRelative through without resolving an absolute dateTimeOriginal', async () => {
      const asset = AssetFactory.create();
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.updateAssets(authStub.user1, 'library-id', { ids: [asset.id], dateTimeRelative: -30 });

      expect(mocks.asset.updateLibraryAssetMetadata).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        [asset.id],
        expect.objectContaining({ dateTimeRelative: -30, dateTimeOriginal: undefined }),
      );
    });

    it('should reverse-geocode new coordinates and write city/state/country in the same edit', async () => {
      const asset = AssetFactory.create();
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.map.reverseGeocode.mockResolvedValue({ city: 'Winnipeg', state: 'Manitoba', country: 'Canada' });

      await sut.updateAssets(authStub.user1, 'library-id', { ids: [asset.id], latitude: 49.895, longitude: -97.138 });

      expect(mocks.map.reverseGeocode).toHaveBeenCalledWith({ latitude: 49.895, longitude: -97.138 });
      expect(mocks.asset.updateLibraryAssetMetadata).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        [asset.id],
        expect.objectContaining({
          latitude: 49.895,
          longitude: -97.138,
          city: 'Winnipeg',
          state: 'Manitoba',
          country: 'Canada',
        }),
      );
    });

    it('should not reverse-geocode when the server has reverse geocoding disabled', async () => {
      const asset = AssetFactory.create();
      mocks.systemMetadata.get.mockResolvedValue({ reverseGeocoding: { enabled: false } });
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.updateAssets(authStub.user1, 'library-id', { ids: [asset.id], latitude: 49.895, longitude: -97.138 });

      expect(mocks.map.reverseGeocode).not.toHaveBeenCalled();
      expect(mocks.asset.updateLibraryAssetMetadata).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        [asset.id],
        expect.objectContaining({ city: null, state: null, country: null }),
      );
    });

    it('should clear city/state/country without geocoding when coordinates are cleared', async () => {
      const asset = AssetFactory.create();
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.updateAssets(authStub.user1, 'library-id', { ids: [asset.id], latitude: null, longitude: null });

      expect(mocks.map.reverseGeocode).not.toHaveBeenCalled();
      expect(mocks.asset.updateLibraryAssetMetadata).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        [asset.id],
        expect.objectContaining({ latitude: null, longitude: null, city: null, state: null, country: null }),
      );
    });

    it('should not touch latitude/longitude/city/state/country when no coordinates are provided', async () => {
      const asset = AssetFactory.create();
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.updateAssets(authStub.user1, 'library-id', { ids: [asset.id], description: 'no location edit' });

      expect(mocks.map.reverseGeocode).not.toHaveBeenCalled();
      const edit = mocks.asset.updateLibraryAssetMetadata.mock.calls[0][3];
      expect(edit).not.toHaveProperty('latitude');
      expect(edit).not.toHaveProperty('city');
    });

    it('should redact people for a non-owner Editor but not for the owner', async () => {
      const asset = AssetFactory.from()
        .face({}, (face) => face.person())
        .build();
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkEditorAccess.mockResolvedValue(new Set(['library-id']));
      const [asEditor] = await sut.updateAssets(authStub.user2, 'library-id', { ids: [asset.id], rating: 3 });
      expect(asEditor.people).toEqual([]);

      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.access.library.checkEditorAccess.mockResolvedValue(new Set());
      const owner = factory.auth({ user: { id: asset.ownerId } });
      const [asOwner] = await sut.updateAssets(owner, 'library-id', { ids: [asset.id], rating: 3 });
      expect(asOwner.people).not.toEqual([]);
    });

    it('should redact livePhotoVideoId unless the motion asset is in the same library', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', livePhotoVideoId: 'motion-id' });
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkEditorAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockImplementation((id) => {
        if (id === asset.id) {
          return Promise.resolve(getForAsset(asset));
        }
        return Promise.resolve({ id: 'motion-id', libraryId: 'a-different-library-id' } as any);
      });

      const [result] = await sut.updateAssets(authStub.user2, 'library-id', { ids: [asset.id], rating: 2 });

      expect(result.livePhotoVideoId).toBeNull();
    });
  });

  describe('updateAsset', () => {
    it('should delegate to updateAssets with a single-element ids array', async () => {
      const asset = AssetFactory.create();
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.updateLibraryAssetMetadata.mockResolvedValue([asset.id]);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      const result = await sut.updateAsset(authStub.user1, 'library-id', asset.id, { description: 'solo edit' });

      expect(mocks.asset.updateLibraryAssetMetadata).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        [asset.id],
        expect.objectContaining({ description: 'solo edit' }),
      );
      expect(result).toEqual(expect.objectContaining({ id: asset.id }));
    });
  });

  describe('getPeople', () => {
    it('should reject a caller with no relationship to the library', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkSharedAccess.mockResolvedValue(new Set());

      await expect(sut.getPeople(authStub.user1, 'library-id', { page: 1, size: 500 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.person.getAllForLibrary).not.toHaveBeenCalled();
    });

    it('should allow a Viewer (read-only share), paginate, and map the repository rows', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkSharedAccess.mockResolvedValue(new Set(['library-id']));
      mocks.person.getAllForLibrary.mockResolvedValue({
        items: [{ id: 'person-1', name: 'Alice', thumbnailFace: null }],
        hasNextPage: true,
      });

      const result = await sut.getPeople(authStub.user1, 'library-id', { page: 2, size: 10 });

      expect(mocks.person.getAllForLibrary).toHaveBeenCalledWith('library-id', { take: 10, skip: 10 });
      expect(result).toEqual({
        people: [{ id: 'person-1', name: 'Alice', thumbnailFace: null }],
        hasNextPage: true,
      });
    });
  });

  describe('getAssetFaces', () => {
    it('should reject a caller with no relationship to the library', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkSharedAccess.mockResolvedValue(new Set());

      await expect(sut.getAssetFaces(authStub.user1, 'library-id', 'asset-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.person.getFacesForLibraryAsset).not.toHaveBeenCalled();
    });

    it('should allow a Viewer and map the faces', async () => {
      const face = AssetFaceFactory.create({ id: 'face-1', assetId: 'asset-1' });
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkSharedAccess.mockResolvedValue(new Set(['library-id']));
      mocks.person.getFacesForLibraryAsset.mockResolvedValue([face]);

      const result = await sut.getAssetFaces(authStub.user1, 'library-id', 'asset-1');

      expect(result).toEqual([expect.objectContaining({ id: 'face-1', assetId: 'asset-1' })]);
    });
  });

  describe('createPerson', () => {
    it('should reject a caller without create access', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkEditorAccess.mockResolvedValue(new Set());

      await expect(
        sut.createPerson(authStub.user1, 'library-id', { name: 'Alice', faceIds: ['face-1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.person.createPersonForLibrary).not.toHaveBeenCalled();
    });

    // The repository primitive re-verifies role, and library/face scope, INSIDE its own transaction -
    // this covers the library not existing, access having been revoked since the outer check, or one or
    // more faces turning out to be out of scope. All three collapse to the same null return and the same
    // generic 400 here, so one test stands in for all of them at the service layer; the primitive's own
    // medium spec (person.repository.spec.ts) exercises each condition individually.
    it('should throw when the repository primitive rejects the request', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.person.createPersonForLibrary.mockResolvedValue(null);

      await expect(
        sut.createPerson(authStub.user1, 'library-id', { name: 'Alice', faceIds: ['face-1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should create the person, queue a feature-photo refresh job, and return the mapped result', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.person.createPersonForLibrary.mockResolvedValue({
        personId: 'new-person',
        needsFeaturePhoto: ['new-person'],
      });
      mocks.person.getOneForLibrary.mockResolvedValue({ id: 'new-person', name: 'Alice', thumbnailFace: null });

      const result = await sut.createPerson(authStub.user1, 'library-id', { name: 'Alice', faceIds: ['face-1'] });

      expect(mocks.person.createPersonForLibrary).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        'Alice',
        ['face-1'],
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.PersonGenerateThumbnail, data: { id: 'new-person' } },
      ]);
      expect(result).toEqual({ id: 'new-person', name: 'Alice', thumbnailFace: null });
    });

    it('should not queue any job when no feature photo needs refreshing', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.person.createPersonForLibrary.mockResolvedValue({ personId: 'new-person', needsFeaturePhoto: [] });
      mocks.person.getOneForLibrary.mockResolvedValue({ id: 'new-person', name: 'Alice', thumbnailFace: null });

      await sut.createPerson(authStub.user1, 'library-id', { name: 'Alice', faceIds: ['face-1'] });

      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });

  describe('updatePersonName', () => {
    it('should reject a caller without update access', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkEditorAccess.mockResolvedValue(new Set());

      await expect(
        sut.updatePersonName(authStub.user1, 'library-id', 'person-1', { name: 'Bob' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.person.updatePersonNameForLibrary).not.toHaveBeenCalled();
    });

    // Covers not-in-scope and not-exclusive alike - both collapse to a false return from the primitive.
    // See its own medium spec for each condition tested individually against a real database.
    it('should throw when the repository primitive rejects the request', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.person.updatePersonNameForLibrary.mockResolvedValue(false);

      await expect(
        sut.updatePersonName(authStub.user1, 'library-id', 'person-1', { name: 'Bob' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should rename and return the mapped result', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.person.updatePersonNameForLibrary.mockResolvedValue(true);
      mocks.person.getOneForLibrary.mockResolvedValue({ id: 'person-1', name: 'Bob', thumbnailFace: null });

      const result = await sut.updatePersonName(authStub.user1, 'library-id', 'person-1', { name: 'Bob' });

      expect(mocks.person.updatePersonNameForLibrary).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        'person-1',
        'Bob',
      );
      expect(result).toEqual({ id: 'person-1', name: 'Bob', thumbnailFace: null });
    });
  });

  describe('assignFaces', () => {
    it('should reject a caller without update access', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkEditorAccess.mockResolvedValue(new Set());

      await expect(
        sut.assignFaces(authStub.user1, 'library-id', { personId: 'person-1', faceIds: ['face-1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.person.assignFacesForLibrary).not.toHaveBeenCalled();
    });

    it('should throw when the repository primitive rejects the request', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.person.assignFacesForLibrary.mockResolvedValue(null);

      await expect(
        sut.assignFaces(authStub.user1, 'library-id', { personId: 'person-1', faceIds: ['face-1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should reassign, queue a feature-photo refresh for the person who lost theirs, and return the mapped faces', async () => {
      const target = { id: 'target-person', name: 'Target' };
      const face = { ...AssetFaceFactory.create({ id: 'face-1' }), person: target };

      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.person.assignFacesForLibrary.mockResolvedValue({ needsFeaturePhoto: ['old-person'] });
      mocks.person.getFaceById.mockResolvedValue(face as any);

      const result = await sut.assignFaces(authStub.user1, 'library-id', {
        personId: 'target-person',
        faceIds: ['face-1'],
      });

      expect(mocks.person.assignFacesForLibrary).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        'target-person',
        ['face-1'],
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.PersonGenerateThumbnail, data: { id: 'old-person' } },
      ]);
      expect(result).toEqual([expect.objectContaining({ id: 'face-1', person: target })]);
    });
  });

  describe('createManualFace', () => {
    const dto = {
      assetId: 'asset-1',
      personId: 'person-1',
      imageWidth: 1000,
      imageHeight: 800,
      x: 10,
      y: 20,
      width: 50,
      height: 60,
    };

    it('should reject a caller without create-face access', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.library.checkEditorAccess.mockResolvedValue(new Set());

      await expect(sut.createManualFace(authStub.user1, 'library-id', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.person.createManualFaceForLibrary).not.toHaveBeenCalled();
    });

    it('should reject when the asset cannot be found at all', async () => {
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.getById.mockResolvedValue(undefined as any);

      await expect(sut.createManualFace(authStub.user1, 'library-id', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.person.createManualFaceForLibrary).not.toHaveBeenCalled();
    });

    // Covers the person or the asset turning out to be out of this library's scope - both collapse to a
    // null return from the primitive, which re-verifies both freshly, inside its own transaction,
    // immediately before writing (this is also the H1 fix: the service no longer trusts a plain
    // libraryId-equality check on the asset - see the primitive's own medium spec for the individual
    // Timeline/soft-delete/cross-library scope conditions tested against a real database).
    it('should throw when the repository primitive rejects the request', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', width: 1000, height: 800 });
      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.person.createManualFaceForLibrary.mockResolvedValue(null);

      await expect(sut.createManualFace(authStub.user1, 'library-id', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should create a face directly from the given box when the asset has no edits', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', libraryId: 'library-id', width: 1000, height: 800 });
      const person = { id: 'person-1', name: 'Alice', faceAssetId: 'existing-face' };

      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.person.createManualFaceForLibrary.mockResolvedValue({ faceId: 'face-1', needsFeaturePhoto: [] });
      mocks.person.getById.mockResolvedValue(person as any);

      const result = await sut.createManualFace(authStub.user1, 'library-id', dto);

      expect(mocks.person.createManualFaceForLibrary).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        'person-1',
        'asset-1',
        expect.objectContaining({
          imageWidth: 1000,
          imageHeight: 800,
          boundingBoxX1: 10,
          boundingBoxY1: 20,
          boundingBoxX2: 60,
          boundingBoxY2: 80,
        }),
      );
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ id: 'face-1', person: { id: 'person-1', name: 'Alice' } }));
    });

    it('should queue a feature-photo refresh when the repository primitive reports one is needed', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', libraryId: 'library-id', width: 1000, height: 800 });
      const person = { id: 'person-1', name: 'Alice', faceAssetId: null };

      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.person.createManualFaceForLibrary.mockResolvedValue({
        faceId: 'face-1',
        needsFeaturePhoto: ['person-1'],
      });
      mocks.person.getById.mockResolvedValue(person as any);

      await sut.createManualFace(authStub.user1, 'library-id', dto);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.PersonGenerateThumbnail, data: { id: 'person-1' } },
      ]);
    });

    it('should switch to the original exif dimensions when the asset has edits', async () => {
      const asset = AssetFactory.from({ id: 'asset-1', libraryId: 'library-id', width: 1000, height: 800 })
        .exif({ exifImageWidth: 4000, exifImageHeight: 3200, orientation: '1' })
        .edit({ parameters: { x: 0, y: 0, width: 1000, height: 800 } })
        .build();
      const person = { id: 'person-1', name: 'Alice', faceAssetId: 'x' };

      mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
      mocks.asset.getById.mockResolvedValue(asset as any);
      mocks.person.createManualFaceForLibrary.mockResolvedValue({ faceId: 'face-1', needsFeaturePhoto: [] });
      mocks.person.getById.mockResolvedValue(person as any);

      await sut.createManualFace(authStub.user1, 'library-id', dto);

      // the value passed to the repository switches to the original exif dimensions, not the (possibly
      // downscaled) preview dimensions the box was drawn against - the exact transformed box is
      // transformPoints' own concern, already covered by its own tests.
      expect(mocks.person.createManualFaceForLibrary).toHaveBeenCalledWith(
        'library-id',
        authStub.user1.user.id,
        'person-1',
        'asset-1',
        expect.objectContaining({ imageWidth: 4000, imageHeight: 3200 }),
      );
    });
  });
});
