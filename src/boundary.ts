import sharp from 'sharp';

/**
 * Lightweight, ultra-conservative brightness-based document boundary detector.
 *
 * Scans a greyscale thumbnail for dark→bright transitions at image margins to
 * estimate where a light document sits on a darker background. Does NOT crop
 * the analysis image — returns the detected region in original-image coordinates.
 *
 * When preset is 'auto', detected bounds inform preset selection (document vs
 * receipt vs card). Detected bounds are always returned in the result's `boundary`
 * field regardless of preset. Controlled via `detectBounds` option (default: true).
 *
 * Returns null (no detection) unless all five safety gates pass. A wrong boundary
 * destroys scoring reliability, so the default posture is "return null".
 */
export async function detectDocumentBounds(
  buffer: Buffer,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    return await detectDocumentBoundsUnsafe(buffer);
  } catch {
    // Any failure in boundary detection (corrupted buffer, sharp error, etc.)
    // → fall back to no detection. Never let this break the quality check.
    return null;
  }
}

async function detectDocumentBoundsUnsafe(
  buffer: Buffer,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
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

  return { x: resultX, y: resultY, width: resultW, height: resultH };
}
