<script lang="ts">
  // Library-scoped equivalent of face-editor/FaceEditor.svelte: draws a manual face box over the
  // currently displayed image and assigns it to an EXISTING library-scoped person. Mirrors that
  // component's fabric.js draggable/resizable-rectangle interaction model closely, with two
  // deliberate differences:
  //  - the candidate list comes from `getLibraryPeople` only (never the owner's `getAllPeople`);
  //  - there's no "create new person" option here, because `createLibraryFace`'s DTO
  //    (LibraryManualFaceDto) requires an existing `personId` - creating-and-assigning a brand new
  //    person from an existing (already-detected) face is a separate flow, see
  //    LibraryFaceAssignSidePanel.svelte's "+" button instead.
  //  - unlike FaceEditor.svelte (which receives `containerWidth`/`containerHeight` from
  //    PhotoViewer's own tracked dimensions), this component isn't mounted inside PhotoViewer, so
  //    it measures its own wrapping element via `bind:clientWidth`/`clientHeight` instead. It's
  //    rendered as a sibling overlay from AssetViewer.svelte, occupying the same content box.
  import { createLibraryFace, getLibraryPeople, type LibraryPersonResponseDto } from '$lib/api/library-share';
  import { getNaturalSize, scaleToFit } from '$lib/utils/container-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import { Button, Input, toastManager } from '@immich/ui';
  import { Canvas, InteractiveFabricObject, Rect } from 'fabric';
  import { clamp } from 'lodash-es';
  import { onDestroy, onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    htmlElement: HTMLImageElement | HTMLVideoElement;
    assetId: string;
    libraryId: string;
    onClose: (created?: boolean) => void;
  };

  let { htmlElement, assetId, libraryId, onClose }: Props = $props();

  let rootEl: HTMLDivElement | undefined = $state();
  let containerWidth = $state(0);
  let containerHeight = $state(0);

  let canvasEl: HTMLCanvasElement | undefined = $state();
  let canvas: Canvas | undefined = $state();
  let faceRect: Rect | undefined = $state();
  let searchInputEl: HTMLInputElement | null = $state(null);

  let candidates = $state<LibraryPersonResponseDto[]>([]);
  let isLoading = $state(false);
  let isSubmitting = $state(false);
  let searchTerm = $state('');

  let filteredCandidates = $derived(
    searchTerm
      ? candidates.filter((person) => normalizeSearchString(person.name).includes(normalizeSearchString(searchTerm)))
      : candidates,
  );

  const configureControlStyle = () => {
    InteractiveFabricObject.ownDefaults = {
      ...InteractiveFabricObject.ownDefaults,
      cornerStyle: 'circle',
      cornerColor: 'rgb(153,166,251)',
      cornerSize: 10,
      padding: 8,
      transparentCorners: false,
      lockRotation: true,
      hasBorders: true,
    };
  };

  const setupCanvas = () => {
    if (!canvasEl || !htmlElement) {
      return;
    }

    canvas = new Canvas(canvasEl);
    configureControlStyle();

    // eslint-disable-next-line tscompat/tscompat
    faceRect = new Rect({
      fill: 'rgba(66,80,175,0.25)',
      stroke: 'rgb(66,80,175)',
      strokeWidth: 2,
      strokeUniform: true,
      width: 112,
      height: 112,
      objectCaching: true,
      rx: 8,
      ry: 8,
    });

    canvas.add(faceRect);
    canvas.setActiveObject(faceRect);
    setDefaultFaceRectanglePosition(faceRect);
  };

  onMount(async () => {
    setupCanvas();
    await loadPeople();
    await tick();
    searchInputEl?.focus();
  });

  const loadPeople = async () => {
    isLoading = true;
    try {
      const loaded: LibraryPersonResponseDto[] = [];
      let page = 1;
      for (;;) {
        const response = await getLibraryPeople({ libraryId, page, size: 250 });
        loaded.push(...response.people);
        if (!response.hasNextPage) {
          break;
        }
        page++;
      }
      candidates = loaded;
    } catch (error) {
      handleError(error, $t('errors.cant_get_faces'));
      candidates = [];
    } finally {
      isLoading = false;
    }
  };

  const imageContentMetrics = $derived.by(() => {
    const natural = getNaturalSize(htmlElement);
    const container = { width: containerWidth, height: containerHeight };
    const { width: contentWidth, height: contentHeight } = scaleToFit(natural, container);
    return {
      contentWidth,
      contentHeight,
      offsetX: (containerWidth - contentWidth) / 2,
      offsetY: (containerHeight - contentHeight) / 2,
    };
  });

  const setDefaultFaceRectanglePosition = (faceRect: Rect) => {
    const { offsetX, offsetY } = imageContentMetrics;
    faceRect.set({ top: offsetY + 100, left: offsetX + 100 });
    faceRect.setCoords();
  };

  $effect(() => {
    if (!canvas) {
      return;
    }

    canvas.setDimensions({ width: containerWidth, height: containerHeight });

    if (!faceRect) {
      return;
    }

    if (!isFaceRectIntersectingCanvas(faceRect, canvas)) {
      setDefaultFaceRectanglePosition(faceRect);
    }
  });

  const isFaceRectIntersectingCanvas = (faceRect: Rect, canvas: Canvas) => {
    const faceBox = faceRect.getBoundingRect();
    return !(
      0 > faceBox.left + faceBox.width ||
      0 > faceBox.top + faceBox.height ||
      canvas.width < faceBox.left ||
      canvas.height < faceBox.top
    );
  };

  const getFaceCroppedCoordinates = () => {
    if (!faceRect || !htmlElement) {
      return;
    }

    const { left, top, width, height } = faceRect.getBoundingRect();
    const { offsetX, offsetY, contentWidth, contentHeight } = imageContentMetrics;
    const natural = getNaturalSize(htmlElement);

    const scaleX = natural.width / contentWidth;
    const scaleY = natural.height / contentHeight;
    const imageX = (left - offsetX) * scaleX;
    const imageY = (top - offsetY) * scaleY;

    return {
      imageWidth: natural.width,
      imageHeight: natural.height,
      x: Math.floor(clamp(imageX, 0, natural.width - 1)),
      y: Math.floor(clamp(imageY, 0, natural.height - 1)),
      width: Math.floor(clamp(width * scaleX, 1, natural.width)),
      height: Math.floor(clamp(height * scaleY, 1, natural.height)),
    };
  };

  const handleAssign = async (person: LibraryPersonResponseDto) => {
    const box = getFaceCroppedCoordinates();
    if (!box) {
      toastManager.warning($t('error_tag_face_bounding_box'));
      return;
    }

    isSubmitting = true;
    try {
      await createLibraryFace({
        libraryId,
        libraryManualFaceDto: { assetId, personId: person.id, ...box },
      });
      onClose(true);
    } catch (error) {
      handleError(error, $t('errors.cant_apply_changes'));
    } finally {
      isSubmitting = false;
    }
  };

  onDestroy(() => {
    void canvas?.dispose();
  });
</script>

<div
  bind:this={rootEl}
  bind:clientWidth={containerWidth}
  bind:clientHeight={containerHeight}
  class="absolute inset-0 z-5 size-full overflow-hidden"
  data-overlay-interactive
>
  <canvas bind:this={canvasEl} class="absolute inset-0"></canvas>

  <div
    class="absolute inset-s-[calc(50%-125px)] top-[calc(50%-200px)] w-62.5 max-w-62.5 rounded-xl border border-gray-200 bg-white px-2 py-4 backdrop-blur-sm dark:border-gray-800 dark:bg-immich-dark-gray dark:text-immich-dark-fg"
  >
    <p class="text-center text-sm">{$t('select_person_to_tag')}</p>

    <div class="relative my-3">
      <Input placeholder={$t('search_people')} bind:value={searchTerm} bind:ref={searchInputEl} size="tiny" />
    </div>

    <div class="mt-2 h-62.5 overflow-y-auto">
      {#if isLoading}
        <div class="flex w-full justify-center py-4">
          <p class="text-sm text-gray-500">{$t('loading')}</p>
        </div>
      {:else if filteredCandidates.length > 0}
        <div class="mt-2 rounded-lg">
          {#each filteredCandidates as person (person.id)}
            <button
              onclick={() => handleAssign(person)}
              type="button"
              disabled={isSubmitting}
              class="flex w-full place-items-center gap-2 rounded-lg py-2 ps-1 pe-4 hover:bg-immich-primary/25"
            >
              <p class="text-sm">{person.name}</p>
            </button>
          {/each}
        </div>
      {:else}
        <div class="flex items-center justify-center py-4">
          <p class="text-sm text-gray-500">{$t('no_people_found')}</p>
        </div>
      {/if}
    </div>

    <Button size="small" fullWidth onclick={() => onClose()} color="danger" class="mt-2">
      {$t('cancel')}
    </Button>
  </div>
</div>
