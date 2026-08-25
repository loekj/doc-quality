#!/usr/bin/env node
/**
 * Pull the labels off the running label server and write them into the repo.
 *
 * The labels live in one file on one container. They have never been in git,
 * are not in S3, and Railway keeps a container's filesystem only when a volume
 * is mounted — so a redeploy without one takes the labelling work with it.
 * `.gitignore` already un-ignores test/fixtures/real/labels.json, so committing
 * the result is the intended destination.
 *
 * Usage:
 *   node scripts/backup-labels.mjs https://your-app.up.railway.app
 *   node scripts/backup-labels.mjs https://your-app.up.railway.app --out ./labels.json
 *   node scripts/backup-labels.mjs --from ./downloaded.json      # merge a file instead
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

const outPath = resolve(flag('--out') ?? 'test/fixtures/real/labels.json');
const fromFile = flag('--from');
const serverUrl = argv.find((a) => /^https?:\/\//.test(a));

if (!serverUrl && !fromFile) {
  console.error('Give the label server URL, or --from <file>.\n');
  console.error('  node scripts/backup-labels.mjs https://your-app.up.railway.app');
  process.exit(1);
}

/** Count how many entries carry a human score, which is what training uses. */
function summarise(labels) {
  const entries = Object.entries(labels);
  let scored = 0;
  const byCategory = {};
  for (const [path, entry] of entries) {
    const score = typeof entry === 'number' ? entry : entry?.score;
    if (score != null) scored++;
    const category = path.split('/')[0] ?? 'unknown';
    byCategory[category] = (byCategory[category] ?? 0) + 1;
  }
  return { total: entries.length, scored, byCategory };
}

async function fetchLabels(url) {
  const endpoint = url.replace(/\/+$/, '') + '/api/labels';
  console.log(`Fetching ${endpoint} ...`);
  const res = await fetch(endpoint);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} — is the server awake and is the URL right?`);
  }
  return res.json();
}

const incoming = fromFile
  ? JSON.parse(await readFile(resolve(fromFile), 'utf-8'))
  : await fetchLabels(serverUrl);

if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
  throw new Error('That did not look like a labels object.');
}

const fresh = summarise(incoming);
console.log(`\nServer has ${fresh.total} entries, ${fresh.scored} with a score`);
for (const [category, count] of Object.entries(fresh.byCategory).sort()) {
  console.log(`  ${category.padEnd(12)} ${count}`);
}

// Merge rather than replace. A local copy may hold labels the server has since
// lost, and the point of this script is that nothing gets dropped silently.
let merged = incoming;
if (existsSync(outPath)) {
  const existing = JSON.parse(await readFile(outPath, 'utf-8'));
  const before = summarise(existing);
  merged = { ...existing, ...incoming };
  const onlyLocal = Object.keys(existing).filter((k) => !(k in incoming));
  console.log(`\nExisting file has ${before.total} entries, ${before.scored} scored`);
  if (onlyLocal.length > 0) {
    console.log(`  ${onlyLocal.length} entr(ies) exist locally but not on the server — kept`);
  }
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(merged, null, 2) + '\n');

const final = summarise(merged);
console.log(`\nWrote ${final.total} entries (${final.scored} scored) to ${outPath}`);
console.log('\nCommit it — that file is currently the only copy outside the container:');
console.log(`  git add ${outPath} && git commit -m "Back up labels"`);
