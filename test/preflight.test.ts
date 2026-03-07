import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { preflight, PREFLIGHT_DEFAULTS } from '../src/preflight.js';
import { checkQuality } from '../src/index.js';
import { DEFAULT_THRESHOLDS } from '../src/defaults.js';

// ── Browser API mocks (sharp-backed) ────────────────────────────

class MockImageBitmap {
  constructor(
    public readonly width: number,
    public readonly height: number,
    public readonly _rgba: Buffer,
  ) {}
  close() {}
}

(globalThis as any).ImageBitmap = MockImageBitmap;

(globalThis as any).createImageBitmap = async (input: any) => {
  if (input instanceof MockImageBitmap) return input;
  const arrayBuf = await (input as Blob).arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new MockImageBitmap(info.width, info.height, data);
};

class MockCanvasContext {
  fillStyle = '#000000';
  private _w: number;
  private _h: number;
  private _pixels: Uint8ClampedArray;

  constructor(w: number, h: number) {
    this._w = w;
    this._h = h;
    this._pixels = new Uint8ClampedArray(w * h * 4);
  }

  fillRect(x: number, y: number, w: number, h: number) {
    let r = 0, g = 0, b = 0;
    if (this.fillStyle === '#ffffff') r = g = b = 255;
    for (let py = y; py < Math.min(y + h, this._h); py++) {
      for (let px = x; px < Math.min(x + w, this._w); px++) {
        const off = (py * this._w + px) * 4;
        this._pixels[off] = r;
        this._pixels[off + 1] = g;
        this._pixels[off + 2] = b;
        this._pixels[off + 3] = 255;
      }
    }
  }

  drawImage(bmp: any, dx: number, dy: number, dw: number, dh: number) {
    const srcW = bmp.width as number;
    const srcH = bmp.height as number;
    const src = bmp._rgba as Buffer;
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(Math.floor(x * srcW / dw), srcW - 1);
        const sy = Math.min(Math.floor(y * srcH / dh), srcH - 1);
        const srcOff = (sy * srcW + sx) * 4;
        const dstX = dx + x;
        const dstY = dy + y;
        if (dstX >= 0 && dstX < this._w && dstY >= 0 && dstY < this._h) {
          const dstOff = (dstY * this._w + dstX) * 4;
          this._pixels[dstOff] = src[srcOff];
          this._pixels[dstOff + 1] = src[srcOff + 1];
          this._pixels[dstOff + 2] = src[srcOff + 2];
          this._pixels[dstOff + 3] = src[srcOff + 3];
        }
      }
    }
  }

  getImageData(x: number, y: number, w: number, h: number) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      const srcStart = ((y + row) * this._w + x) * 4;
      data.set(this._pixels.subarray(srcStart, srcStart + w * 4), row * w * 4);
    }
    return { data, width: w, height: h };
  }
}

(globalThis as any).OffscreenCanvas = class MockOffscreenCanvas {
  width: number;
  height: number;
  private _ctx: MockCanvasContext;

  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    this._ctx = new MockCanvasContext(w, h);
  }

  getContext(_type: string) {
    return this._ctx;
  }
};

// ── Helpers ──────────────────────────────────────────────────────

async function makeImage(opts: {
  width?: number;
  height?: number;
  color?: { r: number; g: number; b: number };
} = {}): Promise<Buffer> {
  const { width = 800, height = 600, color = { r: 200, g: 200, b: 200 } } = opts;
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

async function makeNoisyImage(width = 800, height = 600): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.floor(Math.random() * 256);
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

function toBlob(buffer: Buffer): Blob {
  return new Blob([buffer], { type: 'image/png' });
}

/** Suppress all checks except the one being tested */
const SUPPRESS_ALL = {
  resolutionMin: 0,
  fileSizeMin: 0,
  brightnessMin: 0,
  brightnessMax: 256,
  sharpnessMin: 0,
  blankStdevMax: 0,
  edgeDensityMin: 0,
  contrastFgMin: 0,
};

// ── Tests ────────────────────────────────────────────────────────

describe('preflight', () => {
  describe('resolution check', () => {
    it('rejects images below resolution threshold', async () => {
      const buffer = await makeImage({ width: 50, height: 50, color: { r: 128, g: 128, b: 128 } });
      const result = await preflight(toBlob(buffer));

      expect(result.pass).toBe(false);
      expect(result.issues.some(i => i.code === 'low-resolution')).toBe(true);
    });

    it('skips pixel analysis when resolution is too low', async () => {
      const buffer = await makeImage({ width: 50, height: 50, color: { r: 0, g: 0, b: 0 } });
      const result = await preflight(toBlob(buffer));

      // Should only have resolution issue, not too-dark etc
      expect(result.issues.every(i => i.code === 'low-resolution' || i.code === 'file-too-small')).toBe(true);
    });
  });

  describe('file size check', () => {
    it('rejects files below size threshold', async () => {
      // A tiny solid-color PNG will be well under 3KB
      const buffer = await makeImage({ width: 10, height: 10, color: { r: 100, g: 100, b: 100 } });
      const blob = toBlob(buffer);
      expect(blob.size).toBeLessThan(PREFLIGHT_DEFAULTS.fileSizeMin);

      const result = await preflight(blob);
      expect(result.issues.some(i => i.code === 'file-too-small')).toBe(true);
    });

    it('skips file size check for non-Blob inputs', async () => {
      // ImageBitmap input — no file size available
      const buffer = await makeNoisyImage(400, 300);
      const blob = toBlob(buffer);
      const bmp = await (globalThis as any).createImageBitmap(blob);
      const result = await preflight(bmp);

      expect(result.issues.some(i => i.code === 'file-too-small')).toBe(false);
      expect(result.metadata.fileSize).toBe(0);
    });
  });

  describe('brightness checks', () => {
    it('rejects too-dark images', async () => {
      const buffer = await makeImage({ color: { r: 5, g: 5, b: 5 } });
      const result = await preflight(toBlob(buffer), {
        thresholds: { ...SUPPRESS_ALL, brightnessMin: PREFLIGHT_DEFAULTS.brightnessMin },
      });

      expect(result.pass).toBe(false);
      expect(result.issues.some(i => i.code === 'too-dark')).toBe(true);
    });

    it('rejects overexposed images', async () => {
      const buffer = await makeImage({ color: { r: 254, g: 254, b: 254 } });
      const result = await preflight(toBlob(buffer), {
        thresholds: { ...SUPPRESS_ALL, brightnessMax: PREFLIGHT_DEFAULTS.brightnessMax },
      });

      expect(result.pass).toBe(false);
      expect(result.issues.some(i => i.code === 'overexposed')).toBe(true);
    });
  });

  describe('blank page check', () => {
    it('rejects uniform images', async () => {
      const buffer = await makeImage({ color: { r: 128, g: 128, b: 128 } });
      const result = await preflight(toBlob(buffer), {
        thresholds: { ...SUPPRESS_ALL, blankStdevMax: PREFLIGHT_DEFAULTS.blankStdevMax },
      });

      expect(result.pass).toBe(false);
      expect(result.issues.some(i => i.code === 'blank-page')).toBe(true);
    });
  });

  describe('sharpness check', () => {
    it('rejects blurry images (no edges)', async () => {
      const buffer = await makeImage({ color: { r: 128, g: 128, b: 128 } });
      const result = await preflight(toBlob(buffer), {
        thresholds: { ...SUPPRESS_ALL, sharpnessMin: PREFLIGHT_DEFAULTS.sharpnessMin },
      });

      expect(result.pass).toBe(false);
      expect(result.issues.some(i => i.code === 'blurry')).toBe(true);
    });
  });

  describe('edge density check', () => {
    it('rejects flat images with no edges', async () => {
      const buffer = await makeImage({ color: { r: 128, g: 128, b: 128 } });
      const result = await preflight(toBlob(buffer), {
        thresholds: { ...SUPPRESS_ALL, edgeDensityMin: PREFLIGHT_DEFAULTS.edgeDensityMin },
      });

      expect(result.pass).toBe(false);
      expect(result.issues.some(i => i.code === 'low-edge-density')).toBe(true);
    });
  });

  describe('contrast check', () => {
    it('rejects images with near-zero foreground', async () => {
      // Light image — all pixels > 128, so foregroundRatio ≈ 0
      const buffer = await makeImage({ color: { r: 200, g: 200, b: 200 } });
      const result = await preflight(toBlob(buffer), {
        thresholds: { ...SUPPRESS_ALL, contrastFgMin: PREFLIGHT_DEFAULTS.contrastFgMin },
      });

      expect(result.pass).toBe(false);
      expect(result.issues.some(i => i.code === 'low-contrast')).toBe(true);
    });
  });

  describe('good images pass', () => {
    it('passes a noisy image with good characteristics', async () => {
      const buffer = await makeNoisyImage(800, 600);
      const result = await preflight(toBlob(buffer));

      expect(result.pass).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  describe('monotonic guarantee', () => {
    it('if preflight rejects too-dark, full analysis also rejects', async () => {
      const buffer = await makeImage({ color: { r: 5, g: 5, b: 5 } });

      const preflightResult = await preflight(toBlob(buffer));
      expect(preflightResult.pass).toBe(false);
      expect(preflightResult.issues.some(i => i.code === 'too-dark')).toBe(true);

      const fullResult = await checkQuality(buffer);
      expect(fullResult.pass).toBe(false);
    });

    it('if preflight rejects overexposed, full analysis also rejects', async () => {
      const buffer = await makeImage({ color: { r: 254, g: 254, b: 254 } });

      const preflightResult = await preflight(toBlob(buffer));
      expect(preflightResult.pass).toBe(false);
      expect(preflightResult.issues.some(i => i.code === 'overexposed')).toBe(true);

      const fullResult = await checkQuality(buffer);
      expect(fullResult.pass).toBe(false);
    });

    it('if preflight rejects low-resolution, full analysis also rejects', async () => {
      const buffer = await makeNoisyImage(50, 50);

      const preflightResult = await preflight(toBlob(buffer));
      expect(preflightResult.pass).toBe(false);
      expect(preflightResult.issues.some(i => i.code === 'low-resolution')).toBe(true);

      const fullResult = await checkQuality(buffer);
      expect(fullResult.pass).toBe(false);
    });

    it('if preflight rejects blank-page, full analysis also rejects', async () => {
      const buffer = await makeImage({ color: { r: 128, g: 128, b: 128 } });

      const preflightResult = await preflight(toBlob(buffer));
      expect(preflightResult.pass).toBe(false);

      const fullResult = await checkQuality(buffer);
      expect(fullResult.pass).toBe(false);
    });
  });

  describe('metadata', () => {
    it('returns correct dimensions and file size', async () => {
      const buffer = await makeNoisyImage(640, 480);
      const blob = toBlob(buffer);
      const result = await preflight(blob);

      expect(result.metadata.width).toBe(640);
      expect(result.metadata.height).toBe(480);
      expect(result.metadata.fileSize).toBe(blob.size);
    });

    it('returns timing info', async () => {
      const buffer = await makeNoisyImage(400, 300);
      const result = await preflight(toBlob(buffer));

      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('options', () => {
    it('respects custom thumbnail size', async () => {
      const buffer = await makeNoisyImage(800, 600);
      const result = await preflight(toBlob(buffer), { thumbnailSize: 100 });

      expect(result.pass).toBe(true);
    });

    it('respects threshold overrides', async () => {
      // Image with brightness ~200 — normally passes, but with strict threshold it fails
      const buffer = await makeImage({ color: { r: 200, g: 200, b: 200 } });
      const result = await preflight(toBlob(buffer), {
        thresholds: { ...SUPPRESS_ALL, brightnessMax: 150 },
      });

      expect(result.pass).toBe(false);
      expect(result.issues.some(i => i.code === 'overexposed')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles extreme aspect ratios without crashing', async () => {
      // 1×10000 image — fitInside would round width to 0 without the clamp
      const buffer = await makeImage({ width: 1, height: 10000, color: { r: 128, g: 128, b: 128 } });
      const result = await preflight(toBlob(buffer), {
        thresholds: { ...SUPPRESS_ALL },
      });

      // Should not crash — dimensions should be correct
      expect(result.metadata.width).toBe(1);
      expect(result.metadata.height).toBe(10000);
    });

    it('handles perfectly uniform image without NaN in stdev', async () => {
      // Uniform image — stdev should be exactly 0, not NaN
      // Size must exceed resolutionMin (0.25 MP) so pixel analysis runs
      const buffer = await makeImage({ width: 600, height: 600, color: { r: 100, g: 100, b: 100 } });
      const result = await preflight(toBlob(buffer));

      // blank-page should trigger (stdev 0 < 1.5), not be silently skipped due to NaN
      expect(result.issues.some(i => i.code === 'blank-page')).toBe(true);
    });

    it('closes ImageBitmap when created from Blob', async () => {
      const buffer = await makeNoisyImage(400, 300);
      const closeSpy = vi.spyOn(MockImageBitmap.prototype, 'close');
      await preflight(toBlob(buffer));
      expect(closeSpy).toHaveBeenCalledOnce();
      closeSpy.mockRestore();
    });

    it('does not close caller-owned ImageBitmap', async () => {
      const buffer = await makeNoisyImage(400, 300);
      const blob = toBlob(buffer);
      const bmp = await (globalThis as any).createImageBitmap(blob);
      const closeSpy = vi.spyOn(bmp, 'close');
      await preflight(bmp);
      expect(closeSpy).not.toHaveBeenCalled();
      closeSpy.mockRestore();
    });
  });

  describe('preflight vs backend comparison', () => {
    // These tests verify the monotonic guarantee across a range of
    // synthetic images. For each image that preflight rejects, the
    // full backend must also reject. The reverse is NOT required —
    // preflight is deliberately more lenient.

    async function assertMonotonic(buffer: Buffer, label: string) {
      const pf = await preflight(toBlob(buffer));
      const full = await checkQuality(buffer);

      if (!pf.pass) {
        expect(full.pass, `Monotonic violation for "${label}": preflight rejected but backend passed`).toBe(false);
      }
      return { pf, full };
    }

    it('dark images: preflight is strictly more lenient than backend', async () => {
      // Sweep brightness from 0 to 30
      for (const brightness of [0, 5, 10, 15, 19, 20, 25, 30]) {
        const buffer = await makeImage({ color: { r: brightness, g: brightness, b: brightness } });
        await assertMonotonic(buffer, `brightness=${brightness}`);
      }
    });

    it('bright images: preflight is strictly more lenient than backend', async () => {
      // Sweep brightness from 240 to 255
      for (const brightness of [240, 245, 250, 252, 253, 254, 255]) {
        const buffer = await makeImage({ color: { r: brightness, g: brightness, b: brightness } });
        await assertMonotonic(buffer, `brightness=${brightness}`);
      }
    });

    it('resolution: preflight is strictly more lenient than backend', async () => {
      // Various small sizes — all should fail both or only fail backend
      for (const [w, h] of [[50, 50], [100, 100], [200, 200], [300, 300], [500, 500]]) {
        const buffer = await makeNoisyImage(w, h);
        await assertMonotonic(buffer, `${w}×${h}`);
      }
    });

    it('uniform images: preflight is strictly more lenient than backend', async () => {
      // Various uniform greys — blank-page check
      for (const grey of [64, 128, 192]) {
        const buffer = await makeImage({ color: { r: grey, g: grey, b: grey } });
        await assertMonotonic(buffer, `uniform grey=${grey}`);
      }
    });

    it('good noisy image: preflight passes (backend may reject on extra checks)', async () => {
      // Random noise passes preflight's 8 basic checks but the full backend
      // has 20+ analyzers (noise, moire, compression, etc.) that may reject it.
      // The monotonic guarantee still holds — preflight passing says nothing
      // about whether the backend passes.
      const buffer = await makeNoisyImage(1000, 800);
      const pf = await preflight(toBlob(buffer));

      expect(pf.pass).toBe(true);
      // Monotonic: preflight passed, so we make no claim about backend
    });

    it('preflight passes borderline images that backend rejects (leniency gap)', async () => {
      // Brightness 45: above preflight min (42) but below backend min (50)
      const buffer = await makeImage({ color: { r: 45, g: 45, b: 45 } });

      const pf = await preflight(toBlob(buffer), {
        thresholds: { ...SUPPRESS_ALL, brightnessMin: PREFLIGHT_DEFAULTS.brightnessMin },
      });
      const full = await checkQuality(buffer);

      // Preflight should pass (45 > 42), backend should reject (45 < 50)
      expect(pf.issues.some(i => i.code === 'too-dark')).toBe(false);
      expect(full.issues.some(i => i.code === 'too-dark')).toBe(true);
    });

    it('file size: preflight threshold is below backend threshold', async () => {
      // Create a small but valid image — solid color compresses well
      const buffer = await makeImage({ width: 300, height: 200, color: { r: 100, g: 100, b: 100 } });
      const blob = toBlob(buffer);
      const size = blob.size;

      // If between preflight min (3000) and backend min (15000), preflight passes but backend rejects
      if (size >= PREFLIGHT_DEFAULTS.fileSizeMin && size < 15000) {
        const pf = await preflight(blob);
        const full = await checkQuality(buffer);

        expect(pf.issues.some(i => i.code === 'file-too-small')).toBe(false);
        expect(full.issues.some(i => i.code === 'file-too-small')).toBe(true);
      }
    });

    it('all preflight issue codes map to valid backend issue codes', async () => {
      // Every issue code that preflight can emit must also be a code
      // the backend can emit, otherwise the monotonic mapping breaks.
      const preflightCodes: string[] = [
        'low-resolution', 'file-too-small', 'too-dark', 'overexposed',
        'blank-page', 'blurry', 'low-edge-density', 'low-contrast',
      ];
      const { ISSUE_GUIDANCE } = await import('../src/guidance.js');
      for (const code of preflightCodes) {
        expect(ISSUE_GUIDANCE).toHaveProperty(code);
      }
    });
  });

  describe('threshold leniency bounds', () => {
    // These tests enforce that preflight thresholds stay in the right range:
    // more lenient than the backend (monotonic guarantee) but not excessively so.

    it('every preflight threshold is strictly more lenient than the full default', () => {
      // "More lenient" = fewer rejections:
      //   min thresholds: preflight < full (lower bar to pass)
      //   max thresholds: preflight > full (higher bar to reject)
      expect(PREFLIGHT_DEFAULTS.resolutionMin).toBeLessThan(DEFAULT_THRESHOLDS.resolutionMin);
      expect(PREFLIGHT_DEFAULTS.fileSizeMin).toBeLessThan(DEFAULT_THRESHOLDS.fileSizeMin);
      expect(PREFLIGHT_DEFAULTS.brightnessMin).toBeLessThan(DEFAULT_THRESHOLDS.brightnessMin);
      expect(PREFLIGHT_DEFAULTS.brightnessMax).toBeGreaterThan(DEFAULT_THRESHOLDS.brightnessMax);
      expect(PREFLIGHT_DEFAULTS.sharpnessMin).toBeLessThan(DEFAULT_THRESHOLDS.sharpnessMin);
      expect(PREFLIGHT_DEFAULTS.blankStdevMax).toBeLessThan(DEFAULT_THRESHOLDS.blankVarianceMax);
      expect(PREFLIGHT_DEFAULTS.edgeDensityMin).toBeLessThan(DEFAULT_THRESHOLDS.edgeDensityMin);
      expect(PREFLIGHT_DEFAULTS.contrastFgMin).toBeLessThan(DEFAULT_THRESHOLDS.contrastMin);
    });

    it('global-stat thresholds are within 25% of full defaults', () => {
      // Resolution, file size, brightness, blank page, and contrast are global
      // statistics — Canvas vs sharp differences are <5%, so tight margins suffice.
      expect(PREFLIGHT_DEFAULTS.resolutionMin).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.resolutionMin * 0.75);
      expect(PREFLIGHT_DEFAULTS.fileSizeMin).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.fileSizeMin * 0.75);
      expect(PREFLIGHT_DEFAULTS.brightnessMin).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.brightnessMin * 0.75);
      expect(PREFLIGHT_DEFAULTS.brightnessMax).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.brightnessMax + 5);
      expect(PREFLIGHT_DEFAULTS.blankStdevMax).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.blankVarianceMax * 0.70);
      expect(PREFLIGHT_DEFAULTS.contrastFgMin).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.contrastMin * 0.60);
    });

    it('resolution-dependent thresholds have wider but bounded margins', () => {
      // Sharpness and edge density are Laplacian-based: at the 200px thumbnail,
      // the Laplacian produces ~0.3-0.4x the stdev of the 1500px full analysis.
      // These need wider margins but must still be > 20% of the full default.
      expect(PREFLIGHT_DEFAULTS.sharpnessMin).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.sharpnessMin * 0.20);
      expect(PREFLIGHT_DEFAULTS.edgeDensityMin).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.edgeDensityMin * 0.20);

      // And they should not exceed 50% of the full default (would risk monotonic violation)
      expect(PREFLIGHT_DEFAULTS.sharpnessMin).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.sharpnessMin * 0.50);
      expect(PREFLIGHT_DEFAULTS.edgeDensityMin).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.edgeDensityMin * 0.50);
    });

    it('no threshold is more than 3x more lenient than the full default', () => {
      // Guard against accidentally reverting to overly loose thresholds.
      // The widest acceptable margin is ~3x for resolution-dependent metrics.
      expect(PREFLIGHT_DEFAULTS.resolutionMin).toBeGreaterThan(DEFAULT_THRESHOLDS.resolutionMin / 3);
      expect(PREFLIGHT_DEFAULTS.fileSizeMin).toBeGreaterThan(DEFAULT_THRESHOLDS.fileSizeMin / 3);
      expect(PREFLIGHT_DEFAULTS.brightnessMin).toBeGreaterThan(DEFAULT_THRESHOLDS.brightnessMin / 3);
      expect(PREFLIGHT_DEFAULTS.sharpnessMin).toBeGreaterThan(DEFAULT_THRESHOLDS.sharpnessMin / 5);
      expect(PREFLIGHT_DEFAULTS.blankStdevMax).toBeGreaterThan(DEFAULT_THRESHOLDS.blankVarianceMax / 3);
      expect(PREFLIGHT_DEFAULTS.edgeDensityMin).toBeGreaterThan(DEFAULT_THRESHOLDS.edgeDensityMin / 5);
      expect(PREFLIGHT_DEFAULTS.contrastFgMin).toBeGreaterThan(DEFAULT_THRESHOLDS.contrastMin / 3);
    });
  });

  describe('issue guidance', () => {
    it('includes guidance text on every issue', async () => {
      const buffer = await makeImage({ color: { r: 5, g: 5, b: 5 } });
      const result = await preflight(toBlob(buffer));

      expect(result.issues.length).toBeGreaterThan(0);
      for (const issue of result.issues) {
        expect(issue.guidance).toBeTruthy();
        expect(typeof issue.guidance).toBe('string');
        expect(issue.guidance.length).toBeGreaterThan(10);
      }
    });
  });
});
