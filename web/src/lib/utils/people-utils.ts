import { AssetTypeEnum, type AssetFaceResponseDto } from '@immich/sdk';
import type { Faces } from '$lib/managers/asset-viewer-manager.svelte';
import { getAssetMediaUrl } from '$lib/utils';
import { mapNormalizedRectToContent, type Rect, type Size } from '$lib/utils/container-utils';

export type BoundingBox = Rect & { id: string };

export const getBoundingBox = (faces: Faces[], imageSize: Size): BoundingBox[] => {
  const boxes: BoundingBox[] = [];

  for (const face of faces) {
    const rect = mapNormalizedRectToContent(
      { x: face.boundingBoxX1 / face.imageWidth, y: face.boundingBoxY1 / face.imageHeight },
      { x: face.boundingBoxX2 / face.imageWidth, y: face.boundingBoxY2 / face.imageHeight },
      imageSize,
    );

    boxes.push({ id: face.id, ...rect });
  }

  return boxes;
};

export const zoomImageToBase64 = async (
  face: AssetFaceResponseDto,
  assetId: string,
  assetType: AssetTypeEnum,
  photoViewer: HTMLImageElement | undefined,
): Promise<string | null> => {
  let image: HTMLImageElement | undefined;
  if (assetType === AssetTypeEnum.Image) {
    image = photoViewer;
  } else if (assetType === AssetTypeEnum.Video) {
    const data = getAssetMediaUrl({ id: assetId });
    const img: HTMLImageElement = new Image();
    img.src = data;

    await new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve());
      img.addEventListener('error', () => resolve());
    });

    image = img;
  }
  if (!image) {
    return null;
  }
  const { boundingBoxX1: x1, boundingBoxX2: x2, boundingBoxY1: y1, boundingBoxY2: y2, imageWidth, imageHeight } = face;

  const coordinates = {
    x1: (image.naturalWidth / imageWidth) * x1,
    x2: (image.naturalWidth / imageWidth) * x2,
    y1: (image.naturalHeight / imageHeight) * y1,
    y2: (image.naturalHeight / imageHeight) * y2,
  };

  const faceWidth = coordinates.x2 - coordinates.x1;
  const faceHeight = coordinates.y2 - coordinates.y1;

  const faceImage = new Image();
  faceImage.src = image.src;

  await new Promise((resolve) => {
    faceImage.addEventListener('load', resolve);
    faceImage.addEventListener('error', () => resolve(null));
  });

  const canvas = document.createElement('canvas');
  canvas.width = faceWidth;
  canvas.height = faceHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.drawImage(faceImage, coordinates.x1, coordinates.y1, faceWidth, faceHeight, 0, 0, faceWidth, faceHeight);
  return canvas.toDataURL();
};

/** The subset of face-box fields needed to crop a face out of an image, shared by both the
 * owner's `AssetFaceResponseDto` and the shared-library `LibraryFaceResponseDto`/`thumbnailFace`
 * shapes - all three carry these same six numbers. */
export type FaceBox = {
  boundingBoxX1: number;
  boundingBoxX2: number;
  boundingBoxY1: number;
  boundingBoxY2: number;
  imageWidth: number;
  imageHeight: number;
};

/**
 * Crop a face out of an arbitrary image source and return it as a data URL, for shared-library
 * face/person thumbnails. Mirrors `zoomImageToBase64`'s cropping math above, but that function is
 * scoped to `AssetFaceResponseDto` + the *currently open* asset's `photoViewer` element (an owner-
 * only, account-wide type). A shared-library person's representative face can live on a different
 * asset than the one currently open (see `LibraryPersonResponseDto.thumbnailFace` /
 * `LibraryThumbnailFace` in web/src/lib/api/library-share.ts), so this version loads its own image
 * from a URL instead of reusing the currently-displayed one - never a person's global
 * `thumbnailPath`, only an asset thumbnail URL the caller already has read access to.
 */
export const cropFaceThumbnail = async (box: FaceBox, imageUrl: string): Promise<string | null> => {
  const image = new Image();
  image.src = imageUrl;

  await new Promise<void>((resolve) => {
    image.addEventListener('load', () => resolve());
    image.addEventListener('error', () => resolve());
  });

  if (!image.naturalWidth || !image.naturalHeight) {
    return null;
  }

  const { boundingBoxX1: x1, boundingBoxX2: x2, boundingBoxY1: y1, boundingBoxY2: y2, imageWidth, imageHeight } = box;

  const coordinates = {
    x1: (image.naturalWidth / imageWidth) * x1,
    x2: (image.naturalWidth / imageWidth) * x2,
    y1: (image.naturalHeight / imageHeight) * y1,
    y2: (image.naturalHeight / imageHeight) * y2,
  };

  const faceWidth = coordinates.x2 - coordinates.x1;
  const faceHeight = coordinates.y2 - coordinates.y1;

  if (faceWidth <= 0 || faceHeight <= 0) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = faceWidth;
  canvas.height = faceHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  context.drawImage(image, coordinates.x1, coordinates.y1, faceWidth, faceHeight, 0, 0, faceWidth, faceHeight);
  return canvas.toDataURL();
};
