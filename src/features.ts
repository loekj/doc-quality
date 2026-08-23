import type { AnalysisContext, Mode } from './types.js';
import type { ConcretePreset } from './defaults.js';
import { DEFAULT_THRESHOLDS } from './defaults.js';
import { highFreqEnergyRatio, countSpectralPeaks, jpegBlockiness } from './fft-core.js';
import { estimateSkewAngle } from './analyzers.js';

export interface FeatureVector {
  readonly names: readonly string[];
  readonly values: Float64Array;
}

export const FEATURE_NAMES: readonly string[] = [
  // Fast-mode features (0-14) — always available
  'megapixels', 'width', 'height', 'aspectRatio', 'fileSize',
  'bpp', 'brightnessAvg', 'brightnessStdevMax',
  'laplacianStdev', 'laplacianMean', 'laplacianVariance', 'edgeRatio',
  'dpi', 'isJpeg', 'presetIdx',
  // Thorough-only features (15-41) — NaN in fast mode
  'foregroundRatio',
  'sharpnessRatioTopBot', 'brightnessDiffTopBot',
  'shadowEdgeCenterDiff', 'centerBrightness', 'edgeBrightness',
  'backgroundP90', 'skewAngle', 'colorSaturation',
  'fftHighFreqRatio', 'fftSpectralPeaks', 'fftJpegBlockiness',
  'zoneBrightnessDiff', 'zoneSharpnessRatio', 'directionalEnergyRatio',
  'zoneBrightness0', 'zoneBrightness1', 'zoneBrightness2', 'zoneBrightness3',
  'zoneSharpness0', 'zoneSharpness1', 'zoneSharpness2', 'zoneSharpness3',
  'channelCount',
  'textBaselineDeviation', 'textCharSizeCV', 'textCharShapeCV',
  // Deep-mode features (42-47) — NaN unless mode is 'deep'
  'textLineCount', 'textMedianXHeight', 'textMedianStrokeWidth',
  'textMedianLineContrast', 'textMedianStrokeSharpness', 'textIllegibleFraction',
  // Signed-Laplacian features (48-51) — thorough and deep only; NaN in fast
  // mode, which keeps libvips' cheaper clipped convolve.
  // Appended, not inserted: trained models address features by index, and the
  // fast model's columns must stay exactly positions 0-14 for those indices to
  // line up at inference. See the position-stability test in features.test.ts.
  'laplacianSignedStdev', 'laplacianSignedMeanAbs',
  'laplacianSignedEdgeRatio', 'laplacianSaturationRatio',
] as const;

const PRESET_INDEX: Record<string, number> = { document: 0, receipt: 1, card: 2 };

/**
 * Extract a feature vector from a populated AnalysisContext.
 * No Sharp calls — reads existing buffers only.
 */
export function extractFeatures(
  ctx: AnalysisContext,
  mode: Mode,
  preset: ConcretePreset,
  foregroundRatio?: number,
): FeatureVector {
  const values = new Float64Array(FEATURE_NAMES.length);
  values.fill(NaN);

  const { width, height } = ctx.metadata;
  const megapixels = (width * height) / 1_000_000;
  const fileSize = ctx.originalBuffer.length;
  const totalPixels = width * height;
  const isJpeg = (ctx.sharpMeta?.format === 'jpeg') ? 1 : 0;
  const bpp = totalPixels > 0 ? (fileSize * 8) / totalPixels : 0;

  // Brightness stats
  let brightnessAvg = NaN;
  let brightnessStdevMax = NaN;
  if (ctx.stats && ctx.stats.channels.length > 0) {
    brightnessAvg = ctx.stats.channels.reduce((s, ch) => s + ch.mean, 0) / ctx.stats.channels.length;
    brightnessStdevMax = Math.max(...ctx.stats.channels.map(ch => ch.stdev));
  }

  // Laplacian stats
  let laplacianStdev = NaN;
  let laplacianMean = NaN;
  let laplacianVariance = NaN;
  let edgeRatio = NaN;
  if (ctx.laplacian) {
    laplacianStdev = ctx.laplacian.stdev;
    laplacianMean = ctx.laplacian.mean;
    laplacianVariance = ctx.laplacian.variance;
    edgeRatio = ctx.laplacian.length > 0
      ? ctx.laplacian.edgeCount / ctx.laplacian.length
      : NaN;
  }

  const dpi = ctx.sharpMeta?.density ?? NaN;

  // Fast-mode features (0-14)
  values[0] = megapixels;
  values[1] = width;
  values[2] = height;
  values[3] = width / (height || 1);
  values[4] = fileSize;
  values[5] = bpp;
  values[6] = brightnessAvg;
  values[7] = brightnessStdevMax;
  values[8] = laplacianStdev;
  values[9] = laplacianMean;
  values[10] = laplacianVariance;
  values[11] = edgeRatio;
  values[12] = dpi;
  values[13] = isJpeg;
  values[14] = PRESET_INDEX[preset] ?? 0;

  // 48-51: signed Laplacian (thorough and deep). The clipped features above
  // (8-11) lose the whole negative lobe and saturate on sharp pages; these do
  // not. saturationRatio says how much the clipped ones understate this image.
  if (ctx.laplacianSigned) {
    values[48] = ctx.laplacianSigned.stdev;
    values[49] = ctx.laplacianSigned.meanAbs;
    values[50] = ctx.laplacianSigned.edgeRatio;
    values[51] = ctx.laplacianSigned.saturationRatio;
  }

  // Thorough-only features (15+) — remain NaN in fast mode
  if (mode !== 'fast') {
    // 15: foregroundRatio
    values[15] = foregroundRatio ?? NaN;

    // 16-17: perspective sharpness/brightness ratio (top vs bottom half)
    if (ctx.laplacian && ctx.laplacian.height > 20) {
      const { data, width: lw, height: lh, length: lapLen } = ctx.laplacian;
      const halfRow = Math.floor(lh / 2);
      const topLen = lw * halfRow;
      const botLen = lapLen - topLen;

      if (topLen > 0 && botLen > 0) {
        let topSumSq = 0, topSum = 0;
        for (let i = 0; i < topLen; i++) { topSum += data[i]; topSumSq += data[i] * data[i]; }
        let botSumSq = 0, botSum = 0;
        for (let i = topLen; i < lapLen; i++) { botSum += data[i]; botSumSq += data[i] * data[i]; }

        const topVar = topSumSq / topLen - (topSum / topLen) ** 2;
        const botVar = botSumSq / botLen - (botSum / botLen) ** 2;
        const maxVar = Math.max(topVar, botVar);
        const minVar = Math.min(topVar, botVar);
        values[16] = minVar > 5 ? maxVar / minVar : NaN;
      }
    }

    if (ctx.greyRaw && ctx.greyRaw.height > 20) {
      const { data: grey, width: gw, height: gh } = ctx.greyRaw;
      const halfRow = Math.floor(gh / 2);
      const topLen = gw * halfRow;
      const total = grey.length;
      const botLen = total - topLen;

      if (topLen > 0 && botLen > 0) {
        let topBright = 0, botBright = 0;
        for (let i = 0; i < topLen; i++) topBright += grey[i];
        for (let i = topLen; i < total; i++) botBright += grey[i];

        const topMean = topBright / topLen;
        const botMean = botBright / botLen;
        values[17] = Math.abs(topMean - botMean);
      }
      // If topLen or botLen is 0, values[17] stays NaN — continue with other features

      // 18-20: shadow edge/center diff
      const stripSize = Math.max(1, Math.floor(Math.min(gw, gh) * 0.1));
      let edgeSum = 0, edgeCount = 0;
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          if (y < stripSize || y >= gh - stripSize || x < stripSize || x >= gw - stripSize) {
            edgeSum += grey[y * gw + x];
            edgeCount++;
          }
        }
      }
      const cx0 = Math.floor(gw * 0.3);
      const cx1 = Math.floor(gw * 0.7);
      const cy0 = Math.floor(gh * 0.3);
      const cy1 = Math.floor(gh * 0.7);
      let centerSum = 0, centerCount = 0;
      for (let y = cy0; y < cy1; y++) {
        for (let x = cx0; x < cx1; x++) {
          centerSum += grey[y * gw + x];
          centerCount++;
        }
      }
      if (edgeCount > 0 && centerCount > 0) {
        const edgeMean = edgeSum / edgeCount;
        const centerMean = centerSum / centerCount;
        values[18] = centerMean - edgeMean;
        values[19] = centerMean;
        values[20] = edgeMean;
      }

      // 21: backgroundP90
      const hist = new Uint32Array(256);
      for (let i = 0; i < grey.length; i++) hist[grey[i]]++;
      const target = Math.floor(grey.length * 0.9);
      let cumul = 0;
      for (let b = 0; b < 256; b++) {
        cumul += hist[b];
        if (cumul >= target) { values[21] = b; break; }
      }

      // 22: skewAngle — projection profile (shared with analyzeSkew, computed once)
      const skewSigned = ctx.skewAngle ?? estimateSkewAngle(grey, gw, gh);
      values[22] = skewSigned === null || skewSigned === undefined ? NaN : Math.abs(skewSigned);

      // 23: colorSaturation (requires 3+ color channels)
      if (ctx.stats && ctx.stats.channels.length >= 3) {
        const means = ctx.stats.channels.slice(0, 3).map(ch => ch.mean);
        const maxM = Math.max(means[0], means[1], means[2]);
        const minM = Math.min(means[0], means[1], means[2]);
        values[23] = (maxM - minM) / 255;
      }

      // 24-26: FFT features
      if (ctx.fftSpectrum) {
        values[24] = highFreqEnergyRatio(ctx.fftSpectrum);
        values[25] = countSpectralPeaks(ctx.fftSpectrum);
      }
      if (ctx.sharpMeta?.format === 'jpeg') {
        // Native resolution when available — the 8x8 grid does not survive a resize.
        const src = ctx.fullResGrey ?? ctx.greyRaw;
        if (src) values[26] = jpegBlockiness(src.data, src.width, src.height);
      }

      // 27-38: zone quality — read from the analyzer so the two cannot drift
      if (ctx.zoneMetrics) {
        const zm = ctx.zoneMetrics;
        values[27] = zm.brightnessDiff;
        values[28] = zm.sharpnessRatio;
        for (let i = 0; i < 4; i++) {
          values[30 + i] = zm.brightness[i];
          values[34 + i] = zm.sharpness[i];
        }
      }

      if (ctx.fftSpectrum) {
        const { magnitude, fftW, fftH } = ctx.fftSpectrum;
        const halfFW = fftW >>> 1;
        const halfFH = fftH >>> 1;
        const numSectors = 12;
        const sectorEnergy = new Float64Array(numSectors);

        for (let y = 0; y < fftH; y++) {
          const fy = y <= halfFH ? y : y - fftH;
          const fyNorm = fy / halfFH;
          for (let x = 0; x < fftW; x++) {
            const fx = x <= halfFW ? x : x - fftW;
            const fxNorm = fx / halfFW;
            const r = Math.sqrt(fxNorm * fxNorm + fyNorm * fyNorm);
            if (r < 0.05) continue;
            // |fx|,|fy| folds the spectrum into one quadrant: angle spans [0, π/2].
            const angle = Math.atan2(Math.abs(fyNorm), Math.abs(fxNorm));
            const sectorIdx = Math.min(Math.floor((angle / (Math.PI / 2)) * numSectors), numSectors - 1);
            const mag = magnitude[y * fftW + x];
            sectorEnergy[sectorIdx] += mag * mag;
          }
        }

        const sorted = Array.from(sectorEnergy).sort((a, b) => a - b);
        const mid = sorted.length >>> 1;
        const medianE = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        const maxE = sorted[sorted.length - 1];
        values[29] = medianE > 0 ? maxE / medianE : NaN;
      }

      // 38: channelCount
      values[38] = ctx.sharpMeta?.channels ?? NaN;
    }

    // 42-47: per-text-line legibility (deep mode)
    if (ctx.textLineMetrics) {
      const tl = ctx.textLineMetrics;
      values[42] = tl.lineCount;
      values[43] = tl.medianXHeight;
      values[44] = tl.medianStrokeWidth;
      values[45] = tl.medianContrast;
      values[46] = tl.medianStrokeSharpness;
      values[47] = tl.illegibleFraction;
    }

    // 39-41: text geometry metrics (from textGeometry analyzer)
    if (ctx.textGeometryMetrics) {
      values[39] = ctx.textGeometryMetrics.baselineDeviation;
      values[40] = ctx.textGeometryMetrics.charSizeCV;
      values[41] = ctx.textGeometryMetrics.charShapeCV;
    }
  }

  return { names: FEATURE_NAMES, values };
}
