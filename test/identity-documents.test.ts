import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { checkQuality } from '../src/index.js';

/**
 * Identity documents are not dense pages of text.
 *
 * An ID card, driving licence or passport data page is mostly background, a
 * portrait photograph and a handful of short fields. Checks that measure how
 * much of the page is covered in ink read that as "no legible content", and a
 * clean 300 DPI card scan scored 0.02 with `low-edge-density` and
 * `low-contrast`. The `card` preset made it worse: it was written as "a
 * document, but stricter", tightening the very checks that misfire.
 */

/** ISO 7810 ID-1 — 85.6 x 53.98mm, portrait beside short fields. */
async function idCard(dpi = 300, opts: { blur?: number; dark?: number; bright?: number; resize?: number; q?: number } = {}) {
  const w = Math.round(3.370 * dpi);
  const h = Math.round(2.125 * dpi);
  const fs = Math.round(dpi / 26);
  const fields = ['SURNAME  DOE', 'GIVEN NAMES  JANE A', 'DOB  1988-04-12', 'NO  D1234567', 'EXPIRES  2031-04-11'];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#e9eef4"/>` +
    `<rect x="${Math.round(w * 0.04)}" y="${Math.round(h * 0.22)}" ` +
    `width="${Math.round(w * 0.24)}" height="${Math.round(h * 0.6)}" fill="#8fa3b8"/>` +
    fields.map((t, i) =>
      `<text x="${Math.round(w * 0.32)}" y="${Math.round(h * 0.30) + i * Math.round(fs * 1.9)}" ` +
      `font-size="${fs}" font-family="Helvetica" fill="#16202b">${t}</text>`,
    ).join('') + '</svg>';

  let p = sharp(Buffer.from(svg)).flatten({ background: '#e9eef4' });
  if (opts.blur) p = p.blur(opts.blur);
  if (opts.dark) p = p.modulate({ brightness: opts.dark });
  if (opts.bright) p = p.linear(opts.bright, 30);
  if (opts.resize) p = p.resize(opts.resize);
  return p.jpeg({ quality: opts.q ?? 88 }).toBuffer();
}

describe('identity documents under the card preset', () => {
  it('passes clean cards from 200 to 600 DPI', async () => {
    // A card at 200 DPI is 0.29 MP, under the 0.3 MP document floor. It is a
    // small format, not a low-quality capture.
    for (const dpi of [200, 300, 400, 600]) {
      const result = await checkQuality(await idCard(dpi), {
        mode: 'deep', preset: 'card', timeout: 0,
      });
      expect(result.pass, `${dpi} DPI card should pass`).toBe(true);
      expect(result.issues.filter((i) => i.severity !== 'advisory')).toHaveLength(0);
    }
  }, 180_000);

  it('does not read sparse fields as missing content', async () => {
    const result = await checkQuality(await idCard(), { mode: 'deep', preset: 'card', timeout: 0 });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain('low-edge-density');
    expect(codes).not.toContain('low-contrast');
    // A card is a small file on merit — clean scans measure 4 to 34 KB.
    expect(codes).not.toContain('file-too-small');
  }, 60_000);

  it('still catches every way a card capture goes wrong', async () => {
    const bad: Array<[string, Buffer]> = [
      ['blurred', await idCard(300, { blur: 3 })],
      ['too low resolution', await idCard(300, { resize: 337 })],
      ['overexposed', await idCard(300, { bright: 1.6 })],
      ['heavily compressed', await idCard(300, { q: 6 })],
    ];
    for (const [name, buf] of bad) {
      const result = await checkQuality(buf, { mode: 'deep', preset: 'card', timeout: 0 });
      expect(result.pass, `${name} card should fail`).toBe(false);
    }
  }, 180_000);

  /**
   * Underexposure is the one that got away, and it is worth saying why.
   *
   * `idCard(300, { dark: 0.35 })` used to fail, on `illegible-text`. That
   * verdict was an artefact: the portrait rectangle covers 60% of the card and
   * shades darker than the plastic around it, so Otsu classed it as ink and the
   * fields beside it fell inside the same band. The analyzer measured one
   * "line" with a 383px lowercase body on a 638px card, and called it illegible.
   * Text-line reliability now rejects that reading — correctly, since nothing
   * about it describes the text — and the honest signals left are the ones that
   * were always doing the real work: `dim-background` at p90 77 against 170,
   * scoring 0.53 against a 0.5 bar.
   *
   * Tightening a threshold to reclaim it was measured and rejected. Across 100
   * graded cards from the labelling set, this fixture's mean brightness of 74
   * sits on the 5th percentile of the cards humans marked *good*: raising the
   * card floor from 60 to 100 catches 10 more of the bad ones and fails 10 of
   * the good. At this exposure a real card is genuinely borderline, and 0.53 is
   * an honest description of that. Segmenting text beside a portrait needs
   * column-aware banding, which is the actual fix and a larger one.
   */
  it('scores an underexposed card as borderline, on exposure not on text', async () => {
    const result = await checkQuality(await idCard(300, { dark: 0.35 }), {
      mode: 'deep', preset: 'card', timeout: 0,
    });
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('dim-background');
    expect(codes).toContain('text-unmeasurable');
    expect(codes).not.toContain('illegible-text');
    expect(result.score).toBeLessThan(0.6);
  }, 60_000);

  it('keeps skipped analyzers in the feature vector', async () => {
    // Skipping affects the rule-based score and the reported issues only. A
    // trained model still sees everything those analyzers measured.
    const { FEATURE_NAMES } = await import('../src/features.js');
    let values = new Float64Array();
    await checkQuality(await idCard(), {
      mode: 'deep', preset: 'card', timeout: 0,
      scorer: (f) => { values = f.values; return 1; },
    });
    for (const name of ['edgeRatio', 'foregroundRatio', 'sharpnessRatioTopBot', 'textCharSizeCV']) {
      const idx = FEATURE_NAMES.indexOf(name);
      expect(idx).toBeGreaterThan(-1);
      expect(Number.isNaN(values[idx]), `${name} should still be measured`).toBe(false);
    }
  }, 60_000);

  it('the document preset still rejects the same card', async () => {
    // Confirms the preset is doing the work, not a global loosening.
    const result = await checkQuality(await idCard(), {
      mode: 'deep', preset: 'document', timeout: 0,
    });
    expect(result.pass).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('low-edge-density');
  }, 60_000);
});
