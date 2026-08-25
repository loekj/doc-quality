#!/usr/bin/env node

// Catch crashes early
process.on('uncaughtException', (err) => { console.error('UNCAUGHT:', err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('UNHANDLED REJECTION:', err); process.exit(1); });
console.log('Starting label-server, PORT=' + process.env.PORT + ', LABELS_PATH=' + process.env.LABELS_PATH);

/**
 * Labeling server — browser-based Tinder-style UI for rapidly
 * marking test fixtures as pass/fail.
 *
 * No npm dependencies beyond Node built-ins + the doc-quality dist.
 *
 * Usage:
 *   node test/fixtures/real/label-server.mjs
 *   # then open http://localhost:3847
 */

import { createServer } from 'node:http';
import { readdir, readFile, writeFile, appendFile, rename, mkdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let heicConvert;
try { heicConvert = (await import('heic-convert')).default; } catch (e) {
  console.warn('Warning: heic-convert not available — HEIC conversion disabled:', e.message);
}

const BASE = fileURLToPath(new URL('.', import.meta.url));
const LABELS_PATH = process.env.LABELS_PATH || join(BASE, 'labels.json');
const PORT = parseInt(process.env.PORT, 10) || 3847;
const S3_BUCKET_URL = process.env.S3_BUCKET_URL || ''; // e.g. https://doc-quality-labeling.s3.amazonaws.com

const CATEGORIES = ['documents', 'receipts', 'cards', 'photos'];
const TIERS = ['very-good', 'good', 'bad', 'very-bad', 'unsorted'];
const VALID_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.webp', '.pdf', '.heic', '.heif']);

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

/** Append-only record of every save, beside labels.json. */
const JOURNAL_PATH = LABELS_PATH.replace(/\.json$/, '') + '.jsonl';

/**
 * Load labels, falling back to the journal if the main file is missing or has
 * been corrupted by an interrupted write.
 */
async function loadLabels() {
  try {
    return JSON.parse(await readFile(LABELS_PATH, 'utf-8'));
  } catch (err) {
    const fromJournal = await replayJournal();
    if (Object.keys(fromJournal).length > 0) {
      console.warn(`labels.json unreadable (${err.code ?? err.message}); ` +
        `recovered ${Object.keys(fromJournal).length} entries from the journal`);
      return fromJournal;
    }
    return {};
  }
}

/** Rebuild the label set from the journal. Later lines win. */
async function replayJournal() {
  const labels = {};
  let text;
  try {
    text = await readFile(JOURNAL_PATH, 'utf-8');
  } catch {
    return labels;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const { path, entry } = JSON.parse(line);
      if (path) labels[path] = entry;
    } catch {
      // A torn final line is expected after a crash mid-append. Skip it.
    }
  }
  return labels;
}

/**
 * Persist labels.
 *
 * The journal is appended first and the snapshot written second, because an
 * append cannot destroy what is already there while a rewrite can: the previous
 * version was a plain writeFile, which truncates before it writes, so a crash
 * or a container stopping mid-save left an empty or half-written file and every
 * label with it. The snapshot goes to a temp file and is renamed into place,
 * which is atomic on the same filesystem.
 */
async function saveLabels(labels, changed) {
  if (changed) {
    try {
      await appendFile(JOURNAL_PATH, JSON.stringify(changed) + '\n');
    } catch (err) {
      console.warn('Journal append failed:', err.message);
    }
  }
  const tmp = `${LABELS_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(labels, null, 2) + '\n');
  await rename(tmp, LABELS_PATH);
}

/** Deterministic shuffle (Fisher-Yates with seeded PRNG) */
function shuffleImages(images) {
  const arr = [...images];
  let seed = 12345;
  for (let i = arr.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Scan fixture directories and return image list (or use manifest for S3 mode) */
async function scanImages() {
  // Use manifest.json if images aren't on disk (S3 mode)
  const manifestPath = join(BASE, 'manifest.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    if (manifest.length > 0) return shuffleImages(manifest);
  } catch {}

  // Fall back to scanning directories
  const images = [];
  for (const category of CATEGORIES) {
    for (const tier of TIERS) {
      const dir = join(BASE, category, tier);
      let files;
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files.sort()) {
        const ext = extname(file).toLowerCase();
        if (!VALID_EXTS.has(ext)) continue;
        images.push({
          path: `${category}/${tier}/${file}`,
          category,
          tier,
        });
      }
    }
  }
  return shuffleImages(images);
}

/** Read request body as string */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Attempt to lazy-import checkQuality from the dist build */
let checkQuality = null;
try {
  const mod = await import(join(BASE, '../../../dist/index.js'));
  checkQuality = mod.checkQuality;
} catch {
  console.warn('Warning: dist/index.js not found — analysis endpoint disabled. Run `npm run build` first.');
}

let cachedImages = null;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // Serve label.html at /
    if (pathname === '/' && req.method === 'GET') {
      const html = await readFile(join(BASE, 'label.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Serve review.html at /review
    if (pathname === '/review' && req.method === 'GET') {
      const html = await readFile(join(BASE, 'review.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // GET /api/images — list all images with labels
    if (pathname === '/api/images' && req.method === 'GET') {
      if (!cachedImages) cachedImages = await scanImages();
      const [images, labels] = [cachedImages, await loadLabels()];
      const result = images.map((img) => ({
        ...img,
        label: labels[img.path] ?? null,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/label — save a label
    if (pathname === '/api/label' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const labels = await loadLabels();
      labels[body.path] = {
        label: body.label,
        score: body.score ?? null,
        category: body.category ?? null,
        issues: body.issues ?? [],
        notes: body.notes ?? '',
        timestamp: new Date().toISOString(),
      };
      await saveLabels(labels, { path: body.path, entry: labels[body.path] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/image/:path — serve an image file (from S3 or local disk)
    if (pathname.startsWith('/api/image/') && req.method === 'GET') {
      const imgPath = decodeURIComponent(pathname.slice('/api/image/'.length));
      const ext = extname(imgPath).toLowerCase();
      const isHeic = ext === '.heic' || ext === '.heif';

      let buf;
      if (S3_BUCKET_URL) {
        const s3Res = await fetch(`${S3_BUCKET_URL}/${imgPath}`);
        if (!s3Res.ok) {
          res.writeHead(s3Res.status);
          res.end(`S3 error: ${s3Res.status}`);
          return;
        }
        buf = Buffer.from(await s3Res.arrayBuffer());
      } else {
        const fullPath = join(BASE, imgPath);
        if (!fullPath.startsWith(BASE)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        buf = await readFile(fullPath);
      }

      // Convert HEIC/HEIF to JPEG for browser compatibility
      if (isHeic && heicConvert) {
        buf = Buffer.from(await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.85 }));
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        res.end(buf);
        return;
      }

      const mime = MIME[ext] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
      return;
    }

    // GET /api/analyze/:path — run analysis on an image
    if (pathname.startsWith('/api/analyze/') && req.method === 'GET') {
      if (!checkQuality) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Analysis not available — run npm run build first' }));
        return;
      }
      const imgPath = decodeURIComponent(pathname.slice('/api/analyze/'.length));
      const fullPath = join(BASE, imgPath);
      if (!fullPath.startsWith(BASE)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const buffer = await readFile(fullPath);
      // Use preset from query string if provided, otherwise infer from directory
      const qsPreset = url.searchParams.get('preset');
      const VALID_PRESETS = ['document', 'receipt', 'card'];
      let preset;
      if (qsPreset && VALID_PRESETS.includes(qsPreset)) {
        preset = qsPreset;
      } else {
        const category = imgPath.split('/')[0];
        preset = category === 'receipts' ? 'receipt' : category === 'cards' ? 'card' : 'document';
      }
      const result = await checkQuality(buffer, { mode: 'thorough', preset, timeout: 30_000 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/labels — download labels.json
    if (pathname === '/api/labels' && req.method === 'GET') {
      const labels = await loadLabels();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="labels.json"',
      });
      res.end(JSON.stringify(labels, null, 2));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// Ensure labels directory exists (for volume mounts)
try { await mkdir(dirname(LABELS_PATH), { recursive: true }); } catch {}

/**
 * Say plainly whether labelling work will survive a redeploy.
 *
 * A container's filesystem is thrown away when it restarts unless a volume is
 * mounted, and Railway names that mount in RAILWAY_VOLUME_MOUNT_PATH. Writing
 * labels outside it looks like it is working right up until the moment the
 * work is gone, which is a bad way to find out.
 */
function reportDurability() {
  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!onRailway) return;
  if (volume && LABELS_PATH.startsWith(volume)) {
    console.log(`Labels are on the volume at ${volume} and survive redeploys.`);
    return;
  }
  console.warn('');
  console.warn('  WARNING: labels are NOT on a mounted volume.');
  console.warn(`  ${LABELS_PATH} lives on the container filesystem, which is`);
  console.warn('  discarded on every redeploy. Mount a volume and point');
  console.warn('  LABELS_PATH at it, and back up now:');
  console.warn('    node scripts/backup-labels.mjs <this-server-url>');
  console.warn('');
}
reportDurability();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Labeling server running on 0.0.0.0:${PORT}`);
  console.log(`Labels file: ${LABELS_PATH}`);
});
