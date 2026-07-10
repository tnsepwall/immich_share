<script lang="ts">
  import { initInput } from '$lib/actions/focus';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import {
    addLibraryUsers,
    LibraryUserRole,
    removeLibraryUser,
    searchUsers,
    updateLibraryUser,
    type LibraryResponseDto,
    type LibraryUserResponseDto,
    type SharedLibraryResponseDto,
    type UserResponseDto,
  } from '@immich/sdk';
  import {
    Button,
    Field,
    Icon,
    ListButton,
    LoadingSpinner,
    Modal,
    ModalBody,
    ModalFooter,
    Select,
    Stack,
    Text,
    modalManager,
    type SelectOption,
  } from '@immich/ui';
  import { mdiCheck, mdiClose, mdiLogout } from '@mdi/js';
  import { sortBy } from 'lodash-es';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteMap } from 'svelte/reactivity';

  type Props = {
    library: LibraryResponseDto | SharedLibraryResponseDto;
    onClose: () => void;
  };

  let { library, onClose }: Props = $props();

  // `SharedLibraryResponseDto` (from getLibrariesSharedWithMe) always embeds the owner; the
  // owner's own `LibraryResponseDto` (from getMyLibraries) never does - use that as the
  // discriminator instead of trusting `ownerId === me`, which can't tell the two DTOs apart.
  const isSharedLibraryDto = (
    value: LibraryResponseDto | SharedLibraryResponseDto,
  ): value is SharedLibraryResponseDto => 'owner' in value;

  const sharedLibrary = $derived(isSharedLibraryDto(library) ? library : undefined);
  const isOwner = $derived(sharedLibrary === undefined);

  let sharedUsers: LibraryUserResponseDto[] = $state(isSharedLibraryDto(library) ? [] : (library.sharedUsers ?? []));
  let allUsers: UserResponseDto[] = $state([]);
  let selectedUsers = new SvelteMap<string, UserResponseDto>();
  let addRole: LibraryUserRole = $state(LibraryUserRole.Viewer);
  let search = $state('');
  let loading = $state(isOwner);

  const excludedUserIds = $derived(new Set([authManager.user.id, ...sharedUsers.map(({ user }) => user.id)]));
  const availableUsers = $derived(
    sortBy(
      allUsers.filter(
        (user) =>
          !excludedUserIds.has(user.id) && normalizeSearchString(user.name).includes(normalizeSearchString(search)),
      ),
      ['name'],
    ),
  );

  onMount(async () => {
    if (!isOwner) {
      return;
    }

    try {
      allUsers = await searchUsers();
    } finally {
      loading = false;
    }
  });

  const handleToggle = (user: UserResponseDto) => {
    if (selectedUsers.has(user.id)) {
      selectedUsers.delete(user.id);
    } else {
      selectedUsers.set(user.id, user);
    }
  };

  const handleAdd = async () => {
    if (selectedUsers.size === 0) {
      return;
    }

    try {
      sharedUsers = await addLibraryUsers({
        id: library.id,
        libraryUsersDto: {
          users: [...selectedUsers.values()].map((user) => ({ userId: user.id, role: addRole })),
        },
      });
      selectedUsers.clear();
    } catch (error) {
      handleError(error, $t('errors.unable_to_add_library_users'));
    }
  };

  const handleRemove = async (user: UserResponseDto) => {
    const isConfirmed = await modalManager.showDialog({
      title: $t('remove_user'),
      prompt: $t('library_remove_user_confirmation', { values: { user: user.name } }),
      confirmText: $t('remove_user'),
    });

    if (!isConfirmed) {
      return;
    }

    try {
      await removeLibraryUser({ id: library.id, userId: user.id });
      sharedUsers = sharedUsers.filter((sharedUser) => sharedUser.user.id !== user.id);
    } catch (error) {
      handleError(error, $t('errors.unable_to_remove_library_user'));
    }
  };

  const handleRoleSelect = async (user: UserResponseDto, role: LibraryUserRole | 'none') => {
    if (role === 'none') {
      await handleRemove(user);
      return;
    }

    try {
      const updated = await updateLibraryUser({ id: library.id, userId: user.id, libraryUserUpdateDto: { role } });
      sharedUsers = sharedUsers.map((sharedUser) => (sharedUser.user.id === user.id ? updated : sharedUser));
    } catch (error) {
      handleError(error, $t('errors.unable_to_change_library_user_role'));
    }
  };

  const handleLeave = async () => {
    const isConfirmed = await modalManager.showDialog({
      title: $t('leave_shared_library'),
      prompt: $t('leave_shared_library_confirmation', { values: { library: library.name } }),
      confirmText: $t('leave'),
    });

    if (!isConfirmed) {
      return;
    }

    try {
      await removeLibraryUser({ id: library.id, userId: 'me' });
      onClose();
    } catch (error) {
      handleError(error, $t('errors.unable_to_leave_shared_library'));
    }
  };
</script>

<Modal
  title={isOwner ? $t('share_library', { values: { library: library.name } }) : library.name}
  {onClose}
  size="small"
>
  <ModalBody>
    <Stack gap={6}>
      <div>
        <Text size="small" fontWeight="medium">{$t('library_editor_role_explainer_title')}</Text>
        <ul class="mt-2 ps-2 text-sm">
          <li class="mt-2 flex place-items-center gap-2 py-1">
            <Icon icon={mdiCheck} />
            {$t('library_editor_can_edit_metadata')}
          </li>
          <li class="flex place-items-center gap-2 py-1">
            <Icon icon={mdiCheck} />
            {$t('library_editor_can_label_faces')}
          </li>
          <li class="flex place-items-center gap-2 py-1">
            <Icon icon={mdiClose} />
            {$t('library_editor_cannot_delete_or_change_visibility')}
          </li>
        </ul>
      </div>

      {#if sharedLibrary}
        <!-- Recipient view: read-only summary of my own share, plus a way to leave it -->
        <div class="flex items-center gap-4">
          <UserAvatar user={sharedLibrary.owner} size="md" />
          <div class="text-start">
            <Text size="small">{$t('shared_by_user', { values: { user: sharedLibrary.owner.name } })}</Text>
            <Text size="tiny" color="muted">
              {sharedLibrary.role === LibraryUserRole.Editor ? $t('role_editor') : $t('role_viewer')}
            </Text>
          </div>
        </div>

        <ModalFooter>
          <Button
            shape="round"
            color="danger"
            variant="outline"
            fullWidth
            leadingIcon={mdiLogout}
            onclick={handleLeave}
          >
            {$t('leave_shared_library')}
          </Button>
        </ModalFooter>
      {:else}
        <!-- Owner view: manage the current share list and add new users -->
        <div>
          <Text size="medium" fontWeight="semi-bold">{$t('shared_with')}</Text>
          <div class="mt-2 ps-2">
            {#if sharedUsers.length === 0}
              <Text size="small" color="muted">{$t('library_not_shared_yet')}</Text>
            {/if}
            {#each sharedUsers as { user, role } (user.id)}
              <div class="flex items-center justify-between gap-4 py-2">
                <div class="flex items-center gap-2">
                  <UserAvatar {user} size="md" />
                  <div class="text-start">
                    <Text size="small">{user.name}</Text>
                    <Text size="tiny" color="muted">{user.email}</Text>
                  </div>
                </div>
                <Field class="w-32">
                  <Select
                    value={role}
                    options={[
                      { label: $t('role_editor'), value: LibraryUserRole.Editor },
                      { label: $t('role_viewer'), value: LibraryUserRole.Viewer },
                      { label: $t('remove_user'), value: 'none' },
                    ] as SelectOption<LibraryUserRole | 'none'>[]}
                    onChange={(value) => handleRoleSelect(user, value)}
                  />
                </Field>
              </div>
            {/each}
          </div>
        </div>

        <div>
          <div class="mb-2 flex items-center justify-between gap-4">
            <Text size="medium" fontWeight="semi-bold">{$t('add_people')}</Text>
            <Field class="w-32">
              <Select
                value={addRole}
                options={[
                  { label: $t('role_viewer'), value: LibraryUserRole.Viewer },
                  { label: $t('role_editor'), value: LibraryUserRole.Editor },
                ]}
                onChange={(value) => (addRole = value)}
              />
            </Field>
          </div>

          {#if loading}
            <div class="flex w-full place-content-center place-items-center py-4">
              <LoadingSpinner />
            </div>
          {:else}
            <input
              class="mb-2 w-full border-b-4 border-immich-bg px-3 py-2 text-lg focus:border-immich-primary dark:border-immich-dark-gray dark:focus:border-immich-dark-primary"
              placeholder={$t('search')}
              bind:value={search}
              use:initInput
            />
            {#if availableUsers.length > 0}
              <div class="flex max-h-60 immich-scrollbar flex-col gap-2 overflow-y-auto">
                {#each availableUsers as user (user.id)}
                  <ListButton onclick={() => handleToggle(user)} selected={selectedUsers.has(user.id)}>
                    <UserAvatar {user} size="md" />
                    <div class="grow text-start">
                      <Text fontWeight="medium">{user.name}</Text>
                      <Text size="tiny" color="muted">{user.email}</Text>
                    </div>
                  </ListButton>
                {/each}
              </div>
            {:else}
              <Text size="small" color="muted">{$t('library_share_all_users_added')}</Text>
            {/if}
          {/if}
        </div>

        <ModalFooter>
          {#if selectedUsers.size > 0}
            <Button shape="round" fullWidth onclick={handleAdd}>{$t('add')}</Button>
          {/if}
        </ModalFooter>
      {/if}
    </Stack>
  </ModalBody>
</Modal>
