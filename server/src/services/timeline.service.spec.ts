import { BadRequestException } from '@nestjs/common';
import { AssetVisibility } from 'src/enum';
import { TimelineService } from 'src/services/timeline.service';
import { authStub } from 'test/fixtures/auth.stub';
import { newTestService, ServiceMocks } from 'test/utils';

describe(TimelineService.name, () => {
  let sut: TimelineService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TimelineService));
  });

  describe('getTimeBuckets', () => {
    it("should return buckets if userId and albumId aren't set", async () => {
      mocks.asset.getTimeBuckets.mockResolvedValue([{ timeBucket: 'bucket', count: 1 }]);

      await expect(sut.getTimeBuckets(authStub.admin, {})).resolves.toEqual(
        expect.arrayContaining([{ timeBucket: 'bucket', count: 1 }]),
      );
      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith({
        userIds: [authStub.admin.user.id],
      });
    });

    it('should pass bbox options to repository when all bbox fields are provided', async () => {
      mocks.asset.getTimeBuckets.mockResolvedValue([{ timeBucket: 'bucket', count: 1 }]);

      await sut.getTimeBuckets(authStub.admin, {
        bbox: {
          west: -70,
          south: -30,
          east: 120,
          north: 55,
        },
      });

      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith({
        userIds: [authStub.admin.user.id],
        bbox: { west: -70, south: -30, east: 120, north: 55 },
      });
    });
  });

  describe('getTimeBucket', () => {
    it('should return the assets for a album time bucket if user has album.read', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-id']));
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });

      await expect(sut.getTimeBucket(authStub.admin, { timeBucket: 'bucket', albumId: 'album-id' })).resolves.toEqual(
        json,
      );

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['album-id']));
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        {
          timeBucket: 'bucket',
          albumId: 'album-id',
        },
        authStub.admin,
      );
    });

    it('should return the assets for a archive time bucket if user has archive.read', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Archive,
          userId: authStub.admin.user.id,
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        expect.objectContaining({
          timeBucket: 'bucket',
          visibility: AssetVisibility.Archive,
          userIds: [authStub.admin.user.id],
        }),
        authStub.admin,
      );
    });

    it('should include partner shared assets', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Timeline,
          userId: authStub.admin.user.id,
          withPartners: true,
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Timeline,
          withPartners: true,
          userIds: [authStub.admin.user.id],
        },
        authStub.admin,
      );
    });

    it('should check permissions to read tag', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-123']));

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          userId: authStub.admin.user.id,
          tagId: 'tag-123',
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        {
          tagId: 'tag-123',
          timeBucket: 'bucket',
          userIds: [authStub.admin.user.id],
        },
        authStub.admin,
      );
    });

    it('should return the assets for a library time bucket if user has library.read', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          userId: authStub.admin.user.id,
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        expect.objectContaining({
          timeBucket: 'bucket',
          userIds: [authStub.admin.user.id],
        }),
        authStub.admin,
      );
    });

    it('should throw an error if withParners is true and visibility true or undefined', async () => {
      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Archive,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: undefined,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw an error if withParners is true and isFavorite is either true or false', async () => {
      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          isFavorite: true,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          isFavorite: false,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw an error if withParners is true and isTrash is true', async () => {
      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          isTrashed: true,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw an error if withPartners is true and visibility is locked', async () => {
      await expect(
        sut.getTimeBucket(authStub.adminWithElevatedPermission, {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Locked,
          withPartners: true,
          userId: authStub.adminWithElevatedPermission.user.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    describe('libraryId', () => {
      it('should give the owner full filter freedom', async () => {
        const json = `[{ id: ['asset-id'] }]`;
        mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });
        mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set(['library-id']));
        mocks.library.get.mockResolvedValue({ id: 'library-id', ownerId: authStub.user1.user.id } as any);

        await expect(
          sut.getTimeBucket(authStub.user1, {
            timeBucket: 'bucket',
            libraryId: 'library-id',
            visibility: AssetVisibility.Archive,
          }),
        ).resolves.toEqual(json);

        expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
          'bucket',
          expect.objectContaining({
            libraryId: 'library-id',
            visibility: AssetVisibility.Archive,
            userIds: [authStub.user1.user.id],
          }),
          authStub.user1,
        );
      });

      it('should force Timeline visibility and disable stacks for a shared recipient', async () => {
        const json = `[{ id: ['asset-id'] }]`;
        mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });
        mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
        mocks.access.library.checkSharedAccess.mockResolvedValue(new Set(['library-id']));
        mocks.library.get.mockResolvedValue({ id: 'library-id', ownerId: authStub.user1.user.id } as any);

        await expect(
          sut.getTimeBucket(authStub.user2, {
            timeBucket: 'bucket',
            libraryId: 'library-id',
            withStacked: true,
          }),
        ).resolves.toEqual(json);

        expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
          'bucket',
          expect.objectContaining({
            libraryId: 'library-id',
            visibility: AssetVisibility.Timeline,
            withStacked: false,
            userIds: [authStub.user1.user.id],
          }),
          authStub.user2,
        );
      });

      it('should reject a stranger with no owner or shared access', async () => {
        mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
        mocks.access.library.checkSharedAccess.mockResolvedValue(new Set());

        await expect(
          sut.getTimeBucket(authStub.user2, { timeBucket: 'bucket', libraryId: 'library-id' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(mocks.library.get).not.toHaveBeenCalled();
      });

      it.each([
        { isTrashed: true },
        { isFavorite: true },
        { isFavorite: false },
        { visibility: AssetVisibility.Archive },
        { withPartners: true },
      ])('should reject a recipient requesting a restricted filter: %j', async (filter) => {
        mocks.access.library.checkOwnerAccess.mockResolvedValue(new Set());
        mocks.access.library.checkSharedAccess.mockResolvedValue(new Set(['library-id']));
        mocks.library.get.mockResolvedValue({ id: 'library-id', ownerId: authStub.user1.user.id } as any);

        await expect(
          sut.getTimeBucket(authStub.user2, { timeBucket: 'bucket', libraryId: 'library-id', ...filter }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('should reject combining libraryId with albumId', async () => {
        await expect(
          sut.getTimeBucket(authStub.user1, { timeBucket: 'bucket', libraryId: 'library-id', albumId: 'album-id' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });
  });
});
