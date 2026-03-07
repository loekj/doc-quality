#!/usr/bin/env node

/**
 * Runs doc-quality on every file in the real fixtures directory
 * and writes the results to results.json.
 *
 * Usage:
 *   node test/fixtures/real/analyze-all.mjs [--mode thorough]
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { checkQuality } from '../../../dist/index.js';

const BASE = new URL('.', import.meta.url).pathname;
const OUT = join(BASE, 'results.json');

const { values: flags } = parseArgs({
  options: {
    mode: { type: 'string', default: 'thorough' },
  },
});

const CATEGORIES = ['documents', 'receipts', 'cards', 'photos'];
const TIERS = ['very-good', 'good', 'bad', 'very-bad', 'unsorted'];
const VALID_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.webp', '.pdf']);

const results = {};
let total = 0;
let done = 0;
let errors = 0;

// Collect all files first for progress reporting
const allFiles = [];
for (const category of CATEGORIES) {
  for (const tier of TIERS) {
    const dir = join(BASE, category, tier);
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const ext = extname(file).toLowerCase();
      if (!VALID_EXTS.has(ext)) continue;
      allFiles.push({ category, tier, file, dir });
    }
  }
}

total = allFiles.length;
console.log(`Analyzing ${total} files (mode: ${flags.mode})...\n`);

// Map preset from category
function presetFor(category) {
  if (category === 'receipts') return 'receipt';
  if (category === 'cards') return 'card';
  return 'document';
}

// Process files with concurrency limit
const CONCURRENCY = 8;
let idx = 0;

async function worker() {
  while (idx < allFiles.length) {
    const i = idx++;
    const { category, tier, file, dir } = allFiles[i];
    const filePath = join(dir, file);
    const key = `${category}/${tier}/${file}`;

    try {
      const buffer = await readFile(filePath);
      const result = await checkQuality(buffer, {
        mode: flags.mode,
        preset: presetFor(category),
        timeout: 30_000,
      });

      results[key] = {
        pass: result.pass,
        score: result.score,
        preset: result.preset,
        issues: result.issues.map((i) => ({
          analyzer: i.analyzer,
          message: i.message,
          value: Math.round(i.value * 1000) / 1000,
          threshold: i.threshold,
          penalty: i.penalty,
          ...(i.page != null ? { page: i.page } : {}),
        })),
        metadata: result.metadata,
        timing: result.timing.totalMs,
        ...(result.pageResults ? {
          pageResults: result.pageResults.map((pr) => ({
            page: pr.page,
            pass: pr.pass,
            score: pr.score,
          })),
          worstPageScore: result.worstPageScore,
        } : {}),
      };

      done++;
    } catch (e) {
      results[key] = { error: e.message };
      errors++;
      done++;
    }

    if (done % 25 === 0 || done === total) {
      process.stdout.write(`  [${done}/${total}] ${errors ? `(${errors} errors) ` : ''}${key}\n`);
    }
  }
}

const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
await Promise.all(workers);

// Sort keys for stable output
const sorted = {};
for (const key of Object.keys(results).sort()) {
  sorted[key] = results[key];
}

await writeFile(OUT, JSON.stringify(sorted, null, 2) + '\n');

// Summary
const byTier = {};
for (const [key, res] of Object.entries(sorted)) {
  const tier = key.split('/')[1];
  if (!byTier[tier]) byTier[tier] = { count: 0, pass: 0, fail: 0, errors: 0, scores: [] };
  byTier[tier].count++;
  if (res.error) {
    byTier[tier].errors++;
  } else {
    if (res.pass) byTier[tier].pass++;
    else byTier[tier].fail++;
    byTier[tier].scores.push(res.score);
  }
}

console.log('\n── Summary ──────────────────────────────────────────');
for (const tier of TIERS) {
  const t = byTier[tier];
  if (!t) continue;
  const avgScore = t.scores.length ? (t.scores.reduce((a, b) => a + b, 0) / t.scores.length).toFixed(2) : 'n/a';
  const minScore = t.scores.length ? Math.min(...t.scores).toFixed(2) : 'n/a';
  const maxScore = t.scores.length ? Math.max(...t.scores).toFixed(2) : 'n/a';
  console.log(
    `  ${tier.padEnd(10)} ${String(t.count).padStart(4)} files | pass: ${t.pass} fail: ${t.fail}${t.errors ? ` err: ${t.errors}` : ''} | score avg=${avgScore} min=${minScore} max=${maxScore}`,
  );
}

console.log(`\nResults written to ${relative(process.cwd(), OUT)}`);
