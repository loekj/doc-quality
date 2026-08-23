/**
 * PDF content classification and embedded-image extraction.
 *
 * Rendering a PDF page to PNG and grading the result answers the wrong
 * question twice:
 *
 * 1. A born-digital PDF has a perfect text layer. Its rendered pixels grade
 *    whatever the renderer produced, not the quality of the document.
 * 2. Rendering resamples embedded scans to the viewport and emits PNG, which
 *    erases the JPEG blocking and the bits-per-pixel that made the scan bad.
 *    A 300 DPI scan saved at JPEG quality 6 scores 0.70 and passes when
 *    rendered; the same scan read out of the PDF scores 0.39 and fails.
 *
 * So: classify the page, and grade the embedded raster images at their native
 * resolution instead.
 *
 * Requires `pdfjs-dist`, which ships as a dependency of `pdf-to-png-converter`.
 */

/** What kind of content a PDF page holds. */
export type PdfPageKind =
  /** A text layer with no meaningful raster content — quality analysis does not apply. */
  | 'digital-text'
  /** One raster image covering essentially the whole page — a scan or photo. */
  | 'scanned'
  /** Text plus embedded raster images — grade the images only. */
  | 'mixed'
  /** Neither text nor images. */
  | 'empty';

/** A raster image embedded in a PDF page. */
export interface EmbeddedImage {
  /** pdf.js object id, e.g. `img_p0_1` */
  objId: string;
  /** Encoded image bytes, ready for `checkQuality`. */
  buffer: Buffer;
  /**
   * `jpeg` when the original DCTDecode stream was recovered byte for byte —
   * compression metrics are meaningful. `png` when the image had to be
   * re-encoded from decoded pixels, which discards the original compression.
   */
  format: 'jpeg' | 'png';
  /** Native pixel width. */
  width: number;
  /** Native pixel height. */
  height: number;
  /** Width the image occupies on the page, in PDF points (72 pt = 1 inch). */
  placedWidthPt: number;
  /** Height the image occupies on the page, in PDF points. */
  placedHeightPt: number;
  /** Fraction of the page area this image covers, 0-1. */
  coverage: number;
  /**
   * True scan resolution: native pixels divided by placed size in inches.
   * This is the number a user can act on — "rescan at 300 DPI".
   */
  effectiveDpi: number;
}

/** Classification result for one PDF page. */
export interface PdfPageContent {
  /** 1-indexed page number. */
  page: number;
  kind: PdfPageKind;
  /** Total characters in the page's text layer. */
  textChars: number;
  /** Embedded images large enough to be worth grading. */
  images: EmbeddedImage[];
  /** Combined page-area fraction covered by those images. */
  imageCoverage: number;
  /** Page width in PDF points. */
  pageWidthPt: number;
  /** Page height in PDF points. */
  pageHeightPt: number;
}

// ── Classification thresholds ────────────────────────────────────

/** Below this page-area fraction an image is decoration (logo, rule, icon). */
const MIN_IMAGE_COVERAGE = 0.02;
/** Below this pixel count an image cannot carry document content. */
const MIN_IMAGE_PIXELS = 10_000; // 100x100
/** A page needs at least this many characters to count as having a text layer. */
const MIN_TEXT_CHARS = 50;
/** At or above this coverage the page is a scan rather than a text page with pictures. */
const SCANNED_COVERAGE = 0.6;

// ── pdf.js loading ───────────────────────────────────────────────

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => {
      throw new Error(
        'PDF content analysis requires "pdfjs-dist". Install it:\n  npm install pdfjs-dist',
      );
    }) as Promise<PdfjsModule>;
  }
  return pdfjsPromise;
}

// ── Raw DCTDecode stream recovery ────────────────────────────────

/**
 * A PDF image XObject filtered with DCTDecode stores a complete JPEG file
 * verbatim. Recovering those bytes preserves file size, bits-per-pixel and the
 * 8x8 block structure — everything a re-encode would throw away.
 *
 * Only single-filter DCTDecode streams are safe to slice: `[/FlateDecode
 * /DCTDecode]` means the JPEG is itself deflated, so the raw bytes are not a
 * JPEG. Every candidate is verified against the JPEG SOI marker before use.
 */
function recoverJpegStreams(buffer: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const text = buffer.toString('latin1');
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;

  let match: RegExpExecArray | null;
  while ((match = objRe.exec(text)) !== null) {
    const objNum = match[1];
    const bodyStart = match.index + match[0].length;

    const streamAt = text.indexOf('stream', bodyStart);
    if (streamAt === -1) continue;
    // The dictionary is everything between `obj` and `stream`.
    const dict = text.slice(bodyStart, streamAt);
    // Cheap reject before the more expensive checks.
    if (dict.length > 4096) continue;
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;

    // DCTDecode must be the only filter.
    const filter = /\/Filter\s*(\/\w+|\[[^\]]*\])/.exec(dict);
    if (!filter) continue;
    const filters = (filter[1].match(/\/\w+/g) ?? []).map((f) => f.slice(1));
    if (filters.length !== 1 || filters[0] !== 'DCTDecode') continue;

    // A /Decode array remaps sample values, and Adobe's CMYK JPEGs routinely
    // carry [1 0 1 0 1 0 1 0] to invert them. The raw stream knows nothing
    // about that, so handing it straight to an image decoder would analyse an
    // inverted page — greyscale mean 28 where the truth is 228, which reads as
    // a hopelessly dark scan. Leave these to pdf.js, which applies /Decode.
    if (/\/Decode\s*\[/.test(dict)) continue;

    // Skip the EOL that must follow the `stream` keyword.
    let dataStart = streamAt + 'stream'.length;
    if (text[dataStart] === '\r') dataStart++;
    if (text[dataStart] === '\n') dataStart++;

    // /Length may be an indirect reference — fall back to scanning for endstream.
    const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let dataEnd: number;
    if (lengthMatch) {
      dataEnd = dataStart + parseInt(lengthMatch[1], 10);
    } else {
      const endAt = text.indexOf('endstream', dataStart);
      if (endAt === -1) continue;
      dataEnd = endAt;
    }
    if (dataEnd <= dataStart || dataEnd > buffer.length) continue;

    const bytes = buffer.subarray(dataStart, dataEnd);
    // JPEG SOI — the guard that makes the whole heuristic safe.
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) continue;

    out.set(objNum, bytes);
  }

  return out;
}

// ── Decoded-pixel fallback ───────────────────────────────────────

/**
 * Expand 1-bit-per-pixel packed rows into one byte per pixel.
 *
 * @param inkWhereSet - true when a set bit means ink (stencil masks paint
 *   through their set bits), false when a set bit means paper.
 */
function unpack1Bpp(
  data: Uint8Array,
  width: number,
  height: number,
  inkWhereSet: boolean,
): Buffer {
  const rowBytes = (width + 7) >> 3;
  const out = Buffer.alloc(width * height);
  const set = inkWhereSet ? 0 : 255;
  const clear = inkWhereSet ? 255 : 0;
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const dst = y * width;
    for (let x = 0; x < width; x++) {
      out[dst + x] = (data[src + (x >> 3)] >> (7 - (x & 7))) & 1 ? set : clear;
    }
  }
  return out;
}

/** Re-encode decoded pdf.js image pixels as PNG. Loses original compression. */
async function encodeDecodedPixels(obj: DecodedImage, isMask = false): Promise<Buffer | null> {
  const { width, height, data } = obj;
  if (!data || !width || !height) return null;

  const pixels = width * height;
  let channels: 1 | 3 | 4;
  let raw: Buffer;

  if (data.length === pixels * 3) {
    channels = 3;
    raw = Buffer.from(data.buffer, data.byteOffset, data.length);
  } else if (data.length === pixels * 4) {
    channels = 4;
    raw = Buffer.from(data.buffer, data.byteOffset, data.length);
  } else if (data.length === pixels) {
    channels = 1;
    raw = Buffer.from(data.buffer, data.byteOffset, data.length);
  } else if (data.length === ((width + 7) >> 3) * height) {
    channels = 1;
    raw = unpack1Bpp(data, width, height, isMask);
  } else {
    return null; // Unrecognised layout — safer to skip than to guess.
  }

  const { default: sharp } = await import('sharp');
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

// ── Page walking ─────────────────────────────────────────────────

/** The shape pdf.js stores in `page.objs` for a decoded image. */
interface DecodedImage {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array;
  /**
   * The source PDF object, serialised by pdf.js as e.g. `"5R"`. This is the
   * only exact link back to the file's own object numbering — pdf.js object
   * ids (`img_p0_1`) are positional and carry no relation to it.
   */
  ref?: string;
}

/** How long to wait for pdf.js to decode one image before giving up on it. */
const OBJECT_RESOLVE_TIMEOUT_MS = 10_000;

/**
 * Bound a promise, resolving to `fallback` if it takes too long.
 *
 * Parsing and extraction sit outside the grading deadline, so without this a
 * file that makes pdf.js hang would hang the whole call — the per-page grading
 * timeouts never get a chance to run because they come afterwards.
 */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return work;
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    timer.unref?.();
    work.then(finish, () => finish(fallback));
  });
}

/**
 * Read a decoded image out of `page.objs`.
 *
 * The synchronous form throws "Requesting object that isn't resolved yet" for
 * anything pdf.js decodes asynchronously, which is every image that is not a
 * DCTDecode JPEG. Catching that throw silently dropped every Flate-compressed
 * image in every PDF — bitonal fax scans, PNG-style screenshots, 8-bit greyscale
 * scans — so those pages classified as `empty` and passed with a perfect score.
 * The callback form waits for the decode instead.
 */
function resolveObject(
  objs: { get(id: string, callback: (value: unknown) => void): void },
  objId: string,
): Promise<DecodedImage | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: DecodedImage | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), OBJECT_RESOLVE_TIMEOUT_MS);
    timer.unref?.();
    try {
      objs.get(objId, (value) => finish((value as DecodedImage) ?? null));
    } catch {
      finish(null);
    }
  });
}

type Matrix = [number, number, number, number, number, number];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/**
 * Classify PDF pages and pull out their embedded raster images.
 *
 * @param buffer - PDF file bytes
 * @param pages - 1-indexed page numbers, or `'all'`
 */
export async function analyzePdfContent(
  buffer: Buffer,
  pages: number[] | 'all',
  pageTimeoutMs = 0,
): Promise<PdfPageContent[]> {
  const pdfjs = await loadPdfjs();
  const jpegStreams = recoverJpegStreams(buffer);

  const loading = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    // Font data is irrelevant here — we only need text length and image placement.
    useSystemFonts: false,
  });
  const doc = await withDeadline(loading.promise, pageTimeoutMs, null);
  if (!doc) {
    await loading.destroy().catch(() => {});
    throw new Error('PDF parsing did not finish within the timeout');
  }

  try {
    const wanted =
      pages === 'all'
        ? Array.from({ length: doc.numPages }, (_, i) => i + 1)
        : pages.filter((p) => p >= 1 && p <= doc.numPages);

    const results: PdfPageContent[] = [];

    for (const pageNum of wanted) {
      // Per page, so one unreadable page cannot stall the rest of the document.
      const empty: PdfPageContent = {
        page: pageNum, kind: 'empty', textChars: 0, images: [],
        imageCoverage: 0, pageWidthPt: 0, pageHeightPt: 0,
      };
      results.push(
        await withDeadline(readPage(pdfjs, doc, pageNum, jpegStreams), pageTimeoutMs, empty),
      );
    }
    return results;
  } finally {
    await doc.destroy().catch(() => {});
  }
}

async function readPage(
  pdfjs: PdfjsModule,
  doc: Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>,
  pageNum: number,
  jpegStreams: Map<string, Buffer>,
): Promise<PdfPageContent> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const pageWidthPt = viewport.width;
  const pageHeightPt = viewport.height;
  const pageArea = pageWidthPt * pageHeightPt;

  let textChars = 0;
  try {
    const content = await page.getTextContent();
    for (const item of content.items) {
      const str = (item as { str?: string }).str;
      if (str) textChars += str.length;
    }
  } catch {
    // A page with no extractable text layer is a normal outcome, not an error.
  }

  const images: EmbeddedImage[] = [];

  try {
    const ops = await page.getOperatorList();
    const OPS = pdfjs.OPS;

    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] as unknown[];

      if (fn === OPS.save) {
        stack.push([...ctm] as Matrix);
        continue;
      }
      if (fn === OPS.restore) {
        ctm = stack.pop() ?? ctm;
        continue;
      }
      if (fn === OPS.transform) {
        ctm = multiply(ctm, args as unknown as Matrix);
        continue;
      }
      const isMask =
        fn === OPS.paintImageMaskXObject || fn === OPS.paintImageMaskXObjectRepeat;
      if (
        fn !== OPS.paintImageXObject &&
        fn !== OPS.paintImageXObjectRepeat &&
        fn !== OPS.paintInlineImageXObject &&
        !isMask
      ) {
        continue;
      }

      // A stencil mask paints the current fill colour through a 1-bit shape,
      // and its operator carries an object rather than a plain id. Scanners
      // that emit bitonal pages this way produced no images at all, so the page
      // read as empty and passed. Groups of masks are skipped: those are glyph
      // stencils from type rendering, not page content.
      const objId = isMask
        ? ((args[0] as { data?: string } | undefined)?.data ?? null)
        : typeof args[0] === 'string'
          ? (args[0] as string)
          : null;
      if (!objId) continue;

      // The CTM maps the unit square onto the placed image rectangle.
      const placedWidthPt = Math.hypot(ctm[0], ctm[1]);
      const placedHeightPt = Math.hypot(ctm[2], ctm[3]);
      if (placedWidthPt <= 0 || placedHeightPt <= 0) continue;

      const coverage = pageArea > 0 ? (placedWidthPt * placedHeightPt) / pageArea : 0;

      const obj = await resolveObject(page.objs, objId);
      if (!obj || !obj.width || !obj.height) continue;

      // Skip decoration before doing any encoding work.
      if (coverage < MIN_IMAGE_COVERAGE) continue;
      if (obj.width * obj.height < MIN_IMAGE_PIXELS) continue;

      const extracted = await extractImageBytes(obj, jpegStreams, isMask);
      if (!extracted) continue;

      images.push({
        objId,
        buffer: extracted.buffer,
        format: extracted.format,
        width: obj.width,
        height: obj.height,
        placedWidthPt,
        placedHeightPt,
        coverage,
        effectiveDpi: Math.round(obj.width / (placedWidthPt / 72)),
      });
    }
  } catch {
    // Operator list failed — treat the page as having no recoverable images.
  }

  page.cleanup();

  const imageCoverage = images.reduce((sum, img) => sum + img.coverage, 0);
  const dominant = images.reduce((max, img) => Math.max(max, img.coverage), 0);

  let kind: PdfPageKind;
  if (images.length === 0) {
    kind = textChars >= MIN_TEXT_CHARS ? 'digital-text' : 'empty';
  } else if (dominant >= SCANNED_COVERAGE) {
    // Note: an OCR'd scan carries both a text layer and a full-page image, so
    // coverage decides this, not the presence of text.
    kind = 'scanned';
  } else {
    kind = 'mixed';
  }

  return { page: pageNum, kind, textChars, images, imageCoverage, pageWidthPt, pageHeightPt };
}

async function extractImageBytes(
  obj: DecodedImage,
  jpegStreams: Map<string, Buffer>,
  isMask = false,
): Promise<{ buffer: Buffer; format: 'jpeg' | 'png' } | null> {
  if (!isMask) {
    // Prefer the original JPEG: it carries the file size, bits-per-pixel and
    // block structure that a re-encode destroys.
    const jpeg = findJpegStream(obj, jpegStreams);
    if (jpeg) return { buffer: jpeg, format: 'jpeg' };
  }

  const png = await encodeDecodedPixels(obj, isMask);
  return png ? { buffer: png, format: 'png' } : null;
}

/**
 * Find the original JPEG bytes for a decoded image.
 *
 * Resolution goes through the PDF object number carried in `ref`. Matching on
 * pixel dimensions instead is not safe: a page holding a good photo and a
 * wrecked one at the same size gave both of them the first stream found, so
 * the damaged image was graded as clean. Dimensions are now only a fallback,
 * and only when exactly one candidate has them.
 */
function findJpegStream(obj: DecodedImage, jpegStreams: Map<string, Buffer>): Buffer | null {
  if (jpegStreams.size === 0) return null;

  const refNum = /^(\d+)/.exec(obj.ref ?? '')?.[1];
  if (refNum) {
    const bytes = jpegStreams.get(refNum);
    // Confirm the stream really is this image before trusting it.
    if (bytes) {
      const dims = readJpegSize(bytes);
      if (dims && dims.width === obj.width && dims.height === obj.height) return bytes;
    }
    // A ref that resolves to nothing means our stream scan missed this object
    // (compressed object stream, indirect /Length, an unusual filter chain).
    // Guessing by size from here risks the very collision described above.
    return null;
  }

  const candidates: Buffer[] = [];
  for (const bytes of jpegStreams.values()) {
    const dims = readJpegSize(bytes);
    if (dims && dims.width === obj.width && dims.height === obj.height) candidates.push(bytes);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** Read width/height from a JPEG's SOF marker without decoding it. */
function readJpegSize(buf: Buffer): { width: number; height: number } | null {
  let offset = 2; // skip SOI
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // SOF0-SOF15, excluding DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}
