import type { AnalysisContext, Mode } from './types.js';
import type { ConcretePreset } from './defaults.js';
import { DEFAULT_THRESHOLDS } from './defaults.js';
import { highFreqEnergyRatio, countSpectralPeaks, jpegBlockiness } from './fft-core.js';

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

  // Thorough-only features (15-41) — remain NaN in fast mode
  if (mode === 'thorough') {
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

      // 22: skewAngle — reuse laplacian edge center-of-mass regression
      if (ctx.laplacian && ctx.laplacian.width >= 20 && ctx.laplacian.height >= 20) {
        const lapD = ctx.laplacian.data;
        const lapW = ctx.laplacian.width;
        const lapH = ctx.laplacian.height;
        const numStrips = Math.min(20, lapW);
        const stripW = Math.floor(lapW / numStrips);
        const xs: number[] = [];
        const ys: number[] = [];

        for (let s = 0; s < numStrips; s++) {
          const sx0 = s * stripW;
          const sx1 = Math.min(sx0 + stripW, lapW);
          let weightedY = 0, totalW = 0;
          for (let y = 0; y < lapH; y++) {
            for (let x = sx0; x < sx1; x++) {
              const v = lapD[y * lapW + x];
              if (v > DEFAULT_THRESHOLDS.laplacianEdgeThreshold) { weightedY += y * v; totalW += v; }
            }
          }
          if (totalW > 0) { xs.push((sx0 + sx1) / 2); ys.push(weightedY / totalW); }
        }

        if (xs.length >= 3) {
          const n = xs.length;
          let sX = 0, sY = 0, sXY = 0, sXX = 0;
          for (let i = 0; i < n; i++) { sX += xs[i]; sY += ys[i]; sXY += xs[i] * ys[i]; sXX += xs[i] * xs[i]; }
          const denom = n * sXX - sX * sX;
          if (Math.abs(denom) > 1e-10) {
            const slope = (n * sXY - sX * sY) / denom;
            values[22] = Math.abs(Math.atan(slope) * (180 / Math.PI));
          }
        }
      }

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
      if (ctx.greyRaw && ctx.sharpMeta?.format === 'jpeg') {
        values[26] = jpegBlockiness(ctx.greyRaw.data, ctx.greyRaw.width, ctx.greyRaw.height);
      }

      // 27-29: zone quality summary
      if (ctx.greyRaw && ctx.laplacian && gw >= 100 && gh >= 100) {
        const halfGW = Math.floor(gw / 2);
        const halfGH = Math.floor(gh / 2);
        const zoneBright = [0, 0, 0, 0];
        const zoneCount = [0, 0, 0, 0];

        for (let y = 0; y < gh; y++) {
          const row = y < halfGH ? 0 : 1;
          for (let x = 0; x < gw; x++) {
            const col = x < halfGW ? 0 : 1;
            const idx = row * 2 + col;
            zoneBright[idx] += grey[y * gw + x];
            zoneCount[idx]++;
          }
        }
        for (let i = 0; i < 4; i++) {
          zoneBright[i] = zoneCount[i] > 0 ? zoneBright[i] / zoneCount[i] : 0;
        }

        const { data: lapD2, width: lw2, height: lh2 } = ctx.laplacian;
        const halfLW = Math.floor(lw2 / 2);
        const halfLH = Math.floor(lh2 / 2);
        const zSum = [0, 0, 0, 0];
        const zSumSq = [0, 0, 0, 0];
        const zN = [0, 0, 0, 0];

        for (let y = 0; y < lh2; y++) {
          const row = y < halfLH ? 0 : 1;
          for (let x = 0; x < lw2; x++) {
            const col = x < halfLW ? 0 : 1;
            const idx = row * 2 + col;
            const v = lapD2[y * lw2 + x];
            zSum[idx] += v;
            zSumSq[idx] += v * v;
            zN[idx]++;
          }
        }
        const zoneSharp = [0, 0, 0, 0];
        for (let i = 0; i < 4; i++) {
          if (zN[i] > 0) {
            const m = zSum[i] / zN[i];
            zoneSharp[i] = Math.sqrt(Math.max(0, zSumSq[i] / zN[i] - m * m));
          }
        }

        const maxBright = Math.max(...zoneBright);
        const minBright = Math.min(...zoneBright);
        values[27] = maxBright - minBright;

        const maxSharp = Math.max(...zoneSharp);
        const minSharp = Math.min(...zoneSharp);
        values[28] = maxSharp > 0 ? minSharp / maxSharp : 1;

        // 29: directional energy ratio
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
              const angle = Math.atan2(Math.abs(fyNorm), Math.abs(fxNorm));
              const sectorIdx = Math.min(Math.floor((angle / Math.PI) * numSectors), numSectors - 1);
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

        // 30-33: per-zone brightness
        values[30] = zoneBright[0];
        values[31] = zoneBright[1];
        values[32] = zoneBright[2];
        values[33] = zoneBright[3];

        // 34-37: per-zone sharpness
        values[34] = zoneSharp[0];
        values[35] = zoneSharp[1];
        values[36] = zoneSharp[2];
        values[37] = zoneSharp[3];
      }

      // 38: channelCount
      values[38] = ctx.sharpMeta?.channels ?? NaN;
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
