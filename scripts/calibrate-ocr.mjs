#!/usr/bin/env node
/**
 * Find where OCR actually stops working, and set the cheap thresholds from that.
 *
 * The library's job is to reject a page before anyone pays to read it, which
 * means every threshold in `defaults.ts` is a guess about OCR behaviour made
 * without running OCR. This runs it — once, offline, on files you already have
 * — and prints the point at which each cheap measurement starts predicting
 * failure. The numbers that come out are evidence for a threshold; they are not
 * a threshold, because a sample that contains no distant photographs cannot
 * tell you where distance starts to hurt.
 *
 * Tesseract is deliberately not in the hot path. It costs seconds per page,
 * which is the expense the whole library exists to avoid. Here the cost does
 * not matter: it runs once, on a laptop, against files that are already graded.
 *
 * Needs the Tesseract CLI (`brew install tesseract`).
 *
 *   node scripts/calibrate-ocr.mjs <dir-or-file>... [--limit N] [--json out.json]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import sharp from 'sharp';
import { analyzeTextLines, detectDocumentBounds, detectPreset } from '../dist/index.js';

const run = promisify(execFile);
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp']);

function collect(target, out = []) {
  const s = statSync(target);
  if (s.isDirectory()) {
    for (const name of readdirSync(target)) collect(join(target, name), out);
  } else if (IMAGE.has(extname(target).toLowerCase())) {
    out.push(target);
  }
  return out;
}

/** Median word confidence Tesseract reports, 0-100, or null when it read nothing. */
async function ocrConfidence(file) {
  let stdout;
  try {
    ({ stdout } = await run('tesseract', [file, 'stdout', 'tsv'], { maxBuffer: 64 << 20 }));
  } catch {
    return null;
  }
  const confidences = [];
  for (const line of stdout.split('\n').slice(1)) {
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    if (Number.isFinite(conf) && conf >= 0 && cols[11].trim()) confidences.push(conf);
  }
  if (confidences.length < 5) return null; // too little text to judge
  confidences.sort((a, b) => a - b);
  return { median: confidences[confidences.length >> 1], words: confidences.length };
}

/** The cheap measurements, taken the way the pipeline takes them. */
async function features(file) {
  const buf = readFileSync(file);
  const meta = await sharp(buf).metadata();
  const bounds = await detectDocumentBounds(buf).catch(() => null);
  const region = bounds ?? { x: 0, y: 0, width: meta.width, height: meta.height };
  const grey = await sharp(buf)
    .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const text = analyzeTextLines(grey.data, grey.info.width, grey.info.height);
  return {
    preset: detectPreset(region.width, region.height),
    boundsFound: bounds !== null,
    regionMp: (region.width * region.height) / 1e6,
    frameFill: (region.width * region.height) / ((meta.width * meta.height) || 1),
    xHeight: text?.reliable ? text.medianXHeight : null,
    reliable: text?.reliable ?? false,
    lineCount: text?.lineCount ?? 0,
  };
}

const args = process.argv.slice(2);
const limitAt = args.indexOf('--limit');
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null;
const targets = args.filter((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--limit' && args[i - 1] !== '--json');

if (targets.length === 0) {
  console.error('usage: node scripts/calibrate-ocr.mjs <dir-or-file>... [--limit N] [--json out.json]');
  process.exit(1);
}

const files = targets.flatMap((t) => collect(t)).slice(0, limit);
console.error(`Reading ${files.length} files with Tesseract. This is the slow part.`);

const rows = [];
for (const [i, file] of files.entries()) {
  if (i % 25 === 0 && i) console.error(`  ${i}/${files.length}`);
  try {
    const [feat, ocr] = await Promise.all([features(file), ocrConfidence(file)]);
    if (!ocr) continue;
    rows.push({ file, ...feat, ocrConfidence: ocr.median, ocrWords: ocr.words });
  } catch { /* unreadable file — skip */ }
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
console.log(`\n${rows.length} of ${files.length} files produced both a measurement and an OCR read.\n`);

/** Where does OCR fall over, and does the cheap number see it coming? */
const READABLE = 75; // median word confidence Tesseract reports on text it is sure of

function report(name, pick, edges) {
  const usable = rows.filter((r) => pick(r) !== null && pick(r) !== undefined);
  if (usable.length === 0) return;
  console.log(`${name}  (${usable.length} files)`);
  console.log('  bucket'.padEnd(22) + 'n'.padStart(5) + 'median OCR conf'.padStart(18) + 'unreadable'.padStart(13));
  for (let i = 0; i < edges.length; i++) {
    const lo = i === 0 ? -Infinity : edges[i - 1];
    const hi = edges[i];
    const bucket = usable.filter((r) => pick(r) >= lo && pick(r) < hi);
    if (!bucket.length) continue;
    const confs = bucket.map((r) => r.ocrConfidence).sort((a, b) => a - b);
    const bad = bucket.filter((r) => r.ocrConfidence < READABLE).length;
    const label = i === 0 ? `< ${hi}` : `${lo} – ${hi}`;
    console.log('  ' + label.padEnd(20) + String(bucket.length).padStart(5) +
      confs[confs.length >> 1].toFixed(1).padStart(18) +
      `${bad} (${Math.round(100 * bad / bucket.length)}%)`.padStart(13));
  }
  const rest = usable.filter((r) => pick(r) >= edges[edges.length - 1]);
  if (rest.length) {
    const confs = rest.map((r) => r.ocrConfidence).sort((a, b) => a - b);
    const bad = rest.filter((r) => r.ocrConfidence < READABLE).length;
    console.log('  ' + `>= ${edges[edges.length - 1]}`.padEnd(20) + String(rest.length).padStart(5) +
      confs[confs.length >> 1].toFixed(1).padStart(18) +
      `${bad} (${Math.round(100 * bad / rest.length)}%)`.padStart(13));
  }
  console.log();
}

report('x-height of the lowercase body, in pixels', (r) => r.xHeight, [6, 8, 10, 14, 20, 30]);
report('megapixels the page itself occupies', (r) => r.regionMp, [0.15, 0.3, 0.5, 0.8, 1.5, 3]);
report('share of the frame the page fills', (r) => r.frameFill, [0.2, 0.35, 0.5, 0.7, 0.9]);

const refused = rows.filter((r) => !r.reliable);
if (refused.length) {
  const confs = refused.map((r) => r.ocrConfidence).sort((a, b) => a - b);
  const bad = refused.filter((r) => r.ocrConfidence < READABLE).length;
  console.log(`Text-line measurement refused on ${refused.length} of ${rows.length} files.`);
  console.log(`  Median OCR confidence on those: ${confs[confs.length >> 1].toFixed(1)}`);
  console.log(`  Unreadable (< ${READABLE}): ${bad} (${Math.round(100 * bad / refused.length)}%)`);
  console.log('  A refusal is not a verdict. This says what was hiding behind one.\n');
}

const noBounds = rows.filter((r) => !r.boundsFound).length;
console.log(`Boundary detection found the page in ${rows.length - noBounds} of ${rows.length} files.`);
console.log('Every region-based number above is blind to the rest.');
