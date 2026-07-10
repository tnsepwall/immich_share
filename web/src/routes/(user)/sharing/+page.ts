import { PartnerDirection, getAllAlbums, getLibrariesSharedWithMe, getMyLibraries, getPartners } from '@immich/sdk';
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
