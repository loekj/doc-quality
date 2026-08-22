/**
 * Per-text-line legibility analysis.
 *
 * Page-level statistics answer "how does this page look". They cannot answer
 * the question that actually matters before OCR: "can each line be read?"
 * A page can be well lit, sharp and correctly exposed and still be useless
 * because the text was captured at 90 DPI and the strokes are one pixel wide.
 *
 * This measures the text itself: how tall the lowercase body is in pixels, how
 * wide the strokes are, and how far the ink separates from the paper. Those are
 * the quantities OCR accuracy actually depends on, and every one of them is
 * something a user can act on — move closer, rescan at a higher DPI, turn on
 * more light.
 *
 * Runs on native-resolution pixels. The analysis downscale that the other
 * analyzers use would destroy exactly the detail being measured.
 */

/** One detected line of text and its legibility measurements. */
export interface TextLine {
  /** First row of the line band, in pixels from the top. */
  top: number;
  /** Last row of the line band. */
  bottom: number;
  /**
   * Height of the lowercase body in pixels, excluding ascenders and descenders.
   *
   * The single best predictor of OCR success. Roughly 21px at 300 DPI for 10pt
   * text, 10px at 150 DPI, 7px at 96 DPI.
   */
  xHeight: number;
  /** Median stroke thickness in pixels. Below ~1.2 strokes break up. */
  strokeWidth: number;
  /** Separation between paper and ink, 0-255. */
  contrast: number;
  /** Mean gradient across ink edges, in grey levels. */
  edgeSharpness: number;
  /**
   * Edge gradient divided by the line's own ink-to-paper contrast.
   *
   * Raw gradient conflates blur with fading: pale text has small gradients
   * because there is less to cross, not because the strokes are soft.
   * Normalising separates them cleanly — measured on a 300 DPI page, sharp
   * text scores 0.62-0.78 whether crisp, JPEG-mangled, rotated or faded,
   * while Gaussian blur drops it to 0.30, 0.14 and 0.05.
   */
  strokeSharpness: number;
  /**
   * Stroke width as a fraction of x-height. Normal text sits near 0.18;
   * once letters merge into blobs it climbs past 1.
   */
  strokeRatio: number;
  /** Fraction of the line band that is ink. */
  inkRatio: number;
  /** False when any measurement falls below its legibility floor. */
  legible: boolean;
}

/** Aggregate text-line measurements for a page. */
export interface TextLineMetrics {
  lines: TextLine[];
  lineCount: number;
  medianXHeight: number;
  medianStrokeWidth: number;
  medianContrast: number;
  medianEdgeSharpness: number;
  medianStrokeSharpness: number;
  /** Fraction of detected lines that failed a legibility floor. */
  illegibleFraction: number;
  /** Greyscale threshold Otsu chose — useful for diagnostics. */
  binarizationThreshold: number;
}

/** Legibility floors. */
export interface TextLineThresholds {
  /** Minimum lowercase body height in pixels (default: 8). */
  xHeightMin: number;
  /** Minimum median stroke thickness in pixels (default: 1.2). */
  strokeWidthMin: number;
  /** Minimum ink-to-paper separation, 0-255 (default: 40). */
  contrastMin: number;
  /**
   * Minimum contrast-normalised edge gradient (default: 0.4).
   *
   * This is the per-line blur test. Without it a page blurred until the words
   * are unreadable still measured as legible: x-height and contrast survive
   * heavy blur, and stroke width only grows as letters merge.
   */
  strokeSharpnessMin: number;
}

export const TEXT_LINE_DEFAULTS: TextLineThresholds = {
  xHeightMin: 8,
  strokeWidthMin: 1.2,
  contrastMin: 40,
  strokeSharpnessMin: 0.4,
};

/** A band needs this share of the page width in ink to count as a text line. */
const MIN_LINE_INK_RATIO = 0.004;
/** Rows carrying at least this share of a band's peak ink form the lowercase body. */
const X_HEIGHT_INK_SHARE = 0.5;
/** Guard against pathological inputs. */
const MAX_LINES = 4000;
/**
 * Above this ink share the darker class is the background, not the text —
 * the page is white-on-black. Measured: normal pages run 0.004-0.045 ink,
 * an inverted page reads 0.96.
 */
const INVERTED_INK_FRACTION = 0.5;
/**
 * Above this ink share (after polarity correction) there is no text structure
 * to measure. Random noise reads 0.47-0.54 either way round; real pages, even
 * dense ones, stay well under 0.2.
 */
const MAX_INK_FRACTION = 0.35;
/**
 * A band whose median ink run spans this much of the page width is a rule, a
 * border or a table line, not a row of letters. Measured: text runs are
 * 0.002-0.004 of the width, a horizontal rule is 0.875.
 */
const RULE_RUN_WIDTH_FRACTION = 0.3;
/** ...and a rule is one unbroken run per row, where text is 5-40. */
const RULE_MAX_RUNS_PER_ROW = 3;

// ── helpers ──────────────────────────────────────────────────────

function otsu(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let threshold = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const meanB = sumB / wB;
    const meanF = (sum - sumB) / wF;
    const between = wB * wF * (meanB - meanF) * (meanB - meanF);
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Undo page skew with a per-column vertical shift.
 *
 * A rotation small enough to be called skew is well approximated by a shear,
 * and a shear along one axis is just an integer offset per column. That keeps
 * every downstream measurement on a rectilinear buffer where rows really are
 * text lines.
 */
function deskew(
  grey: Buffer | Uint8Array,
  width: number,
  height: number,
  skewDeg: number,
): Buffer | Uint8Array {
  if (Math.abs(skewDeg) < 0.15) return grey;

  const tan = Math.tan((skewDeg * Math.PI) / 180);
  const centreX = width / 2;
  const out = Buffer.alloc(width * height, 255);

  for (let x = 0; x < width; x++) {
    const shift = Math.round((x - centreX) * tan);
    for (let y = 0; y < height; y++) {
      const srcY = y + shift;
      if (srcY < 0 || srcY >= height) continue;
      out[y * width + x] = grey[srcY * width + x];
    }
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────

/**
 * Detect text lines and measure each one's legibility.
 *
 * @param grey - Native-resolution greyscale pixels, one byte per pixel
 * @param width - Pixel width
 * @param height - Pixel height
 * @param skewDeg - Signed page skew in degrees, from `estimateSkewAngle`
 * @param thresholds - Legibility floors
 * @returns Metrics, or null when no text lines could be found
 */
export function analyzeTextLines(
  grey: Buffer | Uint8Array,
  width: number,
  height: number,
  skewDeg = 0,
  thresholds: TextLineThresholds = TEXT_LINE_DEFAULTS,
): TextLineMetrics | null {
  if (width < 64 || height < 64) return null;

  let pixels = deskew(grey, width, height, skewDeg);
  const total = width * height;

  let hist = new Uint32Array(256);
  for (let i = 0; i < total; i++) hist[pixels[i]]++;
  let threshold = otsu(hist, total);

  let inkPixels = 0;
  for (let i = 0; i <= threshold; i++) inkPixels += hist[i];

  // White-on-black: the darker class is the page, not the text. Flip it and
  // re-threshold, otherwise the whole page reads as one enormous "line".
  if (inkPixels / total > INVERTED_INK_FRACTION) {
    const inverted = Buffer.alloc(total);
    for (let i = 0; i < total; i++) inverted[i] = 255 - pixels[i];
    pixels = inverted;
    hist = new Uint32Array(256);
    for (let i = 0; i < total; i++) hist[pixels[i]]++;
    threshold = otsu(hist, total);
    inkPixels = 0;
    for (let i = 0; i <= threshold; i++) inkPixels += hist[i];
  }

  // Still mostly "ink" after correction means there is no figure/ground split
  // at all — noise, a photograph, a solid fill. Nothing here is a text line.
  if (inkPixels / total > MAX_INK_FRACTION) return null;

  // Ink per row. Text lines are the peaks; leading is the floor between them.
  const rowInk = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let ink = 0;
    for (let x = 0; x < width; x++) {
      if (pixels[row + x] <= threshold) ink++;
    }
    rowInk[y] = ink;
  }

  const minInk = Math.max(2, Math.round(width * MIN_LINE_INK_RATIO));

  const lines: TextLine[] = [];
  let bandStart = -1;

  for (let y = 0; y <= height; y++) {
    const isTextRow = y < height && rowInk[y] >= minInk;

    if (isTextRow && bandStart === -1) {
      bandStart = y;
      continue;
    }
    if (isTextRow || bandStart === -1) continue;

    measureBand(lines, pixels, width, threshold, bandStart, y - 1, rowInk, thresholds);
    bandStart = -1;
    if (lines.length >= MAX_LINES) break;
  }

  if (lines.length === 0) return null;

  const xHeights = lines.map((l) => l.xHeight);
  const illegible = lines.filter((l) => !l.legible).length;

  return {
    lines,
    lineCount: lines.length,
    medianXHeight: median(xHeights),
    medianStrokeWidth: median(lines.map((l) => l.strokeWidth)),
    medianContrast: median(lines.map((l) => l.contrast)),
    medianEdgeSharpness: median(lines.map((l) => l.edgeSharpness)),
    medianStrokeSharpness: median(lines.map((l) => l.strokeSharpness)),
    illegibleFraction: illegible / lines.length,
    binarizationThreshold: threshold,
  };
}

/** Measure one line band and append it if it holds real text. */
function measureBand(
  lines: TextLine[],
  pixels: Buffer | Uint8Array,
  width: number,
  threshold: number,
  top: number,
  bottom: number,
  rowInk: Int32Array,
  t: TextLineThresholds,
): void {
  const bandHeight = bottom - top + 1;
  // One or two rows of ink is a rule, a speck or a table border, not a line.
  if (bandHeight < 3) return;

  // The lowercase body is where the ink concentrates; ascenders and descenders
  // only reach a minority of rows.
  let peakInk = 0;
  for (let y = top; y <= bottom; y++) if (rowInk[y] > peakInk) peakInk = rowInk[y];
  const bodyFloor = peakInk * X_HEIGHT_INK_SHARE;

  let bodyTop = -1;
  let bodyBottom = -1;
  for (let y = top; y <= bottom; y++) {
    if (rowInk[y] < bodyFloor) continue;
    if (bodyTop === -1) bodyTop = y;
    bodyBottom = y;
  }
  if (bodyTop === -1) return;
  const xHeight = bodyBottom - bodyTop + 1;

  // Stroke width: horizontal run lengths of ink across the lowercase body.
  const runs: number[] = [];
  let inkSum = 0;
  let inkCount = 0;
  let paperSum = 0;
  let paperCount = 0;
  let edgeGradient = 0;
  let edgeCount = 0;

  for (let y = bodyTop; y <= bodyBottom; y++) {
    const row = y * width;
    let run = 0;
    for (let x = 0; x < width; x++) {
      const value = pixels[row + x];
      const isInk = value <= threshold;

      if (isInk) {
        inkSum += value;
        inkCount++;
        run++;
      } else {
        paperSum += value;
        paperCount++;
        if (run > 0) {
          runs.push(run);
          run = 0;
        }
      }

      // Gradient across an ink boundary tells us how crisp the stroke edge is.
      if (x > 0) {
        const prevInk = pixels[row + x - 1] <= threshold;
        if (prevInk !== isInk) {
          edgeGradient += Math.abs(value - pixels[row + x - 1]);
          edgeCount++;
        }
      }
    }
    if (run > 0) runs.push(run);
  }

  if (inkCount === 0 || paperCount === 0 || runs.length === 0) return;

  const strokeWidth = median(runs);

  // Rules, borders and table lines project exactly like text but are not text.
  // One unbroken run spanning most of the width is the signature; letters give
  // many short runs. Counting them as lines would drag a form's legibility
  // score down with dozens of 3px-tall "illegible" entries.
  const bodyRows = bodyBottom - bodyTop + 1;
  const runsPerRow = runs.length / bodyRows;
  if (strokeWidth / width > RULE_RUN_WIDTH_FRACTION && runsPerRow < RULE_MAX_RUNS_PER_ROW) return;
  const contrast = paperSum / paperCount - inkSum / inkCount;
  const edgeSharpness = edgeCount > 0 ? edgeGradient / edgeCount : 0;
  const inkRatio = inkCount / (inkCount + paperCount);

  const strokeSharpness = contrast > 0 ? edgeSharpness / contrast : 0;

  lines.push({
    top,
    bottom,
    xHeight,
    strokeWidth,
    contrast,
    edgeSharpness,
    strokeSharpness,
    strokeRatio: xHeight > 0 ? strokeWidth / xHeight : 0,
    inkRatio,
    legible:
      xHeight >= t.xHeightMin &&
      strokeWidth >= t.strokeWidthMin &&
      contrast >= t.contrastMin &&
      strokeSharpness >= t.strokeSharpnessMin,
  });
}
