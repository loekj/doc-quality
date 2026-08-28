#!/usr/bin/env node
/**
 * Find byte-identical images in the labelling corpus.
 *
 * The corpus was assembled from several public datasets and they overlap, so
 * the same photograph sits in it more than once — sometimes filed under two
 * different categories, which matters because the category chooses the preset
 * and therefore the thresholds the image is graded against.
 *
 * Duplicates cost twice. A rater spends time on a picture already judged, and a
 * train/test split can put one copy on each side, which reads as a model
 * generalising when it is reciting.
 *
 * Identity is exact bytes, not perceptual similarity. Two photographs of the
 * same receipt are two data points; the same file twice is one. S3 hands out an
 * MD5 in the ETag of any object it did not receive as a multipart upload, so
 * this is a HEAD per object and no downloads. Objects with a multipart ETag are
 * reported as unchecked rather than assumed unique.
 *
 *   node scripts/find-duplicates.mjs [--bucket <url>] [--out <path>]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const BASE = fileURLToPath(new URL('../test/fixtures/real/', import.meta.url));
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const BUCKET = at('--bucket') ?? process.env.S3_BUCKET_URL
  ?? 'https://doc-quality-labeling.s3.amazonaws.com';
const OUT = at('--out') ?? join(BASE, 'duplicates.json');
const CONCURRENCY = 120;

const manifest = JSON.parse(await readFile(join(BASE, 'manifest.json'), 'utf8'));
const labelled = new Set(Object.keys(
  JSON.parse(await readFile(join(BASE, 'labels.json'), 'utf8')),
));

console.error(`Reading ${manifest.length} ETags from ${BUCKET}`);
const etags = new Map();
const unchecked = [];
let cursor = 0;
let done = 0;

async function worker() {
  while (cursor < manifest.length) {
    const entry = manifest[cursor++];
    const url = `${BUCKET.replace(/\/$/, '')}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) {
        const etag = (res.headers.get('etag') ?? '').replace(/"/g, '');
        // A dash means S3 assembled it from parts and the ETag is a digest of
        // digests, not the file's MD5. Nothing can be concluded from it.
        if (etag.includes('-') || !etag) unchecked.push(entry.path);
        else etags.set(entry.path, etag);
      }
    } catch { /* transient — the object is simply left unchecked */ }
    if (++done % 500 === 0) console.error(`  ${done}/${manifest.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const byEtag = new Map();
for (const [path, etag] of etags) {
  if (!byEtag.has(etag)) byEtag.set(etag, []);
  byEtag.get(etag).push(path);
}

const groups = [...byEtag.values()]
  .filter((paths) => paths.length > 1)
  .map((paths) => {
    // Canonical is a labelled copy where one exists, so pruning the rest never
    // orphans a human judgement. Otherwise the first, for a stable answer.
    const sorted = [...paths].sort();
    const canonical = sorted.find((p) => labelled.has(p)) ?? sorted[0];
    return {
      canonical,
      duplicates: sorted.filter((p) => p !== canonical),
      categories: [...new Set(sorted.map((p) => p.split('/')[0]))],
      labelled: sorted.filter((p) => labelled.has(p)),
    };
  })
  .sort((a, b) => a.canonical.localeCompare(b.canonical));

const redundant = groups.reduce((n, g) => n + g.duplicates.length, 0);
const crossCategory = groups.filter((g) => g.categories.length > 1);
const doubleGraded = groups.filter((g) => g.labelled.length > 1);

await writeFile(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  checked: etags.size,
  unchecked,
  groups,
}, null, 1) + '\n');

console.log(`\n${etags.size} objects checked, ${unchecked.length} unchecked (multipart ETag)`);
console.log(`  duplicate groups:            ${groups.length}`);
console.log(`  redundant copies:            ${redundant}`);
console.log(`  filed under two categories:  ${crossCategory.length}   <- graded against different presets`);
console.log(`  already graded twice:        ${doubleGraded.length}`);
for (const g of doubleGraded) {
  const scores = g.labelled.map((p) => p).join('  and  ');
  console.log(`     ${scores}`);
}
console.log(`\nwritten to ${OUT}`);
