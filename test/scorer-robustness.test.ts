import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { checkQuality } from '../src/index.js';
import type { FeatureVector } from '../src/features.js';
import type { Issue } from '../src/types.js';

async function makeNoisyImage(width = 800, height = 600): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.floor(Math.random() * 256);
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe('scorer fallback — pipeline never crashes', () => {
  it('falls back to default scoring when scorer throws', async () => {
    const buffer = await makeNoisyImage(1000, 800);
    const throwingScorer = () => { throw new Error('model exploded'); };
    const result = await checkQuality(buffer, { scorer: throwingScorer });

    // Should not crash — should produce a valid result via default scoring
    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('score');
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('falls back to default scoring when scorer returns NaN', async () => {
    const buffer = await makeNoisyImage(1000, 800);
    const nanScorer = () => NaN;
    const result = await checkQuality(buffer, { scorer: nanScorer });

    expect(Number.isFinite(result.score)).toBe(true);
  });

  it('falls back to default scoring when scorer returns Infinity', async () => {
    const buffer = await makeNoisyImage(1000, 800);
    const infScorer = () => Infinity;
    const result = await checkQuality(buffer, { scorer: infScorer });

    expect(Number.isFinite(result.score)).toBe(true);
  });

  it('clamps scorer output to [0, 1]', async () => {
    const buffer = await makeNoisyImage(1000, 800);
    const overScorer = () => 1.5;
    const result = await checkQuality(buffer, { scorer: overScorer });

    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('uses ML score when scorer works correctly', async () => {
    const buffer = await makeNoisyImage(1000, 800);
    const fixedScorer = () => 0.42;
    const result = await checkQuality(buffer, { scorer: fixedScorer });

    expect(result.score).toBe(0.42);
  });

  it('default scoring unchanged when no scorer provided', async () => {
    const buffer = await makeNoisyImage(1000, 800);
    const r1 = await checkQuality(buffer);
    const r2 = await checkQuality(buffer);

    // Same input → same score (deterministic pipeline)
    expect(r1.score).toBe(r2.score);
    expect(r1.issues.length).toBe(r2.issues.length);
  });

  it('issues are still present when scorer is used', async () => {
    const buffer = await makeNoisyImage(1000, 800);
    const withScorer = await checkQuality(buffer, { scorer: () => 0.9 });
    const withoutScorer = await checkQuality(buffer);

    // Both should detect the same issues — scorer only replaces scoring, not detection
    expect(withScorer.issues.length).toBe(withoutScorer.issues.length);
    expect(withScorer.issues.map(i => i.code).sort())
      .toEqual(withoutScorer.issues.map(i => i.code).sort());
  });

  it('scorer receives well-formed FeatureVector', async () => {
    const buffer = await makeNoisyImage(1000, 800);
    let captured: FeatureVector | null = null;

    await checkQuality(buffer, {
      scorer: (features: FeatureVector, _issues: Issue[]) => {
        captured = features;
        return 0.5;
      },
    });

    expect(captured).not.toBeNull();
    expect(captured!.names.length).toBe(captured!.values.length);
    expect(captured!.values).toBeInstanceOf(Float64Array);
    // Fast-mode features should be finite (except dpi at index 12 which may be NaN
    // when image metadata lacks density info — synthetic test images don't have it)
    for (let i = 0; i < 15; i++) {
      if (i === 12) continue; // dpi — NaN is valid when metadata absent
      expect(Number.isFinite(captured!.values[i])).toBe(true);
    }
  });

  it('scorer receives issues array with all detected issues', async () => {
    const buffer = await makeNoisyImage(1000, 800);
    let capturedIssues: Issue[] = [];

    const result = await checkQuality(buffer, {
      scorer: (_features: FeatureVector, issues: Issue[]) => {
        capturedIssues = issues;
        return 0.5;
      },
    });

    // Issues passed to scorer match issues in result
    expect(capturedIssues.length).toBe(result.issues.length);
  });
});
