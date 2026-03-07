import { describe, it, expect } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { checkQuality, createChecker, detectPreset } from '../src/index.js';

/** Create a solid-color test image */
async function makeImage(opts: {
  width?: number;
  height?: number;
  color?: { r: number; g: number; b: number };
} = {}): Promise<Buffer> {
  const {
    width = 800,
    height = 600,
    color = { r: 200, g: 200, b: 200 },
  } = opts;
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

/** Create an image with random noise (simulates edges/text) */
async function makeNoisyImage(width = 800, height = 600): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.floor(Math.random() * 256);
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

// ── checkQuality ─────────────────────────────────────────────────

describe('checkQuality', () => {
  it('returns all expected fields', async () => {
    const buffer = await makeNoisyImage(1000, 800);
    const result = await checkQuality(buffer);

    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('preset');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('metadata');
    expect(result).toHaveProperty('timing');
    expect(result.metadata.width).toBe(1000);
    expect(result.metadata.height).toBe(800);
    expect(result.metadata.megapixels).toBe(0.8);
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('accepts Uint8Array input', async () => {
    const buffer = await makeNoisyImage();
    const uint8 = new Uint8Array(buffer);
    const result = await checkQuality(uint8);
    expect(result).toHaveProperty('pass');
  });

  it('detects very small images', async () => {
    const buffer = await makeImage({ width: 100, height: 100 });
    const result = await checkQuality(buffer);
    const issue = result.issues.find((i) => i.analyzer === 'resolution');
    expect(issue).toBeDefined();
    expect(issue!.penalty).toBe(0.5);
  });

  it('detects dark images', async () => {
    const buffer = await makeImage({ color: { r: 10, g: 10, b: 10 } });
    const result = await checkQuality(buffer);
    const issue = result.issues.find((i) => i.analyzer === 'brightness');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('dark');
  });

  it('detects overexposed images', async () => {
    const buffer = await makeImage({ color: { r: 250, g: 250, b: 250 } });
    const result = await checkQuality(buffer);
    const issue = result.issues.find((i) => i.analyzer === 'brightness');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('overexposed');
  });

  it('does not flag normal brightness', async () => {
    const buffer = await makeImage({ color: { r: 180, g: 180, b: 180 } });
    const result = await checkQuality(buffer);
    const issue = result.issues.find((i) => i.analyzer === 'brightness');
    expect(issue).toBeUndefined();
  });

  it('score is multiplicative', async () => {
    const buffer = await makeImage({
      width: 100,
      height: 100,
      color: { r: 10, g: 10, b: 10 },
    });
    const result = await checkQuality(buffer);
    expect(result.score).toBeLessThan(0.5);
    expect(result.pass).toBe(false);
  });
});

// ── Auto-detection ───────────────────────────────────────────────

describe('detectPreset', () => {
  it('detects documents (standard aspect ratios)', () => {
    // A4 portrait at 300dpi: 2480×3508
    expect(detectPreset(2480, 3508)).toBe('document');
    // Letter landscape
    expect(detectPreset(3300, 2550)).toBe('document');
    // Square-ish
    expect(detectPreset(1000, 1000)).toBe('document');
  });

  it('detects cards (credit card / ID aspect ratio, small)', () => {
    // Credit card ratio ~1.586, small image
    expect(detectPreset(856, 540)).toBe('card');
    // Portrait card
    expect(detectPreset(540, 856)).toBe('card');
  });

  it('detects receipts (very elongated)', () => {
    // Tall narrow receipt
    expect(detectPreset(400, 1200)).toBe('receipt');
    // Wide panoramic scan
    expect(detectPreset(3000, 800)).toBe('receipt');
  });

  it('large card-ratio image is document not card', () => {
    // Same ratio as card but 4 MP — too large to be a card photo
    expect(detectPreset(2520, 1590)).toBe('document');
  });
});

describe('auto preset in checkQuality', () => {
  it('auto-detects and returns resolved preset', async () => {
    const buffer = await makeNoisyImage(800, 600);
    const result = await checkQuality(buffer); // default = auto
    expect(['document', 'receipt', 'card']).toContain(result.preset);
  });

  it('explicit preset overrides auto', async () => {
    const buffer = await makeNoisyImage(800, 600);
    const result = await checkQuality(buffer, { preset: 'card' });
    expect(result.preset).toBe('card');
  });
});

// ── Presets ───────────────────────────────────────────────────────

describe('presets', () => {
  it('document preset allows 0.36 MP', async () => {
    const buffer = await makeNoisyImage(600, 600);
    const result = await checkQuality(buffer, { preset: 'document' });
    const issue = result.issues.find((i) => i.analyzer === 'resolution');
    expect(issue).toBeUndefined();
  });

  it('receipt preset rejects 0.36 MP', async () => {
    const buffer = await makeNoisyImage(600, 600);
    const result = await checkQuality(buffer, { preset: 'receipt' });
    const issue = result.issues.find((i) => i.analyzer === 'resolution');
    expect(issue).toBeDefined();
  });

  it('card preset is stricter', async () => {
    const buffer = await makeNoisyImage(600, 600);
    const result = await checkQuality(buffer, { preset: 'card' });
    expect(result.preset).toBe('card');
  });
});

// ── Custom thresholds ────────────────────────────────────────────

describe('custom thresholds', () => {
  it('overrides preset thresholds', async () => {
    const buffer = await makeNoisyImage(800, 600);
    const result = await checkQuality(buffer, {
      thresholds: { resolutionMin: 1.0 },
    });
    const issue = result.issues.find((i) => i.analyzer === 'resolution');
    expect(issue).toBeDefined();
  });

  it('overrides pass threshold', async () => {
    const buffer = await makeImage({ width: 100, height: 100 });
    const lenient = await checkQuality(buffer, {
      thresholds: { passThreshold: 0.01 },
    });
    expect(lenient.pass).toBe(true);
  });
});

// ── Modes ────────────────────────────────────────────────────────

describe('modes', () => {
  it('fast mode runs fewer analyzers', async () => {
    const buffer = await makeNoisyImage();
    const fast = await checkQuality(buffer, { mode: 'fast' });
    const thorough = await checkQuality(buffer, { mode: 'thorough' });

    const fastKeys = Object.keys(fast.timing.analyzers);
    const thoroughKeys = Object.keys(thorough.timing.analyzers);
    expect(thoroughKeys.length).toBeGreaterThan(fastKeys.length);
  });

  it('thorough mode includes edge density and text contrast', async () => {
    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, { mode: 'thorough' });
    const keys = Object.keys(result.timing.analyzers);
    expect(keys).toContain('edgeDensity');
    expect(keys).toContain('textContrast');
    expect(keys).toContain('perspective');
  });
});

// ── Timeout ──────────────────────────────────────────────────────

describe('timeout', () => {
  it('returns pass on timeout', async () => {
    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, { timeout: 1 });
    expect(result).toHaveProperty('pass');
  });

  it('timeout=0 disables timeout', async () => {
    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, { timeout: 0 });
    expect(result).toHaveProperty('pass');
  });
});

// ── createChecker ────────────────────────────────────────────────

describe('createChecker', () => {
  it('creates reusable checker with defaults', async () => {
    const checker = createChecker({ preset: 'receipt', mode: 'fast' });
    const buffer = await makeNoisyImage();
    const result = await checker.check(buffer);
    expect(result).toHaveProperty('pass');
  });

  it('allows per-call overrides', async () => {
    const checker = createChecker({ preset: 'document' });
    const buffer = await makeNoisyImage(600, 600);

    const r1 = await checker.check(buffer);
    const r2 = await checker.check(buffer, {
      thresholds: { resolutionMin: 1.0 },
    });

    expect(r1.issues.find((i) => i.analyzer === 'resolution')).toBeUndefined();
    expect(r2.issues.find((i) => i.analyzer === 'resolution')).toBeDefined();
  });
});

// ── New analyzers ─────────────────────────────────────────────────

describe('analyzeDpi', () => {
  it('flags low DPI from TIFF metadata', async () => {
    // Create a TIFF with explicit low DPI (120 — below 150 threshold, not a camera default)
    const buffer = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .tiff()
      .withMetadata({ density: 120 })
      .toBuffer();
    const result = await checkQuality(buffer, {
      thresholds: { dpiMin: 150 },
    });
    const issue = result.issues.find((i) => i.analyzer === 'dpi');
    expect(issue).toBeDefined();
    expect(issue!.value).toBe(120);
  });

  it('skips camera-default DPI values (72, 96)', async () => {
    for (const density of [72, 96]) {
      const buffer = await sharp({
        create: { width: 800, height: 600, channels: 3, background: { r: 128, g: 128, b: 128 } },
      })
        .tiff()
        .withMetadata({ density })
        .toBuffer();
      const result = await checkQuality(buffer, {
        thresholds: { dpiMin: 150 },
      });
      const issue = result.issues.find((i) => i.analyzer === 'dpi');
      expect(issue).toBeUndefined();
    }
  });

  it('passes high DPI', async () => {
    const buffer = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .tiff()
      .withMetadata({ density: 300 })
      .toBuffer();
    const result = await checkQuality(buffer, {
      thresholds: { dpiMin: 150 },
    });
    const issue = result.issues.find((i) => i.analyzer === 'dpi');
    expect(issue).toBeUndefined();
  });
});

describe('analyzeBlankPage', () => {
  it('detects solid color (blank) images', async () => {
    const buffer = await makeImage({ width: 800, height: 600, color: { r: 200, g: 200, b: 200 } });
    const result = await checkQuality(buffer);
    const issue = result.issues.find((i) => i.analyzer === 'blankPage');
    expect(issue).toBeDefined();
    expect(issue!.penalty).toBe(0.1);
  });

  it('does not flag noisy images', async () => {
    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer);
    const issue = result.issues.find((i) => i.analyzer === 'blankPage');
    expect(issue).toBeUndefined();
  });
});

describe('analyzeCompression', () => {
  it('flags heavily compressed JPEG', async () => {
    // Create a large image but save as very low quality JPEG
    const buffer = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .jpeg({ quality: 1 })
      .toBuffer();
    const result = await checkQuality(buffer, {
      thresholds: { compressionBppMin: 0.5 },
    });
    const issue = result.issues.find((i) => i.analyzer === 'compression');
    expect(issue).toBeDefined();
  });

  it('skips non-JPEG formats', async () => {
    const buffer = await makeImage();
    const result = await checkQuality(buffer);
    const issue = result.issues.find((i) => i.analyzer === 'compression');
    expect(issue).toBeUndefined();
  });
});

describe('analyzeColorDepth', () => {
  it('detects grayscale content in color container (thorough mode)', async () => {
    // Grayscale values in RGB container — all channels equal
    const buffer = await makeImage({ width: 800, height: 600, color: { r: 128, g: 128, b: 128 } });
    const result = await checkQuality(buffer, { mode: 'thorough' });
    const issue = result.issues.find((i) => i.analyzer === 'colorDepth');
    expect(issue).toBeDefined();
    expect(issue!.penalty).toBe(0.97);
  });

  it('does not flag colorful images', async () => {
    const buffer = await makeImage({ width: 800, height: 600, color: { r: 255, g: 0, b: 0 } });
    const result = await checkQuality(buffer, { mode: 'thorough' });
    const issue = result.issues.find((i) => i.analyzer === 'colorDepth');
    expect(issue).toBeUndefined();
  });
});

describe('noise detection', () => {
  it('flags excessive edge density from salt-and-pepper noise', async () => {
    // Create image with salt-and-pepper noise (alternating black/white pixels)
    const width = 800;
    const height = 600;
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const val = Math.random() > 0.5 ? 255 : 0;
      pixels[i * 3] = val;
      pixels[i * 3 + 1] = val;
      pixels[i * 3 + 2] = val;
    }
    const buffer = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    const result = await checkQuality(buffer, { mode: 'thorough' });
    const edgeIssue = result.issues.find(
      (i) => i.analyzer === 'edgeDensity' && i.message.includes('noise'),
    );
    const sharpIssue = result.issues.find(
      (i) => i.analyzer === 'sharpness' && i.message.includes('noise'),
    );
    // At least one noise detector should fire
    expect(edgeIssue || sharpIssue).toBeTruthy();
  });
});

describe('analyzeShadow', () => {
  it('detects dark edges with bright center (thorough mode)', async () => {
    // Create image with dark edges and bright center
    const width = 400;
    const height = 400;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        const isEdge = y < 40 || y >= 360 || x < 40 || x >= 360;
        const val = isEdge ? 20 : 200;
        pixels[idx] = val;
        pixels[idx + 1] = val;
        pixels[idx + 2] = val;
      }
    }
    const buffer = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    const result = await checkQuality(buffer, {
      mode: 'thorough',
      thresholds: { shadowBrightnessDiff: 60 },
    });
    const issue = result.issues.find((i) => i.analyzer === 'shadow');
    expect(issue).toBeDefined();
  });
});

// ── Configurable penalties ────────────────────────────────────────

describe('configurable penalties', () => {
  it('overrides default penalty for a specific analyzer', async () => {
    const buffer = await makeImage({ width: 100, height: 100 }); // triggers resolution issue
    const defaultResult = await checkQuality(buffer);
    const overriddenResult = await checkQuality(buffer, {
      penalties: { resolution: 0.9 },
    });

    const defaultIssue = defaultResult.issues.find((i) => i.analyzer === 'resolution');
    const overriddenIssue = overriddenResult.issues.find((i) => i.analyzer === 'resolution');

    expect(defaultIssue!.penalty).toBe(0.5);
    expect(overriddenIssue!.penalty).toBe(0.9);
    expect(overriddenResult.score).toBeGreaterThan(defaultResult.score);
  });
});

// ── File path input ───────────────────────────────────────────────

describe('file path input', () => {
  it('accepts a file path string', async () => {
    const buffer = await makeNoisyImage(800, 600);
    const tmpPath = join(tmpdir(), `doc-quality-test-${Date.now()}.png`);
    await writeFile(tmpPath, buffer);
    try {
      const result = await checkQuality(tmpPath);
      expect(result).toHaveProperty('pass');
      expect(result.metadata.width).toBe(800);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

  it('throws on nonexistent path', async () => {
    await expect(checkQuality('/nonexistent/file.png')).rejects.toThrow();
  });
});
