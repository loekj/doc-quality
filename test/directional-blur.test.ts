import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { analyzeDirectionalBlur } from '../src/analyzers.js';
import { DEFAULT_THRESHOLDS } from '../src/defaults.js';
import { computeSpectrum2D } from '../src/fft-core.js';
import type { AnalysisContext } from '../src/types.js';

const t = DEFAULT_THRESHOLDS;

/** Build an AnalysisContext with fftSpectrum from a buffer */
async function ctxFrom(buf: Buffer): Promise<AnalysisContext> {
  const meta = await sharp(buf).metadata();
  const grey = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });

  return {
    originalBuffer: buf,
    analysisBuffer: buf,
    metadata: { width: meta.width!, height: meta.height! },
    greyRaw: { data: grey.data, width: grey.info.width, height: grey.info.height },
    fftSpectrum: computeSpectrum2D(grey.data, grey.info.width, grey.info.height, 512) ?? undefined,
  };
}

describe('analyzeDirectionalBlur', () => {
  it('returns null for a uniformly sharp image', async () => {
    // Random noise — energy distributed uniformly across angles
    const w = 400, h = 400;
    const pixels = Buffer.alloc(w * h * 3);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = Math.floor(Math.random() * 256);
    }
    const buf = await sharp(pixels, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const ctx = await ctxFrom(buf);
    expect(analyzeDirectionalBlur(ctx, t)).toBeNull();
  });

  it('detects horizontal motion blur', async () => {
    // Create a synthetic image with strong horizontal structure (vertical lines)
    // then blur only horizontally to simulate motion blur
    const w = 400, h = 400;
    const pixels = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const offset = (y * w + x) * 3;
        // Random per-column, constant per row → horizontal motion blur kills it
        pixels[offset] = Math.floor(Math.random() * 256);
        pixels[offset + 1] = pixels[offset];
        pixels[offset + 2] = pixels[offset];
      }
    }
    const sharp0 = await sharp(pixels, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toBuffer();

    // Simulate horizontal motion blur by averaging each row in a sliding window
    const grey = await sharp(sharp0).greyscale().raw().toBuffer({ resolveWithObject: true });
    const src = grey.data;
    const gw = grey.info.width, gh = grey.info.height;
    const dst = Buffer.alloc(gw * gh * 3);
    const radius = 20;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let sum = 0, count = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < gw) { sum += src[y * gw + nx]; count++; }
        }
        const v = Math.round(sum / count);
        const o = (y * gw + x) * 3;
        dst[o] = v; dst[o + 1] = v; dst[o + 2] = v;
      }
    }
    const blurred = await sharp(dst, { raw: { width: gw, height: gh, channels: 3 } })
      .png()
      .toBuffer();

    const ctx = await ctxFrom(blurred);
    const issue = analyzeDirectionalBlur(ctx, t);
    expect(issue).not.toBeNull();
    expect(issue!.analyzer).toBe('directionalBlur');
  });

  it('returns null for uniformly blurry image (isotropic blur)', async () => {
    // Gaussian blur is isotropic — no directional preference
    const w = 400, h = 400;
    const pixels = Buffer.alloc(w * h * 3);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = Math.floor(Math.random() * 256);
    }
    const buf = await sharp(pixels, { raw: { width: w, height: h, channels: 3 } })
      .blur(10)
      .png()
      .toBuffer();

    const ctx = await ctxFrom(buf);
    // Isotropic blur should not trigger directional blur
    const issue = analyzeDirectionalBlur(ctx, t);
    expect(issue).toBeNull();
  });

  it('returns null when fftSpectrum is missing', () => {
    const ctx: AnalysisContext = {
      originalBuffer: Buffer.alloc(0),
      analysisBuffer: Buffer.alloc(0),
      metadata: { width: 400, height: 400 },
    };
    expect(analyzeDirectionalBlur(ctx, t)).toBeNull();
  });
});
