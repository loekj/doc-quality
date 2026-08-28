import type { AnalysisContext, Issue, Thresholds } from './types.js';
import { highFreqEnergyRatio, countSpectralPeaks, jpegBlockiness } from './fft-core.js';
import { ISSUE_GUIDANCE } from './guidance.js';
import { analyzeTextLines } from './text-lines.js';

// ── Severity scaling ─────────────────────────────────────────────

/**
 * Beyond this multiple of the threshold, extra severity stops mattering.
 *
 * The exponent form is defensible without labels — a defect twice as far past
 * its threshold should cost more than one barely over it, and the penalty is
 * unchanged *at* the threshold either way. The steepness is not: at a cap of 4
 * a single blurry page scored 0.06, which is a stronger claim than the evidence
 * supports. Three keeps a severe single defect able to fail on its own while
 * leaving room for the feature report to say where this really belongs.
 */
const SEVERITY_CAP = 3;

/**
 * Scale a penalty by how badly the threshold was missed.
 *
 * Flat penalties treat a near-miss and a catastrophe alike: a JPEG at quality
 * 25 and one at quality 8 both scored 0.7, so the second one passed. Raising
 * the base penalty to the power of the overshoot keeps a marginal violation
 * marginal while letting a severe one actually sink the score.
 *
 * @param base - Penalty at exactly the threshold
 * @param ratio - How far past the threshold, as a multiple (1 = exactly at it)
 */
export function gradedPenalty(base: number, ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 1) return base;
  const exponent = Math.min(ratio, SEVERITY_CAP);
  return Math.max(0.05, Math.min(1, base ** exponent));
}

// ── Resolution ───────────────────────────────────────────────────

export function analyzeResolution(ctx: AnalysisContext, t: Thresholds): Issue | null {
  const mp = (ctx.metadata.width * ctx.metadata.height) / 1_000_000;
  if (mp >= t.resolutionMin) return null;
  return {
    analyzer: 'resolution',
    code: 'low-resolution',
    guidance: ISSUE_GUIDANCE['low-resolution'],
    message: `Resolution too low (${mp.toFixed(2)} MP, minimum ${t.resolutionMin} MP)`,
    value: mp,
    threshold: t.resolutionMin,
    penalty: gradedPenalty(0.5, mp > 0 ? t.resolutionMin / mp : SEVERITY_CAP),
  };
}

export function analyzeResolutionMax(ctx: AnalysisContext, t: Thresholds): Issue | null {
  const mp = (ctx.metadata.width * ctx.metadata.height) / 1_000_000;
  if (mp <= t.resolutionMax) return null;
  return {
    analyzer: 'resolution',
    code: 'resolution-too-high',
    guidance: ISSUE_GUIDANCE['resolution-too-high'],
    message: `Resolution too high (${mp.toFixed(1)} MP, maximum ${t.resolutionMax} MP)`,
    value: mp,
    threshold: t.resolutionMax,
    penalty: 0.5,
  };
}

// ── Distance from the document ───────────────────────────────────

/**
 * Catch a document photographed from too far away.
 *
 * This is the failure every frame-wide check is blind to. Focus, exposure,
 * contrast and megapixels all describe the picture, and a picture of a page
 * across the room is an excellent picture — sharp, evenly lit, 12 MP. What is
 * wrong is the scale of the writing inside it, and no measurement of the frame
 * can see that.
 *
 * Measured on one A4 page composited into a fixed 3000x4000 frame at
 * decreasing sizes, the page's lowercase body ran 25px at 85% of the frame,
 * 18px at 40%, 11px at 15% and 9px at 8% — crossing the 8px OCR floor at
 * roughly 0.8 MP of page, whatever the frame around it measured.
 *
 * Silent unless boundary detection found the page. A frame with no located
 * document could be a tight scan or a distant photograph, and guessing between
 * them from the frame alone is what produced the wrong answer in the first
 * place.
 *
 * It scores, and it has to, because cropping is flattering. Once boundary
 * detection can find a page this small, the pipeline crops to it and grades
 * what is left — and what is left no longer contains the desk that was failing
 * the capture. A German ID card lying at 22% of its frame, graded 0.15 by a
 * human, went from 0.01 to a clean 1.00 the moment the page became findable.
 * Detection and this penalty are one change; shipping either alone makes the
 * library worse.
 *
 * Framing was checked against Tesseract over a 440-image stratified sample of
 * the labelling corpus: below a fifth of the frame every file was unreadable,
 * between a fifth and a third eight of nine were, and past a third the number
 * settles at the corpus baseline and stops meaning anything. Over the same
 * sample the region's own megapixel count ordered nothing — 0.3–0.5 MP was 50%
 * unreadable and 3 MP and above was 58% — which is why it is a reprieve here
 * and not a gate.
 *
 * Together with the hole-filled solidity that made these pages findable, this
 * cut cards the library wrongly passed from 12 of 52 graded to 8, and moved one
 * image toward the human verdict with none moved away.
 *
 * Run `scripts/calibrate-ocr.mjs` to re-measure any of it.
 */
export function analyzeDocumentDistance(ctx: AnalysisContext, t: Thresholds): Issue | null {
  const region = ctx.documentRegion;
  if (!region) return null;
  // Framing leads, because framing is what the evidence orders. Measured
  // against the frame the file encodes: `ctx.metadata` is the crop once one has
  // been taken, and a region compared to its own crop is always 100%.
  const framePixels = ctx.encodedPixels ?? ctx.metadata.width * ctx.metadata.height;
  const fill = (region.width * region.height) / (framePixels || 1);
  if (fill >= t.documentFrameFillMax) return null;
  // The sensor's reprieve, and only that. A page at a fifth of a 48 MP frame is
  // still 7 MP of page and reads perfectly, so a large enough region excuses
  // the framing. It is not a second opinion on quality — over the same sample
  // the region's megapixel count did not order the outcome at all — which is
  // why it sits here, after the decision, rather than gating it.
  const mp = (region.width * region.height) / 1_000_000;
  if (mp >= t.documentRegionMpMin) return null;
  return {
    analyzer: 'documentDistance',
    code: 'document-too-far',
    guidance: ISSUE_GUIDANCE['document-too-far'],
    message:
      `Document too far away (fills ${(fill * 100).toFixed(0)}% of the frame, ` +
      `minimum ${(t.documentFrameFillMax * 100).toFixed(0)}%; ` +
      `${region.width}x${region.height} = ${mp.toFixed(2)} MP of page)`,
    value: fill,
    threshold: t.documentFrameFillMax,
    // Graded on framing, the quantity that decided this. Grading on megapixels
    // instead pinned every distance to the same severity, because the megapixel
    // floor is a reprieve set high enough to excuse a large sensor: a page at a
    // fifth of the frame and a page at a tenth both cleared it by miles and
    // came back with an identical penalty.
    penalty: gradedPenalty(0.5, fill > 0 ? t.documentFrameFillMax / fill : SEVERITY_CAP),
  };
}

// ── Brightness ───────────────────────────────────────────────────

export function analyzeBrightness(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.stats) return null;
  const avg =
    ctx.stats.channels.reduce((s, ch) => s + ch.mean, 0) / ctx.stats.channels.length;

  if (avg < t.brightnessMin) {
    return {
      analyzer: 'brightness',
      code: 'too-dark',
      guidance: ISSUE_GUIDANCE['too-dark'],
      message: `Image too dark (brightness ${avg.toFixed(0)}, minimum ${t.brightnessMin})`,
      value: avg,
      threshold: t.brightnessMin,
      penalty: gradedPenalty(0.6, avg > 0 ? t.brightnessMin / avg : SEVERITY_CAP),
    };
  }
  if (avg > t.brightnessMax) {
    return {
      analyzer: 'brightness',
      code: 'overexposed',
      guidance: ISSUE_GUIDANCE['overexposed'],
      message: `Image overexposed (brightness ${avg.toFixed(0)}, maximum ${t.brightnessMax})`,
      value: avg,
      threshold: t.brightnessMax,
      penalty: 0.7,
    };
  }
  return null;
}

// ── Sharpness (Laplacian variance) ───────────────────────────────

export function analyzeSharpness(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.laplacian) return null;
  if (ctx.laplacian.mean > t.sharpnessMax) {
    return {
      analyzer: 'sharpness',
      code: 'noisy',
      guidance: ISSUE_GUIDANCE['noisy'],
      message: `Excessive noise (laplacian mean ${ctx.laplacian.mean.toFixed(1)}, maximum ${t.sharpnessMax})`,
      value: ctx.laplacian.mean,
      threshold: t.sharpnessMax,
      penalty: 0.4,
    };
  }
  if (ctx.laplacian.stdev >= t.sharpnessMin) return null;
  return {
    analyzer: 'sharpness',
    code: 'blurry',
    guidance: ISSUE_GUIDANCE['blurry'],
    message: `Image is blurry (sharpness ${ctx.laplacian.stdev.toFixed(1)}, minimum ${t.sharpnessMin})`,
    value: ctx.laplacian.stdev,
    threshold: t.sharpnessMin,
    penalty: gradedPenalty(0.5, ctx.laplacian.stdev > 0 ? t.sharpnessMin / ctx.laplacian.stdev : SEVERITY_CAP),
  };
}

// ── Edge density ─────────────────────────────────────────────────

export function analyzeEdgeDensity(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.laplacian) return null;
  const density = ctx.laplacian.edgeCount / ctx.laplacian.length;
  if (density < t.edgeDensityMin) {
    return {
      analyzer: 'edgeDensity',
      code: 'low-edge-density',
      guidance: ISSUE_GUIDANCE['low-edge-density'],
      message: `No legible content detected (edge density ${(density * 100).toFixed(1)}%, minimum ${(t.edgeDensityMin * 100).toFixed(1)}%)`,
      value: density,
      threshold: t.edgeDensityMin,
      penalty: gradedPenalty(0.6, density > 0 ? t.edgeDensityMin / density : SEVERITY_CAP),
    };
  }
  if (density > t.edgeDensityMax) {
    return {
      analyzer: 'edgeDensity',
      code: 'high-edge-density',
      guidance: ISSUE_GUIDANCE['high-edge-density'],
      message: `Excessive noise detected (edge density ${(density * 100).toFixed(1)}%, maximum ${(t.edgeDensityMax * 100).toFixed(1)}%)`,
      value: density,
      threshold: t.edgeDensityMax,
      penalty: 0.4,
    };
  }
  return null;
}

// ── Text contrast (binarization) ─────────────────────────────────

export function analyzeTextContrast(foregroundRatio: number, t: Thresholds): Issue | null {
  if (foregroundRatio < t.contrastMin) {
    return {
      analyzer: 'textContrast',
      code: 'low-contrast',
      guidance: ISSUE_GUIDANCE['low-contrast'],
      message: `Very low contrast (${(foregroundRatio * 100).toFixed(1)}% foreground, minimum ${(t.contrastMin * 100).toFixed(1)}%)`,
      value: foregroundRatio,
      threshold: t.contrastMin,
      penalty: gradedPenalty(0.6, foregroundRatio > 0 ? t.contrastMin / foregroundRatio : SEVERITY_CAP),
    };
  }
  if (foregroundRatio > t.contrastMax) {
    return {
      analyzer: 'textContrast',
      code: 'too-dark-content',
      guidance: ISSUE_GUIDANCE['too-dark-content'],
      message: `Image mostly dark (${(foregroundRatio * 100).toFixed(1)}% foreground, maximum ${(t.contrastMax * 100).toFixed(1)}%)`,
      value: foregroundRatio,
      threshold: t.contrastMax,
      penalty: 0.7,
    };
  }
  return null;
}

// ── File size ────────────────────────────────────────────────────

export function analyzeFileSize(ctx: AnalysisContext, t: Thresholds): Issue | null {
  const size = ctx.originalBuffer.length;
  if (size >= t.fileSizeMin) return null;
  return {
    analyzer: 'fileSize',
    code: 'file-too-small',
    guidance: ISSUE_GUIDANCE['file-too-small'],
    message: `File very small (${(size / 1024).toFixed(0)} KB, minimum ${(t.fileSizeMin / 1024).toFixed(0)} KB)`,
    value: size,
    threshold: t.fileSizeMin,
    penalty: 0.7,
  };
}

export function analyzeFileSizeMax(ctx: AnalysisContext, t: Thresholds): Issue | null {
  const size = ctx.originalBuffer.length;
  if (size <= t.fileSizeMax) return null;
  return {
    analyzer: 'fileSize',
    code: 'file-too-large',
    guidance: ISSUE_GUIDANCE['file-too-large'],
    message: `File too large (${(size / 1_000_000).toFixed(1)} MB, maximum ${(t.fileSizeMax / 1_000_000).toFixed(0)} MB)`,
    value: size,
    threshold: t.fileSizeMax,
    penalty: 0.5,
  };
}

// ── Perspective / angle — sharpness uniformity ───────────────────

export function analyzePerspectiveSharpness(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.laplacian || ctx.laplacian.height <= 20) return null;

  const { data, width, height, length } = ctx.laplacian;
  const halfRow = Math.floor(height / 2);
  const topLen = width * halfRow;
  const botLen = length - topLen;

  let topSum = 0,
    topSumSq = 0;
  for (let i = 0; i < topLen; i++) {
    topSum += data[i];
    topSumSq += data[i] * data[i];
  }
  let botSum = 0,
    botSumSq = 0;
  for (let i = topLen; i < length; i++) {
    botSum += data[i];
    botSumSq += data[i] * data[i];
  }

  const topVar = topSumSq / topLen - (topSum / topLen) ** 2;
  const botVar = botSumSq / botLen - (botSum / botLen) ** 2;
  const maxVar = Math.max(topVar, botVar);
  const minVar = Math.min(topVar, botVar);

  // Skip if one half is blank margin
  if (minVar <= 5) return null;

  const ratio = maxVar / minVar;
  if (ratio <= t.uniformitySharpnessRatio) return null;

  return {
    analyzer: 'perspective',
    code: 'uneven-focus',
    guidance: ISSUE_GUIDANCE['uneven-focus'],
    message: `Uneven focus — possible angle (ratio ${ratio.toFixed(1)}, max ${t.uniformitySharpnessRatio})`,
    value: ratio,
    threshold: t.uniformitySharpnessRatio,
    penalty: gradedPenalty(0.65, t.uniformitySharpnessRatio > 0 ? ratio / t.uniformitySharpnessRatio : SEVERITY_CAP),
  };
}

// ── DPI (from metadata) ──────────────────────────────────────────

/**
 * Camera/phone images embed low, meaningless DPI values (72, 96, 150, 200).
 * Only scanner software sets DPI intentionally (typically 200+).
 * Skip anything below this floor to avoid false positives on phone photos.
 */
const CAMERA_DPI_FLOOR = 200;

export function analyzeDpi(ctx: AnalysisContext, t: Thresholds): Issue | null {
  const dpi = ctx.sharpMeta?.density;
  if (!dpi || dpi <= 0) return null; // No DPI metadata — skip
  // The camera floor exists because EXIF density is meaningless on phone photos.
  // A DPI derived from PDF page geometry is real, so it bypasses the floor.
  if (!ctx.densityAuthoritative && dpi <= CAMERA_DPI_FLOOR) return null;
  if (dpi >= t.dpiMin) return null;
  return {
    analyzer: 'dpi',
    code: 'low-dpi',
    guidance: ISSUE_GUIDANCE['low-dpi'],
    message: `Low DPI (${dpi}, minimum ${t.dpiMin})`,
    value: dpi,
    threshold: t.dpiMin,
    penalty: gradedPenalty(0.7, dpi > 0 ? t.dpiMin / dpi : SEVERITY_CAP),
  };
}

// ── Blank page ──────────────────────────────────────────────────

export function analyzeBlankPage(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.stats) return null;
  const maxStdev = Math.max(...ctx.stats.channels.map((ch) => ch.stdev));
  if (maxStdev >= t.blankVarianceMax) return null;
  return {
    analyzer: 'blankPage',
    code: 'blank-page',
    guidance: ISSUE_GUIDANCE['blank-page'],
    message: `Blank page detected (max stdev ${maxStdev.toFixed(2)}, threshold ${t.blankVarianceMax})`,
    value: maxStdev,
    threshold: t.blankVarianceMax,
    penalty: 0.1,
  };
}

// ── Compression quality (JPEG bits-per-pixel) ────────────────────

export function analyzeCompression(ctx: AnalysisContext, t: Thresholds): Issue | null {
  const format = ctx.sharpMeta?.format ?? ctx.metadata.format;
  if (format !== 'jpeg') return null;
  // Against the encoded frame, not a cropped subregion: the file's bytes encode
  // the whole image, so dividing them by fewer pixels invents compression.
  const totalPixels = ctx.encodedPixels ?? ctx.metadata.width * ctx.metadata.height;
  if (totalPixels === 0) return null;
  const bpp = (ctx.originalBuffer.length * 8) / totalPixels;
  if (bpp >= t.compressionBppMin) return null;

  // Low bits-per-pixel alone only proves the file is small. Oversampled text
  // is mostly white and compresses hard without losing anything. When the 8x8
  // block grid has been measured, require it to agree before calling it damage.
  if (ctx.jpegBlockiness !== undefined && ctx.jpegBlockiness < t.compressionBlockinessMin) {
    return null;
  }

  return {
    analyzer: 'compression',
    code: 'heavy-compression',
    guidance: ISSUE_GUIDANCE['heavy-compression'],
    message: `Heavy JPEG compression (${bpp.toFixed(2)} bpp, minimum ${t.compressionBppMin})`,
    value: bpp,
    threshold: t.compressionBppMin,
    penalty: gradedPenalty(0.7, bpp > 0 ? t.compressionBppMin / bpp : SEVERITY_CAP),
  };
}

/**
 * Mean brightness of the outer 10% frame against the middle 40% box.
 *
 * Computed once per image and cached on the context. Both shadow analyzers and
 * feature extraction need exactly these numbers.
 */
function shadowMetrics(ctx: AnalysisContext): { edgeMean: number; centerMean: number; diff: number } | null {
  if (ctx.shadowMetrics) return ctx.shadowMetrics;
  if (!ctx.greyRaw || ctx.greyRaw.height < 20 || ctx.greyRaw.width < 20) return null;

  const { data, width, height } = ctx.greyRaw;
  const stripSize = Math.max(1, Math.floor(Math.min(width, height) * 0.1));

  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 0; y < height; y++) {
    const inEdgeRow = y < stripSize || y >= height - stripSize;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!inEdgeRow && x >= stripSize && x < width - stripSize) continue;
      edgeSum += data[row + x];
      edgeCount++;
    }
  }

  const cx0 = Math.floor(width * 0.3);
  const cx1 = Math.floor(width * 0.7);
  const cy0 = Math.floor(height * 0.3);
  const cy1 = Math.floor(height * 0.7);
  let centerSum = 0;
  let centerCount = 0;
  for (let y = cy0; y < cy1; y++) {
    const row = y * width;
    for (let x = cx0; x < cx1; x++) {
      centerSum += data[row + x];
      centerCount++;
    }
  }

  if (edgeCount === 0 || centerCount === 0) return null;

  const edgeMean = edgeSum / edgeCount;
  const centerMean = centerSum / centerCount;
  ctx.shadowMetrics = { edgeMean, centerMean, diff: centerMean - edgeMean };
  return ctx.shadowMetrics;
}

/** 90th-percentile greyscale brightness, computed once and cached. */
export function backgroundP90(ctx: AnalysisContext): number | null {
  if (ctx.backgroundP90 !== undefined) return ctx.backgroundP90;
  if (!ctx.greyRaw || ctx.greyRaw.width < 20 || ctx.greyRaw.height < 20) return null;

  const { data } = ctx.greyRaw;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;

  const target = Math.floor(data.length * 0.9);
  let cumulative = 0;
  for (let value = 0; value < 256; value++) {
    cumulative += hist[value];
    if (cumulative >= target) {
      ctx.backgroundP90 = value;
      return value;
    }
  }
  ctx.backgroundP90 = 255;
  return 255;
}

// ── Shadow detection (dark edges vs center) ──────────────────────

export function analyzeShadow(ctx: AnalysisContext, t: Thresholds): Issue | null {
  const metrics = shadowMetrics(ctx);
  if (!metrics) return null;
  if (metrics.diff <= t.shadowBrightnessDiff) return null;

  return {
    analyzer: 'shadow',
    code: 'shadow-on-edges',
    guidance: ISSUE_GUIDANCE['shadow-on-edges'],
    message: `Shadow detected at edges (brightness diff ${metrics.diff.toFixed(0)}, max ${t.shadowBrightnessDiff})`,
    value: metrics.diff,
    threshold: t.shadowBrightnessDiff,
    penalty: gradedPenalty(0.7, t.shadowBrightnessDiff > 0 ? metrics.diff / t.shadowBrightnessDiff : SEVERITY_CAP),
  };
}

// ── Skew detection (projection profile) ──────────────────────────

/** Longest side used for skew estimation. Smaller is faster; 700px is plenty. */
const SKEW_MAX_DIM = 700;
/** Coarse search half-range in degrees. */
const SKEW_SEARCH_DEG = 15;
/** Minimum foreground pixels needed for a stable estimate. */
const SKEW_MIN_FOREGROUND = 200;
/** Cap on foreground samples — keeps cost bounded on near-black images. */
const SKEW_MAX_SAMPLES = 120_000;

/** Otsu's method — returns the greyscale threshold maximising between-class variance. */
function otsuThreshold(hist: Uint32Array, total: number): number {
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

/**
 * Estimate document skew in degrees via projection profiling.
 *
 * Shears the binarised foreground by a candidate angle, projects onto the Y
 * axis, and scores the profile by sum-of-squares. When text lines align with
 * the projection axis the profile becomes a series of tall spikes, which
 * maximises that score. Coarse pass at 1°, then a refinement pass at 0.1°.
 *
 * Replaces an edge center-of-mass regression that tracked where ink sat on the
 * page rather than the angle of its baselines. Measured against pages rotated
 * by known amounts, that method averaged 34.5° of error and inverted the sign
 * above ~2°; this one averages 0.06°.
 *
 * Returns null when there is not enough foreground to measure.
 */
export function estimateSkewAngle(
  grey: Buffer | Uint8Array,
  width: number,
  height: number,
): number | null {
  if (width < 20 || height < 20) return null;

  // Decimate by an integer stride — cheaper than resampling and good enough,
  // because we only need the position of ink, not its exact shape.
  const stride = Math.max(1, Math.ceil(Math.max(width, height) / SKEW_MAX_DIM));
  const sw = Math.floor(width / stride);
  const sh = Math.floor(height / stride);
  if (sw < 20 || sh < 20) return null;

  const hist = new Uint32Array(256);
  for (let y = 0; y < sh; y++) {
    const row = y * stride * width;
    for (let x = 0; x < sw; x++) hist[grey[row + x * stride]]++;
  }
  const threshold = otsuThreshold(hist, sw * sh);

  // Collect foreground (dark) pixel coordinates.
  let fgTotal = 0;
  for (let i = 0; i <= threshold; i++) fgTotal += hist[i];
  if (fgTotal < SKEW_MIN_FOREGROUND) return null;

  const sampleStep = fgTotal > SKEW_MAX_SAMPLES ? Math.ceil(fgTotal / SKEW_MAX_SAMPLES) : 1;
  const capacity = Math.ceil(fgTotal / sampleStep) + 1;
  const fx = new Float32Array(capacity);
  const fy = new Float32Array(capacity);

  let seen = 0;
  let n = 0;
  for (let y = 0; y < sh && n < capacity; y++) {
    const row = y * stride * width;
    for (let x = 0; x < sw; x++) {
      if (grey[row + x * stride] > threshold) continue;
      if (seen++ % sampleStep !== 0) continue;
      if (n >= capacity) break;
      fx[n] = x;
      fy[n] = y;
      n++;
    }
  }
  if (n < SKEW_MIN_FOREGROUND) return null;

  const cx = sw / 2;
  const profile = new Float64Array(sh + 1);

  function profileScore(angleDeg: number): number {
    profile.fill(0);
    const tan = Math.tan((angleDeg * Math.PI) / 180);
    let counted = 0;
    for (let i = 0; i < n; i++) {
      const yy = fy[i] - (fx[i] - cx) * tan;
      // Drop points sheared off the page. Clamping them instead piled every
      // stray point into bin 0 or bin sh, and that artificial spike made the
      // most extreme angle score highest — a straight sparse page measured 16°.
      if (yy < 0 || yy >= sh) continue;
      profile[yy | 0]++;
      counted++;
    }
    if (counted === 0) return 0;
    // Normalise by the points actually counted, so an angle cannot win simply
    // by shearing content out of the profile.
    let score = 0;
    for (let i = 0; i < sh; i++) score += profile[i] * profile[i];
    return score / counted;
  }

  let bestAngle = 0;
  let bestScore = -1;
  for (let a = -SKEW_SEARCH_DEG; a <= SKEW_SEARCH_DEG; a += 1) {
    const score = profileScore(a);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = a;
    }
  }
  const fineFrom = Math.max(-SKEW_SEARCH_DEG, bestAngle - 1);
  const fineTo = Math.min(SKEW_SEARCH_DEG, bestAngle + 1);
  for (let a = fineFrom; a <= fineTo + 1e-9; a += 0.1) {
    const score = profileScore(a);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = a;
    }
  }

  return Math.round(bestAngle * 100) / 100;
}

export function analyzeSkew(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.greyRaw) return null;
  const { data, width, height } = ctx.greyRaw;

  const angle = estimateSkewAngle(data, width, height);
  if (angle === null) return null;

  ctx.skewAngle = angle; // signed — textGeometry needs the direction to deskew
  const angleDeg = Math.abs(angle);
  if (angleDeg <= t.skewAngleMax) return null;

  return {
    analyzer: 'skew',
    code: 'tilted',
    guidance: ISSUE_GUIDANCE['tilted'],
    message: `Document appears skewed (${angleDeg.toFixed(1)}°, max ${t.skewAngleMax}°)`,
    value: angleDeg,
    threshold: t.skewAngleMax,
    penalty: gradedPenalty(0.85, t.skewAngleMax > 0 ? angleDeg / t.skewAngleMax : SEVERITY_CAP),
  };
}

// ── Color depth (grayscale-in-color container) ───────────────────

export function analyzeColorDepth(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.stats || !ctx.sharpMeta) return null;

  const channels = ctx.sharpMeta.channels ?? 0;
  const space = ctx.sharpMeta.space ?? '';

  // Only flag if the container is color (3+ channels, srgb/etc)
  if (channels < 3) return null;
  if (space === 'b-w' || space === 'grey') return null;

  // Compute max difference between channel means as a saturation proxy
  const means = ctx.stats.channels.slice(0, 3).map((ch) => ch.mean);
  const maxMean = Math.max(...means);
  const minMean = Math.min(...means);
  const saturation = (maxMean - minMean) / 255;

  if (saturation >= t.colorSaturationMin) return null;

  return {
    analyzer: 'colorDepth',
    code: 'grayscale-in-color',
    guidance: ISSUE_GUIDANCE['grayscale-in-color'],
    message: `Grayscale content in color container (saturation ${(saturation * 100).toFixed(2)}%, min ${(t.colorSaturationMin * 100).toFixed(2)}%)`,
    value: saturation,
    threshold: t.colorSaturationMin,
    penalty: 0.97,
    // Advisory: a greyscale scan stored as RGB is a file-format observation,
    // not a quality defect. Fires on ~62% of real documents.
    severity: 'advisory',
  };
}


// ── Perspective / angle — brightness uniformity ──────────────────

export function analyzePerspectiveBrightness(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.greyRaw || ctx.greyRaw.height <= 20) return null;

  const { data, width, height } = ctx.greyRaw;
  const halfRow = Math.floor(height / 2);
  const topLen = width * halfRow;
  const total = data.length;

  let topBright = 0,
    botBright = 0;
  for (let i = 0; i < topLen; i++) topBright += data[i];
  for (let i = topLen; i < total; i++) botBright += data[i];

  const topMean = topBright / topLen;
  const botMean = botBright / (total - topLen);
  const diff = Math.abs(topMean - botMean);

  if (diff <= t.uniformityBrightnessDiff) return null;

  return {
    analyzer: 'perspective',
    code: 'uneven-lighting',
    guidance: ISSUE_GUIDANCE['uneven-lighting'],
    message: `Uneven lighting — possible angle (diff ${diff.toFixed(0)}, max ${t.uniformityBrightnessDiff})`,
    value: diff,
    threshold: t.uniformityBrightnessDiff,
    penalty: 0.7,
  };
}

// ── FFT-based analyzers ──────────────────────────────────────────

export function analyzeFFTBlur(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.fftSpectrum) return null;
  const ratio = highFreqEnergyRatio(ctx.fftSpectrum);
  if (ratio >= t.fftBlurHighFreqMin) return null;
  return {
    analyzer: 'fftBlur',
    code: 'fft-blur',
    guidance: ISSUE_GUIDANCE['fft-blur'],
    message: `Spectral blur detected (high-freq energy ${(ratio * 100).toFixed(1)}%, minimum ${(t.fftBlurHighFreqMin * 100).toFixed(1)}%)`,
    value: ratio,
    threshold: t.fftBlurHighFreqMin,
    penalty: gradedPenalty(0.6, ratio > 0 ? t.fftBlurHighFreqMin / ratio : SEVERITY_CAP),
  };
}

export function analyzeFFTNoise(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.fftSpectrum) return null;
  const ratio = highFreqEnergyRatio(ctx.fftSpectrum);
  if (ratio <= t.fftNoiseHighFreqMax) return null;
  return {
    analyzer: 'fftNoise',
    code: 'fft-noise',
    guidance: ISSUE_GUIDANCE['fft-noise'],
    message: `Spectral noise detected (high-freq energy ${(ratio * 100).toFixed(1)}%, maximum ${(t.fftNoiseHighFreqMax * 100).toFixed(1)}%)`,
    value: ratio,
    threshold: t.fftNoiseHighFreqMax,
    penalty: 0.7,
  };
}

export function analyzeFFTMoire(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.fftSpectrum) return null;
  const peaks = countSpectralPeaks(ctx.fftSpectrum);
  if (peaks <= t.fftMoirePeaksMax) return null;
  return {
    analyzer: 'fftMoire',
    code: 'fft-moire',
    guidance: ISSUE_GUIDANCE['fft-moire'],
    message: `Moiré pattern detected via FFT (${peaks} spectral peaks, maximum ${t.fftMoirePeaksMax})`,
    value: peaks,
    threshold: t.fftMoirePeaksMax,
    penalty: 0.7,
    // Advisory: printed text is periodic, so a clean page produces 20k-37k
    // spectral peaks on its own. Kept as an ML feature, not a gate.
    severity: 'advisory',
  };
}

// ── Dim background detection ────────────────────────────────────

/**
 * Detect dim document background. Uses 90th percentile brightness of greyscale
 * data — the brightest region (paper) should be reasonably white.
 * Fires when even the brightest areas are dim, indicating poor lighting.
 */
export function analyzeDimBackground(ctx: AnalysisContext, t: Thresholds): Issue | null {
  const p90 = backgroundP90(ctx);
  if (p90 === null) return null;
  if (p90 >= t.backgroundP90Min) return null;

  return {
    analyzer: 'dimBackground',
    code: 'dim-background',
    guidance: ISSUE_GUIDANCE['dim-background'],
    message: `Document background too dim (p90 brightness ${p90}, minimum ${t.backgroundP90Min})`,
    value: p90,
    threshold: t.backgroundP90Min,
    penalty: gradedPenalty(0.75, p90 > 0 ? t.backgroundP90Min / p90 : SEVERITY_CAP),
  };
}

/**
 * Enhanced shadow detection — catches moderate shadows on already-dim documents.
 * The standard shadow analyzer requires a large edge-center brightness difference (60+).
 * This catches the harder case: moderate shadow (diff 20-40) where the center is
 * also dim (< 150), indicating the entire document is poorly lit with uneven shadow.
 */
export function analyzeDarkShadow(ctx: AnalysisContext, t: Thresholds): Issue | null {
  const metrics = shadowMetrics(ctx);
  if (!metrics) return null;

  // Compound check: moderate shadow over a centre that is itself dim.
  if (metrics.centerMean >= t.darkShadowCenterMax || metrics.diff <= t.darkShadowDiffMin) return null;

  return {
    analyzer: 'shadow',
    code: 'dark-shadow',
    guidance: ISSUE_GUIDANCE['dark-shadow'],
    message:
      `Dark shadow on dim document (center brightness ${metrics.centerMean.toFixed(0)}, ` +
      `edge-center diff ${metrics.diff.toFixed(0)})`,
    value: metrics.diff,
    threshold: t.darkShadowDiffMin,
    penalty: 0.65,
  };
}

// ── Zone quality (2×2 grid uniformity) ───────────────────────────

export function analyzeZoneQuality(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.greyRaw || !ctx.laplacian) return null;
  const { data: grey, width: gw, height: gh } = ctx.greyRaw;
  const { data: lap, width: lw, height: lh } = ctx.laplacian;

  // Too small to subdivide meaningfully
  if (gw < 100 || gh < 100 || lw < 100 || lh < 100) return null;

  // Compute per-quadrant brightness from greyRaw
  const halfGW = Math.floor(gw / 2);
  const halfGH = Math.floor(gh / 2);
  const zoneBrightness = [0, 0, 0, 0]; // TL, TR, BL, BR
  const zoneCounts = [0, 0, 0, 0];

  for (let y = 0; y < gh; y++) {
    const row = y < halfGH ? 0 : 1;
    for (let x = 0; x < gw; x++) {
      const col = x < halfGW ? 0 : 1;
      const idx = row * 2 + col;
      zoneBrightness[idx] += grey[y * gw + x];
      zoneCounts[idx]++;
    }
  }

  for (let i = 0; i < 4; i++) {
    zoneBrightness[i] = zoneCounts[i] > 0 ? zoneBrightness[i] / zoneCounts[i] : 0;
  }

  // Compute per-quadrant sharpness (laplacian stdev) from laplacian
  const halfLW = Math.floor(lw / 2);
  const halfLH = Math.floor(lh / 2);
  const zoneSum = [0, 0, 0, 0];
  const zoneSumSq = [0, 0, 0, 0];
  const zoneN = [0, 0, 0, 0];

  for (let y = 0; y < lh; y++) {
    const row = y < halfLH ? 0 : 1;
    for (let x = 0; x < lw; x++) {
      const col = x < halfLW ? 0 : 1;
      const idx = row * 2 + col;
      const v = lap[y * lw + x];
      zoneSum[idx] += v;
      zoneSumSq[idx] += v * v;
      zoneN[idx]++;
    }
  }

  const zoneSharpness = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    if (zoneN[i] > 0) {
      const mean = zoneSum[i] / zoneN[i];
      const variance = zoneSumSq[i] / zoneN[i] - mean * mean;
      zoneSharpness[i] = Math.sqrt(Math.max(0, variance));
    }
  }

  // Which quadrants actually hold content? Greyscale spread answers that:
  // blank paper is uniform, blurred text is still a smudge with variation.
  const zoneGreySq = [0, 0, 0, 0];
  const zoneGreySum = [0, 0, 0, 0];
  const zoneGreyN = [0, 0, 0, 0];
  for (let y = 0; y < gh; y++) {
    const row = y < halfGH ? 0 : 1;
    for (let x = 0; x < gw; x++) {
      const idx = row * 2 + (x < halfGW ? 0 : 1);
      const v = grey[y * gw + x];
      zoneGreySum[idx] += v;
      zoneGreySq[idx] += v * v;
      zoneGreyN[idx]++;
    }
  }
  const contentSharpness: number[] = [];
  for (let i = 0; i < 4; i++) {
    if (zoneGreyN[i] === 0) continue;
    const m = zoneGreySum[i] / zoneGreyN[i];
    const stdev = Math.sqrt(Math.max(0, zoneGreySq[i] / zoneGreyN[i] - m * m));
    if (stdev >= t.zoneContentStdevMin) contentSharpness.push(zoneSharpness[i]);
  }

  // Brightness check: max spread across quadrants
  const maxBright = Math.max(...zoneBrightness);
  const minBright = Math.min(...zoneBrightness);
  const brightDiff = maxBright - minBright;

  // Sharpness check: weakest against strongest, over quadrants holding content.
  // Fewer than two means there is nothing to compare — a one-column letter is
  // not unevenly focused just because three quadrants are margin.
  let sharpRatio = 1;
  if (contentSharpness.length >= 2) {
    const maxSharp = Math.max(...contentSharpness);
    const minSharp = Math.min(...contentSharpness);
    sharpRatio = maxSharp > 0 ? minSharp / maxSharp : 1;
  }

  ctx.zoneMetrics = {
    brightness: zoneBrightness,
    sharpness: zoneSharpness,
    brightnessDiff: brightDiff,
    sharpnessRatio: sharpRatio,
  };

  const brightIssue = brightDiff > t.zoneBrightnessMaxDiff;
  const sharpIssue = sharpRatio < t.zoneSharpnessMinRatio;

  if (!brightIssue && !sharpIssue) return null;

  // Return the worst issue (brightness tends to be more impactful)
  if (brightIssue) {
    return {
      analyzer: 'zoneQuality',
      code: 'uneven-zone-brightness',
      guidance: ISSUE_GUIDANCE['uneven-zone-brightness'],
      message: `Uneven zone brightness (spread ${brightDiff.toFixed(0)}, max ${t.zoneBrightnessMaxDiff})`,
      value: brightDiff,
      threshold: t.zoneBrightnessMaxDiff,
      penalty: gradedPenalty(0.7, t.zoneBrightnessMaxDiff > 0 ? brightDiff / t.zoneBrightnessMaxDiff : SEVERITY_CAP),
    };
  }

  return {
    analyzer: 'zoneQuality',
    code: 'uneven-zone-sharpness',
    guidance: ISSUE_GUIDANCE['uneven-zone-sharpness'],
    message: `Uneven zone sharpness (ratio ${sharpRatio.toFixed(2)}, min ${t.zoneSharpnessMinRatio})`,
    value: sharpRatio,
    threshold: t.zoneSharpnessMinRatio,
    penalty: gradedPenalty(0.7, sharpRatio > 0 ? t.zoneSharpnessMinRatio / sharpRatio : SEVERITY_CAP),
  };
}

// ── Directional blur detection (FFT angular energy) ──────────────

export function analyzeDirectionalBlur(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.fftSpectrum) return null;

  const { magnitude, fftW, fftH } = ctx.fftSpectrum;
  const halfW = fftW >>> 1;
  const halfH = fftH >>> 1;

  // Divide spectrum into 12 angular sectors of 30°
  const numSectors = 12;
  const sectorEnergy = new Float64Array(numSectors);

  for (let y = 0; y < fftH; y++) {
    const fy = y <= halfH ? y : y - fftH;
    const fyNorm = fy / halfH;

    for (let x = 0; x < fftW; x++) {
      const fx = x <= halfW ? x : x - fftW;
      const fxNorm = fx / halfW;

      // Skip DC and very low frequencies
      const r = Math.sqrt(fxNorm * fxNorm + fyNorm * fyNorm);
      if (r < 0.05) continue;

      // Taking |fx| and |fy| folds the spectrum into a single quadrant, so the
      // angle spans [0, π/2] — not [0, π). Dividing by π left the top 5 sectors
      // permanently empty and made the median a degenerate statistic.
      const angle = Math.atan2(Math.abs(fyNorm), Math.abs(fxNorm));
      const sectorIdx = Math.min(Math.floor((angle / (Math.PI / 2)) * numSectors), numSectors - 1);

      const mag = magnitude[y * fftW + x];
      sectorEnergy[sectorIdx] += mag * mag;
    }
  }

  // Compute max and median sector energy
  const sorted = Array.from(sectorEnergy).sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  const medianEnergy = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const maxEnergy = sorted[sorted.length - 1];

  if (medianEnergy <= 0) return null;

  const ratio = maxEnergy / medianEnergy;
  if (ratio <= t.directionalBlurRatioMax) return null;

  return {
    analyzer: 'directionalBlur',
    code: 'directional-blur',
    guidance: ISSUE_GUIDANCE['directional-blur'],
    message: `Directional blur detected (energy ratio ${ratio.toFixed(1)}, max ${t.directionalBlurRatioMax})`,
    value: ratio,
    threshold: t.directionalBlurRatioMax,
    penalty: 0.65,
    // Advisory: text is inherently anisotropic (horizontal baselines, vertical
    // stems), so a sharp page scores ~45 against a threshold of 4. The ratio is
    // still a useful ML feature; it is not a usable gate on its own.
    severity: 'advisory',
  };
}

// ── Text geometry (crumpled/folded document detection) ────────────

/** Connected component info extracted from binarized image */
interface CCComponent {
  area: number;
  /** Sum of x-coordinates of component pixels */
  sumX: number;
  /** Sum of y-coordinates of component pixels */
  sumY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  perimeter: number;
}

/** Find root of union-find with path compression */
function ufFind(parent: Int32Array, i: number): number {
  let r = i;
  while (parent[r] !== r) r = parent[r];
  // Path compression
  while (parent[i] !== r) {
    const next = parent[i];
    parent[i] = r;
    i = next;
  }
  return r;
}

/** Union two sets */
function ufUnion(parent: Int32Array, rank: Uint8Array, a: number, b: number): void {
  const ra = ufFind(parent, a);
  const rb = ufFind(parent, b);
  if (ra === rb) return;
  if (rank[ra] < rank[rb]) {
    parent[ra] = rb;
  } else if (rank[ra] > rank[rb]) {
    parent[rb] = ra;
  } else {
    parent[rb] = ra;
    rank[ra]++;
  }
}

/**
 * Analyze text geometry to detect crumpled/folded documents.
 * Uses connected component analysis on the binarized image to measure:
 * 1. Baseline straightness — text lines should be straight
 * 2. Character size consistency — same-font chars have consistent pixel areas
 * 3. Shape distortion — characters should have consistent circularity
 */
export function analyzeTextGeometry(ctx: AnalysisContext, t: Thresholds): Issue[] {
  const issues: Issue[] = [];

  if (!ctx.greyRaw) return issues;
  const { data, width, height } = ctx.greyRaw;

  // Guard: minimum image size
  if (width < 100 || height < 100) return issues;

  const totalPixels = width * height;

  // ── Binarize (dark=foreground) ────────────────────────────────
  const binary = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    binary[i] = data[i] < t.binarizationThreshold ? 1 : 0;
  }

  // ── Connected component labeling (2-pass union-find, 8-connectivity) ──
  const labels = new Int32Array(totalPixels);
  labels.fill(-1);
  const parent = new Int32Array(totalPixels);
  const rank = new Uint8Array(totalPixels);
  let nextLabel = 0;

  // Bail out if we see too many labels — the image is noise, not a document.
  // 50K isolated components is far beyond any real text document.
  const MAX_LABELS = 50_000;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (binary[idx] === 0) continue;

      // Check 8-connected neighbors (already visited: NW, N, NE, W)
      const neighbors: number[] = [];
      if (y > 0 && x > 0 && binary[(y - 1) * width + (x - 1)] === 1)
        neighbors.push(labels[(y - 1) * width + (x - 1)]);
      if (y > 0 && binary[(y - 1) * width + x] === 1)
        neighbors.push(labels[(y - 1) * width + x]);
      if (y > 0 && x < width - 1 && binary[(y - 1) * width + (x + 1)] === 1)
        neighbors.push(labels[(y - 1) * width + (x + 1)]);
      if (x > 0 && binary[y * width + (x - 1)] === 1)
        neighbors.push(labels[y * width + (x - 1)]);

      if (neighbors.length === 0) {
        // New component
        if (nextLabel >= MAX_LABELS) {
          // Too many labels — noisy image, bail out
          ctx.textGeometryMetrics = { baselineDeviation: 0, charSizeCV: 0, charShapeCV: 0 };
          return issues;
        }
        const lbl = nextLabel++;
        labels[idx] = lbl;
        parent[lbl] = lbl;
        rank[lbl] = 0;
      } else {
        // Find minimum root label among neighbors
        let minRoot = ufFind(parent, neighbors[0]);
        for (let i = 1; i < neighbors.length; i++) {
          const root = ufFind(parent, neighbors[i]);
          if (root < minRoot) minRoot = root;
        }
        labels[idx] = minRoot;
        // Union all neighbor labels
        for (const n of neighbors) {
          ufUnion(parent, rank, minRoot, n);
        }
      }
    }
  }

  // ── Second pass: resolve labels and collect component stats ──
  const compMap = new Map<number, CCComponent>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (labels[idx] < 0) continue;

      const root = ufFind(parent, labels[idx]);
      labels[idx] = root;

      let comp = compMap.get(root);
      if (!comp) {
        comp = {
          area: 0,
          sumX: 0,
          sumY: 0,
          minX: x,
          maxX: x,
          minY: y,
          maxY: y,
          perimeter: 0,
        };
        compMap.set(root, comp);
      }

      comp.area++;
      comp.sumX += x;
      comp.sumY += y;
      if (x < comp.minX) comp.minX = x;
      if (x > comp.maxX) comp.maxX = x;
      if (y < comp.minY) comp.minY = y;
      if (y > comp.maxY) comp.maxY = y;

      // Perimeter: count boundary pixels (any 4-neighbor is background or edge)
      const isEdge =
        x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
        binary[(y - 1) * width + x] === 0 ||
        binary[(y + 1) * width + x] === 0 ||
        binary[y * width + (x - 1)] === 0 ||
        binary[y * width + (x + 1)] === 0;
      if (isEdge) comp.perimeter++;
    }
  }

  // ── Filter to text-like components ───────────────────────────
  const minArea = Math.max(totalPixels * 0.000001, 4); // 0.0001% of image, min 4px
  const maxArea = totalPixels * 0.01;                   // 1%

  const textComps: CCComponent[] = [];
  for (const comp of compMap.values()) {
    if (comp.area < minArea || comp.area > maxArea) continue;
    const bw = comp.maxX - comp.minX + 1;
    const bh = comp.maxY - comp.minY + 1;
    const aspect = bw / (bh || 1);
    if (aspect < 0.1 || aspect > 10) continue;
    textComps.push(comp);
  }

  // Cap at 5000 components — beyond this the image is noisy, and sorting/CV
  // computation would be slow for no benefit. Keep the largest 5000 by area
  // (real characters tend to be larger than noise speckles).
  if (textComps.length > 5000) {
    textComps.sort((a, b) => b.area - a.area);
    textComps.length = 5000;
  }

  // Guard: need enough components for statistics
  if (textComps.length < 20) {
    // Store zero metrics so feature extraction doesn't recompute
    ctx.textGeometryMetrics = { baselineDeviation: 0, charSizeCV: 0, charShapeCV: 0 };
    return issues;
  }

  // ── Dominant size clustering ─────────────────────────────────
  // Histogram on log2(area), find mode bin, include components within 2x of mode
  const logAreas = textComps.map(c => Math.log2(c.area));
  let minLog = Infinity, maxLog = -Infinity;
  for (let i = 0; i < logAreas.length; i++) {
    if (logAreas[i] < minLog) minLog = logAreas[i];
    if (logAreas[i] > maxLog) maxLog = logAreas[i];
  }
  const logRange = maxLog - minLog;

  let dominantComps: CCComponent[];
  if (logRange < 0.01) {
    // All areas essentially identical — use all components
    dominantComps = textComps;
  } else {
    const numBins = Math.max(1, Math.ceil(logRange));
    const binSize = logRange / numBins;

    const bins = new Int32Array(numBins + 1);
    for (const la of logAreas) {
      const bin = Math.min(Math.floor((la - minLog) / binSize), numBins);
      bins[bin]++;
    }

    let modeBin = 0;
    for (let i = 1; i <= numBins; i++) {
      if (bins[i] > bins[modeBin]) modeBin = i;
    }

    const modeLogArea = minLog + (modeBin + 0.5) * binSize;
    const modeArea = Math.pow(2, modeLogArea);

    // Include components within 2x of mode area
    dominantComps = textComps.filter(c =>
      c.area >= modeArea / 2 && c.area <= modeArea * 2,
    );
  }

  if (dominantComps.length < 20) {
    ctx.textGeometryMetrics = { baselineDeviation: 0, charSizeCV: 0, charShapeCV: 0 };
    return issues;
  }

  // ── Signal 1: Baseline straightness ──────────────────────────
  // Cluster components into rows by centroid Y, fit lines, measure residuals
  // Remove global page skew first. Row clustering cuts on gaps in y, so on a
  // tilted page characters from neighbouring lines interleave, rows get mixed,
  // and the residual explodes — every tilted page read as "wavy text lines".
  // Deskewing separates tilt (already reported by analyzeSkew) from waviness.
  const skewTan = Math.tan(((ctx.skewAngle ?? 0) * Math.PI) / 180);
  const midX = width / 2;
  const centroids = dominantComps.map(c => {
    const cx = c.sumX / c.area;
    return {
      cx,
      cy: c.sumY / c.area - (cx - midX) * skewTan,
      comp: c,
    };
  });
  centroids.sort((a, b) => a.cy - b.cy);

  // Cluster into rows: components within rowGap of each other are same row
  // Use median area of dominant components for row gap estimation
  const sortedAreas = dominantComps.map(c => c.area).sort((a, b) => a - b);
  const medianArea = sortedAreas[sortedAreas.length >>> 1];
  const avgCharH = Math.sqrt(medianArea); // approximate character height
  const rowGap = Math.max(avgCharH * 1.5, 1); // floor of 1px prevents degenerate clustering

  const rows: Array<Array<{ cx: number; cy: number }>> = [];
  let currentRow: Array<{ cx: number; cy: number }> = [centroids[0]];

  for (let i = 1; i < centroids.length; i++) {
    if (centroids[i].cy - centroids[i - 1].cy > rowGap) {
      rows.push(currentRow);
      currentRow = [centroids[i]];
    } else {
      currentRow.push(centroids[i]);
    }
  }
  rows.push(currentRow);

  // For each row with 5+ components, fit least-squares line, measure residual
  let totalResidual = 0;
  let rowCount = 0;

  for (const row of rows) {
    if (row.length < 5) continue;
    const n = row.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of row) {
      sumX += p.cx;
      sumY += p.cy;
      sumXY += p.cx * p.cy;
      sumXX += p.cx * p.cx;
    }
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-10) continue;

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    // RMS residual
    let sumResidSq = 0;
    for (const p of row) {
      const predicted = slope * p.cx + intercept;
      const resid = p.cy - predicted;
      sumResidSq += resid * resid;
    }
    totalResidual += Math.sqrt(sumResidSq / n);
    rowCount++;
  }

  const baselineDeviation = rowCount > 0 ? (totalResidual / rowCount) / height : 0;

  // ── Signal 2: Character size consistency ─────────────────────
  const areas = dominantComps.map(c => c.area);
  const meanArea = areas.reduce((s, a) => s + a, 0) / areas.length;
  const areaVariance = areas.reduce((s, a) => s + (a - meanArea) ** 2, 0) / areas.length;
  const charSizeCV = meanArea > 0 ? Math.sqrt(areaVariance) / meanArea : 0;

  // ── Signal 3: Shape distortion (circularity) ─────────────────
  const circularities = dominantComps
    .filter(c => c.perimeter > 0)
    .map(c => (4 * Math.PI * c.area) / (c.perimeter * c.perimeter));

  let charShapeCV = 0;
  if (circularities.length >= 20) {
    const meanCirc = circularities.reduce((s, v) => s + v, 0) / circularities.length;
    const circVar = circularities.reduce((s, v) => s + (v - meanCirc) ** 2, 0) / circularities.length;
    charShapeCV = meanCirc > 0 ? Math.sqrt(circVar) / meanCirc : 0;
  }

  // Store metrics for feature extraction
  ctx.textGeometryMetrics = { baselineDeviation, charSizeCV, charShapeCV };

  // ── Emit issues ──────────────────────────────────────────────
  if (baselineDeviation > t.baselineDeviationMax) {
    issues.push({
      analyzer: 'textGeometry',
      code: 'wavy-text-lines',
      guidance: ISSUE_GUIDANCE['wavy-text-lines'],
      message: `Wavy text baselines (deviation ${(baselineDeviation * 100).toFixed(2)}% of height, max ${(t.baselineDeviationMax * 100).toFixed(2)}%)`,
      value: baselineDeviation,
      threshold: t.baselineDeviationMax,
      penalty: 0.6,
    });
  }

  if (charSizeCV > t.charSizeCVMax) {
    issues.push({
      analyzer: 'textGeometry',
      code: 'inconsistent-char-size',
      guidance: ISSUE_GUIDANCE['inconsistent-char-size'],
      message: `Inconsistent character sizes (CV ${charSizeCV.toFixed(2)}, max ${t.charSizeCVMax})`,
      value: charSizeCV,
      threshold: t.charSizeCVMax,
      penalty: 0.7,
    });
  }

  if (charShapeCV > t.charShapeCVMax) {
    issues.push({
      analyzer: 'textGeometry',
      code: 'distorted-char-shapes',
      guidance: ISSUE_GUIDANCE['distorted-char-shapes'],
      message: `Distorted character shapes (circularity CV ${charShapeCV.toFixed(2)}, max ${t.charShapeCVMax})`,
      value: charShapeCV,
      threshold: t.charShapeCVMax,
      penalty: 0.65,
      // Advisory: circularity varies by letter ('i' vs 'o' vs 'm') and by
      // resolution. Clean scans measure 0.21, 0.39 and 0.41 against a 0.4 limit
      // — the gate is a coin flip. Baseline deviation and size CV keep their
      // margins and stay as gates; this one is a feature only.
      severity: 'advisory',
    });
  }

  return issues;
}

export function analyzeFFTJpegArtifact(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (ctx.sharpMeta?.format !== 'jpeg') return null;
  // Prefer native-resolution pixels: the 8x8 JPEG grid is destroyed by the
  // analysis downscale, which made this analyzer return 0.000 for every image
  // wider than analysisMaxPx — i.e. every phone photo.
  const src = ctx.fullResGrey ?? ctx.greyRaw;
  if (!src) return null;
  const blockiness = jpegBlockiness(src.data, src.width, src.height);
  ctx.jpegBlockiness = blockiness; // analyzeCompression corroborates against this
  if (blockiness <= t.fftJpegGridMax) return null;
  return {
    analyzer: 'fftJpegArtifact',
    code: 'jpeg-artifacts',
    guidance: ISSUE_GUIDANCE['jpeg-artifacts'],
    message: `JPEG block artifacts detected (blockiness ${blockiness.toFixed(3)}, maximum ${t.fftJpegGridMax})`,
    value: blockiness,
    threshold: t.fftJpegGridMax,
    penalty: gradedPenalty(0.8, t.fftJpegGridMax > 0 ? blockiness / t.fftJpegGridMax : SEVERITY_CAP),
  };
}

// ── Text-line legibility (deep mode) ─────────────────────────────

/**
 * Measure whether the text on the page can actually be read.
 *
 * Every other analyzer describes the page. This one describes the words:
 * how tall the lowercase body is in pixels, how thick the strokes are, and
 * how far the ink separates from the paper. Those quantities are what OCR
 * accuracy depends on, and each maps to something a user can do — move
 * closer, rescan at a higher DPI, hold the camera still, add light.
 *
 * Needs native-resolution pixels; the analysis downscale would erase the
 * detail being measured.
 */
export function analyzeTextLegibility(ctx: AnalysisContext, t: Thresholds): Issue[] {
  const issues: Issue[] = [];
  const source = ctx.fullResGrey ?? ctx.greyRaw;
  if (!source) return issues;

  const floors = {
    xHeightMin: t.textXHeightMin,
    strokeWidthMin: t.textStrokeWidthMin,
    contrastMin: t.textLineContrastMin,
    strokeSharpnessMin: t.textStrokeSharpnessMin,
  };
  const skew = ctx.skewAngle ?? 0;

  // The crop first: it is the page, and where it works it is the cleaner
  // surface. Where it does not, the frame it was cut from usually does — the
  // threshold that failed to separate print from paper inside a cropped ID card
  // separates the card from the desk perfectly well one level out. The two
  // never both work, so this is a fallback and not a choice between answers.
  let metrics = analyzeTextLines(source.data, source.width, source.height, skew, floors);
  let measuredOn: 'page' | 'frame' = 'page';
  if ((!metrics || !metrics.reliable) && ctx.uncroppedGrey) {
    const frame = ctx.uncroppedGrey;
    const fromFrame = analyzeTextLines(frame.data, frame.width, frame.height, skew, floors);
    if (fromFrame?.reliable) {
      metrics = fromFrame;
      measuredOn = 'frame';
    }
  }
  if (!metrics) return issues;

  ctx.textLineMetrics = metrics;
  const surface = measuredOn === 'frame' ? ', measured on the uncropped frame' : '';

  // Otsu split the frame, not the page. Whatever the medians say, they describe
  // a mis-segmentation, and on the worst inputs they say the text is excellent:
  // a page at 20% of a 3000x4000 frame came back as one 800px-tall "line" with
  // nothing illegible. Reporting that as legible is the false pass this guard
  // exists to stop, so say the text could not be read instead of guessing.
  //
  // Advisory, not an error. "Could not measure" is not evidence of a bad page —
  // a sparse form or a card legitimately has too few lines — and scoring it as
  // a fault would reject good documents for being sparse. It reaches the caller
  // and the feature vector, where a trained model can weigh it properly.
  if (!metrics.reliable) {
    issues.push({
      analyzer: 'textLines',
      code: 'text-unmeasurable',
      guidance: ISSUE_GUIDANCE['text-unmeasurable'],
      message:
        `Text could not be measured (${metrics.lineCount} line(s) found, ` +
        `median x-height ${metrics.medianXHeight.toFixed(1)}px against a ` +
        `${source.height}px page — ink did not separate from paper` +
        `${ctx.uncroppedGrey ? ', on the page or on the frame around it' : ''})`,
      value: metrics.lineCount,
      threshold: 3,
      penalty: 1,
      severity: 'advisory',
    });
    return issues;
  }

  if (metrics.medianXHeight < t.textXHeightMin) {
    issues.push({
      analyzer: 'textLines',
      code: 'text-too-small',
      guidance: ISSUE_GUIDANCE['text-too-small'],
      message:
        `Text too small to read (median x-height ${metrics.medianXHeight.toFixed(1)}px, ` +
        `minimum ${t.textXHeightMin}px, across ${metrics.lineCount} lines${surface})`,
      value: metrics.medianXHeight,
      threshold: t.textXHeightMin,
      penalty: gradedPenalty(
        0.55,
        metrics.medianXHeight > 0 ? t.textXHeightMin / metrics.medianXHeight : SEVERITY_CAP,
      ),
    });
  }

  if (metrics.illegibleFraction > t.textIllegibleFractionMax) {
    const illegibleLines = Math.round(metrics.illegibleFraction * metrics.lineCount);
    issues.push({
      analyzer: 'textLines',
      code: 'illegible-text',
      guidance: ISSUE_GUIDANCE['illegible-text'],
      message:
        `${illegibleLines} of ${metrics.lineCount} text lines are not legible ` +
        `(${(metrics.illegibleFraction * 100).toFixed(0)}%, maximum ` +
        `${(t.textIllegibleFractionMax * 100).toFixed(0)}%${surface})`,
      value: metrics.illegibleFraction,
      threshold: t.textIllegibleFractionMax,
      penalty: gradedPenalty(
        0.6,
        t.textIllegibleFractionMax > 0
          ? metrics.illegibleFraction / t.textIllegibleFractionMax
          : SEVERITY_CAP,
      ),
    });
  }

  return issues;
}
