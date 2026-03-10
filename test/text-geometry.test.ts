import { describe, it, expect } from 'vitest';
import { analyzeTextGeometry } from '../src/analyzers.js';
import type { AnalysisContext, Thresholds } from '../src/types.js';
import { DEFAULT_THRESHOLDS } from '../src/defaults.js';

/** Create a greyscale image buffer filled with a uniform value */
function makeGrey(width: number, height: number, value = 200): Buffer {
  const buf = Buffer.alloc(width * height);
  buf.fill(value);
  return buf;
}

/** Draw a filled dark rectangle onto a greyscale buffer */
function drawRect(
  buf: Buffer,
  width: number,
  x: number,
  y: number,
  w: number,
  h: number,
  value = 0,
): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px >= 0 && px < width && py >= 0 && py < (buf.length / width)) {
        buf[py * width + px] = value;
      }
    }
  }
}

/** Build a minimal AnalysisContext with just greyRaw */
function makeCtx(greyData: Buffer, width: number, height: number): AnalysisContext {
  return {
    originalBuffer: Buffer.alloc(1),
    analysisBuffer: Buffer.alloc(1),
    metadata: { width, height },
    greyRaw: { data: greyData, width, height },
  };
}

const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };

describe('analyzeTextGeometry', () => {
  it('returns empty on uniform image (no components)', () => {
    const w = 200, h = 200;
    const grey = makeGrey(w, h, 200);
    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    expect(issues).toEqual([]);
  });

  it('returns empty on too-small image', () => {
    const w = 50, h = 50;
    const grey = makeGrey(w, h, 200);
    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    expect(issues).toEqual([]);
  });

  it('returns no issues for straight baselines with uniform characters', () => {
    const w = 400, h = 300;
    const grey = makeGrey(w, h, 200);
    const charW = 6, charH = 8;
    const gap = 10;

    // Draw 5 rows of 25 uniform characters along perfectly straight baselines
    for (let row = 0; row < 5; row++) {
      const y = 30 + row * 40;
      for (let col = 0; col < 25; col++) {
        const x = 10 + col * (charW + gap);
        drawRect(grey, w, x, y, charW, charH, 0);
      }
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);

    // Should not detect any issues — baselines are straight and chars uniform
    const wavyIssue = issues.find(i => i.code === 'wavy-text-lines');
    expect(wavyIssue).toBeUndefined();
    const sizeIssue = issues.find(i => i.code === 'inconsistent-char-size');
    expect(sizeIssue).toBeUndefined();
  });

  it('detects wavy text lines', () => {
    const w = 400, h = 300;
    const grey = makeGrey(w, h, 200);
    const charW = 6, charH = 8;
    const gap = 10;

    // Draw characters along sinusoidal baselines
    for (let row = 0; row < 5; row++) {
      const baseY = 30 + row * 50;
      for (let col = 0; col < 25; col++) {
        const x = 10 + col * (charW + gap);
        // Large sine wave deviation (amplitude 15px on 300px image = 5%)
        const yOffset = Math.round(15 * Math.sin((col / 25) * Math.PI * 2));
        drawRect(grey, w, x, baseY + yOffset, charW, charH, 0);
      }
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    const wavyIssue = issues.find(i => i.code === 'wavy-text-lines');
    expect(wavyIssue).toBeDefined();
    expect(wavyIssue!.analyzer).toBe('textGeometry');
    expect(wavyIssue!.penalty).toBe(0.6);
  });

  it('detects inconsistent character sizes', () => {
    const w = 600, h = 300;
    const grey = makeGrey(w, h, 200);
    const gap = 8;

    // Draw characters with continuously varying widths (4-12px, height 6px)
    // All areas (24-72) fall within a 3x range, so most land in the dominant cluster.
    // The spread gives CV ~0.3, well above the strict threshold of 0.15.
    for (let row = 0; row < 6; row++) {
      const y = 20 + row * 40;
      let x = 10;
      for (let col = 0; col < 30; col++) {
        const cw = 4 + (col % 9); // widths cycle 4,5,6,7,8,9,10,11,12
        const ch = 6;
        drawRect(grey, w, x, y, cw, ch, 0);
        x += cw + gap;
      }
    }

    const ctx = makeCtx(grey, w, h);
    // Use strict threshold — continuous spread gives CV ~0.3
    const strictT = { ...thresholds, charSizeCVMax: 0.15 };
    const issues = analyzeTextGeometry(ctx, strictT);
    const sizeIssue = issues.find(i => i.code === 'inconsistent-char-size');
    expect(sizeIssue).toBeDefined();
    expect(sizeIssue!.penalty).toBe(0.7);
  });

  it('detects distorted character shapes', () => {
    const w = 600, h = 400;
    const grey = makeGrey(w, h, 200);
    const gap = 8;

    // Draw characters with wildly varying shapes (some square, some very elongated)
    // All have the same area (~36px) so they land in the same dominant cluster,
    // but their circularity (4πA/P²) differs significantly → high shape CV.
    for (let row = 0; row < 8; row++) {
      const y = 20 + row * 45;
      let x = 10;
      for (let col = 0; col < 30; col++) {
        let cw: number, ch: number;
        if (col % 3 === 0) {
          cw = 6; ch = 6;  // square — higher circularity
        } else if (col % 3 === 1) {
          cw = 3; ch = 12; // tall thin — lower circularity
        } else {
          cw = 12; ch = 3; // wide flat — lower circularity
        }
        drawRect(grey, w, x, y, cw, ch, 0);
        x += Math.max(cw, ch) + gap;
      }
    }

    const ctx = makeCtx(grey, w, h);
    // Use strict threshold
    const strictT = { ...thresholds, charShapeCVMax: 0.1 };
    const issues = analyzeTextGeometry(ctx, strictT);
    const shapeIssue = issues.find(i => i.code === 'distorted-char-shapes');
    expect(shapeIssue).toBeDefined();
    expect(shapeIssue!.penalty).toBe(0.65);
  });

  it('stores metrics on ctx.textGeometryMetrics', () => {
    const w = 400, h = 300;
    const grey = makeGrey(w, h, 200);
    const charW = 6, charH = 8;
    const gap = 10;

    for (let row = 0; row < 5; row++) {
      const y = 30 + row * 40;
      for (let col = 0; col < 25; col++) {
        const x = 10 + col * (charW + gap);
        drawRect(grey, w, x, y, charW, charH, 0);
      }
    }

    const ctx = makeCtx(grey, w, h);
    analyzeTextGeometry(ctx, thresholds);

    expect(ctx.textGeometryMetrics).toBeDefined();
    expect(typeof ctx.textGeometryMetrics!.baselineDeviation).toBe('number');
    expect(typeof ctx.textGeometryMetrics!.charSizeCV).toBe('number');
    expect(typeof ctx.textGeometryMetrics!.charShapeCV).toBe('number');
  });

  it('respects custom thresholds', () => {
    const w = 400, h = 300;
    const grey = makeGrey(w, h, 200);
    const gap = 10;

    // Draw characters with slight size variation (5px and 7px wide, both 6px tall)
    // This creates measurable but small size CV (~0.15-0.2)
    for (let row = 0; row < 5; row++) {
      const y = 30 + row * 40;
      let x = 10;
      for (let col = 0; col < 25; col++) {
        const cw = col % 2 === 0 ? 5 : 7;
        drawRect(grey, w, x, y, cw, 6, 0);
        x += cw + gap;
      }
    }

    const ctx = makeCtx(grey, w, h);
    // Default thresholds should NOT fire (variation is small)
    const defaultIssues = analyzeTextGeometry(ctx, thresholds);
    const defaultSize = defaultIssues.find(i => i.code === 'inconsistent-char-size');
    expect(defaultSize).toBeUndefined();

    // Strict threshold SHOULD fire
    const ctx2 = makeCtx(makeGrey(w, h, 200), w, h);
    for (let row = 0; row < 5; row++) {
      const y = 30 + row * 40;
      let x = 10;
      for (let col = 0; col < 25; col++) {
        const cw = col % 2 === 0 ? 5 : 7;
        drawRect(ctx2.greyRaw!.data, w, x, y, cw, 6, 0);
        x += cw + gap;
      }
    }
    const strict = { ...thresholds, charSizeCVMax: 0.05 };
    const strictIssues = analyzeTextGeometry(ctx2, strict);
    const strictSize = strictIssues.find(i => i.code === 'inconsistent-char-size');
    expect(strictSize).toBeDefined();
  });

  it('returns empty when too few text components', () => {
    const w = 200, h = 200;
    const grey = makeGrey(w, h, 200);

    // Draw only 5 small rects — not enough for analysis
    for (let i = 0; i < 5; i++) {
      drawRect(grey, w, 10 + i * 30, 50, 6, 8, 0);
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    expect(issues).toEqual([]);
    // Metrics should still be stored (as zeros)
    expect(ctx.textGeometryMetrics).toBeDefined();
  });

  it('handles many small components without crashing', () => {
    // Draw a dense grid of small (2×2) components — stresses the min/max loop
    // and dominant clustering with many items (avoids spread operator overflow)
    const w = 400, h = 400;
    const grey = makeGrey(w, h, 200);

    // Place 2×2 dark pixels in a grid pattern (every 4px), giving ~10,000 components
    for (let y = 2; y < h - 2; y += 4) {
      for (let x = 2; x < w - 2; x += 4) {
        drawRect(grey, w, x, y, 2, 2, 0);
      }
    }

    const ctx = makeCtx(grey, w, h);
    // Should not throw — previously Math.min(...) could overflow the call stack
    expect(() => analyzeTextGeometry(ctx, thresholds)).not.toThrow();
  });

  // ── Guard & boundary edge cases ──────────────────────────────

  it('returns empty and does not set metrics when greyRaw is missing', () => {
    const ctx: AnalysisContext = {
      originalBuffer: Buffer.alloc(1),
      analysisBuffer: Buffer.alloc(1),
      metadata: { width: 400, height: 300 },
      // greyRaw intentionally missing
    };
    const issues = analyzeTextGeometry(ctx, thresholds);
    expect(issues).toEqual([]);
    expect(ctx.textGeometryMetrics).toBeUndefined();
  });

  it('skips at width=99 (just below minimum), works at width=100', () => {
    // 99×200 — below threshold
    const grey99 = makeGrey(99, 200, 200);
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        drawRect(grey99, 99, 5 + col * 16, 10 + row * 30, 6, 8, 0);
      }
    }
    const ctx99 = makeCtx(grey99, 99, 200);
    expect(analyzeTextGeometry(ctx99, thresholds)).toEqual([]);
    expect(ctx99.textGeometryMetrics).toBeUndefined();

    // 100×200 — at threshold, should proceed (though may hit <20 component guard)
    const grey100 = makeGrey(100, 200, 200);
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        drawRect(grey100, 100, 5 + col * 16, 10 + row * 30, 6, 8, 0);
      }
    }
    const ctx100 = makeCtx(grey100, 100, 200);
    analyzeTextGeometry(ctx100, thresholds);
    // Should at least set metrics (even if zero due to component count guard)
    expect(ctx100.textGeometryMetrics).toBeDefined();
  });

  it('skips at height=99 (just below minimum)', () => {
    const grey = makeGrey(200, 99, 200);
    const ctx = makeCtx(grey, 200, 99);
    expect(analyzeTextGeometry(ctx, thresholds)).toEqual([]);
    expect(ctx.textGeometryMetrics).toBeUndefined();
  });

  // ── CC labeling edge cases ───────────────────────────────────

  it('all-dark image: single giant CC filtered by maxArea', () => {
    // Every pixel is dark → one connected component covering the entire image.
    // Area = 40000 (200×200), maxArea = 0.01 * 40000 = 400. Filtered out.
    const w = 200, h = 200;
    const grey = makeGrey(w, h, 0); // all black
    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    expect(issues).toEqual([]);
  });

  it('touching characters merge via 8-connectivity into fewer components', () => {
    // Draw characters that touch diagonally — they merge into one CC.
    // 8-connectivity means diagonal adjacency counts.
    const w = 200, h = 200;
    const grey = makeGrey(w, h, 200);

    // Two 4×4 blocks touching at corner (diagonal adjacency)
    drawRect(grey, w, 10, 10, 4, 4, 0); // block at (10,10)-(13,13)
    drawRect(grey, w, 14, 14, 4, 4, 0); // block at (14,14)-(17,17)
    // With 8-connectivity, pixel (13,13) and (14,14) are neighbors → one CC

    // Draw isolated blocks separately for comparison
    drawRect(grey, w, 30, 10, 4, 4, 0); // isolated block
    drawRect(grey, w, 50, 10, 4, 4, 0); // isolated block

    const ctx = makeCtx(grey, w, h);
    analyzeTextGeometry(ctx, thresholds);
    // Not enough components for full analysis, but shouldn't crash
    // The merged block has area=32 (two 4×4), the others have area=16 each
    expect(ctx.textGeometryMetrics).toBeDefined();
  });

  it('components at image edges: perimeter counted correctly', () => {
    // Draw a component touching the top-left corner of the image.
    // Perimeter should include edge-of-image pixels.
    const w = 200, h = 200;
    const grey = makeGrey(w, h, 200);

    // 25 components: 5 at corners/edges, 20 in interior
    drawRect(grey, w, 0, 0, 6, 8, 0);     // top-left corner
    drawRect(grey, w, 194, 0, 6, 8, 0);   // top-right corner
    drawRect(grey, w, 0, 192, 6, 8, 0);   // bottom-left corner
    drawRect(grey, w, 194, 192, 6, 8, 0); // bottom-right corner
    drawRect(grey, w, 97, 0, 6, 8, 0);    // top edge
    for (let i = 0; i < 20; i++) {
      const x = 10 + (i % 10) * 18;
      const y = 40 + Math.floor(i / 10) * 40;
      drawRect(grey, w, x, y, 6, 8, 0);
    }

    const ctx = makeCtx(grey, w, h);
    // Should not crash and should handle edge components gracefully
    const issues = analyzeTextGeometry(ctx, thresholds);
    expect(ctx.textGeometryMetrics).toBeDefined();
    // Metrics should be finite numbers
    expect(Number.isFinite(ctx.textGeometryMetrics!.baselineDeviation)).toBe(true);
    expect(Number.isFinite(ctx.textGeometryMetrics!.charSizeCV)).toBe(true);
    expect(Number.isFinite(ctx.textGeometryMetrics!.charShapeCV)).toBe(true);
  });

  it('extreme aspect ratio components are filtered out', () => {
    // Draw very tall-thin (1×50) and very wide-flat (50×1) shapes.
    // Aspect ratios: 1/50=0.02 and 50/1=50 — both outside [0.1, 10] filter.
    const w = 300, h = 300;
    const grey = makeGrey(w, h, 200);

    // 15 vertical lines (aspect ~0.02) — filtered
    for (let i = 0; i < 15; i++) {
      drawRect(grey, w, 10 + i * 18, 10, 1, 50, 0);
    }
    // 15 horizontal lines (aspect ~50) — filtered
    for (let i = 0; i < 15; i++) {
      drawRect(grey, w, 10, 80 + i * 12, 50, 1, 0);
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    // All components fail aspect ratio filter → <20 text components → empty
    expect(issues).toEqual([]);
  });

  // ── Dominant clustering edge cases ───────────────────────────

  it('bimodal sizes: dominant cluster filters minority, rest analyzed cleanly', () => {
    // 100 small chars (6×6) + 10 large chars (20×20).
    // The large ones are outside the 2x range of the small mode → excluded.
    // Only the 100 small chars remain in the dominant cluster.
    const w = 400, h = 400;
    const grey = makeGrey(w, h, 200);

    // 10 rows of 10 small (6×6) chars
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 10; col++) {
        drawRect(grey, w, 10 + col * 20, 10 + row * 20, 6, 6, 0);
      }
    }
    // 10 large (20×20) chars at the bottom
    for (let i = 0; i < 10; i++) {
      drawRect(grey, w, 10 + i * 35, 300, 20, 20, 0);
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    // The 100 small chars are uniform → no issues at default thresholds
    expect(issues.find(i => i.code === 'inconsistent-char-size')).toBeUndefined();
    expect(ctx.textGeometryMetrics).toBeDefined();
    // charSizeCV should be near 0 (all dominant components are 6×6 = area 36)
    expect(ctx.textGeometryMetrics!.charSizeCV).toBeLessThan(0.01);
  });

  it('dominant cluster < 20 after filtering: returns [] with zero metrics', () => {
    // 30 total components: 10 small (area 9), 10 medium (area 48), 10 large (area 200).
    // No size cluster reaches 20 components.
    const w = 400, h = 200;
    const grey = makeGrey(w, h, 200);

    for (let i = 0; i < 10; i++) drawRect(grey, w, 10 + i * 15, 10, 3, 3, 0);   // area 9
    for (let i = 0; i < 10; i++) drawRect(grey, w, 10 + i * 15, 40, 6, 8, 0);   // area 48
    for (let i = 0; i < 10; i++) drawRect(grey, w, 10 + i * 25, 80, 10, 20, 0); // area 200

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    expect(issues).toEqual([]);
    expect(ctx.textGeometryMetrics).toBeDefined();
    expect(ctx.textGeometryMetrics!.baselineDeviation).toBe(0);
  });

  // ── Baseline regression edge cases ───────────────────────────

  it('rows with < 5 components are excluded from baseline analysis', () => {
    // 4 rows with 4 components each (16 total < 20 initially, but let's make exactly
    // 20+ by adding a fifth row) — first 4 rows have 4 components each (skipped),
    // last row has 25 components.
    const w = 500, h = 300;
    const grey = makeGrey(w, h, 200);

    // 4 rows of 4 components — below per-row minimum
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        drawRect(grey, w, 10 + col * 40, 10 + row * 30, 6, 8, 0);
      }
    }
    // 1 row of 25 components — above per-row minimum, perfectly straight
    for (let col = 0; col < 25; col++) {
      drawRect(grey, w, 10 + col * 16, 200, 6, 8, 0);
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    // Only the 25-component row contributes to baseline analysis.
    // It's perfectly straight → no wavy-text issue.
    expect(issues.find(i => i.code === 'wavy-text-lines')).toBeUndefined();
    expect(ctx.textGeometryMetrics!.baselineDeviation).toBe(0);
  });

  it('no rows qualify (all < 5 components): baselineDeviation is 0', () => {
    // Many components spread out so no row has 5+ members.
    // Place 25 components in a diagonal pattern — each is alone in its row.
    const w = 400, h = 400;
    const grey = makeGrey(w, h, 200);

    for (let i = 0; i < 25; i++) {
      drawRect(grey, w, 10 + i * 14, 10 + i * 14, 6, 8, 0);
    }

    const ctx = makeCtx(grey, w, h);
    analyzeTextGeometry(ctx, thresholds);
    expect(ctx.textGeometryMetrics).toBeDefined();
    expect(ctx.textGeometryMetrics!.baselineDeviation).toBe(0);
  });

  it('tilted but straight baseline: regression absorbs slope, low residual', () => {
    // Characters along a consistent 5° tilt — still straight, just angled.
    // Regression fits the slope perfectly → residual ≈ 0.
    const w = 500, h = 300;
    const grey = makeGrey(w, h, 200);
    const slope = Math.tan(5 * Math.PI / 180); // ~0.087

    for (let row = 0; row < 4; row++) {
      const baseY = 40 + row * 50;
      for (let col = 0; col < 25; col++) {
        const x = 10 + col * 18;
        const y = Math.round(baseY + x * slope);
        if (y >= 0 && y + 8 < h) {
          drawRect(grey, w, x, y, 6, 8, 0);
        }
      }
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    // Tilted but straight → regression absorbs the slope → no wavy detection
    expect(issues.find(i => i.code === 'wavy-text-lines')).toBeUndefined();
    expect(ctx.textGeometryMetrics!.baselineDeviation).toBeLessThan(0.001);
  });

  // ── Multi-signal and combined scenarios ──────────────────────

  it('fires multiple issues simultaneously when document is severely distorted', () => {
    // Wavy baselines + mixed shapes → should trigger both wavy-text and shape distortion
    const w = 600, h = 400;
    const grey = makeGrey(w, h, 200);

    for (let row = 0; row < 8; row++) {
      const baseY = 20 + row * 45;
      let x = 10;
      for (let col = 0; col < 30; col++) {
        // Wavy: sinusoidal Y offset
        const yOffset = Math.round(20 * Math.sin((col / 30) * Math.PI * 2));
        // Varying shapes (same area ≈ 36): square, tall-thin, wide-flat
        let cw: number, ch: number;
        if (col % 3 === 0) { cw = 6; ch = 6; }
        else if (col % 3 === 1) { cw = 3; ch = 12; }
        else { cw = 12; ch = 3; }
        const y = baseY + yOffset;
        if (y >= 0 && y + ch < h) {
          drawRect(grey, w, x, y, cw, ch, 0);
        }
        x += Math.max(cw, ch) + 8;
      }
    }

    const ctx = makeCtx(grey, w, h);
    const strictT = { ...thresholds, charShapeCVMax: 0.1 };
    const issues = analyzeTextGeometry(ctx, strictT);

    // Both wavy baselines and shape distortion should fire
    expect(issues.find(i => i.code === 'wavy-text-lines')).toBeDefined();
    expect(issues.find(i => i.code === 'distorted-char-shapes')).toBeDefined();
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('single long row: baseline computed from one qualifying row', () => {
    // One row of 50 components along a sinusoidal baseline, no other rows.
    const w = 800, h = 200;
    const grey = makeGrey(w, h, 200);

    for (let col = 0; col < 50; col++) {
      const x = 10 + col * 15;
      const yOffset = Math.round(12 * Math.sin((col / 50) * Math.PI * 4)); // 2 full waves
      drawRect(grey, w, x, 80 + yOffset, 6, 8, 0);
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    // rowCount = 1, but the wave should produce measurable deviation
    expect(ctx.textGeometryMetrics).toBeDefined();
    expect(ctx.textGeometryMetrics!.baselineDeviation).toBeGreaterThan(0);
    expect(issues.find(i => i.code === 'wavy-text-lines')).toBeDefined();
  });

  // ── Pixel value boundary ─────────────────────────────────────

  it('binarization boundary: pixel value 127 is foreground, 128 is background', () => {
    // Verify the exact threshold: < 128 → foreground, >= 128 → background
    const w = 200, h = 200;
    const grey = makeGrey(w, h, 128); // all pixels = 128 → background

    // Draw 25 components at pixel value 127 (just below threshold → foreground)
    for (let i = 0; i < 25; i++) {
      drawRect(grey, w, 10 + (i % 5) * 30, 10 + Math.floor(i / 5) * 30, 6, 8, 127);
    }

    const ctx = makeCtx(grey, w, h);
    analyzeTextGeometry(ctx, thresholds);
    // 25 components with value 127 should be detected as foreground
    expect(ctx.textGeometryMetrics).toBeDefined();
    // charSizeCV should be ~0 since all same size
    expect(ctx.textGeometryMetrics!.charSizeCV).toBeLessThan(0.01);
  });

  it('pixel value 128 is treated as background', () => {
    const w = 200, h = 200;
    const grey = makeGrey(w, h, 200);

    // Draw "characters" at pixel value 128 — should be treated as BACKGROUND
    for (let i = 0; i < 25; i++) {
      drawRect(grey, w, 10 + (i % 5) * 30, 10 + Math.floor(i / 5) * 30, 6, 8, 128);
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    // Nothing detected — value 128 is not foreground
    expect(issues).toEqual([]);
    // Metrics are set to zero (CCL ran but found 0 foreground components → <20 guard)
    expect(ctx.textGeometryMetrics).toBeDefined();
    expect(ctx.textGeometryMetrics!.charSizeCV).toBe(0);
  });

  // ── Robustness: pathological inputs ──────────────────────────

  it('bails out on noise image with excessive label count', () => {
    // Scattered single dark pixels on a grid create many isolated labels.
    // The MAX_LABELS guard (50K) should bail early and return [].
    const w = 500, h = 500;
    const grey = makeGrey(w, h, 200);

    // Place isolated dark pixels every 2px — ~62,500 isolated foreground pixels,
    // each becoming its own label (no 8-connected neighbors).
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        grey[y * w + x] = 0;
      }
    }

    const ctx = makeCtx(grey, w, h);
    // Should not throw, should bail early with zero metrics
    const issues = analyzeTextGeometry(ctx, thresholds);
    expect(issues).toEqual([]);
    expect(ctx.textGeometryMetrics).toBeDefined();
    expect(ctx.textGeometryMetrics!.baselineDeviation).toBe(0);
  });

  it('caps text components at 5000 and still produces valid results', () => {
    // Dense grid of 3×3 dark blocks spaced by 1px gap — many small components.
    // Total ~7,000+ components, capped to 5000 for downstream analysis.
    const w = 400, h = 400;
    const grey = makeGrey(w, h, 200);

    for (let y = 1; y < h - 3; y += 4) {
      for (let x = 1; x < w - 3; x += 4) {
        drawRect(grey, w, x, y, 3, 3, 0);
      }
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    // Should not throw and should produce finite metrics
    expect(ctx.textGeometryMetrics).toBeDefined();
    expect(Number.isFinite(ctx.textGeometryMetrics!.baselineDeviation)).toBe(true);
    expect(Number.isFinite(ctx.textGeometryMetrics!.charSizeCV)).toBe(true);
    expect(Number.isFinite(ctx.textGeometryMetrics!.charShapeCV)).toBe(true);
  });

  it('inverted image (white text on black): no text detected', () => {
    // Binarization uses threshold < 128 for foreground (dark).
    // White characters on black background: the black bg is foreground,
    // white chars are background. The giant bg CC exceeds maxArea → filtered.
    const w = 300, h = 300;
    const grey = makeGrey(w, h, 0); // black background

    // Draw white "characters" — these are background to the binarizer
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 15; col++) {
        drawRect(grey, w, 10 + col * 18, 20 + row * 40, 6, 8, 255);
      }
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    // No text-like components detected (the "holes" are background, not foreground)
    expect(issues).toEqual([]);
  });

  it('low-contrast image: text near threshold not binarized', () => {
    // Background at 150, text at 130 — both >= 128, so nothing is foreground.
    const w = 300, h = 300;
    const grey = makeGrey(w, h, 150);

    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 15; col++) {
        drawRect(grey, w, 10 + col * 18, 20 + row * 40, 6, 8, 130);
      }
    }

    const ctx = makeCtx(grey, w, h);
    const issues = analyzeTextGeometry(ctx, thresholds);
    expect(issues).toEqual([]);
  });

  it('components exactly at minArea (4px) and maxArea (1%) boundaries', () => {
    const w = 200, h = 200;
    const grey = makeGrey(w, h, 200);
    // totalPixels = 40000, minArea = max(0.04, 4) = 4, maxArea = 400

    // Draw 10 components at exactly area = 4 (2×2 blocks)
    for (let i = 0; i < 10; i++) {
      drawRect(grey, w, 10 + i * 15, 10, 2, 2, 0);
    }
    // Draw 10 components at exactly area = 400 (20×20 blocks)
    for (let i = 0; i < 10; i++) {
      drawRect(grey, w, 10 + i * 22, 40, 20, 20, 0);
    }
    // Draw 10 components just above maxArea: 401px (area ≈ 21×20 = 420)
    for (let i = 0; i < 5; i++) {
      drawRect(grey, w, 10 + i * 25, 100, 21, 20, 0);
    }

    const ctx = makeCtx(grey, w, h);
    analyzeTextGeometry(ctx, thresholds);
    // Should process: the 4px and 400px components pass, the 420px ones are excluded (> 1%)
    expect(ctx.textGeometryMetrics).toBeDefined();
  });

  it('all components in a vertical column: no qualifying rows for baseline', () => {
    // Components stacked vertically with large Y gaps — each row has 1 component.
    const w = 200, h = 400;
    const grey = makeGrey(w, h, 200);

    for (let i = 0; i < 25; i++) {
      drawRect(grey, w, 90, 5 + i * 15, 6, 8, 0);
    }

    const ctx = makeCtx(grey, w, h);
    analyzeTextGeometry(ctx, thresholds);
    expect(ctx.textGeometryMetrics).toBeDefined();
    // No row has >= 5 components → rowCount = 0 → baselineDeviation = 0
    expect(ctx.textGeometryMetrics!.baselineDeviation).toBe(0);
  });

  it('all components at the same X: regression denom ≈ 0, row skipped', () => {
    // All components in a single row but with identical cx (stacked vertically
    // but close enough in cy to cluster as one row).
    const w = 200, h = 200;
    const grey = makeGrey(w, h, 200);

    // 25 components at x=50, y spaced by 1px (within rowGap)
    for (let i = 0; i < 25; i++) {
      drawRect(grey, w, 50, 10 + i * 2, 6, 1, 0);
    }

    const ctx = makeCtx(grey, w, h);
    analyzeTextGeometry(ctx, thresholds);
    expect(ctx.textGeometryMetrics).toBeDefined();
    // All cx values identical → regression denom ≈ 0 → row skipped → deviation = 0
    expect(ctx.textGeometryMetrics!.baselineDeviation).toBe(0);
  });
});
