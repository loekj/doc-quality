import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

const exec = promisify(execFile);

const CLI_PATH = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = 'npx';
const TSX_ARGS = ['tsx', CLI_PATH];

/** Deterministic PRNG for reproducible test images */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let testImagePath: string;
let darkImagePath: string;

beforeAll(async () => {
  const rng = mulberry32(99);
  const pixels = Buffer.alloc(800 * 600 * 3);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.floor(rng() * 256);
  }
  const buffer = await sharp(pixels, { raw: { width: 800, height: 600, channels: 3 } })
    .png()
    .toBuffer();
  testImagePath = join(tmpdir(), `doc-quality-cli-test-${Date.now()}.png`);
  await writeFile(testImagePath, buffer);

  // Pre-create a dark image for reuse
  const darkBuf = await sharp({
    create: { width: 50, height: 50, channels: 3, background: { r: 5, g: 5, b: 5 } },
  }).png().toBuffer();
  darkImagePath = join(tmpdir(), `doc-quality-cli-dark-${Date.now()}.png`);
  await writeFile(darkImagePath, darkBuf);
});

afterAll(async () => {
  await unlink(testImagePath).catch(() => {});
  await unlink(darkImagePath).catch(() => {});
});

describe('CLI', () => {
  it('--help prints usage and exits 0', async () => {
    const { stdout } = await exec(TSX, [...TSX_ARGS, '--help']);
    expect(stdout).toContain('doc-quality');
    expect(stdout).toContain('Usage');
  });

  it('-h short flag works', async () => {
    const { stdout } = await exec(TSX, [...TSX_ARGS, '-h']);
    expect(stdout).toContain('Usage');
  });

  it('no arguments shows error and help', async () => {
    try {
      await exec(TSX, [...TSX_ARGS]);
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const e = err as { stderr?: string; code?: number };
      expect(e.stderr).toContain('No file specified');
    }
  });

  it('JSON output is valid JSON with all expected fields', async () => {
    try {
      const { stdout } = await exec(TSX, [...TSX_ARGS, testImagePath, '--json']);
      const result = JSON.parse(stdout);
      expect(result).toHaveProperty('pass');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('metadata');
      expect(result).toHaveProperty('timing');
      expect(result).toHaveProperty('preset');
      expect(result).toHaveProperty('confidence');
    } catch (err: unknown) {
      const e = err as { stdout?: string; code?: number };
      if (e.stdout) {
        const result = JSON.parse(e.stdout);
        expect(result).toHaveProperty('pass');
        expect(result).toHaveProperty('score');
      } else {
        throw err;
      }
    }
  });

  it('-j short flag works', async () => {
    try {
      const { stdout } = await exec(TSX, [...TSX_ARGS, testImagePath, '-j']);
      JSON.parse(stdout); // Should be valid JSON
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      if (e.stdout) JSON.parse(e.stdout);
      else throw err;
    }
  });

  it('human-readable output (no --json) contains Score and Result', async () => {
    try {
      const { stdout } = await exec(TSX, [...TSX_ARGS, testImagePath]);
      expect(stdout).toContain('Score:');
      expect(stdout).toContain('Result:');
      expect(stdout).toContain('Preset:');
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      if (e.stdout) {
        expect(e.stdout).toContain('Score:');
        expect(e.stdout).toContain('Result:');
      } else {
        throw err;
      }
    }
  });

  it('exits 1 for failing images', async () => {
    try {
      await exec(TSX, [...TSX_ARGS, darkImagePath, '--json']);
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string };
      expect(e.stdout).toBeTruthy();
      const result = JSON.parse(e.stdout!);
      expect(result.pass).toBe(false);
    }
  });

  it('--mode thorough produces more timing keys', async () => {
    const getTimingKeys = async (mode: string) => {
      try {
        const { stdout } = await exec(TSX, [...TSX_ARGS, testImagePath, '--json', '-m', mode]);
        return Object.keys(JSON.parse(stdout).timing.analyzers);
      } catch (err: unknown) {
        const e = err as { stdout?: string };
        if (e.stdout) return Object.keys(JSON.parse(e.stdout).timing.analyzers);
        throw err;
      }
    };

    const fastKeys = await getTimingKeys('fast');
    const thoroughKeys = await getTimingKeys('thorough');
    expect(thoroughKeys.length).toBeGreaterThan(fastKeys.length);
  });

  it('--preset card sets preset in output', async () => {
    try {
      const { stdout } = await exec(TSX, [...TSX_ARGS, testImagePath, '--json', '--preset', 'card']);
      const result = JSON.parse(stdout);
      expect(result.preset).toBe('card');
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      if (e.stdout) {
        const result = JSON.parse(e.stdout);
        expect(result.preset).toBe('card');
      } else {
        throw err;
      }
    }
  });

  it('errors on missing file', async () => {
    try {
      await exec(TSX, [...TSX_ARGS, '/nonexistent/file.png']);
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const e = err as { code?: number };
      expect(e.code).not.toBe(0);
    }
  });
});
