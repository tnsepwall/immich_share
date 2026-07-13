import { BadRequestException } from '@nestjs/common';
import { PartnerDirection } from 'src/repositories/partner.repository';
import { PartnerService } from 'src/services/partner.service';
import { AuthFactory } from 'test/factories/auth.factory';
import { PartnerFactory } from 'test/factories/partner.factory';
import { UserFactory } from 'test/factories/user.factory';
import { getForPartner } from 'test/mappers';
import { newTestService, ServiceMocks } from 'test/utils';
import { vitest } from 'vitest';

describe(PartnerService.name, () => {
  let sut: PartnerService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PartnerService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('search', () => {
    it("should return a list of partners with whom I've shared my library", async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const sharedWithUser2 = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const sharedWithUser1 = PartnerFactory.from().sharedBy(user2).sharedWith(user1).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.getAll.mockResolvedValue([getForPartner(sharedWithUser1), getForPartner(sharedWithUser2)]);

      await expect(sut.search(auth, { direction: PartnerDirection.SharedBy })).resolves.toBeDefined();
      expect(mocks.partner.getAll).toHaveBeenCalledWith(user1.id);
    });

    it('should return a list of partners who have shared their libraries with me', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const sharedWithUser2 = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const sharedWithUser1 = PartnerFactory.from().sharedBy(user2).sharedWith(user1).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.getAll.mockResolvedValue([getForPartner(sharedWithUser1), getForPartner(sharedWithUser2)]);
      await expect(sut.search(auth, { direction: PartnerDirection.SharedWith })).resolves.toBeDefined();
      expect(mocks.partner.getAll).toHaveBeenCalledWith(user1.id);
    });
  });

  describe('create', () => {
    it('should create a new partner', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.get.mockResolvedValue(void 0);
      mocks.partner.create.mockResolvedValue(getForPartner(partner));

      await expect(sut.create(auth, { sharedWithId: user2.id })).resolves.toBeDefined();

      expect(mocks.partner.create).toHaveBeenCalledWith({
        sharedById: partner.sharedById,
        sharedWithId: partner.sharedWithId,
      });
    });

    it('should throw an error when the partner already exists', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.get.mockResolvedValue(getForPartner(partner));

      await expect(sut.create(auth, { sharedWithId: user2.id })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.partner.create).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should remove a partner', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.get.mockResolvedValue(getForPartner(partner));

      await sut.remove(auth, user2.id);

      expect(mocks.partner.remove).toHaveBeenCalledWith({ sharedById: user1.id, sharedWithId: user2.id });
    });

    it('should throw an error when the partner does not exist', async () => {
      const user2 = UserFactory.create();
      const auth = AuthFactory.create();

      mocks.partner.get.mockResolvedValue(void 0);

      await expect(sut.remove(auth, user2.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.partner.remove).not.toHaveBeenCalled();
    });

    it('Phase 6: should force a session reset when the sharee still has a flagged library from this owner', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const auth = AuthFactory.create({ id: user1.id });

      // First call (the existence check) finds the partner; the SAME mock answers the post-removal
      // check inside resolveSharedLibraryTransition too (mocks don't model DB state transitions), so
      // this must be a mockResolvedValueOnce to accurately simulate "the partner is now gone".
      mocks.partner.get.mockResolvedValueOnce(getForPartner(partner)).mockResolvedValue(void 0);
      (mocks.sync as any).sharedLibrary = {
        getFlaggedShares: vitest.fn().mockResolvedValue([{ ownerId: user1.id }]),
      };
      mocks.session.markPendingSyncReset.mockResolvedValue(void 0);

      await sut.remove(auth, user2.id);

      expect(mocks.partner.remove).toHaveBeenCalledWith({ sharedById: user1.id, sharedWithId: user2.id });
      expect(mocks.session.markPendingSyncReset).toHaveBeenCalledWith(user2.id);
    });

    it('Phase 6: should not force a reset when the sharee has no flagged library from this owner', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.get.mockResolvedValueOnce(getForPartner(partner)).mockResolvedValue(void 0);
      (mocks.sync as any).sharedLibrary = { getFlaggedShares: vitest.fn().mockResolvedValue([]) };

      await sut.remove(auth, user2.id);

      expect(mocks.session.markPendingSyncReset).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should require access', async () => {
      const user2 = UserFactory.create();
      const auth = AuthFactory.create();

      await expect(sut.update(auth, user2.id, { inTimeline: false })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should update partner', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.access.partner.checkUpdateAccess.mockResolvedValue(new Set([user2.id]));
      mocks.partner.update.mockResolvedValue(getForPartner(partner));

      await expect(sut.update(auth, user2.id, { inTimeline: true })).resolves.toBeDefined();
      expect(mocks.partner.update).toHaveBeenCalledWith(
        { sharedById: user2.id, sharedWithId: user1.id },
        { inTimeline: true },
      );
    });
  });
});
