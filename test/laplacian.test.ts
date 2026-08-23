import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { signedLaplacian, clipToUint8 } from '../src/laplacian.js';
import { checkQuality, FEATURE_NAMES } from '../src/index.js';

const KERNEL = { width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] };

async function textPage(width: number, height: number, fontSize: number): Promise<Buffer> {
  const rows = Math.floor(height / (fontSize * 2));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#fbfaf6"/>` +
    Array.from({ length: rows }, (_, i) =>
      `<text x="60" y="${fontSize * 2 + i * fontSize * 2}" font-size="${fontSize}" ` +
      `font-family="Helvetica" fill="#181818">Line ${i} the quick brown fox 41.20</text>`,
    ).join('') + '</svg>';
  return sharp(Buffer.from(svg)).flatten({ background: '#fbfaf6' }).png().toBuffer();
}

describe('signed Laplacian', () => {
  /**
   * The whole switch rests on this: the analyzers and their tuned thresholds
   * keep reading the exact same numbers, so nothing needed recalibrating.
   * If this drifts, every sharpness and edge-density threshold silently moves.
   */
  it('clips to exactly what sharp.convolve produced', async () => {
    for (const [w, h, fs] of [[800, 600, 26], [1500, 1900, 26], [400, 400, 14]] as const) {
      const buf = await textPage(w, h, fs);
      const grey = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
      const viaSharp = await sharp(buf).greyscale().convolve(KERNEL).raw().toBuffer();

      const signed = signedLaplacian(grey.data, grey.info.width, grey.info.height, 30);
      const derived = clipToUint8(signed.data);

      expect(derived.length).toBe(viaSharp.length);
      expect(Buffer.compare(derived, viaSharp)).toBe(0);
    }
  }, 90_000);

  it('keeps the signal that clipping destroys', async () => {
    const buf = await textPage(1500, 1900, 26);
    const grey = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const signed = signedLaplacian(grey.data, grey.info.width, grey.info.height, 30);
    const clipped = clipToUint8(signed.data);

    let clippedSum = 0;
    let clippedSumSq = 0;
    for (const v of clipped) { clippedSum += v; clippedSumSq += v * v; }
    const mean = clippedSum / clipped.length;
    const clippedStdev = Math.sqrt(clippedSumSq / clipped.length - mean * mean);

    // A sharp page pins a real share of its pixels at the uint8 ceiling.
    expect(signed.saturationRatio).toBeGreaterThan(0.01);
    // And the signed spread is far wider than what survives clipping.
    expect(signed.stdev).toBeGreaterThan(clippedStdev * 1.5);
  }, 60_000);

  it('separates blur levels more widely than the clipped version', async () => {
    const base = await textPage(1500, 1900, 26);
    const measure = async (blur: number) => {
      const buf = blur ? await sharp(base).blur(blur).png().toBuffer() : base;
      const grey = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
      const signed = signedLaplacian(grey.data, grey.info.width, grey.info.height, 30);
      const clipped = clipToUint8(signed.data);
      let sum = 0, sumSq = 0;
      for (const v of clipped) { sum += v; sumSq += v * v; }
      const m = sum / clipped.length;
      return { signed: signed.stdev, clipped: Math.sqrt(sumSq / clipped.length - m * m) };
    };
    const sharpest = await measure(0);
    const blurred = await measure(8);

    expect(sharpest.signed / blurred.signed).toBeGreaterThan(sharpest.clipped / blurred.clipped);
    // Both must still fall monotonically — this is a better metric, not a new one.
    expect(sharpest.signed).toBeGreaterThan(blurred.signed);
  }, 90_000);

  it('handles degenerate sizes without throwing', () => {
    for (const [w, h] of [[1, 1], [1, 10], [10, 1], [2, 2], [3, 3]] as const) {
      const px = new Uint8Array(w * h).fill(128);
      const result = signedLaplacian(px, w, h, 30);
      expect(result.data.length).toBe(w * h);
      expect(Number.isFinite(result.stdev)).toBe(true);
      expect(Number.isFinite(result.meanAbs)).toBe(true);
    }
  });

  it('reads zero on a uniform image', () => {
    const px = new Uint8Array(64 * 64).fill(200);
    const result = signedLaplacian(px, 64, 64, 30);
    expect(result.stdev).toBe(0);
    expect(result.meanAbs).toBe(0);
    expect(result.edgeRatio).toBe(0);
    expect(result.saturationRatio).toBe(0);
  });

  it('exposes the signed statistics in thorough and deep, not fast', async () => {
    const buf = await textPage(1200, 1500, 26);
    const featuresFor = async (mode: 'fast' | 'thorough' | 'deep') => {
      let values = new Float64Array();
      await checkQuality(buf, {
        mode, preset: 'document', timeout: 0,
        scorer: (f) => { values = f.values; return 1; },
      });
      return (name: string) => values[FEATURE_NAMES.indexOf(name)];
    };

    for (const mode of ['thorough', 'deep'] as const) {
      const at = await featuresFor(mode);
      expect(at('laplacianSignedStdev')).toBeGreaterThan(0);
      expect(at('laplacianSignedMeanAbs')).toBeGreaterThan(0);
      expect(at('laplacianSaturationRatio')).toBeGreaterThanOrEqual(0);
    }

    // Fast mode keeps libvips' cheaper clipped convolve — computing the signed
    // version there doubles the step, which is the one thing fast mode sells.
    const fast = await featuresFor('fast');
    expect(Number.isNaN(fast('laplacianSignedStdev'))).toBe(true);
    // ...but the clipped features it does produce are still populated.
    expect(fast('laplacianStdev')).toBeGreaterThan(0);
  }, 90_000);
});
