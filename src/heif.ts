/**
 * HEIC/HEIF input.
 *
 * sharp cannot decode these. It advertises `heif` as an input format and will
 * happily read the header — reporting dimensions and `format: 'heif'` — then
 * fail on the pixels with `No decoding plugin installed for this compression
 * format`. Its prebuilt binaries carry no HEVC decoder on any platform, for
 * licensing reasons, so this is not a missing-install problem a user can fix.
 *
 * Since a phone camera roll is mostly HEIC, refusing them outright would reject
 * the commonest photo there is. `heic-convert` is pure JavaScript and does
 * decode them, so it is an optional peer dependency here, the same arrangement
 * PDF support already uses.
 */

/**
 * Brands that mean "HEVC-coded image", plus the two generic HEIF brands that
 * HEIC files list among their compatible brands.
 */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/**
 * Brands that share the HEIF container but not its codec.
 *
 * AVIF is ISO-BMFF too and lists `mif1` as a compatible brand, so a naive brand
 * check claims it. Its payload is AV1, which `heic-convert` cannot decode, so
 * claiming it here would turn a clear sharp error into a confusing one from a
 * converter that was never going to work.
 */
const NON_HEVC_BRANDS = new Set(['avif', 'avis']);

/**
 * Identify HEIC/HEIF from the bytes.
 *
 * The extension is a claim, not a fact, and this decides whether a buffer is
 * handed to a decoder that cannot cope with being wrong.
 *
 * ISO-BMFF layout: a 4-byte box size, `ftyp`, a 4-byte major brand, a 4-byte
 * minor version, then any number of 4-byte compatible brands.
 */
export function isHeif(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer.subarray(4, 8).toString('latin1') !== 'ftyp') return false;

  const major = buffer.subarray(8, 12).toString('latin1');
  if (NON_HEVC_BRANDS.has(major)) return false;
  if (HEIF_BRANDS.has(major)) return true;

  // Major brand was something else — check the compatible brands list, bounded
  // by the box size so a corrupt length cannot walk off the buffer.
  const boxSize = Math.min(buffer.readUInt32BE(0), buffer.length);
  for (let off = 16; off + 4 <= boxSize; off += 4) {
    const brand = buffer.subarray(off, off + 4).toString('latin1');
    if (NON_HEVC_BRANDS.has(brand)) return false;
    if (HEIF_BRANDS.has(brand)) return true;
  }
  return false;
}

/**
 * Decode HEIC/HEIF to PNG for analysis.
 *
 * PNG, not JPEG. A lossy hop stamps fresh compression damage into the pixels,
 * which `deep` mode then reports as a defect of the original — the analysis
 * would be grading this library's own conversion. The cost is size: a 2.6 MB
 * HEIC becomes roughly 25 MB of PNG, and everything downstream is slower for it.
 *
 * What the transcode cannot give back is the original encoding. Compression
 * signals — `heavy-compression`, `jpeg-artifacts` — describe the PNG, which is
 * lossless, so they say nothing about how the HEIC was encoded. Sharpness,
 * brightness, geometry and legibility are all measured on the real pixels and
 * are unaffected.
 */
/**
 * The worker's whole program.
 *
 * Inlined as a string rather than shipped as `dist/heif-worker.js`, because a
 * library cannot rely on finding its own files at runtime: bundlers rewrite
 * paths, and the ESM and CJS builds disagree about what "here" means. A string
 * has no path to lose.
 *
 * `heic-convert` is resolved by the parent and handed over as an absolute URL —
 * a worker created from source has no filename, so a bare specifier inside it
 * resolves against the process's working directory, which is the application's
 * business and not necessarily anywhere near this package.
 */
const WORKER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads';
const mod = await import(workerData.modUrl);
const convert = mod.default ?? mod;
const out = await convert({ buffer: Buffer.from(workerData.bytes), format: 'PNG' });
const png = Buffer.from(out);
parentPort.postMessage(png, [png.buffer]);
`;

/**
 * How many HEIC decodes may run at once.
 *
 * Two, because each one costs about 195 MB while it runs — a 3024×4032 photo is
 * ~48 MB of raw RGBA plus a ~25 MB PNG, and the worker's own heap on top.
 * Measured peak RSS: 1 concurrent 414 MB, 4 concurrent 1.2 GB, 8 concurrent
 * 2.5 GB. Unbounded, sixteen simultaneous uploads would ask for ~3 GB and be
 * killed on any ordinary container.
 *
 * Decoding in-process used to bound this by accident: it held the event loop, so
 * only one could ever run. Moving to a worker removed that accident, and this
 * replaces it deliberately.
 *
 * Throughput scales nearly linearly with concurrency where memory allows — on a
 * 14-core machine, 1 gives 0.68 img/s and 6 gives 3.60 — so raise it if your
 * container has the headroom. The default assumes it does not.
 */
let maxConcurrentDecodes = 2;
let activeDecodes = 0;
const decodeQueue: Array<() => void> = [];

/**
 * Set how many HEIC/HEIF decodes may run concurrently. Default 2.
 *
 * Budget roughly 195 MB per concurrent decode. Raising this trades memory for
 * throughput; there is no benefit past the core count.
 */
export function setHeifDecodeConcurrency(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`HEIF decode concurrency must be a positive integer, got ${limit}`);
  }
  maxConcurrentDecodes = limit;
  // Let anything already queued start if the ceiling just went up.
  while (activeDecodes < maxConcurrentDecodes && decodeQueue.length > 0) {
    decodeQueue.shift()!();
  }
}

/** Current HEIC/HEIF decode concurrency limit. */
export function getHeifDecodeConcurrency(): number {
  return maxConcurrentDecodes;
}

/** Wait for a decode slot. Returns the function that gives it back. */
async function acquireDecodeSlot(signal?: AbortSignal): Promise<() => void> {
  if (activeDecodes >= maxConcurrentDecodes) {
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      function onAbort() {
        const i = decodeQueue.indexOf(start);
        if (i >= 0) decodeQueue.splice(i, 1);
        reject(new Error('HEIC/HEIF decode was aborted'));
      }
      // Aborting while queued must free the slot for someone else rather than
      // decode an image whose caller has already given up on it.
      signal?.addEventListener('abort', onAbort, { once: true });
      decodeQueue.push(start);
    });
  }
  activeDecodes++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeDecodes--;
    decodeQueue.shift()?.();
  };
}

/**
 * Say plainly that the file could not be decoded.
 *
 * heic-convert reports a damaged file as "HEIF image not found", which reads
 * like the wrong file was handed over rather than a truncated upload.
 */
function describeDecodeFailure(err: unknown, buffer: Buffer): Error {
  return new Error(
    `Could not decode this HEIC/HEIF file — it may be truncated or damaged (${buffer.length} bytes): ` +
    `${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Resolve `heic-convert` to a file URL, or explain why it cannot be found. */
async function resolveConverter(): Promise<string> {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('heic-convert')).href;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'HEIC/HEIF input requires the optional peer dependency `heic-convert`. ' +
        'sharp cannot decode HEVC — its prebuilt binaries ship without an HEVC decoder ' +
        'on every platform, for licensing reasons. Install it with `npm install heic-convert`.',
      );
    }
    throw err;
  }
}

/**
 * Decode in a worker thread.
 *
 * `heic-convert` is pure JavaScript, so decoding in-process holds the event loop
 * for seconds: a `timeout` could not fire while it ran, and every other request
 * on the process stalled behind it. Measured on a 2.6 MB photo — 137 of an
 * expected ~150 timer ticks still fired during a worker decode, against a loop
 * that was effectively frozen before.
 *
 * A worker also makes the timeout real. `Promise.race` abandons a result but
 * cannot stop the work, so an abandoned in-process decode kept burning CPU and
 * slowed whatever came next; two overlapping calls took 12 s. `terminate()`
 * actually stops it, and reclaims the ~70 MB of decode buffers with it.
 *
 * Startup is ~17 ms against a decode of 1.5 s or more, so it costs about 1%.
 */
async function decodeInWorker(
  Worker: typeof import('node:worker_threads').Worker,
  modUrl: string,
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { modUrl, bytes: buffer },
    });

    let started = false;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    function onAbort() {
      finish(() => reject(new Error('HEIC/HEIF decode was aborted')));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('online', () => { started = true; });
    worker.on('message', (png: Buffer) => finish(() => resolve(Buffer.from(png))));
    worker.on('error', (err: Error) => finish(() => {
      // A thread that never came online failed to start; one that did has
      // genuinely failed to decode. Only the first is worth retrying inline.
      if (!started) err.name = 'WorkerStartError';
      reject(err);
    }));
    worker.on('exit', (code) => {
      // Only reached when neither a message nor an error arrived first.
      finish(() => reject(new Error(`HEIC/HEIF decode worker exited with code ${code}`)));
    });
  });
}

export async function decodeHeif(buffer: Buffer, signal?: AbortSignal): Promise<Buffer> {
  // A signal that is already aborted must not start work. `addEventListener`
  // does not fire for an abort that has already happened, so without this check
  // a caller who cancelled first still paid for the whole decode.
  if (signal?.aborted) throw new Error('HEIC/HEIF decode was aborted');

  // Resolving the converter and loading worker_threads happen before a slot is
  // taken: both are cheap, and failing here should not make anyone queue.
  const modUrl = await resolveConverter();

  let Worker: typeof import('node:worker_threads').Worker | undefined;
  try {
    ({ Worker } = await import('node:worker_threads'));
  } catch {
    // A runtime without worker threads. Decoding on this thread holds the event
    // loop, but that beats refusing the file outright.
    Worker = undefined;
  }

  const release = await acquireDecodeSlot(signal);
  try {
    if (!Worker) return await decodeInline(buffer, modUrl);
    try {
      return await decodeInWorker(Worker, modUrl, buffer, signal);
    } catch (err) {
      // Only a thread that never started is worth retrying inline. A decode
      // that ran and failed has already told us the file is unreadable, and
      // running it again would just spend the time twice to say so.
      if (err instanceof Error && err.name === 'WorkerStartError') {
        return await decodeInline(buffer, modUrl);
      }
      if (err instanceof Error && err.message === 'HEIC/HEIF decode was aborted') throw err;
      throw describeDecodeFailure(err, buffer);
    }
  } finally {
    release();
  }
}

/** Last resort: decode on this thread, holding the event loop while it runs. */
async function decodeInline(buffer: Buffer, modUrl: string): Promise<Buffer> {
  let convert: typeof import('heic-convert').default;
  try {
    const mod = (await import(/* @vite-ignore */ modUrl)) as { default: typeof convert };
    convert = mod.default ?? (mod as unknown as typeof convert);
  } catch (err) {
    // Only a genuinely absent module means "not installed". An installed
    // package that throws while evaluating would otherwise be reported as
    // missing, sending whoever reads this to reinstall something already there.
    if ((err as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'HEIC/HEIF input requires the optional peer dependency `heic-convert`. ' +
        'sharp cannot decode HEVC — its prebuilt binaries ship without an HEVC decoder ' +
        'on every platform, for licensing reasons. Install it with `npm install heic-convert`.',
      );
    }
    throw new Error(
      `HEIC/HEIF input: loading \`heic-convert\` failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    return Buffer.from(await convert({ buffer, format: 'PNG' }));
  } catch (err) {
    throw describeDecodeFailure(err, buffer);
  }
}
