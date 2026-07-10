import { BadRequestException } from '@nestjs/common';
import { LibraryEditorService } from 'src/services/library-editor.service';
import { AssetFactory } from 'test/factories/asset.factory';
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
});
