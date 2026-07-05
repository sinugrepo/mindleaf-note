import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { compressImage } from './image-upload';

describe('compressImage', () => {
  let mockImageConfig: { width: number; height: number; error: boolean };
  let mockFileError: Error | null;
  let mockCtx: unknown;
  let capturedCanvasData: { type?: string; quality?: number; width: number; height: number } | null;

  beforeEach(() => {
    mockImageConfig = { width: 800, height: 600, error: false };
    mockFileError = null;
    mockCtx = { drawImage: vi.fn() };
    capturedCanvasData = null;

    // Mock FileReader so readAsDataURL fires onload synchronously on next
    // microtask. We set `this.error` in the failure branch so production
    // code that reads `reader.error` (see compressImage onerror handler)
    // gets the same shape a real FileReader would expose.
    vi.stubGlobal(
      'FileReader',
      class MockFileReader {
        onload: ((ev: any) => void) | null = null;
        onerror: ((ev: any) => void) | null = null;
        result: string | ArrayBuffer | null = 'data:fake_original';
        error: Error | null = null;
        readAsDataURL() {
          Promise.resolve().then(() => {
            if (mockFileError) {
              this.error = mockFileError;
              this.onerror?.(mockFileError);
            } else {
              this.onload?.({ target: { result: 'data:fake_original' } });
            }
          });
        }
      },
    );

    // Mock Image so we can control width/height and fire onload from the test
    vi.stubGlobal(
      'Image',
      class MockImage {
        width = 0;
        height = 0;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_val: string) {
          Promise.resolve().then(() => {
            if (mockImageConfig.error) {
              this.onerror?.();
            } else {
              this.width = mockImageConfig.width;
              this.height = mockImageConfig.height;
              this.onload?.();
            }
          });
        }
      },
    );

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      return mockCtx as RenderingContext;
    });

    // canvas.toBlob is async — the production code awaits via callback.
    // Capture dimensions/mime/quality at toBlob-call time so the scaling
    // tests can still observe them.
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      cb: BlobCallback | null,
      type?: string,
      quality?: number,
    ) {
      capturedCanvasData = { type, quality, width: this.width, height: this.height };
      const mime = type ?? 'image/jpeg';
      Promise.resolve().then(() => {
        cb?.(new Blob(['fake'], { type: mime }));
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createFakeFile(type: string, size: number, name = 'test_file.png') {
    const file = new File([''], name, { type });
    Object.defineProperty(file, 'size', { value: size, configurable: true });
    return file;
  }

  it('resolves with a JPEG Blob for JPEG images', async () => {
    const file = createFakeFile('image/jpeg', 500_000);
    const result = await compressImage(file);

    expect(result).toBeInstanceOf(Blob);
    expect((result as Blob).type).toBe('image/jpeg');
    expect(capturedCanvasData?.type).toBe('image/jpeg');
    expect(capturedCanvasData?.quality).toBe(0.82);
  });

  it('keeps PNG mime for small PNG files (< 300KB)', async () => {
    const file = createFakeFile('image/png', 100_000);
    const result = await compressImage(file);

    expect(result).toBeInstanceOf(Blob);
    expect((result as Blob).type).toBe('image/png');
    expect(capturedCanvasData?.type).toBe('image/png');
    expect(capturedCanvasData?.quality).toBe(1);
  });

  it('converts large PNG to JPEG for compression', async () => {
    const file = createFakeFile('image/png', 400_000);
    const result = await compressImage(file);

    expect(result).toBeInstanceOf(Blob);
    expect((result as Blob).type).toBe('image/jpeg');
    expect(capturedCanvasData?.type).toBe('image/jpeg');
    expect(capturedCanvasData?.quality).toBe(0.82);
  });

  it('scales down wide images that exceed MAX_WIDTH (1600)', async () => {
    mockImageConfig.width = 3200;
    mockImageConfig.height = 1200;

    const file = createFakeFile('image/jpeg', 100_000);
    await compressImage(file);

    expect(capturedCanvasData?.width).toBe(1600);
    expect(capturedCanvasData?.height).toBe(600);
  });

  it('scales down tall images that exceed MAX_HEIGHT (1600)', async () => {
    mockImageConfig.width = 600;
    mockImageConfig.height = 3200;

    const file = createFakeFile('image/jpeg', 100_000);
    await compressImage(file);

    expect(capturedCanvasData?.width).toBe(300);
    expect(capturedCanvasData?.height).toBe(1600);
  });

  it('does not up-scale small images', async () => {
    mockImageConfig.width = 400;
    mockImageConfig.height = 300;

    const file = createFakeFile('image/jpeg', 100_000);
    await compressImage(file);

    expect(capturedCanvasData?.width).toBe(400);
    expect(capturedCanvasData?.height).toBe(300);
  });

  it('falls back to the original File when Image fails to load', async () => {
    mockImageConfig.error = true;
    const file = createFakeFile('image/jpeg', 100_000);
    const result = await compressImage(file);

    // Fallback path returns the input File unchanged, NOT a Blob.
    expect(result).toBe(file);
  });

  it('falls back to the original File when canvas context is unavailable', async () => {
    mockCtx = null;
    const file = createFakeFile('image/jpeg', 100_000);
    const result = await compressImage(file);

    expect(result).toBe(file);
  });

  it('falls back to the original File when canvas.toBlob returns null', async () => {
    // Override the default toBlob mock for this single test to simulate
    // browser quirk: tainted canvas / OOM -> callback receives null.
    // Signature mirrors the DOM's toBlob(callback, type?, quality?). Do
    // NOT add `this` as a positional parameter — that would mis-shift
    // the args at runtime because canvas.toBlob binds `this` implicitly.
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      cb: BlobCallback | null,
    ) {
      Promise.resolve().then(() => cb?.(null));
    });

    const file = createFakeFile('image/jpeg', 100_000);
    const result = await compressImage(file);

    expect(result).toBe(file);
  });

  it('rejects when FileReader fires onerror', async () => {
    mockFileError = new Error('File read failed');
    const file = createFakeFile('image/jpeg', 100_000);

    await expect(compressImage(file)).rejects.toThrow('File read failed');
  });
});
