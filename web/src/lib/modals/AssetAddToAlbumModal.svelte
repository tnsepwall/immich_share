<script lang="ts">
  import AlbumPickerModal from '$lib/modals/AlbumPickerModal.svelte';
  import { addAssetsToAlbums } from '$lib/services/album.service';
  import { type AlbumResponseDto } from '@immich/sdk';

  type Props = {
    assetIds: string[];
    onClose: () => void;
    /**
     * Restrict the picker to albums owned by the current user. Used from the shared-library
     * browse route: a recipient may only add a library-derived asset to an album they own (never
     * one merely shared with them), since the server's `LibraryAssetAddToAlbum` grant requires
     * album ownership - see FEATURE-PLAN-shared-external-libraries.md §2 "Derived album/link
     * access". Defaults to false everywhere else, so existing callers are unaffected.
     */
    restrictToOwnedAlbums?: boolean;
  };

  const { assetIds, onClose, restrictToOwnedAlbums = false }: Props = $props();

  const handleClose = async (albums?: AlbumResponseDto[]) => {
    const albumIds = (albums ?? []).map(({ id }) => id);
    if (albumIds.length === 0) {
      onClose();
      return;
    }

    const success = await addAssetsToAlbums(albumIds, assetIds, { notify: true });
    if (success) {
      onClose();
    }
  };
</script>

<AlbumPickerModal onClose={handleClose} {restrictToOwnedAlbums} />
