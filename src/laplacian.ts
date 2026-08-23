/**
 * Signed 3x3 Laplacian.
 *
 * The pipeline used to get its Laplacian from `sharp.convolve`, whose output is
 * uint8: every negative response clamps to 0 and everything above 255 pins
 * there. A Laplacian is symmetric about zero, so that discards the entire
 * negative lobe — on a page of dark text on light paper, the dark side of every
 * stroke — and saturates on the sharp end, where 4% of pixels pin at 255.
 *
 * Computing it signed instead nearly doubles the usable range: 73x from sharp
 * to heavily blurred, against 44x clipped.
 *
 * It costs about twice what libvips' SIMD convolve does. Thorough and deep pay
 * almost nothing for it because they already decode greyscale for other
 * analyzers and can share that pass; fast mode has no such pass to share, so it
 * keeps libvips and forgoes the signed statistics.
 *
 * Clipping the signed result reproduces the old buffer bit for bit, so the
 * existing analyzers and their thresholds are unaffected. The signed statistics
 * are additional.
 */

/** Kernel radius — 3x3. */
const RADIUS = 1;

export interface SignedLaplacian {
  /** Signed response, row-major. Range is ±2040, so Int16 is exact. */
  data: Int16Array;
  /**
   * The same response clipped to uint8 — bit-identical to what
   * `sharp.convolve` produced, so existing analyzers read the same numbers.
   * Produced in the same pass; a separate one costs more than the arithmetic.
   */
  clipped: Buffer;
  width: number;
  height: number;
  /** Standard deviation of the signed response — the classic focus measure. */
  stdev: number;
  /**
   * Mean absolute response.
   *
   * The honest version of what the clipped buffer's mean was measuring. Clipping
   * rectified the signal, so its mean was a one-sided edge-energy proxy; this
   * uses both lobes.
   */
  meanAbs: number;
  /** Fraction of pixels whose absolute response exceeds the edge threshold. */
  edgeRatio: number;
  /**
   * Fraction of pixels the old uint8 buffer had to clamp.
   *
   * A direct measure of how much the clipped statistics are understating this
   * image. Near zero on blurred pages, several percent on sharp ones.
   */
  saturationRatio: number;
}

/**
 * Compute the signed Laplacian of a greyscale image.
 *
 * Edges replicate the border pixel, matching libvips, which is what makes the
 * clipped result bit-identical to the previous `sharp.convolve` output.
 */
export function signedLaplacian(
  grey: Buffer | Uint8Array,
  width: number,
  height: number,
  edgeThreshold: number,
): SignedLaplacian {
  const total = width * height;
  const data = new Int16Array(total);
  const clipped = Buffer.allocUnsafe(total);

  let sum = 0;
  let sumSq = 0;
  let absSum = 0;
  let edges = 0;
  let saturated = 0;

  // One pass: convolve, clip and accumulate together. Three separate passes
  // over an 8 MP image cost more than the arithmetic does.
  const accumulate = (i: number, v: number): void => {
    data[i] = v;
    clipped[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    sum += v;
    sumSq += v * v;
    const abs = v < 0 ? -v : v;
    absSum += abs;
    if (abs > edgeThreshold) edges++;
    if (v < 0 || v > 255) saturated++;
  };

  for (let y = RADIUS; y < height - RADIUS; y++) {
    const row = y * width;
    const up = row - width;
    const down = row + width;
    for (let x = RADIUS; x < width - RADIUS; x++) {
      const i = row + x;
      accumulate(
        i,
        8 * grey[i] -
          grey[up + x - 1] - grey[up + x] - grey[up + x + 1] -
          grey[i - 1] - grey[i + 1] -
          grey[down + x - 1] - grey[down + x] - grey[down + x + 1],
      );
    }
  }

  // Borders, with edge replication — this is what makes the clipped result
  // bit-identical to libvips.
  const at = (x: number, y: number): number => {
    const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
    const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
    return grey[cy * width + cx];
  };
  const border = (x: number, y: number): void => {
    accumulate(
      y * width + x,
      8 * at(x, y) -
        at(x - 1, y - 1) - at(x, y - 1) - at(x + 1, y - 1) -
        at(x - 1, y) - at(x + 1, y) -
        at(x - 1, y + 1) - at(x, y + 1) - at(x + 1, y + 1),
    );
  };
  for (let x = 0; x < width; x++) {
    border(x, 0);
    if (height > 1) border(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    border(0, y);
    if (width > 1) border(width - 1, y);
  }

  const mean = sum / total;

  return {
    data,
    clipped,
    width,
    height,
    stdev: Math.sqrt(Math.max(0, sumSq / total - mean * mean)),
    meanAbs: absSum / total,
    edgeRatio: edges / total,
    saturationRatio: saturated / total,
  };
}

/**
 * Clip a signed Laplacian to uint8.
 *
 * Reproduces `sharp.convolve`'s output exactly — verified bit-identical across
 * test images — so existing analyzers and their tuned thresholds keep working
 * on the same numbers while the signed statistics become available alongside.
 */
export function clipToUint8(signed: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(signed.length);
  for (let i = 0; i < signed.length; i++) {
    const v = signed[i];
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}
