import type { AnalysisContext, Issue, Thresholds, AnalyzerName } from './types.js';
import { ISSUE_GUIDANCE } from './guidance.js';

/**
 * Issue shape accepted from custom FFT analyzers.
 * `code` and `guidance` are optional — if omitted, defaults to `'custom'`
 * with a generic guidance message.
 */
export type FFTAnalyzerIssue = Omit<Issue, 'code' | 'guidance'> & Partial<Pick<Issue, 'code' | 'guidance'>>;

/**
 * FFT-based analyzer function signature.
 *
 * Implement this to add frequency-domain analysis (spectral blur detection,
 * periodic noise detection, moiré pattern detection, etc.).
 *
 * Receives the shared analysis context (with raw pixel data available via
 * ctx.analysisBuffer / ctx.greyRaw) and resolved thresholds.
 */
export type FFTAnalyzerFn = (
  ctx: AnalysisContext,
  thresholds: Thresholds,
) => FFTAnalyzerIssue[] | Promise<FFTAnalyzerIssue[]>;

/** Registry of user-provided FFT analyzers */
const registry: Array<{ name: AnalyzerName; fn: FFTAnalyzerFn }> = [];

/** Ensure an FFTAnalyzerIssue has code/guidance filled in */
function normalizeIssue(issue: FFTAnalyzerIssue): Issue {
  return {
    ...issue,
    code: issue.code ?? 'custom',
    guidance: issue.guidance ?? ISSUE_GUIDANCE[issue.code ?? 'custom'] ?? ISSUE_GUIDANCE['custom'],
  };
}

/**
 * Register a custom FFT-based analyzer.
 *
 * Registered analyzers run during `'thorough'` mode after all built-in checks.
 * They receive the same analysis context as built-in analyzers, so you can
 * access raw pixel data via `ctx.greyRaw` or `ctx.analysisBuffer`.
 *
 * @example
 * ```ts
 * import { registerFFTAnalyzer } from 'doc-quality';
 *
 * // Spectral blur detection using high-frequency energy ratio
 * registerFFTAnalyzer('fftBlur', async (ctx) => {
 *   const grey = ctx.greyRaw;
 *   if (!grey) return [];
 *
 *   // 1. Apply 2D FFT to greyscale pixel data
 *   const spectrum = fft2d(grey.data, grey.width, grey.height);
 *
 *   // 2. Compute ratio of high-frequency to total energy
 *   const highFreqRatio = computeHighFreqRatio(spectrum, grey.width, grey.height);
 *
 *   if (highFreqRatio < 0.15) {
 *     return [{
 *       analyzer: 'fftBlur',
 *       message: `Low high-frequency content (${(highFreqRatio * 100).toFixed(1)}%)`,
 *       value: highFreqRatio,
 *       threshold: 0.15,
 *       penalty: 0.6,
 *     }];
 *   }
 *   return [];
 * });
 *
 * // Periodic noise / moiré detection
 * registerFFTAnalyzer('fftNoise', async (ctx) => {
 *   const grey = ctx.greyRaw;
 *   if (!grey) return [];
 *
 *   const spectrum = fft2d(grey.data, grey.width, grey.height);
 *   const spikes = detectSpectralSpikes(spectrum, grey.width, grey.height);
 *
 *   if (spikes.length > 0) {
 *     return [{
 *       analyzer: 'fftNoise',
 *       message: `Periodic noise detected (${spikes.length} spectral spikes)`,
 *       value: spikes.length,
 *       threshold: 0,
 *       penalty: 0.75,
 *     }];
 *   }
 *   return [];
 * });
 * ```
 */
export function registerFFTAnalyzer(name: AnalyzerName, fn: FFTAnalyzerFn): void {
  registry.push({ name, fn });
}

/** Run all registered FFT analyzers. Called by the pipeline in 'thorough' mode. */
export async function runRegisteredFFTAnalyzers(
  ctx: AnalysisContext,
  thresholds: Thresholds,
): Promise<Issue[]> {
  const results: Issue[] = [];
  for (const { fn } of registry) {
    try {
      const issues = await fn(ctx, thresholds);
      results.push(...issues.map(normalizeIssue));
    } catch {
      // FFT analyzers are optional — swallow errors silently
    }
  }
  return results;
}

/** Clear all registered FFT analyzers. Useful for testing. */
export function clearFFTAnalyzers(): void {
  registry.length = 0;
}

/** Check whether any FFT analyzers are registered */
export function hasFFTAnalyzers(): boolean {
  return registry.length > 0;
}
