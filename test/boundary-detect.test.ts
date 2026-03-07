import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { detectDocumentBounds } from '../src/boundary.js';
import { detectPreset } from '../src/defaults.js';
import { checkQuality } from '../src/index.js';

/**
 * Create a synthetic image with a bright rectangle on a dark background.
 * @param imgW - Full image width
 * @param imgH - Full image height
 * @param bgBrightness - Background brightness (0-255)
 * @param docBrightness - Document brightness (0-255)
 * @param inset - Fractional inset on each side (0-0.5), e.g. 0.15 = 15% border
 */
async function makeDocOnBackground(
  imgW: number,
  imgH: number,
  bgBrightness: number,
  docBrightness: number,
  inset: number | { top: number; bottom: number; left: number; right: number },
): Promise<Buffer> {
  const pixels = Buffer.alloc(imgW * imgH * 3);
  const insets = typeof inset === 'number'
    ? { top: inset, bottom: inset, left: inset, right: inset }
    : inset;

  const docTop = Math.floor(imgH * insets.top);
  const docBottom = Math.floor(imgH * (1 - insets.bottom));
  const docLeft = Math.floor(imgW * insets.left);
  const docRight = Math.floor(imgW * (1 - insets.right));

  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < imgW; x++) {
      const idx = (y * imgW + x) * 3;
      const isDoc = x >= docLeft && x < docRight && y >= docTop && y < docBottom;
      const val = isDoc ? docBrightness : bgBrightness;
      pixels[idx] = val;
      pixels[idx + 1] = val;
      pixels[idx + 2] = val;
    }
  }

  return sharp(pixels, { raw: { width: imgW, height: imgH, channels: 3 } })
    .png()
    .toBuffer();
}

/** Create a uniform solid-color image */
async function makeUniformImage(
  width: number,
  height: number,
  brightness: number,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: brightness, g: brightness, b: brightness },
    },
  })
    .png()
    .toBuffer();
}

// ── detectDocumentBounds ──────────────────────────────────────────

describe('detectDocumentBounds', () => {
  it('detects white document on dark background', async () => {
    // 400x400 image, dark grey (80) background with white (240) rectangle inset 15%
    const buffer = await makeDocOnBackground(400, 400, 80, 240, 0.15);
    const bounds = await detectDocumentBounds(buffer);

    expect(bounds).not.toBeNull();
    // White area: x=60..340, y=60..340 (15% of 400 = 60)
    // Conservative detection may include some background, but should be close
    expect(bounds!.x).toBeGreaterThanOrEqual(20);
    expect(bounds!.x).toBeLessThanOrEqual(100);
    expect(bounds!.y).toBeGreaterThanOrEqual(20);
    expect(bounds!.y).toBeLessThanOrEqual(100);
    expect(bounds!.width).toBeGreaterThan(200);
    expect(bounds!.height).toBeGreaterThan(200);
    // Bounds must fit within original image
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(400);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(400);
  });

  it('returns null for full-frame document (no background)', async () => {
    // Uniformly bright image — mean > 200
    const buffer = await makeUniformImage(400, 400, 235);
    const bounds = await detectDocumentBounds(buffer);
    expect(bounds).toBeNull();
  });

  it('handles document clipped on left edge', async () => {
    // Document extends to left edge (no left background), 15% inset on other 3 sides
    // 3 edges should be detected (top, bottom, right), left skipped
    const buffer = await makeDocOnBackground(400, 400, 80, 240, {
      top: 0.15,
      bottom: 0.15,
      left: 0,
      right: 0.15,
    });
    const bounds = await detectDocumentBounds(buffer);

    // Should detect bounds — 3 of 4 edges visible (top, bottom, right)
    expect(bounds).not.toBeNull();
    // Left edge should be at or near 0 (no left boundary detected → falls back to image edge)
    expect(bounds!.x).toBeLessThanOrEqual(10);
    // Width should be less than full image (right edge cropped)
    expect(bounds!.width).toBeLessThan(400);
    expect(bounds!.width).toBeGreaterThan(250);
    // Bounds must fit within original image
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(400);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(400);
  });

  it('returns null for very dark image', async () => {
    // Mean < 40 → early exit
    const buffer = await makeUniformImage(400, 400, 20);
    const bounds = await detectDocumentBounds(buffer);
    expect(bounds).toBeNull();
  });

  it('returns null when detected region is too small', async () => {
    // Tiny bright area in center of mostly dark image — will fail 40% gate
    const buffer = await makeDocOnBackground(400, 400, 60, 240, 0.35);
    const bounds = await detectDocumentBounds(buffer);
    // Region would be ~30% of dimensions, below 40% threshold
    expect(bounds).toBeNull();
  });

  it('detects receipt on dark surface and infers receipt preset', async () => {
    // Tall narrow bright region on dark background
    // Use 500x1400 so the thumbnail (~71x200) has enough width for ray consensus
    const imgW = 500;
    const imgH = 1400;
    const buffer = await makeDocOnBackground(imgW, imgH, 70, 235, 0.15);

    const bounds = await detectDocumentBounds(buffer);
    expect(bounds).not.toBeNull();

    // The detected dimensions should give a receipt-like aspect ratio
    const preset = detectPreset(bounds!.width, bounds!.height);
    expect(preset).toBe('receipt');
    // Bounds must fit within original image
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(imgW);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(imgH);
  });

  it('detects bounds for skewed document', async () => {
    // Tilted bright rectangle (5 degrees) on dark background
    // Use large image (800x800) with 500x600 document so transitions stay within
    // the 20% scan depth even with the diagonal boundary shift from rotation
    const imgW = 800;
    const imgH = 800;
    const pixels = Buffer.alloc(imgW * imgH * 3);

    // Fill background dark
    pixels.fill(70);

    // Draw a rotated rectangle (5 degrees)
    const cx = imgW / 2;
    const cy = imgH / 2;
    const halfW = 250;
    const halfH = 300;
    const angle = (5 * Math.PI) / 180;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    for (let y = 0; y < imgH; y++) {
      for (let x = 0; x < imgW; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const rx = dx * cosA + dy * sinA;
        const ry = -dx * sinA + dy * cosA;

        if (Math.abs(rx) <= halfW && Math.abs(ry) <= halfH) {
          const idx = (y * imgW + x) * 3;
          pixels[idx] = 235;
          pixels[idx + 1] = 235;
          pixels[idx + 2] = 235;
        }
      }
    }

    const buffer = await sharp(pixels, { raw: { width: imgW, height: imgH, channels: 3 } })
      .png()
      .toBuffer();

    const bounds = await detectDocumentBounds(buffer);

    // Conservative approach detects top/bottom edges (left/right may be missed
    // due to diagonal boundary), returning bounds that encompass the document height
    expect(bounds).not.toBeNull();
    // AABB of rotated 500x600 at 5° ≈ 550x642 — detected height should roughly match
    expect(bounds!.height).toBeGreaterThanOrEqual(500);
    // Bounds must fit within original image
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(imgW);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(imgH);
  });

  it('returns null for uniform grey image (low stdev)', async () => {
    // Grey image with stdev < 15
    const buffer = await makeUniformImage(400, 400, 128);
    const bounds = await detectDocumentBounds(buffer);
    expect(bounds).toBeNull();
  });

  it('returns null for full-frame document scan (no false positives)', async () => {
    // Crisp document scan — mostly white with dark text-like elements scattered throughout
    const imgW = 800;
    const imgH = 600;
    const pixels = Buffer.alloc(imgW * imgH * 3);

    // Fill with document-white
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = 230;
    }

    // Add dark "text" lines in the middle
    for (let y = 100; y < 500; y += 20) {
      for (let x = 50; x < 750; x++) {
        if (y % 20 < 3) {
          const idx = (y * imgW + x) * 3;
          pixels[idx] = 30;
          pixels[idx + 1] = 30;
          pixels[idx + 2] = 30;
        }
      }
    }

    const buffer = await sharp(pixels, { raw: { width: imgW, height: imgH, channels: 3 } })
      .png()
      .toBuffer();

    const bounds = await detectDocumentBounds(buffer);
    // Full-frame scan with no visible background should return null
    expect(bounds).toBeNull();
  });

  // ── Edge cases & robustness ─────────────────────────────────────

  it('returns null for corrupted/invalid buffer', async () => {
    const garbage = Buffer.from('not a valid image at all');
    const bounds = await detectDocumentBounds(garbage);
    // Should not throw — the try/catch wrapper returns null
    expect(bounds).toBeNull();
  });

  it('returns null for very small image', async () => {
    // 5x5 is below the 10px thumbnail minimum
    const buffer = await makeUniformImage(5, 5, 128);
    const bounds = await detectDocumentBounds(buffer);
    expect(bounds).toBeNull();
  });

  it('returns null for zero-byte buffer', async () => {
    const bounds = await detectDocumentBounds(Buffer.alloc(0));
    expect(bounds).toBeNull();
  });

  it('detectBounds: false suppresses built-in detection', async () => {
    // Image that would normally trigger boundary detection
    const buffer = await makeDocOnBackground(800, 600, 80, 240, 0.15);

    // With detectBounds: false, boundary should NOT be in the result
    const result = await checkQuality(buffer, { detectBounds: false });
    expect(result.boundary).toBeUndefined();

    // With detectBounds: true (default), boundary should be detected
    const result2 = await checkQuality(buffer, { detectBounds: true });
    expect(result2.boundary).toBeDefined();
    expect(result2.boundary!.detected).toBe(true);
    expect(result2.boundary!.region).toBeDefined();
  });

  it('detected bounds never exceed original image dimensions', async () => {
    // Various image sizes — all should produce in-bounds results
    const sizes = [
      [400, 400], [800, 600], [600, 800], [1000, 300], [300, 1000],
    ] as const;

    for (const [w, h] of sizes) {
      const buffer = await makeDocOnBackground(w, h, 70, 235, 0.12);
      const bounds = await detectDocumentBounds(buffer);
      if (bounds) {
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.width).toBeGreaterThan(0);
        expect(bounds.height).toBeGreaterThan(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(w);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(h);
      }
    }
  });

  it('returns null when background is brighter than document (inverted)', async () => {
    // Light background, dark document — violates the "document is lighter" assumption
    // Gate 4 (brightness contrast) should reject this
    const buffer = await makeDocOnBackground(400, 400, 200, 80, 0.15);
    const bounds = await detectDocumentBounds(buffer);
    expect(bounds).toBeNull();
  });
});
