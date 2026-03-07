import { describe, it, expect, afterEach } from 'vitest';
import sharp from 'sharp';
import {
  checkQuality,
  registerFFTAnalyzer,
  clearFFTAnalyzers,
  hasFFTAnalyzers,
} from '../src/index.js';

async function makeNoisyImage(width = 800, height = 600): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.floor(Math.random() * 256);
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

afterEach(() => {
  clearFFTAnalyzers();
});

describe('FFT analyzer registration', () => {
  it('starts with no analyzers registered', () => {
    expect(hasFFTAnalyzers()).toBe(false);
  });

  it('registers and runs a custom analyzer alongside built-in ones', async () => {
    registerFFTAnalyzer('fftBlur', async () => [
      {
        analyzer: 'fftBlur',
        message: 'Mock FFT blur detected',
        value: 0.05,
        threshold: 0.15,
        penalty: 0.6,
      },
    ]);

    expect(hasFFTAnalyzers()).toBe(true);

    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, { mode: 'thorough' });
    // User-registered analyzer should have run
    const issues = result.issues.filter((i) => i.analyzer === 'fftBlur');
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it('FFT analyzers only run in thorough mode', async () => {
    const buffer = await makeNoisyImage();
    const fast = await checkQuality(buffer, { mode: 'fast' });
    const thorough = await checkQuality(buffer, { mode: 'thorough' });

    // Built-in FFT analyzers should not appear in fast mode
    expect(fast.issues.find((i) => i.analyzer === 'fftBlur')).toBeUndefined();
    expect(fast.issues.find((i) => i.analyzer === 'fftNoise')).toBeUndefined();
    expect(fast.issues.find((i) => i.analyzer === 'fftMoire')).toBeUndefined();

    // Thorough should have FFT timings
    expect(thorough.timing.analyzers.fftBlur).toBeDefined();
  });

  it('swallows errors from registered FFT analyzers', async () => {
    registerFFTAnalyzer('fftBlur', async () => {
      throw new Error('FFT computation failed');
    });

    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, { mode: 'thorough' });
    expect(result).toHaveProperty('pass');
  });

  it('clearFFTAnalyzers removes all', () => {
    registerFFTAnalyzer('fftBlur', async () => []);
    registerFFTAnalyzer('fftNoise', async () => []);
    expect(hasFFTAnalyzers()).toBe(true);

    clearFFTAnalyzers();
    expect(hasFFTAnalyzers()).toBe(false);
  });
});

describe('Built-in FFT analyzers', () => {
  it('Gaussian-blurred image triggers fftBlur', async () => {
    // Create a smooth gradient image (no high-frequency content)
    const width = 400, height = 400;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const val = Math.floor((x / width) * 200) + 28;
        const idx = (y * width + x) * 3;
        pixels[idx] = val;
        pixels[idx + 1] = val;
        pixels[idx + 2] = val;
      }
    }
    const buffer = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .blur(10) // Strong Gaussian blur
      .png()
      .toBuffer();

    const result = await checkQuality(buffer, {
      mode: 'thorough',
      thresholds: { fftBlurHighFreqMin: 0.005 },
    });
    const issue = result.issues.find((i) => i.analyzer === 'fftBlur');
    expect(issue).toBeDefined();
    expect(issue!.penalty).toBe(0.6);
  });

  it('sharp noisy image does NOT trigger fftBlur', async () => {
    // Use small image to avoid downsampling smoothing
    const buffer = await makeNoisyImage(400, 300);
    const result = await checkQuality(buffer, { mode: 'thorough' });
    const issue = result.issues.find((i) => i.analyzer === 'fftBlur');
    expect(issue).toBeUndefined();
  });

  it('salt-and-pepper noise triggers fftNoise', async () => {
    // Small image to avoid downsampling smoothing
    const width = 400, height = 300;
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const val = Math.random() > 0.5 ? 255 : 0;
      pixels[i * 3] = val;
      pixels[i * 3 + 1] = val;
      pixels[i * 3 + 2] = val;
    }
    const buffer = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();

    const result = await checkQuality(buffer, { mode: 'thorough' });
    const issue = result.issues.find((i) => i.analyzer === 'fftNoise');
    expect(issue).toBeDefined();
    expect(issue!.penalty).toBe(0.7);
  });

  it('clean image does NOT trigger fftNoise', async () => {
    // Smooth gradient — not noisy
    const width = 400, height = 400;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const val = Math.floor((x / width) * 200) + 28;
        const idx = (y * width + x) * 3;
        pixels[idx] = val;
        pixels[idx + 1] = val;
        pixels[idx + 2] = val;
      }
    }
    const buffer = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();

    const result = await checkQuality(buffer, { mode: 'thorough' });
    const issue = result.issues.find((i) => i.analyzer === 'fftNoise');
    expect(issue).toBeUndefined();
  });

  it('synthetic moiré triggers fftMoire with lower threshold', async () => {
    // Overlaid sine gratings at many frequencies create moiré-like spectral peaks
    const width = 512, height = 512;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let val = 128;
        // Many overlapping frequencies to create dense spectral peaks
        for (let f = 10; f < 200; f += 7) {
          val += 10 * Math.sin(2 * Math.PI * x * f / width);
          val += 10 * Math.sin(2 * Math.PI * y * f / height);
        }
        const idx = (y * width + x) * 3;
        const clamped = Math.max(0, Math.min(255, Math.floor(val)));
        pixels[idx] = clamped;
        pixels[idx + 1] = clamped;
        pixels[idx + 2] = clamped;
      }
    }
    const buffer = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();

    // Use a threshold that detects the synthetic pattern
    const result = await checkQuality(buffer, {
      mode: 'thorough',
      thresholds: { fftMoirePeaksMax: 10 },
    });
    const issue = result.issues.find((i) => i.analyzer === 'fftMoire');
    expect(issue).toBeDefined();
    expect(issue!.penalty).toBe(0.7);
  });

  it('normal noisy image does NOT trigger fftMoire', async () => {
    // Random noise has broad spectrum but no sharp spectral peaks
    const buffer = await makeNoisyImage(400, 300);
    const result = await checkQuality(buffer, { mode: 'thorough' });
    const issue = result.issues.find((i) => i.analyzer === 'fftMoire');
    expect(issue).toBeUndefined();
  });

  it('JPEG quality=1 triggers fftJpegArtifact', async () => {
    // Create a textured image — JPEG quality=1 makes 8×8 blocks very visible
    const width = 400, height = 400;
    const pixels = Buffer.alloc(width * height * 3);
    // Use a smoothly varying pattern that gets badly quantized at q=1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const val = Math.floor(
          128
          + 60 * Math.sin(x * 0.05)
          + 40 * Math.cos(y * 0.07)
          + 30 * Math.sin((x + y) * 0.03),
        );
        const idx = (y * width + x) * 3;
        pixels[idx] = Math.max(0, Math.min(255, val));
        pixels[idx + 1] = Math.max(0, Math.min(255, val));
        pixels[idx + 2] = Math.max(0, Math.min(255, val));
      }
    }
    const jpegBuffer = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 1 })
      .toBuffer();

    const result = await checkQuality(jpegBuffer, { mode: 'thorough' });
    const issue = result.issues.find((i) => i.analyzer === 'fftJpegArtifact');
    expect(issue).toBeDefined();
    expect(issue!.penalty).toBe(0.8);
  });

  it('fftJpegArtifact does not fire for non-JPEG', async () => {
    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, { mode: 'thorough' });
    const issue = result.issues.find((i) => i.analyzer === 'fftJpegArtifact');
    expect(issue).toBeUndefined();
  });

  it('FFT timings are present in thorough results', async () => {
    const buffer = await makeNoisyImage();
    const result = await checkQuality(buffer, { mode: 'thorough' });
    expect(result.timing.analyzers.fftBlur).toBeDefined();
    expect(result.timing.analyzers.fftNoise).toBeDefined();
    expect(result.timing.analyzers.fftMoire).toBeDefined();
  });
});
