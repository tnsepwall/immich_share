import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { AssetFace } from 'src/database';
import { AssetEditAction, MirrorAxis } from 'src/dtos/editing.dto';
import { AssetOcrResponseDto } from 'src/dtos/ocr.dto';
import { SourceType } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { BoundingBox } from 'src/repositories/machine-learning.repository';
import { MediaRepository } from 'src/repositories/media.repository';
import { checkFaceVisibility, checkOcrVisibility } from 'src/utils/editor';
import { automock } from 'test/utils';

vi.mock('fluent-ffmpeg', () => {
  const mockFn = vi.fn();
  (mockFn as any).ffprobe = vi.fn();
  return { default: mockFn };
});

const getPixelColor = async (buffer: Buffer, x: number, y: number) => {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width!;
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * width + x) * 4;
  return {
    r: data[idx],
    g: data[idx + 1],
    b: data[idx + 2],
  };
};

const buildTestQuadImage = async () => {
  // build a 4 quadrant image for testing mirroring
  const base = sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png();

  const tl = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();

  const tr = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 0, g: 255, b: 0 } },
  })
    .png()
    .toBuffer();

  const bl = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer();

  const br = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 255, g: 255, b: 0 } },
  })
    .png()
    .toBuffer();

  const image = base.composite([
    { input: tl, left: 0, top: 0 }, // top-left
    { input: tr, left: 500, top: 0 }, // top-right
    { input: bl, left: 0, top: 500 }, // bottom-left
    { input: br, left: 500, top: 500 }, // bottom-right
  ]);

  return image.png().toBuffer();
};

const buildMockChain = (triggerEvent: 'end' | 'error' = 'end', stderrMsg = '') => {
  const chain = {
    seekInput: vi.fn(),
    outputOptions: vi.fn(),
    output: vi.fn(),
    on: vi.fn(),
    run: vi.fn(),
  };
  chain.seekInput.mockReturnValue(chain);
  chain.outputOptions.mockReturnValue(chain);
  chain.output.mockReturnValue(chain);
  chain.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    if (event === triggerEvent) {
      if (event === 'end') {
        setImmediate(() => cb());
      } else {
        setImmediate(() => cb(new Error('ffmpeg failed'), '', stderrMsg));
      }
    }
    return chain;
  });
  return chain;
};

const mockProbe = (
  duration?: number,
  streams: any[] = [{ index: 0, codec_type: 'video', height: 1080, width: 1920 }],
) => {
  vi.mocked(ffmpeg.ffprobe).mockImplementation((_path: any, _opts: any, cb: any) =>
    cb(null, { format: { duration }, streams }),
  );
};

describe(MediaRepository.name, () => {
  let sut: MediaRepository;

  beforeEach(() => {
    // eslint-disable-next-line no-sparse-arrays
    sut = new MediaRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
  });

  describe('applyEdits (single actions)', () => {
    it('should apply crop edit correctly', async () => {
      const result = sut['applyEdits'](
        sharp({
          create: {
            width: 1000,
            height: 1000,
            channels: 4,
            background: { r: 255, g: 0, b: 0, alpha: 0.5 },
          },
        }).png(),
        [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 100,
              y: 200,
              width: 700,
              height: 300,
            },
          },
        ],
      );

      const metadata = await result.toBuffer().then((buf) => sharp(buf).metadata());
      expect(metadata.width).toBe(700);
      expect(metadata.height).toBe(300);
    });
    it('should apply rotate edit correctly', async () => {
      const result = sut['applyEdits'](
        sharp({
          create: {
            width: 500,
            height: 1000,
            channels: 4,
            background: { r: 255, g: 0, b: 0, alpha: 0.5 },
          },
        }).png(),
        [
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
        ],
      );

      const metadata = await result.toBuffer().then((buf) => sharp(buf).metadata());
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);
    });

    it('should apply mirror edit correctly', async () => {
      const resultHorizontal = sut['applyEdits'](sharp(await buildTestQuadImage()), [
        {
          action: AssetEditAction.Mirror,
          parameters: {
            axis: MirrorAxis.Horizontal,
          },
        },
      ]);

      const bufferHorizontal = await resultHorizontal.toBuffer();
      const metadataHorizontal = await resultHorizontal.metadata();
      expect(metadataHorizontal.width).toBe(1000);
      expect(metadataHorizontal.height).toBe(1000);

      expect(await getPixelColor(bufferHorizontal, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 990, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 10, 990)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });

      const resultVertical = sut['applyEdits'](sharp(await buildTestQuadImage()), [
        {
          action: AssetEditAction.Mirror,
          parameters: {
            axis: MirrorAxis.Vertical,
          },
        },
      ]);

      const bufferVertical = await resultVertical.toBuffer();
      const metadataVertical = await resultVertical.metadata();
      expect(metadataVertical.width).toBe(1000);
      expect(metadataVertical.height).toBe(1000);

      // top-left should now be bottom-left (blue)
      expect(await getPixelColor(bufferVertical, 10, 10)).toEqual({ r: 0, g: 0, b: 255 });
      // top-right should now be bottom-right (yellow)
      expect(await getPixelColor(bufferVertical, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      // bottom-left should now be top-left (red)
      expect(await getPixelColor(bufferVertical, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      // bottom-right should now be top-right (blue)
      expect(await getPixelColor(bufferVertical, 990, 990)).toEqual({ r: 0, g: 255, b: 0 });
    });
  });

  describe('applyEdits (multiple sequential edits)', () => {
    it('should apply horizontal mirror then vertical mirror (equivalent to 180° rotation)', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['applyEdits'](sharp(imageBuffer), [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply rotate 90° then horizontal mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['applyEdits'](sharp(imageBuffer), [
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 255, b: 0 });
    });

    it('should apply 180° rotation', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['applyEdits'](sharp(imageBuffer), [
        { action: AssetEditAction.Rotate, parameters: { angle: 180 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply 270° rotations', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['applyEdits'](sharp(imageBuffer), [
        { action: AssetEditAction.Rotate, parameters: { angle: 270 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should apply crop then rotate 90°', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['applyEdits'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1000, height: 500 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(500);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('should apply rotate 90° then crop', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['applyEdits'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 1000 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply vertical mirror then horizontal mirror then rotate 90°', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['applyEdits'](sharp(imageBuffer), [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should apply crop to single quadrant then mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['applyEdits'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 500 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(500);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 490, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 10, 490)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 490, 490)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply all operations: crop, rotate, mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['applyEdits'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 1000 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
    });
  });

  describe('checkFaceVisibility', () => {
    const baseFace: AssetFace = {
      id: 'face-1',
      assetId: 'asset-1',
      personId: 'person-1',
      boundingBoxX1: 100,
      boundingBoxY1: 100,
      boundingBoxX2: 200,
      boundingBoxY2: 200,
      imageWidth: 1000,
      imageHeight: 800,
      sourceType: SourceType.MachineLearning,
      isVisible: true,
      updatedAt: new Date(),
      deletedAt: null,
      updateId: '',
      timestampMs: null,
    };

    const assetDimensions = { width: 1000, height: 800 };

    describe('with no crop edit', () => {
      it('should return only currently invisible faces when no crop is provided', () => {
        const visibleFace = { ...baseFace, id: 'face-visible', isVisible: true };
        const invisibleFace = { ...baseFace, id: 'face-invisible', isVisible: false };
        const faces = [visibleFace, invisibleFace];
        const result = checkFaceVisibility(faces, assetDimensions);

        expect(result.visible).toEqual([invisibleFace]);
        expect(result.hidden).toEqual([]);
      });

      it('should return empty arrays when all faces are already visible and no crop is provided', () => {
        const faces = [baseFace];
        const result = checkFaceVisibility(faces, assetDimensions);

        expect(result.visible).toEqual([]);
        expect(result.hidden).toEqual([]);
      });

      it('should return all faces when all are invisible and no crop is provided', () => {
        const face1 = { ...baseFace, id: 'face-1', isVisible: false };
        const face2 = { ...baseFace, id: 'face-2', isVisible: false };
        const faces = [face1, face2];
        const result = checkFaceVisibility(faces, assetDimensions);

        expect(result.visible).toEqual([face1, face2]);
        expect(result.hidden).toEqual([]);
      });
    });

    describe('with crop edit', () => {
      it('should mark face as visible when fully inside crop area', () => {
        const crop: BoundingBox = { x1: 0, y1: 0, x2: 500, y2: 400 };
        const faces = [baseFace];
        const result = checkFaceVisibility(faces, assetDimensions, crop);

        expect(result.visible).toEqual(faces);
        expect(result.hidden).toEqual([]);
      });

      it('should mark face as visible when more than 50% inside crop area', () => {
        const crop: BoundingBox = { x1: 150, y1: 150, x2: 650, y2: 550 };
        // Face at (100,100)-(200,200), crop starts at (150,150)
        // Overlap: (150,150)-(200,200) = 50x50 = 2500
        // Face area: 100x100 = 10000
        // Overlap percentage: 25% - should be hidden
        const faces = [baseFace];
        const result = checkFaceVisibility(faces, assetDimensions, crop);

        expect(result.visible).toEqual([]);
        expect(result.hidden).toEqual(faces);
      });

      it('should mark face as hidden when less than 50% inside crop area', () => {
        const crop: BoundingBox = { x1: 250, y1: 250, x2: 750, y2: 650 };
        // Face completely outside crop area
        const faces = [baseFace];
        const result = checkFaceVisibility(faces, assetDimensions, crop);

        expect(result.visible).toEqual([]);
        expect(result.hidden).toEqual(faces);
      });

      it('should mark face as hidden when completely outside crop area', () => {
        const crop: BoundingBox = { x1: 500, y1: 500, x2: 700, y2: 700 };
        const faces = [baseFace];
        const result = checkFaceVisibility(faces, assetDimensions, crop);

        expect(result.visible).toEqual([]);
        expect(result.hidden).toEqual(faces);
      });

      it('should handle multiple faces with mixed visibility', () => {
        const crop: BoundingBox = { x1: 0, y1: 0, x2: 300, y2: 300 };
        const faceInside: AssetFace = {
          ...baseFace,
          id: 'face-inside',
          boundingBoxX1: 50,
          boundingBoxY1: 50,
          boundingBoxX2: 150,
          boundingBoxY2: 150,
        };
        const faceOutside: AssetFace = {
          ...baseFace,
          id: 'face-outside',
          boundingBoxX1: 400,
          boundingBoxY1: 400,
          boundingBoxX2: 500,
          boundingBoxY2: 500,
        };
        const faces = [faceInside, faceOutside];
        const result = checkFaceVisibility(faces, assetDimensions, crop);

        expect(result.visible).toEqual([faceInside]);
        expect(result.hidden).toEqual([faceOutside]);
      });

      it('should handle face at exactly 50% overlap threshold', () => {
        // Face at (0,0)-(100,100), crop at (50,0)-(150,100)
        // Overlap: (50,0)-(100,100) = 50x100 = 5000
        // Face area: 100x100 = 10000
        // Overlap percentage: 50% - exactly at threshold, should be visible
        const faceAtEdge: AssetFace = {
          ...baseFace,
          id: 'face-edge',
          boundingBoxX1: 0,
          boundingBoxY1: 0,
          boundingBoxX2: 100,
          boundingBoxY2: 100,
        };
        const crop: BoundingBox = { x1: 50, y1: 0, x2: 150, y2: 100 };
        const faces = [faceAtEdge];
        const result = checkFaceVisibility(faces, assetDimensions, crop);

        expect(result.visible).toEqual([faceAtEdge]);
        expect(result.hidden).toEqual([]);
      });
    });

    describe('with scaled dimensions', () => {
      it('should handle faces when asset dimensions differ from face image dimensions', () => {
        // Face stored at 1000x800 resolution, but displaying at 500x400
        const scaledDimensions = { width: 500, height: 400 };
        const crop: BoundingBox = { x1: 0, y1: 0, x2: 250, y2: 200 };
        // Face at (100,100)-(200,200) on 1000x800
        // Scaled to 500x400: (50,50)-(100,100)
        // Crop at (0,0)-(250,200) - face is fully inside
        const faces = [baseFace];
        const result = checkFaceVisibility(faces, scaledDimensions, crop);

        expect(result.visible).toEqual(faces);
        expect(result.hidden).toEqual([]);
      });
    });
  });

  describe('checkOcrVisibility', () => {
    const baseOcr: AssetOcrResponseDto & { isVisible: boolean } = {
      id: 'ocr-1',
      assetId: 'asset-1',
      x1: 0.1,
      y1: 0.1,
      x2: 0.2,
      y2: 0.1,
      x3: 0.2,
      y3: 0.2,
      x4: 0.1,
      y4: 0.2,
      boxScore: 0.9,
      textScore: 0.85,
      text: 'Test OCR',
      isVisible: false,
    };

    const assetDimensions = { width: 1000, height: 800 };

    describe('with no crop edit', () => {
      it('should return only currently invisible OCR items when no crop is provided', () => {
        const visibleOcr = { ...baseOcr, id: 'ocr-visible', isVisible: true };
        const invisibleOcr = { ...baseOcr, id: 'ocr-invisible', isVisible: false };
        const ocrs = [visibleOcr, invisibleOcr];
        const result = checkOcrVisibility(ocrs, assetDimensions);

        expect(result.visible).toEqual([invisibleOcr]);
        expect(result.hidden).toEqual([]);
      });

      it('should return empty arrays when all OCR items are already visible and no crop is provided', () => {
        const visibleOcr = { ...baseOcr, isVisible: true };
        const ocrs = [visibleOcr];
        const result = checkOcrVisibility(ocrs, assetDimensions);

        expect(result.visible).toEqual([]);
        expect(result.hidden).toEqual([]);
      });

      it('should return all OCR items when all are invisible and no crop is provided', () => {
        const ocr1 = { ...baseOcr, id: 'ocr-1', isVisible: false };
        const ocr2 = { ...baseOcr, id: 'ocr-2', isVisible: false };
        const ocrs = [ocr1, ocr2];
        const result = checkOcrVisibility(ocrs, assetDimensions);

        expect(result.visible).toEqual([ocr1, ocr2]);
        expect(result.hidden).toEqual([]);
      });
    });

    describe('with crop edit', () => {
      it('should mark OCR as visible when fully inside crop area', () => {
        const crop: BoundingBox = { x1: 0, y1: 0, x2: 500, y2: 400 };
        // OCR box: (0.1,0.1)-(0.2,0.2) on 1000x800 = (100,80)-(200,160)
        // Crop: (0,0)-(500,400) - OCR fully inside
        const ocrs = [baseOcr];
        const result = checkOcrVisibility(ocrs, assetDimensions, crop);

        expect(result.visible).toEqual(ocrs);
        expect(result.hidden).toEqual([]);
      });

      it('should mark OCR as hidden when completely outside crop area', () => {
        const crop: BoundingBox = { x1: 500, y1: 500, x2: 700, y2: 700 };
        // OCR box: (100,80)-(200,160) - completely outside crop
        const ocrs = [baseOcr];
        const result = checkOcrVisibility(ocrs, assetDimensions, crop);

        expect(result.visible).toEqual([]);
        expect(result.hidden).toEqual(ocrs);
      });

      it('should mark OCR as hidden when less than 50% inside crop area', () => {
        const crop: BoundingBox = { x1: 150, y1: 120, x2: 650, y2: 520 };
        // OCR box: (100,80)-(200,160)
        // Crop: (150,120)-(650,520)
        // Overlap: (150,120)-(200,160) = 50x40 = 2000
        // OCR area: 100x80 = 8000
        // Overlap percentage: 25% - should be hidden
        const ocrs = [baseOcr];
        const result = checkOcrVisibility(ocrs, assetDimensions, crop);

        expect(result.visible).toEqual([]);
        expect(result.hidden).toEqual(ocrs);
      });

      it('should handle multiple OCR items with mixed visibility', () => {
        const crop: BoundingBox = { x1: 0, y1: 0, x2: 300, y2: 300 };
        const ocrInside = {
          ...baseOcr,
          id: 'ocr-inside',
        };
        const ocrOutside = {
          ...baseOcr,
          id: 'ocr-outside',
          x1: 0.5,
          y1: 0.5,
          x2: 0.6,
          y2: 0.5,
          x3: 0.6,
          y3: 0.6,
          x4: 0.5,
          y4: 0.6,
        };
        const ocrs = [ocrInside, ocrOutside];
        const result = checkOcrVisibility(ocrs, assetDimensions, crop);

        expect(result.visible).toEqual([ocrInside]);
        expect(result.hidden).toEqual([ocrOutside]);
      });

      it('should handle OCR boxes with rotated/skewed polygons', () => {
        // OCR with a rotated bounding box (not axis-aligned)
        const rotatedOcr = {
          ...baseOcr,
          id: 'ocr-rotated',
          x1: 0.15,
          y1: 0.1,
          x2: 0.25,
          y2: 0.15,
          x3: 0.2,
          y3: 0.25,
          x4: 0.1,
          y4: 0.2,
        };
        const crop: BoundingBox = { x1: 0, y1: 0, x2: 300, y2: 300 };
        const ocrs = [rotatedOcr];
        const result = checkOcrVisibility(ocrs, assetDimensions, crop);

        expect(result.visible).toEqual([rotatedOcr]);
        expect(result.hidden).toEqual([]);
      });
    });

    describe('visibility is only affected by crop (not rotate or mirror)', () => {
      it('should keep all OCR items visible when there is no crop regardless of other transforms', () => {
        // Rotate and mirror edits don't affect visibility - only crop does
        // The visibility functions only take an optional crop parameter
        const ocrs = [baseOcr];

        // Without any crop, all OCR items remain visible
        const result = checkOcrVisibility(ocrs, assetDimensions);

        expect(result.visible).toEqual(ocrs);
        expect(result.hidden).toEqual([]);
      });

      it('should only consider crop for visibility calculation', () => {
        // Even if the image will be rotated/mirrored, visibility is determined
        // solely by whether the OCR box overlaps with the crop area
        const crop: BoundingBox = { x1: 0, y1: 0, x2: 300, y2: 300 };

        const ocrInsideCrop = {
          ...baseOcr,
          id: 'ocr-inside',
          // OCR at (0.1,0.1)-(0.2,0.2) = (100,80)-(200,160) on 1000x800, inside crop
        };

        const ocrOutsideCrop = {
          ...baseOcr,
          id: 'ocr-outside',
          x1: 0.5,
          y1: 0.5,
          x2: 0.6,
          y2: 0.5,
          x3: 0.6,
          y3: 0.6,
          x4: 0.5,
          y4: 0.6,
          // OCR at (500,400)-(600,480) on 1000x800, outside crop
        };

        const ocrs = [ocrInsideCrop, ocrOutsideCrop];
        const result = checkOcrVisibility(ocrs, assetDimensions, crop);

        // OCR inside crop area is visible, OCR outside is hidden
        // This is true regardless of any subsequent rotate/mirror operations
        expect(result.visible).toEqual([ocrInsideCrop]);
        expect(result.hidden).toEqual([ocrOutsideCrop]);
      });
    });
  });

  describe('extractVideoFrames', () => {
    const scaleOption = `-vf scale='min(1440,iw)':'min(1440,ih)':force_original_aspect_ratio=decrease`;

    beforeEach(() => {
      vi.mocked(ffmpeg).mockReturnValue(buildMockChain() as any);
      vi.spyOn(fs, 'access').mockResolvedValue();
      // Default: short video where naive count (floor(5/2)+1 = 3) does not exceed maxFrames (50)
      mockProbe(5);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should seek once per interval and extract a downscaled single frame', async () => {
      const mockChain = buildMockChain();
      vi.mocked(ffmpeg).mockReturnValue(mockChain as any);

      const result = await sut.extractVideoFrames('/video.mp4', '/tmp/frames', 2, 50, 1440);

      expect(vi.mocked(ffmpeg)).toHaveBeenCalledTimes(3);
      expect(vi.mocked(ffmpeg)).toHaveBeenCalledWith('/video.mp4');
      expect(mockChain.seekInput.mock.calls.map(([t]) => t)).toEqual([0, 2, 4]);
      expect(mockChain.outputOptions).toHaveBeenCalledWith(['-frames:v 1', '-q:v 3', scaleOption]);
      expect(mockChain.output).toHaveBeenCalledWith('/tmp/frames/frame_0001.jpg');
      expect(result).toEqual([
        { path: '/tmp/frames/frame_0001.jpg', timestampMs: 0 },
        { path: '/tmp/frames/frame_0002.jpg', timestampMs: 2000 },
        { path: '/tmp/frames/frame_0003.jpg', timestampMs: 4000 },
      ]);
    });

    it('should spread frames evenly across the video when naive count exceeds maxFrames', async () => {
      // 100s video at 2s interval = 51 frames > maxFrames 4 → interval 100/4 = 25s
      mockProbe(100);
      const mockChain = buildMockChain();
      vi.mocked(ffmpeg).mockReturnValue(mockChain as any);

      const result = await sut.extractVideoFrames('/video.mp4', '/tmp/frames', 2, 4, 1440);

      expect(mockChain.seekInput.mock.calls.map(([t]) => t)).toEqual([0, 25, 50, 75]);
      expect(result.map((frame) => frame.timestampMs)).toEqual([0, 25_000, 50_000, 75_000]);
    });

    it('should not seek at or past the end of the stream', async () => {
      // 4s video at 2s interval — the naive third sample would land exactly at EOF
      mockProbe(4);
      const mockChain = buildMockChain();
      vi.mocked(ffmpeg).mockReturnValue(mockChain as any);

      const result = await sut.extractVideoFrames('/video.mp4', '/tmp/frames', 2, 50, 1440);

      expect(mockChain.seekInput.mock.calls.map(([t]) => t)).toEqual([0, 2]);
      expect(result.map((frame) => frame.timestampMs)).toEqual([0, 2000]);
    });

    it('should skip timestamps that do not produce a frame', async () => {
      vi.spyOn(fs, 'access').mockImplementation((filePath) =>
        String(filePath).endsWith('frame_0003.jpg') ? Promise.reject(new Error('ENOENT')) : Promise.resolve(),
      );

      const result = await sut.extractVideoFrames('/video.mp4', '/tmp/frames', 2, 50, 1440);

      expect(result.map((frame) => frame.timestampMs)).toEqual([0, 2000]);
    });

    it('should return no frames for a file without a video stream', async () => {
      mockProbe(60, [{ index: 0, codec_type: 'audio' }]);
      const mockChain = buildMockChain();
      vi.mocked(ffmpeg).mockReturnValue(mockChain as any);

      const result = await sut.extractVideoFrames('/audio.mp4', '/tmp/frames', 2, 50, 1440);

      expect(result).toEqual([]);
      expect(mockChain.seekInput).not.toHaveBeenCalled();
    });

    it('should extract a single frame at the start when duration is unknown', async () => {
      mockProbe();
      const mockChain = buildMockChain();
      vi.mocked(ffmpeg).mockReturnValue(mockChain as any);

      const result = await sut.extractVideoFrames('/video.mp4', '/tmp/frames', 2, 50, 1440);

      expect(mockChain.seekInput.mock.calls.map(([t]) => t)).toEqual([0]);
      expect(result).toEqual([{ path: '/tmp/frames/frame_0001.jpg', timestampMs: 0 }]);
    });

    it('should reject with stderr when every extraction fails', async () => {
      vi.mocked(ffmpeg).mockReturnValue(buildMockChain('error', 'invalid video stream') as any);

      await expect(sut.extractVideoFrames('/video.mp4', '/tmp/frames', 2, 50, 1440)).rejects.toThrow(
        'invalid video stream',
      );
    });

    it('should tolerate partial extraction failures', async () => {
      vi.mocked(ffmpeg)
        .mockReturnValueOnce(buildMockChain('error', 'corrupt segment') as any)
        .mockReturnValue(buildMockChain() as any);

      const result = await sut.extractVideoFrames('/video.mp4', '/tmp/frames', 2, 50, 1440);

      expect(result.map((frame) => frame.timestampMs)).toEqual([2000, 4000]);
    });
  });

  describe('extractVideoFrame', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should seek to the timestamp and write a single downscaled frame', async () => {
      const mockChain = buildMockChain();
      vi.mocked(ffmpeg).mockReturnValue(mockChain as any);
      vi.spyOn(fs, 'access').mockResolvedValue();

      await expect(sut.extractVideoFrame('/video.mp4', '/tmp/frame.jpg', 8, 1440)).resolves.toBe(true);

      expect(mockChain.seekInput).toHaveBeenCalledWith(8);
      expect(mockChain.outputOptions).toHaveBeenCalledWith([
        '-frames:v 1',
        '-q:v 3',
        `-vf scale='min(1440,iw)':'min(1440,ih)':force_original_aspect_ratio=decrease`,
      ]);
      expect(mockChain.output).toHaveBeenCalledWith('/tmp/frame.jpg');
    });

    it('should return false when no frame is produced', async () => {
      vi.mocked(ffmpeg).mockReturnValue(buildMockChain() as any);
      vi.spyOn(fs, 'access').mockRejectedValue(new Error('ENOENT'));

      await expect(sut.extractVideoFrame('/video.mp4', '/tmp/frame.jpg', 8, 1440)).resolves.toBe(false);
    });
  });
});
