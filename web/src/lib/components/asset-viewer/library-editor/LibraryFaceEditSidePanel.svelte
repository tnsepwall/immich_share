<script lang="ts">
  // Library-scoped equivalent of PersonSidePanel.svelte, shown by DetailPanel.svelte for a shared-
  // library Editor. Differences from the owner's panel (deliberate, per
  // FEATURE-PLAN-shared-external-libraries.md Step 13):
  //  - loads faces via `getLibraryAssetFaces` (library-scoped), never the owner's `getFaces`;
  //  - reassign/create-and-assign apply IMMEDIATELY when picked in LibraryFaceAssignSidePanel,
  //    rather than the owner panel's "select several changes, apply them all on Done" batching -
  //    a deliberate simplification since each library endpoint call is already a single atomic
  //    operation and there's no bulk variant to batch toward;
  //  - no delete-face control at all (owner-only per the Editor allowlist - see design decision 3).
  import { shortcut } from '$lib/actions/shortcut';
  import { getLibraryAssetFaces, type LibraryFaceResponseDto } from '$lib/api/library-share';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { cropFaceThumbnail } from '$lib/utils/people-utils';
  import { AssetMediaSize } from '@immich/sdk';
  import { Icon, IconButton, LoadingSpinner } from '@immich/ui';
  import { mdiAccountOff, mdiArrowLeftThin, mdiDraw, mdiPencil } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { linear } from 'svelte/easing';
  import { fly } from 'svelte/transition';
  import ImageThumbnail from '../../assets/thumbnail/ImageThumbnail.svelte';
  import LibraryFaceAssignSidePanel from './LibraryFaceAssignSidePanel.svelte';

  interface Props {
    assetId: string;
    libraryId: string;
    refreshToken?: number;
    onClose: () => void;
    onDrawFace: () => void;
  }

  let { assetId, libraryId, refreshToken = 0, onClose, onDrawFace }: Props = $props();

  let faces: LibraryFaceResponseDto[] = $state([]);
  let isLoading = $state(false);
  let editedFace: LibraryFaceResponseDto | undefined = $state();
  let showAssignPanel = $state(false);

  const loadFaces = async () => {
    isLoading = true;
    try {
      faces = await getLibraryAssetFaces({ libraryId, assetId });
    } catch (error) {
      handleError(error, $t('errors.cant_get_faces'));
      faces = [];
    } finally {
      isLoading = false;
    }
  };

  $effect(() => {
    void assetId;
    void libraryId;
    void refreshToken;
    void loadFaces();
  });

  const thumbnailUrl = (face: LibraryFaceResponseDto) =>
    cropFaceThumbnail(face, getAssetMediaUrl({ id: face.assetId, size: AssetMediaSize.Preview }));

  const handleFacePicker = (face: LibraryFaceResponseDto) => {
    editedFace = face;
    showAssignPanel = true;
  };

  const handleAssigned = () => {
    showAssignPanel = false;
    editedFace = undefined;
    void loadFaces();
  };
</script>

<svelte:document
  use:shortcut={{
    shortcut: { key: 'Escape' },
    onShortcut: () => {
      if (showAssignPanel) {
        showAssignPanel = false;
      } else {
        onClose();
      }
    },
  }}
/>

<section
  transition:fly={{ x: 360, duration: 100, easing: linear }}
  class="absolute top-0 h-full w-90 overflow-x-hidden bg-light p-2 dark:text-immich-dark-fg"
>
  <div class="flex place-items-center justify-between gap-2">
    <div class="flex items-center gap-2">
      <IconButton
        shape="round"
        color="secondary"
        variant="ghost"
        icon={mdiArrowLeftThin}
        aria-label={$t('back')}
        onclick={onClose}
      />
      <p class="flex text-lg text-immich-fg dark:text-immich-dark-fg">{$t('edit_faces')}</p>
    </div>
    <IconButton
      aria-label={$t('add_a_face')}
      icon={mdiDraw}
      shape="round"
      color="secondary"
      variant="ghost"
      onclick={onDrawFace}
    />
  </div>

  <div class="p-4 text-sm">
    <div class="mt-4 flex flex-wrap gap-2">
      {#if isLoading}
        <div class="flex w-full justify-center">
          <LoadingSpinner />
        </div>
      {:else}
        {#each faces as face (face.id)}
          {@const personName = face.person ? face.person.name : $t('face_unassigned')}
          <div class="relative h-29 w-24">
            <div class="absolute inset-s-0 top-0 size-22.5">
              {#await thumbnailUrl(face)}
                <ImageThumbnail
                  curve
                  shadow
                  url="/src/lib/assets/no-thumbnail.png"
                  altText={personName}
                  title={personName}
                  widthStyle="90px"
                  heightStyle="90px"
                />
              {:then url}
                <ImageThumbnail
                  curve
                  shadow
                  url={url ?? '/src/lib/assets/no-thumbnail.png'}
                  altText={personName}
                  title={personName}
                  widthStyle="90px"
                  heightStyle="90px"
                />
              {/await}

              <p class="relative mt-1 truncate font-medium" title={personName}>
                <span class={face.person ? '' : 'dark:text-gray-500'}>{personName}</span>
              </p>

              <div class="absolute inset-e-[-3px] top-[-3px] size-5 rounded-full">
                <IconButton
                  shape="round"
                  color="primary"
                  icon={mdiPencil}
                  aria-label={$t('select_new_face')}
                  size="small"
                  class="absolute inset-s-1/2 top-1/2 translate-[-50%] transform"
                  onclick={() => handleFacePicker(face)}
                />
              </div>
              {#if !face.person}
                <div class="absolute inset-e-8 top-[-3px] size-5 rounded-full">
                  <div
                    class="absolute inset-s-1/2 top-1/2 flex translate-[-50%] transform place-content-center place-items-center rounded-full bg-[#d3d3d3] p-1 transition-all"
                  >
                    <Icon color="primary" icon={mdiAccountOff} aria-hidden size="24" />
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</section>

{#if showAssignPanel && editedFace}
  <LibraryFaceAssignSidePanel
    {libraryId}
    editedFace={editedFace!}
    onClose={() => (showAssignPanel = false)}
    onAssigned={handleAssigned}
  />
{/if}
