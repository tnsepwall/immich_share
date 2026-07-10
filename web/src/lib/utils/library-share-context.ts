// TEMPORARY: this file is UI-only (no server DTOs live here), but it depends on the temporary
// `LibraryUserRole` type from web/src/lib/api/library-share.ts, which exists only because
// `packages/sdk` has not been regenerated for the shared-external-libraries feature yet. See that
// file's header comment for the full explanation.
import { LibraryUserRole } from '$lib/api/library-share';

/**
 * The role a user has when viewing a library through the shared-library browse route
 * (`web/src/routes/(user)/shared-libraries/[libraryId]/...`).
 *
 * `'owner'` is synthesized client-side - it never comes from the server - for a library owner
 * previewing their own library through this same route (see that route's `+page.ts` loader,
 * which checks `getMyLibraries()` before `getLibrariesSharedWithMe()`). Recipients get the real
 * `LibraryUserRole` ('viewer' or 'editor') from their `library_user` share row.
 */
export type LibraryViewerRole = 'owner' | LibraryUserRole;

/**
 * Capability context threaded through the asset viewer for an asset being viewed via a shared
 * library, alongside the existing `album`/`person` view-context props (see Timeline.svelte ->
 * TimelineAssetViewer.svelte -> AssetViewer.svelte). Lets viewer/detail-panel components branch on
 * "is this asset being viewed through a shared library, and if so as what role" without
 * re-deriving it from the route in several places.
 *
 * Read-side behavior (thumbnail/original/video/download) never needs to consult this - it's
 * already covered by the server's AssetView/AssetDownload access control (Phase 1). This context
 * only gates which WRITE-side UI (metadata editor, face-labeling panel) is shown, and which
 * write-side calls it makes (library-scoped endpoints vs. the owner-only ones).
 */
export type LibraryShareContext = {
  libraryId: string;
  role: LibraryViewerRole;
};

/** True only for a real recipient with the Editor role - never for the owner or a Viewer. */
export const isLibraryShareEditor = (context: LibraryShareContext | undefined | null): boolean =>
  context?.role === LibraryUserRole.Editor;

/** True when the current user is the library's owner previewing it through this route. */
export const isLibraryShareOwnerPreview = (context: LibraryShareContext | undefined | null): boolean =>
  context?.role === 'owner';
