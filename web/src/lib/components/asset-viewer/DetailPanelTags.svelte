<script lang="ts">
  import HeaderActionButton from '$lib/components/HeaderActionButton.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetActions } from '$lib/services/asset.service';
  import { removeTag } from '$lib/utils/asset-utils';
  import { isLibraryShareEditor, type LibraryShareContext } from '$lib/utils/library-share-context';
  import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
  import { Badge, Link, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
    libraryShare?: LibraryShareContext;
  }

  let { asset = $bindable(), isOwner, libraryShare }: Props = $props();

  // A shared-library Editor may attach/remove their own tags on the owner's asset (server enforces
  // both tag ownership and the Editor role); a Viewer share keeps the section hidden.
  let canTag = $derived(isOwner || isLibraryShareEditor(libraryShare));

  let tags = $derived(asset.tags || []);

  const handleRemove = async (tagId: string) => {
    const ids = await removeTag({ tagIds: [tagId], assetIds: [asset.id], showNotification: false });
    if (ids) {
      asset = await getAssetInfo({ id: asset.id });
    }
  };

  const onAssetsTag = async (ids: string[]) => {
    if (ids.includes(asset.id)) {
      asset = await getAssetInfo({ id: asset.id });
    }
  };

  const { Tag } = $derived(getAssetActions($t, asset));
</script>

<OnEvents {onAssetsTag} />

{#if canTag && !authManager.isSharedLink}
  <section class="mt-4 px-4">
    <div class="flex h-10 w-full items-center justify-between text-sm">
      <Text color="muted">{$t('tags')}</Text>
    </div>
    <section class="flex flex-wrap gap-1 pt-2" data-testid="detail-panel-tags">
      {#each tags as tag (tag.id)}
        <Badge
          onClose={() => handleRemove(tag.id)}
          size="small"
          shape="round"
          translations={{ close: $t('remove_tag') }}
        >
          <Link href={Route.tags({ path: tag.value })} underline={false} class="px-2 font-light">
            {tag.value}
          </Link>
        </Badge>
      {/each}
      <HeaderActionButton action={Tag} />
    </section>
  </section>
{/if}
