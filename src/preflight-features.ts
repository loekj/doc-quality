export const PREFLIGHT_FEATURE_NAMES: readonly string[] = [
  'megapixels', 'fileSize', 'brightnessAvg', 'brightnessStdevMax',
  'laplacianStdev', 'edgeRatio', 'foregroundRatio', 'blankStdevMax',
];

export interface PreflightFeatureVector {
  readonly names: readonly string[];
  readonly values: Float64Array;
}

export function extractPreflightFeatures(stats: {
  megapixels: number;
  fileSize: number;
  meanBrightness: number;
  maxChannelStdev: number;
  laplacianStdev: number;
  edgeDensity: number;
  foregroundRatio: number;
  maxStdev: number;
}): PreflightFeatureVector {
  const values = new Float64Array(PREFLIGHT_FEATURE_NAMES.length);
  values[0] = stats.megapixels;
  values[1] = stats.fileSize;
  values[2] = stats.meanBrightness;
  values[3] = stats.maxChannelStdev;
  values[4] = stats.laplacianStdev;
  values[5] = stats.edgeDensity;
  values[6] = stats.foregroundRatio;
  values[7] = stats.maxStdev;
  return { names: PREFLIGHT_FEATURE_NAMES, values };
}
