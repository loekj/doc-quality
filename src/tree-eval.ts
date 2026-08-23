import { readFile } from 'node:fs/promises';
import type { FeatureVector } from './features.js';
import type { PreflightFeatureVector } from './preflight-features.js';
import type { Issue } from './types.js';

// ── Model types ──────────────────────────────────────────────────

export interface TreeNode {
  /** Feature index for split (leaf nodes: -1 or absent) */
  split?: number;
  /** Split threshold — go left if feature <= split_condition */
  split_condition?: number;
  /** Direction for missing (NaN) values: 0 = left, 1 = right */
  missing?: number;
  /** Left child */
  left?: TreeNode;
  /** Right child */
  right?: TreeNode;
  /** Leaf value (only on leaf nodes) */
  leaf?: number;
}

export interface XGBModel {
  trees: TreeNode[][];
  base_score: number;
  objective: 'reg:squarederror' | 'binary:logistic';
  feature_names?: string[];
}

/** Model bundle — one model per mode, preset is a feature */
export interface ModelBundle {
  [key: string]: XGBModel;
}

/** Scorer function for a single model */
export type ScorerFn = (features: FeatureVector, issues: Issue[]) => number;

/** Multi-model scorer — auto-selects model by preset × mode */
export type Scorer = ScorerFn & {
  getModel(preset: string, mode: string): XGBModel | undefined;
};

/** Preflight scorer function */
export type PreflightScorerFn = (features: PreflightFeatureVector) => number;

// ── Tree evaluation ──────────────────────────────────────────────

/** Maximum tree depth to prevent stack overflow from malformed models */
const MAX_TREE_DEPTH = 64;

function walkTree(node: TreeNode, features: Float64Array, depth: number): number {
  // Leaf node
  if (node.leaf !== undefined) return node.leaf;

  // Depth guard — prevents stack overflow from malformed/circular trees
  if (depth >= MAX_TREE_DEPTH) return 0;

  // Validate split node has required fields
  const featureIdx = node.split;
  if (featureIdx === undefined || featureIdx === null || node.split_condition === undefined) {
    return 0; // Malformed node — treat as zero-contribution leaf
  }

  const threshold = node.split_condition;
  const value = features[featureIdx];

  // NaN or out-of-bounds index → follow `missing` direction
  if (value !== value) { // fast NaN check
    const next = node.missing === 1 ? node.right : node.left;
    return next ? walkTree(next, features, depth + 1) : 0;
  }

  if (value <= threshold) {
    return node.left ? walkTree(node.left, features, depth + 1) : 0;
  }
  return node.right ? walkTree(node.right, features, depth + 1) : 0;
}

function sigmoid(x: number): number {
  // Clamp input to prevent overflow — sigmoid(-700) ≈ 0, sigmoid(700) ≈ 1
  if (x < -500) return 0;
  if (x > 500) return 1;
  return 1 / (1 + Math.exp(-x));
}

/** Evaluate a model on a feature vector. Returns score in [0, 1]. */
export function evaluateModel(model: XGBModel, features: Float64Array): number {
  if (!model || !Array.isArray(model.trees)) return 0.5; // Invalid model — neutral score

  let sum = model.base_score ?? 0.5;

  for (const tree of model.trees) {
    if (!Array.isArray(tree) || tree.length === 0 || !tree[0]) continue;
    sum += walkTree(tree[0], features, 0);
  }

  // Guard against NaN/Infinity from corrupted tree values
  if (!Number.isFinite(sum)) return 0.5;

  if (model.objective === 'binary:logistic') {
    return sigmoid(sum);
  }

  // reg:squarederror — clamp to [0, 1]
  return Math.max(0, Math.min(1, sum));
}

// ── Model validation ─────────────────────────────────────────────

function validateModel(model: unknown, label: string): XGBModel {
  if (!model || typeof model !== 'object') {
    throw new Error(`Invalid model (${label}): expected an object`);
  }
  const m = model as Record<string, unknown>;
  if (!Array.isArray(m.trees)) {
    throw new Error(`Invalid model (${label}): missing "trees" array`);
  }
  if (typeof m.base_score !== 'number') {
    throw new Error(`Invalid model (${label}): missing or non-numeric "base_score"`);
  }
  return model as XGBModel;
}

function validateBundle(raw: unknown): ModelBundle {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid model bundle: expected a JSON object with model keys');
  }
  const bundle = raw as Record<string, unknown>;
  const result: ModelBundle = {};
  for (const [key, value] of Object.entries(bundle)) {
    result[key] = validateModel(value, key);
  }
  if (Object.keys(result).length === 0) {
    throw new Error('Invalid model bundle: no models found');
  }
  return result;
}

// ── Public loaders ───────────────────────────────────────────────

/**
 * Load model bundle from file path. Returns a Scorer that auto-selects by preset × mode.
 * @throws if the file cannot be read or the JSON structure is invalid
 */
export async function loadModels(path: string): Promise<Scorer> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read model file "${path}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse model file "${path}": invalid JSON`);
  }

  const bundle = validateBundle(parsed);
  return createScorer(bundle);
}

/**
 * Parse single model from JSON string. Returns a scorer function.
 * @throws if the JSON is invalid or the model structure is malformed
 */
export function loadModelSync(json: string): ScorerFn {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Failed to parse model JSON: invalid JSON');
  }
  const model = validateModel(parsed, 'single');
  return (features: FeatureVector) => evaluateModel(model, features.values);
}

/**
 * Load preflight model from JSON string. Returns a preflight scorer.
 * @throws if the JSON is invalid or the model structure is malformed
 */
export function loadPreflightModel(json: string): PreflightScorerFn {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Failed to parse preflight model JSON: invalid JSON');
  }
  const model = validateModel(parsed, 'preflight');
  return (features: PreflightFeatureVector) => evaluateModel(model, features.values);
}

/** Feature index that is only populated in thorough and deep modes. */
const THOROUGH_MARKER = 15; // foregroundRatio
/** Feature index that is only populated in deep mode. */
const DEEP_MARKER = 42; // textLineCount

/**
 * Which mode produced this feature vector.
 *
 * Inferred from which features are present, because the vector carries no mode
 * of its own. A deep run fills the text-line block; a thorough run fills the
 * foreground ratio but not that block; a fast run fills neither.
 */
function inferMode(values: Float64Array): 'fast' | 'thorough' | 'deep' {
  if (values.length > DEEP_MARKER && !Number.isNaN(values[DEEP_MARKER])) return 'deep';
  if (values.length > THOROUGH_MARKER && !Number.isNaN(values[THOROUGH_MARKER])) return 'thorough';
  return 'fast';
}

/**
 * Which models can stand in for a mode, best first.
 *
 * A deep vector is a superset of a thorough one, so the thorough model reads it
 * correctly — the deep-only columns simply go unused. The reverse is not true:
 * handing a fast vector to a thorough model means every thorough feature
 * arrives as NaN, which XGBoost routes down its missing-value branches. That
 * still returns a number, so it is a last resort rather than a refusal.
 */
const MODEL_FALLBACKS: Record<'fast' | 'thorough' | 'deep', string[]> = {
  fast: ['fast', 'thorough', 'deep'],
  thorough: ['thorough', 'deep', 'fast'],
  deep: ['deep', 'thorough', 'fast'],
};

function createScorer(bundle: ModelBundle): Scorer {
  const scorer = ((features: FeatureVector, _issues: Issue[]) => {
    // One model per mode — preset is encoded as feature #14 (presetIdx)
    const mode = inferMode(features.values);

    for (const key of MODEL_FALLBACKS[mode]) {
      const model = bundle[key];
      if (model) return evaluateModel(model, features.values);
    }

    const any = Object.values(bundle)[0];
    if (!any) return 1.0; // No models at all — pass through
    return evaluateModel(any, features.values);
  }) as Scorer;

  scorer.getModel = (_preset: string, mode: string) => bundle[mode];
  return scorer;
}
