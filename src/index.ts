import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { runPipeline } from './pipeline.js';
import { resolveThresholds, detectPreset } from './defaults.js';
import { detectDocumentBounds } from './boundary.js';
import type { ConcretePreset } from './defaults.js';
import type { QualityOptions, QualityResult, Issue, PageResult, AnalyzerName } from './types.js';
import { isPdf, parsePages, renderPdfPages } from './pdf.js';
import type { RenderedPage } from './pdf.js';
import { ISSUE_GUIDANCE } from './guidance.js';
import { analyzePdfContent } from './pdf-content.js';
import type { PdfPageContent, PdfPageKind, EmbeddedImage } from './pdf-content.js';

/**
 * Supported image formats (via Sharp).
 * PDF is handled separately via pdf-to-png-converter.
 */
export const SUPPORTED_FORMATS = [
  'jpeg', 'png', 'webp', 'tiff', 'gif', 'avif', 'heif', 'svg',
] as const;

/** Set for O(1) lookup */
const SUPPORTED_FORMAT_SET = new Set<string>(SUPPORTED_FORMATS);

// ── Public API ───────────────────────────────────────────────────

export type {
  QualityOptions,
  QualityResult,
  Issue,
  PageResult,
  Thresholds,
  PresetName,
  Mode,
  ImageMetadata,
  BoundaryResult,
  BoundaryDetectorFn,
  DocumentRegion,
  Timing,
  AnalyzerName,
  IssueCode,
  AnalysisContext,
  Scorer,
  ScorerFn,
} from './types.js';

export { DEFAULT_THRESHOLDS, PRESETS, resolveThresholds, detectPreset } from './defaults.js';
export { ISSUE_GUIDANCE } from './guidance.js';
export { registerFFTAnalyzer, clearFFTAnalyzers, hasFFTAnalyzers } from './fft.js';
export type { FFTAnalyzerFn } from './fft.js';
export { computeSpectrum2D } from './fft-core.js';
export type { MagnitudeSpectrum2D } from './fft-core.js';
export { isPdf, parsePages } from './pdf.js';
export { detectDocumentBounds } from './boundary.js';
export { estimateSkewAngle, gradedPenalty } from './analyzers.js';
export { analyzeTextLines, TEXT_LINE_DEFAULTS } from './text-lines.js';
export { signedLaplacian, clipToUint8 } from './laplacian.js';
export type { SignedLaplacian } from './laplacian.js';
export type { TextLine, TextLineMetrics, TextLineThresholds } from './text-lines.js';
export { analyzePdfContent } from './pdf-content.js';
export type { PdfPageContent, PdfPageKind, EmbeddedImage } from './pdf-content.js';
export type { OcrResult } from './ocr.js';
export { preflight, PREFLIGHT_DEFAULTS } from './preflight.js';
export type { PreflightResult, PreflightIssue, PreflightOptions, PreflightThresholds } from './preflight.js';
export { extractFeatures, FEATURE_NAMES } from './features.js';
export type { FeatureVector } from './features.js';
export { extractPreflightFeatures, PREFLIGHT_FEATURE_NAMES } from './preflight-features.js';
export type { PreflightFeatureVector } from './preflight-features.js';
export { loadModels, loadModelSync, loadPreflightModel, evaluateModel } from './tree-eval.js';
export type { XGBModel, ModelBundle } from './tree-eval.js';

type RenderedPages = RenderedPage[];

/** Default timeout in ms */
const DEFAULT_TIMEOUT = 10_000;

/**
 * Check image or PDF quality.
 *
 * Auto-detects PDF vs image from magic bytes. For PDFs, renders the
 * requested pages to PNG and analyzes each. For images, analyzes directly.
 *
 * @param input - Image or PDF buffer (Buffer or Uint8Array)
 * @param options - Analysis options
 * @returns Quality result with pass/fail, score, issues, and per-page breakdown for PDFs
 *
 * @example
 * ```ts
 * import { checkQuality } from 'doc-quality';
 *
 * // Image — auto-detect type
 * const result = await checkQuality(imageBuffer);
 *
 * // PDF — first page only (default)
 * const result = await checkQuality(pdfBuffer);
 *
 * // PDF — specific pages
 * const result = await checkQuality(pdfBuffer, { pages: '1,4,8-12' });
 *
 * // PDF — all pages
 * const result = await checkQuality(pdfBuffer, { pages: 'all' });
 * ```
 */
export async function checkQuality(
  input: string | URL | Buffer | Uint8Array,
  options: QualityOptions = {},
): Promise<QualityResult> {
  const buffer = await resolveInput(input);
  const {
    mode = 'fast',
    preset = 'auto',
    thresholds: overrides,
    timeout = DEFAULT_TIMEOUT,
    boundaryDetector,
    pages: pagesInput = '1',
    penalties,
    maxConcurrency,
    onPage,
    pdfStrategy = 'content',
  } = options;

  // Boundary detection only runs in thorough mode
  const useBoundary = mode === 'thorough' ? boundaryDetector : undefined;

  const run = isPdf(buffer)
    ? () => checkPdf(buffer, mode, preset, overrides, useBoundary, pagesInput, penalties, maxConcurrency, onPage, pdfStrategy, options)
    : () => checkImage(buffer, mode, preset, overrides, useBoundary, penalties, options);

  // A PDF's timeout applies per page, not to the whole document. A 20-page
  // scan legitimately takes ~18s, and a flat 10s guard would fail the entire
  // file — which, now that the timeout fails closed, means reporting perfectly
  // good pages as unreadable. Per page also contains the damage: one page that
  // hangs no longer sinks the other nineteen.
  if (timeout > 0 && !isPdf(buffer)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<QualityResult>((resolve) => {
      timer = setTimeout(() => {
        // Fail closed. A check that did not finish tells us nothing about the
        // image, so it must not report a perfect score — it previously returned
        // pass: true / score: 1, which made a slow image look flawless.
        resolve({
          pass: false,
          score: 0,
          confidence: 'low' as const,
          preset: preset === 'auto' ? 'document' : preset,
          issues: [
            {
              analyzer: 'timeout',
              code: 'analysis-timeout',
              guidance: ISSUE_GUIDANCE['analysis-timeout'],
              message: `Analysis did not finish within ${timeout} ms`,
              value: timeout,
              threshold: timeout,
              penalty: 0,
            },
          ],
          metadata: { width: 0, height: 0, megapixels: 0, fileSize: buffer.length },
          timing: { totalMs: timeout, analyzers: {} },
        });
      }, timeout);
      // Do not hold the event loop open once the real work is done.
      timer.unref?.();
    });

    try {
      return await Promise.race([run(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return run();
}

/** Resolve input to a Buffer — supports file paths, URLs (file:// and https://), Buffer, and Uint8Array */
async function resolveInput(input: string | URL | Buffer | Uint8Array): Promise<Buffer> {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (input instanceof URL) {
    if (input.protocol === 'file:') return readFile(fileURLToPath(input));
    return fetchToBuffer(input);
  }
  if (typeof input === 'string' && /^https?:\/\//i.test(input)) {
    return fetchToBuffer(input);
  }
  // string — treat as file path
  return readFile(input);
}

/** Fetch a remote URL and return as Buffer */
async function fetchToBuffer(url: string | URL): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Run tasks with a concurrency limit */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Create a reusable checker with fixed default options.
 *
 * @example
 * ```ts
 * import { createChecker } from 'doc-quality';
 *
 * const checker = createChecker({
 *   preset: 'card',
 *   mode: 'thorough',
 * });
 *
 * const r1 = await checker.check(buffer1);
 * const r2 = await checker.check(buffer2);
 * ```
 */
export function createChecker(defaults: QualityOptions = {}) {
  return {
    check(
      input: Buffer | Uint8Array,
      overrides: QualityOptions = {},
    ): Promise<QualityResult> {
      return checkQuality(input, { ...defaults, ...overrides });
    },
  };
}

// ── Internal ─────────────────────────────────────────────────────

async function checkImage(
  buffer: Buffer,
  mode: QualityOptions['mode'] & string,
  preset: QualityOptions['preset'] & string,
  overrides: QualityOptions['thresholds'],
  useBoundary: QualityOptions['boundaryDetector'],
  penalties?: Partial<Record<AnalyzerName, number>>,
  options?: QualityOptions,
): Promise<QualityResult> {
  // Validate format upfront
  const meta = await sharp(buffer).metadata();
  if (meta.format && !SUPPORTED_FORMAT_SET.has(meta.format)) {
    throw new Error(
      `Unsupported image format: "${meta.format}". Supported: ${SUPPORTED_FORMATS.join(', ')}, pdf`,
    );
  }

  // Run built-in boundary detection when enabled (default: true) and no custom detector
  const shouldDetectBounds = options?.detectBounds !== false && !useBoundary;
  const builtinBounds = shouldDetectBounds ? await detectDocumentBounds(buffer) : null;

  const resolvedPreset = await resolvePreset(buffer, preset, useBoundary, builtinBounds);
  const thresholds = resolveThresholds(resolvedPreset, overrides);
  const result = await runPipeline(
    buffer, mode, thresholds, resolvedPreset, useBoundary, penalties, options, builtinBounds,
  );

  // Report the region even when it was not used for analysis — either because
  // cropping is off, or because it already covered nearly the whole frame.
  if (builtinBounds && !result.boundary) {
    result.boundary = {
      detected: true,
      region: {
        x: builtinBounds.x,
        y: builtinBounds.y,
        width: builtinBounds.width,
        height: builtinBounds.height,
      },
      edgesDetected: builtinBounds.edgesDetected,
      confidence: 1,
      cropped: false,
    };
  }

  return result;
}

async function checkPdf(
  buffer: Buffer,
  mode: QualityOptions['mode'] & string,
  preset: QualityOptions['preset'] & string,
  overrides: QualityOptions['thresholds'],
  useBoundary: QualityOptions['boundaryDetector'],
  pagesInput: string,
  penalties?: Partial<Record<AnalyzerName, number>>,
  maxConcurrency?: number,
  onPage?: QualityOptions['onPage'],
  pdfStrategy: 'content' | 'render' = 'content',
  options?: QualityOptions,
): Promise<QualityResult> {
  const t0 = performance.now();
  const parsed = parsePages(pagesInput);

  // Preferred path: classify each page and grade its embedded images at native
  // resolution. Falls through to rasterising if pdfjs is missing or the file
  // cannot be parsed — a malformed PDF should still get a best-effort answer.
  // Parsing and extraction happen before any grading, so they need their own
  // deadline: the per-page grading timeouts below cannot help with a file that
  // makes the parser hang.
  const pageBudget = options?.timeout ?? DEFAULT_TIMEOUT;

  if (pdfStrategy === 'content') {
    try {
      const contents = await analyzePdfContent(buffer, parsed, pageBudget);
      if (contents.length > 0) {
        return await checkPdfByContent(
          buffer, contents, mode, preset, overrides, useBoundary,
          penalties, maxConcurrency, onPage, options, t0,
        );
      }
    } catch {
      // Content analysis unavailable — rasterise instead.
    }
  }

  // null distinguishes "rendering ran out of time" from "this PDF has no pages".
  // Collapsing the two would hand a timed-out file the empty-document result,
  // which passes with a perfect score.
  const rendered = await withTimeout(
    async () => (await renderPdfPages(buffer, parsed)) as RenderedPages | null,
    pageBudget,
    () => null,
  );

  if (rendered === null) {
    return {
      pass: false,
      score: 0,
      confidence: 'low' as const,
      preset: preset === 'auto' ? 'document' : (preset as ConcretePreset),
      issues: [timeoutIssue(pageBudget)],
      metadata: { width: 0, height: 0, megapixels: 0, format: 'pdf', fileSize: buffer.length },
      timing: { totalMs: Math.round(performance.now() - t0), analyzers: {} },
    };
  }

  if (rendered.length === 0) {
    return {
      pass: true,
      score: 1,
      confidence: 'high' as const,
      preset: preset === 'auto' ? 'document' : preset,
      issues: [],
      metadata: { width: 0, height: 0, megapixels: 0, fileSize: buffer.length },
      timing: { totalMs: Math.round(performance.now() - t0), analyzers: {} },
    };
  }

  // Single page — return flat result (no pageResults array)
  if (rendered.length === 1) {
    const { page, buffer: pageBuffer } = rendered[0];
    // PDFs skip the whole-document race, so the deadline has to be applied here.
    const singleTimeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const result = await withTimeout(
      () => checkImage(pageBuffer, mode, preset, overrides, useBoundary, penalties, options),
      singleTimeout,
      () => ({
        pass: false,
        score: 0,
        confidence: 'low' as const,
        preset: preset === 'auto' ? ('document' as const) : (preset as ConcretePreset),
        issues: [timeoutIssue(singleTimeout)],
        metadata: { width: 0, height: 0, megapixels: 0, format: 'pdf', fileSize: buffer.length },
        timing: { totalMs: singleTimeout, analyzers: {} },
      }),
    );
    // Tag issues with page number
    for (const issue of result.issues) issue.page = page;
    // Preserve original PDF file size
    result.metadata.fileSize = buffer.length;
    result.timing.totalMs = Math.round(performance.now() - t0);
    const pageResult: PageResult = {
      page,
      pass: result.pass,
      score: result.score,
      issues: result.issues,
    };
    onPage?.(page, rendered.length, pageResult);
    return result;
  }

  // Multi-page — run with concurrency limit, aggregate
  // Cap default concurrency at 4 to avoid excessive memory from parallel sharp pipelines
  const concurrency = maxConcurrency && maxConcurrency > 0 ? maxConcurrency : Math.min(4, rendered.length);
  const total = rendered.length;

  const perPageTimeout = options?.timeout ?? DEFAULT_TIMEOUT;

  const pageResults = await mapWithConcurrency(
    rendered,
    concurrency,
    async ({ page, buffer: pageBuffer }) => {
      const pr = await withTimeout(
        async () => {
          const result = await checkImage(
            pageBuffer, mode, preset, overrides, useBoundary, penalties, options,
          );
          return {
            page,
            pass: result.pass,
            score: result.score,
            issues: result.issues.map((issue) => ({ ...issue, page })),
          } as PageResult;
        },
        perPageTimeout,
        () => ({
          page,
          pass: false,
          score: 0,
          issues: [{ ...timeoutIssue(perPageTimeout), page }],
        } as PageResult),
      );
      onPage?.(page, total, pr);
      return pr;
    },
  );

  const allIssues: Issue[] = pageResults.flatMap((pr) => pr.issues);
  const avgScore = pageResults.reduce((sum, pr) => sum + pr.score, 0) / pageResults.length;
  const worstScore = Math.min(...pageResults.map((pr) => pr.score));

  // Use first page metadata for dimensions, but original PDF size
  const meta = await sharp(rendered[0].buffer).metadata();

  // Resolve preset from the worst-scoring page's rendered buffer
  const worstPageIdx = pageResults.findIndex((pr) => pr.score === worstScore);
  const resolvedPreset = allIssues.length > 0
    ? await resolvePreset(rendered[worstPageIdx >= 0 ? worstPageIdx : 0].buffer, preset, useBoundary)
    : preset === 'auto' ? 'document' as const : preset as ConcretePreset;

  const finalScore = Math.round(avgScore * 100) / 100;
  const threshold = resolveThresholds(resolvedPreset, overrides).passThreshold;
  const dist = Math.abs(finalScore - threshold);
  const confidence: 'high' | 'medium' | 'low' = dist >= 0.2 ? 'high' : dist >= 0.1 ? 'medium' : 'low';

  return {
    pass: pageResults.every((pr) => pr.pass),
    score: finalScore,
    confidence,
    worstPageScore: Math.round(worstScore * 100) / 100,
    preset: resolvedPreset,
    issues: allIssues,
    pageResults,
    metadata: {
      width: meta.width || 0,
      height: meta.height || 0,
      megapixels: Math.round((((meta.width || 0) * (meta.height || 0)) / 1_000_000) * 100) / 100,
      format: 'pdf',
      fileSize: buffer.length,
    },
    timing: {
      totalMs: Math.round(performance.now() - t0),
      analyzers: {},
    },
  };
}

/** Timed-out page marker — the same shape a failed analysis produces. */
function timeoutIssue(timeout: number): Issue {
  return {
    analyzer: 'timeout',
    code: 'analysis-timeout',
    guidance: ISSUE_GUIDANCE['analysis-timeout'],
    message: `Analysis did not finish within ${timeout} ms`,
    value: timeout,
    threshold: timeout,
    penalty: 0,
  };
}

/**
 * Race work against a deadline, clearing the timer either way.
 *
 * An uncleared timer holds the event loop open for its full duration after the
 * work is already done, which turned a 43 ms check into an 8 s process.
 */
async function withTimeout<T>(work: () => Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  if (ms <= 0) return work();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Grade a PDF from its content rather than its rendered pixels.
 *
 * Digital-text and empty pages pass without pixel analysis: their text layer is
 * exact, so there is no image quality to measure. Pages holding raster content
 * are graded on the embedded images themselves, at native resolution, with the
 * true scan DPI derived from how large each image is placed on the page.
 */
async function checkPdfByContent(
  buffer: Buffer,
  contents: PdfPageContent[],
  mode: QualityOptions['mode'] & string,
  preset: QualityOptions['preset'] & string,
  overrides: QualityOptions['thresholds'],
  useBoundary: QualityOptions['boundaryDetector'],
  penalties: Partial<Record<AnalyzerName, number>> | undefined,
  maxConcurrency: number | undefined,
  onPage: QualityOptions['onPage'] | undefined,
  options: QualityOptions | undefined,
  t0: number,
): Promise<QualityResult> {
  const total = contents.length;
  const concurrency = maxConcurrency && maxConcurrency > 0 ? maxConcurrency : Math.min(4, total);

  const perPageTimeout = options?.timeout ?? DEFAULT_TIMEOUT;

  const analyzed = await mapWithConcurrency(contents, concurrency, async (content) => {
    const outcome = await withTimeout(
      () => gradePage(content, mode, preset, overrides, useBoundary, penalties, options),
      perPageTimeout,
      () => ({
        pageResult: {
          page: content.page,
          pass: false,
          score: 0,
          issues: [{ ...timeoutIssue(perPageTimeout), page: content.page }],
          kind: content.kind,
        } as PageResult,
        result: null,
      }),
    );
    onPage?.(content.page, total, outcome.pageResult);
    return outcome;
  });

  const pageResults = analyzed.map((a) => a.pageResult);
  const allIssues: Issue[] = pageResults.flatMap((pr) => pr.issues);

  const avgScore = pageResults.reduce((sum, pr) => sum + pr.score, 0) / pageResults.length;
  const worstScore = Math.min(...pageResults.map((pr) => pr.score));
  const worstIdx = pageResults.findIndex((pr) => pr.score === worstScore);
  const worst = analyzed[worstIdx >= 0 ? worstIdx : 0];

  // Single page keeps the flat image-result shape callers already expect.
  if (total === 1) {
    const single = worst.result;
    if (single) {
      single.metadata.fileSize = buffer.length;
      single.timing.totalMs = Math.round(performance.now() - t0);
      single.pdfKind = worst.pageResult.kind;
      if (worst.pageResult.effectiveDpi !== undefined) {
        single.effectiveDpi = worst.pageResult.effectiveDpi;
      }
      for (const issue of single.issues) issue.page = worst.pageResult.page;
      return single;
    }
    // No image result. Either the page held nothing to measure — digital text,
    // an empty page — or the analysis failed or ran out of time. Only the first
    // case is a pass; conflating them reported a timed-out page as flawless.
    const pageResult = worst.pageResult;
    return {
      pass: pageResult.pass,
      score: pageResult.score,
      confidence: pageResult.pass ? 'high' : 'low',
      preset: preset === 'auto' ? 'document' : (preset as ConcretePreset),
      issues: pageResult.issues,
      metadata: { width: 0, height: 0, megapixels: 0, format: 'pdf', fileSize: buffer.length },
      pdfKind: pageResult.kind,
      timing: { totalMs: Math.round(performance.now() - t0), analyzers: {} },
    };
  }

  const finalScore = Math.round(avgScore * 100) / 100;
  const resolvedPreset = worst.result?.preset
    ?? (preset === 'auto' ? ('document' as const) : (preset as ConcretePreset));
  const threshold = resolveThresholds(resolvedPreset, overrides).passThreshold;
  const dist = Math.abs(finalScore - threshold);

  return {
    pass: pageResults.every((pr) => pr.pass),
    score: finalScore,
    confidence: dist >= 0.2 ? 'high' : dist >= 0.1 ? 'medium' : 'low',
    worstPageScore: Math.round(worstScore * 100) / 100,
    preset: resolvedPreset,
    issues: allIssues,
    pageResults,
    metadata: {
      width: worst.result?.metadata.width ?? 0,
      height: worst.result?.metadata.height ?? 0,
      megapixels: worst.result?.metadata.megapixels ?? 0,
      format: 'pdf',
      fileSize: buffer.length,
    },
    pdfKind: worst.pageResult.kind,
    ...(worst.pageResult.effectiveDpi !== undefined
      ? { effectiveDpi: worst.pageResult.effectiveDpi }
      : {}),
    timing: { totalMs: Math.round(performance.now() - t0), analyzers: {} },
  };
}

/** Grade one classified page. Returns the page summary plus the worst image's full result. */
async function gradePage(
  content: PdfPageContent,
  mode: QualityOptions['mode'] & string,
  preset: QualityOptions['preset'] & string,
  overrides: QualityOptions['thresholds'],
  useBoundary: QualityOptions['boundaryDetector'],
  penalties: Partial<Record<AnalyzerName, number>> | undefined,
  options: QualityOptions | undefined,
): Promise<{ pageResult: PageResult; result: QualityResult | null }> {
  if (content.kind === 'digital-text' || content.kind === 'empty' || content.images.length === 0) {
    return {
      pageResult: {
        page: content.page,
        pass: true,
        score: 1,
        issues: [],
        kind: content.kind,
        imageCount: 0,
      },
      result: null,
    };
  }

  const graded: Array<{ image: EmbeddedImage; result: QualityResult }> = [];
  for (const image of content.images) {
    try {
      const result = await checkImage(
        image.buffer, mode, preset, overrides, useBoundary, penalties,
        { ...options, densityOverride: image.effectiveDpi },
      );
      graded.push({ image, result });
    } catch {
      // A single unreadable image must not sink the whole page.
    }
  }

  if (graded.length === 0) {
    return {
      pageResult: {
        page: content.page, pass: true, score: 1, issues: [],
        kind: content.kind, imageCount: 0,
      },
      result: null,
    };
  }

  // The worst image governs the page: one unreadable photo makes the page unusable.
  graded.sort((a, b) => a.result.score - b.result.score);
  const worst = graded[0];
  const issues = graded.flatMap(({ result }) =>
    result.issues.map((issue) => ({ ...issue, page: content.page })),
  );

  return {
    pageResult: {
      page: content.page,
      pass: graded.every(({ result }) => result.pass),
      score: worst.result.score,
      issues,
      kind: content.kind,
      effectiveDpi: worst.image.effectiveDpi,
      imageCount: graded.length,
    },
    result: worst.result,
  };
}

async function resolvePreset(
  buffer: Buffer,
  preset: string,
  useBoundary: QualityOptions['boundaryDetector'],
  builtinBounds?: { x: number; y: number; width: number; height: number } | null,
): Promise<ConcretePreset> {
  if (preset !== 'auto') return preset as ConcretePreset;

  let detectWidth: number;
  let detectHeight: number;

  if (useBoundary) {
    try {
      const boundary = await useBoundary(buffer);
      if (boundary?.detected && boundary.region) {
        detectWidth = boundary.region.width;
        detectHeight = boundary.region.height;
      } else {
        const meta = await sharp(buffer).metadata();
        detectWidth = meta.width || 0;
        detectHeight = meta.height || 0;
      }
    } catch {
      const meta = await sharp(buffer).metadata();
      detectWidth = meta.width || 0;
      detectHeight = meta.height || 0;
    }
  } else if (builtinBounds) {
    detectWidth = builtinBounds.width;
    detectHeight = builtinBounds.height;
  } else {
    const meta = await sharp(buffer).metadata();
    detectWidth = meta.width || 0;
    detectHeight = meta.height || 0;
  }

  return detectPreset(detectWidth, detectHeight);
}
