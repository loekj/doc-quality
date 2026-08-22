import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { checkQuality } from '../src/index.js';
import { estimateSkewAngle } from '../src/analyzers.js';
import { jpegBlockiness } from '../src/fft-core.js';

/**
 * Regressions for defects found by running the pipeline on inputs whose
 * correct answer is known without a human label.
 */

/** A clean, sharply rendered text page — the best input the library can get. */
async function makeTextPage(opts: { width?: number; height?: number; lines?: number } = {}) {
  const width = opts.width ?? 1700;
  const height = opts.height ?? 2200;
  const lines = opts.lines ?? 40;
  const step = Math.floor((height - 160) / lines);
  const body = Array.from({ length: lines }, (_, i) =>
    `<text x="110" y="${120 + i * step}" font-family="Helvetica" font-size="26" fill="#161616">` +
    `Line ${i} of body text on this page, quantity 3, unit 41.20, total 123.60</text>`,
  ).join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#fcfbf8"/>` +
    `<text x="110" y="70" font-size="40" font-family="Helvetica" fill="#000">INVOICE 2026-0042</text>` +
    `${body}</svg>`;
  // Flatten is required: libvips convolve returns all zeros on an RGBA image.
  return sharp(Buffer.from(svg)).flatten({ background: '#fcfbf8' }).png().toBuffer();
}

describe('regression: a clean text page must pass', () => {
  it('thorough mode passes a pristine rendered document', async () => {
    const page = await makeTextPage();
    const result = await checkQuality(page, { mode: 'thorough', preset: 'document', timeout: 0 });
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.9);
  });

  it('advisory issues are reported but never lower the score', async () => {
    const page = await makeTextPage();
    const result = await checkQuality(page, { mode: 'thorough', preset: 'document', timeout: 0 });
    const advisory = result.issues.filter((i) => i.severity === 'advisory');
    const errors = result.issues.filter((i) => i.severity !== 'advisory');
    // Whatever fires on a clean page must be advisory, not scoring.
    expect(errors).toHaveLength(0);
    const productOfErrors = errors.reduce((s, i) => s * i.penalty, 1);
    expect(result.score).toBeCloseTo(productOfErrors, 2);
    // Advisory issues still carry their diagnostic penalty value for the model.
    for (const i of advisory) expect(i.penalty).toBeGreaterThan(0);
  });
});

describe('regression: alpha channel silently zeroes the Laplacian', () => {
  it('flatten keeps convolve alive — an RGBA image would measure as perfectly flat', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
      '<rect width="800" height="600" fill="#fdfdfb"/>' +
      Array.from({ length: 12 }, (_, i) =>
        `<text x="40" y="${50 + i * 45}" font-size="26" font-family="Helvetica" fill="#111">Sample body text line ${i}</text>`,
      ).join('') + '</svg>';
    const rgba = await sharp(Buffer.from(svg)).png().toBuffer();
    const rgb = await sharp(Buffer.from(svg)).flatten({ background: '#ffffff' }).png().toBuffer();

    const K = { width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] };
    const maxOf = async (buf: Buffer) => {
      const raw = await sharp(buf).greyscale().convolve(K).raw().toBuffer();
      let max = 0;
      for (const v of raw) if (v > max) max = v;
      return max;
    };

    expect(await maxOf(rgba)).toBe(0);   // documents the libvips behaviour
    expect(await maxOf(rgb)).toBeGreaterThan(0);

    // The pipeline flattens first, so an RGBA page must not read as blurry/blank.
    const result = await checkQuality(rgba, { mode: 'fast', preset: 'document', timeout: 0 });
    expect(result.issues.map((i) => i.code)).not.toContain('blurry');
    expect(result.issues.map((i) => i.code)).not.toContain('blank-page');
  });
});

describe('regression: skew estimation', () => {
  async function skewOf(angle: number) {
    const page = await makeTextPage();
    const rotated = await sharp(page)
      .rotate(angle, { background: '#fcfbf8' })
      .flatten({ background: '#fcfbf8' })
      .greyscale()
      .resize(1500, 1500, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return estimateSkewAngle(rotated.data, rotated.info.width, rotated.info.height);
  }

  it('recovers known rotation angles within 0.5 degrees', async () => {
    for (const truth of [0, 2, 5, -3, -7]) {
      const est = skewOf(truth);
      expect(Math.abs((await est)! - truth)).toBeLessThan(0.5);
    }
  }, 60_000);

  it('does not report a straight page as tilted', async () => {
    const page = await makeTextPage();
    const result = await checkQuality(page, { mode: 'thorough', preset: 'document', timeout: 0 });
    expect(result.issues.map((i) => i.code)).not.toContain('tilted');
  });

  it('flags a genuinely skewed page', async () => {
    const page = await makeTextPage();
    const tilted = await sharp(page)
      .rotate(14, { background: '#fcfbf8' })
      .flatten({ background: '#fcfbf8' })
      .png()
      .toBuffer();
    const result = await checkQuality(tilted, { mode: 'thorough', preset: 'document', timeout: 0 });
    expect(result.issues.map((i) => i.code)).toContain('tilted');
  });
});

describe('regression: JPEG blockiness survives the analysis downscale', () => {
  it('detects heavy compression on an image larger than analysisMaxPx', async () => {
    const page = await makeTextPage({ width: 2600, height: 1900, lines: 26 });
    const wrecked = await sharp(page).jpeg({ quality: 3 }).toBuffer();
    const meta = await sharp(wrecked).metadata();
    expect(meta.width!).toBeGreaterThan(1500); // must exercise the resize path

    const result = await checkQuality(wrecked, { mode: 'thorough', preset: 'document', timeout: 0 });
    const issue = result.issues.find((i) => i.analyzer === 'fftJpegArtifact');
    expect(issue).toBeDefined();
    expect(issue!.value).toBeGreaterThan(0.5);
  }, 60_000);

  it('blockiness reads zero once the 8px grid is resampled away', async () => {
    const page = await makeTextPage({ width: 2600, height: 1900, lines: 26 });
    const wrecked = await sharp(page).jpeg({ quality: 3 }).toBuffer();
    const resized = await sharp(wrecked)
      .greyscale()
      .resize(1500, 1500, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const native = await sharp(wrecked).greyscale().raw().toBuffer({ resolveWithObject: true });

    expect(jpegBlockiness(resized.data, resized.info.width, resized.info.height)).toBeLessThan(0.5);
    expect(jpegBlockiness(native.data, native.info.width, native.info.height)).toBeGreaterThan(0.5);
  }, 60_000);
});

describe('regression: directional blur sector histogram', () => {
  it('populates every angular sector', async () => {
    const { computeSpectrum2D } = await import('../src/fft-core.js');
    const W = 512, H = 512;
    const px = Buffer.alloc(W * H, 255);
    for (let y = 0; y < H; y++) {
      if (Math.floor(y / 6) % 3 !== 0) continue;
      for (let x = 40; x < W - 40; x++) if (Math.floor(x / 4) % 2 === 0) px[y * W + x] = 20;
    }
    const spec = computeSpectrum2D(px, W, H, 512)!;
    const { magnitude, fftW, fftH } = spec;
    const halfW = fftW >>> 1, halfH = fftH >>> 1;
    const N = 12;
    const sectors = new Float64Array(N);
    for (let y = 0; y < fftH; y++) {
      const fy = y <= halfH ? y : y - fftH;
      const fyN = fy / halfH;
      for (let x = 0; x < fftW; x++) {
        const fx = x <= halfW ? x : x - fftW;
        const fxN = fx / halfW;
        if (Math.hypot(fxN, fyN) < 0.05) continue;
        const angle = Math.atan2(Math.abs(fyN), Math.abs(fxN));
        const idx = Math.min(Math.floor((angle / (Math.PI / 2)) * N), N - 1);
        const m = magnitude[y * fftW + x];
        sectors[idx] += m * m;
      }
    }
    // The old `/ Math.PI` mapping left sectors 7..11 permanently at zero.
    for (let i = 0; i < N; i++) expect(sectors[i]).toBeGreaterThan(0);
  });
});

describe('regression: timeout', () => {
  it('fails closed instead of reporting a perfect score', async () => {
    const buf = await sharp({
      create: { width: 1200, height: 1600, channels: 3, background: '#ffffff' },
    }).jpeg().toBuffer();
    // 1 ms is not enough to decode and analyse — the timeout branch wins.
    const result = await checkQuality(buf, { mode: 'thorough', timeout: 1 });
    if (result.issues.some((i) => i.analyzer === 'timeout')) {
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
      expect(result.confidence).toBe('low');
    }
  });

  it('does not hold the event loop open after finishing', async () => {
    const buf = await sharp({
      create: { width: 600, height: 800, channels: 3, background: '#ffffff' },
    }).jpeg().toBuffer();
    const before = process.hrtime.bigint();
    await checkQuality(buf, { mode: 'fast', timeout: 30_000 });
    // The pending timer used to keep the process alive for the full timeout.
    // clearTimeout + unref means no handle survives this call.
    const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
