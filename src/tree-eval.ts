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

/** Model bundle — one model per preset × mode */
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

function walkTree(node: TreeNode, features: Float64Array): number {
  // Leaf node
  if (node.leaf !== undefined) return node.leaf;

  const featureIdx = node.split!;
  const threshold = node.split_condition!;
  const value = features[featureIdx];

  // NaN → follow `missing` direction
  if (value !== value) { // fast NaN check
    return walkTree(node.missing === 1 ? node.right! : node.left!, features);
  }

  return walkTree(value <= threshold ? node.left! : node.right!, features);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Evaluate a model on a feature vector. Returns score in [0, 1]. */
export function evaluateModel(model: XGBModel, features: Float64Array): number {
  let sum = model.base_score;

  for (const tree of model.trees) {
    // Each tree is an array of nodes — tree[0] is root
    // But our format stores trees as nested objects, so tree itself is TreeNode[]
    // where tree[0] is the root node
    sum += walkTree(tree[0], features);
  }

  if (model.objective === 'binary:logistic') {
    return sigmoid(sum);
  }

  // reg:squarederror — clamp to [0, 1]
  return Math.max(0, Math.min(1, sum));
}

/** Load model bundle from file path. Returns a Scorer that auto-selects by preset × mode. */
export async function loadModels(path: string): Promise<Scorer> {
  const raw = await readFile(path, 'utf-8');
  const bundle: ModelBundle = JSON.parse(raw);
  return createScorer(bundle);
}

/** Parse single model from JSON string. Returns a scorer function. */
export function loadModelSync(json: string): ScorerFn {
  const model: XGBModel = JSON.parse(json);
  return (features: FeatureVector) => evaluateModel(model, features.values);
}

/** Load preflight model from JSON string. Returns a preflight scorer. */
export function loadPreflightModel(json: string): PreflightScorerFn {
  const model: XGBModel = JSON.parse(json);
  return (features: PreflightFeatureVector) => evaluateModel(model, features.values);
}

function createScorer(bundle: ModelBundle): Scorer {
  const scorer = ((features: FeatureVector, _issues: Issue[]) => {
    // Auto-select model: try preset-mode first, then preset, then fallback
    // The preset and mode are encoded in the feature vector
    // presetIdx is feature 14, mode is determined by whether thorough features are present
    const presetIdx = features.values[14];
    const presetNames = ['document', 'receipt', 'card'];
    const preset = presetNames[presetIdx] ?? 'document';
    const isThorough = !isNaN(features.values[15]); // foregroundRatio is NaN in fast mode
    const mode = isThorough ? 'thorough' : 'fast';

    const key = `${preset}-${mode}`;
    const model = bundle[key];
    if (!model) {
      // Fallback: try any model for this preset, then any model
      const fallback = bundle[`${preset}-thorough`] ?? bundle[`${preset}-fast`]
        ?? Object.values(bundle)[0];
      if (!fallback) return 1.0; // No models at all
      return evaluateModel(fallback, features.values);
    }

    return evaluateModel(model, features.values);
  }) as Scorer;

  scorer.getModel = (preset: string, mode: string) => bundle[`${preset}-${mode}`];
  return scorer;
}
