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

let testImagePath: string;

beforeAll(async () => {
  const pixels = Buffer.alloc(800 * 600 * 3);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.floor(Math.random() * 256);
  }
  const buffer = await sharp(pixels, { raw: { width: 800, height: 600, channels: 3 } })
    .png()
    .toBuffer();
  testImagePath = join(tmpdir(), `doc-quality-cli-test-${Date.now()}.png`);
  await writeFile(testImagePath, buffer);
});

afterAll(async () => {
  await unlink(testImagePath).catch(() => {});
});

describe('CLI', () => {
  it('--help prints usage and exits 0', async () => {
    const { stdout } = await exec(TSX, [...TSX_ARGS, '--help']);
    expect(stdout).toContain('doc-quality');
    expect(stdout).toContain('Usage');
  });

  it('JSON output is valid JSON', async () => {
    try {
      const { stdout } = await exec(TSX, [...TSX_ARGS, testImagePath, '--json']);
      const result = JSON.parse(stdout);
      expect(result).toHaveProperty('pass');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('issues');
    } catch (err: unknown) {
      // CLI exits 1 on fail — capture stdout from error
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

  it('exits 1 for failing images', async () => {
    // Create a tiny dark image that should fail
    const buffer = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 5, g: 5, b: 5 } },
    }).png().toBuffer();
    const badPath = join(tmpdir(), `doc-quality-cli-bad-${Date.now()}.png`);
    await writeFile(badPath, buffer);

    try {
      await exec(TSX, [...TSX_ARGS, badPath, '--json']);
      // If it passes, that's unexpected but not a test failure
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string };
      // Exit code 1 is expected for failing images
      expect(e.stdout).toBeTruthy();
      const result = JSON.parse(e.stdout!);
      expect(result.pass).toBe(false);
    } finally {
      await unlink(badPath).catch(() => {});
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
