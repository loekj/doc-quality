#!/usr/bin/env node

/**
 * Degrades "good" fixture images into "bad" and "very-bad" variants.
 *
 * Inspired by https://kennethghartman.com/blog/bad_scanner/
 *
 * Usage:
 *   node test/fixtures/real/degrade.mjs [--dry-run] [--seed 42]
 *
 * Degradation techniques (applied randomly per file):
 *   bad:      blur, darken, lighten, add noise, compress, skew, shrink
 *   very-bad: stacks multiple degradations aggressively
 */

import sharp from 'sharp';
import { readdir, copyFile, mkdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { parseArgs } from 'node:util';

const BASE = new URL('.', import.meta.url).pathname;

// ── Seeded PRNG (mulberry32) ────────────────────────────────────

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Degradation functions ───────────────────────────────────────

/** Gaussian blur */
async function blur(buf, rand, intensity) {
  const sigma = intensity === 'heavy' ? 6 + rand() * 6 : 3 + rand() * 3;
  return sharp(buf).blur(sigma).toBuffer();
}

/** Darken the image */
async function darken(buf, rand, intensity) {
  const factor = intensity === 'heavy' ? 0.05 + rand() * 0.15 : 0.2 + rand() * 0.25;
  return sharp(buf).modulate({ brightness: factor }).toBuffer();
}

/** Overexpose / wash out */
async function lighten(buf, rand, intensity) {
  const factor = intensity === 'heavy' ? 2.5 + rand() * 1.0 : 1.6 + rand() * 0.6;
  return sharp(buf).modulate({ brightness: factor }).toBuffer();
}

/** Reduce contrast (flatten towards grey) */
async function lowContrast(buf, rand, intensity) {
  const amount = intensity === 'heavy' ? -60 - rand() * 40 : -20 - rand() * 30;
  return sharp(buf).linear(1 + amount / 100, -amount / 2).toBuffer();
}

/** Add salt-and-pepper noise via raw pixel manipulation */
async function addNoise(buf, rand, intensity) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data);
  const density = intensity === 'heavy' ? 0.18 + rand() * 0.12 : 0.06 + rand() * 0.06;
  const count = Math.floor((pixels.length / info.channels) * density);

  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rand() * (pixels.length / info.channels)) * info.channels;
    const val = rand() > 0.5 ? 255 : 0;
    for (let c = 0; c < info.channels; c++) pixels[idx + c] = val;
  }

  return sharp(Buffer.from(pixels), { raw: { width: info.width, height: info.height, channels: info.channels } })
    .jpeg()
    .toBuffer();
}

/** Heavy JPEG compression */
async function crush(buf, rand, intensity) {
  const quality = intensity === 'heavy' ? 1 + Math.floor(rand() * 1) : 1 + Math.floor(rand() * 4);
  return sharp(buf).jpeg({ quality }).toBuffer();
}

/** Shrink to very low resolution */
async function shrink(buf, rand, intensity) {
  const scale = intensity === 'heavy' ? 0.02 + rand() * 0.04 : 0.08 + rand() * 0.1;
  const meta = await sharp(buf).metadata();
  const w = Math.max(10, Math.round(meta.width * scale));
  return sharp(buf).resize(w).jpeg().toBuffer();
}

/** Rotate / skew slightly */
async function skew(buf, rand, intensity) {
  const angle = intensity === 'heavy' ? 8 + rand() * 20 : 2 + rand() * 6;
  const dir = rand() > 0.5 ? 1 : -1;
  return sharp(buf).rotate(angle * dir, { background: { r: 240, g: 240, b: 240 } }).toBuffer();
}

/** Add dark edges (shadow simulation) */
async function addShadow(buf, rand, intensity) {
  const meta = await sharp(buf).metadata();
  const w = meta.width;
  const h = meta.height;
  const stripFrac = intensity === 'heavy' ? 0.25 : 0.15;
  const stripW = Math.round(w * stripFrac);
  const opacity = intensity === 'heavy' ? 0.7 + rand() * 0.2 : 0.3 + rand() * 0.3;

  // Create a dark gradient overlay on the left edge
  const shadow = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: stripW, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: Math.round(opacity * 255) } },
        })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();

  return sharp(buf).composite([{ input: shadow, blend: 'over' }]).jpeg().toBuffer();
}

/** Simulate dust spots */
async function addDust(buf, rand, intensity) {
  const meta = await sharp(buf).metadata();
  const w = meta.width;
  const h = meta.height;
  const count = intensity === 'heavy' ? 30 + Math.floor(rand() * 40) : 5 + Math.floor(rand() * 15);

  const spots = [];
  for (let i = 0; i < count; i++) {
    const r = 1 + Math.floor(rand() * (intensity === 'heavy' ? 6 : 3));
    const cx = Math.floor(rand() * w);
    const cy = Math.floor(rand() * h);
    const grey = Math.floor(rand() * 80);
    spots.push({
      input: await sharp({
        create: { width: r * 2, height: r * 2, channels: 4, background: { r: grey, g: grey, b: grey, alpha: 180 } },
      })
        .png()
        .toBuffer(),
      left: Math.max(0, cx - r),
      top: Math.max(0, cy - r),
    });
  }

  return sharp(buf).composite(spots).jpeg().toBuffer();
}

/** Convert to greyscale (lose color info) */
async function desaturate(buf) {
  return sharp(buf).greyscale().jpeg().toBuffer();
}

// ── All degradation ops ─────────────────────────────────────────

const OPS_BAD = [blur, darken, lighten, lowContrast, crush, skew, addShadow, addDust];
const OPS_VERY_BAD = [blur, darken, lighten, addNoise, crush, shrink, skew, addShadow, addDust, desaturate];

// ── Main ────────────────────────────────────────────────────────

const { values: flags } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    seed: { type: 'string', default: '42' },
  },
});

const seed = parseInt(flags.seed, 10);
const rand = mulberry32(seed);
const dryRun = flags['dry-run'];

const CATEGORIES = ['documents', 'receipts', 'cards', 'photos'];
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.webp']);

let totalBad = 0;
let totalVeryBad = 0;

for (const category of CATEGORIES) {
  const goodDir = join(BASE, category, 'good');
  const badDir = join(BASE, category, 'bad');
  const veryBadDir = join(BASE, category, 'very-bad');

  let files;
  try {
    files = await readdir(goodDir);
  } catch {
    continue;
  }

  // Only degrade images (not PDFs — sharp can't re-encode those)
  const images = files.filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()));
  if (images.length === 0) continue;

  await mkdir(badDir, { recursive: true });
  await mkdir(veryBadDir, { recursive: true });

  // Pick ~30% for bad, ~15% for very-bad
  const shuffled = images.slice().sort(() => rand() - 0.5);
  const badCount = Math.max(1, Math.round(shuffled.length * 0.3));
  const veryBadCount = Math.max(1, Math.round(shuffled.length * 0.15));

  const badFiles = shuffled.slice(0, badCount);
  const veryBadFiles = shuffled.slice(badCount, badCount + veryBadCount);

  // Generate "bad" variants — 2-3 degradations, moderate intensity
  for (const file of badFiles) {
    const src = join(goodDir, file);
    const ext = extname(file);
    const name = basename(file, ext);
    const opCount = 2 + Math.floor(rand() * 2);
    const ops = [];

    for (let i = 0; i < opCount; i++) {
      const op = OPS_BAD[Math.floor(rand() * OPS_BAD.length)];
      if (!ops.includes(op)) ops.push(op);
    }

    const destName = `${name}_degraded${ops.map((o) => '_' + o.name).join('')}.jpg`;
    const dest = join(badDir, destName);

    if (dryRun) {
      console.log(`  [bad] ${file} → ${destName} (${ops.map((o) => o.name).join(' + ')})`);
    } else {
      try {
        let buf = await sharp(src).jpeg().toBuffer();
        for (const op of ops) {
          buf = await op(buf, rand, 'moderate');
        }
        await sharp(buf).toFile(dest);
        totalBad++;
      } catch (e) {
        console.error(`  SKIP ${file}: ${e.message}`);
      }
    }
  }

  // Generate "very-bad" variants — 3-5 degradations, heavy intensity, always include shrink or crush
  for (const file of veryBadFiles) {
    const src = join(goodDir, file);
    const ext = extname(file);
    const name = basename(file, ext);
    const opCount = 3 + Math.floor(rand() * 3);
    const ops = [];

    // Always include shrink or crush
    ops.push(rand() > 0.5 ? shrink : crush);

    for (let i = ops.length; i < opCount; i++) {
      const op = OPS_VERY_BAD[Math.floor(rand() * OPS_VERY_BAD.length)];
      if (!ops.includes(op)) ops.push(op);
    }

    const destName = `${name}_degraded${ops.map((o) => '_' + o.name).join('')}.jpg`;
    const dest = join(veryBadDir, destName);

    if (dryRun) {
      console.log(`  [very-bad] ${file} → ${destName} (${ops.map((o) => o.name).join(' + ')})`);
    } else {
      try {
        let buf = await sharp(src).jpeg().toBuffer();
        for (const op of ops) {
          buf = await op(buf, rand, 'heavy');
        }
        await sharp(buf).toFile(dest);
        totalVeryBad++;
      } catch (e) {
        console.error(`  SKIP ${file}: ${e.message}`);
      }
    }
  }

  console.log(
    `${category}: ${images.length} source images → ${badFiles.length} bad, ${veryBadFiles.length} very-bad`,
  );
}

if (!dryRun) {
  console.log(`\nGenerated ${totalBad} bad + ${totalVeryBad} very-bad variants.`);
} else {
  console.log('\n(dry run — no files written)');
}
