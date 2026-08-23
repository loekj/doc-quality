import sharp from 'sharp';
import type {
  AnalysisContext,
  BoundaryDetectorFn,
  BoundaryResult,
  Issue,
  Mode,
  QualityOptions,
  QualityResult,
  Thresholds,
  ImageMetadata,
  Timing,
  AnalyzerName,
  DocumentRegion,
} from './types.js';
import type { ConcretePreset } from './defaults.js';
import { extractFeatures } from './features.js';
import {
  analyzeResolution,
  analyzeResolutionMax,
  analyzeBrightness,
  analyzeSharpness,
  analyzeEdgeDensity,
  analyzeFileSize,
  analyzeFileSizeMax,
  analyzeTextContrast,
  analyzePerspectiveSharpness,
  analyzePerspectiveBrightness,
  analyzeDpi,
  analyzeBlankPage,
  analyzeCompression,
  analyzeShadow,
  analyzeSkew,
  analyzeColorDepth,
  analyzeFFTBlur,
  analyzeFFTNoise,
  analyzeFFTMoire,
  analyzeFFTJpegArtifact,
  analyzeDimBackground,
  analyzeDarkShadow,
  analyzeZoneQuality,
  analyzeDirectionalBlur,
  analyzeTextGeometry,
  analyzeTextLegibility,
} from './analyzers.js';
import { computeSpectrum2D } from './fft-core.js';
import { signedLaplacian } from './laplacian.js';
import { runRegisteredFFTAnalyzers, hasFFTAnalyzers } from './fft.js';

/**
 * Run the analysis pipeline.
 *
 * - `fast` mode: resolution, fileSize, brightness, sharpness (~50-100ms)
 * - `thorough` mode: all of the above + edgeDensity, textContrast,
 *   perspective, built-in FFT analyzers, registered FFT analyzers (~200-500ms)
 *
 * If a boundaryDetector is provided, it runs first and quality analysis
 * uses the cropped document region instead of the full image.
 */
export async function runPipeline(
  buffer: Buffer,
  mode: Mode,
  thresholds: Thresholds,
  resolvedPreset: ConcretePreset,
  boundaryDetector?: BoundaryDetectorFn,
  penalties?: Partial<Record<AnalyzerName, number>>,
  options?: QualityOptions,
  builtinBounds?: (DocumentRegion & { edgesDetected?: number }) | null,
): Promise<QualityResult> {
  const t0 = performance.now();
  const timings: Timing['analyzers'] = {};
  const issues: Issue[] = [];
  let foregroundRatio: number | undefined;

  // ── 0. Boundary detection (if provided) ──────────────────────
  let boundaryResult: BoundaryResult | undefined;
  let analysisSource = buffer;

  if (boundaryDetector) {
    try {
      const result = await boundaryDetector(buffer);
      if (result) {
        boundaryResult = result;
        if (result.detected && result.croppedBuffer) {
          analysisSource = result.croppedBuffer;
        }
      }
    } catch {
      // Boundary detection is optional — swallow errors
    }
  }

  // ── 1. Metadata ──────────────────────────────────────────────
  let t = performance.now();
  const meta = await sharp(analysisSource).metadata();
  // Pixel count of the encoded file, before any crop. Bits-per-pixel has to be
  // measured against the pixels the file actually encodes, not a subregion.
  const encodedPixels = (meta.width || 0) * (meta.height || 0);

  // ── 1b. Crop to the detected document ────────────────────────
  //
  // Detection used to inform preset selection and then be thrown away, so every
  // lighting metric still saw the desk. A correctly exposed page photographed
  // on a dark surface scored 0.70 with `shadow-on-edges`; the same page cropped
  // to its own edges scores 1.00 with nothing flagged — the shadow was the
  // table. Detection declines whenever its five gates are not all satisfied,
  // and when it does fire it lands within 1% of the true rectangle.
  let croppedRegion: (DocumentRegion & { edgesDetected?: number }) | undefined;
  if (
    builtinBounds &&
    !boundaryResult &&
    options?.cropToBounds !== false &&
    isWorthCropping(builtinBounds, meta.width || 0, meta.height || 0)
  ) {
    try {
      analysisSource = await sharp(analysisSource)
        .extract({
          left: builtinBounds.x,
          top: builtinBounds.y,
          width: builtinBounds.width,
          height: builtinBounds.height,
        })
        .toBuffer();
      croppedRegion = builtinBounds;
    } catch {
      // Extraction failed — analyse the full frame rather than nothing.
    }
  }

  const analysisMeta = croppedRegion ? await sharp(analysisSource).metadata() : meta;
  const width = analysisMeta.width || 0;
  const height = analysisMeta.height || 0;
  timings.resolution = performance.now() - t;

  const imageMetadata: ImageMetadata = {
    width,
    height,
    megapixels: Math.round(((width * height) / 1_000_000) * 100) / 100,
    format: meta.format,
    fileSize: buffer.length, // Always report original file size
  };

  // ── 2. Flatten alpha (PDF renderers produce RGBA PNGs) ───────
  if (analysisMeta.hasAlpha) {
    analysisSource = await sharp(analysisSource)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .toBuffer();
  }

  // ── 3. Resize for analysis (cap memory on huge photos) ───────
  const needsResize =
    width > thresholds.analysisMaxPx || height > thresholds.analysisMaxPx;
  const analysisBuffer = needsResize
    ? await sharp(analysisSource)
        .resize(thresholds.analysisMaxPx, thresholds.analysisMaxPx, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toBuffer()
    : analysisSource;

  const ctx: AnalysisContext = {
    originalBuffer: buffer,
    analysisBuffer,
    metadata: { width, height, format: meta.format },
    // A trusted DPI (from PDF page geometry) beats whatever the file claims.
    densityAuthoritative: options?.densityOverride !== undefined,
    sharpMeta: {
      density: options?.densityOverride ?? meta.density,
      channels: meta.channels,
      space: meta.space,
      format: meta.format,
    },
  };

  // ── 4. Resolution (uses document metadata, not resized) ──────
  push(issues, analyzeResolution(ctx, thresholds));
  push(issues, analyzeResolutionMax(ctx, thresholds));

  // ── 5. File size ─────────────────────────────────────────────
  t = performance.now();
  push(issues, analyzeFileSize(ctx, thresholds));
  push(issues, analyzeFileSizeMax(ctx, thresholds));
  timings.fileSize = performance.now() - t;

  // ── 6. Stats → brightness ───────────────────────────────────
  t = performance.now();
  const stats = await sharp(analysisBuffer).stats();
  ctx.stats = stats;
  push(issues, analyzeBrightness(ctx, thresholds));
  timings.brightness = performance.now() - t;

  // ── 7. Laplacian → sharpness (+ shared data for thorough) ───
  //
  // `sharp.convolve` returns uint8, which discards the Laplacian's entire
  // negative lobe and pins anything above 255 — on a sharp page that is 4% of
  // pixels. Computing it signed keeps both, widening the sharp-to-blurred range
  // from 44x to 73x, and clipping the signed result reproduces the old buffer
  // bit for bit, so the analyzers below read identical numbers.
  //
  // It is not free: libvips convolves with SIMD, and the JS version measured
  // roughly twice its cost. In thorough and deep that barely registers, because
  // the greyscale decode it needs was already happening for greyRaw — 42ms to
  // 53ms at 1500px. In fast mode there is no such decode to share, so the step
  // would double outright, which defeats the point of the tier. Fast mode keeps
  // libvips, and features 48-51 stay NaN there.
  t = performance.now();
  let lapData: Buffer;
  let lapWidth: number;
  let lapHeight: number;

  if (mode === 'fast') {
    const lapResult = await sharp(analysisBuffer)
      .greyscale()
      .convolve({
        width: 3,
        height: 3,
        kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1],
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    lapData = lapResult.data;
    lapWidth = lapResult.info.width;
    lapHeight = lapResult.info.height;
  } else {
    const greyResult = await sharp(analysisBuffer)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    ctx.greyRaw = {
      data: greyResult.data,
      width: greyResult.info.width,
      height: greyResult.info.height,
    };

    const signed = signedLaplacian(
      greyResult.data,
      greyResult.info.width,
      greyResult.info.height,
      thresholds.laplacianEdgeThreshold,
    );
    ctx.laplacianSigned = signed;
    lapData = signed.clipped;
    lapWidth = signed.width;
    lapHeight = signed.height;
  }

  const lapLen = lapData.length;
  let lapSum = 0,
    lapSumSq = 0,
    edgeCount = 0;
  for (let i = 0; i < lapLen; i++) {
    const v = lapData[i];
    lapSum += v;
    lapSumSq += v * v;
    if (v > thresholds.laplacianEdgeThreshold) edgeCount++;
  }
  const lapMean = lapSum / lapLen;
  const lapVariance = lapSumSq / lapLen - lapMean * lapMean;

  ctx.laplacian = {
    data: lapData,
    width: lapWidth,
    height: lapHeight,
    mean: lapMean,
    variance: lapVariance,
    stdev: Math.sqrt(Math.max(0, lapVariance)),
    edgeCount,
    length: lapLen,
  };
  timings.sharpness = performance.now() - t;

  push(issues, analyzeSharpness(ctx, thresholds));

  // ── Fast-mode additions ───────────────────────────────────────
  t = performance.now();
  push(issues, analyzeDpi(ctx, thresholds));
  timings.dpi = performance.now() - t;

  t = performance.now();
  push(issues, analyzeBlankPage(ctx, thresholds));
  timings.blankPage = performance.now() - t;

  // Fast mode has no blockiness measurement, so it runs the bits-per-pixel
  // check on its own. Thorough and deep defer until the block grid is known —
  // `!== 'thorough'` let deep run it here and again below, reporting it twice.
  if (mode === 'fast') {
    t = performance.now();
    push(issues, analyzeCompression(ctx, thresholds));
    timings.compression = performance.now() - t;
  }

  // ── Thorough-only checks (deep is a superset) ────────────────
  const deep = mode === 'deep';
  if (mode === 'thorough' || deep) {
    // Edge density (reuses laplacian data — nearly free)
    t = performance.now();
    push(issues, analyzeEdgeDensity(ctx, thresholds));
    timings.edgeDensity = performance.now() - t;

    // Text contrast via binarization
    t = performance.now();
    const binarized = await sharp(analysisBuffer)
      .greyscale()
      .threshold(thresholds.binarizationThreshold)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const binData = binarized.data;
    let darkCount = 0;
    for (let i = 0; i < binData.length; i++) {
      if (binData[i] === 0) darkCount++;
    }
    foregroundRatio = darkCount / binData.length;
    push(issues, analyzeTextContrast(foregroundRatio, thresholds));
    timings.textContrast = performance.now() - t;

    // Perspective — sharpness uniformity (reuses laplacian data)
    t = performance.now();
    push(issues, analyzePerspectiveSharpness(ctx, thresholds));

    // Perspective — brightness uniformity (greyRaw was decoded for the Laplacian)
    push(issues, analyzePerspectiveBrightness(ctx, thresholds));
    timings.perspective = performance.now() - t;

    // Shadow detection (reuses greyRaw)
    t = performance.now();
    push(issues, analyzeShadow(ctx, thresholds));
    push(issues, analyzeDarkShadow(ctx, thresholds));
    timings.shadow = performance.now() - t;

    // Dim background detection (reuses greyRaw)
    t = performance.now();
    push(issues, analyzeDimBackground(ctx, thresholds));
    timings.dimBackground = performance.now() - t;

    // Zone quality (2×2 grid uniformity — reuses greyRaw + laplacian)
    t = performance.now();
    push(issues, analyzeZoneQuality(ctx, thresholds));
    timings.zoneQuality = performance.now() - t;

    // Skew detection (projection profile over greyRaw).
    // Must run before textGeometry, which deskews using ctx.skewAngle.
    t = performance.now();
    push(issues, analyzeSkew(ctx, thresholds));
    timings.skew = performance.now() - t;

    // Text geometry (crumpled/folded detection — reuses greyRaw)
    t = performance.now();
    for (const issue of analyzeTextGeometry(ctx, thresholds)) issues.push(issue);
    timings.textGeometry = performance.now() - t;

    // Color depth (reuses stats + sharpMeta)
    t = performance.now();
    push(issues, analyzeColorDepth(ctx, thresholds));
    timings.colorDepth = performance.now() - t;

    // Native-resolution greyscale. JPEGs need it so the 8x8 block grid survives
    // the downscale; deep mode needs it because stroke width and x-height are
    // exactly the detail a resize destroys. Transient: ~12 MB for a 12 MP photo.
    if (needsResize && (deep || ctx.sharpMeta?.format === 'jpeg')) {
      try {
        const fullGrey = await sharp(analysisSource)
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true });
        ctx.fullResGrey = {
          data: fullGrey.data,
          width: fullGrey.info.width,
          height: fullGrey.info.height,
        };
      } catch {
        // Decode failed — fall back to the resized pixels.
      }
    }

    // FFT spectrum computation + built-in FFT analyzers
    t = performance.now();
    ctx.fftSpectrum = computeSpectrum2D(ctx.greyRaw!.data, ctx.greyRaw!.width, ctx.greyRaw!.height, 512) ?? undefined;
    if (ctx.sharpMeta?.format === 'jpeg') {
      ctx.fftSpectrumFull = computeSpectrum2D(ctx.greyRaw!.data, ctx.greyRaw!.width, ctx.greyRaw!.height) ?? undefined;
    }
    push(issues, analyzeFFTBlur(ctx, thresholds));
    timings.fftBlur = performance.now() - t;

    t = performance.now();
    push(issues, analyzeFFTNoise(ctx, thresholds));
    timings.fftNoise = performance.now() - t;

    t = performance.now();
    push(issues, analyzeFFTMoire(ctx, thresholds));
    timings.fftMoire = performance.now() - t;

    t = performance.now();
    push(issues, analyzeFFTJpegArtifact(ctx, thresholds));
    timings.fftJpegArtifact = performance.now() - t;

    // Now that blockiness is measured, the compression check can corroborate.
    t = performance.now();
    push(issues, analyzeCompression(ctx, thresholds));
    timings.compression = performance.now() - t;

    // Directional blur (reuses fftSpectrum)
    t = performance.now();
    push(issues, analyzeDirectionalBlur(ctx, thresholds));
    timings.directionalBlur = performance.now() - t;

    // Per-text-line legibility — the deep tier's reason to exist.
    if (deep) {
      t = performance.now();
      for (const issue of analyzeTextLegibility(ctx, thresholds)) issues.push(issue);
      timings.textLines = performance.now() - t;
    }

    // Registered FFT analyzers (if any)
    if (hasFFTAnalyzers()) {
      t = performance.now();
      const fftIssues = await runRegisteredFFTAnalyzers(ctx, thresholds);
      for (const issue of fftIssues) issues.push(issue);
      // Don't overwrite built-in FFT timing — registered analyzers are additive
    }
  }

  // ── OCR confidence (optional, runs in both modes if enabled) ──
  if (options?.ocrConfidence) {
    t = performance.now();
    try {
      const { analyzeOcrConfidence } = await import('./ocr.js');
      push(
        issues,
        await analyzeOcrConfidence(
          ctx.analysisBuffer,
          thresholds.ocrConfidenceMin,
          options.ocrLanguage,
          options.ocrWorker,
        ),
      );
    } catch (err) {
      // If tesseract.js not installed, log but don't fail the pipeline
      if ((err as Error).message?.includes('tesseract.js is required')) {
        // Silently skip — user enabled OCR but didn't install the peer dep
      } else {
        throw err;
      }
    }
    timings.ocrConfidence = performance.now() - t;
  }

  // ── Score ───────────────────────────────────────────────────
  let score = 1.0;
  let usedScorer = false;

  if (options?.scorer) {
    try {
      const featureVec = extractFeatures(ctx, mode, resolvedPreset, foregroundRatio);
      const mlScore = options.scorer(featureVec, issues);
      // Validate scorer output — must be a finite number in [0, 1]
      if (Number.isFinite(mlScore)) {
        score = Math.max(0, Math.min(1, mlScore));
        usedScorer = true;
      } else {
        // Scorer returned non-finite — fall back to default scoring
        score = NaN; // will be caught by fallback below
      }
    } catch {
      // Scorer threw — fall back to default multiplicative scoring.
      // This ensures the ML layer never crashes the pipeline.
      score = NaN; // will be caught by fallback below
    }
  }

  if (!usedScorer) {
    // Default: multiplicative penalties over `error` issues only.
    // `advisory` issues are still reported and still reach the feature vector,
    // but they do not lower the score — they fire on good documents.
    score = 1.0;
    for (const issue of issues) {
      const effectivePenalty = penalties?.[issue.analyzer] ?? issue.penalty;
      issue.penalty = effectivePenalty;
      if (issue.severity === 'advisory') continue;
      score *= effectivePenalty;
    }
  } else {
    // Still apply penalty overrides for metadata purposes when scorer was used
    for (const issue of issues) {
      issue.penalty = penalties?.[issue.analyzer] ?? issue.penalty;
    }
  }

  // NaN guard — if any computation returned NaN, treat as unknown quality
  if (!Number.isFinite(score)) score = 1.0;

  const finalScore = Math.round(score * 100) / 100;

  return {
    pass: finalScore >= thresholds.passThreshold,
    score: finalScore,
    confidence: scoreConfidence(finalScore, thresholds.passThreshold),
    preset: resolvedPreset,
    issues,
    metadata: imageMetadata,
    ...(boundaryResult ? { boundary: boundaryResult } : {}),
    ...(croppedRegion
      ? {
          boundary: {
            detected: true,
            region: {
              x: croppedRegion.x,
              y: croppedRegion.y,
              width: croppedRegion.width,
              height: croppedRegion.height,
            },
            edgesDetected: croppedRegion.edgesDetected,
            confidence: 1,
            cropped: true,
          },
        }
      : {}),
    timing: {
      totalMs: Math.round(performance.now() - t0),
      analyzers: roundTimings(timings),
    },
  };
}

/**
 * Is this crop worth making?
 *
 * A region covering almost the whole frame has no desk to remove, and the
 * extract plus re-encode costs more than it saves. Guard against degenerate
 * regions here too, since a bad crop destroys every downstream measurement.
 */
function isWorthCropping(
  region: DocumentRegion & { edgesDetected?: number },
  width: number,
  height: number,
): boolean {
  if (width <= 0 || height <= 0) return false;
  // Every edge must have been found. An undetected edge falls back to the frame
  // edge, so cropping on two edges keeps the desk along the other two — and a
  // hard dark strip on one side reads as a shadow, which is worse than the
  // uncropped frame it replaced.
  if ((region.edgesDetected ?? 0) < 4) return false;
  if (region.width < 32 || region.height < 32) return false;
  if (region.x < 0 || region.y < 0) return false;
  if (region.x + region.width > width || region.y + region.height > height) return false;
  const coverage = (region.width * region.height) / (width * height);
  return coverage < 0.95;
}

/** Compute confidence based on distance from the pass threshold */
function scoreConfidence(score: number, threshold: number): 'high' | 'medium' | 'low' {
  const dist = Math.abs(score - threshold);
  if (dist >= 0.2) return 'high';
  if (dist >= 0.1) return 'medium';
  return 'low';
}

function push(issues: Issue[], issue: Issue | null): void {
  if (issue) issues.push(issue);
}

function roundTimings(
  timings: Partial<Record<AnalyzerName, number>>,
): Partial<Record<AnalyzerName, number>> {
  const result: Partial<Record<AnalyzerName, number>> = {};
  for (const [key, value] of Object.entries(timings)) {
    if (value !== undefined) {
      result[key as AnalyzerName] = Math.round(value * 100) / 100;
    }
  }
  return result;
}
