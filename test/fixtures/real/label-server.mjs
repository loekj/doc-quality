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
import { spawn } from 'node:child_process';

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
      if (!path) continue;
      // A null entry is an undo. Replaying it as a value would resurrect the
      // label the journal exists to have removed.
      if (entry === null) delete labels[path];
      else labels[path] = entry;
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

/**
 * Paths that are byte-identical to another path already in the queue.
 *
 * The corpus was built from overlapping public datasets, so the same photograph
 * appears in it more than once — 115 groups, and 48 of those are filed under
 * two different categories, which means the same picture is graded against two
 * different presets. Serving both wastes a rater's time on a decided image and
 * lets a train/test split put one copy on each side, where a model reciting
 * looks like a model generalising.
 *
 * Only unlabelled copies are dropped. Where a duplicate already carries a human
 * judgement it stays in the queue, because removing it would orphan that
 * judgement — `duplicates.json` records every group so a trainer can keep the
 * remaining pairs on the same side of a split.
 *
 * Regenerate with `node scripts/find-duplicates.mjs`. Absent, everything is
 * served, which is the old behaviour.
 */
async function loadDuplicateSkips(labels) {
  try {
    const raw = await readFile(join(BASE, 'duplicates.json'), 'utf-8');
    const groups = JSON.parse(raw).groups ?? [];
    const probes = pickProbeGroups(groups);
    const kept = new Set(probes.flatMap((g) => [g.canonical, ...g.duplicates]));
    const skip = new Set();
    for (const group of groups) {
      for (const path of group.duplicates ?? []) {
        if (!labels[path] && !kept.has(path)) skip.add(path);
      }
    }
    return { skip, probes };
  } catch {
    return { skip: new Set(), probes: [] };
  }
}

/**
 * Duplicate pairs deliberately left in the queue, to measure the rater.
 *
 * Every accuracy number in this project is stated as agreement with human
 * grades — and nobody knows what that number can be. Five pairs of the corpus
 * happened to get graded twice and four of them matched; the fifth read 0.40
 * against 0.55, opposite sides of the pass line. That is the entire evidence
 * base, and on it the library's 76% is either close to a ceiling or nowhere
 * near one, with no way to tell which.
 *
 * A pair costs one extra grading and buys a reading on that ceiling. Byte
 * identical, so a disagreement is the rater changing, never the image.
 *
 * Has to be seeded before a grading run, not after: repeats cannot be
 * retrofitted into a session that already happened, which is why this exists at
 * all rather than being computed later from whatever turned up.
 *
 * Selection is a fixed stride over a sorted list, so the same pairs are chosen
 * on every restart and a probe does not quietly become a normal image.
 */
const PROBE_TARGET = 40;

function pickProbeGroups(groups) {
  // Ungraded pairs only. A group already carrying a judgement is measuring
  // whoever graded it before, and there is no record of who that was.
  const eligible = groups
    .filter((g) => (g.labelled ?? []).length === 0 && (g.duplicates ?? []).length === 1)
    .sort((a, b) => a.canonical.localeCompare(b.canonical));
  if (eligible.length <= PROBE_TARGET) return eligible;
  const stride = eligible.length / PROBE_TARGET;
  return Array.from({ length: PROBE_TARGET }, (_, i) => eligible[Math.floor(i * stride)]);
}

/**
 * Push the second copy of each probe pair far from the first.
 *
 * A repeat recognised is not a repeat. The shuffle alone could seat both copies
 * within a screen of each other, so the twin is moved to roughly two thirds of
 * the way through whatever remains after the first — hundreds of images later
 * in a queue this size, and far enough that the answer comes from the picture
 * rather than from memory of the last one.
 */
function spaceProbePairs(images, probes) {
  if (probes.length === 0) return images;
  const twins = new Map();
  for (const group of probes) twins.set(group.duplicates[0], group.canonical);
  const rest = images.filter((image) => !twins.has(image.path));
  const held = images.filter((image) => twins.has(image.path));
  const out = [...rest];
  for (const image of held) {
    const firstAt = out.findIndex((i) => i.path === twins.get(image.path));
    // The first copy was dropped or never present — nothing to space against.
    if (firstAt === -1) { out.push(image); continue; }
    const target = Math.min(out.length, firstAt + Math.floor((out.length - firstAt) * 0.66) + 1);
    out.splice(target, 0, image);
  }
  return out;
}

/**
 * Order the queue so the least-graded category comes first.
 *
 * Grading drifted badly toward cards: 44% of them were done against 17% of
 * receipts, which left cards as 52% of every label while being 31% of the
 * corpus. A model trained on that learns what a bad card looks like and guesses
 * at the rest.
 *
 * Recomputed on each scan from the labels as they stand, so it corrects itself
 * — as receipts catch up they stop being served first. Within a category the
 * existing deterministic shuffle is kept, so order is still reproducible.
 */
function orderByCoverage(images, labels) {
  const byCategory = new Map();
  for (const image of images) {
    if (!byCategory.has(image.category)) byCategory.set(image.category, []);
    byCategory.get(image.category).push(image);
  }
  const coverage = (list) =>
    list.filter((image) => labels[image.path]).length / (list.length || 1);
  return [...byCategory.entries()]
    .sort((a, b) => coverage(a[1]) - coverage(b[1]) || a[0].localeCompare(b[0]))
    .flatMap(([, list]) => list);
}

/** Scan fixture directories and return image list (or use manifest for S3 mode) */
async function scanImages() {
  // Labels decide two things about the queue: which duplicates can be dropped
  // without orphaning a judgement, and which category is furthest behind.
  const labels = await loadLabels();
  const { skip, probes } = await loadDuplicateSkips(labels);
  const prepare = (images) =>
    spaceProbePairs(
      orderByCoverage(shuffleImages(images.filter((i) => !skip.has(i.path))), labels),
      probes,
    );

  // Use manifest.json if images aren't on disk (S3 mode)
  const manifestPath = join(BASE, 'manifest.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    if (manifest.length > 0) return prepare(manifest);
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
  return prepare(images);
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

/**
 * Fetch an image's bytes from wherever they live.
 *
 * On Railway the fixture folders are not in the image — .railwayignore drops
 * them and the originals are served from S3 — so reading from disk works only
 * when running locally. Both the image route and the analyze route need this,
 * and analyze used to read the disk unconditionally, which meant it could never
 * work in production.
 */
async function loadImageBytes(imgPath) {
  if (imgPath.includes('..') || imgPath.startsWith('/')) {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  }
  if (S3_BUCKET_URL) {
    const res = await fetch(`${S3_BUCKET_URL}/${imgPath}`);
    if (!res.ok) throw Object.assign(new Error(`S3 error: ${res.status}`), { status: res.status });
    return { buffer: Buffer.from(await res.arrayBuffer()), source: 's3' };
  }
  const fullPath = join(BASE, imgPath);
  if (!fullPath.startsWith(BASE)) throw Object.assign(new Error('Forbidden'), { status: 403 });
  return { buffer: await readFile(fullPath), source: 'disk' };
}

/**
 * Identify HEIF/HEIC from the bytes rather than the file extension.
 *
 * The extension is a claim, not a fact, and getting this wrong is expensive:
 * @napi-rs/canvas segfaults on HEIC (exit 139, nothing to catch), so a
 * mislabelled .jpg would take a process down.
 */
const HEIF_BRANDS = /heic|heix|hevc|hevx|mif1|msf1|heim|heis/;
function looksLikeHeif(buf) {
  if (buf.length < 16) return false;
  const head = buf.subarray(0, 32).toString('latin1');
  return head.includes('ftyp') && HEIF_BRANDS.test(head);
}

/**
 * Give the analyzers bytes they can actually decode.
 *
 * Nothing here reads HEVC: sharp reports the header then fails on the pixels
 * ("No decoding plugin installed for this compression format"), so checkQuality
 * fails on HEIC in every mode. heic-convert is pure JS and does work, which
 * makes the transcode unavoidable rather than a choice.
 *
 * It converts to PNG, not JPEG. A lossy hop would add compression damage that
 * deep mode then reports as a defect of the original — the analysis would be
 * grading our own conversion. The result records that this happened, because a
 * measurement of a transcode should never look like a measurement of the file.
 */
async function decodeForAnalysis(buf) {
  if (!looksLikeHeif(buf)) return { buffer: buf, converted: null };
  if (!heicConvert) throw new Error('HEIC image, but heic-convert is not installed — cannot decode');
  const started = Date.now();
  const out = Buffer.from(await heicConvert({ buffer: buf, format: 'PNG' }));
  return {
    buffer: out,
    converted: { from: 'heif', to: 'png', bytes: out.length, ms: Date.now() - started },
  };
}

/** Run `fn`, returning whatever it printed alongside its value. */
async function captureConsole(fn) {
  const logs = [];
  const real = {};
  for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
    real[level] = console[level];
    console[level] = (...args) => logs.push(`[${level}] ${args.map(String).join(' ')}`);
  }
  try {
    return { value: await fn(), logs };
  } finally {
    for (const level of Object.keys(real)) console[level] = real[level];
  }
}

/**
 * Run analyses one at a time.
 *
 * captureConsole swaps the global console, so two analyses in flight would
 * steal each other's output, and they would compete for CPU while the endpoint
 * is reporting per-analyzer timings. Both problems go away if only one runs.
 */
let analyzeQueue = Promise.resolve();
function serialize(fn) {
  const run = analyzeQueue.then(fn, fn);
  analyzeQueue = run.then(() => {}, () => {});
  return run;
}

/**
 * Run the browser preflight in a child process.
 *
 * @napi-rs/canvas can die natively rather than throw — HEIC segfaults it — and
 * this server exits on uncaughtException, so an in-process call would take the
 * labelling session down with it. Converting first avoids the known case; the
 * child process is what covers the next one.
 */
function runPreflightIsolated(buffer, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [join(BASE, 'preflight-worker.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // Every run reports `ms`, including the ones that fail — how long a crash
    // took to arrive is part of what someone reading this is trying to find out.
    const finish = (value) => {
      if (!settled) { settled = true; resolve({ ms: Date.now() - startedAt, ...value }); }
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `preflight timed out after ${timeoutMs}ms`, logs: [] });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); finish({ ok: false, error: err.message, logs: [] }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      try {
        finish(JSON.parse(stdout.trim().split('\n').pop()));
      } catch {
        finish({
          ok: false,
          error: signal
            ? `preflight worker killed by ${signal} — the decoder crashed natively`
            : `preflight worker exited ${code} without a result`,
          stderr: stderr.slice(0, 500) || null,
          logs: [],
        });
      }
    });
    // The child can die mid-write; that is reported by 'close', not here.
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
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
    /**
     * How consistent are the people grading?
     *
     * Reads every duplicate group that now carries two or more judgements and
     * asks whether they landed on the same side of the pass line. Split by
     * whether the same device graded both — one rater contradicting themselves
     * is a different problem from two raters disagreeing, and only the first is
     * fixable by slowing down.
     *
     * The number this produces is the ceiling. A library agreeing with humans
     * 76% of the time is close to perfect if humans agree with themselves 78%,
     * and has plenty left to give if they agree 97%. Every accuracy figure in
     * this project is uninterpretable until this has a real sample behind it.
     */
    if (pathname === '/api/agreement' && req.method === 'GET') {
      const labels = await loadLabels();
      let groups = [];
      try {
        groups = JSON.parse(await readFile(join(BASE, 'duplicates.json'), 'utf-8')).groups ?? [];
      } catch { /* no duplicate index — the report is simply empty */ }

      const pairs = [];
      for (const group of groups) {
        const graded = [group.canonical, ...(group.duplicates ?? [])]
          .filter((path) => labels[path] && labels[path].score !== null);
        if (graded.length < 2) continue;
        const entries = graded.map((path) => ({ path, ...labels[path] }));
        const verdicts = new Set(entries.map((e) => e.score >= 0.5));
        const raters = new Set(entries.map((e) => e.rater ?? 'unknown'));
        const scores = entries.map((e) => e.score);
        pairs.push({
          paths: graded,
          scores,
          spread: Math.max(...scores) - Math.min(...scores),
          agreed: verdicts.size === 1,
          sameRater: raters.size === 1 && !raters.has('unknown'),
          anonymous: raters.has('unknown'),
          crossCategory: (group.categories ?? []).length > 1,
        });
      }

      const summarise = (list) => {
        if (list.length === 0) return { pairs: 0 };
        const agreed = list.filter((p) => p.agreed).length;
        const spreads = list.map((p) => p.spread).sort((a, b) => a - b);
        return {
          pairs: list.length,
          agreedOnPassFail: agreed,
          agreementRate: Math.round((100 * agreed) / list.length) / 100,
          medianScoreSpread: spreads[spreads.length >> 1],
        };
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        note: 'Byte-identical image pairs graded more than once. This is the ceiling '
          + 'any model accuracy should be read against.',
        all: summarise(pairs),
        sameRaterTwice: summarise(pairs.filter((p) => p.sameRater)),
        differentRaters: summarise(pairs.filter((p) => !p.sameRater && !p.anonymous)),
        involvingAnonymousLabels: summarise(pairs.filter((p) => p.anonymous)),
        // The same picture offered as a receipt and as a photo picks up a
        // different preset chip, so a disagreement here may be the label
        // talking rather than the rater.
        crossCategory: summarise(pairs.filter((p) => p.crossCategory)),
        disagreements: pairs.filter((p) => !p.agreed)
          .sort((a, b) => b.spread - a.spread)
          .slice(0, 25),
      }, null, 1));
      return;
    }

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

      // "unlabeled" removes the entry rather than storing a tombstone. Undo has
      // to leave the image genuinely ungraded, or it reappears as labelled on
      // the next load and never gets looked at again.
      if (body.label === 'unlabeled') {
        delete labels[body.path];
        await saveLabels(labels, { path: body.path, entry: null });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, removed: true }));
        return;
      }

      labels[body.path] = {
        label: body.label,
        // A skip is "I am not judging this one", which is not the same as a
        // score of zero. Recording one made every skipped image train as
        // unusable; extract-features drops entries whose score is null.
        score: body.label === 'skip' ? null : (body.score ?? null),
        category: body.category ?? null,
        // Which device graded it. An opaque random string minted in the
        // browser, not a name or an account — enough to ask whether two graders
        // agree and whether one has drifted, and nothing more.
        //
        // Cannot be added after the fact: the 1340 labels collected before this
        // existed are permanently anonymous, and every hour of grading without
        // it adds more. Recorded as 'unknown' when a client does not send one,
        // so those stay distinguishable from a real cohort rather than blending
        // into whoever is grading now.
        rater: typeof body.rater === 'string' && /^r-[0-9a-f]{8}$/.test(body.rater)
          ? body.rater
          : 'unknown',
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
      try {
        ({ buffer: buf } = await loadImageBytes(imgPath));
      } catch (err) {
        res.writeHead(err.status ?? 500);
        res.end(err.message);
        return;
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

    // GET /api/analyze/:path — every verdict the library has on one image
    //
    // The four analyses disagree, and the disagreement is the interesting part:
    // one card in the corpus passes fast at 1.00, fails thorough at 0.33 and
    // fails deep at 0.03. Returning a single mode hid that.
    //
    //   ?modes=fast,deep   run a subset (default: all four)
    //   ?preset=receipt    override the preset inferred from the folder
    //   ?features=0        omit the feature vectors
    //   ?timeout=30000     per-run timeout in ms (default 60000)
    if (pathname.startsWith('/api/analyze/') && req.method === 'GET') {
      if (!checkQuality) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Analysis not available — run npm run build first' }));
        return;
      }
      const imgPath = decodeURIComponent(pathname.slice('/api/analyze/'.length));

      const qsPreset = url.searchParams.get('preset');
      const VALID_PRESETS = ['document', 'receipt', 'card'];
      let preset;
      let presetFrom;
      if (qsPreset && VALID_PRESETS.includes(qsPreset)) {
        preset = qsPreset;
        presetFrom = 'query';
      } else {
        const category = imgPath.split('/')[0];
        preset = category === 'receipts' ? 'receipt' : category === 'cards' ? 'card' : 'document';
        presetFrom = 'folder';
      }

      const ALL_RUNS = ['preflight', 'fast', 'thorough', 'deep'];
      const requested = url.searchParams.get('modes');
      const wanted = requested
        ? requested.split(',').map((m) => m.trim()).filter((m) => ALL_RUNS.includes(m))
        : ALL_RUNS;
      const wantFeatures = url.searchParams.get('features') !== '0';
      const timeout = Number(url.searchParams.get('timeout')) || 60_000;

      let loaded;
      try {
        loaded = await loadImageBytes(imgPath);
      } catch (err) {
        res.writeHead(err.status ?? 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      const payload = await serialize(async () => {
        const startedAll = Date.now();
        const runs = {};

        let bytes;
        let converted;
        try {
          ({ buffer: bytes, converted } = await decodeForAnalysis(loaded.buffer));
        } catch (err) {
          return { path: imgPath, source: loaded.source, error: err.message };
        }

        if (wanted.includes('preflight')) {
          const r = await runPreflightIsolated(bytes, timeout);
          if (!wantFeatures) delete r.features;
          runs.preflight = {
            // Not a browser. README calls preflight more lenient than the
            // backend to absorb "Canvas vs sharp measurement differences", and
            // @napi-rs/canvas is a third Canvas again — read this as a check of
            // the monotonic guarantee, never as a prediction of what Safari
            // will say.
            engine: '@napi-rs/canvas (server-side, not a real browser)',
            ...r,
          };
        }

        for (const mode of ['fast', 'thorough', 'deep']) {
          if (!wanted.includes(mode)) continue;
          const started = Date.now();
          let features = null;
          try {
            // A scorer returning a non-finite number hands back the feature
            // vector and then falls through to the real scoring, so the verdict
            // is byte-identical to a plain call. scripts/extract-features.mjs
            // uses the same trick to build training/features.csv.
            const { value: result, logs } = await captureConsole(() =>
              checkQuality(bytes, {
                mode,
                preset,
                timeout,
                scorer: (f) => { features = f; return NaN; },
              }),
            );
            runs[mode] = {
              ok: true,
              ms: Date.now() - started,
              result,
              ...(wantFeatures && features
                ? { features: Object.fromEntries(features.names.map((n, i) => [n, features.values[i]])) }
                : {}),
              logs,
            };
          } catch (err) {
            runs[mode] = {
              ok: false,
              ms: Date.now() - started,
              error: err?.message ?? String(err),
              stack: err?.stack ?? null,
              logs: [],
            };
          }
        }

        const labels = await loadLabels();
        const summary = {};
        for (const [name, run] of Object.entries(runs)) {
          summary[name] = run.ok
            ? {
                pass: run.result.pass,
                ...(run.result.score !== undefined ? { score: run.result.score } : {}),
                codes: (run.result.issues ?? [])
                  .filter((i) => i.severity !== 'advisory')
                  .map((i) => i.code),
              }
            : { error: run.error };
        }
        const verdicts = Object.values(summary).map((s) => s.pass).filter((p) => p !== undefined);

        return {
          path: imgPath,
          source: loaded.source,
          bytes: loaded.buffer.length,
          ext: extname(imgPath).toLowerCase(),
          preset,
          presetFrom,
          converted,
          label: labels[imgPath] ?? null,
          runs,
          summary: { ...summary, agree: new Set(verdicts).size <= 1 },
          totalMs: Date.now() - startedAll,
        };
      });

      res.writeHead(payload.error && !payload.runs ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
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

/**
 * Say out loud whether the duplicate index arrived.
 *
 * Without it the server still runs, and every duplicate-related feature simply
 * stops: nothing is skipped, no probes are seeded, and the queue is the full
 * manifest. That is the right way to degrade and the wrong way to do it in
 * silence — the file was left out of the Dockerfile's COPY list on its first
 * deploy and the only visible symptom was a queue 74 images longer than
 * expected, which nobody would notice.
 */
async function reportDuplicateIndex() {
  try {
    const groups = JSON.parse(await readFile(join(BASE, 'duplicates.json'), 'utf-8')).groups ?? [];
    const probes = pickProbeGroups(groups);
    console.log(
      `Duplicate index: ${groups.length} groups, ${probes.length} seeded as rater-agreement probes.`,
    );
  } catch {
    console.warn('');
    console.warn('  WARNING: duplicates.json not found.');
    console.warn('  Duplicate images will be served again and no agreement');
    console.warn('  probes are seeded, so /api/agreement stays empty. If this');
    console.warn('  is a container, check the COPY lines in the Dockerfile.');
    console.warn('  Regenerate with: node scripts/find-duplicates.mjs');
    console.warn('');
  }
}
await reportDuplicateIndex();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Labeling server running on 0.0.0.0:${PORT}`);
  console.log(`Labels file: ${LABELS_PATH}`);
});
