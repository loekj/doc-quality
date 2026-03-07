// ── FFT Math Module ──────────────────────────────────────────────
// Pure-JS radix-2 Cooley-Tukey FFT, 2D spectrum computation,
// and analysis utilities for blur/noise/moiré/JPEG artifact detection.

/** Interleaved complex array: [re0, im0, re1, im1, ...] */
export type ComplexArray = Float64Array;

export interface MagnitudeSpectrum2D {
  /** Row-major magnitude values (fftH × fftW) */
  magnitude: Float64Array;
  /** Padded width (power of 2) */
  fftW: number;
  /** Padded height (power of 2) */
  fftH: number;
  /** Pre-pad width */
  origW: number;
  /** Pre-pad height */
  origH: number;
  /** Total energy: Σ(magnitude²) */
  totalEnergy: number;
}

/** Smallest power of 2 >= n */
export function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * In-place radix-2 Cooley-Tukey FFT on interleaved ComplexArray.
 * Length must be a power of 2. `forward=true` for FFT, `false` for inverse.
 */
export function fft1d(data: ComplexArray, forward = true): void {
  const n = data.length >>> 1; // number of complex samples
  if (n <= 1) return;

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >>> 1;
    while (j & bit) {
      j ^= bit;
      bit >>>= 1;
    }
    j ^= bit;
    if (i < j) {
      // Swap complex values at i and j
      const ri = i << 1, rj = j << 1;
      let tmp = data[ri]; data[ri] = data[rj]; data[rj] = tmp;
      tmp = data[ri + 1]; data[ri + 1] = data[rj + 1]; data[rj + 1] = tmp;
    }
  }

  // Butterfly stages
  const dir = forward ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >>> 1;
    const angle = (dir * 2 * Math.PI) / size;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let start = 0; start < n; start += size) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < halfSize; k++) {
        const evenIdx = (start + k) << 1;
        const oddIdx = (start + k + halfSize) << 1;

        const tRe = curRe * data[oddIdx] - curIm * data[oddIdx + 1];
        const tIm = curRe * data[oddIdx + 1] + curIm * data[oddIdx];

        data[oddIdx] = data[evenIdx] - tRe;
        data[oddIdx + 1] = data[evenIdx + 1] - tIm;
        data[evenIdx] += tRe;
        data[evenIdx + 1] += tIm;

        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  // Inverse: scale by 1/n
  if (!forward) {
    for (let i = 0; i < data.length; i++) {
      data[i] /= n;
    }
  }
}

/** Hann window value: 0.5 * (1 - cos(2πi/(N-1))) */
export function hannWindow(i: number, N: number): number {
  if (N <= 1) return 1;
  return 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
}

/**
 * Area-average downsample of single-channel data preserving aspect ratio.
 * Returns the downsampled data and new dimensions.
 */
export function downsampleGreyscale(
  pixels: Buffer | Uint8Array,
  w: number,
  h: number,
  maxDim: number,
): { data: Float64Array; width: number; height: number } {
  const scale = maxDim / Math.max(w, h);
  if (scale >= 1) {
    const out = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = pixels[i];
    return { data: out, width: w, height: h };
  }

  const newW = Math.max(1, Math.round(w * scale));
  const newH = Math.max(1, Math.round(h * scale));
  const out = new Float64Array(newW * newH);

  const xRatio = w / newW;
  const yRatio = h / newH;

  for (let ny = 0; ny < newH; ny++) {
    const srcY0 = ny * yRatio;
    const srcY1 = Math.min((ny + 1) * yRatio, h);
    const iy0 = Math.floor(srcY0);
    const iy1 = Math.min(Math.ceil(srcY1), h);

    for (let nx = 0; nx < newW; nx++) {
      const srcX0 = nx * xRatio;
      const srcX1 = Math.min((nx + 1) * xRatio, w);
      const ix0 = Math.floor(srcX0);
      const ix1 = Math.min(Math.ceil(srcX1), w);

      let sum = 0;
      let area = 0;

      for (let sy = iy0; sy < iy1; sy++) {
        const yWeight = Math.min(sy + 1, srcY1) - Math.max(sy, srcY0);
        for (let sx = ix0; sx < ix1; sx++) {
          const xWeight = Math.min(sx + 1, srcX1) - Math.max(sx, srcX0);
          const weight = xWeight * yWeight;
          sum += pixels[sy * w + sx] * weight;
          area += weight;
        }
      }

      out[ny * newW + nx] = area > 0 ? sum / area : 0;
    }
  }

  return { data: out, width: newW, height: newH };
}

/**
 * Compute 2D magnitude spectrum from greyscale pixel data.
 *
 * 1. Optional downsample to maxDim (area averaging)
 * 2. Pad width/height independently to next power of 2
 * 3. Apply 2D Hann window
 * 4. Row-wise FFT, then column-wise FFT
 * 5. Compute magnitude and total energy
 *
 * Returns null if either dimension < 32px after downsample.
 */
export function computeSpectrum2D(
  pixels: Buffer | Uint8Array,
  width: number,
  height: number,
  maxDim?: number,
): MagnitudeSpectrum2D | null {
  // Downsample if requested
  let data: Float64Array;
  let w: number;
  let h: number;

  if (maxDim && maxDim < Math.max(width, height)) {
    const ds = downsampleGreyscale(pixels, width, height, maxDim);
    data = ds.data;
    w = ds.width;
    h = ds.height;
  } else {
    data = new Float64Array(width * height);
    for (let i = 0; i < width * height; i++) data[i] = pixels[i];
    w = width;
    h = height;
  }

  if (w < 32 || h < 32) return null;

  const fftW = nextPow2(w);
  const fftH = nextPow2(h);

  // Subtract mean to remove DC dominance
  let mean = 0;
  for (let i = 0; i < w * h; i++) mean += data[i];
  mean /= (w * h);

  // Build complex 2D array with mean-subtracted, Hann-windowed data, zero-padded
  const complex = new Float64Array(fftH * fftW * 2); // interleaved per row

  for (let y = 0; y < h; y++) {
    const wy = hannWindow(y, h);
    for (let x = 0; x < w; x++) {
      const wx = hannWindow(x, w);
      complex[(y * fftW + x) * 2] = (data[y * w + x] - mean) * wy * wx;
      // imaginary part = 0 (already zeroed)
    }
  }

  // FFT all rows
  const rowBuf = new Float64Array(fftW * 2);
  for (let y = 0; y < fftH; y++) {
    const offset = y * fftW * 2;
    rowBuf.set(complex.subarray(offset, offset + fftW * 2));
    fft1d(rowBuf, true);
    complex.set(rowBuf, offset);
  }

  // FFT all columns — extract column into temp buffer, FFT, copy back
  const colBuf = new Float64Array(fftH * 2);
  for (let x = 0; x < fftW; x++) {
    // Extract column x
    for (let y = 0; y < fftH; y++) {
      const idx = (y * fftW + x) * 2;
      colBuf[y * 2] = complex[idx];
      colBuf[y * 2 + 1] = complex[idx + 1];
    }
    fft1d(colBuf, true);
    // Copy back
    for (let y = 0; y < fftH; y++) {
      const idx = (y * fftW + x) * 2;
      complex[idx] = colBuf[y * 2];
      complex[idx + 1] = colBuf[y * 2 + 1];
    }
  }

  // Compute magnitude and total energy
  const magnitude = new Float64Array(fftH * fftW);
  let totalEnergy = 0;
  for (let i = 0; i < fftH * fftW; i++) {
    const re = complex[i * 2];
    const im = complex[i * 2 + 1];
    const mag = Math.sqrt(re * re + im * im);
    magnitude[i] = mag;
    totalEnergy += mag * mag;
  }

  return { magnitude, fftW, fftH, origW: w, origH: h, totalEnergy };
}

/**
 * Ratio of energy outside a central ellipse to total energy.
 * Uses elliptical radius: r = sqrt((fx/fftW)² + (fy/fftH)²)
 * Frequencies are relative to DC at (0,0), wrapping at N/2.
 */
export function highFreqEnergyRatio(
  spectrum: MagnitudeSpectrum2D,
  radiusFraction = 0.3,
): number {
  const { magnitude, fftW, fftH, totalEnergy } = spectrum;
  if (totalEnergy <= 0) return 0;

  let highEnergy = 0;
  const halfW = fftW >>> 1;
  const halfH = fftH >>> 1;

  for (let y = 0; y < fftH; y++) {
    // Frequency distance from DC (wraps at N/2)
    const fy = y <= halfH ? y : fftH - y;
    const fyNorm = fy / halfH;

    for (let x = 0; x < fftW; x++) {
      const fx = x <= halfW ? x : fftW - x;
      const fxNorm = fx / halfW;

      const r = Math.sqrt(fxNorm * fxNorm + fyNorm * fyNorm);
      if (r > radiusFraction) {
        const mag = magnitude[y * fftW + x];
        highEnergy += mag * mag;
      }
    }
  }

  return highEnergy / totalEnergy;
}

/**
 * Count spectral peaks — bins exceeding threshold × median in their annulus.
 * Divides spectrum into concentric elliptical annuli and computes median per annulus.
 * Excludes DC and innermost 5% radius.
 */
export function countSpectralPeaks(
  spectrum: MagnitudeSpectrum2D,
  peakThreshold = 6.0,
): number {
  const { magnitude, fftW, fftH, totalEnergy } = spectrum;
  if (totalEnergy <= 0) return 0;

  const halfW = fftW >>> 1;
  const halfH = fftH >>> 1;
  const totalBins = fftW * fftH;
  // Noise floor: median must exceed this to be meaningful
  const noiseFloor = Math.sqrt(totalEnergy / totalBins) * 0.01;

  const numAnnuli = 10;
  const annuliLists: number[][] = Array.from({ length: numAnnuli }, () => []);

  for (let y = 0; y < fftH; y++) {
    const fy = y <= halfH ? y : fftH - y;
    const fyNorm = fy / halfH;

    for (let x = 0; x < fftW; x++) {
      const fx = x <= halfW ? x : fftW - x;
      const fxNorm = fx / halfW;

      const r = Math.sqrt(fxNorm * fxNorm + fyNorm * fyNorm);
      if (r < 0.05) continue; // Skip DC + innermost 5%

      const annulusIdx = Math.min(Math.floor(r * numAnnuli), numAnnuli - 1);
      annuliLists[annulusIdx].push(magnitude[y * fftW + x]);
    }
  }

  let peakCount = 0;
  for (let a = 0; a < numAnnuli; a++) {
    const bins = annuliLists[a];
    if (bins.length < 3) continue;

    // Compute median
    bins.sort((x, y) => x - y);
    const mid = bins.length >>> 1;
    const median = bins.length % 2 === 0 ? (bins[mid - 1] + bins[mid]) / 2 : bins[mid];
    // Use noise floor as minimum median to avoid false peaks from floating-point noise
    const effectiveMedian = Math.max(median, noiseFloor);
    const thresh = effectiveMedian * peakThreshold;
    for (const val of bins) {
      if (val > thresh) peakCount++;
    }
  }

  return peakCount;
}

/**
 * JPEG 8×8 block grid energy — energy at horizontal/vertical frequency bins
 * at multiples of N/8 (±1 bin neighborhood) relative to total non-DC energy.
 * Uses full-resolution spectrum for accuracy.
 */
/**
 * Measure JPEG 8×8 blockiness via spatial-domain gradient analysis.
 * Compares average absolute gradient at block boundaries (every 8 pixels)
 * to non-boundary gradients. Returns excess ratio (0 = no artifacts).
 * Works on raw greyscale pixel data, not FFT spectrum.
 */
export function jpegBlockiness(
  pixels: Buffer | Uint8Array,
  width: number,
  height: number,
): number {
  if (width < 16 || height < 16) return 0;

  let boundaryGrad = 0, boundaryCount = 0;
  let nonBoundaryGrad = 0, nonBoundaryCount = 0;

  // Horizontal gradients
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const grad = Math.abs(pixels[y * width + x] - pixels[y * width + x - 1]);
      if (x % 8 === 0) {
        boundaryGrad += grad;
        boundaryCount++;
      } else {
        nonBoundaryGrad += grad;
        nonBoundaryCount++;
      }
    }
  }

  // Vertical gradients
  for (let y = 1; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grad = Math.abs(pixels[y * width + x] - pixels[(y - 1) * width + x]);
      if (y % 8 === 0) {
        boundaryGrad += grad;
        boundaryCount++;
      } else {
        nonBoundaryGrad += grad;
        nonBoundaryCount++;
      }
    }
  }

  if (nonBoundaryCount === 0 || boundaryCount === 0) return 0;
  const avgBoundary = boundaryGrad / boundaryCount;
  const avgNonBoundary = nonBoundaryGrad / nonBoundaryCount;

  // When non-boundary gradients are near zero but boundary gradients exist,
  // that's extreme blockiness (q=1 JPEG: blocks are constant, boundaries have steps)
  if (avgNonBoundary < 0.1) {
    return avgBoundary > 0.5 ? 10.0 : 0;
  }

  return Math.max(0, avgBoundary / avgNonBoundary - 1);
}
