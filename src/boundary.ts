import sharp from 'sharp';

/**
 * Detected document region, in original-image coordinates.
 */
export interface DetectedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * How many of the four edges produced a real transition, 2 to 4.
   *
   * An undetected edge falls back to the frame edge, so a region built from two
   * edges still contains whatever sat along the other two. That is enough to
   * pick a preset from, and not enough to crop to: a partial crop leaves a hard
   * dark strip along one side, which then reads as `shadow-on-edges` — worse
   * than the uncropped frame it replaced. The pipeline requires all four.
   */
  edgesDetected: number;
}

/**
 * Lightweight, ultra-conservative brightness-based document boundary detector.
 *
 * Scans a greyscale thumbnail for dark→bright transitions at image margins to
 * estimate where a light document sits on a darker background. Returns the
 * region in original-image coordinates; the caller decides what to do with it.
 *
 * When preset is 'auto', detected bounds inform preset selection. When all four
 * edges were found, the pipeline also crops analysis to the region, so the desk
 * a document was photographed on stops being graded along with it. Controlled
 * via `detectBounds` and `cropToBounds` (both default true).
 *
 * Returns null unless all five safety gates pass. A wrong boundary destroys
 * scoring reliability, so the default posture is "return null".
 */
export async function detectDocumentBounds(
  buffer: Buffer,
): Promise<DetectedBounds | null> {
  // The ray scan is the conservative one and goes first. It only sees edges in
  // the outer 20% of the frame, so when it declines — or finds only some of the
  // sides, which is not enough to crop on — the region finder gets a turn.
  let rays: DetectedBounds | null = null;
  try {
    rays = await detectDocumentBoundsUnsafe(buffer);
  } catch {
    rays = null;
  }
  if (rays && rays.edgesDetected >= 4) return rays;

  try {
    const region = await detectByBrightRegion(buffer);
    if (region) return region;
  } catch {
    // Never let boundary detection break the quality check.
  }
  return rays;
}

async function detectDocumentBoundsUnsafe(buffer: Buffer): Promise<DetectedBounds | null> {
  // ── Step 1: Quick decode to greyscale thumbnail ──────────────────
  const meta = await sharp(buffer).metadata();
  const origW = meta.width || 0;
  const origH = meta.height || 0;
  if (origW === 0 || origH === 0) return null;

  const thumb = await sharp(buffer)
    .greyscale()
    .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const thumbW = thumb.info.width;
  const thumbH = thumb.info.height;
  if (thumbW < 10 || thumbH < 10) return null; // Too small for meaningful edge scanning

  const pixels = thumb.data;
  const scaleX = origW / thumbW;
  const scaleY = origH / thumbH;

  // ── Step 2: Early-exit checks ────────────────────────────────────
  const totalPixels = thumbW * thumbH;
  let sum = 0;
  for (let i = 0; i < totalPixels; i++) {
    sum += pixels[i];
  }
  const mean = sum / totalPixels;

  // Uniformly bright — no visible background
  if (mean > 200) return null;
  // Uniformly dark — mostly background or very dark photo
  if (mean < 40) return null;

  // Compute standard deviation
  let sqDiffSum = 0;
  for (let i = 0; i < totalPixels; i++) {
    const diff = pixels[i] - mean;
    sqDiffSum += diff * diff;
  }
  const stdev = Math.sqrt(sqDiffSum / totalPixels);

  // Very uniform image — no discernible boundary
  if (stdev < 15) return null;

  // ── Step 3: Per-edge scanning ────────────────────────────────────
  const NUM_RAYS = 15;
  const SCAN_DEPTH_RATIO = 0.2; // Only scan outer 20%
  const DOC_THRESHOLD = 160;    // Brightness above this = "document"
  const BG_THRESHOLD = 120;     // Brightness below this = "background"
  const MIN_JUMP = 25;          // Minimum brightness jump over 3 pixels

  function getPixel(x: number, y: number): number {
    return pixels[y * thumbW + x];
  }

  /**
   * Find dark→bright transition along a scan line.
   * Returns the pixel position of the transition, or -1 if none found.
   */
  function findTransition(
    coords: Array<[number, number]>,
  ): number {
    if (coords.length < 4) return -1;

    // Collect brightness values
    const vals: number[] = coords.map(([x, y]) => getPixel(x, y));

    // Apply 3-point running average
    const smoothed: number[] = new Array(vals.length);
    smoothed[0] = vals[0];
    smoothed[vals.length - 1] = vals[vals.length - 1];
    for (let i = 1; i < vals.length - 1; i++) {
      smoothed[i] = (vals[i - 1] + vals[i] + vals[i + 1]) / 3;
    }

    // Find dark→bright transition
    for (let i = 3; i < smoothed.length; i++) {
      // Current pixel is bright enough to be document
      if (smoothed[i] < DOC_THRESHOLD) continue;
      // Check that some pixel within 3 steps back was below background threshold
      let wasDark = false;
      for (let j = Math.max(0, i - 3); j < i; j++) {
        if (smoothed[j] < BG_THRESHOLD) { wasDark = true; break; }
      }
      if (!wasDark) continue;
      // Check minimum jump over 3 pixels
      const jumpStart = Math.max(0, i - 3);
      if (smoothed[i] - smoothed[jumpStart] >= MIN_JUMP) {
        return i;
      }
    }

    return -1;
  }

  type EdgeResult = { transitions: number[]; detected: boolean; conservativePos: number };

  function scanEdge(
    edge: 'top' | 'bottom' | 'left' | 'right',
  ): EdgeResult {
    const transitions: number[] = [];

    for (let r = 0; r < NUM_RAYS; r++) {
      const coords: Array<[number, number]> = [];

      if (edge === 'top') {
        const x = Math.round(((r + 0.5) / NUM_RAYS) * thumbW);
        const clampedX = Math.min(x, thumbW - 1);
        const maxDepth = Math.floor(thumbH * SCAN_DEPTH_RATIO);
        for (let y = 0; y < maxDepth; y++) {
          coords.push([clampedX, y]);
        }
      } else if (edge === 'bottom') {
        const x = Math.round(((r + 0.5) / NUM_RAYS) * thumbW);
        const clampedX = Math.min(x, thumbW - 1);
        const maxDepth = Math.floor(thumbH * SCAN_DEPTH_RATIO);
        for (let y = thumbH - 1; y >= thumbH - maxDepth; y--) {
          coords.push([clampedX, y]);
        }
      } else if (edge === 'left') {
        const y = Math.round(((r + 0.5) / NUM_RAYS) * thumbH);
        const clampedY = Math.min(y, thumbH - 1);
        const maxDepth = Math.floor(thumbW * SCAN_DEPTH_RATIO);
        for (let x = 0; x < maxDepth; x++) {
          coords.push([x, clampedY]);
        }
      } else {
        // right
        const y = Math.round(((r + 0.5) / NUM_RAYS) * thumbH);
        const clampedY = Math.min(y, thumbH - 1);
        const maxDepth = Math.floor(thumbW * SCAN_DEPTH_RATIO);
        for (let x = thumbW - 1; x >= thumbW - maxDepth; x--) {
          coords.push([x, clampedY]);
        }
      }

      const pos = findTransition(coords);
      if (pos >= 0) {
        // Convert ray-local position back to actual coordinate on the relevant axis
        if (edge === 'top') {
          transitions.push(pos); // y-coordinate from top
        } else if (edge === 'bottom') {
          transitions.push(thumbH - 1 - pos); // y-coordinate from top
        } else if (edge === 'left') {
          transitions.push(pos); // x-coordinate from left
        } else {
          transitions.push(thumbW - 1 - pos); // x-coordinate from left
        }
      }
    }

    // Gate 1: Need at least 10 of 15 rays to find a transition
    if (transitions.length < 10) {
      return { transitions, detected: false, conservativePos: 0 };
    }

    // Gate 3: Full spread check
    const minT = Math.min(...transitions);
    const maxT = Math.max(...transitions);
    const dimension = (edge === 'top' || edge === 'bottom') ? thumbH : thumbW;
    if (maxT - minT > 0.25 * dimension) {
      return { transitions, detected: false, conservativePos: 0 };
    }

    // Gate 2 (skew handling): Use most conservative transition point
    let conservativePos: number;
    if (edge === 'top' || edge === 'left') {
      // Use shallowest inset (minimum) — includes most of document
      conservativePos = minT;
    } else {
      // Use closest to image edge (maximum) — includes most of document
      conservativePos = maxT;
    }

    return { transitions, detected: true, conservativePos };
  }

  const topResult = scanEdge('top');
  const bottomResult = scanEdge('bottom');
  const leftResult = scanEdge('left');
  const rightResult = scanEdge('right');

  // ── Step 5: Assembly and safety checks ───────────────────────────

  // Use image edge for any undetected edge
  const top = topResult.detected ? topResult.conservativePos : 0;
  const bottom = bottomResult.detected ? bottomResult.conservativePos : thumbH - 1;
  const left = leftResult.detected ? leftResult.conservativePos : 0;
  const right = rightResult.detected ? rightResult.conservativePos : thumbW - 1;

  const detectedEdgeCount = [topResult, bottomResult, leftResult, rightResult]
    .filter((r) => r.detected).length;

  // Safety Gate 1: At least 2 edges must be detected
  if (detectedEdgeCount < 2) return null;

  // Compute region in thumbnail coordinates
  const regionX = left;
  const regionY = top;
  const regionW = right - left + 1;
  const regionH = bottom - top + 1;

  // Safety Gate 2: Minimum region size (≥ 40% of each dimension)
  if (regionW < thumbW * 0.4 || regionH < thumbH * 0.4) return null;

  // Safety Gate 3: No single edge may be inset by more than 25%
  if (top > thumbH * 0.25) return null;
  if ((thumbH - 1 - bottom) > thumbH * 0.25) return null;
  if (left > thumbW * 0.25) return null;
  if ((thumbW - 1 - right) > thumbW * 0.25) return null;

  // Safety Gate 4: Brightness contrast validation
  // Sample mean brightness inside detected region vs. excluded margins
  let insideSum = 0;
  let insideCount = 0;
  let outsideSum = 0;
  let outsideCount = 0;

  for (let y = 0; y < thumbH; y++) {
    for (let x = 0; x < thumbW; x++) {
      const val = pixels[y * thumbW + x];
      if (x >= regionX && x < regionX + regionW && y >= regionY && y < regionY + regionH) {
        insideSum += val;
        insideCount++;
      } else {
        outsideSum += val;
        outsideCount++;
      }
    }
  }

  if (outsideCount === 0) return null; // No margin pixels — nothing to compare
  const insideMean = insideSum / insideCount;
  const outsideMean = outsideSum / outsideCount;
  if (insideMean - outsideMean < 25) return null;

  // Safety Gate 5: Aspect ratio sanity (between 0.15 and 6.5)
  const aspectRatio = regionW / regionH;
  if (aspectRatio < 0.15 || aspectRatio > 6.5) return null;

  // Scale back to original coordinates, clamped to image bounds
  const resultX = Math.min(Math.round(regionX * scaleX), origW - 1);
  const resultY = Math.min(Math.round(regionY * scaleY), origH - 1);
  const resultW = Math.min(Math.round(regionW * scaleX), origW - resultX);
  const resultH = Math.min(Math.round(regionH * scaleY), origH - resultY);

  if (resultW <= 0 || resultH <= 0) return null;

  return {
    x: resultX,
    y: resultY,
    width: resultW,
    height: resultH,
    edgesDetected: detectedEdgeCount,
  };
}


// ── Largest-bright-region detection ──────────────────────────────

/** Longest side used for region detection. */
const REGION_MAX_DIM = 400;
/**
 * The document must be at least this share of the frame to be worth finding.
 *
 * A receipt is narrow, so even a well-framed one covers less of the picture
 * than its size suggests: at 40% of the frame's short side it is under a tenth
 * of the total area. The other gates — solidity, contrast against the
 * surroundings, aspect ratio — are what keep this honest, not this one.
 */
const MIN_REGION_AREA = 0.08;
/** Filled share of its own bounding box — a sheet is solid, a scatter is not. */
const MIN_SOLIDITY = 0.7;
/** Above this the region is the whole frame and there is nothing to crop away. */
const MAX_REGION_COVERAGE = 0.95;
/** Mean brightness the region must exceed its surroundings by. */
const MIN_REGION_CONTRAST = 20;

/** Otsu's threshold from a 256-bin histogram. */
function otsuThreshold(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let threshold = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const meanB = sumB / wB;
    const meanF = (sum - sumB) / wF;
    const between = wB * wF * (meanB - meanF) * (meanB - meanF);
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

/**
 * Find a document as the largest bright region in the frame.
 *
 * The ray scan only looks at the outer 20% of the image, so it cannot see a
 * document whose edge lies further in than that — anything covering less than
 * roughly 60% of a dimension is invisible to it. That is the common case for a
 * card or a receipt photographed on a desk, which is precisely when cropping
 * matters most: without it the desk is graded along with the document.
 *
 * This makes no assumption about where the edges are. It thresholds the frame,
 * takes the largest connected bright region, and accepts its bounding box only
 * if that region behaves like a sheet of paper: a decent share of the frame,
 * solidly filling its own bounding box, and meaningfully brighter than what
 * surrounds it.
 */
/**
 * Solidity of the largest bright region, counting its enclosed holes as part of
 * it.
 *
 * Re-floods the winning region from its seed, then floods the non-region pixels
 * inward from the bounding box border. Anything the second flood cannot reach
 * is sealed inside the region — a portrait, a photograph, a block of solid ink
 * — and belongs to the sheet. Anything it does reach is background that the
 * bounding box merely happens to span, which is exactly what the solidity gate
 * exists to reject.
 *
 * Both floods are bounded by the 400px thumbnail, so this is a few hundred
 * thousand operations at worst.
 */
function solidityWithHolesFilled(
  px: Buffer | Uint8Array,
  w: number,
  threshold: number,
  seed: number,
  box: { minX: number; maxX: number; minY: number; maxY: number },
): number {
  if (seed < 0) return 0;
  const boxW = box.maxX - box.minX + 1;
  const boxH = box.maxY - box.minY + 1;
  const boxArea = boxW * boxH;
  if (boxArea <= 0) return 0;

  // Pass 1: the region itself, in bounding-box coordinates.
  const inRegion = new Uint8Array(boxArea);
  const stack = new Int32Array(boxArea);
  let top = 0;
  const seedX = seed % w;
  const seedY = (seed - seedX) / w;
  const seedIdx = (seedY - box.minY) * boxW + (seedX - box.minX);
  inRegion[seedIdx] = 1;
  stack[top++] = seedIdx;
  let regionArea = 0;
  while (top > 0) {
    const i = stack[--top];
    const x = i % boxW;
    const y = (i - x) / boxW;
    regionArea++;
    const push = (nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= boxW || ny >= boxH) return;
      const ni = ny * boxW + nx;
      if (inRegion[ni]) return;
      if (px[(ny + box.minY) * w + (nx + box.minX)] <= threshold) return;
      inRegion[ni] = 1;
      stack[top++] = ni;
    };
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }

  // Pass 2: background reachable from the border. What it misses is a hole.
  const outside = new Uint8Array(boxArea);
  top = 0;
  const seedEdge = (i: number): void => {
    if (inRegion[i] || outside[i]) return;
    outside[i] = 1;
    stack[top++] = i;
  };
  for (let x = 0; x < boxW; x++) { seedEdge(x); seedEdge((boxH - 1) * boxW + x); }
  for (let y = 0; y < boxH; y++) { seedEdge(y * boxW); seedEdge(y * boxW + boxW - 1); }
  let outsideArea = 0;
  while (top > 0) {
    const i = stack[--top];
    const x = i % boxW;
    const y = (i - x) / boxW;
    outsideArea++;
    const push = (nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= boxW || ny >= boxH) return;
      const ni = ny * boxW + nx;
      if (inRegion[ni] || outside[ni]) return;
      outside[ni] = 1;
      stack[top++] = ni;
    };
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }

  return (boxArea - outsideArea) / boxArea;
}

async function detectByBrightRegion(buffer: Buffer): Promise<DetectedBounds | null> {
  const meta = await sharp(buffer).metadata();
  const origW = meta.width || 0;
  const origH = meta.height || 0;
  if (origW === 0 || origH === 0) return null;

  const thumb = await sharp(buffer)
    .greyscale()
    .resize(REGION_MAX_DIM, REGION_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = thumb.info.width;
  const h = thumb.info.height;
  if (w < 20 || h < 20) return null;

  const px = thumb.data;
  const total = w * h;
  const hist = new Uint32Array(256);
  for (let i = 0; i < total; i++) hist[px[i]]++;
  const threshold = otsuThreshold(hist, total);

  // Flood-fill the bright class, tracking the largest region and its extent.
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  let bestArea = 0;
  let bestSeed = -1;
  let best = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

  for (let start = 0; start < total; start++) {
    if (seen[start] || px[start] <= threshold) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let area = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;

    while (top > 0) {
      const idx = stack[--top];
      const x = idx % w;
      const y = (idx - x) / w;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0 && !seen[idx - 1] && px[idx - 1] > threshold) { seen[idx - 1] = 1; stack[top++] = idx - 1; }
      if (x < w - 1 && !seen[idx + 1] && px[idx + 1] > threshold) { seen[idx + 1] = 1; stack[top++] = idx + 1; }
      if (y > 0 && !seen[idx - w] && px[idx - w] > threshold) { seen[idx - w] = 1; stack[top++] = idx - w; }
      if (y < h - 1 && !seen[idx + w] && px[idx + w] > threshold) { seen[idx + w] = 1; stack[top++] = idx + w; }
    }

    if (area > bestArea) {
      bestArea = area;
      bestSeed = start;
      best = { minX, maxX, minY, maxY };
    }
  }

  if (bestArea / total < MIN_REGION_AREA) return null;

  const regionW = best.maxX - best.minX + 1;
  const regionH = best.maxY - best.minY + 1;
  if (regionW < 16 || regionH < 16) return null;

  // A sheet of paper fills its own bounding box. A scattering of bright
  // speckles across a dark frame does not, and neither does a bright object
  // with a long thin arm reaching across the image.
  //
  // Measured with the region's enclosed holes filled in, because a document is
  // not required to be uniformly bright to be a document. An ID card's portrait
  // photograph is a dark rectangle covering a third of it; a page with a figure
  // on it has the same shape. Both punch a hole straight through the bright
  // class and drop raw solidity under the floor while the page's outline stays
  // perfectly crisp — a German ID card lying on a desk, filling 22% of the
  // frame, measured 0.67 raw and 0.90 filled. That was the archetype of the
  // capture this library most needs to catch, thrown away for containing a face.
  //
  // Filling can only raise the number, so nothing that passes today can fail
  // tomorrow: across the same 450-image sample every one of the 123 regions
  // already clearing the floor still cleared it, and 13 more joined them. A
  // scatter of speckles is unaffected — bright fragments with dark sky between
  // them enclose nothing, and the gate still turns them away.
  if (solidityWithHolesFilled(px, w, threshold, bestSeed, best) < MIN_SOLIDITY) return null;

  const coverage = (regionW * regionH) / total;
  // The brightest region is the whole picture. Reporting it as the document was
  // tried and reverted: on a scan it is true and buys nothing — the distance
  // check is silent for a page filling its frame either way, no crop is taken,
  // and the preset resolves to the same thing — while on an image whose
  // background outshines its document it is simply wrong, naming the surface as
  // the page. `null` here means "no idea", which on those inputs is accurate.
  if (coverage > MAX_REGION_COVERAGE) return null;

  const aspect = regionW / regionH;
  if (aspect < 0.15 || aspect > 6.5) return null;

  // A document photographed on a surface is surrounded by that surface. A
  // region pressed against several sides of the frame is not a document with a
  // border, it is one side of a gradient or a two-tone image — both of which
  // were detected as documents covering exactly half the picture. One touching
  // side is allowed, so a page running off the bottom edge is still found.
  const touching =
    (best.minX === 0 ? 1 : 0) + (best.maxX === w - 1 ? 1 : 0) +
    (best.minY === 0 ? 1 : 0) + (best.maxY === h - 1 ? 1 : 0);
  if (touching > 1) return null;

  let insideSum = 0;
  let insideCount = 0;
  let outsideSum = 0;
  let outsideCount = 0;
  for (let y = 0; y < h; y++) {
    const inRows = y >= best.minY && y <= best.maxY;
    for (let x = 0; x < w; x++) {
      const value = px[y * w + x];
      if (inRows && x >= best.minX && x <= best.maxX) { insideSum += value; insideCount++; }
      else { outsideSum += value; outsideCount++; }
    }
  }
  if (outsideCount === 0 || insideCount === 0) return null;
  if (insideSum / insideCount - outsideSum / outsideCount < MIN_REGION_CONTRAST) return null;

  const scaleX = origW / w;
  const scaleY = origH / h;
  const x = Math.min(Math.round(best.minX * scaleX), origW - 1);
  const y = Math.min(Math.round(best.minY * scaleY), origH - 1);
  const width = Math.min(Math.round(regionW * scaleX), origW - x);
  const height = Math.min(Math.round(regionH * scaleY), origH - y);
  if (width <= 0 || height <= 0) return null;

  // The whole rectangle was found at once, so all four sides are known.
  return { x, y, width, height, edgesDetected: 4 };
}
