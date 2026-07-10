<script lang="ts">
  // Library-scoped equivalent of AssignFaceSidePanel.svelte: picks the destination for a shared-
  // library face. Search/candidate list comes exclusively from `getLibraryPeople` (never the
  // owner's `getAllPeople`), so an Editor's "assign to person" picker only ever shows people
  // reachable through this library - see design decision 3's person-thumbnail/visibility rule.
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { cropFaceThumbnail } from '$lib/utils/people-utils';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import {
    assignLibraryFaces,
    AssetMediaSize,
    createLibraryPerson,
    getLibraryPeople,
    updateLibraryPerson,
    type LibraryFaceResponseDto,
    type LibraryPersonResponseDto,
  } from '@immich/sdk';
  import { Button, IconButton, Input, LoadingSpinner } from '@immich/ui';
  import { mdiArrowLeftThin, mdiCheck, mdiPencil, mdiPlus } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { linear } from 'svelte/easing';
  import { fly } from 'svelte/transition';
  import ImageThumbnail from '../../assets/thumbnail/ImageThumbnail.svelte';

  interface Props {
    libraryId: string;
    editedFace: LibraryFaceResponseDto;
    onClose: () => void;
    onAssigned: () => void;
  }

  let { libraryId, editedFace, onClose, onAssigned }: Props = $props();

  let people: LibraryPersonResponseDto[] = $state([]);
  let isLoading = $state(false);
  let searchTerm = $state('');
  let showCreateForm = $state(false);
  let newPersonName = $state('');
  let isSubmitting = $state(false);
  // Safe name change (Editor allowlist item): a rename is only "safe" when every one of the
  // person's non-deleted faces is inside this library - the server re-validates that exclusivity
  // rule at write time (updateLibraryPerson -> checkPersonExclusiveToLibrary), so a rename that
  // isn't actually safe surfaces as a normal request error here rather than silently succeeding.
  let renamingPersonId: string | undefined = $state();
  let renameValue = $state('');

  const filteredPeople = $derived(
    searchTerm
      ? people.filter((person) => normalizeSearchString(person.name).includes(normalizeSearchString(searchTerm)))
      : people,
  );

  const loadPeople = async () => {
    isLoading = true;
    try {
      const loaded: LibraryPersonResponseDto[] = [];
      let page = 1;
      // `getLibraryPeople` is paginated; the picker needs the full list to search/filter client-side
      // the way FaceEditor.svelte's owner-side candidate list already does.
      for (;;) {
        const response = await getLibraryPeople({ libraryId, page, size: 250 });
        loaded.push(...response.people);
        if (!response.hasNextPage) {
          break;
        }
        page++;
      }
      people = loaded;
    } catch (error) {
      handleError(error, $t('errors.cant_get_faces'));
      people = [];
    } finally {
      isLoading = false;
    }
  };

  $effect(() => {
    void loadPeople();
  });

  const thumbnailUrl = (person: LibraryPersonResponseDto) => {
    const { thumbnailFace } = person;
    if (!thumbnailFace) {
      return Promise.resolve(null);
    }
    return cropFaceThumbnail(
      thumbnailFace,
      getAssetMediaUrl({ id: thumbnailFace.assetId, size: AssetMediaSize.Preview }),
    );
  };

  const handleReassign = async (person: LibraryPersonResponseDto) => {
    try {
      await assignLibraryFaces({
        libraryId,
        libraryFaceAssignDto: { personId: person.id, faceIds: [editedFace.id] },
      });
      onAssigned();
    } catch (error) {
      handleError(error, $t('errors.cant_apply_changes'));
    }
  };

  const handleCreatePerson = async () => {
    const name = newPersonName.trim();
    if (!name) {
      return;
    }
    isSubmitting = true;
    try {
      await createLibraryPerson({ libraryId, libraryPersonCreateDto: { name, faceIds: [editedFace.id] } });
      onAssigned();
    } catch (error) {
      handleError(error, $t('errors.cant_apply_changes'));
    } finally {
      isSubmitting = false;
    }
  };

  const startRename = (person: LibraryPersonResponseDto) => {
    renamingPersonId = person.id;
    renameValue = person.name;
  };

  const handleRename = async (person: LibraryPersonResponseDto) => {
    const name = renameValue.trim();
    if (!name || name === person.name) {
      renamingPersonId = undefined;
      return;
    }
    try {
      const updated = await updateLibraryPerson({ libraryId, personId: person.id, libraryPersonUpdateDto: { name } });
      people = people.map((p) => (p.id === updated.id ? updated : p));
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_person'));
    } finally {
      renamingPersonId = undefined;
    }
  };
</script>

<section
  transition:fly={{ x: 360, duration: 100, easing: linear }}
  class="absolute top-0 h-full w-90 overflow-x-hidden bg-light p-2 dark:text-immich-dark-fg"
>
  <div class="flex place-items-center justify-between gap-2">
    <div class="flex items-center gap-2">
      <IconButton
        color="secondary"
        variant="ghost"
        shape="round"
        icon={mdiArrowLeftThin}
        aria-label={$t('back')}
        onclick={onClose}
      />
      <p class="flex text-lg text-immich-fg dark:text-immich-dark-fg">{$t('select_face')}</p>
    </div>
    {#if !showCreateForm}
      <IconButton
        color="secondary"
        variant="ghost"
        shape="round"
        icon={mdiPlus}
        aria-label={$t('create_new_person')}
        onclick={() => (showCreateForm = true)}
      />
    {/if}
  </div>

  <div class="p-4 text-sm">
    {#if showCreateForm}
      <div class="mt-4 flex flex-col gap-3">
        <Input placeholder={$t('name')} bind:value={newPersonName} disabled={isSubmitting} autofocus />
        <div class="flex gap-2">
          <Button size="small" disabled={!newPersonName.trim() || isSubmitting} onclick={() => handleCreatePerson()}>
            {$t('tag_face')}
          </Button>
          <Button size="small" variant="outline" onclick={() => (showCreateForm = false)}>{$t('cancel')}</Button>
        </div>
      </div>
    {:else}
      <Input placeholder={$t('search_people')} bind:value={searchTerm} class="mb-4" />

      {#if isLoading}
        <div class="flex w-full justify-center">
          <LoadingSpinner />
        </div>
      {:else}
        <div class="mt-4 flex immich-scrollbar flex-wrap gap-2 overflow-y-auto">
          {#each filteredPeople as person (person.id)}
            <div class="w-22.5">
              <button type="button" class="relative w-22.5" onclick={() => handleReassign(person)}>
                {#await thumbnailUrl(person)}
                  <ImageThumbnail
                    curve
                    shadow
                    url="/src/lib/assets/no-thumbnail.png"
                    altText={person.name}
                    title={person.name}
                    widthStyle="90px"
                    heightStyle="90px"
                  />
                {:then url}
                  <ImageThumbnail
                    curve
                    shadow
                    url={url ?? '/src/lib/assets/no-thumbnail.png'}
                    altText={person.name}
                    title={person.name}
                    widthStyle="90px"
                    heightStyle="90px"
                  />
                {/await}
              </button>
              {#if renamingPersonId === person.id}
                <div class="mt-1 flex items-center gap-1">
                  <Input size="tiny" bind:value={renameValue} autofocus />
                  <IconButton
                    aria-label={$t('confirm')}
                    icon={mdiCheck}
                    size="small"
                    shape="round"
                    color="primary"
                    variant="ghost"
                    onclick={() => handleRename(person)}
                  />
                </div>
              {:else}
                <div class="mt-1 flex items-center gap-1">
                  <p class="grow truncate font-medium" title={person.name}>{person.name}</p>
                  <IconButton
                    aria-label={$t('edit_name')}
                    icon={mdiPencil}
                    size="small"
                    shape="round"
                    color="secondary"
                    variant="ghost"
                    onclick={() => startRename(person)}
                  />
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</section>
