import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { analyzeZoneQuality } from '../src/analyzers.js';
import { DEFAULT_THRESHOLDS } from '../src/defaults.js';
import type { AnalysisContext, Thresholds } from '../src/types.js';

const t = DEFAULT_THRESHOLDS;

/** Build a minimal AnalysisContext with greyRaw and laplacian from a buffer */
async function ctxFrom(buf: Buffer): Promise<AnalysisContext> {
  const meta = await sharp(buf).metadata();
  const grey = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const lap = await sharp(buf)
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lapData = lap.data;
  const lapLen = lapData.length;
  let lapSum = 0, lapSumSq = 0, edgeCount = 0;
  for (let i = 0; i < lapLen; i++) {
    const v = lapData[i];
    lapSum += v;
    lapSumSq += v * v;
    if (v > 30) edgeCount++;
  }
  const lapMean = lapSum / lapLen;
  const lapVariance = lapSumSq / lapLen - lapMean * lapMean;

  return {
    originalBuffer: buf,
    analysisBuffer: buf,
    metadata: { width: meta.width!, height: meta.height! },
    greyRaw: { data: grey.data, width: grey.info.width, height: grey.info.height },
    laplacian: {
      data: lapData,
      width: lap.info.width,
      height: lap.info.height,
      mean: lapMean,
      variance: lapVariance,
      stdev: Math.sqrt(Math.max(0, lapVariance)),
      edgeCount,
      length: lapLen,
    },
  };
}

describe('analyzeZoneQuality', () => {
  it('returns null for a uniform image', async () => {
    const buf = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 180, g: 180, b: 180 } },
    }).png().toBuffer();
    const ctx = await ctxFrom(buf);
    expect(analyzeZoneQuality(ctx, t)).toBeNull();
  });

  it('detects one dark quadrant (zone brightness issue)', async () => {
    // Create image: top-left quadrant is dark, rest is bright
    const w = 400, h = 400;
    const pixels = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const offset = (y * w + x) * 3;
        const bright = (y < h / 2 && x < w / 2) ? 30 : 200;
        pixels[offset] = bright;
        pixels[offset + 1] = bright;
        pixels[offset + 2] = bright;
      }
    }
    const buf = await sharp(pixels, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const ctx = await ctxFrom(buf);
    const issue = analyzeZoneQuality(ctx, t);
    expect(issue).not.toBeNull();
    expect(issue!.analyzer).toBe('zoneQuality');
    expect(issue!.message).toContain('brightness');
  });

  it('detects one blurry quadrant (zone sharpness issue)', async () => {
    // Create image with textured content in 3 quadrants, blurred in bottom-right
    const w = 400, h = 400;
    const pixels = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const offset = (y * w + x) * 3;
        if (y >= h / 2 && x >= w / 2) {
          // Bottom-right: uniform (no edges → low sharpness)
          pixels[offset] = 128;
          pixels[offset + 1] = 128;
          pixels[offset + 2] = 128;
        } else {
          // Other quadrants: high-frequency checkerboard pattern
          const v = ((x + y) % 2 === 0) ? 50 : 200;
          pixels[offset] = v;
          pixels[offset + 1] = v;
          pixels[offset + 2] = v;
        }
      }
    }
    const buf = await sharp(pixels, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const ctx = await ctxFrom(buf);
    const issue = analyzeZoneQuality(ctx, t);
    expect(issue).not.toBeNull();
    expect(issue!.analyzer).toBe('zoneQuality');
  });

  it('returns null for images too small to subdivide', async () => {
    const buf = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 180, g: 180, b: 180 } },
    }).png().toBuffer();
    const ctx = await ctxFrom(buf);
    expect(analyzeZoneQuality(ctx, t)).toBeNull();
  });
});
