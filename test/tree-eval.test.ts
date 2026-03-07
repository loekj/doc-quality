import { describe, it, expect } from 'vitest';
import { evaluateModel, loadModelSync, loadPreflightModel } from '../src/tree-eval.js';
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

describe('loadModelSync', () => {
  it('parses JSON and returns scorer function', () => {
    const model = makeTestModel();
    const json = JSON.stringify(model);
    const scorer = loadModelSync(json);
    expect(typeof scorer).toBe('function');

    const features = { names: ['f0', 'f1'], values: new Float64Array([3, 15]) };
    const score = scorer(features, []);
    expect(score).toBeCloseTo(0.4);
  });
});

describe('loadPreflightModel', () => {
  it('parses JSON and returns preflight scorer', () => {
    const model = makeTestModel();
    const json = JSON.stringify(model);
    const scorer = loadPreflightModel(json);
    expect(typeof scorer).toBe('function');

    const features = { names: ['f0', 'f1'], values: new Float64Array([3, 15]) };
    const score = scorer(features);
    expect(score).toBeCloseTo(0.4);
  });
});
