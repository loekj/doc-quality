import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { checkQuality } from '../src/index.js';
import type { PreflightResult } from '../src/preflight.js';

/**
 * The monotonic guarantee: if preflight rejects an image, `checkQuality` must
 * reject it too. A browser that refuses an upload the server would have
 * accepted is a bug the user experiences as "it won't let me submit".
 *
 * This exercises the real `preflight()` rather than a re-implementation of it,
 * by giving Node the small browser surface it needs. Testing a mirror would
 * only prove the mirror agrees with itself.
 *
 * The guarantee is currently *emergent*, not enforced. Nothing in the code
 * links preflight's thresholds to the backend's, and boundary cropping could
 * plausibly break it: the backend now scores the document while preflight still
 * sees the whole frame, desk included. It holds because the boundary detector
 * refuses to crop unless the document covers most of the frame, which keeps the
 * two views close. Loosen those gates and this test is what notices.
 */
let preflight: (input: Blob) => Promise<PreflightResult>;

beforeAll(async () => {
  const { createCanvas, loadImage, Image } = await import('@napi-rs/canvas');
  const g = globalThis as Record<string, unknown>;
  if (!(Image.prototype as { close?: () => void }).close) {
    (Image.prototype as { close?: () => void }).close = () => {};
  }
  g.ImageBitmap = Image;
  g.OffscreenCanvas = class {
    constructor(w: number, h: number) { return createCanvas(w, h) as unknown as object; }
  };
  g.createImageBitmap = async (input: Blob | InstanceType<typeof Image>) =>
    input instanceof Image ? input : loadImage(Buffer.from(await (input as Blob).arrayBuffer()));
  ({ preflight } = await import('../src/preflight.js'));
});

async function page(width = 1200, height = 1550): Promise<Buffer> {
  const fontSize = Math.round(height / 60);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#fbfaf6"/>` +
    Array.from({ length: 32 }, (_, i) =>
      `<text x="${Math.round(width * 0.08)}" y="${fontSize * 2 + i * Math.floor((height - fontSize * 3) / 32)}" ` +
      `font-size="${fontSize}" font-family="Helvetica" fill="#191919">` +
      `Line ${i} invoice item qty 3 unit 41.20</text>`,
    ).join('') + '</svg>';
  return sharp(Buffer.from(svg)).flatten({ background: '#fbfaf6' }).png().toBuffer();
}

/** Place the page on a coloured surface covering `coverage` of each dimension. */
async function onDesk(coverage: number, colour: string, doc: Buffer): Promise<Buffer> {
  const frameW = 1800;
  const frameH = 2200;
  const w = Math.round(frameW * coverage);
  const h = Math.round(frameH * coverage);
  const resized = await sharp(doc).resize(w, h, { fit: 'fill' }).toBuffer();
  return sharp({ create: { width: frameW, height: frameH, channels: 3, background: colour } })
    .composite([{ input: resized, left: Math.round((frameW - w) / 2), top: Math.round((frameH - h) / 2) }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function bothVerdicts(buf: Buffer) {
  const pf = await preflight(new Blob([buf], { type: 'image/jpeg' }));
  const be = await checkQuality(buf, { mode: 'thorough', preset: 'document', timeout: 0 });
  return { pf, be };
}

describe('preflight runs against the same images as the backend', () => {
  it('accepts a good page and rejects an obviously bad one', async () => {
    const good = await sharp(await page()).jpeg({ quality: 88 }).toBuffer();
    expect((await preflight(new Blob([good], { type: 'image/jpeg' }))).pass).toBe(true);

    const dark = await sharp(good).modulate({ brightness: 0.1 }).jpeg({ quality: 88 }).toBuffer();
    expect((await preflight(new Blob([dark], { type: 'image/jpeg' }))).pass).toBe(false);
  }, 60_000);
});

describe('monotonic guarantee — preflight rejects implies backend rejects', () => {
  it('holds for every reason preflight can reject', async () => {
    const good = await page();
    const cases: Array<[string, Buffer]> = [
      ['too dark', await sharp(good).modulate({ brightness: 0.08 }).jpeg({ quality: 88 }).toBuffer()],
      ['overexposed', await sharp(good).linear(1.6, 60).jpeg({ quality: 88 }).toBuffer()],
      ['very blurry', await sharp(good).blur(14).jpeg({ quality: 88 }).toBuffer()],
      ['blank page', await sharp({
        create: { width: 1200, height: 1550, channels: 3, background: '#ffffff' },
      }).jpeg({ quality: 88 }).toBuffer()],
      ['tiny resolution', await sharp(good).resize(320).jpeg({ quality: 60 }).toBuffer()],
      ['washed out', await sharp(good).linear(0.06, 225).jpeg({ quality: 88 }).toBuffer()],
    ];

    let rejectedByPreflight = 0;
    for (const [name, buf] of cases) {
      const { pf, be } = await bothVerdicts(buf);
      if (!pf.pass) {
        rejectedByPreflight++;
        expect(be.pass, `${name}: preflight rejected but the backend accepted`).toBe(false);
      }
    }
    // The cases are only meaningful if preflight actually rejects most of them.
    expect(rejectedByPreflight).toBeGreaterThanOrEqual(4);
  }, 180_000);

  it('holds across desk colours and document coverage, where cropping applies', async () => {
    // Cropping is the change most likely to break this: the backend measures
    // the document while preflight still measures the whole frame.
    const doc = await page();
    for (const coverage of [0.9, 0.75, 0.6, 0.45]) {
      for (const colour of ['#000000', '#2b2b2b', '#6e6e6e', '#e8e8e8']) {
        const img = await onDesk(coverage, colour, doc);
        const { pf, be } = await bothVerdicts(img);
        if (!pf.pass) {
          expect(be.pass, `coverage ${coverage} on ${colour}: preflight rejected, backend accepted`)
            .toBe(false);
        }
      }
    }
  }, 300_000);

  it('never rejects an image the backend scores perfectly', async () => {
    const doc = await page();
    for (const colour of ['#1a1a1a', '#6e6e6e', '#7a5c3a']) {
      const img = await onDesk(0.85, colour, doc);
      const { pf, be } = await bothVerdicts(img);
      if (be.score === 1) {
        expect(pf.pass, `${colour}: backend scored 1.00 but preflight rejected`).toBe(true);
      }
    }
  }, 120_000);
});
