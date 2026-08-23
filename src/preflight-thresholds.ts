/**
 * Preflight thresholds, kept in their own module so the backend can import them
 * without pulling in browser-only code.
 *
 * The backend enforces the monotonic guarantee against these values directly —
 * see `crossesPreflightFloor` in pipeline.ts. Loosening a number here loosens
 * the backend's hard-fail floor with it, by construction rather than by luck.
 */

export interface PreflightThresholds {
  resolutionMin: number;   // megapixels
  resolutionMax: number;   // megapixels
  fileSizeMin: number;     // bytes
  fileSizeMax: number;     // bytes
  brightnessMin: number;   // 0-255, mean across channels
  brightnessMax: number;   // 0-255
  sharpnessMin: number;    // laplacian stdev
  blankStdevMax: number;   // max channel stdev
  edgeDensityMin: number;  // ratio of edge pixels
  contrastFgMin: number;   // foreground ratio after binarization
  laplacianEdgeThreshold: number; // magnitude threshold for counting edge pixels
  binarizationThreshold: number;  // greyscale threshold for text binarization
}

/**
 * Preflight thresholds — slightly more lenient than the full backend defaults
 * to ensure the monotonic guarantee (if preflight rejects, backend also rejects).
 *
 * Most checks use tight margins (7-15%) since Canvas vs sharp pixel differences
 * are small for global statistics. Sharpness and edge density need wider margins
 * because preflight analyzes at 200px while the backend analyzes at 1500px —
 * the Laplacian produces ~0.3-0.4x the stdev at lower resolution.
 */
export const PREFLIGHT_DEFAULTS: PreflightThresholds = {
  resolutionMin: 0.28,          // Full: 0.3   →  7% margin (dimension check is exact)
  resolutionMax: 220,           // Full: 200   → 10% margin (dimension check is exact)
  fileSizeMin: 13500,           // Full: 15000 → 10% margin (byte count is exact)
  fileSizeMax: 110_000_000,     // Full: 100MB → 10% margin (byte count is exact)
  brightnessMin: 45,            // Full: 50    → 10% margin
  brightnessMax: 247,           // Full: 245   → 2pt margin
  sharpnessMin: 5,              // Full: 15    → wider margin: 200px thumbnail loses fine detail
  blankStdevMax: 1.7,           // Full: 2.0   → 15% margin
  edgeDensityMin: 0.005,        // Full: 0.015 → wider margin: 200px thumbnail loses fine edges
  contrastFgMin: 0.008,         // Full: 0.01  → 20% margin
  laplacianEdgeThreshold: 30,   // Same as backend — magnitude threshold for edge pixels
  binarizationThreshold: 128,   // Same as backend — greyscale binarization cutoff
};
