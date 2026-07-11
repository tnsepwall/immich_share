<script lang="ts">
  import empty2Url from '$lib/assets/empty-2.svg';
  import Albums from '$lib/components/album-page/AlbumsList.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import SettingSwitch from '$lib/components/shared-components/settings/SettingSwitch.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import LibraryShareModal from '$lib/modals/LibraryShareModal.svelte';
  import { Route } from '$lib/route';
  import { getAlbumsActions } from '$lib/services/album.service';
  import { getSharedLinksActions } from '$lib/services/shared-link.service';
  import {
    AlbumFilter,
    AlbumGroupBy,
    AlbumSortBy,
    AlbumViewMode,
    SortOrder,
    type AlbumViewSettings,
  } from '$lib/stores/preferences.store';
  import { libraryShareStore } from '$lib/stores/library-share-store.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { updateMyLibraryShare, type LibraryResponseDto, type SharedLibraryResponseDto } from '@immich/sdk';
  import { Button, IconButton, modalManager, toastManager } from '@immich/ui';
  import { mdiInformationOutline, mdiShareVariantOutline } from '@mdi/js';
  import { invalidateAll } from '$app/navigation';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  const openLibraryShareModal = async (library: LibraryResponseDto | SharedLibraryResponseDto) => {
    await modalManager.show(LibraryShareModal, { library });
    // The modal manages its own share list locally; refresh the loader data so the hub (and
    // asset counts / owned-library share counts) reflect any add/remove/leave that happened. Also
    // invalidate the session-cached share-role lookup (§6.3) - a role change or leave here could
    // change what the main-timeline asset viewer derives for this library going forward.
    await invalidateAll();
    libraryShareStore.invalidate();
  };

  // Sharee-controlled opt-in (§0.1/§6.1): mirrors PartnerSettings.svelte's
  // handleShowOnTimelineChanged - bind:checked on the switch below already applies the change
  // optimistically, so on failure we just revert it and surface the error.
  const handleShowInTimelineChanged = async (library: SharedLibraryResponseDto, inTimeline: boolean) => {
    try {
      const updated = await updateMyLibraryShare({ id: library.id, libraryUserSelfUpdateDto: { inTimeline } });
      library.inTimeline = updated.inTimeline;
      toastManager.primary($t('saved_settings'));
    } catch (error) {
      library.inTimeline = !inTimeline;
      handleError(error, $t('errors.unable_to_update_timeline_display_status'));
    }
  };

  const settings: AlbumViewSettings = {
    view: AlbumViewMode.Cover,
    filter: AlbumFilter.Shared,
    groupBy: AlbumGroupBy.None,
    groupOrder: SortOrder.Desc,
    sortBy: AlbumSortBy.MostRecentPhoto,
    sortOrder: SortOrder.Desc,
    collapsedGroups: {},
  };

  const { Create: CreateAlbum } = $derived(getAlbumsActions($t));
  const { ViewAll: ViewSharedLinks } = $derived(getSharedLinksActions($t));
</script>

<UserPageLayout title={data.meta.title} actions={[CreateAlbum, ViewSharedLinks]}>
  <div class="flex flex-col">
    {#if data.partners.length > 0}
      <div class="mt-2 mb-6">
        <div>
          <p class="mb-4 font-medium dark:text-immich-dark-fg">{$t('partners')}</p>
        </div>

        <div class="flex flex-row flex-wrap gap-4">
          {#each data.partners as partner (partner.id)}
            <a
              href={Route.viewPartner(partner)}
              class="flex gap-4 rounded-lg px-5 py-4 transition-all hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              <UserAvatar user={partner} size="lg" />
              <div class="text-start">
                <p class="text-immich-fg dark:text-immich-dark-fg">
                  {partner.name}
                </p>
                <p class="text-sm text-immich-fg/75 dark:text-immich-dark-fg/75">
                  {partner.email}
                </p>
              </div>
            </a>
          {/each}
        </div>
      </div>

      <hr class="mb-4 dark:border-immich-dark-gray" />
    {/if}

    {#if data.sharedLibraries.length > 0 || data.myLibraries.length > 0}
      <div class="mt-2 mb-6">
        <div>
          <p class="mb-4 font-medium dark:text-immich-dark-fg">{$t('shared_libraries')}</p>
        </div>

        {#if data.sharedLibraries.length > 0}
          <div class="flex flex-row flex-wrap gap-4">
            {#each data.sharedLibraries as library (library.id)}
              <div
                class="flex flex-col gap-2 rounded-lg border border-gray-200 px-5 py-3 transition-all dark:border-gray-800"
              >
                <div class="flex items-center gap-1">
                  <a
                    href={Route.viewSharedLibrary(library)}
                    class="flex grow gap-4 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700"
                  >
                    <UserAvatar user={library.owner} size="lg" />
                    <div class="text-start">
                      <p class="text-immich-fg dark:text-immich-dark-fg">
                        {library.name}
                      </p>
                      <p class="text-sm text-immich-fg/75 dark:text-immich-dark-fg/75">
                        {$t('shared_by_user', { values: { user: library.owner.name } })}
                      </p>
                    </div>
                  </a>
                  <IconButton
                    shape="round"
                    color="secondary"
                    variant="ghost"
                    size="small"
                    icon={mdiInformationOutline}
                    aria-label={$t('view_shared_library_details')}
                    onclick={() => openLibraryShareModal(library)}
                  />
                </div>
                <SettingSwitch
                  title={$t('show_shared_library_in_main_surfaces')}
                  bind:checked={library.inTimeline}
                  onToggle={(isChecked) => handleShowInTimelineChanged(library, isChecked)}
                />
              </div>
            {/each}
          </div>
        {/if}

        {#if data.myLibraries.length > 0}
          <div class="flex flex-col gap-2" class:mt-4={data.sharedLibraries.length > 0}>
            {#each data.myLibraries as library (library.id)}
              <div
                class="flex items-center justify-between gap-4 rounded-lg px-5 py-3 transition-all hover:bg-gray-200 dark:hover:bg-gray-700"
              >
                <div class="text-start">
                  <p class="text-immich-fg dark:text-immich-dark-fg">{library.name}</p>
                  <p class="text-sm text-immich-fg/75 dark:text-immich-dark-fg/75">
                    {$t('library_shared_with_count', { values: { count: library.sharedUsers?.length ?? 0 } })}
                  </p>
                </div>
                <Button
                  shape="round"
                  size="small"
                  color="secondary"
                  leadingIcon={mdiShareVariantOutline}
                  onclick={() => openLibraryShareModal(library)}
                >
                  {$t('share')}
                </Button>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <hr class="mb-4 dark:border-immich-dark-gray" />
    {/if}

    <div class="mt-2 mb-6">
      <div>
        <p class="mb-4 font-medium dark:text-immich-dark-fg">{$t('albums')}</p>
      </div>

      <div>
        <!-- Shared Album List -->
        <Albums sharedAlbums={data.sharedAlbums} userSettings={settings} showOwner>
          <!-- Empty List -->
          {#snippet empty()}
            <EmptyPlaceholder text={$t('no_shared_albums_message')} src={empty2Url} class="mx-auto mt-10" />
          {/snippet}
        </Albums>
      </div>
    </div>
  </div>
</UserPageLayout>
