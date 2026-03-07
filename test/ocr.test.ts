import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { checkQuality } from '../src/index.js';

/** Check if tesseract.js is available */
async function hasTesseract(): Promise<boolean> {
  try {
    const name = 'tesseract.js';
    await import(/* @vite-ignore */ name);
    return true;
  } catch {
    return false;
  }
}

describe('OCR confidence analyzer', () => {
  it('does not run when ocrConfidence is false (default)', async () => {
    const buf = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 200, b: 200 } },
    }).png().toBuffer();

    const result = await checkQuality(buf, { mode: 'fast' });
    // No OCR timing entry
    expect(result.timing.analyzers.ocrConfidence).toBeUndefined();
    // No OCR issue
    expect(result.issues.find(i => i.analyzer === 'ocrConfidence')).toBeUndefined();
  });

  it('skips gracefully when tesseract.js is not installed', async () => {
    if (await hasTesseract()) {
      // Can't test the "not installed" path when it IS installed — skip
      return;
    }

    const buf = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 200, b: 200 } },
    }).png().toBuffer();

    // Should not throw even though tesseract.js is missing
    const result = await checkQuality(buf, { mode: 'fast', ocrConfidence: true });
    expect(result).toBeDefined();
    expect(result.timing.analyzers.ocrConfidence).toBeDefined();
  });

  it('returns null for image with < 5 words (if tesseract available)', async () => {
    if (!(await hasTesseract())) return;

    // Blank image — Tesseract will find < 5 words
    const buf = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer();

    const result = await checkQuality(buf, { mode: 'fast', ocrConfidence: true, timeout: 30_000 });
    expect(result.issues.find(i => i.analyzer === 'ocrConfidence')).toBeUndefined();
  });
});
