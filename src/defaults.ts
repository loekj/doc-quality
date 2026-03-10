import type { Thresholds, PresetName } from './types.js';

/** Default thresholds — tuned for full-page documents */
export const DEFAULT_THRESHOLDS: Thresholds = {
  resolutionMin: 0.3,
  brightnessMin: 50,
  brightnessMax: 245,
  sharpnessMin: 15,
  sharpnessMax: 80,
  edgeDensityMin: 0.015,
  edgeDensityMax: 0.5,
  contrastMin: 0.01,
  contrastMax: 0.85,
  fileSizeMin: 15_000,
  fileSizeMax: 100_000_000,
  resolutionMax: 200,
  uniformitySharpnessRatio: 3.5,
  uniformityBrightnessDiff: 45,
  passThreshold: 0.5,
  analysisMaxPx: 1500,
  dpiMin: 150,
  blankVarianceMax: 2.0,
  skewAngleMax: 10.0,
  shadowBrightnessDiff: 60,
  compressionBppMin: 0.5,
  colorSaturationMin: 0.01,
  moireCorrelationMax: 0.65,
  backgroundP90Min: 170,
  darkShadowCenterMax: 150,
  darkShadowDiffMin: 20,
  fftBlurHighFreqMin: 0.005,
  fftNoiseHighFreqMax: 0.85,
  fftMoirePeaksMax: 15000,
  fftJpegGridMax: 0.5,
  zoneBrightnessMaxDiff: 60,
  zoneSharpnessMinRatio: 0.25,
  directionalBlurRatioMax: 4.0,
  ocrConfidenceMin: 60,
  baselineDeviationMax: 0.02,
  charSizeCVMax: 0.5,
  charShapeCVMax: 0.4,
  laplacianEdgeThreshold: 30,
  binarizationThreshold: 128,
};

/** Concrete preset names (excludes 'auto') */
export type ConcretePreset = Exclude<PresetName, 'auto'>;

/** Preset overrides — merged on top of defaults */
export const PRESETS: Record<ConcretePreset, Partial<Thresholds>> = {
  /** Full-page documents — tax forms, contracts, invoices, letters */
  document: {},

  /**
   * Receipts — narrow thermal paper, small text.
   * Stricter on brightness/sharpness since text is tiny and fades fast.
   * Aspect ratio effectively unchecked — receipts can be any length.
   */
  receipt: {
    resolutionMin: 0.5,
    brightnessMin: 80,
    brightnessMax: 220,
    sharpnessMin: 20,
    fileSizeMin: 50_000,
    passThreshold: 0.6,
    fftBlurHighFreqMin: 0.003,
    backgroundP90Min: 100, // Receipts on dark surfaces — don't penalize
    darkShadowCenterMax: 100, // Receipts naturally have dark edges from surface
    zoneBrightnessMaxDiff: 80, // Receipts have natural gradient from thermal printing
    baselineDeviationMax: 0.03, // Thermal paper curls
  },

  /**
   * Cards — ID cards, credit cards, passports, driver's licenses.
   * Small format where every detail matters. Strict on everything.
   */
  card: {
    resolutionMin: 0.3,
    brightnessMin: 60,
    brightnessMax: 240,
    sharpnessMin: 15,
    edgeDensityMin: 0.02,
    contrastMin: 0.02,
    contrastMax: 0.80,
    fileSizeMin: 30_000,
    uniformitySharpnessRatio: 3.0,
    uniformityBrightnessDiff: 35,
    passThreshold: 0.6,
    fftJpegGridMax: 0.3,
    zoneSharpnessMinRatio: 0.3, // Small cards — tighter uniformity expected
  },
};

/**
 * Detect document type from image dimensions.
 *
 * Heuristics:
 * - Cards: aspect ratio ~1.4–1.8 (ISO 7810: 85.6×53.98mm = 1.586)
 *   and relatively small (< 2 MP) — a full-page scan at 300dpi is ~3.5 MP
 * - Receipts: very tall/narrow (ratio < 0.4) or very wide/short (ratio > 2.5)
 * - Everything else: document
 */
export function detectPreset(width: number, height: number): ConcretePreset {
  const ratio = width / (height || 1);
  const mp = (width * height) / 1_000_000;

  // Receipts: very elongated in either direction
  if (ratio < 0.4 || ratio > 2.5) return 'receipt';

  // Cards: credit-card-shaped (~1.586) and not huge
  // Check both orientations: landscape (1.3–1.9) or portrait (0.53–0.77)
  const isCardLandscape = ratio >= 1.3 && ratio <= 1.9;
  const isCardPortrait = ratio >= 0.53 && ratio <= 0.77;
  if ((isCardLandscape || isCardPortrait) && mp < 2.0) return 'card';

  return 'document';
}

/** Resolve thresholds: defaults → preset overrides → user overrides */
export function resolveThresholds(
  preset: ConcretePreset,
  overrides?: Partial<Thresholds>,
): Thresholds {
  return {
    ...DEFAULT_THRESHOLDS,
    ...PRESETS[preset],
    ...overrides,
  };
}
