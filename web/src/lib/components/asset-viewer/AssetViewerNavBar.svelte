<script lang="ts">
  import ActionMenuItem from '$lib/components/ActionMenuItem.svelte';
  import type { OnAction, PreAction } from '$lib/components/asset-viewer/actions/action';
  import AddToStackAction from '$lib/components/asset-viewer/actions/AddToStackAction.svelte';
  import ArchiveAction from '$lib/components/asset-viewer/actions/ArchiveAction.svelte';
  import DeleteAction from '$lib/components/asset-viewer/actions/DeleteAction.svelte';
  import KeepThisDeleteOthersAction from '$lib/components/asset-viewer/actions/KeepThisDeleteOthers.svelte';
  import RatingAction from '$lib/components/asset-viewer/actions/RatingAction.svelte';
  import RemoveAssetFromStack from '$lib/components/asset-viewer/actions/RemoveAssetFromStack.svelte';
  import RestoreAction from '$lib/components/asset-viewer/actions/RestoreAction.svelte';
  import SetFeaturedPhotoAction from '$lib/components/asset-viewer/actions/SetPersonFeaturedAction.svelte';
  import SetStackPrimaryAsset from '$lib/components/asset-viewer/actions/SetStackPrimaryAsset.svelte';
  import SetVisibilityAction from '$lib/components/asset-viewer/actions/SetVisibilityAction.svelte';
  import UnstackAction from '$lib/components/asset-viewer/actions/UnstackAction.svelte';
  import LoadingDots from '$lib/components/LoadingDots.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import RemoveFromAlbumAction from '$lib/components/timeline/actions/RemoveFromAlbumAction.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { languageManager } from '$lib/managers/language-manager.svelte';
  import AssetAddToAlbumModal from '$lib/modals/AssetAddToAlbumModal.svelte';
  import { getAlbumAssetActions } from '$lib/services/album.service';
  import { getGlobalActions } from '$lib/services/app.service';
  import { getAssetActions } from '$lib/services/asset.service';
  import { getSharedLink, withoutIcons } from '$lib/utils';
  import type { OnUndoDelete } from '$lib/utils/actions';
  import type { LibraryShareContext } from '$lib/utils/library-share-context';
  import { isLibraryShareEditor, isLibraryShareOwnerPreview } from '$lib/utils/library-share-context';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    AssetTypeEnum,
    AssetVisibility,
    type AlbumResponseDto,
    type AssetResponseDto,
    type PersonResponseDto,
    type StackResponseDto,
  } from '@immich/sdk';
  import { ActionButton, CommandPaletteDefaultProvider, modalManager, Tooltip, type ActionItem } from '@immich/ui';
  import { mdiArrowLeft, mdiArrowRight, mdiDotsVertical, mdiPencilOutline, mdiVideoOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    album?: AlbumResponseDto | null;
    person?: PersonResponseDto | null;
    stack?: StackResponseDto | null;
    /** Set for the shared-library browse route only - see web/src/lib/utils/library-share-context.ts */
    libraryShare?: LibraryShareContext;
    preAction: PreAction;
    onAction: OnAction;
    onUndoDelete?: OnUndoDelete;
    onClose?: () => void;
    onRemoveFromAlbum?: (assetIds: string[]) => void;
    isPlayingOriginalVideo: boolean;
    setPlayOriginalVideo: (value: boolean) => void;
  }

  let {
    asset,
    album = null,
    person = null,
    stack = null,
    libraryShare,
    preAction,
    onAction,
    onUndoDelete = undefined,
    onClose,
    onRemoveFromAlbum,
    isPlayingOriginalVideo = false,
    setPlayOriginalVideo,
  }: Props = $props();

  const isOwner = $derived(authManager.authenticated && asset.ownerId === authManager.user.id);
  const isAlbumOwner = $derived(authManager.authenticated && album?.albumUsers[0].user.id === authManager.user.id);
  const isLocked = $derived(asset.visibility === AssetVisibility.Locked);

  const { Cast } = $derived(getGlobalActions($t));

  const Close: ActionItem = $derived({
    title: $t('go_back'),
    icon: languageManager.rtl ? mdiArrowRight : mdiArrowLeft,
    $if: () => !!onClose && !assetViewerManager.isFaceEditMode && !assetViewerManager.isEditFacesPanelOpen,
    onAction: () => onClose?.(),
    shortcuts: [{ key: 'Escape' }],
  });

  const PlayOriginalVideo: ActionItem = $derived({
    title: isPlayingOriginalVideo ? $t('play_transcoded_video') : $t('play_original_video'),
    icon: mdiVideoOutline,
    $if: () => asset.type === AssetTypeEnum.Video,
    onAction: () => setPlayOriginalVideo(!isPlayingOriginalVideo),
  });

  const Actions = $derived(getAssetActions($t, { ...asset, stackPrimaryAssetId: stack?.primaryAssetId }));
  const sharedLink = getSharedLink();

  // A shared-library Viewer/Editor never holds `AssetShare` (see design decision 3 in
  // FEATURE-PLAN-shared-external-libraries.md) - creating a shared link from this route always
  // fails server-side for a recipient, so it isn't offered at all. An owner previewing their own
  // library through this same route keeps the normal Share action.
  const isLibraryRecipient = $derived(!!libraryShare && !isLibraryShareOwnerPreview(libraryShare));

  // A recipient may only add a library-derived asset to an album they own (and the server
  // additionally rejects the insertion into an album that already has a shared link) - see §2
  // "Derived album/link access". Filter the picker up front rather than only surfacing the error.
  const AddToAlbum: ActionItem = $derived(
    isLibraryRecipient
      ? {
          ...Actions.AddToAlbum,
          onAction: () =>
            modalManager.show(AssetAddToAlbumModal, { assetIds: [asset.id], restrictToOwnedAlbums: true }),
        }
      : Actions.AddToAlbum,
  );

  // Discoverability fix: a shared-library Editor's metadata editor already lives inside the same
  // detail panel the generic "Info" button opens (DetailPanel.svelte's isLibraryEditor branch), but
  // nothing labeled it as editable, so Editors reported not being able to find it at all. A second,
  // explicitly-labeled action fixes that without touching Info's own read-oriented behavior or
  // reusing Actions.Edit (mdiTune) - that's the destructive photo editor, a different surface.
  const isEditor = $derived(isLibraryShareEditor(libraryShare));
  const EditInfo: ActionItem = $derived({
    title: $t('edit_info'),
    icon: mdiPencilOutline,
    $if: () => isEditor && asset.hasMetadata,
    onAction: () => assetViewerManager.openDetailPanel(),
  });

  // Command-palette actions mirror what's actually rendered below: swap in the restricted
  // AddToAlbum, drop Share entirely for a shared-library recipient, and surface the Editor's
  // "Edit info" action, so a keyboard/palette invocation can't reach a dead action the server would
  // reject anyway and can reach the one this fix adds.
  const paletteActions = $derived(
    Object.values({ ...Actions, AddToAlbum, EditInfo }).filter(
      (action) => !isLibraryRecipient || action !== Actions.Share,
    ),
  );
</script>

<CommandPaletteDefaultProvider name={$t('assets')} actions={withoutIcons([Close, Cast, ...paletteActions])} />

<div
  class="flex h-16 place-items-center justify-between bg-linear-to-b from-black/40 px-3 drop-shadow-[0_0_1px_rgba(0,0,0,0.4)] transition-transform duration-200"
>
  <div class="dark">
    <ActionButton action={Close} />
  </div>

  <div
    class="dark -m-1 flex items-center gap-2 overflow-x-auto p-1 *:shrink-0"
    data-testid="asset-viewer-navbar-actions"
  >
    {#if assetViewerManager.isImageLoading}
      <Tooltip text={$t('loading')}>
        {#snippet child({ props })}
          <div {...props} role="status" aria-label={$t('loading')}>
            <LoadingDots class="me-1" />
          </div>
        {/snippet}
      </Tooltip>
    {/if}
    <ActionButton action={Cast} />
    {#if !isLibraryRecipient}
      <ActionButton action={Actions.Share} />
    {/if}
    <ActionButton action={Actions.Offline} />
    <ActionButton action={Actions.ZoomIn} />
    <ActionButton action={Actions.ZoomOut} />
    <ActionButton action={Actions.PlayMotionPhoto} />
    <ActionButton action={Actions.StopMotionPhoto} />
    <ActionButton action={Actions.Copy} />
    <ActionButton action={Actions.SharedLinkDownload} />
    <ActionButton action={Actions.Info} />
    <ActionButton action={EditInfo} />
    <ActionButton action={Actions.Favorite} />
    <ActionButton action={Actions.Unfavorite} />

    {#if isOwner}
      <RatingAction {asset} {onAction} />
    {/if}

    <ActionButton action={Actions.Edit} />

    {#if isOwner}
      <DeleteAction {asset} {onAction} {preAction} {onUndoDelete} />
    {/if}

    {#if !sharedLink}
      <ButtonContextMenu direction="left" align="top-right" color="secondary" title={$t('more')} icon={mdiDotsVertical}>
        <ActionMenuItem action={Actions.PlaySlideshow} />

        <ActionMenuItem action={Actions.Download} />
        <ActionMenuItem action={Actions.DownloadOriginal} />

        {#if !isLocked && asset.isTrashed}
          <RestoreAction {asset} {onAction} />
        {/if}

        <ActionMenuItem action={AddToAlbum} />
        {#if album && (isOwner || isAlbumOwner)}
          <RemoveFromAlbumAction {album} onRemove={onRemoveFromAlbum} assetIds={[asset.id]} menuItem />
        {/if}

        {#if isOwner}
          <AddToStackAction {asset} {stack} {onAction} />
          {#if stack}
            <UnstackAction {stack} {onAction} />
            <KeepThisDeleteOthersAction {stack} {asset} {onAction} />
            {#if stack?.primaryAssetId !== asset.id}
              <SetStackPrimaryAsset {stack} {asset} {onAction} />
              {#if stack?.assets?.length > 2}
                <RemoveAssetFromStack {asset} {stack} {onAction} />
              {/if}
            {/if}
          {/if}
        {/if}
        {#if album}
          {@const { SetCover } = getAlbumAssetActions($t, album, asset)}
          <ActionMenuItem action={SetCover} />
        {/if}
        {#if person}
          <SetFeaturedPhotoAction {asset} {person} {onAction} />
        {/if}

        <ActionMenuItem action={Actions.SetProfilePicture} />

        {#if isOwner && !isLocked}
          <ArchiveAction {asset} {onAction} {preAction} />
        {/if}
        <ActionMenuItem action={Actions.ViewInTimeline} />
        <ActionMenuItem action={Actions.ViewSimilar} />

        {#if !asset.isTrashed && isOwner}
          <SetVisibilityAction asset={toTimelineAsset(asset)} {onAction} {preAction} />
        {/if}

        <ActionMenuItem action={PlayOriginalVideo} />

        {#if isOwner}
          <hr />
          <ActionMenuItem action={Actions.RefreshFacesJob} />
          <ActionMenuItem action={Actions.RefreshMetadataJob} />
          <ActionMenuItem action={Actions.RegenerateThumbnailJob} />
          <ActionMenuItem action={Actions.TranscodeVideoJob} />
        {/if}
      </ButtonContextMenu>
    {/if}
  </div>
</div>
