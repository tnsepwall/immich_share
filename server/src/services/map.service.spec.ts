import { MapService } from 'src/services/map.service';
import { AlbumFactory } from 'test/factories/album.factory';
import { AssetFactory } from 'test/factories/asset.factory';
import { AuthFactory } from 'test/factories/auth.factory';
import { PartnerFactory } from 'test/factories/partner.factory';
import { userStub } from 'test/fixtures/user.stub';
import { getForPartner } from 'test/mappers';
import { newUuid } from 'test/small.factory';
import { newTestService, ServiceMocks } from 'test/utils';

describe(MapService.name, () => {
  let sut: MapService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MapService));
  });

  describe('getMapMarkers', () => {
    it('should get geo information of assets', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.from()
        .exif({ latitude: 42, longitude: 69, city: 'city', state: 'state', country: 'country' })
        .build();
      const marker = {
        id: asset.id,
        lat: asset.exifInfo.latitude!,
        lon: asset.exifInfo.longitude!,
        city: asset.exifInfo.city,
        state: asset.exifInfo.state,
        country: asset.exifInfo.country,
      };
      mocks.partner.getAll.mockResolvedValue([]);
      mocks.map.getMapMarkers.mockResolvedValue([marker]);

      const markers = await sut.getMapMarkers(auth, {});

      expect(markers).toHaveLength(1);
      expect(markers[0]).toEqual(marker);
    });

    it('should include partner assets', async () => {
      const auth = AuthFactory.create();
      const partner = PartnerFactory.create({ sharedWithId: auth.user.id });

      const asset = AssetFactory.from()
        .exif({ latitude: 42, longitude: 69, city: 'city', state: 'state', country: 'country' })
        .build();
      const marker = {
        id: asset.id,
        lat: asset.exifInfo.latitude!,
        lon: asset.exifInfo.longitude!,
        city: asset.exifInfo.city,
        state: asset.exifInfo.state,
        country: asset.exifInfo.country,
      };
      mocks.partner.getAll.mockResolvedValue([getForPartner(partner)]);
      mocks.map.getMapMarkers.mockResolvedValue([marker]);

      const markers = await sut.getMapMarkers(auth, { withPartners: true });

      expect(mocks.map.getMapMarkers).toHaveBeenCalledWith(
        auth.user.id,
        [auth.user.id, partner.sharedById],
        expect.arrayContaining([]),
        [],
        { withPartners: true },
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]).toEqual(marker);
    });

    it('should include assets from shared albums', async () => {
      const auth = AuthFactory.create(userStub.user1);
      const asset = AssetFactory.from()
        .exif({ latitude: 42, longitude: 69, city: 'city', state: 'state', country: 'country' })
        .build();
      const marker = {
        id: asset.id,
        lat: asset.exifInfo.latitude!,
        lon: asset.exifInfo.longitude!,
        city: asset.exifInfo.city,
        state: asset.exifInfo.state,
        country: asset.exifInfo.country,
      };
      mocks.partner.getAll.mockResolvedValue([]);
      mocks.map.getMapMarkers.mockResolvedValue([marker]);
      const album1 = AlbumFactory.create();
      const album2 = AlbumFactory.from().albumUser({ userId: userStub.user1.id }).build();
      mocks.album.getAllIds.mockResolvedValue([album1.id, album2.id]);

      const markers = await sut.getMapMarkers(auth, { withSharedAlbums: true });

      expect(markers).toHaveLength(1);
      expect(markers[0]).toEqual(marker);
      expect(mocks.album.getAllIds).toHaveBeenCalledWith(auth.user.id);
    });

    it('should include inTimeline shared-library ids when withSharedLibraries is set', async () => {
      const auth = AuthFactory.create();
      const libraryId = newUuid();

      mocks.partner.getAll.mockResolvedValue([]);
      mocks.library.getInTimelineSharedLibraryIds.mockResolvedValue([libraryId]);
      mocks.map.getMapMarkers.mockResolvedValue([]);

      await sut.getMapMarkers(auth, { withSharedLibraries: true });

      expect(mocks.library.getInTimelineSharedLibraryIds).toHaveBeenCalledWith(auth.user.id);
      expect(mocks.map.getMapMarkers).toHaveBeenCalledWith(auth.user.id, [auth.user.id], [], [libraryId], {
        withSharedLibraries: true,
      });
    });

    // Review finding: the repository ANDs the isFavorite filter across every arm, so combining it
    // with the shared-library arm would enumerate which shared assets the OWNER favorited - the same
    // probe class the timeline rejects and search's dropSharedLibraryProbe() defends against.
    it('should drop the shared-library arm when isFavorite is filtered', async () => {
      const auth = AuthFactory.create();

      mocks.partner.getAll.mockResolvedValue([]);
      mocks.map.getMapMarkers.mockResolvedValue([]);

      await sut.getMapMarkers(auth, { withSharedLibraries: true, isFavorite: true });

      expect(mocks.library.getInTimelineSharedLibraryIds).not.toHaveBeenCalled();
      expect(mocks.map.getMapMarkers).toHaveBeenCalledWith(auth.user.id, [auth.user.id], [], [], {
        withSharedLibraries: true,
        isFavorite: true,
      });
    });
  });

  describe('reverseGeocode', () => {
    it('should reverse geocode a location', async () => {
      mocks.map.reverseGeocode.mockResolvedValue({ city: 'foo', state: 'bar', country: 'baz' });

      await expect(sut.reverseGeocode({ lat: 42, lon: 69 })).resolves.toEqual([
        { city: 'foo', state: 'bar', country: 'baz' },
      ]);

      expect(mocks.map.reverseGeocode).toHaveBeenCalledWith({ latitude: 42, longitude: 69 });
    });
  });
});
