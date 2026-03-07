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
} from './analyzers.js';
import { computeSpectrum2D } from './fft-core.js';
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
  const width = meta.width || 0;
  const height = meta.height || 0;
  timings.resolution = performance.now() - t;

  const imageMetadata: ImageMetadata = {
    width,
    height,
    megapixels: Math.round(((width * height) / 1_000_000) * 100) / 100,
    format: meta.format,
    fileSize: buffer.length, // Always report original file size
  };

  // ── 2. Flatten alpha (PDF renderers produce RGBA PNGs) ───────
  if (meta.hasAlpha) {
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
    sharpMeta: {
      density: meta.density,
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
  t = performance.now();
  const lapResult = await sharp(analysisBuffer)
    .greyscale()
    .convolve({
      width: 3,
      height: 3,
      kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1],
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lapData = lapResult.data;
  const lapLen = lapData.length;
  let lapSum = 0,
    lapSumSq = 0,
    edgeCount = 0;
  for (let i = 0; i < lapLen; i++) {
    const v = lapData[i];
    lapSum += v;
    lapSumSq += v * v;
    if (v > 30) edgeCount++;
  }
  const lapMean = lapSum / lapLen;
  const lapVariance = lapSumSq / lapLen - lapMean * lapMean;

  ctx.laplacian = {
    data: lapData,
    width: lapResult.info.width,
    height: lapResult.info.height,
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

  t = performance.now();
  push(issues, analyzeCompression(ctx, thresholds));
  timings.compression = performance.now() - t;

  // ── Thorough-only checks ─────────────────────────────────────
  if (mode === 'thorough') {
    // Edge density (reuses laplacian data — nearly free)
    t = performance.now();
    push(issues, analyzeEdgeDensity(ctx, thresholds));
    timings.edgeDensity = performance.now() - t;

    // Text contrast via binarization
    t = performance.now();
    const binarized = await sharp(analysisBuffer)
      .greyscale()
      .threshold(128)
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

    // Perspective — brightness uniformity
    const greyRaw = await sharp(analysisBuffer)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    ctx.greyRaw = {
      data: greyRaw.data,
      width: greyRaw.info.width,
      height: greyRaw.info.height,
    };
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

    // Skew detection (reuses laplacian)
    t = performance.now();
    push(issues, analyzeSkew(ctx, thresholds));
    timings.skew = performance.now() - t;

    // Color depth (reuses stats + sharpMeta)
    t = performance.now();
    push(issues, analyzeColorDepth(ctx, thresholds));
    timings.colorDepth = performance.now() - t;

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

    // Directional blur (reuses fftSpectrum)
    t = performance.now();
    push(issues, analyzeDirectionalBlur(ctx, thresholds));
    timings.directionalBlur = performance.now() - t;

    // Registered FFT analyzers (if any)
    if (hasFFTAnalyzers()) {
      t = performance.now();
      const fftIssues = await runRegisteredFFTAnalyzers(ctx, thresholds);
      for (const issue of fftIssues) issues.push(issue);
      const fftTime = performance.now() - t;
      if (fftIssues.some((i) => i.analyzer === 'fftBlur'))
        timings.fftBlur = fftTime;
      if (fftIssues.some((i) => i.analyzer === 'fftNoise'))
        timings.fftNoise = fftTime;
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
    // Default: multiplicative penalties (exact current behavior)
    score = 1.0;
    for (const issue of issues) {
      const effectivePenalty = penalties?.[issue.analyzer] ?? issue.penalty;
      issue.penalty = effectivePenalty;
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

  return {
    pass: score >= thresholds.passThreshold,
    score: Math.round(score * 100) / 100,
    preset: resolvedPreset,
    issues,
    metadata: imageMetadata,
    ...(boundaryResult ? { boundary: boundaryResult } : {}),
    timing: {
      totalMs: Math.round(performance.now() - t0),
      analyzers: roundTimings(timings),
    },
  };
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
