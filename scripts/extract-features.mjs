#!/usr/bin/env node
/**
 * Extract feature vectors from labeled images for ML training.
 *
 * Directory structure:
 *   test/fixtures/real/{documents,receipts,cards}/{very-good,good,bad,very-bad}/
 *
 * Each tier directory may contain a labels.json for per-file overrides:
 *   { "filename.jpg": 0.9 }
 *
 * Output: training/{document,receipt,card}-features.csv
 *
 * Usage:
 *   node scripts/extract-features.mjs
 *   node scripts/extract-features.mjs --input-dir ./my-images --output-dir ./my-training
 */

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { existsSync } from 'node:fs';

// Dynamic import so this runs after build
const { checkQuality, extractFeatures, FEATURE_NAMES } = await import('../dist/index.js');

const TIER_LABELS = {
  'very-good': 1.0,
  'good': 0.75,
  'bad': 0.25,
  'very-bad': 0.0,
};

const PRESET_MAP = {
  documents: 'document',
  receipts: 'receipt',
  cards: 'card',
};

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif', '.avif', '.heif']);

const args = process.argv.slice(2);
const inputDir = getArg(args, '--input-dir') || 'test/fixtures/real';
const outputDir = getArg(args, '--output-dir') || 'training';

function getArg(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

async function loadLabels(dir) {
  const labelsPath = join(dir, 'labels.json');
  if (existsSync(labelsPath)) {
    return JSON.parse(await readFile(labelsPath, 'utf-8'));
  }
  return {};
}

async function listImages(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && IMAGE_EXTS.has(extname(e.name).toLowerCase()))
      .map(e => join(dir, e.name));
  } catch {
    return [];
  }
}

async function main() {
  await mkdir(outputDir, { recursive: true });

  for (const [dirName, preset] of Object.entries(PRESET_MAP)) {
    const presetDir = join(inputDir, dirName);
    if (!existsSync(presetDir)) {
      console.log(`Skipping ${presetDir} (not found)`);
      continue;
    }

    const rows = [];

    for (const [tier, defaultLabel] of Object.entries(TIER_LABELS)) {
      const tierDir = join(presetDir, tier);
      const images = await listImages(tierDir);
      if (images.length === 0) continue;

      const labels = await loadLabels(tierDir);
      console.log(`Processing ${preset}/${tier}: ${images.length} images`);

      for (const imagePath of images) {
        const filename = basename(imagePath);
        const label = labels[filename] ?? defaultLabel;

        try {
          const buffer = await readFile(imagePath);

          // Extract in both modes
          for (const mode of ['fast', 'thorough']) {
            const result = await checkQuality(buffer, { mode, preset });

            // Re-run pipeline to get AnalysisContext — use internal API
            // For simplicity, we extract features from a fresh run
            // The checkQuality already ran the pipeline, but we need the context
            // Instead, we'll use a lightweight approach:
            // Run checkQuality with a custom scorer that captures the feature vector
            let featureVec = null;
            await checkQuality(buffer, {
              mode,
              preset,
              scorer: (features) => {
                featureVec = features;
                return 1.0; // dummy score
              },
            });

            if (featureVec) {
              const row = {
                path: imagePath,
                preset,
                mode,
                label,
                ...Object.fromEntries(featureVec.names.map((n, i) => [n, featureVec.values[i]])),
              };
              rows.push(row);
            }
          }
        } catch (err) {
          console.error(`  Error processing ${filename}: ${err.message}`);
        }
      }
    }

    if (rows.length === 0) {
      console.log(`No data for ${preset}`);
      continue;
    }

    // Write CSV
    const featureNames = FEATURE_NAMES;
    const header = ['path', 'preset', 'mode', 'label', ...featureNames].join(',');
    const csvRows = rows.map(row =>
      ['path', 'preset', 'mode', 'label', ...featureNames]
        .map(col => {
          const val = row[col];
          if (typeof val === 'string') return `"${val}"`;
          if (typeof val === 'number' && isNaN(val)) return '';
          return val;
        })
        .join(',')
    );

    const csv = [header, ...csvRows].join('\n');
    const outPath = join(outputDir, `${preset}-features.csv`);
    await writeFile(outPath, csv);
    console.log(`Wrote ${rows.length} rows to ${outPath}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
