<script lang="ts">
  // Library-editor equivalent of AssetChangeDateModal.svelte: same date/timezone picker UI, but
  // calls the library-scoped `updateLibraryAsset` endpoint (never the owner-only `updateAsset`)
  // and sends the picked IANA `timeZone` explicitly alongside `dateTimeOriginal` (the owner path
  // only bakes a raw UTC offset into the ISO string; sending the zone name too lets the server's
  // date-derivation primitive use the real IANA zone rather than reconstructing one from an
  // offset - see server/src/services/library-editor.service.ts's date-edit modes).
  import Combobox from '$lib/components/shared-components/Combobox.svelte';
  import DateInput from '$lib/elements/DateInput.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { getPreferredTimeZone, getTimezones, toIsoDate } from '$lib/modals/timezone-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { updateLibraryAsset, type AssetResponseDto } from '@immich/sdk';
  import { FormModal, Label } from '@immich/ui';
  import { mdiCalendarEdit } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  interface Props {
    libraryId: string;
    asset: AssetResponseDto;
    initialDate?: DateTime;
    initialTimeZone?: string;
    onClose: (success: boolean) => void;
  }

  let { libraryId, asset, initialDate = DateTime.now(), initialTimeZone, onClose }: Props = $props();

  let selectedDate = $state(initialDate.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS"));
  const timezones = $derived(getTimezones(selectedDate));

  let selectedOption = $state(getPreferredTimeZone(initialDate, initialTimeZone, getTimezones(selectedDate)));

  const onSubmit = async () => {
    if (!date.isValid || !selectedOption) {
      onClose(false);
      return;
    }

    const isoDate = toIsoDate(selectedDate, selectedOption);
    try {
      const updated = await updateLibraryAsset({
        libraryId,
        assetId: asset.id,
        libraryAssetUpdateDto: { dateTimeOriginal: isoDate, timeZone: selectedOption.value },
      });
      // The asset may have moved to a different day/month bucket - the timeline manager's
      // AssetUpdate subscription already re-buckets on a changed ordering date, so a plain emit
      // here is enough (no separate "reload the timeline" call needed).
      eventManager.emit('AssetUpdate', updated);
      onClose(true);
    } catch (error) {
      handleError(error, $t('errors.unable_to_change_date'));
      onClose(false);
    }
  };

  const updateSelectedDate = (value: string) => {
    selectedDate = value;
    selectedOption = getPreferredTimeZone(initialDate, initialTimeZone, getTimezones(value), selectedOption);
  };

  // when changing the time zone, assume the configured date/time is meant for that time zone (instead of updating it)
  const date = $derived(DateTime.fromISO(selectedDate, { zone: selectedOption?.value, setZone: true }));
</script>

<FormModal
  title={$t('edit_date_and_time')}
  icon={mdiCalendarEdit}
  onClose={() => onClose(false)}
  {onSubmit}
  submitText={$t('confirm')}
  disabled={!date.isValid || !selectedOption}
  size="small"
>
  <Label for="datetime" class="mb-1 block">{$t('date_and_time')}</Label>
  <DateInput
    class="mb-2 immich-form-input w-full"
    id="datetime"
    type="datetime-local"
    bind:value={() => selectedDate, updateSelectedDate}
  />
  <div class="w-full">
    <Combobox bind:selectedOption label={$t('timezone')} options={timezones} placeholder={$t('search_timezone')} />
  </div>
</FormModal>
