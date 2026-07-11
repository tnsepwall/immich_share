<script lang="ts">
  // Dedicated metadata editor for a shared-library Editor - the Phase 3 allowlist exactly:
  // description, dateTimeOriginal/dateTimeRelative, timeZone, latitude/longitude, rating. Shown by
  // DetailPanel.svelte IN PLACE OF DetailPanelDescription/DetailPanelRating/DetailPanelDate/
  // DetailPanelLocation (never alongside them - see DetailPanel.svelte's `isLibraryEditor` branch),
  // and routes every write through the library-scoped `updateLibraryAsset` endpoint, never the
  // owner-only `updateAsset`.
  import { shortcut } from '$lib/actions/shortcut';
  import StarRating, { type Rating } from '$lib/elements/StarRating.svelte';
  import GeolocationPointPickerModal from '$lib/modals/GeolocationPointPickerModal.svelte';
  import LibraryAssetChangeDateModal from '$lib/modals/LibraryAssetChangeDateModal.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { fromISODateTime, fromISODateTimeUTC } from '$lib/utils/timeline-util';
  import { getAssetInfo, updateLibraryAsset, type AssetResponseDto } from '@immich/sdk';
  import { Icon, modalManager, Text, Textarea, toastManager } from '@immich/ui';
  import { mdiCalendar, mdiMapMarkerOutline, mdiPencil } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { fromAction } from 'svelte/attachments';

  interface Props {
    asset: AssetResponseDto;
    libraryId: string;
  }

  let { asset, libraryId }: Props = $props();

  let description = $derived(asset.exifInfo?.description ?? '');
  let rating = $derived((asset.exifInfo?.rating ?? null) as Rating);

  const timeZone = $derived(asset.exifInfo?.timeZone ?? undefined);
  const dateTime = $derived(
    timeZone && asset.exifInfo?.dateTimeOriginal
      ? fromISODateTime(asset.exifInfo.dateTimeOriginal, timeZone)
      : fromISODateTimeUTC(asset.localDateTime),
  );

  // Full re-fetch fallback: our writes are single-transaction (either the whole edit lands or
  // nothing does - see server/src/services/library-editor.service.ts), so a request error never
  // leaves a partial write behind, but the UI should still resync with server truth rather than
  // risk drifting from whatever was last successfully shown.
  const resyncFromServer = async () => {
    try {
      const refreshed = await getAssetInfo({ id: asset.id });
      eventManager.emit('AssetUpdate', refreshed);
    } catch {
      // best-effort resync only; the original error is already surfaced to the user
    }
  };

  const handleDescriptionFocusOut = async () => {
    const currentDescription = asset.exifInfo?.description ?? '';
    if (description === currentDescription) {
      return;
    }
    try {
      const updated = await updateLibraryAsset({
        libraryId,
        assetId: asset.id,
        libraryAssetUpdateDto: { description },
      });
      eventManager.emit('AssetUpdate', updated);
      toastManager.primary($t('asset_description_updated'));
    } catch (error) {
      handleError(error, $t('cannot_update_the_description'));
      await resyncFromServer();
    }
  };

  const handleRatingChange = async (newRating: Rating) => {
    try {
      const updated = await updateLibraryAsset({
        libraryId,
        assetId: asset.id,
        libraryAssetUpdateDto: { rating: newRating },
      });
      eventManager.emit('AssetUpdate', updated);
    } catch (error) {
      handleError(error, $t('errors.unable_to_set_rating'));
      await resyncFromServer();
    }
  };

  const handleChangeDate = () => {
    void modalManager.show(LibraryAssetChangeDateModal, {
      libraryId,
      asset,
      initialDate: dateTime,
      initialTimeZone: timeZone,
    });
  };

  const handleChangeLocation = async () => {
    const point = await modalManager.show(GeolocationPointPickerModal, { asset });
    if (!point) {
      return;
    }

    try {
      const updated = await updateLibraryAsset({
        libraryId,
        assetId: asset.id,
        libraryAssetUpdateDto: { latitude: point.lat, longitude: point.lng },
      });
      eventManager.emit('AssetUpdate', updated);
    } catch (error) {
      handleError(error, $t('errors.unable_to_change_location'));
      await resyncFromServer();
    }
  };
</script>

<section class="mt-10 px-4 text-sm">
  <div class="flex h-10 w-full items-center gap-2">
    <Icon icon={mdiPencil} size="16" />
    <Text size="small" color="muted">{$t('edit_metadata')}</Text>
  </div>
</section>

<section class="px-4">
  <Textarea
    bind:value={description}
    class="max-h-40 resize-none border-b border-gray-500 bg-transparent pl-0 ring-0 outline-none focus:border-b-2 focus:border-immich-primary focus:ring-0 dark:bg-transparent dark:focus:border-immich-dark-primary"
    rows={1}
    grow
    shape="rectangle"
    onfocusout={() => handlePromiseError(handleDescriptionFocusOut())}
    placeholder={$t('add_a_description')}
    {@attach fromAction(shortcut, () => ({
      shortcut: { key: 'Enter', ctrl: true },
      onShortcut: (e) => e.currentTarget.blur(),
    }))}
  />
</section>

<section class="px-4 pt-4">
  <StarRating {rating} onRating={(value) => handlePromiseError(handleRatingChange(value))} />
</section>

<button
  type="button"
  class="flex w-full place-items-start justify-between gap-4 p-4 text-start hover:text-primary"
  onclick={handleChangeDate}
  title={$t('edit_date')}
>
  <div class="flex gap-4">
    <Icon icon={mdiCalendar} size="24" />
    <div>
      {#if dateTime}
        <p>
          {dateTime.toLocaleString({ month: 'short', day: 'numeric', year: 'numeric' }, { locale: $locale })}
        </p>
        <div class="flex gap-2 text-sm">
          <p>
            {dateTime.toLocaleString(
              {
                weekday: 'short',
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit',
                timeZoneName: timeZone ? 'longOffset' : undefined,
              },
              { locale: $locale },
            )}
          </p>
        </div>
      {/if}
    </div>
  </div>
  <div class="p-1"><Icon icon={mdiPencil} size="20" /></div>
</button>

<button
  type="button"
  class="flex w-full place-items-start justify-between gap-4 p-4 text-start hover:text-primary"
  onclick={() => handlePromiseError(handleChangeLocation())}
  title={$t('edit_location')}
>
  <div class="flex gap-4">
    <Icon icon={mdiMapMarkerOutline} size="24" />
    <div>
      {#if asset.exifInfo?.city}
        <p>{asset.exifInfo.city}</p>
      {/if}
      {#if asset.exifInfo?.state}
        <div class="flex gap-2 text-sm"><p>{asset.exifInfo.state}</p></div>
      {/if}
      {#if asset.exifInfo?.country}
        <div class="flex gap-2 text-sm"><p>{asset.exifInfo.country}</p></div>
      {:else}
        <p>{$t('add_a_location')}</p>
      {/if}
    </div>
  </div>
  <div class="p-1"><Icon icon={mdiPencil} size="20" /></div>
</button>
