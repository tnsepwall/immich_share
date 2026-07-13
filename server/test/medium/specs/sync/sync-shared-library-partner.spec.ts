import { Kysely } from 'kysely';
import { SyncEntityType, SyncRequestType } from 'src/enum';
import { LibraryRepository } from 'src/repositories/library.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { SessionRepository } from 'src/repositories/session.repository';
import { SyncRepository } from 'src/repositories/sync.repository';
import { DB } from 'src/schema';
import { maybeResetForSharedLibraryTransition } from 'src/utils/shared-library-sync';
import { SyncTestContext } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

// Phase 6: mobile pseudo-partner projection. Each library owner O with >=1 library shared to user U
// where library_user.inTimeline = true is presented to U's sync stream as a pseudo SyncPartnerV1,
// through the EXISTING PartnersV1 handler/checkpoint (sync.service.ts#syncPartnersV1) - no new sync
// entity or request types. See FEATURE-PLAN-phase6-mobile-projection.md §3.1/§3.2/§4.

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(`${SyncEntityType.PartnerV1} (shared library projection)`, () => {
  it('should project a flagged library share as a pseudo partner', async () => {
    const { auth, ctx } = await setup();
    const { user: owner } = await ctx.newUser();
    const { library } = await ctx.newLibrary({ ownerId: owner.id });
    const { libraryUser } = await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

    const response = await ctx.syncStream(auth, [SyncRequestType.PartnersV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: { sharedById: owner.id, sharedWithId: auth.user.id, inTimeline: true },
        type: SyncEntityType.PartnerV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    expect(libraryUser.timelineEnabledId).not.toBeNull();

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnersV1]);
  });

  it('should NOT project a share whose inTimeline flag is off', async () => {
    const { auth, ctx } = await setup();
    const { user: owner } = await ctx.newUser();
    const { library } = await ctx.newLibrary({ ownerId: owner.id });
    await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: false });

    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnersV1]);
  });

  it('should dedupe multiple flagged libraries from the same owner into one pseudo partner', async () => {
    const { auth, ctx } = await setup();
    const { user: owner } = await ctx.newUser();
    const { library: libraryA } = await ctx.newLibrary({ ownerId: owner.id });
    const { library: libraryB } = await ctx.newLibrary({ ownerId: owner.id });
    await ctx.newLibraryUser({ libraryId: libraryA.id, userId: auth.user.id, inTimeline: true });
    await ctx.newLibraryUser({ libraryId: libraryB.id, userId: auth.user.id, inTimeline: true });

    const response = await ctx.syncStream(auth, [SyncRequestType.PartnersV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: { sharedById: owner.id, sharedWithId: auth.user.id, inTimeline: true },
        type: SyncEntityType.PartnerV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });

  it('should suppress the pseudo partner when a real partner already exists (real partner wins)', async () => {
    const { auth, ctx } = await setup();
    const { user: owner } = await ctx.newUser();
    await ctx.newPartner({ sharedById: owner.id, sharedWithId: auth.user.id, inTimeline: false });
    const { library } = await ctx.newLibrary({ ownerId: owner.id });
    await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

    const response = await ctx.syncStream(auth, [SyncRequestType.PartnersV1]);
    // Only ONE PartnerV1 (the real one, carrying the OWNER's real inTimeline value), never a duplicate
    // or a pseudo-partner entry for the same (owner, user) pair.
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: { sharedById: owner.id, sharedWithId: auth.user.id, inTimeline: false },
        type: SyncEntityType.PartnerV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });

  it('regression: byte-identical real-partner-only stream when no shares exist at all', async () => {
    const { auth, ctx } = await setup();
    const { user: owner } = await ctx.newUser();
    const { partner } = await ctx.newPartner({ sharedById: owner.id, sharedWithId: auth.user.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.PartnersV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: { sharedById: partner.sharedById, sharedWithId: partner.sharedWithId, inTimeline: partner.inTimeline },
        type: SyncEntityType.PartnerV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });

  it('should emit PartnerDeleteV1 once the last flagged library from an owner is unshared', async () => {
    const { auth, ctx } = await setup();
    const libraryRepo = ctx.get(LibraryRepository);
    const { user: owner } = await ctx.newUser();
    const { library } = await ctx.newLibrary({ ownerId: owner.id });
    await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

    const response = await ctx.syncStream(auth, [SyncRequestType.PartnersV1]);
    await ctx.syncAckAll(auth, response);

    await libraryRepo.removeUser(library.id, auth.user.id);

    const newResponse = await ctx.syncStream(auth, [SyncRequestType.PartnersV1]);
    expect(newResponse).toEqual([
      {
        ack: expect.any(String),
        data: { sharedById: owner.id, sharedWithId: auth.user.id },
        type: SyncEntityType.PartnerDeleteV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, newResponse);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnersV1]);
  });

  it('should NOT emit PartnerDeleteV1 when another flagged library from the same owner remains (reset instead)', async () => {
    const { auth, ctx } = await setup();
    const libraryRepo = ctx.get(LibraryRepository);
    const sessionRepo = ctx.get(SessionRepository);
    const { user: owner } = await ctx.newUser();
    const { library: libraryA } = await ctx.newLibrary({ ownerId: owner.id });
    const { library: libraryB } = await ctx.newLibrary({ ownerId: owner.id });
    await ctx.newLibraryUser({ libraryId: libraryA.id, userId: auth.user.id, inTimeline: true });
    await ctx.newLibraryUser({ libraryId: libraryB.id, userId: auth.user.id, inTimeline: true });

    const response = await ctx.syncStream(auth, [SyncRequestType.PartnersV1]);
    await ctx.syncAckAll(auth, response);

    await libraryRepo.removeUser(libraryA.id, auth.user.id);

    // The audit-driven delete path must NOT fire (libraryB is still flagged) - verified by asking the
    // exact transition decision the mutation-time hook uses, against real Postgres.
    const outcome = await maybeResetForSharedLibraryTransition(
      {
        partnerRepository: ctx.get(PartnerRepository),
        syncRepository: ctx.get(SyncRepository),
        sessionRepository: sessionRepo,
      },
      { ownerId: owner.id, userId: auth.user.id },
    );
    expect(outcome).toBe(true);
    expect(await sessionRepo.isPendingSyncReset(auth.session!.id)).toBe(true);

    // And the sync stream itself never emits a stray PartnerDeleteV1 for this pair either.
    await sessionRepo.update(auth.session!.id, { isPendingSyncReset: false });
    const newResponse = await ctx.syncStream(auth, [SyncRequestType.PartnersV1]);
    expect(newResponse).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: SyncEntityType.PartnerDeleteV1 })]),
    );
  });

  it('matrix row: real partner deleted while a flagged library remains -> reset', async () => {
    const { auth, ctx } = await setup();
    const partnerRepo = ctx.get(PartnerRepository);
    const sessionRepo = ctx.get(SessionRepository);
    const { user: owner } = await ctx.newUser();
    const { partner } = await ctx.newPartner({ sharedById: owner.id, sharedWithId: auth.user.id });
    const { library } = await ctx.newLibrary({ ownerId: owner.id });
    await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

    await partnerRepo.remove(partner);

    const outcome = await maybeResetForSharedLibraryTransition(
      { partnerRepository: partnerRepo, syncRepository: ctx.get(SyncRepository), sessionRepository: sessionRepo },
      { ownerId: owner.id, userId: auth.user.id },
    );

    expect(outcome).toBe(true);
    expect(await sessionRepo.isPendingSyncReset(auth.session!.id)).toBe(true);
  });

  it('matrix row: library soft-deleted while it was the only flagged share -> no reset needed, pseudo partner stops appearing', async () => {
    const { auth, ctx } = await setup();
    const { user: owner } = await ctx.newUser();
    const { library } = await ctx.newLibrary({ ownerId: owner.id });
    await ctx.newLibraryUser({ libraryId: library.id, userId: auth.user.id, inTimeline: true });

    await ctx.database.updateTable('library').set({ deletedAt: new Date() }).where('id', '=', library.id).execute();

    // getFlaggedShares' live-library join must exclude the share immediately - no pseudo partner
    // upsert should appear on the very next sync.
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnersV1]);
  });
});
