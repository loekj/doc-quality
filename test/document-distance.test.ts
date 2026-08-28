import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { checkQuality, analyzeTextLines } from '../src/index.js';

/**
 * A page photographed from too far away.
 *
 * This is the one failure every frame-wide check is blind to, because there is
 * nothing wrong with the frame. Focus, exposure, contrast and megapixels all
 * describe the picture, and a picture of a document across the room is an
 * excellent picture. What is wrong is the size of the writing inside it.
 */

/** A page of 10pt text, rendered at the given pixel height. */
async function page(height: number): Promise<Buffer> {
  const width = Math.round(height * 210 / 297);
  const scale = height / 1122; // 1122px is A4 at 96 DPI
  const fontSize = Math.max(4, Math.round(13 * scale));
  const leading = Math.round(fontSize * 1.5);
  const margin = Math.round(height * 0.08);
  const count = Math.floor((height - 2 * margin) / leading);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#fcfbf7"/>` +
    Array.from({ length: count }, (_, i) =>
      `<text x="${margin}" y="${margin + i * leading}" font-size="${fontSize}" ` +
      `font-family="Helvetica" fill="#191919">Statement line ${i} — total 41.20 due on receipt</text>`,
    ).join('') + '</svg>';
  return sharp(Buffer.from(svg)).flatten({ background: '#fcfbf7' }).png().toBuffer();
}

/**
 * That page laid on a desk and photographed, filling `fill` of the frame's
 * height.
 *
 * Note what this cannot express. A4 is 0.707 wide for its height, so a page at
 * 40% of the frame's height covers only 8.5% of its area — and `MIN_REGION_AREA`
 * in boundary.ts declines anything under 8%. Below roughly 0.4 here the page
 * stops being findable at all and every check downstream goes quiet, which is
 * the real ceiling on how far away this library can see. Keep test fills inside
 * 0.4 to 0.95.
 */
async function photographed(frameW: number, frameH: number, fill: number): Promise<Buffer> {
  const h = Math.round(frameH * fill);
  const buf = await page(h);
  const meta = await sharp(buf).metadata();
  return sharp({
    create: { width: frameW, height: frameH, channels: 3, background: { r: 202, g: 200, b: 197 } },
  })
    .composite([{
      input: buf,
      top: Math.round((frameH - h) / 2),
      left: Math.round((frameW - (meta.width ?? 0)) / 2),
    }])
    .jpeg({ quality: 94 })
    .toBuffer();
}

describe('a document photographed from a distance', () => {
  it('reports how little of the frame the page occupies', async () => {
    const result = await checkQuality(await photographed(1600, 1200, 0.6), { mode: 'fast' });
    const far = result.issues.find((i) => i.code === 'document-too-far');
    expect(far, 'a page covering a fifth of its frame should be reported').toBeDefined();
    expect(far!.message).toMatch(/% of the frame/);
    expect(far!.message).toMatch(/MP of page/);
  }, 60_000);

  it('says nothing when the page already fills the frame', async () => {
    // Same page, same pixel count, no room left to step closer. Whatever is
    // wrong here is the sensor's fault, and `low-resolution` owns that.
    const result = await checkQuality(await photographed(760, 1060, 0.95), { mode: 'fast' });
    expect(result.issues.map((i) => i.code)).not.toContain('document-too-far');
  }, 60_000);

  it('costs the score, and more the further away the page is', async () => {
    // It scores because it has to. Boundary detection reaching these captures
    // means they now get cropped to the page, and a crop is flattering: it
    // throws away the desk that was failing them and grades what is left. A
    // German ID card at 22% of its frame, graded 0.15 by a human, went from
    // 0.01 to a clean 1.00 the moment the page was found. Better detection and
    // this penalty are one change, not two.
    const near = await checkQuality(await photographed(1600, 1200, 0.6), { mode: 'fast' });
    const far = await checkQuality(await photographed(1600, 1200, 0.45), { mode: 'fast' });
    const issue = (r: typeof near) => r.issues.find((i) => i.code === 'document-too-far');
    expect(issue(near)?.severity).toBeUndefined();
    expect(issue(near)!.penalty).toBeLessThan(1);
    expect(issue(far)!.penalty).toBeLessThan(issue(near)!.penalty);
  }, 60_000);
});

describe('text measured on a page that never separated from its background', () => {
  it('is refused rather than reported as legible', async () => {
    // Otsu splits the frame into two classes. When the page does not fill it,
    // the split lands between desk and paper instead of between paper and ink,
    // and the whole sheet arrives as a single enormous "line" that clears every
    // legibility floor. The worst inputs used to produce the cleanest verdict.
    const buf = await photographed(3000, 4000, 0.2);
    const grey = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const metrics = analyzeTextLines(grey.data, grey.info.width, grey.info.height);
    expect(metrics).not.toBeNull();
    expect(metrics!.lineCount).toBeLessThan(2);
    expect(metrics!.medianXHeight).toBeGreaterThan(grey.info.height * 0.05);
    expect(metrics!.reliable, 'a page-sized "letter" is not a measurement').toBe(false);
  }, 60_000);

  it('trusts a page that did separate', async () => {
    const buf = await page(1600);
    const grey = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const metrics = analyzeTextLines(grey.data, grey.info.width, grey.info.height);
    expect(metrics!.reliable).toBe(true);
    expect(metrics!.lineCount).toBeGreaterThan(10);
  }, 60_000);

  it('claims nothing about legibility when the measurement is refused', async () => {
    const result = await checkQuality(await photographed(3000, 4000, 0.2), {
      mode: 'deep', timeout: 0,
    });
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('text-unmeasurable');
    expect(codes).not.toContain('illegible-text');
    expect(codes).not.toContain('text-too-small');
    expect(result.issues.find((i) => i.code === 'text-unmeasurable')!.severity).toBe('advisory');
  }, 120_000);
});

/**
 * An ID card is the case where cropping to the page destroys the measurement.
 *
 * The portrait covers a third of it and is the darkest thing on it, so once the
 * desk is cropped away the ink/paper split lands on the portrait instead of the
 * print, and the card returns as one page-sized "letter". Inside its original
 * frame the split lands between card and desk, and the print resolves.
 */
async function cardOnDesk(frameW: number, frameH: number, cardH: number): Promise<Buffer> {
  const w = Math.round(cardH * 85.6 / 54);
  const h = cardH;
  const fs = Math.max(3, Math.round(h / 14));
  const fields = ['SURNAME  DOE', 'GIVEN NAMES  JANE', 'DOB  1988-04-12', 'NO  D1234567'];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#eef2f7"/>` +
    // The portrait: dark, and a third of the card.
    `<rect x="${Math.round(w * 0.04)}" y="${Math.round(h * 0.2)}" ` +
    `width="${Math.round(w * 0.28)}" height="${Math.round(h * 0.62)}" fill="#63758a"/>` +
    fields.map((text, i) =>
      `<text x="${Math.round(w * 0.37)}" y="${Math.round(h * 0.32) + i * Math.round(fs * 1.8)}" ` +
      `font-size="${fs}" font-family="Helvetica" fill="#131c26">${text}</text>`).join('') +
    '</svg>';
  const card = await sharp(Buffer.from(svg)).flatten({ background: '#eef2f7' }).png().toBuffer();
  return sharp({
    create: { width: frameW, height: frameH, channels: 3, background: { r: 116, g: 92, b: 66 } },
  })
    .composite([{ input: card, top: Math.round((frameH - h) / 2), left: Math.round((frameW - w) / 2) }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

describe('text measured on the frame when the crop cannot be read', () => {
  /**
   * What is asserted here is that the second surface is consulted, not that it
   * rescues this particular card.
   *
   * Whether the fallback succeeds turns on where Otsu lands, and that depends
   * on the desk: a dark surface makes the frame split card-from-desk and fail
   * exactly as the crop did, while a surface light enough to split with the
   * paper stops boundary detection finding the card at all, so no crop happens
   * and there is nothing to fall back from. Every synthetic tried landed in one
   * of those two, and a fixture tuned until it threaded the gap would be
   * testing the tuning.
   *
   * The rescue itself is measured against the corpus instead: over 450 real
   * images it recovered a text verdict on 17 that returned none before — 15 ID
   * cards and 2 documents, the class whose portrait or figure defeats the crop.
   * Re-measure by counting `uncropped frame` in issue messages.
   */
  it('consults the frame before giving up on a cropped page', async () => {
    const buf = await cardOnDesk(1400, 1000, 520);
    const result = await checkQuality(buf, { mode: 'deep', preset: 'card', timeout: 0 });
    expect(result.boundary?.cropped, 'this fixture must crop for the test to mean anything').toBe(true);
    const refusal = result.issues.find((i) => i.code === 'text-unmeasurable');
    expect(refusal, 'neither surface reads this fixture').toBeDefined();
    expect(refusal!.message).toContain('on the page or on the frame around it');
  }, 120_000);

  it('leaves a readable crop alone', async () => {
    // Same card, filling its frame. Nothing to fall back to and nothing to fix.
    const buf = await cardOnDesk(1000, 660, 620);
    const result = await checkQuality(buf, { mode: 'deep', preset: 'card', timeout: 0 });
    for (const issue of result.issues) expect(issue.message).not.toContain('uncropped frame');
  }, 120_000);
});
