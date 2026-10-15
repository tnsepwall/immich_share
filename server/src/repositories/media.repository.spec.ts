import ffmpeg from 'fluent-ffmpeg';
import { mkdtempDisposableSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AssetEditAction, MirrorAxis } from 'src/dtos/editing.dto.js';
import { Colorspace, ImageFormat } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { automock } from 'test/utils.js';

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
  // the module's default export is what MediaRepository calls (and what vi.mock replaces)
  // eslint-disable-next-line import-x/no-named-as-default-member
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

  describe('edit (single actions)', () => {
    it('should apply crop edit correctly', async () => {
      const result = sut['edit'](
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
      const result = sut['edit'](
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
      const resultHorizontal = sut['edit'](sharp(await buildTestQuadImage()), [
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

      const resultVertical = sut['edit'](sharp(await buildTestQuadImage()), [
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

  describe('edit (multiple sequential edits)', () => {
    it('should apply horizontal mirror then vertical mirror (equivalent to 180° rotation)', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
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
      const result = sut['edit'](sharp(imageBuffer), [
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
      const result = sut['edit'](sharp(imageBuffer), [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }]);

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
      const result = sut['edit'](sharp(imageBuffer), [{ action: AssetEditAction.Rotate, parameters: { angle: 270 } }]);

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
      const result = sut['edit'](sharp(imageBuffer), [
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
      const result = sut['edit'](sharp(imageBuffer), [
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
      const result = sut['edit'](sharp(imageBuffer), [
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
      const result = sut['edit'](sharp(imageBuffer), [
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
      const result = sut['edit'](sharp(imageBuffer), [
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

  describe('generateThumbnail', () => {
    it('should process random Authentik thumbnail image', async () => {
      const response = await fetch(
        'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NHB4IiBoZWlnaHQ9IjY0cHgiIHZpZXdCb3g9IjAgMCA2NCA2NCIgdmVyc2lvbj0iMS4xIj48cmVjdCBmaWxsPSIjMzc3YjM3IiBjeD0iMzIiIGN5PSIzMiIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByPSIzMiIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBzdHlsZT0iY29sb3I6ICNmZmY7IGxpbmUtaGVpZ2h0OiAxOyBmb250LWZhbWlseTogJ1JlZEhhdFRleHQnLCdPdmVycGFzcycsb3ZlcnBhc3MsaGVsdmV0aWNhLGFyaWFsLHNhbnMtc2VyaWY7ICIgZmlsbD0iI2ZmZiIgYWxpZ25tZW50LWJhc2VsaW5lPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtc2l6ZT0iMjgiIGZvbnQtd2VpZ2h0PSI0MDAiIGR5PSIuMWVtIj5BQTwvdGV4dD48L3N2Zz4=',
      );
      const buffer = Buffer.from(await response.arrayBuffer());
      const dir = mkdtempDisposableSync(join(tmpdir(), 'media-repository-'));
      const file = join(dir.path, 'test.webp');
      const decoded = await sut.decodeImage(buffer, { colorspace: Colorspace.P3, processInvalidImages: false });
      await sut.generateThumbnail(
        decoded,
        { colorspace: Colorspace.P3, quality: 80, format: ImageFormat.Webp, processInvalidImages: false },
        file,
      );

      expect(statSync(file).blksize).toBeGreaterThan(0);
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
