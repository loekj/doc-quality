import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { detectPreset, checkQuality } from '../src/index.js';

/** Pixel dimensions of a paper size at a given DPI. */
const at = (dpi: number, wIn: number, hIn: number): [number, number] =>
  [Math.round(wIn * dpi), Math.round(hIn * dpi)];

const A4: [number, number] = [8.27, 11.69];
const LETTER: [number, number] = [8.5, 11];
const LEGAL: [number, number] = [8.5, 14];
const ID1: [number, number] = [3.370, 2.125]; // ISO 7810 ID-1, 85.6 x 53.98 mm

describe('detectPreset — paper', () => {
  it('reads A4 as a document at every capture resolution', () => {
    // Below roughly 145 DPI, A4 falls under 2 MP, and its 0.707 aspect used to
    // land inside the card band. Card applies a stricter zone-uniformity limit
    // that a normal page fails, so identical content scored 1.00 as a document
    // and 0.70 as a card.
    for (const dpi of [72, 96, 110, 120, 140, 150, 200, 300, 600]) {
      expect(detectPreset(...at(dpi, ...A4))).toBe('document');
    }
  });

  it('reads Letter and Legal as documents, both orientations', () => {
    for (const dpi of [72, 100, 150, 300]) {
      const [lw, lh] = at(dpi, ...LETTER);
      expect(detectPreset(lw, lh)).toBe('document');
      expect(detectPreset(lh, lw)).toBe('document');
      const [gw, gh] = at(dpi, ...LEGAL);
      expect(detectPreset(gw, gh)).toBe('document');
      // Legal landscape is 1.647, which sits inside any card band wide enough
      // to hold an ID-1 card. Paper is checked first for exactly this reason.
      expect(detectPreset(gh, gw)).toBe('document');
    }
  });

  it('reads the whole ISO A series as documents — they share one ratio', () => {
    for (const [w, h] of [[874, 1240], [1240, 1754], [1754, 2480]] as const) {
      expect(detectPreset(w, h)).toBe('document');
    }
  });

  it('does not read camera frames as cards', () => {
    // 4:3 and 3:2 frames used to fall in the card band whenever they were
    // under 2 MP.
    for (const [w, h] of [[1600, 1200], [4032, 3024], [1500, 1000], [1920, 1080]] as const) {
      expect(detectPreset(w, h)).toBe('document');
    }
  });
});

describe('detectPreset — cards', () => {
  it('reads ID-1 cards as cards from 150 to 600 DPI', () => {
    for (const dpi of [150, 200, 300, 400, 600]) {
      const [w, h] = at(dpi, ...ID1);
      expect(detectPreset(w, h)).toBe('card');
      expect(detectPreset(h, w)).toBe('card'); // portrait
    }
  });
});

describe('detectPreset — receipts', () => {
  it('reads long narrow shapes as receipts', () => {
    for (const [w, h] of [[945, 2362], [945, 4724], [472, 2953]] as const) {
      expect(detectPreset(w, h)).toBe('receipt');
    }
  });

  it('includes the boundary ratio itself', () => {
    // An 80x200mm receipt lands on exactly 0.400; an exclusive test read it as
    // a document.
    expect(detectPreset(945, 2362)).toBe('receipt');
    expect(detectPreset(400, 1000)).toBe('receipt');
  });

  it('reads very wide frames as receipts too', () => {
    expect(detectPreset(4000, 1000)).toBe('receipt');
  });
});

describe('preset choice does not change the score of identical content', () => {
  async function a4At(dpi: number): Promise<Buffer> {
    const width = Math.round(8.27 * dpi);
    const height = Math.round(11.69 * dpi);
    const fontSize = Math.round(dpi / 9);
    const lines = Math.floor((height - dpi) / (fontSize * 1.7));
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" fill="#fbfaf6"/>` +
      Array.from({ length: lines }, (_, i) =>
        `<text x="${Math.round(dpi * 0.8)}" y="${Math.round(dpi * 0.8) + i * Math.round(fontSize * 1.7)}" ` +
        `font-size="${fontSize}" font-family="Helvetica" fill="#191919">` +
        `Line ${i} — invoice item description, quantity 3, unit 41.20, total 123.60</text>`,
      ).join('') + '</svg>';
    return sharp(Buffer.from(svg)).flatten({ background: '#fbfaf6' }).jpeg({ quality: 85 }).toBuffer();
  }

  it('scores an A4 page the same on auto as on document', async () => {
    // The score is the training label, so a swing driven by aspect ratio alone
    // is noise injected straight into the signal.
    for (const dpi of [96, 120, 140, 150]) {
      const buf = await a4At(dpi);
      const auto = await checkQuality(buf, { mode: 'thorough', preset: 'auto', timeout: 0 });
      const doc = await checkQuality(buf, { mode: 'thorough', preset: 'document', timeout: 0 });
      expect(auto.preset).toBe('document');
      expect(auto.score).toBe(doc.score);
    }
  }, 180_000);
});
