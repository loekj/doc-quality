import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { runPipeline } from './pipeline.js';
import { resolveThresholds, detectPreset } from './defaults.js';
import { detectDocumentBounds } from './boundary.js';
import type { ConcretePreset } from './defaults.js';
import type { QualityOptions, QualityResult, Issue, PageResult, AnalyzerName } from './types.js';
import { isPdf, parsePages, renderPdfPages } from './pdf.js';

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
export type { OcrResult } from './ocr.js';
export { preflight, PREFLIGHT_DEFAULTS } from './preflight.js';
export type { PreflightResult, PreflightIssue, PreflightOptions, PreflightThresholds } from './preflight.js';
export { extractFeatures, FEATURE_NAMES } from './features.js';
export type { FeatureVector } from './features.js';
export { extractPreflightFeatures, PREFLIGHT_FEATURE_NAMES } from './preflight-features.js';
export type { PreflightFeatureVector } from './preflight-features.js';
export { loadModels, loadModelSync, loadPreflightModel, evaluateModel } from './tree-eval.js';
export type { XGBModel, ModelBundle } from './tree-eval.js';

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
  } = options;

  // Boundary detection only runs in thorough mode
  const useBoundary = mode === 'thorough' ? boundaryDetector : undefined;

  const run = isPdf(buffer)
    ? () => checkPdf(buffer, mode, preset, overrides, useBoundary, pagesInput, penalties, maxConcurrency, onPage, options)
    : () => checkImage(buffer, mode, preset, overrides, useBoundary, penalties, options);

  if (timeout > 0) {
    return Promise.race([
      run(),
      new Promise<QualityResult>((resolve) =>
        setTimeout(() => {
          resolve({
            pass: true,
            score: 1,
            preset: preset === 'auto' ? 'document' : preset,
            issues: [],
            metadata: { width: 0, height: 0, megapixels: 0, fileSize: buffer.length },
            timing: { totalMs: timeout, analyzers: {} },
          });
        }, timeout),
      ),
    ]);
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
  const result = await runPipeline(buffer, mode as 'fast' | 'thorough', thresholds, resolvedPreset, useBoundary, penalties, options);

  // Attach detected bounds to result (regardless of preset)
  if (builtinBounds && !result.boundary) {
    result.boundary = {
      detected: true,
      region: builtinBounds,
      confidence: 1,
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
  options?: QualityOptions,
): Promise<QualityResult> {
  const t0 = performance.now();
  const parsed = parsePages(pagesInput);
  const rendered = await renderPdfPages(buffer, parsed);

  if (rendered.length === 0) {
    return {
      pass: true,
      score: 1,
      preset: preset === 'auto' ? 'document' : preset,
      issues: [],
      metadata: { width: 0, height: 0, megapixels: 0, fileSize: buffer.length },
      timing: { totalMs: Math.round(performance.now() - t0), analyzers: {} },
    };
  }

  // Single page — return flat result (no pageResults array)
  if (rendered.length === 1) {
    const { page, buffer: pageBuffer } = rendered[0];
    const result = await checkImage(pageBuffer, mode, preset, overrides, useBoundary, penalties, options);
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
  const concurrency = maxConcurrency && maxConcurrency > 0 ? maxConcurrency : rendered.length;
  const total = rendered.length;

  const pageResults = await mapWithConcurrency(
    rendered,
    concurrency,
    async ({ page, buffer: pageBuffer }) => {
      const result = await checkImage(pageBuffer, mode, preset, overrides, useBoundary, penalties, options);
      const pr: PageResult = {
        page,
        pass: result.pass,
        score: result.score,
        issues: result.issues.map((issue) => ({ ...issue, page })),
      };
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

  return {
    pass: pageResults.every((pr) => pr.pass),
    score: Math.round(avgScore * 100) / 100,
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
