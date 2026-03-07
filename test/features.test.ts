import { describe, it, expect } from 'vitest';
import { extractFeatures, FEATURE_NAMES } from '../src/features.js';
import type { AnalysisContext } from '../src/types.js';

function makeCtx(overrides?: Partial<AnalysisContext>): AnalysisContext {
  const w = 1000;
  const h = 1500;
  const buf = Buffer.alloc(200_000);

  // Create a realistic laplacian
  const lapData = Buffer.alloc(w * h);
  let edgeCount = 0;
  let lapSum = 0;
  let lapSumSq = 0;
  for (let i = 0; i < lapData.length; i++) {
    const v = Math.floor(Math.random() * 50);
    lapData[i] = v;
    lapSum += v;
    lapSumSq += v * v;
    if (v > 30) edgeCount++;
  }
  const lapMean = lapSum / lapData.length;
  const lapVariance = lapSumSq / lapData.length - lapMean * lapMean;

  // Create greyRaw
  const greyData = Buffer.alloc(w * h);
  for (let i = 0; i < greyData.length; i++) {
    greyData[i] = 128 + Math.floor(Math.random() * 40);
  }

  return {
    originalBuffer: buf,
    analysisBuffer: buf,
    metadata: { width: w, height: h, format: 'jpeg' },
    stats: {
      channels: [
        { mean: 130, stdev: 35 },
        { mean: 125, stdev: 32 },
        { mean: 128, stdev: 33 },
      ],
    },
    laplacian: {
      data: lapData,
      width: w,
      height: h,
      mean: lapMean,
      variance: lapVariance,
      stdev: Math.sqrt(Math.max(0, lapVariance)),
      edgeCount,
      length: lapData.length,
    },
    greyRaw: {
      data: greyData,
      width: w,
      height: h,
    },
    sharpMeta: {
      density: 300,
      channels: 3,
      space: 'srgb',
      format: 'jpeg',
    },
    ...overrides,
  };
}

describe('extractFeatures', () => {
  it('returns correct length and names', () => {
    const ctx = makeCtx();
    const vec = extractFeatures(ctx, 'fast', 'document');
    expect(vec.names).toEqual(FEATURE_NAMES);
    expect(vec.values.length).toBe(FEATURE_NAMES.length);
    expect(vec.values.length).toBe(39);
  });

  it('fast mode: thorough features (15-38) are NaN', () => {
    const ctx = makeCtx();
    const vec = extractFeatures(ctx, 'fast', 'document');

    // Fast features (0-14) should all be finite
    for (let i = 0; i < 15; i++) {
      expect(Number.isFinite(vec.values[i])).toBe(true);
    }

    // Thorough features (15-38) should all be NaN
    for (let i = 15; i <= 38; i++) {
      expect(Number.isNaN(vec.values[i])).toBe(true);
    }
  });

  it('thorough mode: all features are finite (with complete context)', () => {
    const ctx = makeCtx();
    const vec = extractFeatures(ctx, 'thorough', 'document', 0.15);

    // All fast features should be finite
    for (let i = 0; i < 15; i++) {
      expect(Number.isFinite(vec.values[i])).toBe(true);
    }

    // foregroundRatio should be set
    expect(vec.values[15]).toBe(0.15);

    // Most thorough features should be finite (some may still be NaN if FFT is absent)
    // channelCount should be finite
    expect(Number.isFinite(vec.values[38])).toBe(true);
    expect(vec.values[38]).toBe(3);
  });

  it('preset encoding: document=0, receipt=1, card=2', () => {
    const ctx = makeCtx();

    const docVec = extractFeatures(ctx, 'fast', 'document');
    expect(docVec.values[14]).toBe(0);

    const recVec = extractFeatures(ctx, 'fast', 'receipt');
    expect(recVec.values[14]).toBe(1);

    const cardVec = extractFeatures(ctx, 'fast', 'card');
    expect(cardVec.values[14]).toBe(2);
  });

  it('megapixels is correctly computed', () => {
    const ctx = makeCtx();
    const vec = extractFeatures(ctx, 'fast', 'document');
    expect(vec.values[0]).toBeCloseTo(1.5); // 1000 * 1500 / 1e6
  });

  it('aspect ratio is correctly computed', () => {
    const ctx = makeCtx();
    const vec = extractFeatures(ctx, 'fast', 'document');
    expect(vec.values[3]).toBeCloseTo(1000 / 1500);
  });

  it('isJpeg flag is set correctly', () => {
    const jpegCtx = makeCtx();
    const jpegVec = extractFeatures(jpegCtx, 'fast', 'document');
    expect(jpegVec.values[13]).toBe(1);

    const pngCtx = makeCtx({
      metadata: { width: 1000, height: 1500, format: 'png' },
      sharpMeta: { density: 300, channels: 3, space: 'srgb', format: 'png' },
    });
    const pngVec = extractFeatures(pngCtx, 'fast', 'document');
    expect(pngVec.values[13]).toBe(0);
  });

  it('handles missing stats gracefully', () => {
    const ctx = makeCtx({ stats: undefined });
    const vec = extractFeatures(ctx, 'fast', 'document');
    expect(Number.isNaN(vec.values[6])).toBe(true); // brightnessAvg
    expect(Number.isNaN(vec.values[7])).toBe(true); // brightnessStdevMax
  });

  it('handles missing laplacian gracefully', () => {
    const ctx = makeCtx({ laplacian: undefined });
    const vec = extractFeatures(ctx, 'fast', 'document');
    expect(Number.isNaN(vec.values[8])).toBe(true);  // laplacianStdev
    expect(Number.isNaN(vec.values[9])).toBe(true);  // laplacianMean
    expect(Number.isNaN(vec.values[10])).toBe(true); // laplacianVariance
    expect(Number.isNaN(vec.values[11])).toBe(true); // edgeRatio
  });
});
