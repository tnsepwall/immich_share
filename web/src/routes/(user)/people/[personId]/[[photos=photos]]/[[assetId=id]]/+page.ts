import { getPerson, getPersonStatistics, type PersonStatisticsResponseDto } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ params, url }) => {
  await authenticate(url);

  // Statistics are owner-only (Phase 5, plan §5.4) - for a person reached through a shared library the
  // call fails by design, so fall back to a shared-friendly display instead of dead-ending the page.
  const [person, statistics] = await Promise.all([
    getPerson({ id: params.personId }),
    getPersonStatistics({ id: params.personId }).catch(() => null as PersonStatisticsResponseDto | null),
  ]);
  const $t = await getFormatter();

  return {
    person,
    statistics,
    meta: {
      title: person.name || $t('person'),
    },
  };
}) satisfies PageLoad;
