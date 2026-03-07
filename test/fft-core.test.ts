import { describe, it, expect } from 'vitest';
import {
  nextPow2,
  fft1d,
  hannWindow,
  computeSpectrum2D,
  highFreqEnergyRatio,
} from '../src/fft-core.js';

describe('nextPow2', () => {
  it('returns 1 for 0 and 1', () => {
    expect(nextPow2(0)).toBe(1);
    expect(nextPow2(1)).toBe(1);
  });

  it('returns next power of 2 for non-powers', () => {
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(5)).toBe(8);
    expect(nextPow2(7)).toBe(8);
    expect(nextPow2(9)).toBe(16);
    expect(nextPow2(255)).toBe(256);
  });

  it('returns same value for powers of 2', () => {
    expect(nextPow2(2)).toBe(2);
    expect(nextPow2(4)).toBe(4);
    expect(nextPow2(512)).toBe(512);
    expect(nextPow2(1024)).toBe(1024);
  });
});

describe('fft1d', () => {
  it('pure cosine at bin 3 of length 16 has energy at bins 3 and 13', () => {
    const N = 16;
    const data = new Float64Array(N * 2);
    // cos(2π * 3 * n / N) = Re part
    for (let n = 0; n < N; n++) {
      data[n * 2] = Math.cos((2 * Math.PI * 3 * n) / N);
      data[n * 2 + 1] = 0;
    }

    fft1d(data, true);

    // Compute magnitudes
    const mags = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      mags[k] = Math.sqrt(data[k * 2] ** 2 + data[k * 2 + 1] ** 2);
    }

    // Bins 3 and 13 (N-3) should have significant energy
    expect(mags[3]).toBeGreaterThan(1);
    expect(mags[13]).toBeGreaterThan(1);

    // Other bins should be approximately zero
    for (let k = 0; k < N; k++) {
      if (k !== 3 && k !== 13) {
        expect(mags[k]).toBeLessThan(1e-10);
      }
    }
  });

  it('forward + inverse round-trip recovers input', () => {
    const N = 16;
    const original = new Float64Array(N * 2);
    for (let n = 0; n < N; n++) {
      original[n * 2] = Math.sin((2 * Math.PI * 5 * n) / N) + 0.5 * Math.cos((2 * Math.PI * 2 * n) / N);
      original[n * 2 + 1] = 0;
    }

    const data = new Float64Array(original);
    fft1d(data, true);  // Forward
    fft1d(data, false); // Inverse

    for (let n = 0; n < N; n++) {
      expect(data[n * 2]).toBeCloseTo(original[n * 2], 10);
      expect(data[n * 2 + 1]).toBeCloseTo(original[n * 2 + 1], 10);
    }
  });

  it('all-zero input produces all-zero output', () => {
    const N = 8;
    const data = new Float64Array(N * 2);
    fft1d(data, true);
    for (let i = 0; i < data.length; i++) {
      expect(data[i]).toBe(0);
    }
  });
});

describe('hannWindow', () => {
  it('is 0 at edges', () => {
    expect(hannWindow(0, 64)).toBeCloseTo(0, 10);
    expect(hannWindow(63, 64)).toBeCloseTo(0, 10);
  });

  it('is 1 at center for odd N', () => {
    // For odd N, the center is exactly (N-1)/2
    const N = 65;
    expect(hannWindow(32, N)).toBeCloseTo(1, 10);
  });

  it('peaks near 1 at center for even N', () => {
    const N = 64;
    const center = (N - 1) / 2;
    expect(hannWindow(Math.floor(center), N)).toBeGreaterThan(0.99);
  });

  it('returns 1 for N=1', () => {
    expect(hannWindow(0, 1)).toBe(1);
  });
});

describe('computeSpectrum2D', () => {
  it('constant image has energy only at DC, high-freq ratio ≈ 0', () => {
    const w = 64, h = 64;
    const pixels = Buffer.alloc(w * h, 128);

    const spectrum = computeSpectrum2D(pixels, w, h);
    expect(spectrum).not.toBeNull();

    const ratio = highFreqEnergyRatio(spectrum!);
    expect(ratio).toBeLessThan(0.01);
  });

  it('random noise has high high-freq ratio', () => {
    const w = 64, h = 64;
    const pixels = Buffer.alloc(w * h);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = Math.floor(Math.random() * 256);
    }

    const spectrum = computeSpectrum2D(pixels, w, h);
    expect(spectrum).not.toBeNull();

    const ratio = highFreqEnergyRatio(spectrum!);
    // After mean subtraction, random noise energy is spread across all frequencies
    expect(ratio).toBeGreaterThan(0.5);
  });

  it('returns null for images smaller than 32px', () => {
    const pixels = Buffer.alloc(16 * 16, 128);
    expect(computeSpectrum2D(pixels, 16, 16)).toBeNull();
  });

  it('all-zero input does not crash, magnitude all zeros', () => {
    const w = 32, h = 32;
    const pixels = Buffer.alloc(w * h, 0);

    const spectrum = computeSpectrum2D(pixels, w, h);
    expect(spectrum).not.toBeNull();
    expect(spectrum!.totalEnergy).toBe(0);
    for (let i = 0; i < spectrum!.magnitude.length; i++) {
      expect(spectrum!.magnitude[i]).toBe(0);
    }
  });

  it('handles non-square (rectangular) images', () => {
    const w = 100, h = 64;
    const pixels = Buffer.alloc(w * h);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = Math.floor(Math.random() * 256);
    }

    const spectrum = computeSpectrum2D(pixels, w, h);
    expect(spectrum).not.toBeNull();
    // Width pads to 128, height stays 64
    expect(spectrum!.fftW).toBe(128);
    expect(spectrum!.fftH).toBe(64);
  });

  it('downsamples when maxDim is given', () => {
    const w = 200, h = 300;
    const pixels = Buffer.alloc(w * h, 128);

    const spectrum = computeSpectrum2D(pixels, w, h, 64);
    expect(spectrum).not.toBeNull();
    // Should have been downsampled proportionally
    expect(spectrum!.origW).toBeLessThanOrEqual(64);
    expect(spectrum!.origH).toBeLessThanOrEqual(64);
  });
});
