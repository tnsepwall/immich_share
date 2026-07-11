<script lang="ts">
  import { focusOutside } from '$lib/actions/focus-outside';
  import ActionMenuItem from '$lib/components/ActionMenuItem.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import { Route } from '$lib/route';
  import { getPersonActions } from '$lib/services/person.service';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { type PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAccount,
    mdiAccountMultipleCheckOutline,
    mdiDotsVertical,
    mdiEyeOffOutline,
    mdiHeart,
    mdiHeartMinusOutline,
    mdiHeartOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';

  type Props = {
    person: PersonResponseDto;
    onMergePeople: () => void;
    onHidePerson: () => void;
    onToggleFavorite: () => void;
  };

  let { person, onMergePeople, onHidePerson, onToggleFavorite }: Props = $props();

  let showVerticalDots = $state(false);
  // Phase 5 review finding fix: a shared-library person's thumbnail may be unservable (the source
  // asset of the crop isn't in a library shared with the viewer), so fall back to an initials/generic
  // avatar instead of ImageThumbnail's BrokenAsset placeholder.
  let thumbnailErrored = $state(false);

  const initials = $derived(
    (person.name ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join(''),
  );

  const { SetDateOfBirth } = $derived(getPersonActions($t, person));
</script>

<div
  id="people-card"
  class="relative"
  onmouseenter={() => (showVerticalDots = true)}
  onmouseleave={() => (showVerticalDots = false)}
  role="group"
  use:focusOutside={{ onFocusOut: () => (showVerticalDots = false) }}
>
  <a
    href={Route.viewPerson(person, { previousRoute: Route.people() })}
    draggable="false"
    onfocus={() => (showVerticalDots = true)}
  >
    <div class="size-full rounded-xl brightness-95 filter">
      {#if thumbnailErrored}
        <div
          class="flex aspect-square w-full items-center justify-center rounded-full bg-gray-200 shadow-lg dark:bg-gray-700"
          title={person.name}
        >
          {#if initials}
            <span class="text-3xl font-medium text-gray-500 select-none dark:text-gray-300">{initials}</span>
          {:else}
            <Icon icon={mdiAccount} size="45%" class="text-gray-400 dark:text-gray-400" />
          {/if}
        </div>
      {:else}
        <ImageThumbnail
          shadow
          url={getPeopleThumbnailUrl(person)}
          altText={person.name}
          title={person.name}
          widthStyle="100%"
          circle
          preload={false}
          onComplete={(errored) => (thumbnailErrored = errored)}
        />
      {/if}
      {#if person.isFavorite}
        <div class="absolute inset-s-4 top-4">
          <Icon icon={mdiHeart} size="24" class="text-white" />
        </div>
      {/if}
    </div>
  </a>

  {#if showVerticalDots}
    <div class="absolute inset-e-2 top-2 z-1">
      <ButtonContextMenu
        buttonClass="icon-white-drop-shadow"
        color="secondary"
        size="medium"
        variant="filled"
        icon={mdiDotsVertical}
        title={$t('show_person_options')}
      >
        <MenuOption onClick={onHidePerson} icon={mdiEyeOffOutline} text={$t('hide_person')} />
        <ActionMenuItem action={SetDateOfBirth} />
        <MenuOption onClick={onMergePeople} icon={mdiAccountMultipleCheckOutline} text={$t('merge_people')} />
        <MenuOption
          onClick={onToggleFavorite}
          icon={person.isFavorite ? mdiHeartMinusOutline : mdiHeartOutline}
          text={person.isFavorite ? $t('unfavorite') : $t('to_favorite')}
        />
      </ButtonContextMenu>
    </div>
  {/if}
</div>
