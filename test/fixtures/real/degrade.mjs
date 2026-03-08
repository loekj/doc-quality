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
 *   bad:      blur, motionBlur, darken, lighten, lowContrast, crush, skew,
 *             perspectiveTilt, addShadow, addDust, glare, partialCrop,
 *             unevenLighting, moire
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

/** Gaussian blur — noticeable softness */
async function blur(buf, rand, intensity) {
  const sigma = intensity === 'heavy' ? 3.5 + rand() * 3 : 2.5 + rand() * 2.5;
  return sharp(buf).blur(sigma).toBuffer();
}

/** Darken the image — dim room / underexposed phone photo */
async function darken(buf, rand, intensity) {
  const factor = intensity === 'heavy' ? 0.35 + rand() * 0.2 : 0.4 + rand() * 0.15;
  return sharp(buf).modulate({ brightness: factor }).toBuffer();
}

/** Overexpose / wash out — too much flash or bright lighting */
async function lighten(buf, rand, intensity) {
  const factor = intensity === 'heavy' ? 1.6 + rand() * 0.5 : 1.4 + rand() * 0.4;
  return sharp(buf).modulate({ brightness: factor }).toBuffer();
}

/** Reduce contrast (flatten towards grey) */
async function lowContrast(buf, rand, intensity) {
  const amount = intensity === 'heavy' ? -35 - rand() * 25 : -25 - rand() * 20;
  return sharp(buf).linear(1 + amount / 100, -amount / 2).toBuffer();
}

/** Add salt-and-pepper noise — sensor noise in low light */
async function addNoise(buf, rand, intensity) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data);
  const density = intensity === 'heavy' ? 0.04 + rand() * 0.04 : 0.02 + rand() * 0.03;
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

/** JPEG compression — realistic re-saves (messaging apps, email) */
async function crush(buf, rand, intensity) {
  const quality = intensity === 'heavy' ? 12 + Math.floor(rand() * 15) : 18 + Math.floor(rand() * 15);
  return sharp(buf).jpeg({ quality }).toBuffer();
}

/** Shrink — low-res forwarded image, mild reduction */
async function shrink(buf, rand, intensity) {
  const scale = intensity === 'heavy' ? 0.3 + rand() * 0.2 : 0.4 + rand() * 0.2;
  const meta = await sharp(buf).metadata();
  const w = Math.max(100, Math.round(meta.width * scale));
  return sharp(buf).resize(w).jpeg().toBuffer();
}

/** Rotate / skew slightly — not perfectly aligned on scanner/table */
async function skew(buf, rand, intensity) {
  const angle = intensity === 'heavy' ? 5 + rand() * 10 : 1 + rand() * 4;
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

/**
 * Motion blur — directional blur using sharp's convolve with a line kernel.
 * Simulates camera shake during shutter open.
 */
async function motionBlur(buf, rand, intensity) {
  const len = intensity === 'heavy' ? 7 + Math.floor(rand() * 8) : 3 + Math.floor(rand() * 5);
  // Must be odd for a centered kernel
  const size = len % 2 === 0 ? len + 1 : len;
  const angle = rand() * Math.PI; // any angle

  // Build a size×size kernel with 1s along the line at `angle`, 0s elsewhere
  const kernel = new Float64Array(size * size);
  const center = Math.floor(size / 2);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let count = 0;

  for (let k = -center; k <= center; k++) {
    const px = Math.round(center + k * dx);
    const py = Math.round(center + k * dy);
    if (px >= 0 && px < size && py >= 0 && py < size) {
      const idx = py * size + px;
      if (kernel[idx] === 0) { kernel[idx] = 1; count++; }
    }
  }

  // Normalize so values sum to 1
  const normalized = Array.from(kernel).map((v) => v / count);

  return sharp(buf)
    .convolve({ width: size, height: size, kernel: normalized })
    .jpeg()
    .toBuffer();
}

/**
 * Perspective tilt — simulates photographing a document at an angle.
 *
 * The OUTPUT is a trapezoid (one edge shorter) inside the image rectangle,
 * with background visible around the narrowed edge. This is what a real
 * phone camera produces when not held parallel to the document.
 *
 * Approach: for each output pixel, check if it falls inside the destination
 * trapezoid. If so, compute normalized (u,v) within the trapezoid and sample
 * from the source at (u*W, v*H). Pixels outside the trapezoid get a
 * realistic dark-surface background.
 */
async function perspectiveTilt(buf, rand, intensity) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const src = new Uint8Array(data);
  const { width: W, height: H, channels: ch } = info;
  const out = new Uint8Array(src.length);

  // Background: dark surface (desk/table) — not uniform, slight noise
  for (let i = 0; i < out.length; i += ch) {
    const grey = 35 + Math.floor(rand() * 20);
    out[i] = grey; out[i + 1] = grey; out[i + 2] = grey;
  }

  // Tilt amount: fraction of the edge that gets cut off on each side
  // Heavy: up to 55% narrowing on one edge (severe angle, like phone at ~30-40°)
  // Moderate: up to 30% (noticeable but readable)
  const tilt = intensity === 'heavy' ? 0.30 + rand() * 0.25 : 0.12 + rand() * 0.18;
  const direction = Math.floor(rand() * 4); // 0=top, 1=bottom, 2=left, 3=right
  const inset = Math.round(tilt * (direction <= 1 ? W : H) / 2);

  for (let dy = 0; dy < H; dy++) {
    for (let dx = 0; dx < W; dx++) {
      let u, v;

      if (direction === 0) {
        // Top edge narrower (camera tilted looking down at far edge)
        v = dy / (H - 1);
        const leftEdge = inset * (1 - v);
        const rightEdge = W - inset * (1 - v);
        if (dx < leftEdge || dx > rightEdge) continue;
        u = (dx - leftEdge) / (rightEdge - leftEdge);
      } else if (direction === 1) {
        // Bottom edge narrower
        v = dy / (H - 1);
        const leftEdge = inset * v;
        const rightEdge = W - inset * v;
        if (dx < leftEdge || dx > rightEdge) continue;
        u = (dx - leftEdge) / (rightEdge - leftEdge);
      } else if (direction === 2) {
        // Left edge narrower
        u = dx / (W - 1);
        const topEdge = inset * (1 - u);
        const bottomEdge = H - inset * (1 - u);
        if (dy < topEdge || dy > bottomEdge) continue;
        v = (dy - topEdge) / (bottomEdge - topEdge);
      } else {
        // Right edge narrower
        u = dx / (W - 1);
        const topEdge = inset * u;
        const bottomEdge = H - inset * u;
        if (dy < topEdge || dy > bottomEdge) continue;
        v = (dy - topEdge) / (bottomEdge - topEdge);
      }

      // Bilinear sample from source
      const sx = u * (W - 1);
      const sy = v * (H - 1);
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
      const fx = sx - x0, fy = sy - y0;

      const di = (dy * W + dx) * ch;
      for (let c = 0; c < ch; c++) {
        const v00 = src[(y0 * W + x0) * ch + c];
        const v10 = src[(y0 * W + x1) * ch + c];
        const v01 = src[(y1 * W + x0) * ch + c];
        const v11 = src[(y1 * W + x1) * ch + c];
        out[di + c] = Math.round(
          v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
          v01 * (1 - fx) * fy + v11 * fx * fy,
        );
      }
    }
  }

  return sharp(Buffer.from(out), { raw: { width: W, height: H, channels: ch } })
    .jpeg()
    .toBuffer();
}

/**
 * Glare / specular reflection — bright elliptical hotspot with gaussian
 * falloff, saturated white core, and slight warm tint (as real light
 * reflections tend to be slightly warm from tungsten/LED sources).
 */
async function glare(buf, rand, intensity) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data);
  const { width: w, height: h, channels: ch } = info;

  // Glare center — biased toward center but randomized
  const cx = w * (0.2 + rand() * 0.6);
  const cy = h * (0.2 + rand() * 0.6);
  const rx = w * (intensity === 'heavy' ? 0.30 + rand() * 0.25 : 0.15 + rand() * 0.15);
  const ry = h * (intensity === 'heavy' ? 0.30 + rand() * 0.25 : 0.15 + rand() * 0.15);
  const peakAlpha = intensity === 'heavy' ? 0.85 + rand() * 0.15 : 0.45 + rand() * 0.35;

  // Warm tint for realistic light source (slight yellow-orange cast)
  const tintR = 1.0;
  const tintG = 0.95 + rand() * 0.04; // slightly less green
  const tintB = 0.85 + rand() * 0.08; // noticeably less blue

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ndx = (x - cx) / rx;
      const ndy = (y - cy) / ry;
      const dist2 = ndx * ndx + ndy * ndy;

      // Gaussian falloff — extends smoothly beyond the "radius" unlike 1-d²
      // sigma chosen so the effect is strong in the core and fades gradually
      const sigma = 0.5;
      const alpha = peakAlpha * Math.exp(-dist2 / (2 * sigma * sigma));

      // Below perceptual threshold — skip
      if (alpha < 0.005) continue;

      const idx = (y * w + x) * ch;
      const tints = [tintR, tintG, tintB];
      for (let c = 0; c < Math.min(ch, 3); c++) {
        // Blend toward white with warm tint
        const target = 255 * tints[c];
        pixels[idx + c] = Math.min(255, Math.round(pixels[idx + c] + (target - pixels[idx + c]) * alpha));
      }
    }
  }

  return sharp(Buffer.from(pixels), { raw: { width: w, height: h, channels: ch } })
    .jpeg()
    .toBuffer();
}

/**
 * Partial crop — simulate finger in frame or cut-off document.
 * The "finger" uses an organic rounded shape (elliptical blob with
 * feathered edges) rather than a hard rectangle.
 */
async function partialCrop(buf, rand, intensity) {
  const meta = await sharp(buf).metadata();
  const w = meta.width;
  const h = meta.height;

  // Crop a portion off one or two edges
  const cropFrac = intensity === 'heavy' ? 0.15 + rand() * 0.2 : 0.05 + rand() * 0.12;
  const side = Math.floor(rand() * 4); // 0=top, 1=right, 2=bottom, 3=left

  let left = 0, top = 0, cw = w, ch2 = h;
  if (side === 0) { top = Math.round(h * cropFrac); ch2 = h - top; }
  else if (side === 1) { cw = Math.round(w * (1 - cropFrac)); }
  else if (side === 2) { ch2 = Math.round(h * (1 - cropFrac)); }
  else { left = Math.round(w * cropFrac); cw = w - left; }

  let result = await sharp(buf).extract({ left, top, width: cw, height: ch2 }).jpeg().toBuffer();

  // Optionally add an organic finger-like blob on an edge
  if (rand() > 0.5) {
    const { data: fData, info: fInfo } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
    const pixels = new Uint8Array(fData);
    const fw = fInfo.width;
    const fh = fInfo.height;
    const fch = fInfo.channels;

    // Finger enters from an edge — elliptical with the long axis
    // perpendicular to the edge, and feathered alpha at the boundary
    const edge = Math.floor(rand() * 4); // 0=top, 1=right, 2=bottom, 3=left
    const fingerLen = (edge <= 1 ? fh : fw) * (0.12 + rand() * 0.15);
    const fingerWidth = (edge <= 1 ? fw : fh) * (0.08 + rand() * 0.08);

    // Position along the edge
    const pos = 0.15 + rand() * 0.7;
    let fcx, fcy, frx, fry;
    if (edge === 0) { fcx = fw * pos; fcy = 0; frx = fingerWidth; fry = fingerLen; }
    else if (edge === 1) { fcx = fw; fcy = fh * pos; frx = fingerLen; fry = fingerWidth; }
    else if (edge === 2) { fcx = fw * pos; fcy = fh; frx = fingerWidth; fry = fingerLen; }
    else { fcx = 0; fcy = fh * pos; frx = fingerLen; fry = fingerWidth; }

    // Finger skin tone — darkish, slightly warm
    const skinR = 50 + Math.floor(rand() * 40);
    const skinG = 35 + Math.floor(rand() * 30);
    const skinB = 30 + Math.floor(rand() * 25);

    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const ndx = (x - fcx) / frx;
        const ndy = (y - fcy) / fry;
        const dist2 = ndx * ndx + ndy * ndy;
        if (dist2 >= 1) continue;

        // Smooth feathered edge — sharper in core, soft at boundary
        const alpha = Math.min(1, Math.max(0, (1 - dist2) * 2.5));
        const opacity = (0.7 + rand() * 0.25) * alpha;

        const idx = (y * fw + x) * fch;
        if (fch >= 3) {
          pixels[idx] = Math.round(pixels[idx] * (1 - opacity) + skinR * opacity);
          pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - opacity) + skinG * opacity);
          pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - opacity) + skinB * opacity);
        }
      }
    }

    result = await sharp(Buffer.from(pixels), { raw: { width: fw, height: fh, channels: fch } })
      .jpeg()
      .toBuffer();
  }

  return result;
}

/**
 * Uneven lighting — simulates a single point light source illuminating the
 * document from one side/corner. Uses inverse-square-ish radial falloff from
 * a light position (placed off-frame or at an edge), which is how real
 * single-source lighting behaves, rather than a uniform linear gradient.
 */
async function unevenLighting(buf, rand, intensity) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data);
  const { width: w, height: h, channels: ch } = info;

  // Light source position — placed at or beyond an edge/corner
  // to simulate a desk lamp, window light, etc.
  const corner = Math.floor(rand() * 4);
  const lx = (corner === 0 || corner === 3) ? -w * (0.1 + rand() * 0.3) : w * (1.1 + rand() * 0.3);
  const ly = (corner === 0 || corner === 1) ? -h * (0.1 + rand() * 0.3) : h * (1.1 + rand() * 0.3);

  // Compute distance range for normalization
  const maxDist = Math.sqrt(w * w + h * h);
  const maxDarken = intensity === 'heavy' ? 0.55 + rand() * 0.3 : 0.2 + rand() * 0.25;

  // Light "height" above the surface (controls how gradual the falloff is)
  // Higher = more even, lower = more dramatic falloff
  const lightHeight = maxDist * (0.3 + rand() * 0.4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - lx;
      const dy = y - ly;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Inverse-square falloff with height factor to prevent infinity at source
      // illumination ∝ 1 / (dist² + height²), normalized so brightest point ≈ 1
      const illum = (lightHeight * lightHeight) / (dist * dist + lightHeight * lightHeight);
      const factor = 1 - maxDarken * (1 - illum);

      const idx = (y * w + x) * ch;
      for (let c = 0; c < Math.min(ch, 3); c++) {
        pixels[idx + c] = Math.round(pixels[idx + c] * factor);
      }
    }
  }

  return sharp(Buffer.from(pixels), { raw: { width: w, height: h, channels: ch } })
    .jpeg()
    .toBuffer();
}

/**
 * Moiré pattern — simulate photographing a screen or halftone print.
 * Real moiré from screens has color fringing because RGB subpixels have
 * slightly different spatial frequencies and orientations. Each channel
 * gets its own interference pattern with offset frequencies/angles.
 */
async function moire(buf, rand, intensity) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data);
  const { width: w, height: h, channels: ch } = info;

  // Base frequency and angle — each channel gets a slight offset
  // to simulate RGB subpixel layout interference
  const baseFreq = 0.05 + rand() * 0.1;
  const baseAngle = rand() * Math.PI;
  const strength = intensity === 'heavy' ? 40 + rand() * 50 : 15 + rand() * 25;

  // Per-channel frequency and angle offsets (simulating RGB subpixel geometry)
  const channelParams = [];
  for (let c = 0; c < Math.min(ch, 3); c++) {
    channelParams.push({
      freq1: baseFreq * (0.92 + c * 0.08 + rand() * 0.04),
      freq2: baseFreq * (1.0 + c * 0.06 + rand() * 0.04) * (1.05 + rand() * 0.15),
      angle: baseAngle + (c - 1) * (0.03 + rand() * 0.04), // slight angle shift per channel
      strength: strength * (0.8 + rand() * 0.4), // slightly different intensity per channel
    });
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * ch;
      for (let c = 0; c < Math.min(ch, 3); c++) {
        const p = channelParams[c];
        const rotX = x * Math.cos(p.angle) + y * Math.sin(p.angle);
        const rotY = -x * Math.sin(p.angle) + y * Math.cos(p.angle);
        const v1 = Math.sin(rotX * p.freq1 * 2 * Math.PI);
        const v2 = Math.sin(rotY * p.freq2 * 2 * Math.PI);
        const interference = (v1 * v2) * p.strength;
        pixels[idx + c] = Math.max(0, Math.min(255, Math.round(pixels[idx + c] + interference)));
      }
    }
  }

  return sharp(Buffer.from(pixels), { raw: { width: w, height: h, channels: ch } })
    .jpeg()
    .toBuffer();
}

// ── All degradation ops ─────────────────────────────────────────

const OPS_BAD = [
  blur, motionBlur, darken, lighten, lowContrast, crush, skew,
  perspectiveTilt, addShadow, addDust, glare, unevenLighting, moire,
];
const OPS_VERY_BAD = [
  blur, motionBlur, darken, lighten, addNoise, crush, skew,
  perspectiveTilt, addShadow, addDust, desaturate, glare, partialCrop,
  unevenLighting, moire, shrink,
];

// ── Main ────────────────────────────────────────────────────────

const { values: flags } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    seed: { type: 'string', default: '42' },
    'base-dir': { type: 'string', default: '' },
  },
});

const seed = parseInt(flags.seed, 10);
const rand = mulberry32(seed);
const dryRun = flags['dry-run'];
const ROOT = flags['base-dir'] ? flags['base-dir'] : BASE;

const CATEGORIES = ['documents', 'receipts', 'cards', 'photos'];
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.webp', '.heic', '.heif']);

let totalBad = 0;
let totalVeryBad = 0;

for (const category of CATEGORIES) {
  const goodDir = join(ROOT, category, 'good');
  const badDir = join(ROOT, category, 'bad');
  const veryBadDir = join(ROOT, category, 'very-bad');

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

  // Pick ~65% for bad, ~35% for very-bad (processes all files in good/)
  const shuffled = images.slice().sort(() => rand() - 0.5);
  const badCount = Math.max(1, Math.round(shuffled.length * 0.65));
  const veryBadCount = Math.max(1, shuffled.length - badCount);

  const badFiles = shuffled.slice(0, badCount);
  const veryBadFiles = shuffled.slice(badCount, badCount + veryBadCount);

  // Generate "bad" variants — 1-2 degradations, moderate intensity
  // Think: slightly blurry phone photo, or a bit dark, or minor tilt
  for (const file of badFiles) {
    const src = join(goodDir, file);
    const ext = extname(file);
    const name = basename(file, ext);
    const opCount = 2; // always 2 ops — enough to be noticeably bad
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

  // Generate "very-bad" variants — 2-3 degradations, heavy intensity
  // Think: dark + blurry, heavy tilt + washed out, glare + noise
  for (const file of veryBadFiles) {
    const src = join(goodDir, file);
    const ext = extname(file);
    const name = basename(file, ext);
    const opCount = 2 + Math.floor(rand() * 2); // 2-3 ops
    const ops = [];

    for (let i = 0; i < opCount; i++) {
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
