<script lang="ts">
  // Compact "people" summary for a shared-library Editor, shown by DetailPanel.svelte in place of
  // (never alongside) DetailPanelPeople - which is owner-only and reads the owner's account-wide
  // `faceManager` store. This component reads exclusively from `getLibraryAssetFaces`, so an
  // Editor only ever sees faces/people reachable through this library, never the owner's full
  // people list. Clicking the pencil opens LibraryFaceEditSidePanel for the actual face-labeling
  // interactions (reassign, create-and-assign, manual face box, rename).
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { getLibraryAssetFaces, type LibraryFaceResponseDto } from '$lib/api/library-share';
  import { cropFaceThumbnail } from '$lib/utils/people-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';
  import { IconButton, Text } from '@immich/ui';
  import { mdiPencil } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    libraryId: string;
    refreshToken?: number;
    onOpenEditor: () => void;
  }

  let { asset, libraryId, refreshToken = 0, onOpenEditor }: Props = $props();

  let faces: LibraryFaceResponseDto[] = $state([]);
  let isLoading = $state(false);

  const assignedPeople = $derived(
    // one row per distinct assigned person on this asset (a person may have more than one face here)
    [...new Map(faces.filter((face) => face.person).map((face) => [face.person!.id, face])).values()],
  );

  const loadFaces = async () => {
    isLoading = true;
    try {
      faces = await getLibraryAssetFaces({ libraryId, assetId: asset.id });
    } catch (error) {
      handleError(error, $t('errors.cant_get_faces'));
      faces = [];
    } finally {
      isLoading = false;
    }
  };

  $effect(() => {
    void asset.id;
    void libraryId;
    void refreshToken;
    void loadFaces();
  });

  const thumbnailUrl = (face: LibraryFaceResponseDto) =>
    cropFaceThumbnail(face, getAssetMediaUrl({ id: face.assetId, size: AssetMediaSize.Preview }));
</script>

<section class="px-4 pt-4 text-sm">
  <div class="flex h-10 w-full items-center justify-between">
    <Text size="small" color="muted">{$t('people')}</Text>
    <IconButton
      aria-label={$t('edit_people')}
      icon={mdiPencil}
      size="medium"
      shape="round"
      color="secondary"
      variant="ghost"
      onclick={onOpenEditor}
    />
  </div>

  {#if !isLoading && assignedPeople.length > 0}
    <div class="mt-2 grid {assignedPeople.length <= 6 ? 'grid-cols-3 gap-3' : 'grid-cols-4 gap-2'}">
      {#each assignedPeople as face (face.id)}
        {#await thumbnailUrl(face) then url}
          <button type="button" class="group text-start outline-none" onclick={onOpenEditor}>
            <ImageThumbnail
              curve
              shadow
              url={url ?? '/src/lib/assets/no-thumbnail.png'}
              altText={face.person!.name}
              title={face.person!.name}
              widthStyle="100%"
            />
            <p class="mt-1 truncate font-medium" title={face.person!.name}>{face.person!.name}</p>
          </button>
        {/await}
      {/each}
    </div>
  {/if}
</section>
