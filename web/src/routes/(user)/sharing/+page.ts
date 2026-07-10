import { PartnerDirection, getAllAlbums, getPartners } from '@immich/sdk';
// TEMPORARY: shared-library endpoints aren't in the generated SDK yet - see web/src/lib/api/library-share.ts.
import { getLibrariesSharedWithMe, getMyLibraries } from '$lib/api/library-share';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const sharedAlbums = await getAllAlbums({ isShared: true });
  const partners = await getPartners({ direction: PartnerDirection.SharedWith });
  const myLibraries = await getMyLibraries();
  const sharedLibraries = await getLibrariesSharedWithMe();
  const $t = await getFormatter();

  return {
    sharedAlbums,
    partners,
    myLibraries,
    sharedLibraries,
    meta: {
      title: $t('sharing'),
    },
  };
}) satisfies PageLoad;
