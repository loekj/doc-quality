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
  compressionBppMin: 0.3,
  compressionBlockinessMin: 0.1,
  colorSaturationMin: 0.01,
  backgroundP90Min: 170,
  darkShadowCenterMax: 150,
  darkShadowDiffMin: 20,
  fftBlurHighFreqMin: 0.005,
  fftNoiseHighFreqMax: 0.85,
  fftMoirePeaksMax: 15000,
  fftJpegGridMax: 0.5,
  zoneBrightnessMaxDiff: 60,
  zoneSharpnessMinRatio: 0.25,
  zoneContentStdevMin: 5,
  directionalBlurRatioMax: 4.0,
  ocrConfidenceMin: 60,
  baselineDeviationMax: 0.02,
  charSizeCVMax: 0.5,
  charShapeCVMax: 0.4,
  laplacianEdgeThreshold: 30,
  binarizationThreshold: 128,
  textXHeightMin: 8,
  textStrokeWidthMin: 1.2,
  textLineContrastMin: 40,
  textStrokeSharpnessMin: 0.4,
  textIllegibleFractionMax: 0.15,
  skipAnalyzers: [],
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
    // Thermal paper is close to white and a receipt is mostly blank space, so
    // its mean brightness sits just under the ceiling tuned for inked pages.
    // A clean 203 DPI receipt scan measured 246 and was called overexposed.
    brightnessMax: 248,
    sharpnessMin: 20,
    fileSizeMin: 50_000,
    passThreshold: 0.6,
    fftBlurHighFreqMin: 0.003,
    backgroundP90Min: 100, // Receipts on dark surfaces — don't penalize
    darkShadowCenterMax: 100, // Receipts naturally have dark edges from surface
    zoneBrightnessMaxDiff: 80, // Receipts have natural gradient from thermal printing
    baselineDeviationMax: 0.03, // Thermal paper curls
    textLineContrastMin: 30,    // Thermal ink fades — pale but still readable
    textXHeightMin: 7,          // Receipt type is small by design
  },

  /**
   * Identity documents — ID cards, driving licences, passport data pages,
   * credit cards.
   *
   * These were previously treated as "a document, but stricter", which is
   * backwards. A card is not a dense page of text: it is mostly background,
   * a portrait photograph and a handful of short fields, often in two columns.
   * Tightening the ink-coverage checks made a clean 300 DPI card scan score
   * 0.02, and every good card failed.
   *
   * So the coverage checks are skipped rather than tightened, and what remains
   * is what actually degrades a card: focus, resolution, exposure, shadow and
   * compression. The skipped analyzers still run and still reach the feature
   * vector, so a trained model loses nothing.
   */
  card: {
    // A card at 300 DPI is 0.65 MP; at 200 DPI it is 0.29 MP and still perfectly
    // readable. The document floor of 0.3 rejected every capture under 200 DPI
    // purely because the format is small.
    resolutionMin: 0.15,
    brightnessMin: 60,
    brightnessMax: 246,
    // Measured on clean card scans: the Laplacian spread runs 15.6 at 600 DPI
    // to 21.7 at 150 DPI, so the document threshold of 15 sits underneath a
    // perfectly sharp card and fired on good ones. Blurred by sigma 1 it is
    // 8.7, by sigma 2 it is 2.1. Eight separates those without touching a sharp
    // card. The global Laplacian is a weak blur signal on sparse content;
    // `deep` mode's contrast-normalised stroke sharpness is the better one,
    // running 1.38 clean against 0.19 at sigma 2.
    sharpnessMin: 8,
    uniformityBrightnessDiff: 35,
    passThreshold: 0.5,
    fftJpegGridMax: 0.3,
    // Ink coverage says nothing about a card, and a portrait beside text is
    // legitimately less uniform than a page of paragraphs. Text geometry
    // assumes rows of continuous prose, which card fields are not. Absolute
    // file size is a thumbnail check that a card fails on merit — clean scans
    // measured 4 to 34 KB — and bits-per-pixel already covers a starved file.
    skipAnalyzers: ['edgeDensity', 'textContrast', 'perspective', 'textGeometry', 'fileSize'],
  },
};

/**
 * Aspect ratios of the paper sizes documents actually arrive on, portrait and
 * landscape. The ISO A series is all 1:√2, so A3, A4 and A5 share one entry.
 */
const PAPER_RATIOS = [
  210 / 297,   // A-series portrait  0.707
  297 / 210,   // A-series landscape 1.414
  8.5 / 11,    // Letter portrait    0.773
  11 / 8.5,    // Letter landscape   1.294
  8.5 / 14,    // Legal portrait     0.607
  14 / 8.5,    // Legal landscape    1.647
];

/** How close a ratio must be to a paper ratio to count as that paper. */
const PAPER_TOLERANCE = 0.015;

function isPaperRatio(ratio: number): boolean {
  return PAPER_RATIOS.some((paper) => Math.abs(ratio - paper) <= PAPER_TOLERANCE);
}

/**
 * Detect document type from image dimensions.
 *
 * Two numbers cannot separate every case, so where shapes genuinely collide
 * this resolves toward `document`. That preset has the lenient thresholds: a
 * card graded as a document under-detects, where a document graded as a card
 * over-rejects, and over-rejection is the error that actually hurts.
 *
 * Paper is checked before cards because their shapes overlap and paper is far
 * more common. A4 portrait is 0.707 and a portrait passport is 0.704; A4
 * landscape is 1.414 and an open passport is 1.420. Nothing can tell those
 * apart from dimensions alone, so paper wins. Legal portrait (0.607) likewise
 * sits inside any card band wide enough to hold an ID-1 card at 0.631.
 *
 * Previously A4 below about 2 MP — anything scanned under 145 DPI — was read as
 * a card, which applies a stricter zone-uniformity limit that a normal page
 * fails: identical content scored 1.00 as a document and 0.70 as a card.
 *
 * Heuristics:
 * - Receipts: much longer than wide in either orientation.
 * - Cards: close to ISO 7810 ID-1 (85.6×53.98mm, ratio 1.586) and not huge.
 *   The band is deliberately narrow, which excludes 3:2 and 4:3 camera frames.
 * - Everything else: document.
 */
export function detectPreset(width: number, height: number): ConcretePreset {
  const ratio = width / (height || 1);
  const mp = (width * height) / 1_000_000;

  // Receipts: thermal rolls and their photographs are far longer than wide.
  // The bound is inclusive — an 80x200mm receipt lands on exactly 0.400, and
  // an exclusive test read it as a document.
  if (ratio <= 0.45 || ratio >= 2.2) return 'receipt';

  // Standard paper outranks the card check where the two overlap.
  if (isPaperRatio(ratio)) return 'document';

  // ID-1 is 1.586 landscape, 0.631 portrait. Kept tight on purpose: widening it
  // to admit passports would swallow A4, and widening it to 1.3 swallowed every
  // 4:3 phone frame. The megapixel ceiling allows a card scanned at 600 DPI
  // (2.6 MP) while still excluding full-page scans, which are paper-shaped and
  // have already returned above.
  const isCardLandscape = ratio >= 1.52 && ratio <= 1.7;
  const isCardPortrait = ratio >= 0.59 && ratio <= 0.66;
  if ((isCardLandscape || isCardPortrait) && mp < 4.0) return 'card';

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
