import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  checkQuality,
  isHeif,
  decodeHeif,
  getHeifDecodeConcurrency,
  setHeifDecodeConcurrency,
} from '../src/index.js';

/**
 * HEIC is the format a phone camera roll is mostly made of, and sharp cannot
 * read it: its prebuilt binaries carry no HEVC decoder on any platform, for
 * licensing reasons. It advertises `heif` as an input format and will read a
 * header — dimensions, `format: 'heif'` — then fail on the pixels. So every
 * mode threw on a photo straight off an iPhone until `heic-convert` was wired
 * in ahead of the pipeline.
 */

/** Build an ISO-BMFF `ftyp` box: size, 'ftyp', major brand, minor version, compatible brands. */
function ftyp(major: string, compatible: string[] = []): Buffer {
  const size = 16 + compatible.length * 4;
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);
  buf.write('ftyp', 4, 'latin1');
  buf.write(major, 8, 'latin1');
  buf.writeUInt32BE(0, 12);
  compatible.forEach((brand, i) => buf.write(brand, 16 + i * 4, 'latin1'));
  return buf;
}

describe('HEIF detection', () => {
  it('claims HEVC-coded images by brand, not by extension', () => {
    expect(isHeif(ftyp('heic', ['mif1']))).toBe(true);
    expect(isHeif(ftyp('heix'))).toBe(true);
    // Generic HEIF brand as major, HEVC brand among the compatible ones.
    expect(isHeif(ftyp('mif1', ['heic']))).toBe(true);
  });

  it('leaves AVIF alone', () => {
    // AVIF is the same container and lists `mif1` as compatible, so a brand
    // check that only looked for HEIF brands would claim it — and then hand AV1
    // payload to a decoder that only speaks HEVC.
    expect(isHeif(ftyp('avif', ['mif1', 'miaf']))).toBe(false);
    expect(isHeif(ftyp('avis', ['mif1']))).toBe(false);
  });

  it('leaves other containers and short buffers alone', () => {
    expect(isHeif(ftyp('isom', ['mp42', 'avc1']))).toBe(false);
    expect(isHeif(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(isHeif(Buffer.alloc(8))).toBe(false);
    expect(isHeif(Buffer.alloc(0))).toBe(false);
  });

  it('does not claim an ordinary JPEG or PNG', async () => {
    const page = sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } });
    expect(isHeif(await page.clone().jpeg().toBuffer())).toBe(false);
    expect(isHeif(await page.clone().png().toBuffer())).toBe(false);
  });
});

describe('HEIF input reaches the analyzers', () => {
  /**
   * Encoding a real HEIC needs the encoder this platform does not have, so the
   * conversion path is exercised through the public API with a JPEG: it must
   * take the ordinary route and be reported at its own size.
   */
  it('reports the size of the file it was given, not of the decoded copy', async () => {
    const jpeg = await sharp({
      create: { width: 400, height: 300, channels: 3, background: '#f4f4f0' },
    }).jpeg().toBuffer();

    const result = await checkQuality(jpeg, { mode: 'fast', preset: 'document', timeout: 0 });
    expect(result.metadata.fileSize).toBe(jpeg.length);
  });
});

describe('HEIF decoding is bounded and cancellable', () => {
  /**
   * Each decode holds ~195 MB while it runs. In-process decoding bounded that
   * by accident — it held the event loop, so only one could run — and moving to
   * a worker removed the accident: eight concurrent decodes peaked at 2.5 GB of
   * RSS before this limit existed.
   */
  it('defaults to a concurrency a small container can survive', () => {
    expect(getHeifDecodeConcurrency()).toBe(2);
  });

  it('refuses a limit that would disable the bound', () => {
    const original = getHeifDecodeConcurrency();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => setHeifDecodeConcurrency(bad)).toThrow(/positive integer/);
    }
    expect(getHeifDecodeConcurrency()).toBe(original);
  });

  it('restores the limit it was given', () => {
    const original = getHeifDecodeConcurrency();
    setHeifDecodeConcurrency(4);
    expect(getHeifDecodeConcurrency()).toBe(4);
    setHeifDecodeConcurrency(original);
    expect(getHeifDecodeConcurrency()).toBe(original);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    // addEventListener does not fire for an abort that already happened, so
    // without an explicit check a cancelled caller still paid for the decode.
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await expect(decodeHeif(Buffer.alloc(64), controller.signal)).rejects.toThrow(/aborted/);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
