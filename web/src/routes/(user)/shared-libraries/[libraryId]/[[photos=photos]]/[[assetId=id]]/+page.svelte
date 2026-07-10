<script lang="ts">
  import { goto } from '$app/navigation';
  // TEMPORARY: shared-library types aren't in the generated SDK yet - see web/src/lib/api/library-share.ts.
  import type { SharedLibraryResponseDto } from '$lib/api/library-share';
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import AssetAddToAlbumModal from '$lib/modals/AssetAddToAlbumModal.svelte';
  import { Route } from '$lib/route';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import type { LibraryShareContext } from '$lib/utils/library-share-context';
  import { AssetVisibility } from '@immich/sdk';
  import { ActionButton, CommandPaletteDefaultProvider, modalManager } from '@immich/ui';
  import { mdiArrowLeft } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const isOwnerPreview = $derived(data.role === 'owner');

  const libraryShare: LibraryShareContext = $derived({ libraryId: data.library.id, role: data.role });

  const options = $derived({
    libraryId: data.library.id,
    visibility: AssetVisibility.Timeline,
    // Deliberately no `withStacked` here: stacks are owner-only in v1 (the server forces
    // `withStacked=false` for non-owner requests and redacts stack fields from recipient asset
    // responses - see FEATURE-PLAN-shared-external-libraries.md §2), so this route never asks for
    // or renders stack grouping/navigation regardless of role.
  });

  const ownerName = $derived(
    isOwnerPreview
      ? authManager.authenticated
        ? authManager.user.name
        : ''
      : (data.library as SharedLibraryResponseDto).owner.name,
  );

  const handleEscape = () => {
    if (assetMultiSelectManager.selectionActive) {
      assetMultiSelectManager.clear();
      return;
    }
  };
</script>

<main class="relative h-dvh overflow-hidden px-2 pt-(--navbar-height) max-md:pt-(--navbar-height-md) md:px-6">
  <Timeline
    enableRouting={true}
    {options}
    {libraryShare}
    assetInteraction={assetMultiSelectManager}
    onEscape={handleEscape}
  />
</main>

{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    {@const Actions = getAssetBulkActions($t)}
    {@const AddToAlbum = isOwnerPreview
      ? Actions.AddToAlbum
      : {
          ...Actions.AddToAlbum,
          onAction: () =>
            modalManager.show(AssetAddToAlbumModal, {
              assetIds: assetMultiSelectManager.assets.map((asset) => asset.id),
              // A recipient may only add library-derived assets to an album they own (and the
              // server additionally rejects the insertion if that album already has a shared
              // link) - see FEATURE-PLAN-shared-external-libraries.md §2 "Derived album/link
              // access". Filter the picker up front rather than only surfacing the server error.
              restrictToOwnedAlbums: true,
            }),
        }}
    <CommandPaletteDefaultProvider name={$t('assets')} actions={[AddToAlbum]} />
    <ActionButton action={AddToAlbum} />
    <DownloadAction />
    <!-- Deliberately no CreateSharedLink: neither Viewer nor Editor holds AssetShare for a shared
    library (see design decision 3), so link creation always fails for a recipient - it isn't
    offered here at all. An owner previewing their own library keeps normal album/link privileges
    through the standard AddToAlbum action above, but shared-link creation from the multi-select
    bar isn't part of this preview route either; use the regular library-management UI instead. -->
  </AssetSelectControlBar>
{:else}
  <ControlAppBar backIcon={mdiArrowLeft} onClose={() => goto(Route.sharing())}>
    {#snippet leading()}
      <p class="whitespace-nowrap text-immich-fg dark:text-immich-dark-fg">
        {#if isOwnerPreview}
          {data.library.name}
        {:else}
          {$t('shared_library_owned_by', { values: { library: data.library.name, user: ownerName } })}
        {/if}
      </p>
    {/snippet}
  </ControlAppBar>
{/if}
