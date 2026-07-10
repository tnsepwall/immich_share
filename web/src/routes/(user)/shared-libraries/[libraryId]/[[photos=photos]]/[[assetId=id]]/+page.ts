import { error } from '@sveltejs/kit';
// TEMPORARY: shared-library endpoints aren't in the generated SDK yet - see web/src/lib/api/library-share.ts.
import { getLibrariesSharedWithMe, getMyLibraries } from '$lib/api/library-share';
import { authenticate } from '$lib/utils/auth';
import type { LibraryViewerRole } from '$lib/utils/library-share-context';
import type { PageLoad } from './$types';

export const load = (async ({ params, url }) => {
  await authenticate(url);

  // A library owner can preview their own shared library through this same route, so both lists
  // are checked - `getMyLibraries()` first, since owning a library always wins over (theoretically
  // impossible, but not worth trusting) stale/overlapping share data.
  const [myLibraries, sharedLibraries] = await Promise.all([getMyLibraries(), getLibrariesSharedWithMe()]);

  const ownedLibrary = myLibraries.find((library) => library.id === params.libraryId);
  const sharedLibrary = ownedLibrary ? undefined : sharedLibraries.find((library) => library.id === params.libraryId);

  if (!ownedLibrary && !sharedLibrary) {
    error(404, 'Library not found');
  }

  const library = ownedLibrary ?? sharedLibrary!;
  const role: LibraryViewerRole = ownedLibrary ? 'owner' : sharedLibrary!.role;

  return {
    library,
    role,
    meta: {
      title: library.name,
    },
  };
}) satisfies PageLoad;
