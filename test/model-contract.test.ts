import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FEATURE_NAMES } from '../src/features.js';
import { PREFLIGHT_FEATURE_NAMES } from '../src/preflight-features.js';
import { evaluateModel } from '../src/tree-eval.js';
import type { XGBModel } from '../src/tree-eval.js';

/**
 * The trainer and the runtime agree on feature *order*, not on names.
 *
 * `model_to_json` writes each split as an index into the column list it was
 * trained on, and `walkTree` reads `features[index]` from the runtime vector.
 * Nothing at load time checks that those two lists match. Insert a feature in
 * the middle of one and every tree in every exported model quietly starts
 * reading a different quantity — no error, just wrong numbers forever.
 */
const trainer = readFileSync('scripts/train-model.py', 'utf-8');

function pythonList(name: string, source: string): string[] {
  const block = new RegExp(`${name} = (?:FAST_FEATURES \\+ )?\\[(.*?)\\n\\]`, 's').exec(source);
  if (!block) throw new Error(`Could not find ${name} in train-model.py`);
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('trainer and runtime feature contract', () => {
  it('ALL_FEATURES matches FEATURE_NAMES exactly, in order', () => {
    const all = [...pythonList('FAST_FEATURES', trainer), ...pythonList('ALL_FEATURES', trainer)];
    expect(all).toEqual([...FEATURE_NAMES]);
  });

  it('FAST_FEATURES is exactly the leading block of FEATURE_NAMES', () => {
    // The fast model is evaluated against the *full* runtime vector, so its
    // columns must occupy positions 0..n-1 with nothing skipped.
    const fast = pythonList('FAST_FEATURES', trainer);
    expect(fast).toEqual([...FEATURE_NAMES].slice(0, fast.length));
  });

  it('PREFLIGHT_FEATURES matches the preflight vector exactly, in order', () => {
    expect(pythonList('PREFLIGHT_FEATURES', trainer)).toEqual([...PREFLIGHT_FEATURE_NAMES]);
  });

  it('every preflight feature is a column extractFeatures produces', () => {
    // The preflight model is trained from the same CSV. A name with no column
    // used to be dropped silently, shifting every index after it.
    for (const name of PREFLIGHT_FEATURE_NAMES) {
      expect(FEATURE_NAMES).toContain(name);
    }
  });

  it('trains a model per mode the runtime knows how to select', () => {
    for (const key of ['fast', 'thorough', 'deep', 'preflight']) {
      expect(trainer).toContain(`bundle['${key}']`);
    }
  });
});

describe('scorer model selection', () => {
  /** A model whose only job is to return a recognisable constant. */
  function constantModel(value: number): XGBModel {
    return {
      trees: [[{ split: 0, split_condition: 0.5, missing: 1,
        left: { leaf: value }, right: { leaf: value } }]],
      base_score: 0,
      objective: 'reg:squarederror',
    };
  }

  function vector(mode: 'fast' | 'thorough' | 'deep'): Float64Array {
    const values = new Float64Array(FEATURE_NAMES.length).fill(NaN);
    values[0] = 1; // megapixels — always present
    if (mode !== 'fast') values[FEATURE_NAMES.indexOf('foregroundRatio')] = 0.04;
    if (mode === 'deep') values[FEATURE_NAMES.indexOf('textLineCount')] = 40;
    return values;
  }

  it('routes a vector to the model for the mode that produced it', async () => {
    const { loadModels } = await import('../src/tree-eval.js');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const path = join(mkdtempSync(join(tmpdir(), 'doc-quality-')), 'bundle.json');
    writeFileSync(path, JSON.stringify({
      fast: constantModel(0.2),
      thorough: constantModel(0.5),
      deep: constantModel(0.9),
    }));
    const scorer = await loadModels(path);

    expect(scorer({ names: FEATURE_NAMES, values: vector('fast') }, [])).toBeCloseTo(0.2, 5);
    expect(scorer({ names: FEATURE_NAMES, values: vector('thorough') }, [])).toBeCloseTo(0.5, 5);
    expect(scorer({ names: FEATURE_NAMES, values: vector('deep') }, [])).toBeCloseTo(0.9, 5);
  });

  it('falls back to the thorough model for a deep vector when no deep model exists', async () => {
    const { loadModels } = await import('../src/tree-eval.js');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const path = join(mkdtempSync(join(tmpdir(), 'doc-quality-')), 'bundle.json');
    writeFileSync(path, JSON.stringify({ fast: constantModel(0.2), thorough: constantModel(0.5) }));
    const scorer = await loadModels(path);

    // A deep vector is a superset of a thorough one, so thorough reads it
    // correctly — it must not drop all the way to the fast model.
    expect(scorer({ names: FEATURE_NAMES, values: vector('deep') }, [])).toBeCloseTo(0.5, 5);
  });

  it('treats a deep run that found no text as deep, not thorough', async () => {
    const { loadModels } = await import('../src/tree-eval.js');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const path = join(mkdtempSync(join(tmpdir(), 'doc-quality-')), 'bundle.json');
    writeFileSync(path, JSON.stringify({ thorough: constantModel(0.5), deep: constantModel(0.9) }));
    const scorer = await loadModels(path);

    // lineCount is 0 rather than NaN precisely so these stay distinguishable:
    // a blank page analysed deeply is still a deep vector.
    const blankDeep = vector('thorough');
    blankDeep[FEATURE_NAMES.indexOf('textLineCount')] = 0;
    expect(scorer({ names: FEATURE_NAMES, values: blankDeep }, [])).toBeCloseTo(0.9, 5);
  });

  it('never throws on a malformed bundle', () => {
    expect(evaluateModel({ trees: [], base_score: 0.5, objective: 'reg:squarederror' },
      new Float64Array(FEATURE_NAMES.length))).toBe(0.5);
  });
});
