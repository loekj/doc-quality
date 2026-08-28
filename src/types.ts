// ── Public types ─────────────────────────────────────────────────

/**
 * Analysis mode.
 *
 * - `fast` — global statistics on a downscaled copy. Cheap enough for a
 *   request that a user is waiting on.
 * - `thorough` — adds FFT, zone, shadow, skew and text-geometry analysis.
 * - `deep` — adds per-text-line legibility measured on native-resolution
 *   pixels: how tall the lowercase body is, how thick the strokes are, how far
 *   the ink separates from the paper. Page-level statistics cannot answer
 *   "can this be read"; a page can be sharp, level and well lit and still be
 *   useless because it was captured at 90 DPI. Intended for asynchronous work.
 */
export type Mode = 'fast' | 'thorough' | 'deep';

/**
 * Built-in preset names — describes the document type.
 * `auto` infers type from aspect ratio and dimensions.
 */
export type PresetName = 'auto' | 'document' | 'receipt' | 'card';

/**
 * Boundary detector function signature.
 *
 * Receives the original image buffer. Returns a BoundaryResult describing
 * the detected document region, or null if no document boundary was found.
 *
 * When a croppedBuffer is returned, all quality checks run on that cropped
 * region instead of the full image — so background (desk, table, floor)
 * doesn't pollute quality metrics.
 */
export type BoundaryDetectorFn = (
  buffer: Buffer,
) => BoundaryResult | null | Promise<BoundaryResult | null>;

/** Scorer function for a single model */
export type ScorerFn = (features: import('./features.js').FeatureVector, issues: Issue[]) => number;

/** Multi-model scorer — auto-selects model by preset × mode */
export type Scorer = ScorerFn & {
  /** Get the underlying model for a specific preset × mode */
  getModel(preset: string, mode: string): import('./tree-eval.js').XGBModel | undefined;
};

/** Options for checkQuality() */
export interface QualityOptions {
  /** Analysis mode: 'fast' runs essential checks, 'thorough' runs all (default: 'fast') */
  mode?: Mode;
  /** Built-in threshold preset (default: 'auto') */
  preset?: PresetName;
  /** Override individual thresholds (merged on top of preset) */
  thresholds?: Partial<Thresholds>;
  /** Timeout in ms (default: 10000). Set to 0 to disable. */
  timeout?: number;
  /**
   * Boundary detector — crops the document region before analysis.
   * Adds latency but improves accuracy when documents are photographed
   * on a desk/table with visible background.
   */
  boundaryDetector?: BoundaryDetectorFn;
  /**
   * Pages to analyze for PDFs. Ignored for images.
   * Default: `'1'` (first page only).
   *
   * Examples: `'1'`, `'1-5'`, `'1,4,8-12'`, `'all'`
   */
  pages?: string;
  /**
   * Override the default penalty for specific analyzers.
   * Values should be between 0 and 1 (score multiplier).
   *
   * Naming an analyzer here also promotes its `advisory` issues into scoring
   * ones: an explicit override is a request for that analyzer to count. This is
   * the way to re-enable `colorDepth`, `fftMoire`, `directionalBlur` or
   * `textGeometry`'s shape check if your corpus wants them as gates.
   */
  penalties?: Partial<Record<AnalyzerName, number>>;
  /**
   * Maximum number of PDF pages to analyze concurrently (default: Infinity).
   * Useful for controlling memory usage on large PDFs.
   */
  maxConcurrency?: number;
  /**
   * Called after each page is analyzed (PDFs only).
   * Useful for progress bars and streaming results.
   */
  onPage?: (page: number, total: number, result: PageResult) => void;
  /**
   * Enable built-in lightweight document boundary detection.
   * Detects where a document sits on a darker background using brightness transitions.
   * When preset is 'auto', detected bounds are used for preset selection.
   * Detected bounds are returned in the result's `boundary` field.
   * Skipped when a custom `boundaryDetector` is provided.
   * Default: true
   */
  detectBounds?: boolean;
  /**
   * Analyse only the detected document region instead of the whole frame.
   *
   * Without this, a page photographed on a desk is graded together with the
   * desk: a correctly exposed document on a dark surface reports
   * `shadow-on-edges` and scores 0.70, where the same page cropped to its own
   * edges scores 1.00 with nothing flagged. Only applies when `detectBounds`
   * found a region and no custom `boundaryDetector` was supplied, and is
   * skipped when the region already covers most of the frame.
   *
   * Set to false to report the detected bounds without letting them change
   * what is measured. Default: true
   */
  cropToBounds?: boolean;
  /** Enable OCR confidence check (requires tesseract.js peer dep). Default: false */
  ocrConfidence?: boolean;
  /** Pre-initialized Tesseract worker for reuse. If not provided, one is created and terminated per call. */
  ocrWorker?: unknown;
  /** Tesseract language (default: 'eng') */
  ocrLanguage?: string;
  /**
   * How to analyse a PDF. Ignored for images.
   *
   * - `content` (default) — classify each page, then grade the embedded raster
   *   images at native resolution. Pages that are pure digital text pass
   *   without pixel analysis, because their text layer is exact.
   * - `render` — rasterise every page and grade the pixels. This resamples
   *   embedded scans to the viewport and emits PNG, which hides JPEG
   *   compression damage. Kept for compatibility.
   *
   * Falls back to `render` automatically when content analysis is unavailable.
   */
  pdfStrategy?: 'content' | 'render';
  /**
   * Treat this value as the image's true DPI, overriding any embedded metadata.
   * Set by the PDF content path, which derives real scan resolution from native
   * pixels and placed page size. Unlike camera EXIF density, this is trustworthy,
   * so the low-DPI check honours it instead of skipping it.
   */
  densityOverride?: number;
  /**
   * Custom scorer — replaces multiplicative penalty scoring with ML model.
   * Use `loadModels()` to create from an XGBoost model bundle.
   */
  scorer?: Scorer | ScorerFn;
}

/** Detection thresholds — all configurable */
export interface Thresholds {
  /** Minimum resolution in megapixels (default: 0.3) */
  resolutionMin: number;
  /** Dark image threshold — mean brightness 0-255 (default: 50) */
  brightnessMin: number;
  /** Overexposed threshold — mean brightness 0-255 (default: 245) */
  brightnessMax: number;
  /** Minimum Laplacian stdev for sharpness (default: 15) */
  sharpnessMin: number;
  /** Maximum Laplacian mean — noise detection (default: 80) */
  sharpnessMax: number;
  /** Minimum edge pixel ratio 0-1 (default: 0.015) */
  edgeDensityMin: number;
  /** Maximum edge pixel ratio 0-1 — noise detection (default: 0.5) */
  edgeDensityMax: number;
  /** Minimum foreground ratio after binarization (default: 0.01) */
  contrastMin: number;
  /** Maximum foreground ratio — nearly all-dark (default: 0.85) */
  contrastMax: number;
  /** Minimum file size in bytes (default: 15000) */
  fileSizeMin: number;
  /** Maximum file size in bytes (default: 100_000_000 = 100 MB) */
  fileSizeMax: number;
  /** Maximum resolution in megapixels (default: 200) */
  resolutionMax: number;
  /** Max Laplacian variance ratio between halves for angle detection (default: 3.5) */
  uniformitySharpnessRatio: number;
  /** Max brightness difference between halves (default: 45) */
  uniformityBrightnessDiff: number;
  /** Score at or above this = pass (default: 0.5) */
  passThreshold: number;
  /** Max dimension in px for analysis resize (default: 1500) */
  analysisMaxPx: number;
  /** Minimum DPI from metadata (default: 150) */
  dpiMin: number;
  /** Maximum stdev across channels for blank page detection (default: 2.0) */
  blankVarianceMax: number;
  /** Maximum estimated skew angle in degrees (default: 5.0) */
  skewAngleMax: number;
  /** Max brightness diff between edge strips and center for shadow detection (default: 60) */
  shadowBrightnessDiff: number;
  /**
   * Minimum bits-per-pixel for JPEG compression quality (default: 0.3).
   *
   * A high-resolution scan of a text page is mostly white, so it compresses far
   * below the rate photographic content needs. At the old 0.5 floor this fired
   * on 17 of 20 clean test scans, quality 92 included.
   */
  compressionBppMin: number;
  /**
   * Blockiness needed to confirm that low bits-per-pixel is real damage
   * (default: 0.1). Only applied when blockiness has been measured — thorough
   * mode, on native-resolution pixels. Low bpp on its own says the file is
   * small; the 8x8 block grid says the encoder actually discarded information.
   */
  compressionBlockinessMin: number;
  /** Minimum channel saturation — grayscale-in-color detection (default: 0.01) */
  colorSaturationMin: number;
  /** Minimum 90th-percentile brightness for document background (default: 170) */
  backgroundP90Min: number;
  /** Maximum center brightness for compound shadow detection (default: 150) */
  darkShadowCenterMax: number;
  /** Minimum shadow diff for compound shadow detection (default: 20) */
  darkShadowDiffMin: number;
  /** Minimum high-frequency energy ratio — below = blurry (default: 0.15) */
  fftBlurHighFreqMin: number;
  /** Maximum high-frequency energy ratio — above = noisy (default: 0.70) */
  fftNoiseHighFreqMax: number;
  /** Maximum spectral peaks — above = moiré (default: 3) */
  fftMoirePeaksMax: number;
  /** Maximum JPEG grid energy ratio — above = JPEG artifacts (default: 0.05) */
  fftJpegGridMax: number;
  /** Maximum brightness spread across 2x2 quadrants (default: 60) */
  zoneBrightnessMaxDiff: number;
  /** Minimum ratio of weakest to strongest quadrant sharpness (default: 0.25) */
  zoneSharpnessMinRatio: number;
  /**
   * Greyscale stdev a quadrant needs before its sharpness is compared
   * (default: 5).
   *
   * A blank margin has no detail, so its Laplacian stdev is ~0 — which made the
   * weakest/strongest ratio 0.000 for any page whose content did not reach all
   * four corners. A clean short letter and a page with half of it blurred were
   * literally indistinguishable. Empty quadrants are now excluded instead.
   */
  zoneContentStdevMin: number;
  /** Maximum directional energy concentration in FFT spectrum (default: 4.0) */
  directionalBlurRatioMax: number;
  /** Minimum OCR median word confidence 0-100 (default: 60) */
  ocrConfidenceMin: number;
  /** Maximum baseline deviation normalized to image height (default: 0.02) */
  baselineDeviationMax: number;
  /** Maximum coefficient of variation for character sizes (default: 0.5) */
  charSizeCVMax: number;
  /** Maximum coefficient of variation for character shape circularity (default: 0.4) */
  charShapeCVMax: number;
  /** Laplacian magnitude threshold for counting edge pixels (default: 30) */
  laplacianEdgeThreshold: number;
  /** Greyscale threshold for text binarization 0-255 (default: 128) */
  binarizationThreshold: number;
  /**
   * Minimum lowercase body height in pixels, below which OCR stops working.
   *
   * 10, raised from 8 on Tesseract measurements over the labelling corpus. Of
   * 103 documents with a trustworthy reading, the 8-10px band came back at a
   * median word confidence of 53.6 with 63% of files unreadable, while 10-14px
   * jumped to 83.5 and 36%. Eight admitted a band where OCR mostly fails.
   *
   * It flips nothing on the labels that exist today — every image in that band
   * was already failing for other reasons — so this is a threshold set from
   * where OCR actually breaks rather than from an observed disagreement. It
   * will start mattering as grading covers more of the corpus.
   *
   * The `receipt` preset keeps its own, lower floor, and deliberately: no
   * receipt in the sample had an x-height under 10 at all, so there is no
   * evidence to move it in either direction. `card` inherits this number with
   * one measured row behind it, which is to say none.
   *
   * Re-measure with `scripts/calibrate-ocr.mjs`.
   */
  textXHeightMin: number;
  /** Minimum median stroke thickness in pixels (default: 1.2). `deep` mode only. */
  textStrokeWidthMin: number;
  /** Minimum per-line ink-to-paper separation, 0-255 (default: 40). `deep` mode only. */
  textLineContrastMin: number;
  /**
   * Minimum contrast-normalised stroke edge gradient (default: 0.4).
   *
   * The per-line blur test. Sharp text measures 0.62-0.94 whether crisp,
   * JPEG-mangled, rotated, faded or underexposed; Gaussian blur takes it to
   * 0.30 and below. `deep` mode only.
   */
  textStrokeSharpnessMin: number;
  /** Share of lines allowed to fail legibility before the page is flagged (default: 0.15). */
  textIllegibleFractionMax: number;
  /**
   * Fewest megapixels the document itself may occupy, once found in the frame.
   *
   * `resolutionMin` measures the picture; this measures the page inside it. The
   * two are the same for a scan and diverge for a photograph, which is exactly
   * the case that needed catching: a 12 MP phone shot of an A4 page held at
   * arm's length is 12 MP of picture and about 0.8 MP of page, and every check
   * that reads the frame calls it excellent. Only the page's own pixel count
   * predicts whether the text will survive OCR.
   *
   * Deliberately a count and not a share of the frame. Framing is what a user
   * controls; pixels are what OCR consumes. A 48 MP camera at 15% fill still
   * delivers 7 MP of page, and a fill-ratio test would reject it for being far
   * away when its text is in fact enormous.
   *
   * Only applies when boundary detection found the page. There is no honest
   * number to compare against otherwise.
   */
  documentRegionMpMin: number;
  /**
   * Largest share of the frame the page may fill and still be called "too far".
   *
   * Distance is a thing the photographer can fix, and that only makes sense
   * while there is empty frame left to close. A page already filling 90% of the
   * picture and still short of pixels is not far away — it is a small sensor,
   * which is `low-resolution`'s job, not this one's.
   *
   * 0.35 is where Tesseract falls off. Over a 440-image stratified sample of
   * the labelling corpus, median word confidence by fill ran: under 0.2, one
   * file, unreadable; 0.2–0.35, seven of eight unreadable; 0.35–0.5, two of
   * four; 0.5–0.7, four of nine; and at 0.9 and above — 230 files, nearly all
   * of them — half. Below roughly a third of the frame the page stops being
   * readable; above it, framing stops predicting anything.
   *
   * This is the load-bearing half of the pair. Over the same sample the page's
   * own megapixel count did not order the outcome at all: 0.3–0.5 MP was 50%
   * unreadable and 3 MP and above was 58%. `documentRegionMpMin` survives as
   * the escape hatch for a large sensor — 15% of a 48 MP frame is still 7 MP of
   * perfectly legible page — not as a predictor in its own right.
   */
  documentFrameFillMax: number;
  /**
   * Analyzers whose issues are dropped before scoring (default: none).
   *
   * Some checks measure how much of the page is covered in ink, and that is a
   * reasonable proxy for quality only on a page of text. An ID card, a driving
   * licence or a passport data page is mostly background, a portrait and a few
   * short fields, so `low-edge-density` and `low-contrast` fire on a perfectly
   * good one — a clean 300 DPI card scan scored 0.02.
   *
   * The analyzers still run and still populate the feature vector, so a trained
   * model keeps everything. Only the rule-based score and the reported issues
   * are affected.
   */
  skipAnalyzers: AnalyzerName[];
}

/** Quality check result */
export interface QualityResult {
  /** Whether the image/document passes the quality threshold */
  pass: boolean;
  /** Aggregate quality score 0–1. For multi-page PDFs: average across all pages. */
  score: number;
  /** Confidence level: 'high' | 'medium' | 'low'. Low when score is in the ambiguous zone (0.35–0.65). */
  confidence: 'high' | 'medium' | 'low';
  /** Preset used (resolved from 'auto' if applicable) */
  preset: Exclude<PresetName, 'auto'>;
  /** All issues found. For multi-page PDFs: issues from all pages (each tagged with `page`). */
  issues: Issue[];
  /** Image metadata (for PDFs: from the first analyzed page) */
  metadata: ImageMetadata;
  /** Per-page results (only present for multi-page PDF analysis) */
  pageResults?: PageResult[];
  /** Worst page score (only present for multi-page PDF analysis) */
  worstPageScore?: number;
  /** Boundary detection result (present when a detector is used) */
  boundary?: BoundaryResult;
  /**
   * What the PDF page held (PDFs analysed with `pdfStrategy: 'content'`).
   * `digital-text` pages pass without pixel analysis — their text layer is exact,
   * so image quality does not apply. For multi-page PDFs this is the kind of the
   * worst-scoring page.
   */
  pdfKind?: import('./pdf-content.js').PdfPageKind;
  /**
   * True scan resolution of the graded image, in DPI: native pixels divided by
   * placed size on the page. Only available via the PDF content path — a
   * rendered page can only report the renderer's own viewport scale.
   */
  effectiveDpi?: number;
  /** Timing breakdown in ms */
  timing: Timing;
}

/** Per-page quality result (multi-page PDF analysis) */
export interface PageResult {
  /** 1-indexed page number */
  page: number;
  /** Whether this page passes the quality threshold */
  pass: boolean;
  /** Quality score for this page */
  score: number;
  /** Issues found on this page */
  issues: Issue[];
  /** What this page held (PDF content analysis only) */
  kind?: import('./pdf-content.js').PdfPageKind;
  /** True scan resolution in DPI of the worst image on this page */
  effectiveDpi?: number;
  /** Number of embedded raster images graded on this page */
  imageCount?: number;
}

/** Detected document region within the image */
export interface DocumentRegion {
  /** X offset of the document region in px */
  x: number;
  /** Y offset of the document region in px */
  y: number;
  /** Width of the document region in px */
  width: number;
  /** Height of the document region in px */
  height: number;
  /** Rotation angle in degrees (if document is tilted) */
  angle?: number;
}

/** Result from a boundary detector */
export interface BoundaryResult {
  /** Whether a document boundary was found */
  detected: boolean;
  /** Detected document region (if detected) */
  region?: DocumentRegion;
  /** How many of the four edges produced a real transition (built-in detector) */
  edgesDetected?: number;
  /** Confidence of the detection 0–1 */
  confidence: number;
  /** Cropped buffer containing only the document (if detected) */
  croppedBuffer?: Buffer;
  /**
   * True when quality analysis actually ran on this region rather than the
   * whole frame. False or absent means the region is reported for information
   * only and the surrounding desk was still measured.
   */
  cropped?: boolean;
}

/** A single quality issue */
export interface Issue {
  /** Which analyzer flagged this */
  analyzer: AnalyzerName;
  /** Specific issue code — more granular than analyzer name (e.g. 'too-dark' vs 'overexposed') */
  code: IssueCode;
  /** User-facing guidance suitable for display in UI (e.g. "Please retake in better lighting") */
  guidance: string;
  /** Technical diagnostic message with measured values */
  message: string;
  /** Measured value */
  value: number;
  /** Threshold that was violated */
  threshold: number;
  /** Score multiplier applied (e.g. 0.5 = halved the score) */
  penalty: number;
  /**
   * How this issue affects the score.
   *
   * - `error` (default) — multiplies `penalty` into the score.
   * - `advisory` — reported for diagnostics and fed to the ML feature vector,
   *   but never lowers the score. Used for signals that fire on perfectly good
   *   documents (text is periodic and anisotropic, so it looks like moiré and
   *   directional blur to a global detector).
   */
  severity?: 'error' | 'advisory';
  /** Page number (1-indexed). Present for PDF analysis. */
  page?: number;
}

/** Granular issue codes — each analyzer may emit one or more distinct codes */
export type IssueCode =
  | 'low-resolution'
  | 'too-dark'
  | 'overexposed'
  | 'blurry'
  | 'noisy'
  | 'low-edge-density'
  | 'high-edge-density'
  | 'low-contrast'
  | 'too-dark-content'
  | 'file-too-small'
  | 'uneven-focus'
  | 'uneven-lighting'
  | 'low-dpi'
  | 'blank-page'
  | 'heavy-compression'
  | 'shadow-on-edges'
  | 'dark-shadow'
  | 'tilted'
  | 'grayscale-in-color'
  | 'moire-pattern'
  | 'dim-background'
  | 'fft-blur'
  | 'fft-noise'
  | 'fft-moire'
  | 'jpeg-artifacts'
  | 'uneven-zone-brightness'
  | 'uneven-zone-sharpness'
  | 'directional-blur'
  | 'low-ocr-confidence'
  | 'file-too-large'
  | 'resolution-too-high'
  | 'wavy-text-lines'
  | 'inconsistent-char-size'
  | 'distorted-char-shapes'
  | 'analysis-timeout'
  | 'text-too-small'
  | 'illegible-text'
  | 'document-too-far'
  | 'text-unmeasurable'
  /**
   * The file could not be decoded at all.
   *
   * Browser-only: `preflight` depends on the browser's own decoders, and they
   * differ. Safari reads HEIC; Chrome and Firefox generally do not, so a photo
   * straight off an iPhone is undecodable for most of the web.
   */
  | 'unreadable-file'
  | 'custom';

/** Image metadata extracted during analysis */
export interface ImageMetadata {
  width: number;
  height: number;
  megapixels: number;
  format?: string;
  fileSize: number;
}

/** Timing breakdown */
export interface Timing {
  /** Total analysis time in ms */
  totalMs: number;
  /** Per-analyzer timing */
  analyzers: Partial<Record<AnalyzerName, number>>;
}

/** Analyzer names */
export type AnalyzerName =
  | 'resolution'
  | 'brightness'
  | 'sharpness'
  | 'edgeDensity'
  | 'textContrast'
  | 'fileSize'
  | 'perspective'
  | 'fftBlur'
  | 'fftNoise'
  | 'fftMoire'
  | 'fftJpegArtifact'
  | 'dpi'
  | 'blankPage'
  | 'skew'
  | 'shadow'
  | 'dimBackground'
  | 'compression'
  | 'colorDepth'
  | 'zoneQuality'
  | 'directionalBlur'
  | 'ocrConfidence'
  | 'darkShadow'
  | 'textGeometry'
  | 'textLines'
  | 'documentDistance'
  | 'timeout';

// ── Internal types ───────────────────────────────────────────────

/** Shared computation context passed between analyzers */
export interface AnalysisContext {
  /** Original input buffer */
  originalBuffer: Buffer;
  /** Resized buffer for analysis */
  analysisBuffer: Buffer;
  /** Original image metadata */
  metadata: { width: number; height: number; format?: string };
  /** Image channel stats (computed once, shared) */
  stats?: { channels: Array<{ mean: number; stdev: number }> };
  /** Laplacian data (computed once, shared by sharpness/edgeDensity/perspective) */
  laplacian?: {
    data: Buffer;
    width: number;
    height: number;
    mean: number;
    variance: number;
    stdev: number;
    edgeCount: number;
    length: number;
  };
  /**
   * Pixel count of the encoded file, before any crop to the document region.
   * Bits-per-pixel must be measured against the pixels the file encodes.
   */
  encodedPixels?: number;
  /**
   * The page's own size in pixels, when boundary detection found it.
   *
   * Absent means the page was never located, not that it fills the frame — the
   * detector declines far more often on photographs than on scans. Anything
   * reading this must treat absence as "unknown" and stay silent, never as
   * "the page is fine".
   */
  documentRegion?: { width: number; height: number };
  /** Signed Laplacian and its statistics — computed once, shared */
  laplacianSigned?: import('./laplacian.js').SignedLaplacian;
  /** Greyscale raw pixel data (computed once, shared) */
  greyRaw?: {
    data: Buffer;
    width: number;
    height: number;
  };
  /** Sharp metadata (density, channels, colour space, format) */
  sharpMeta?: {
    density?: number;
    channels?: number;
    space?: string;
    format?: string;
  };
  /** FFT spectrum at 512px max — used by blur/noise/moiré */
  fftSpectrum?: import('./fft-core.js').MagnitudeSpectrum2D;
  /** FFT spectrum at full analysis resolution — used by JPEG artifact detector (JPEG only) */
  fftSpectrumFull?: import('./fft-core.js').MagnitudeSpectrum2D;
  /**
   * Full-resolution greyscale pixels. Only populated for JPEGs that were
   * downscaled for analysis. The 8x8 JPEG block grid does not survive a
   * resize, so blockiness must be measured on native-resolution pixels.
   */
  fullResGrey?: {
    data: Buffer;
    width: number;
    height: number;
  };
  /**
   * The uncropped frame in greyscale, kept only when a crop was taken.
   *
   * Text-line measurement thresholds whatever surface it is handed into ink and
   * paper, so the surface changes the answer. Cropping to an ID card leaves the
   * card's portrait as the darkest thing in the picture, and the split lands
   * between paper and portrait rather than between paper and print — the card
   * comes back as a single 528px "letter". The same card inside its original
   * frame splits against the desk, and the print resolves: twelve lines with a
   * 5.5px lowercase body, which is the honest reading and well under the floor.
   *
   * Measured across the 68 cropped images in a 450-image sample: 12 were
   * readable only from the crop, 18 only from the frame, and none from both. So
   * there is nothing to reconcile — one surface works or the other does.
   */
  uncroppedGrey?: {
    data: Buffer;
    width: number;
    height: number;
  };
  /**
   * Edge-versus-centre brightness, computed once and shared.
   *
   * Both shadow analyzers and feature extraction were each walking the whole
   * greyscale buffer to derive the same three numbers — the identical maths
   * written out three times, which is how the skew estimator and the
   * directional-blur sector index drifted from their analyzers.
   */
  shadowMetrics?: {
    edgeMean: number;
    centerMean: number;
    /** centerMean - edgeMean; positive when the edges are darker. */
    diff: number;
  };
  /** 90th-percentile greyscale brightness — the paper's own tone. */
  backgroundP90?: number;
  /**
   * Per-quadrant zone metrics, computed once by analyzeZoneQuality.
   *
   * Feature extraction reads these rather than recomputing them. Duplicating
   * this maths is exactly how the skew estimator and the directional-blur
   * sector index drifted out of sync with their analyzers.
   */
  zoneMetrics?: {
    brightness: number[];
    sharpness: number[];
    brightnessDiff: number;
    sharpnessRatio: number;
  };
  /** Per-text-line legibility metrics — `deep` mode only */
  textLineMetrics?: import('./text-lines.js').TextLineMetrics;
  /** Measured JPEG 8x8 blockiness — set by analyzeFFTJpegArtifact, read by analyzeCompression */
  jpegBlockiness?: number;
  /** True when `density` came from a trusted source rather than image metadata */
  densityAuthoritative?: boolean;
  /**
   * Signed skew angle in degrees — computed once by analyzeSkew and reused by
   * feature extraction and by textGeometry, which must deskew before it can
   * cluster characters into text rows.
   */
  skewAngle?: number;
  /** Text geometry metrics — shared between analyzer and feature extraction */
  textGeometryMetrics?: {
    baselineDeviation: number;
    charSizeCV: number;
    charShapeCV: number;
  };
}
