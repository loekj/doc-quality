#!/usr/bin/env node
/**
 * Compare two builds of the library on identical images.
 *
 * Written after a differential run found, in one pass, something 364 tests had
 * missed across fourteen commits: no single issue could fail an image, because
 * every penalty sat at or above the pass threshold. Tests could not see it —
 * they were written against the same assumptions as the code. Comparing against
 * an older build has no such blind spot.
 *
 * It reports three things:
 *   - accuracy against expected verdicts, per build
 *   - verdict flips, with direction
 *   - score movements past a cutoff, where the verdict held but the number moved
 *
 * Exits non-zero when the candidate is less accurate than the baseline, so it
 * can gate a change.
 *
 * Usage:
 *   node scripts/diff-verdicts.mjs                        # against the previous commit
 *   node scripts/diff-verdicts.mjs --baseline main
 *   node scripts/diff-verdicts.mjs --baseline-dist ../old/dist
 *   node scripts/diff-verdicts.mjs --images ./corpus --labels ./corpus/labels.json
 *   node scripts/diff-verdicts.mjs --modes fast,thorough,deep
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

// ── arguments ────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const baselineRef = arg('--baseline', 'HEAD~1');
const baselineDist = arg('--baseline-dist');
const imagesDir = arg('--images');
const labelsPath = arg('--labels');
const modes = (arg('--modes', 'fast,thorough') || '').split(',').map((m) => m.trim()).filter(Boolean);
const scoreCutoff = Number(arg('--score-cutoff', '0.15'));
const preset = arg('--preset', 'auto');

// ── the battery ──────────────────────────────────────────────────

/**
 * A page of text at a given capture resolution.
 *
 * Deterministic: no randomness anywhere, so two runs of this script on the same
 * two builds produce byte-identical fixtures and any difference is the library.
 */
async function textPage(dpi, opts = {}) {
  const width = Math.round(8.27 * dpi);
  const height = Math.round(11.69 * dpi);
  const fontSize = Math.round(dpi / 9);
  const lines = Math.floor((height - dpi) / (fontSize * 1.7));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#fbfaf6"/>` +
    Array.from({ length: lines }, (_, i) =>
      `<text x="${Math.round(dpi * 0.8)}" y="${Math.round(dpi * 0.8) + i * Math.round(fontSize * 1.7)}" ` +
      `font-size="${fontSize}" font-family="Helvetica" fill="#191919">` +
      `Line ${i} invoice item description quantity 3 unit 41.20 total 123.60</text>`,
    ).join('') + '</svg>';

  let p = sharp(Buffer.from(svg)).flatten({ background: '#fbfaf6' });
  if (opts.blur) p = p.blur(opts.blur);
  if (opts.dark) p = p.modulate({ brightness: opts.dark });
  if (opts.bright) p = p.linear(opts.bright, 40);
  if (opts.rotate) {
    p = p.rotate(opts.rotate, { background: '#fbfaf6' }).flatten({ background: '#fbfaf6' });
  }
  if (opts.resize) p = p.resize(opts.resize);
  return p.jpeg({ quality: opts.q ?? 88 }).toBuffer();
}

/**
 * `shouldPass` is a judgement about synthetic pages, not ground truth. It makes
 * the report say which build is closer to a sensible answer instead of only
 * which numbers moved. Treat the accuracy figures as a direction.
 */
async function buildBattery() {
  const cases = [];
  const add = (name, buffer, shouldPass) => cases.push({ name, buffer, shouldPass });

  for (const dpi of [300, 200, 150, 120, 96]) add(`clean ${dpi}dpi`, await textPage(dpi), true);
  for (const b of [1, 2]) add(`blur ${b}`, await textPage(300, { blur: b }), true);
  for (const b of [4, 6, 9]) add(`blur ${b}`, await textPage(300, { blur: b }), false);
  add('dark 0.7', await textPage(300, { dark: 0.7 }), true);
  for (const d of [0.35, 0.15]) add(`dark ${d}`, await textPage(300, { dark: d }), false);
  for (const q of [50, 25]) add(`jpeg q${q}`, await textPage(300, { q }), true);
  for (const q of [8, 3]) add(`jpeg q${q}`, await textPage(300, { q }), false);
  for (const r of [3, 8]) add(`rotate ${r}`, await textPage(300, { rotate: r }), true);
  add('rotate 25', await textPage(300, { rotate: 25 }), false);
  for (const s of [1200, 800]) add(`resize ${s}`, await textPage(300, { resize: s }), true);
  for (const s of [400, 250]) add(`resize ${s}`, await textPage(300, { resize: s }), false);
  for (const b of [1.4, 1.8]) add(`bright x${b}`, await textPage(300, { bright: b }), false);
  add('blank', await sharp({
    create: { width: 1200, height: 1550, channels: 3, background: '#ffffff' },
  }).jpeg().toBuffer(), false);

  return cases;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif', '.pdf']);

/** Real files instead of the synthetic battery. Labels are optional. */
async function loadImages(dir, labelFile) {
  let labels = {};
  if (labelFile && existsSync(labelFile)) {
    const raw = JSON.parse(await readFile(labelFile, 'utf-8'));
    for (const [path, entry] of Object.entries(raw)) {
      const score = typeof entry === 'number' ? entry : entry?.score;
      if (score != null) labels[basename(path)] = score;
    }
  }
  const cases = [];
  const walk = async (current) => {
    for (const e of await readdir(current, { withFileTypes: true })) {
      const full = join(current, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!IMAGE_EXTS.has(extname(e.name).toLowerCase())) continue;
      const score = labels[e.name];
      cases.push({
        name: full.slice(dir.length + 1),
        buffer: await readFile(full),
        shouldPass: score == null ? null : score >= 0.5,
      });
    }
  };
  await walk(dir);
  return cases;
}

// ── baseline build ───────────────────────────────────────────────

function buildBaseline(ref) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-quality-baseline-'));
  console.log(`Building ${ref} in ${dir} ...`);
  execFileSync('git', ['worktree', 'add', '--detach', dir, ref], { stdio: 'pipe' });
  // Reuse the installed dependencies rather than a second npm install.
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'));
  execFileSync('npx', ['tsup'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

function removeBaseline(dir) {
  try { execFileSync('git', ['worktree', 'remove', dir, '--force'], { stdio: 'pipe' }); }
  catch { rmSync(dir, { recursive: true, force: true }); }
}

// ── comparison ───────────────────────────────────────────────────

async function verdicts(lib, cases, mode) {
  const out = [];
  for (const c of cases) {
    try {
      const r = await lib.checkQuality(c.buffer, { mode, preset, timeout: 0 });
      out.push({
        pass: r.pass,
        score: r.score,
        codes: (r.issues ?? []).filter((i) => i.severity !== 'advisory').map((i) => i.code),
      });
    } catch (err) {
      out.push({ pass: null, score: null, codes: [], error: err.message.slice(0, 60) });
    }
  }
  return out;
}

async function main() {
  const cases = imagesDir
    ? await loadImages(resolve(imagesDir), labelsPath)
    : await buildBattery();

  if (cases.length === 0) {
    console.log('No cases to compare.');
    process.exit(1);
  }

  let baselineDir = null;
  let baselinePath = baselineDist ? resolve(baselineDist, 'index.js') : null;
  if (!baselinePath) {
    baselineDir = buildBaseline(baselineRef);
    baselinePath = join(baselineDir, 'dist', 'index.js');
  }

  let regressed = false;
  try {
    const OLD = await import(pathToFileURL(baselinePath).href);
    const NEW = await import(pathToFileURL(resolve('dist', 'index.js')).href);

    const scored = cases.filter((c) => c.shouldPass !== null).length;
    console.log(`\n${cases.length} cases` +
      (scored ? `, ${scored} with an expected verdict` : ', no expected verdicts') +
      ` | baseline: ${baselineDist ?? baselineRef}\n`);

    for (const mode of modes) {
      const before = await verdicts(OLD, cases, mode);
      const after = await verdicts(NEW, cases, mode);

      const flips = [];
      const moved = [];
      let oldRight = 0, newRight = 0;

      cases.forEach((c, i) => {
        const o = before[i], n = after[i];
        if (c.shouldPass !== null) {
          if (o.pass === c.shouldPass) oldRight++;
          if (n.pass === c.shouldPass) newRight++;
        }
        if (o.pass !== n.pass) {
          flips.push({ name: c.name, o, n, expected: c.shouldPass });
        } else if (o.score != null && n.score != null && Math.abs(o.score - n.score) >= scoreCutoff) {
          moved.push({ name: c.name, o, n });
        }
      });

      console.log(`── ${mode} ──`);
      if (scored) {
        const pct = (v) => `${v}/${scored} (${Math.round((100 * v) / scored)}%)`;
        console.log(`   expected verdicts: baseline ${pct(oldRight)}   candidate ${pct(newRight)}`);
        if (newRight < oldRight) {
          regressed = true;
          console.log('   REGRESSION: the candidate agrees with fewer expected verdicts.');
        }
      }

      if (flips.length) {
        console.log(`   ${flips.length} verdict flip(s):`);
        for (const f of flips) {
          const dir = f.n.pass ? 'now PASSES' : 'now FAILS';
          const judged = f.expected === null ? ''
            : f.n.pass === f.expected ? '  (correct)' : '  (WRONG)';
          console.log(`     ${f.name.padEnd(24)} ${String(f.o.score).padEnd(5)} -> ` +
            `${String(f.n.score).padEnd(5)} ${dir}${judged}`);
          if (f.n.codes.length || f.o.codes.length) {
            console.log(`       was: ${f.o.codes.join(', ') || 'none'}`);
            console.log(`       now: ${f.n.codes.join(', ') || 'none'}`);
          }
        }
      } else {
        console.log('   no verdict flips');
      }

      if (moved.length) {
        console.log(`   ${moved.length} score move(s) of ${scoreCutoff} or more, verdict unchanged:`);
        for (const m of moved) {
          console.log(`     ${m.name.padEnd(24)} ${m.o.score} -> ${m.n.score}`);
        }
      }
      console.log();
    }
  } finally {
    if (baselineDir) removeBaseline(baselineDir);
  }

  if (regressed) {
    console.log('Candidate is less accurate than the baseline on the expected verdicts.');
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
