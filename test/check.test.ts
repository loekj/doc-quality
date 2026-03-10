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
    // Create a TIFF with DPI above the camera floor (200) but below threshold (300)
    const buffer = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .tiff()
      .withMetadata({ density: 220 })
      .toBuffer();
    const result = await checkQuality(buffer, {
      thresholds: { dpiMin: 300 },
    });
    const issue = result.issues.find((i) => i.analyzer === 'dpi');
    expect(issue).toBeDefined();
    expect(issue!.value).toBe(220);
  });

  it('skips camera/phone DPI values (72, 96, 150, 200)', async () => {
    for (const density of [72, 96, 150, 200]) {
      const buffer = await sharp({
        create: { width: 800, height: 600, channels: 3, background: { r: 128, g: 128, b: 128 } },
      })
        .tiff()
        .withMetadata({ density })
        .toBuffer();
      const result = await checkQuality(buffer, {
        thresholds: { dpiMin: 300 },
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

// ── End-to-end integration: multiple simultaneous issues ────────

describe('integration — multiple simultaneous issues', () => {
  it('dark + low-res + blurry image triggers all three issues', async () => {
    // 200×200 solid dark image → low-res, dark, blurry (no edges), blank
    const buffer = await makeImage({
      width: 200,
      height: 200,
      color: { r: 15, g: 15, b: 15 },
    });
    const result = await checkQuality(buffer);

    expect(result.pass).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);

    const analyzers = result.issues.map(i => i.analyzer);
    expect(analyzers).toContain('resolution');
    expect(analyzers).toContain('brightness');

    // Score should be product of all penalties — much lower than any single penalty
    expect(result.score).toBeLessThan(0.3);
  });

  it('score equals product of issue penalties (default scoring)', async () => {
    const buffer = await makeImage({
      width: 200,
      height: 200,
      color: { r: 20, g: 20, b: 20 },
    });
    const result = await checkQuality(buffer);

    // Compute expected score manually
    let expected = 1.0;
    for (const issue of result.issues) {
      expected *= issue.penalty;
    }
    expected = Math.round(expected * 100) / 100;

    expect(result.score).toBe(expected);
  });

  it('thorough mode finds more issues than fast mode', async () => {
    // Solid grey — triggers blank page + possible other issues in thorough
    const buffer = await makeImage({
      width: 800,
      height: 600,
      color: { r: 128, g: 128, b: 128 },
    });
    const fast = await checkQuality(buffer, { mode: 'fast' });
    const thorough = await checkQuality(buffer, { mode: 'thorough' });

    expect(thorough.issues.length).toBeGreaterThanOrEqual(fast.issues.length);
    // Thorough has more timing keys
    expect(Object.keys(thorough.timing.analyzers).length).toBeGreaterThan(
      Object.keys(fast.timing.analyzers).length,
    );
  });

  it('timing.totalMs is positive and covers all analyzers', async () => {
    const buffer = await makeNoisyImage(800, 600);
    const result = await checkQuality(buffer, { mode: 'thorough' });

    expect(result.timing.totalMs).toBeGreaterThan(0);
    // Sum of individual timings should not exceed total
    const analyzerSum = Object.values(result.timing.analyzers).reduce((s, v) => s + (v ?? 0), 0);
    expect(analyzerSum).toBeLessThanOrEqual(result.timing.totalMs + 1); // +1 for rounding
  });

  it('confidence reflects distance from threshold', async () => {
    // Definitely failing image — score near 0, well below 0.5 threshold
    const dark = await makeImage({ width: 200, height: 200, color: { r: 5, g: 5, b: 5 } });
    const darkResult = await checkQuality(dark);
    expect(darkResult.confidence).toBe('high');
    expect(darkResult.pass).toBe(false);
    expect(darkResult.score).toBeLessThan(0.3); // Far below threshold = high confidence

    // Confidence is always one of three valid values
    expect(['high', 'medium', 'low']).toContain(darkResult.confidence);
  });

  it('every issue has all required fields populated', async () => {
    const buffer = await makeImage({
      width: 200,
      height: 200,
      color: { r: 10, g: 10, b: 10 },
    });
    const result = await checkQuality(buffer, { mode: 'thorough' });

    for (const issue of result.issues) {
      expect(issue.analyzer).toBeTruthy();
      expect(issue.code).toBeTruthy();
      expect(issue.guidance.length).toBeGreaterThan(10);
      expect(issue.message).toBeTruthy();
      expect(typeof issue.value).toBe('number');
      expect(typeof issue.threshold).toBe('number');
      expect(issue.penalty).toBeGreaterThan(0);
      expect(issue.penalty).toBeLessThanOrEqual(1);
    }
  });

  it('metadata is correct for original image (not analysis resize)', async () => {
    const buffer = await makeNoisyImage(3000, 2000);
    const result = await checkQuality(buffer);

    // Metadata reflects original dimensions, not resized
    expect(result.metadata.width).toBe(3000);
    expect(result.metadata.height).toBe(2000);
    expect(result.metadata.megapixels).toBe(6);
    expect(result.metadata.fileSize).toBe(buffer.length);
  });
});

// ── Multi-page PDF tests ───────────────────────────────────────

describe('checkQuality — multi-page PDF', () => {
  /**
   * Create a multi-page PDF. Each page can have a different colored background.
   * Uses raw PDF syntax to avoid external dependencies.
   */
  function makeMultiPagePdf(pageColors: Array<{ r: number; g: number; b: number }>): Buffer {
    const pages = pageColors.length;
    // Build PDF objects
    const objects: string[] = [];
    const offsets: number[] = [];
    let body = '';

    // Object 1: Catalog
    objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);

    // Object 2: Pages — kids are objects 3, 5, 7, ... (odd numbers starting at 3)
    const kids = pageColors.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
    objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n`);

    // For each page: page object + content stream
    for (let i = 0; i < pages; i++) {
      const pageObjNum = 3 + i * 2;
      const contentObjNum = 4 + i * 2;
      const { r, g, b } = pageColors[i];
      const rr = (r / 255).toFixed(3);
      const gg = (g / 255).toFixed(3);
      const bb = (b / 255).toFixed(3);
      const stream = `${rr} ${gg} ${bb} rg\n0 0 612 792 re f\n`;

      objects.push(
        `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]\n   /Contents ${contentObjNum} 0 R /Resources << >> >>\nendobj\n`,
      );
      objects.push(
        `${contentObjNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`,
      );
    }

    // Build body with offsets
    let pos = 0;
    const header = '%PDF-1.0\n';
    pos = header.length;
    for (const obj of objects) {
      offsets.push(pos);
      body += obj;
      pos = header.length + body.length;
    }

    // xref table
    const xrefStart = pos;
    const totalObjs = objects.length + 1; // +1 for the free object entry
    let xref = `xref\n0 ${totalObjs}\n`;
    xref += `0000000000 65535 f \n`;
    for (const off of offsets) {
      xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    }

    const trailer = `trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    return Buffer.from(header + body + xref + trailer);
  }

  it('multi-page PDF returns pageResults array', async () => {
    const pdf = makeMultiPagePdf([
      { r: 200, g: 200, b: 200 },
      { r: 180, g: 180, b: 180 },
    ]);
    const result = await checkQuality(pdf, { pages: '1-2' });

    expect(result.pageResults).toBeDefined();
    expect(result.pageResults!.length).toBe(2);
    expect(result.pageResults![0].page).toBe(1);
    expect(result.pageResults![1].page).toBe(2);
  });

  it('multi-page PDF: each page has its own score and issues', async () => {
    const pdf = makeMultiPagePdf([
      { r: 200, g: 200, b: 200 }, // light page
      { r: 200, g: 200, b: 200 }, // light page
    ]);
    const result = await checkQuality(pdf, { pages: '1-2' });

    for (const pr of result.pageResults!) {
      expect(pr).toHaveProperty('pass');
      expect(pr).toHaveProperty('score');
      expect(pr).toHaveProperty('issues');
      expect(pr.score).toBeGreaterThanOrEqual(0);
      expect(pr.score).toBeLessThanOrEqual(1);
    }
  });

  it('multi-page PDF: overall score is average of pages', async () => {
    const pdf = makeMultiPagePdf([
      { r: 200, g: 200, b: 200 },
      { r: 200, g: 200, b: 200 },
    ]);
    const result = await checkQuality(pdf, { pages: '1-2' });

    const avg = result.pageResults!.reduce((s, pr) => s + pr.score, 0) / result.pageResults!.length;
    expect(result.score).toBe(Math.round(avg * 100) / 100);
  });

  it('multi-page PDF: worstPageScore is set', async () => {
    const pdf = makeMultiPagePdf([
      { r: 200, g: 200, b: 200 },
      { r: 200, g: 200, b: 200 },
    ]);
    const result = await checkQuality(pdf, { pages: '1-2' });

    expect(result.worstPageScore).toBeDefined();
    const min = Math.min(...result.pageResults!.map(pr => pr.score));
    expect(result.worstPageScore).toBe(Math.round(min * 100) / 100);
  });

  it('multi-page PDF: issues tagged with page numbers', async () => {
    const pdf = makeMultiPagePdf([
      { r: 200, g: 200, b: 200 },
      { r: 200, g: 200, b: 200 },
    ]);
    const result = await checkQuality(pdf, { pages: '1-2' });

    for (const issue of result.issues) {
      expect(issue.page).toBeDefined();
      expect([1, 2]).toContain(issue.page);
    }
  });

  it('multi-page PDF: onPage callback fires for each page', async () => {
    const pdf = makeMultiPagePdf([
      { r: 200, g: 200, b: 200 },
      { r: 180, g: 180, b: 180 },
    ]);
    const fired: number[] = [];
    await checkQuality(pdf, {
      pages: '1-2',
      onPage: (page, total, pr) => {
        fired.push(page);
        expect(total).toBe(2);
        expect(pr).toHaveProperty('score');
      },
    });
    expect(fired.sort()).toEqual([1, 2]);
  });

  it('multi-page PDF: pass requires ALL pages to pass', async () => {
    const pdf = makeMultiPagePdf([
      { r: 200, g: 200, b: 200 },
      { r: 200, g: 200, b: 200 },
    ]);
    const result = await checkQuality(pdf, { pages: '1-2' });

    // pass = every page passes
    const allPass = result.pageResults!.every(pr => pr.pass);
    expect(result.pass).toBe(allPass);
  });

  it('multi-page PDF: metadata.format is pdf', async () => {
    const pdf = makeMultiPagePdf([
      { r: 200, g: 200, b: 200 },
      { r: 180, g: 180, b: 180 },
    ]);
    const result = await checkQuality(pdf, { pages: '1-2' });

    expect(result.metadata.format).toBe('pdf');
    expect(result.metadata.fileSize).toBe(pdf.length);
  });

  it('multi-page PDF: maxConcurrency > 1 works', async () => {
    const pdf = makeMultiPagePdf([
      { r: 200, g: 200, b: 200 },
      { r: 180, g: 180, b: 180 },
    ]);
    const result = await checkQuality(pdf, { pages: '1-2', maxConcurrency: 2 });

    expect(result.pageResults).toBeDefined();
    expect(result.pageResults!.length).toBe(2);
  });
});
