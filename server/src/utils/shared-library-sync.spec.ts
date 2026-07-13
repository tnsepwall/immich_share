import { PartnerRepository } from 'src/repositories/partner.repository';
import { SessionRepository } from 'src/repositories/session.repository';
import { SyncRepository } from 'src/repositories/sync.repository';
import { maybeResetForSharedLibraryTransition, resolveSharedLibraryTransition } from 'src/utils/shared-library-sync';
import { factory } from 'test/small.factory';
import { Mocked, vi } from 'vitest';

// Shared by both describe blocks below - a pure factory with no closure dependencies, so it lives at
// module scope rather than being redefined per describe block (unicorn/consistent-function-scoping).
const setup = () => {
  const partnerRepository = { get: vi.fn() } as unknown as Mocked<PartnerRepository>;
  const syncRepository = {
    sharedLibrary: { getFlaggedShares: vi.fn() },
  } as unknown as Mocked<SyncRepository> & { sharedLibrary: { getFlaggedShares: ReturnType<typeof vi.fn> } };
  const sessionRepository = { markPendingSyncReset: vi.fn() } as unknown as Mocked<SessionRepository>;
  return { partnerRepository, syncRepository, sessionRepository };
};

// Matrix-row specs for FEATURE-PLAN-phase6-mobile-projection.md §4. Each row is a distinct
// (real partner exists?, remaining flagged share from the same owner?) combination; this is the ONE
// place the decision is made, so every mutation call site (LibraryService.updateMyShare/removeUser/
// delete, PartnerService.remove, UserService.handleUserDelete) and the sync stream's own
// PartnerDeleteV1 projection all inherit correctness from these specs.
describe('resolveSharedLibraryTransition', () => {
  const ownerId = factory.uuid();
  const userId = factory.uuid();

  it('matrix row: real partner exists, other flagged shares remain -> none', async () => {
    const { partnerRepository, syncRepository } = setup();
    partnerRepository.get.mockResolvedValue({ sharedById: ownerId, sharedWithId: userId } as any);
    syncRepository.sharedLibrary.getFlaggedShares.mockResolvedValue([
      { libraryId: factory.uuid(), ownerId, timelineEnabledId: factory.uuid(), updateId: factory.uuid() },
    ]);

    const outcome = await resolveSharedLibraryTransition({ partnerRepository, syncRepository }, { ownerId, userId });

    expect(outcome).toBe('none');
  });

  it('matrix row: real partner exists, zero flagged shares remain -> none', async () => {
    const { partnerRepository, syncRepository } = setup();
    partnerRepository.get.mockResolvedValue({ sharedById: ownerId, sharedWithId: userId } as any);
    syncRepository.sharedLibrary.getFlaggedShares.mockResolvedValue([]);

    const outcome = await resolveSharedLibraryTransition({ partnerRepository, syncRepository }, { ownerId, userId });

    expect(outcome).toBe('none');
  });

  it('matrix row: no real partner, another flagged library from the same owner remains -> reset', async () => {
    const { partnerRepository, syncRepository } = setup();
    partnerRepository.get.mockResolvedValue(void 0);
    syncRepository.sharedLibrary.getFlaggedShares.mockResolvedValue([
      { libraryId: factory.uuid(), ownerId, timelineEnabledId: factory.uuid(), updateId: factory.uuid() },
    ]);

    const outcome = await resolveSharedLibraryTransition({ partnerRepository, syncRepository }, { ownerId, userId });

    expect(outcome).toBe('reset');
  });

  it('matrix row: no real partner, no remaining flagged share from this owner -> delete', async () => {
    const { partnerRepository, syncRepository } = setup();
    partnerRepository.get.mockResolvedValue(void 0);
    syncRepository.sharedLibrary.getFlaggedShares.mockResolvedValue([]);

    const outcome = await resolveSharedLibraryTransition({ partnerRepository, syncRepository }, { ownerId, userId });

    expect(outcome).toBe('delete');
  });

  it('a flagged share from a DIFFERENT owner does not count as "remaining" -> delete, not reset', async () => {
    const { partnerRepository, syncRepository } = setup();
    const otherOwnerId = factory.uuid();
    partnerRepository.get.mockResolvedValue(void 0);
    syncRepository.sharedLibrary.getFlaggedShares.mockResolvedValue([
      { libraryId: factory.uuid(), ownerId: otherOwnerId, timelineEnabledId: factory.uuid(), updateId: factory.uuid() },
    ]);

    const outcome = await resolveSharedLibraryTransition({ partnerRepository, syncRepository }, { ownerId, userId });

    expect(outcome).toBe('delete');
  });

  it('checks the real partner in the (ownerId -> userId) direction, not the reverse', async () => {
    const { partnerRepository, syncRepository } = setup();
    partnerRepository.get.mockResolvedValue(void 0);
    syncRepository.sharedLibrary.getFlaggedShares.mockResolvedValue([]);

    await resolveSharedLibraryTransition({ partnerRepository, syncRepository }, { ownerId, userId });

    expect(partnerRepository.get).toHaveBeenCalledWith({ sharedById: ownerId, sharedWithId: userId });
  });
});

describe('maybeResetForSharedLibraryTransition', () => {
  const ownerId = factory.uuid();
  const userId = factory.uuid();

  it('triggers a session reset only for the "reset" outcome', async () => {
    const { partnerRepository, syncRepository, sessionRepository } = setup();
    partnerRepository.get.mockResolvedValue(void 0);
    syncRepository.sharedLibrary.getFlaggedShares.mockResolvedValue([
      { libraryId: factory.uuid(), ownerId, timelineEnabledId: factory.uuid(), updateId: factory.uuid() },
    ]);

    const result = await maybeResetForSharedLibraryTransition(
      { partnerRepository, syncRepository, sessionRepository },
      { ownerId, userId },
    );

    expect(result).toBe(true);
    expect(sessionRepository.markPendingSyncReset).toHaveBeenCalledWith(userId);
  });

  it('does not reset for the "none" outcome (real partner exists)', async () => {
    const { partnerRepository, syncRepository, sessionRepository } = setup();
    partnerRepository.get.mockResolvedValue({ sharedById: ownerId, sharedWithId: userId } as any);
    syncRepository.sharedLibrary.getFlaggedShares.mockResolvedValue([
      { libraryId: factory.uuid(), ownerId, timelineEnabledId: factory.uuid(), updateId: factory.uuid() },
    ]);

    const result = await maybeResetForSharedLibraryTransition(
      { partnerRepository, syncRepository, sessionRepository },
      { ownerId, userId },
    );

    expect(result).toBe(false);
    expect(sessionRepository.markPendingSyncReset).not.toHaveBeenCalled();
  });

  it('does not reset for the "delete" outcome (last flagged library, no real partner)', async () => {
    const { partnerRepository, syncRepository, sessionRepository } = setup();
    partnerRepository.get.mockResolvedValue(void 0);
    syncRepository.sharedLibrary.getFlaggedShares.mockResolvedValue([]);

    const result = await maybeResetForSharedLibraryTransition(
      { partnerRepository, syncRepository, sessionRepository },
      { ownerId, userId },
    );

    expect(result).toBe(false);
    expect(sessionRepository.markPendingSyncReset).not.toHaveBeenCalled();
  });
});
