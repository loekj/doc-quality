import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { checkQuality, detectDocumentBounds } from '../src/index.js';

/** A page of text at a given pixel size. */
async function page(width: number, height: number, opts: { blur?: number } = {}): Promise<Buffer> {
  const fontSize = Math.round(height / 60);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#fbfaf6"/>` +
    Array.from({ length: 32 }, (_, i) =>
      `<text x="${Math.round(width * 0.08)}" y="${fontSize * 2 + i * Math.floor((height - fontSize * 3) / 32)}" ` +
      `font-size="${fontSize}" font-family="Helvetica" fill="#191919">` +
      `Line ${i} — invoice item, quantity 3, unit 41.20, total 123.60</text>`,
    ).join('') + '</svg>';
  let pipeline = sharp(Buffer.from(svg)).flatten({ background: '#fbfaf6' });
  if (opts.blur) pipeline = pipeline.blur(opts.blur);
  return pipeline.png().toBuffer();
}

/** Place a page onto a coloured surface at a known rectangle. */
async function onDesk(
  rect: { x: number; y: number; width: number; height: number },
  colour: string,
  doc: Buffer,
  frame = { width: 1800, height: 2200 },
): Promise<Buffer> {
  const resized = await sharp(doc).resize(rect.width, rect.height, { fit: 'fill' }).toBuffer();
  return sharp({
    create: { width: frame.width, height: frame.height, channels: 3, background: colour },
  })
    .composite([{ input: resized, left: rect.x, top: rect.y }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

const RECT = { x: 144, y: 176, width: 1512, height: 1848 };

describe('document boundary detection', () => {
  it('lands within 2% of the true rectangle', async () => {
    const doc = await page(1200, 1550);
    for (const colour of ['#2b2b2b', '#6e6e6e', '#7a5c3a']) {
      const bounds = await detectDocumentBounds(await onDesk(RECT, colour, doc));
      expect(bounds).not.toBeNull();
      const x1 = Math.max(bounds!.x, RECT.x);
      const y1 = Math.max(bounds!.y, RECT.y);
      const x2 = Math.min(bounds!.x + bounds!.width, RECT.x + RECT.width);
      const y2 = Math.min(bounds!.y + bounds!.height, RECT.y + RECT.height);
      const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const union = bounds!.width * bounds!.height + RECT.width * RECT.height - intersection;
      expect(intersection / union).toBeGreaterThan(0.98);
    }
  }, 120_000);

  it('declines when the surface is nearly as bright as the page', async () => {
    const doc = await page(1200, 1550);
    expect(await detectDocumentBounds(await onDesk(RECT, '#e8e8e8', doc))).toBeNull();
  }, 60_000);
});

describe('cropping to the detected document', () => {
  it('stops grading the desk along with the page', async () => {
    const doc = await page(1200, 1550);
    for (const colour of ['#2b2b2b', '#6e6e6e', '#7a5c3a', '#0d0d0d']) {
      const image = await onDesk(RECT, colour, doc);

      const cropped = await checkQuality(image, { mode: 'thorough', preset: 'document', timeout: 0 });
      expect(cropped.boundary?.cropped).toBe(true);
      expect(cropped.score).toBe(1);
      expect(cropped.issues.filter((i) => i.severity !== 'advisory')).toHaveLength(0);
      expect(cropped.metadata.width).toBeLessThan(1800);

      // The desk was the whole problem: put it back and the page is "shadowed".
      const whole = await checkQuality(image, {
        mode: 'thorough', preset: 'document', timeout: 0, cropToBounds: false,
      });
      expect(whole.boundary?.cropped).toBe(false);
      expect(whole.score).toBeLessThan(cropped.score);
      expect(whole.issues.map((i) => i.code)).toContain('shadow-on-edges');
    }
  }, 180_000);

  it('needs all four edges before it will crop', async () => {
    // Flush to the bottom of the frame: three edges resolve, the fourth cannot.
    // Cropping on three leaves the desk along the fourth, and a hard dark strip
    // reads as a shadow — worse than the uncropped frame.
    const image = await onDesk(
      { x: 144, y: 352, width: 1512, height: 1848 },
      '#2b2b2b',
      await page(1200, 1550),
    );
    const bounds = await detectDocumentBounds(image);
    expect(bounds!.edgesDetected).toBeLessThan(4);

    const result = await checkQuality(image, { mode: 'thorough', preset: 'document', timeout: 0 });
    expect(result.boundary?.cropped).toBe(false);
  }, 90_000);

  it('leaves a bare page alone', async () => {
    const bare = await sharp(await page(1200, 1550)).jpeg({ quality: 90 }).toBuffer();
    const result = await checkQuality(bare, { mode: 'thorough', preset: 'document', timeout: 0 });
    expect(result.boundary?.cropped).not.toBe(true);
    expect(result.pass).toBe(true);
  }, 60_000);

  it('still catches a genuinely bad page after cropping', async () => {
    const image = await onDesk(RECT, '#2b2b2b', await page(1200, 1550, { blur: 6 }));
    const result = await checkQuality(image, { mode: 'thorough', preset: 'document', timeout: 0 });
    expect(result.boundary?.cropped).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('blurry');
  }, 90_000);

  it('measures compression against the encoded frame, not the crop', async () => {
    // Bits-per-pixel divides the file's bytes by the pixels it encodes. Using
    // the cropped subregion instead would invent compression that is not there.
    const doc = await page(1200, 1550);
    const image = await onDesk(RECT, '#2b2b2b', doc);
    const cropped = await checkQuality(image, { mode: 'thorough', preset: 'document', timeout: 0 });
    const whole = await checkQuality(image, {
      mode: 'thorough', preset: 'document', timeout: 0, cropToBounds: false,
    });
    const bppOf = (r: typeof cropped) =>
      r.issues.find((i) => i.code === 'heavy-compression')?.value;
    expect(bppOf(cropped)).toBe(bppOf(whole));
  }, 90_000);
});
