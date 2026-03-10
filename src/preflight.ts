import type { IssueCode } from './types.js';
import { ISSUE_GUIDANCE } from './guidance.js';
import { extractPreflightFeatures } from './preflight-features.js';
import type { PreflightFeatureVector } from './preflight-features.js';

// ── Public types ─────────────────────────────────────────────────

export interface PreflightOptions {
  /** Thumbnail size for analysis (default: 200). Smaller = faster. */
  thumbnailSize?: number;
  /** Override preflight thresholds */
  thresholds?: Partial<PreflightThresholds>;
  /** Custom scorer for ML-based preflight scoring */
  scorer?: (features: PreflightFeatureVector) => number;
}

export interface PreflightResult {
  pass: boolean;
  /** ML model score (only present when scorer is used) */
  score?: number;
  issues: PreflightIssue[];
  metadata: { width: number; height: number; fileSize: number };
  timing: { totalMs: number };
}

export interface PreflightIssue {
  code: IssueCode;
  message: string;
  guidance: string;
}

export interface PreflightThresholds {
  resolutionMin: number;   // megapixels
  resolutionMax: number;   // megapixels
  fileSizeMin: number;     // bytes
  fileSizeMax: number;     // bytes
  brightnessMin: number;   // 0-255, mean across channels
  brightnessMax: number;   // 0-255
  sharpnessMin: number;    // laplacian stdev
  blankStdevMax: number;   // max channel stdev
  edgeDensityMin: number;  // ratio of edge pixels
  contrastFgMin: number;   // foreground ratio after binarization
  laplacianEdgeThreshold: number; // magnitude threshold for counting edge pixels
  binarizationThreshold: number;  // greyscale threshold for text binarization
}

/**
 * Preflight thresholds — slightly more lenient than the full backend defaults
 * to ensure the monotonic guarantee (if preflight rejects, backend also rejects).
 *
 * Most checks use tight margins (7-15%) since Canvas vs sharp pixel differences
 * are small for global statistics. Sharpness and edge density need wider margins
 * because preflight analyzes at 200px while the backend analyzes at 1500px —
 * the Laplacian produces ~0.3-0.4x the stdev at lower resolution.
 */
export const PREFLIGHT_DEFAULTS: PreflightThresholds = {
  resolutionMin: 0.28,          // Full: 0.3   →  7% margin (dimension check is exact)
  resolutionMax: 220,           // Full: 200   → 10% margin (dimension check is exact)
  fileSizeMin: 13500,           // Full: 15000 → 10% margin (byte count is exact)
  fileSizeMax: 110_000_000,     // Full: 100MB → 10% margin (byte count is exact)
  brightnessMin: 45,            // Full: 50    → 10% margin
  brightnessMax: 247,           // Full: 245   → 2pt margin
  sharpnessMin: 5,              // Full: 15    → wider margin: 200px thumbnail loses fine detail
  blankStdevMax: 1.7,           // Full: 2.0   → 15% margin
  edgeDensityMin: 0.005,        // Full: 0.015 → wider margin: 200px thumbnail loses fine edges
  contrastFgMin: 0.008,         // Full: 0.01  → 20% margin
  laplacianEdgeThreshold: 30,   // Same as backend — magnitude threshold for edge pixels
  binarizationThreshold: 128,   // Same as backend — greyscale binarization cutoff
};

// ── Canvas helpers ───────────────────────────────────────────────

async function decodeImage(
  input: Blob | File | ImageBitmap | HTMLImageElement,
): Promise<ImageBitmap> {
  if (input instanceof ImageBitmap) return input;
  if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
    if (!input.complete || input.naturalWidth === 0) {
      throw new Error('HTMLImageElement must be fully loaded');
    }
    return createImageBitmap(input);
  }
  if (typeof createImageBitmap === 'undefined') {
    throw new Error('doc-quality/preflight requires a browser environment (createImageBitmap not found)');
  }
  return createImageBitmap(input as Blob);
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error('doc-quality/preflight requires a browser environment');
}

function fitInside(srcW: number, srcH: number, max: number): { w: number; h: number } {
  if (srcW <= max && srcH <= max) return { w: Math.max(1, srcW), h: Math.max(1, srcH) };
  const scale = Math.min(max / srcW, max / srcH);
  return { w: Math.max(1, Math.round(srcW * scale)), h: Math.max(1, Math.round(srcH * scale)) };
}

function toGreyscale(rgba: Uint8ClampedArray, count: number): Uint8Array {
  const grey = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const off = i * 4;
    grey[i] = Math.round(0.2989 * rgba[off] + 0.5870 * rgba[off + 1] + 0.1140 * rgba[off + 2]);
  }
  return grey;
}

function laplacian3x3(grey: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const sum =
        -grey[(y - 1) * w + (x - 1)] - grey[(y - 1) * w + x] - grey[(y - 1) * w + (x + 1)]
        - grey[y * w + (x - 1)] + 8 * grey[y * w + x] - grey[y * w + (x + 1)]
        - grey[(y + 1) * w + (x - 1)] - grey[(y + 1) * w + x] - grey[(y + 1) * w + (x + 1)];
      out[y * w + x] = Math.min(255, Math.max(0, sum));
    }
  }
  return out;
}

// ── Main function ────────────────────────────────────────────────

/**
 * Fast browser-side quality preflight check.
 *
 * Monotonic guarantee: if preflight rejects, the full `checkQuality()` will
 * also reject. If preflight passes, `checkQuality()` may still reject.
 *
 * @param input - Image as Blob, File, ImageBitmap, or loaded HTMLImageElement
 * @param options - Optional thumbnail size and threshold overrides
 * @returns Preflight result with pass/fail, issues, metadata, and timing
 */
export async function preflight(
  input: Blob | File | ImageBitmap | HTMLImageElement,
  options?: PreflightOptions,
): Promise<PreflightResult> {
  const t0 = performance.now();
  const thumbSize = options?.thumbnailSize ?? 200;
  const t: PreflightThresholds = { ...PREFLIGHT_DEFAULTS, ...options?.thresholds };
  const issues: PreflightIssue[] = [];

  // File size checks (no decoding needed)
  const fileSize = (input instanceof Blob) ? input.size : 0;
  if (input instanceof Blob && fileSize < t.fileSizeMin) {
    issues.push(makeIssue('file-too-small', `File size ${fileSize} bytes is below minimum ${t.fileSizeMin}`));
  }
  if (input instanceof Blob && fileSize > t.fileSizeMax) {
    issues.push(makeIssue('file-too-large', `File size ${(fileSize / 1_000_000).toFixed(1)} MB exceeds maximum ${(t.fileSizeMax / 1_000_000).toFixed(0)} MB`));
  }

  // Decode to ImageBitmap for dimensions
  const bmp = await decodeImage(input);
  const ownsBitmap = !(input instanceof ImageBitmap);

  try {
    const { width, height } = bmp;

    // Resolution checks (no pixel access needed)
    const megapixels = (width * height) / 1_000_000;
    if (megapixels < t.resolutionMin) {
      issues.push(makeIssue('low-resolution', `Resolution ${width}×${height} (${megapixels.toFixed(3)} MP) is below minimum ${t.resolutionMin} MP`));
    }
    if (megapixels > t.resolutionMax) {
      issues.push(makeIssue('resolution-too-high', `Resolution ${width}×${height} (${megapixels.toFixed(1)} MP) exceeds maximum ${t.resolutionMax} MP`));
    }

    // If resolution is too low, skip pixel analysis — nothing useful to measure
    // Hoisted stats for ML scorer
    let meanBrightness = NaN;
    let maxChannelStdev = NaN;
    let lapStdev = NaN;
    let edgeDensity = NaN;
    let foregroundRatio = NaN;
    let maxStdev = NaN;

    if (megapixels >= t.resolutionMin) {
      // Draw to thumbnail canvas
      const { w, h } = fitInside(width, height, thumbSize);
      const canvas = makeCanvas(w, h);
      const ctx = (canvas as OffscreenCanvas).getContext('2d', { willReadFrequently: true }) as
        OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
      if (!ctx) throw new Error('Failed to get 2d context');

      // White background (for transparency)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);

      const imageData = ctx.getImageData(0, 0, w, h);
      const rgba = imageData.data;
      const pixelCount = w * h;

      // ── Single pass: channel stats (brightness + blank page) ──
      let sumR = 0, sumG = 0, sumB = 0;
      let sumR2 = 0, sumG2 = 0, sumB2 = 0;

      for (let i = 0; i < pixelCount; i++) {
        const off = i * 4;
        const r = rgba[off], g = rgba[off + 1], b = rgba[off + 2];
        sumR += r; sumG += g; sumB += b;
        sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
      }

      const meanR = sumR / pixelCount;
      const meanG = sumG / pixelCount;
      const meanB = sumB / pixelCount;
      meanBrightness = (meanR + meanG + meanB) / 3;

      // Brightness checks
      if (meanBrightness < t.brightnessMin) {
        issues.push(makeIssue('too-dark', `Mean brightness ${meanBrightness.toFixed(1)} is below minimum ${t.brightnessMin}`));
      }
      if (meanBrightness > t.brightnessMax) {
        issues.push(makeIssue('overexposed', `Mean brightness ${meanBrightness.toFixed(1)} exceeds maximum ${t.brightnessMax}`));
      }

      // Blank page check — max stdev across channels
      // Math.max(0, ...) guards against float imprecision producing tiny negatives
      const stdevR = Math.sqrt(Math.max(0, sumR2 / pixelCount - meanR * meanR));
      const stdevG = Math.sqrt(Math.max(0, sumG2 / pixelCount - meanG * meanG));
      const stdevB = Math.sqrt(Math.max(0, sumB2 / pixelCount - meanB * meanB));
      maxStdev = Math.max(stdevR, stdevG, stdevB);
      maxChannelStdev = maxStdev;

      if (maxStdev < t.blankStdevMax) {
        issues.push(makeIssue('blank-page', `Channel stdev ${maxStdev.toFixed(2)} indicates a blank/uniform page`));
      }

      // ── Greyscale + Laplacian ──
      const grey = toGreyscale(rgba, pixelCount);
      const lap = laplacian3x3(grey, w, h);

      // Sharpness — Laplacian stdev (skip 1px border)
      let lapSum = 0, lapSum2 = 0, lapCount = 0;
      let edgePixels = 0;

      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const v = lap[y * w + x];
          lapSum += v;
          lapSum2 += v * v;
          lapCount++;
          if (v > t.laplacianEdgeThreshold) edgePixels++;
        }
      }

      if (lapCount > 0) {
        const lapMean = lapSum / lapCount;
        lapStdev = Math.sqrt(Math.max(0, lapSum2 / lapCount - lapMean * lapMean));

        if (lapStdev < t.sharpnessMin) {
          issues.push(makeIssue('blurry', `Laplacian stdev ${lapStdev.toFixed(2)} is below minimum ${t.sharpnessMin}`));
        }

        // Edge density
        edgeDensity = edgePixels / lapCount;
        if (edgeDensity < t.edgeDensityMin) {
          issues.push(makeIssue('low-edge-density', `Edge density ${edgeDensity.toFixed(4)} is below minimum ${t.edgeDensityMin}`));
        }
      }

      // ── Contrast — binarize at threshold, count dark pixels ──
      let darkPixels = 0;
      for (let i = 0; i < pixelCount; i++) {
        if (grey[i] < t.binarizationThreshold) darkPixels++;
      }
      foregroundRatio = darkPixels / pixelCount;
      if (foregroundRatio < t.contrastFgMin) {
        issues.push(makeIssue('low-contrast', `Foreground ratio ${foregroundRatio.toFixed(4)} is below minimum ${t.contrastFgMin}`));
      }
    }

    // ML scorer path — wrapped in try/catch so a broken model never kills preflight
    if (options?.scorer) {
      try {
        const features = extractPreflightFeatures({
          megapixels, fileSize, meanBrightness, maxChannelStdev,
          laplacianStdev: lapStdev, edgeDensity, foregroundRatio, maxStdev,
        });
        const raw = options.scorer(features);
        // Validate: must be a finite number; clamp to [0, 1]
        if (Number.isFinite(raw)) {
          const mlScore = Math.max(0, Math.min(1, raw));
          return {
            pass: mlScore >= 0.5,
            score: mlScore,
            issues,
            metadata: { width, height, fileSize },
            timing: { totalMs: Math.round(performance.now() - t0) },
          };
        }
        // Non-finite result — fall through to default issue-based scoring
      } catch {
        // Scorer threw — fall through to default issue-based scoring
      }
    }

    return {
      pass: issues.length === 0,
      issues,
      metadata: { width, height, fileSize },
      timing: { totalMs: Math.round(performance.now() - t0) },
    };
  } finally {
    // Release GPU-backed ImageBitmap if we created it
    if (ownsBitmap) bmp.close();
  }
}

function makeIssue(code: IssueCode, message: string): PreflightIssue {
  return { code, message, guidance: ISSUE_GUIDANCE[code] };
}
