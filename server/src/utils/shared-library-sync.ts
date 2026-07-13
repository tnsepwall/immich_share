import { PartnerRepository } from 'src/repositories/partner.repository';
import { SessionRepository } from 'src/repositories/session.repository';
import { SyncRepository } from 'src/repositories/sync.repository';

/**
 * Phase 6 (mobile pseudo-partner projection via the v2 sync protocol) - the ONE place that decides
 * what a library-share/partner transition means for a sharee's mobile sync state. Every trigger point
 * in the transition matrix (FEATURE-PLAN-phase6-mobile-projection.md §4) funnels through
 * `resolveSharedLibraryTransition` so the rule is never duplicated or allowed to drift between call
 * sites:
 *
 *   - LibraryService.updateMyShare (flag true -> false)
 *   - LibraryService.removeUser (unshare)
 *   - LibraryService.delete (library soft-delete, treated the same as unshare for every affected sharee)
 *   - UserService.handleUserDelete (owner hard-delete, same as unshare for every affected sharee)
 *   - PartnerService.remove (real partner deleted)
 *   - SyncService's own PartnerDeleteV1 projection arm (driven by library_user_audit rows) asks the
 *     SAME question to decide whether an audit row is actually delete-worthy right now, rather than
 *     stale (superseded by a later re-share, a real partner, or another still-flagged library).
 *
 * Outcomes:
 *   - 'none'  - a real partner (O->U) currently exists. The real sync arm already streams every one of
 *               the owner's assets and owns the (sharedById, sharedWithId) partner row; the projection
 *               must never interfere (plan §5's #1 invariant).
 *   - 'reset' - no real partner, but U still has >=1 OTHER flagged library from O. That other library's
 *               pseudo-partner relationship must keep working, so we cannot emit a plain PartnerDeleteV1
 *               (it would wipe a still-valid relationship) - instead force a full clean re-sync so the
 *               phone converges on the new, smaller scope.
 *   - 'delete' - no real partner and no remaining flagged library from O. The pseudo-partner relationship
 *               itself should stop existing on the phone; a PartnerDeleteV1 for (O, U) is correct and
 *               sufficient (SyncService emits it from the sync stream side).
 */
export type SharedLibraryTransitionOutcome = 'none' | 'reset' | 'delete';

export type SharedLibraryTransitionDeps = {
  partnerRepository: PartnerRepository;
  syncRepository: SyncRepository;
};

export type SharedLibraryTransitionEvent = {
  /** The library owner (the pseudo-partner's "sharedById"). */
  ownerId: string;
  /** The sharee (the pseudo-partner's "sharedWithId"). */
  userId: string;
};

export const resolveSharedLibraryTransition = async (
  { partnerRepository, syncRepository }: SharedLibraryTransitionDeps,
  { ownerId, userId }: SharedLibraryTransitionEvent,
): Promise<SharedLibraryTransitionOutcome> => {
  // Sequential, not Promise.all, and deliberately so: a real partner makes the outcome 'none'
  // regardless of flagged-share state, so short-circuit before ever touching
  // syncRepository.sharedLibrary - the common case for any caller unrelated to library sharing (most
  // PartnerService/LibraryService mutations) never has to reach it at all.
  const realPartner = await partnerRepository.get({ sharedById: ownerId, sharedWithId: userId });
  if (realPartner) {
    return 'none';
  }

  const flaggedShares = await syncRepository.sharedLibrary.getFlaggedShares(userId);

  const hasRemainingFlaggedShare = flaggedShares.some((share) => share.ownerId === ownerId);
  return hasRemainingFlaggedShare ? 'reset' : 'delete';
};

/**
 * Called from mutation call sites (never from the sync stream itself). Triggers a full sync reset for
 * every one of the sharee's sessions when - and only when - the transition resolves to 'reset'. The
 * 'delete' outcome is deliberately NOT actioned here: it is left for the sharee's next natural sync,
 * where SyncService emits PartnerDeleteV1 from the library_user_audit trail (§2.7/§3.2) - forcing a
 * reset for a plain "last library unshared" event would work but is unnecessary (a reset means "wipe
 * and fully re-sync everything," which is strictly more expensive than a single targeted delete event).
 */
export const maybeResetForSharedLibraryTransition = async (
  deps: SharedLibraryTransitionDeps & { sessionRepository: SessionRepository },
  event: SharedLibraryTransitionEvent,
): Promise<boolean> => {
  const outcome = await resolveSharedLibraryTransition(deps, event);
  if (outcome !== 'reset') {
    return false;
  }

  await deps.sessionRepository.markPendingSyncReset(event.userId);
  return true;
};
