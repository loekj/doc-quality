/**
 * Pull the labeling corpus out of S3 and onto disk.
 *
 * The images are not in this repo and never were (see
 * test/fixtures/real/README.md). Feature extraction needs them locally, so
 * this fetches the manifest from a running label server - or from the
 * committed manifest.json - and mirrors every object into the category
 * folders the test fixtures already expect.
 *
 * Resumable: a file whose size already matches the object's Content-Length is
 * left alone, so a killed run picks up where it stopped rather than starting
 * over on 3.7 GB.
 *
 *   node scripts/fetch-corpus.mjs
 *   node scripts/fetch-corpus.mjs --server https://... --concurrency 24
 *   node scripts/fetch-corpus.mjs --labeled-only     # just the graded ones
 */
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEST = join(ROOT, 'test/fixtures/real');
const BUCKET = 'https://doc-quality-labeling.s3.amazonaws.com';
const DEFAULT_SERVER = 'https://labeling-service-production-6c6e.up.railway.app';

/* S3 answers a burst of parallel GETs happily; the ceiling here is the local
   disk and the link, not the bucket. 16 keeps a home connection saturated
   without stalling every request behind a slow one. */
const DEFAULT_CONCURRENCY = 16;
const RETRIES = 3;
const RETRY_BASE_MS = 400;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

async function loadManifest(server) {
  /* The server's /api/images carries the labels alongside the paths, which is
     what --labeled-only needs. The committed manifest.json is the offline
     fallback and carries paths only. */
  try {
    const res = await fetch(`${server.replace(/\/+$/, '')}/api/images`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return { entries: await res.json(), source: 'server' };
    console.warn(`Server returned ${res.status}; falling back to manifest.json`);
  } catch (err) {
    console.warn(`Server unreachable (${err.message}); falling back to manifest.json`);
  }
  const raw = JSON.parse(await readFile(join(DEST, 'manifest.json'), 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.images || [];
  return { entries, source: 'manifest.json' };
}

async function alreadyHave(dest, expectedBytes) {
  try {
    const s = await stat(dest);
    /* Size is the only cheap integrity signal S3 gives us without a second
       round trip. A truncated file from a killed run will not match. */
    return expectedBytes > 0 ? s.size === expectedBytes : s.size > 0;
  } catch {
    return false;
  }
}

async function fetchOne(path) {
  const url = `${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const dest = join(DEST, path);

  let head;
  try {
    head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
  } catch {
    head = null;
  }
  const expected = Number(head?.headers.get('content-length') || 0);
  if (await alreadyHave(dest, expected)) return { path, status: 'skipped', bytes: expected };

  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      return { path, status: 'fetched', bytes: buf.length };
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
      }
    }
  }
  return { path, status: 'failed', bytes: 0, error: lastErr?.message ?? 'unknown' };
}

async function main() {
  const server = arg('server', DEFAULT_SERVER);
  const concurrency = Number(arg('concurrency', DEFAULT_CONCURRENCY));
  const labeledOnly = hasFlag('labeled-only');

  const { entries, source } = await loadManifest(server);
  let paths = entries.map((e) => (typeof e === 'string' ? e : e.path)).filter(Boolean);
  if (labeledOnly) {
    const labeled = entries.filter((e) => e && typeof e === 'object' && e.label);
    if (!labeled.length) {
      console.error('--labeled-only needs the server manifest; it carries the labels.');
      process.exit(1);
    }
    paths = labeled.map((e) => e.path);
  }

  console.log(`Manifest from ${source}: ${paths.length} objects`);
  console.log(`Writing to ${DEST}`);
  console.log(`Concurrency ${concurrency}\n`);

  const counts = { fetched: 0, skipped: 0, failed: 0 };
  const failures = [];
  let bytes = 0;
  let done = 0;
  const started = Date.now();

  let next = 0;
  async function worker() {
    while (next < paths.length) {
      const r = await fetchOne(paths[next++]);
      counts[r.status]++;
      bytes += r.bytes;
      if (r.status === 'failed') failures.push(`${r.path}: ${r.error}`);
      if (++done % 100 === 0 || done === paths.length) {
        const mb = (bytes / 1024 / 1024).toFixed(0);
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        console.log(
          `${done}/${paths.length}  ${mb} MB  ${secs}s  ` +
            `(fetched ${counts.fetched}, skipped ${counts.skipped}, failed ${counts.failed})`
        );
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log(`\nfetched ${counts.fetched}, already had ${counts.skipped}, failed ${counts.failed}`);
  console.log(`${(bytes / 1024 / 1024).toFixed(0)} MB in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (failures.length) {
    console.log('\nFailures (re-run to retry, completed files are skipped):');
    for (const f of failures.slice(0, 20)) console.log('  ' + f);
    if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
