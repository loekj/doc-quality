import { describe, it, expect } from 'vitest';
import { fft1d, nextPow2, computeSpectrum2D, downsampleGreyscale } from '../src/fft-core.js';

/** Naive DFT, O(n^2), used only as ground truth. */
function naiveDft(data: Float64Array): Float64Array {
  const n = data.length / 2;
  const out = new Float64Array(n * 2);
  for (let k = 0; k < n; k++) {
    let re = 0, im = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      const c = Math.cos(a), s = Math.sin(a);
      re += data[t * 2] * c - data[t * 2 + 1] * s;
      im += data[t * 2] * s + data[t * 2 + 1] * c;
    }
    out[k * 2] = re; out[k * 2 + 1] = im;
  }
  return out;
}

describe('fft1d against a naive DFT', () => {
  it('matches for random complex input at several sizes', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
    for (const n of [2, 4, 8, 16, 64, 256]) {
      const data = new Float64Array(n * 2);
      for (let i = 0; i < n * 2; i++) data[i] = rnd() * 100;
      const reference = naiveDft(data);
      const actual = new Float64Array(data);
      fft1d(actual, true);
      for (let i = 0; i < n * 2; i++) {
        expect(Math.abs(actual[i] - reference[i])).toBeLessThan(1e-6 * Math.max(1, Math.abs(reference[i])) + 1e-6);
      }
    }
  });

  it('inverts back to the original', () => {
    let seed = 999;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
    const n = 128;
    const original = new Float64Array(n * 2);
    for (let i = 0; i < n * 2; i++) original[i] = rnd() * 50;
    const roundTrip = new Float64Array(original);
    fft1d(roundTrip, true);
    fft1d(roundTrip, false);
    for (let i = 0; i < n * 2; i++) expect(roundTrip[i]).toBeCloseTo(original[i], 9);
  });

  it('leaves length 0 and 1 alone', () => {
    const one = new Float64Array([3, 4]);
    fft1d(one, true);
    expect(Array.from(one)).toEqual([3, 4]);
    const empty = new Float64Array(0);
    expect(() => fft1d(empty, true)).not.toThrow();
  });
});

describe('nextPow2', () => {
  it('returns the smallest power of two at or above n', () => {
    expect([0, 1, 2, 3, 31, 32, 33, 1000, 1024, 1025].map(nextPow2))
      .toEqual([1, 1, 2, 4, 32, 32, 64, 1024, 1024, 2048]);
  });
});

describe('computeSpectrum2D', () => {
  const make = (w: number, h: number, fn: (x: number, y: number) => number) => {
    const p = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      p[y * w + x] = Math.max(0, Math.min(255, Math.round(fn(x, y))));
    }
    return p;
  };
  /** Signed frequency coordinates of the strongest non-DC bin. */
  function peak(spec: NonNullable<ReturnType<typeof computeSpectrum2D>>) {
    const { magnitude, fftW, fftH } = spec;
    let best = -1, bx = 0, by = 0;
    for (let y = 0; y < fftH; y++) for (let x = 0; x < fftW; x++) {
      const m = magnitude[y * fftW + x];
      if (m > best) { best = m; bx = x; by = y; }
    }
    return { fx: bx <= fftW / 2 ? bx : bx - fftW, fy: by <= fftH / 2 ? by : by - fftH };
  }

  it('puts a horizontal sinusoid at the right frequency', () => {
    const spec = computeSpectrum2D(make(64, 64, (x) => 128 + 100 * Math.cos((2 * Math.PI * 8 * x) / 64)), 64, 64)!;
    const { fx, fy } = peak(spec);
    expect(Math.abs(Math.abs(fx) - 8)).toBeLessThanOrEqual(1); // Hann spreads by a bin
    expect(fy).toBe(0);
  });

  it('puts a vertical sinusoid at the right frequency', () => {
    const spec = computeSpectrum2D(make(64, 64, (_x, y) => 128 + 100 * Math.cos((2 * Math.PI * 5 * y) / 64)), 64, 64)!;
    const { fx, fy } = peak(spec);
    expect(fx).toBe(0);
    expect(Math.abs(Math.abs(fy) - 5)).toBeLessThanOrEqual(1);
  });

  it('reports essentially no energy for a flat image', () => {
    // The mean is subtracted, so a constant image has nothing left.
    const spec = computeSpectrum2D(make(64, 64, () => 200), 64, 64)!;
    expect(spec.totalEnergy).toBeLessThan(1e-6);
  });

  it('handles non-square and non-power-of-two sizes', () => {
    for (const [w, h, ew, eh] of [[100, 60, 128, 64], [63, 63, 64, 64], [37, 129, 64, 256]] as const) {
      const spec = computeSpectrum2D(make(w, h, (x) => 128 + 60 * Math.cos((2 * Math.PI * 4 * x) / w)), w, h)!;
      expect(spec.fftW).toBe(ew);
      expect(spec.fftH).toBe(eh);
      expect(spec.origW).toBe(w);
      expect(spec.origH).toBe(h);
    }
  });

  it('returns null below the minimum size', () => {
    expect(computeSpectrum2D(new Uint8Array(31 * 31), 31, 31)).toBeNull();
  });
});

describe('downsampleGreyscale', () => {
  it('preserves the mean of a flat image', () => {
    const px = new Uint8Array(100 * 80).fill(137);
    const out = downsampleGreyscale(px, 100, 80, 25);
    expect(out.width).toBe(25);
    expect(out.height).toBe(20);
    for (const v of out.data) expect(v).toBeCloseTo(137, 6);
  });

  it('preserves the overall mean of a gradient', () => {
    const w = 120, h = 90;
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = Math.round((x / w) * 255);
    let before = 0;
    for (const v of px) before += v;
    const out = downsampleGreyscale(px, w, h, 30);
    let after = 0;
    for (const v of out.data) after += v;
    expect(after / out.data.length).toBeCloseTo(before / px.length, 0);
  });

  it('passes through when no downscale is needed', () => {
    const px = new Uint8Array([1, 2, 3, 4]);
    const out = downsampleGreyscale(px, 2, 2, 10);
    expect(out.width).toBe(2);
    expect(Array.from(out.data)).toEqual([1, 2, 3, 4]);
  });
});
