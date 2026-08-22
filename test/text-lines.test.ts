import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { checkQuality, analyzeTextLines, estimateSkewAngle } from '../src/index.js';

/** A page of 10pt text rendered at a given DPI. */
async function pageAt(dpi: number, opts: { blur?: number; fade?: boolean } = {}): Promise<Buffer> {
  const width = Math.round(8.5 * dpi);
  const height = Math.round(11 * dpi);
  const scale = dpi / 72;
  const fontSize = Math.round(10 * scale);
  const leading = Math.round(14 * scale);
  const lines = Math.floor((height - 2 * dpi) / leading);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#fbfaf6"/>` +
    Array.from({ length: lines }, (_, i) =>
      `<text x="${Math.round(dpi)}" y="${Math.round(dpi) + i * leading}" font-size="${fontSize}" ` +
      `font-family="Helvetica" fill="#181818">The quick brown fox jumps over the lazy dog ${i} — invoice 41.20</text>`,
    ).join('') + '</svg>';

  let pipeline = sharp(Buffer.from(svg)).flatten({ background: '#fbfaf6' });
  if (opts.blur) pipeline = pipeline.blur(opts.blur);
  if (opts.fade) pipeline = pipeline.linear(0.12, 215);
  return pipeline.png().toBuffer();
}

async function metricsOf(buf: Buffer) {
  const grey = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const skew = estimateSkewAngle(grey.data, grey.info.width, grey.info.height) ?? 0;
  return analyzeTextLines(grey.data, grey.info.width, grey.info.height, skew);
}

describe('text-line detection', () => {
  it('finds every line on the page', async () => {
    const metrics = await metricsOf(await pageAt(200));
    expect(metrics).not.toBeNull();
    expect(metrics!.lineCount).toBeGreaterThan(30);
  }, 60_000);

  it('still finds them on a tilted page', async () => {
    const tilted = await sharp(await pageAt(200))
      .rotate(6, { background: '#fbfaf6' })
      .flatten({ background: '#fbfaf6' })
      .png()
      .toBuffer();
    const straight = await metricsOf(await pageAt(200));
    const rotated = await metricsOf(tilted);
    expect(rotated).not.toBeNull();
    // Deskewing before projection keeps the line count stable.
    expect(Math.abs(rotated!.lineCount - straight!.lineCount)).toBeLessThanOrEqual(2);
  }, 60_000);

  it('returns null when there is no text', async () => {
    const blank = await sharp({
      create: { width: 800, height: 1000, channels: 3, background: '#ffffff' },
    }).png().toBuffer();
    expect(await metricsOf(blank)).toBeNull();
  });
});

describe('x-height tracks capture resolution', () => {
  it('scales linearly with DPI', async () => {
    const measured: Array<[number, number]> = [];
    for (const dpi of [96, 150, 300]) {
      const metrics = await metricsOf(await pageAt(dpi));
      measured.push([dpi, metrics!.medianXHeight]);
    }
    // 10pt text has an x-height near 5.2pt, so px ≈ dpi * 5.2/72.
    for (const [dpi, xHeight] of measured) {
      const expected = (dpi * 5.2) / 72;
      expect(Math.abs(xHeight - expected)).toBeLessThan(2.5);
    }
    // Strictly increasing.
    expect(measured[0][1]).toBeLessThan(measured[1][1]);
    expect(measured[1][1]).toBeLessThan(measured[2][1]);
  }, 90_000);
});

describe('stroke sharpness separates blur from fading', () => {
  it('stays high for faded but crisp text, collapses under blur', async () => {
    const sharpText = await metricsOf(await pageAt(300));
    const faded = await metricsOf(await pageAt(300, { fade: true }));
    const blurred = await metricsOf(await pageAt(300, { blur: 3 }));

    // Fading lowers contrast without softening the strokes.
    expect(faded!.medianContrast).toBeLessThan(sharpText!.medianContrast / 2);
    expect(faded!.medianStrokeSharpness).toBeGreaterThan(0.5);

    // Blur softens the strokes, which is what the normalised metric is for.
    expect(blurred!.medianStrokeSharpness).toBeLessThan(0.4);
  }, 90_000);
});

describe('deep mode', () => {
  it('passes a clean 300 DPI page', async () => {
    const result = await checkQuality(await pageAt(300), {
      mode: 'deep', preset: 'document', timeout: 0,
    });
    expect(result.pass).toBe(true);
    expect(result.issues.filter((i) => i.analyzer === 'textLines')).toHaveLength(0);
  }, 90_000);

  it('catches a low-DPI capture that page-level checks call clean', async () => {
    const buf = await pageAt(96);
    const thorough = await checkQuality(buf, { mode: 'thorough', preset: 'document', timeout: 0 });
    const deep = await checkQuality(buf, { mode: 'deep', preset: 'document', timeout: 0 });

    // The image really is clean — it is simply too small to read.
    expect(thorough.pass).toBe(true);
    expect(deep.pass).toBe(false);
    expect(deep.issues.map((i) => i.code)).toContain('text-too-small');
  }, 90_000);

  it('catches blur that survives the analysis downscale', async () => {
    const buf = await pageAt(300, { blur: 3 });
    const thorough = await checkQuality(buf, { mode: 'thorough', preset: 'document', timeout: 0 });
    const deep = await checkQuality(buf, { mode: 'deep', preset: 'document', timeout: 0 });
    expect(thorough.pass).toBe(true);
    expect(deep.pass).toBe(false);
    expect(deep.issues.map((i) => i.code)).toContain('illegible-text');
  }, 90_000);

  it('reports counts a user can act on', async () => {
    const deep = await checkQuality(await pageAt(96), {
      mode: 'deep', preset: 'document', timeout: 0,
    });
    const issue = deep.issues.find((i) => i.code === 'illegible-text');
    expect(issue).toBeDefined();
    expect(issue!.message).toMatch(/\d+ of \d+ text lines/);
  }, 90_000);

  it('does not report an issue twice', async () => {
    const buf = await sharp(await pageAt(300)).jpeg({ quality: 8 }).toBuffer();
    const deep = await checkQuality(buf, { mode: 'deep', preset: 'document', timeout: 0 });
    const codes = deep.issues.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
  }, 90_000);

  it('exposes text-line features to the model', async () => {
    let names: readonly string[] = [];
    let values = new Float64Array();
    await checkQuality(await pageAt(300), {
      mode: 'deep', preset: 'document', timeout: 0,
      scorer: (f) => { names = f.names; values = f.values; return 1; },
    });
    const idx = names.indexOf('textMedianXHeight');
    expect(idx).toBeGreaterThan(-1);
    expect(values[idx]).toBeGreaterThan(15); // ~22px at 300 DPI
    expect(values[names.indexOf('textIllegibleFraction')]).toBe(0);
  }, 90_000);
});
