import type { AnalysisContext, Issue, Thresholds } from './types.js';
import { highFreqEnergyRatio, countSpectralPeaks, jpegBlockiness } from './fft-core.js';
import { ISSUE_GUIDANCE } from './guidance.js';

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
    penalty: 0.5,
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
      penalty: 0.6,
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
    penalty: 0.5,
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
      penalty: 0.6,
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
      penalty: 0.6,
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
    penalty: 0.65,
  };
}

// ── DPI (from metadata) ──────────────────────────────────────────

/** Camera-default DPI values — meaningless metadata, not real scanner DPI */
const CAMERA_DEFAULT_DPI = new Set([72, 96]);

export function analyzeDpi(ctx: AnalysisContext, t: Thresholds): Issue | null {
  const dpi = ctx.sharpMeta?.density;
  if (!dpi || dpi <= 0) return null; // No DPI metadata — skip
  if (CAMERA_DEFAULT_DPI.has(dpi)) return null; // Camera default — skip
  if (dpi >= t.dpiMin) return null;
  return {
    analyzer: 'dpi',
    code: 'low-dpi',
    guidance: ISSUE_GUIDANCE['low-dpi'],
    message: `Low DPI (${dpi}, minimum ${t.dpiMin})`,
    value: dpi,
    threshold: t.dpiMin,
    penalty: 0.7,
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
  const totalPixels = ctx.metadata.width * ctx.metadata.height;
  if (totalPixels === 0) return null;
  const bpp = (ctx.originalBuffer.length * 8) / totalPixels;
  if (bpp >= t.compressionBppMin) return null;
  return {
    analyzer: 'compression',
    code: 'heavy-compression',
    guidance: ISSUE_GUIDANCE['heavy-compression'],
    message: `Heavy JPEG compression (${bpp.toFixed(2)} bpp, minimum ${t.compressionBppMin})`,
    value: bpp,
    threshold: t.compressionBppMin,
    penalty: 0.7,
  };
}

// ── Shadow detection (dark edges vs center) ──────────────────────

export function analyzeShadow(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.greyRaw || ctx.greyRaw.height < 20 || ctx.greyRaw.width < 20) return null;

  const { data, width, height } = ctx.greyRaw;
  const stripSize = Math.max(1, Math.floor(Math.min(width, height) * 0.1));

  // Average brightness of 10% edge strips (top, bottom, left, right)
  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y < stripSize || y >= height - stripSize || x < stripSize || x >= width - stripSize) {
        edgeSum += data[y * width + x];
        edgeCount++;
      }
    }
  }

  // Average brightness of center region
  const cx0 = Math.floor(width * 0.3);
  const cx1 = Math.floor(width * 0.7);
  const cy0 = Math.floor(height * 0.3);
  const cy1 = Math.floor(height * 0.7);
  let centerSum = 0;
  let centerCount = 0;
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      centerSum += data[y * width + x];
      centerCount++;
    }
  }

  if (edgeCount === 0 || centerCount === 0) return null;

  const edgeMean = edgeSum / edgeCount;
  const centerMean = centerSum / centerCount;
  const diff = centerMean - edgeMean; // Positive = edges darker than center

  if (diff <= t.shadowBrightnessDiff) return null;

  return {
    analyzer: 'shadow',
    code: 'shadow-on-edges',
    guidance: ISSUE_GUIDANCE['shadow-on-edges'],
    message: `Shadow detected at edges (brightness diff ${diff.toFixed(0)}, max ${t.shadowBrightnessDiff})`,
    value: diff,
    threshold: t.shadowBrightnessDiff,
    penalty: 0.7,
  };
}

// ── Skew detection (edge pixel center-of-mass regression) ────────

export function analyzeSkew(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.laplacian || ctx.laplacian.width < 20 || ctx.laplacian.height < 20) return null;

  const { data, width, height } = ctx.laplacian;
  const numStrips = Math.min(20, width);
  const stripWidth = Math.floor(width / numStrips);

  // For each vertical strip, compute center-of-mass of edge pixels (>30)
  const xs: number[] = [];
  const ys: number[] = [];

  for (let s = 0; s < numStrips; s++) {
    const x0 = s * stripWidth;
    const x1 = Math.min(x0 + stripWidth, width);
    let weightedY = 0;
    let totalWeight = 0;
    for (let y = 0; y < height; y++) {
      for (let x = x0; x < x1; x++) {
        const v = data[y * width + x];
        if (v > 30) {
          weightedY += y * v;
          totalWeight += v;
        }
      }
    }
    if (totalWeight > 0) {
      xs.push((x0 + x1) / 2);
      ys.push(weightedY / totalWeight);
    }
  }

  if (xs.length < 3) return null;

  // Linear regression: y = mx + b → slope m → angle = atan(m * aspectRatio)
  const n = xs.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumXX += xs[i] * xs[i];
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return null;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const angleDeg = Math.abs(Math.atan(slope) * (180 / Math.PI));

  if (angleDeg <= t.skewAngleMax) return null;

  return {
    analyzer: 'skew',
    code: 'tilted',
    guidance: ISSUE_GUIDANCE['tilted'],
    message: `Document appears skewed (${angleDeg.toFixed(1)}°, max ${t.skewAngleMax}°)`,
    value: angleDeg,
    threshold: t.skewAngleMax,
    penalty: 0.85,
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
  };
}

// ── Moiré pattern detection (autocorrelation on laplacian rows) ──

/** @deprecated Use analyzeFFTMoire instead */
export function analyzeMoire(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.laplacian || ctx.laplacian.width < 60 || ctx.laplacian.height < 20) return null;

  const { data, width, height } = ctx.laplacian;

  // Sample up to 20 rows evenly spaced
  const sampleRows = Math.min(20, height);
  const rowStep = Math.max(1, Math.floor(height / sampleRows));

  let maxCorrelation = 0;

  for (let r = 0; r < sampleRows; r++) {
    const y = r * rowStep;
    if (y >= height) break;

    const rowOffset = y * width;

    // Compute row mean
    let rowSum = 0;
    for (let x = 0; x < width; x++) rowSum += data[rowOffset + x];
    const rowMean = rowSum / width;

    // Compute variance
    let rowVar = 0;
    for (let x = 0; x < width; x++) {
      const d = data[rowOffset + x] - rowMean;
      rowVar += d * d;
    }
    rowVar /= width;
    if (rowVar < 1) continue; // Flat row — skip

    // Autocorrelation at lags 4–50
    for (let lag = 4; lag <= Math.min(50, Math.floor(width / 2)); lag++) {
      let cov = 0;
      const n = width - lag;
      for (let x = 0; x < n; x++) {
        cov += (data[rowOffset + x] - rowMean) * (data[rowOffset + x + lag] - rowMean);
      }
      const corr = cov / (n * rowVar);
      if (corr > maxCorrelation) maxCorrelation = corr;
    }
  }

  if (maxCorrelation <= t.moireCorrelationMax) return null;

  return {
    analyzer: 'moire',
    code: 'moire-pattern',
    guidance: ISSUE_GUIDANCE['moire-pattern'],
    message: `Moiré pattern detected (correlation ${maxCorrelation.toFixed(2)}, max ${t.moireCorrelationMax})`,
    value: maxCorrelation,
    threshold: t.moireCorrelationMax,
    penalty: 0.7,
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
    penalty: 0.6,
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
  };
}

// ── Dim background detection ────────────────────────────────────

/**
 * Detect dim document background. Uses 90th percentile brightness of greyscale
 * data — the brightest region (paper) should be reasonably white.
 * Fires when even the brightest areas are dim, indicating poor lighting.
 */
export function analyzeDimBackground(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.greyRaw || ctx.greyRaw.width < 20 || ctx.greyRaw.height < 20) return null;

  const { data } = ctx.greyRaw;

  // Build histogram to find p90
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;

  const target = Math.floor(data.length * 0.9);
  let cumul = 0;
  let p90 = 0;
  for (let i = 0; i < 256; i++) {
    cumul += hist[i];
    if (cumul >= target) { p90 = i; break; }
  }

  if (p90 >= t.backgroundP90Min) return null;

  return {
    analyzer: 'dimBackground',
    code: 'dim-background',
    guidance: ISSUE_GUIDANCE['dim-background'],
    message: `Document background too dim (p90 brightness ${p90}, minimum ${t.backgroundP90Min})`,
    value: p90,
    threshold: t.backgroundP90Min,
    penalty: 0.75,
  };
}

/**
 * Enhanced shadow detection — catches moderate shadows on already-dim documents.
 * The standard shadow analyzer requires a large edge-center brightness difference (60+).
 * This catches the harder case: moderate shadow (diff 20-40) where the center is
 * also dim (< 150), indicating the entire document is poorly lit with uneven shadow.
 */
export function analyzeDarkShadow(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.greyRaw || ctx.greyRaw.height < 20 || ctx.greyRaw.width < 20) return null;

  const { data, width, height } = ctx.greyRaw;
  const stripSize = Math.max(1, Math.floor(Math.min(width, height) * 0.1));

  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y < stripSize || y >= height - stripSize || x < stripSize || x >= width - stripSize) {
        edgeSum += data[y * width + x];
        edgeCount++;
      }
    }
  }

  const cx0 = Math.floor(width * 0.3);
  const cx1 = Math.floor(width * 0.7);
  const cy0 = Math.floor(height * 0.3);
  const cy1 = Math.floor(height * 0.7);
  let centerSum = 0;
  let centerCount = 0;
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      centerSum += data[y * width + x];
      centerCount++;
    }
  }

  if (edgeCount === 0 || centerCount === 0) return null;

  const centerMean = centerSum / centerCount;
  const edgeMean = edgeSum / edgeCount;
  const diff = centerMean - edgeMean;

  // Compound check: moderate shadow + dim center content area
  if (centerMean >= t.darkShadowCenterMax || diff <= t.darkShadowDiffMin) return null;

  return {
    analyzer: 'shadow',
    code: 'dark-shadow',
    guidance: ISSUE_GUIDANCE['dark-shadow'],
    message: `Dark shadow on dim document (center brightness ${centerMean.toFixed(0)}, edge-center diff ${diff.toFixed(0)})`,
    value: diff,
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

  // Brightness check: max spread across quadrants
  const maxBright = Math.max(...zoneBrightness);
  const minBright = Math.min(...zoneBrightness);
  const brightDiff = maxBright - minBright;

  // Sharpness check: ratio of weakest to strongest
  const maxSharp = Math.max(...zoneSharpness);
  const minSharp = Math.min(...zoneSharpness);
  const sharpRatio = maxSharp > 0 ? minSharp / maxSharp : 1;

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
      penalty: 0.7,
    };
  }

  return {
    analyzer: 'zoneQuality',
    code: 'uneven-zone-sharpness',
    guidance: ISSUE_GUIDANCE['uneven-zone-sharpness'],
    message: `Uneven zone sharpness (ratio ${sharpRatio.toFixed(2)}, min ${t.zoneSharpnessMinRatio})`,
    value: sharpRatio,
    threshold: t.zoneSharpnessMinRatio,
    penalty: 0.7,
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

      // Compute angle [0, π) — we fold into half-circle since spectrum is symmetric
      let angle = Math.atan2(Math.abs(fyNorm), Math.abs(fxNorm));
      // Map to sector index [0, numSectors)
      const sectorIdx = Math.min(Math.floor((angle / Math.PI) * numSectors), numSectors - 1);

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
  };
}

export function analyzeFFTJpegArtifact(ctx: AnalysisContext, t: Thresholds): Issue | null {
  if (!ctx.greyRaw || ctx.sharpMeta?.format !== 'jpeg') return null;
  const blockiness = jpegBlockiness(ctx.greyRaw.data, ctx.greyRaw.width, ctx.greyRaw.height);
  if (blockiness <= t.fftJpegGridMax) return null;
  return {
    analyzer: 'fftJpegArtifact',
    code: 'jpeg-artifacts',
    guidance: ISSUE_GUIDANCE['jpeg-artifacts'],
    message: `JPEG block artifacts detected (blockiness ${blockiness.toFixed(3)}, maximum ${t.fftJpegGridMax})`,
    value: blockiness,
    threshold: t.fftJpegGridMax,
    penalty: 0.8,
  };
}
