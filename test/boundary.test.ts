import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { checkQuality, createChecker } from '../src/index.js';
import type { BoundaryDetectorFn } from '../src/index.js';

async function makeNoisyImage(width = 800, height = 600): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.floor(Math.random() * 256);
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

const mockDetector: BoundaryDetectorFn = async () => ({
  detected: true,
  region: { x: 50, y: 50, width: 700, height: 500 },
  confidence: 0.9,
});

describe('boundary detection — mode gating', () => {
  it('fast mode skips boundary detection even when detector provided', async () => {
    let called = false;
    const detector: BoundaryDetectorFn = async () => {
      called = true;
      return { detected: true, region: { x: 0, y: 0, width: 100, height: 100 }, confidence: 0.9 };
    };

    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, {
      mode: 'fast',
      boundaryDetector: detector,
    });

    expect(called).toBe(false);
    expect(result.boundary).toBeUndefined();
  });

  it('thorough mode runs boundary detection when detector provided', async () => {
    let called = false;
    const detector: BoundaryDetectorFn = async () => {
      called = true;
      return { detected: true, region: { x: 50, y: 50, width: 700, height: 500 }, confidence: 0.9 };
    };

    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, {
      mode: 'thorough',
      boundaryDetector: detector,
    });

    expect(called).toBe(true);
    expect(result.boundary).toBeDefined();
    expect(result.boundary!.detected).toBe(true);
  });

  it('thorough mode without detector has no boundary', async () => {
    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, { mode: 'thorough' });
    expect(result.boundary).toBeUndefined();
  });
});

describe('boundary detection — behavior', () => {
  it('uses cropped buffer for analysis when provided', async () => {
    const croppedBuffer = await makeNoisyImage(100, 100);
    const detector: BoundaryDetectorFn = async () => ({
      detected: true,
      region: { x: 0, y: 0, width: 100, height: 100 },
      confidence: 0.95,
      croppedBuffer,
    });

    const buffer = await makeNoisyImage(1000, 800);
    const result = await checkQuality(buffer, {
      mode: 'thorough',
      boundaryDetector: detector,
    });

    expect(result.metadata.width).toBe(100);
    expect(result.metadata.height).toBe(100);
    expect(result.issues.find((i) => i.analyzer === 'resolution')).toBeDefined();
  });

  it('does not crop when detected=false', async () => {
    const detector: BoundaryDetectorFn = async () => ({
      detected: false,
      confidence: 0.1,
    });

    const buffer = await makeNoisyImage(1000, 800);
    const result = await checkQuality(buffer, {
      mode: 'thorough',
      boundaryDetector: detector,
    });
    expect(result.boundary!.detected).toBe(false);
    expect(result.metadata.width).toBe(1000);
  });

  it('falls back gracefully when detector returns null', async () => {
    const detector: BoundaryDetectorFn = async () => null;
    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, {
      mode: 'thorough',
      boundaryDetector: detector,
    });
    expect(result.boundary).toBeUndefined();
    expect(result).toHaveProperty('pass');
  });

  it('swallows detector errors', async () => {
    const detector: BoundaryDetectorFn = async () => {
      throw new Error('OpenCV crashed');
    };

    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, {
      mode: 'thorough',
      boundaryDetector: detector,
    });
    expect(result).toHaveProperty('pass');
    expect(result.boundary).toBeUndefined();
  });

  it('auto-detect uses boundary region dimensions', async () => {
    const detector: BoundaryDetectorFn = async () => ({
      detected: true,
      region: { x: 100, y: 100, width: 856, height: 540 },
      confidence: 0.9,
    });

    const buffer = await makeNoisyImage(1000, 800);
    const result = await checkQuality(buffer, {
      mode: 'thorough',
      boundaryDetector: detector,
    });
    expect(result.preset).toBe('card');
  });
});

describe('boundary detection — createChecker', () => {
  it('passes boundaryDetector through in thorough mode', async () => {
    const checker = createChecker({
      mode: 'thorough',
      boundaryDetector: mockDetector,
    });
    const buffer = await makeNoisyImage();
    const result = await checker.check(buffer);
    expect(result.boundary).toBeDefined();
    expect(result.boundary!.detected).toBe(true);
  });

  it('skips boundary in fast mode even with checker defaults', async () => {
    const checker = createChecker({
      mode: 'fast',
      boundaryDetector: mockDetector,
    });
    const buffer = await makeNoisyImage();
    const result = await checker.check(buffer);
    expect(result.boundary).toBeUndefined();
  });
});
