import { describe, it, expect } from 'vitest';
import { evaluateModel, loadModelSync, loadPreflightModel, loadModels } from '../src/tree-eval.js';
import type { XGBModel, TreeNode } from '../src/tree-eval.js';

// Hand-crafted 2-tree model for testing
function makeTestModel(objective: 'reg:squarederror' | 'binary:logistic' = 'reg:squarederror'): XGBModel {
  // Tree 0: if feature[0] <= 5 then 0.3 else 0.7
  const tree0: TreeNode = {
    split: 0,
    split_condition: 5,
    missing: 0, // NaN goes left
    left: { leaf: 0.3 },
    right: { leaf: 0.7 },
  };

  // Tree 1: if feature[1] <= 10 then -0.1 else 0.1
  const tree1: TreeNode = {
    split: 1,
    split_condition: 10,
    missing: 1, // NaN goes right
    left: { leaf: -0.1 },
    right: { leaf: 0.1 },
  };

  return {
    trees: [[tree0], [tree1]],
    base_score: 0.0,
    objective,
  };
}

describe('evaluateModel', () => {
  it('evaluates a simple 2-tree model correctly', () => {
    const model = makeTestModel();
    // feature[0] = 3 (<=5, go left → 0.3), feature[1] = 15 (>10, go right → 0.1)
    // sum = 0.0 + 0.3 + 0.1 = 0.4
    const features = new Float64Array([3, 15]);
    const score = evaluateModel(model, features);
    expect(score).toBeCloseTo(0.4);
  });

  it('follows right branch correctly', () => {
    const model = makeTestModel();
    // feature[0] = 8 (>5, go right → 0.7), feature[1] = 5 (<=10, go left → -0.1)
    // sum = 0.0 + 0.7 + (-0.1) = 0.6
    const features = new Float64Array([8, 5]);
    const score = evaluateModel(model, features);
    expect(score).toBeCloseTo(0.6);
  });

  it('NaN feature follows missing direction', () => {
    const model = makeTestModel();
    // feature[0] = NaN → missing=0 → go left → 0.3
    // feature[1] = NaN → missing=1 → go right → 0.1
    // sum = 0.0 + 0.3 + 0.1 = 0.4
    const features = new Float64Array([NaN, NaN]);
    const score = evaluateModel(model, features);
    expect(score).toBeCloseTo(0.4);
  });

  it('NaN feature follows correct missing direction per tree', () => {
    const model = makeTestModel();
    // feature[0] = NaN → missing=0 → go left → 0.3
    // feature[1] = 15 → go right → 0.1
    const features = new Float64Array([NaN, 15]);
    const score = evaluateModel(model, features);
    expect(score).toBeCloseTo(0.4);
  });

  it('applies sigmoid for logistic objective', () => {
    const model = makeTestModel('binary:logistic');
    // feature[0] = 3 → left → 0.3, feature[1] = 15 → right → 0.1
    // raw = 0.0 + 0.3 + 0.1 = 0.4
    // sigmoid(0.4) = 1/(1+exp(-0.4)) ≈ 0.5987
    const features = new Float64Array([3, 15]);
    const score = evaluateModel(model, features);
    const expected = 1 / (1 + Math.exp(-0.4));
    expect(score).toBeCloseTo(expected, 4);
  });

  it('clamps to [0, 1] for squarederror', () => {
    // Model that would produce negative sum
    const model: XGBModel = {
      trees: [[{ leaf: -0.5 }]],
      base_score: 0.0,
      objective: 'reg:squarederror',
    };
    const score = evaluateModel(model, new Float64Array([]));
    expect(score).toBe(0);
  });

  it('clamps above 1 for squarederror', () => {
    const model: XGBModel = {
      trees: [[{ leaf: 0.8 }]],
      base_score: 0.5,
      objective: 'reg:squarederror',
    };
    const score = evaluateModel(model, new Float64Array([]));
    expect(score).toBe(1);
  });
});

describe('evaluateModel — robustness', () => {
  it('returns 0.5 for null/undefined model', () => {
    expect(evaluateModel(null as unknown as XGBModel, new Float64Array([]))).toBe(0.5);
    expect(evaluateModel(undefined as unknown as XGBModel, new Float64Array([]))).toBe(0.5);
  });

  it('returns 0.5 for model with non-array trees', () => {
    const bad = { trees: 'not-an-array', base_score: 0, objective: 'reg:squarederror' } as unknown as XGBModel;
    expect(evaluateModel(bad, new Float64Array([1]))).toBe(0.5);
  });

  it('skips empty tree arrays gracefully', () => {
    const model: XGBModel = {
      trees: [[], [{ leaf: 0.2 }]],
      base_score: 0.3,
      objective: 'reg:squarederror',
    };
    // Only the second tree contributes: 0.3 + 0.2 = 0.5
    expect(evaluateModel(model, new Float64Array([]))).toBeCloseTo(0.5);
  });

  it('handles malformed split node (missing split/split_condition) as zero-contribution', () => {
    // Node has no leaf and no split — malformed
    const badNode: TreeNode = { left: { leaf: 0.5 }, right: { leaf: 0.9 } };
    const model: XGBModel = {
      trees: [[badNode]],
      base_score: 0.4,
      objective: 'reg:squarederror',
    };
    // Malformed node returns 0, so result = clamp(0.4 + 0) = 0.4
    expect(evaluateModel(model, new Float64Array([1]))).toBeCloseTo(0.4);
  });

  it('handles missing left/right children gracefully', () => {
    // Split node that matches left, but left child is missing
    const node: TreeNode = { split: 0, split_condition: 10, missing: 0 };
    const model: XGBModel = {
      trees: [[node]],
      base_score: 0.3,
      objective: 'reg:squarederror',
    };
    // feature[0] = 5 <= 10 → go left → left is undefined → returns 0
    expect(evaluateModel(model, new Float64Array([5]))).toBeCloseTo(0.3);
  });

  it('respects MAX_TREE_DEPTH to prevent stack overflow', () => {
    // Build a deeply nested tree (depth > 64)
    let node: TreeNode = { leaf: 0.1 };
    for (let i = 0; i < 100; i++) {
      node = { split: 0, split_condition: 1, missing: 0, left: node, right: { leaf: 0.9 } };
    }
    const model: XGBModel = {
      trees: [[node]],
      base_score: 0,
      objective: 'reg:squarederror',
    };
    // Should not throw — depth limit kicks in and returns 0
    const score = evaluateModel(model, new Float64Array([0]));
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('handles NaN base_score', () => {
    const model: XGBModel = {
      trees: [[{ leaf: 0.3 }]],
      base_score: NaN,
      objective: 'reg:squarederror',
    };
    // NaN + 0.3 = NaN → guard returns 0.5
    expect(evaluateModel(model, new Float64Array([]))).toBe(0.5);
  });

  it('handles Infinity leaf value', () => {
    const model: XGBModel = {
      trees: [[{ leaf: Infinity }]],
      base_score: 0,
      objective: 'reg:squarederror',
    };
    // 0 + Infinity = Infinity → guard returns 0.5
    expect(evaluateModel(model, new Float64Array([]))).toBe(0.5);
  });

  it('sigmoid handles extreme values without overflow', () => {
    const model: XGBModel = {
      trees: [[{ leaf: 1000 }]],
      base_score: 0,
      objective: 'binary:logistic',
    };
    const score = evaluateModel(model, new Float64Array([]));
    expect(score).toBe(1);

    const model2: XGBModel = {
      trees: [[{ leaf: -1000 }]],
      base_score: 0,
      objective: 'binary:logistic',
    };
    const score2 = evaluateModel(model2, new Float64Array([]));
    expect(score2).toBe(0);
  });
});

describe('loadModelSync — validation', () => {
  it('parses JSON and returns scorer function', () => {
    const model = makeTestModel();
    const json = JSON.stringify(model);
    const scorer = loadModelSync(json);
    expect(typeof scorer).toBe('function');

    const features = { names: ['f0', 'f1'], values: new Float64Array([3, 15]) };
    const score = scorer(features, []);
    expect(score).toBeCloseTo(0.4);
  });

  it('throws on invalid JSON', () => {
    expect(() => loadModelSync('not json')).toThrow('invalid JSON');
  });

  it('throws on missing trees array', () => {
    expect(() => loadModelSync('{"base_score": 0}')).toThrow('missing "trees" array');
  });

  it('throws on missing base_score', () => {
    expect(() => loadModelSync('{"trees": []}')).toThrow('missing or non-numeric "base_score"');
  });

  it('throws on non-object input', () => {
    expect(() => loadModelSync('"just a string"')).toThrow('expected an object');
  });
});

describe('loadPreflightModel — validation', () => {
  it('parses JSON and returns preflight scorer', () => {
    const model = makeTestModel();
    const json = JSON.stringify(model);
    const scorer = loadPreflightModel(json);
    expect(typeof scorer).toBe('function');

    const features = { names: ['f0', 'f1'], values: new Float64Array([3, 15]) };
    const score = scorer(features);
    expect(score).toBeCloseTo(0.4);
  });

  it('throws on invalid JSON', () => {
    expect(() => loadPreflightModel('{bad')).toThrow('invalid JSON');
  });
});

describe('loadModels — validation', () => {
  it('throws on missing file', async () => {
    await expect(loadModels('/nonexistent/path.json')).rejects.toThrow('Failed to read model file');
  });
});
