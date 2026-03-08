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
 * Output: training/features.csv (single file, preset is a feature column)
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

// Quartile centers: VB=0–0.25, B=0.25–0.50, G=0.50–0.75, VG=0.75–1.00
const TIER_LABELS = {
  'very-good': 0.87,
  'good': 0.62,
  'bad': 0.37,
  'very-bad': 0.12,
};

const PRESET_MAP = {
  documents: 'document',
  receipts: 'receipt',
  cards: 'card',
  photos: 'receipt',
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

/** Load the main labels.json (label-server output) from inputDir root */
async function loadMainLabels() {
  const mainLabelsPath = join(inputDir, 'labels.json');
  if (existsSync(mainLabelsPath)) {
    return JSON.parse(await readFile(mainLabelsPath, 'utf-8'));
  }
  return {};
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const mainLabels = await loadMainLabels();

  // Single unified dataset — preset is just a feature, not a separate model
  const allRows = [];

  for (const [dirName, preset] of Object.entries(PRESET_MAP)) {
    const presetDir = join(inputDir, dirName);
    if (!existsSync(presetDir)) {
      console.log(`Skipping ${presetDir} (not found)`);
      continue;
    }

    for (const [tier, defaultLabel] of Object.entries(TIER_LABELS)) {
      const tierDir = join(presetDir, tier);
      const images = await listImages(tierDir);
      if (images.length === 0) continue;

      const labels = await loadLabels(tierDir);
      console.log(`Processing ${preset}/${tier}: ${images.length} images`);

      for (const imagePath of images) {
        const filename = basename(imagePath);
        const relPath = `${dirName}/${tier}/${filename}`;

        // Priority: main labels.json score > per-tier override > tier default
        const mainEntry = mainLabels[relPath];
        const label = (mainEntry && mainEntry.score != null)
          ? mainEntry.score
          : labels[filename] ?? defaultLabel;

        try {
          const buffer = await readFile(imagePath);

          // Extract in both modes
          for (const mode of ['fast', 'thorough']) {
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
              allRows.push(row);
            }
          }
        } catch (err) {
          console.error(`  Error processing ${filename}: ${err.message}`);
        }
      }
    }
  }

  if (allRows.length === 0) {
    console.log('No data found');
    return;
  }

  // Write single unified CSV
  const featureNames = FEATURE_NAMES;
  const header = ['path', 'preset', 'mode', 'label', ...featureNames].join(',');
  const csvRows = allRows.map(row =>
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
  const outPath = join(outputDir, 'features.csv');
  await writeFile(outPath, csv);
  console.log(`\nWrote ${allRows.length} rows to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
