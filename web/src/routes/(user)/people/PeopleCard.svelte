<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import PersonIndicator from '$lib/components/faces-page/PersonIndicator.svelte';
  import { Route } from '$lib/route';
  import { getPersonActions } from '$lib/services/person.service';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { type PersonResponseDto } from '@immich/sdk';
  import { ContextMenuButton, Icon } from '@immich/ui';
  import { mdiAccount, mdiAccountMultipleCheckOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    person: PersonResponseDto;
    onMergePeople: () => void;
  };

  let { person, onMergePeople }: Props = $props();

  const { Edit, HidePerson, Favorite, Unfavorite, Access } = $derived(getPersonActions($t, person));

  const items = $derived([
    Edit,
    HidePerson,
    {
      icon: mdiAccountMultipleCheckOutline,
      title: $t('merge_people'),
      onAction: onMergePeople,
    },
    Favorite,
    Unfavorite,
    Access,
  ]);

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
</script>

<div id="people-card" class="relative" role="group">
  <a href={Route.viewPerson(person, { previousRoute: Route.people() })} draggable="false" class="group">
    <div class="@container relative size-full rounded-xl brightness-95 filter">
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
      <PersonIndicator {person} />
    </div>

    <!-- Edit/hide/merge/favorite/access are all owner-side mutations - a person projected from a
         shared library gets no menu (Editors rename from the person's own page instead). -->
    {#if person.isOwner !== false}
      <div class="absolute inset-e-2 top-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <ContextMenuButton
          variant="filled"
          class="icon-white-drop-shadow"
          translations={{ open_menu: $t('show_person_options') }}
          {items}
        />
      </div>
    {/if}
  </a>
</div>
