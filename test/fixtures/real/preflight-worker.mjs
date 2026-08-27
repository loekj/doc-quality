#!/usr/bin/env node

/**
 * Run the browser preflight once, in a process of its own, and report the
 * result as one line of JSON on stdout.
 *
 * `preflight()` is a browser module: it wants `createImageBitmap`,
 * `OffscreenCanvas` and `ImageBitmap`, none of which Node has. The shim below
 * is the one `test/preflight-guarantee.test.ts` uses, so this runs the real
 * module rather than a mirror of it.
 *
 * It lives in a separate process because @napi-rs/canvas can die *natively* on
 * a format it cannot decode — HEIC takes the whole process down with no
 * exception to catch, and label-server exits on uncaughtException. A decoder
 * that segfaults should cost one analysis, not the server and whoever is
 * labelling at the time.
 *
 * Bytes arrive on stdin. Anything the run prints is captured and returned in
 * the JSON, because stdout here belongs to the protocol.
 */

const logs = [];
const real = {};
for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
  real[level] = console[level];
  console[level] = (...args) => {
    logs.push(`[${level}] ${args.map(String).join(' ')}`);
  };
}

/** Read the whole of stdin as one Buffer. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const startedAt = performance.now();

function done(payload) {
  real.log.call(console, JSON.stringify({ ms: Math.round(performance.now() - startedAt), ...payload, logs }));
  process.exit(0);
}

try {
  const buffer = await readStdin();

  const { createCanvas, loadImage, Image } = await import('@napi-rs/canvas');
  if (!Image.prototype.close) Image.prototype.close = () => {};
  globalThis.ImageBitmap = Image;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { return createCanvas(w, h); }
  };
  globalThis.createImageBitmap = async (input) =>
    input instanceof Image ? input : loadImage(Buffer.from(await input.arrayBuffer()));

  const { preflight } = await import(new URL('../../../dist/preflight.js', import.meta.url).href);

  // A scorer that returns a non-finite number hands back the feature vector
  // without taking over scoring — src/preflight.ts falls through to its own
  // issue-based verdict. So this costs nothing and changes nothing.
  let features = null;
  const started = performance.now();
  const result = await preflight(new Blob([buffer]), {
    scorer: (f) => { features = f; return NaN; },
  });
  const ms = Math.round(performance.now() - started);

  done({
    ok: true,
    ms,
    result,
    features: features
      ? Object.fromEntries(features.names.map((n, i) => [n, features.values[i]]))
      : null,
  });
} catch (err) {
  done({ ok: false, error: err?.message ?? String(err), stack: err?.stack ?? null });
}
