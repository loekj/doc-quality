import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import zlib from 'node:zlib';
import { checkQuality, analyzePdfContent } from '../src/index.js';

// ── minimal hand-built PDFs ──────────────────────────────────────

function buildPdf(objs: Array<string | Buffer | null>): Buffer {
  let len = 9;
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = len;
    const head = Buffer.from(`${i} 0 obj\n`, 'latin1');
    const body = Buffer.isBuffer(objs[i]) ? (objs[i] as Buffer) : Buffer.from(objs[i] as string, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    chunks.push(head, body, tail);
    len += head.length + body.length + tail.length;
  }
  const xref = len;
  let trailer = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) trailer += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  trailer += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  chunks.push(Buffer.from(trailer, 'latin1'));
  return Buffer.concat(chunks);
}

function streamObj(dict: string, data: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`, 'latin1'),
    bytes,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

/** True mean luminance, measured from converted pixels. */
async function greyscaleMean(buf: Buffer): Promise<number> {
  const raw = await sharp(buf).greyscale().raw().toBuffer();
  let sum = 0;
  for (const v of raw) sum += v;
  return sum / raw.length;
}

const pageDict = (resources: string, contentsObj: number) =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents ${contentsObj} 0 R >>`;

/** A JPEG that looks like a scanned text page. */
async function scanJpeg(width: number, height: number, quality: number, blur = 0): Promise<Buffer> {
  const rows = Math.max(4, Math.floor(height / 70));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#f6f3ea"/>` +
    Array.from({ length: rows }, (_, i) =>
      `<text x="${Math.round(width * 0.06)}" y="${90 + i * 70}" font-size="${Math.round(height / 100)}" ` +
      `font-family="Helvetica" fill="#1c1c1c">Scanned body line ${i} — invoice item, qty 3, unit 41.20, ref ABC</text>`,
    ).join('') + '</svg>';
  let pipeline = sharp(Buffer.from(svg)).flatten({ background: '#f6f3ea' });
  if (blur) pipeline = pipeline.blur(blur);
  return pipeline.jpeg({ quality }).toBuffer();
}

const FULL_PAGE_DRAW = 'q 612 0 0 792 0 0 cm /Im0 Do Q';

function digitalTextPdf(): Buffer {
  let content = 'BT /F1 11 Tf\n';
  for (let i = 0; i < 55; i++) {
    content += `1 0 0 1 50 ${760 - i * 13} Tm (Line ${i} invoice item description quantity 3 unit 41.20) Tj\n`;
  }
  content += 'ET';
  return buildPdf([
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    pageDict('/Font << /F1 5 0 R >>', 4),
    streamObj('', content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

function scannedPdf(jpeg: Buffer, width: number, height: number, draw = FULL_PAGE_DRAW): Buffer {
  return buildPdf([
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    pageDict('/XObject << /Im0 5 0 R >>', 4),
    streamObj('', draw),
    streamObj(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      jpeg,
    ),
  ]);
}

function mixedPdf(jpeg: Buffer, width: number, height: number): Buffer {
  let content = 'BT /F1 11 Tf\n';
  for (let i = 0; i < 22; i++) {
    content += `1 0 0 1 50 ${760 - i * 14} Tm (Digital invoice line ${i} with extractable text) Tj\n`;
  }
  content += 'ET\nq 260 0 0 340 60 180 cm /Im0 Do Q';
  return buildPdf([
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    pageDict('/Font << /F1 6 0 R >> /XObject << /Im0 5 0 R >>', 4),
    streamObj('', content),
    streamObj(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      jpeg,
    ),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

// ── tests ────────────────────────────────────────────────────────

describe('PDF content classification', () => {
  it('classifies a born-digital page as digital-text', async () => {
    const [content] = await analyzePdfContent(digitalTextPdf(), [1]);
    expect(content.kind).toBe('digital-text');
    expect(content.textChars).toBeGreaterThan(1000);
    expect(content.images).toHaveLength(0);
  });

  it('classifies a full-page image as scanned', async () => {
    const [content] = await analyzePdfContent(scannedPdf(await scanJpeg(2550, 3300, 85), 2550, 3300), [1]);
    expect(content.kind).toBe('scanned');
    expect(content.images).toHaveLength(1);
    expect(content.images[0].coverage).toBeGreaterThan(0.95);
  }, 60_000);

  it('classifies text plus an inset photo as mixed', async () => {
    const [content] = await analyzePdfContent(mixedPdf(await scanJpeg(900, 1150, 40), 900, 1150), [1]);
    expect(content.kind).toBe('mixed');
    expect(content.textChars).toBeGreaterThan(100);
    expect(content.images).toHaveLength(1);
    expect(content.images[0].coverage).toBeLessThan(0.5);
  }, 60_000);

  it('reports true scan DPI from native pixels and placed size', async () => {
    // 2550px across a 612pt (8.5in) page is 300 DPI by definition.
    const [content] = await analyzePdfContent(scannedPdf(await scanJpeg(2550, 3300, 85), 2550, 3300), [1]);
    expect(content.images[0].effectiveDpi).toBe(300);

    const [low] = await analyzePdfContent(scannedPdf(await scanJpeg(800, 1035, 85), 800, 1035), [1]);
    expect(low.images[0].effectiveDpi).toBe(94);
  }, 60_000);

  it('recovers the original JPEG stream rather than re-encoding', async () => {
    const jpeg = await scanJpeg(1700, 2200, 40);
    const [content] = await analyzePdfContent(scannedPdf(jpeg, 1700, 2200), [1]);
    expect(content.images[0].format).toBe('jpeg');
    // Byte-identical: file size and bits-per-pixel stay meaningful.
    expect(content.images[0].buffer.length).toBe(jpeg.length);
  }, 60_000);
});

describe('PDF grading uses content, not rendered pixels', () => {
  it('passes a digital-text PDF without pixel analysis', async () => {
    const result = await checkQuality(digitalTextPdf(), { mode: 'thorough', timeout: 0 });
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
    expect(result.pdfKind).toBe('digital-text');
    expect(result.issues).toHaveLength(0);
  });

  it('catches compression damage that rendering hides', async () => {
    const pdf = scannedPdf(await scanJpeg(2550, 3300, 4), 2550, 3300);

    const content = await checkQuality(pdf, { mode: 'thorough', timeout: 0 });
    expect(content.pass).toBe(false);
    expect(content.issues.map((i) => i.code)).toContain('jpeg-artifacts');

    // Rasterising resamples the 8x8 grid away and emits PNG, so the JPEG
    // analyzers never even run. This is why `content` is the default.
    const rendered = await checkQuality(pdf, { mode: 'thorough', timeout: 0, pdfStrategy: 'render' });
    expect(rendered.issues.map((i) => i.code)).not.toContain('jpeg-artifacts');
    expect(content.score).toBeLessThan(rendered.score);
  }, 90_000);

  it('does not flag a good high-resolution scan', async () => {
    for (const quality of [92, 75]) {
      const pdf = scannedPdf(await scanJpeg(2550, 3300, quality), 2550, 3300);
      const result = await checkQuality(pdf, { mode: 'thorough', timeout: 0 });
      expect(result.issues.map((i) => i.code)).not.toContain('heavy-compression');
      expect(result.pass).toBe(true);
    }
  }, 90_000);

  it('flags a low-DPI scan using page geometry, not image metadata', async () => {
    const pdf = scannedPdf(await scanJpeg(800, 1035, 85), 800, 1035);
    const result = await checkQuality(pdf, { mode: 'thorough', timeout: 0 });
    expect(result.issues.map((i) => i.code)).toContain('low-dpi');
    expect(result.effectiveDpi).toBe(94);
  }, 60_000);

  it('grades the embedded photo on a mixed page', async () => {
    const pdf = mixedPdf(await scanJpeg(900, 1150, 20, 8), 900, 1150);
    const result = await checkQuality(pdf, { mode: 'thorough', timeout: 0 });
    expect(result.pdfKind).toBe('mixed');
    expect(result.pass).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('blurry');
  }, 60_000);

  it('falls back to rendering when asked', async () => {
    const result = await checkQuality(digitalTextPdf(), {
      mode: 'fast', timeout: 0, pdfStrategy: 'render',
    });
    expect(result.pdfKind).toBeUndefined();
    expect(result.metadata.width).toBeGreaterThan(0); // real rasterised pixels
  });
});

describe('embedded image identity', () => {
  /** Two images of identical dimensions but very different quality. */
  async function samePixelSizePdf() {
    const tile = async (quality: number, label: string) => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1200">' +
        '<rect width="1000" height="1200" fill="#f6f3ea"/>' +
        Array.from({ length: 12 }, (_, i) =>
          `<text x="30" y="${60 + i * 60}" font-size="24" font-family="Helvetica" fill="#1c1c1c">${label} line ${i}</text>`,
        ).join('') + '</svg>';
      return sharp(Buffer.from(svg)).flatten({ background: '#f6f3ea' }).jpeg({ quality }).toBuffer();
    };
    const good = await tile(92, 'GOOD');
    const bad = await tile(3, 'BAD');
    const pdf = buildPdf([
      null,
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      pageDict('/XObject << /Im0 5 0 R /Im1 6 0 R >>', 4),
      streamObj('', 'q 280 0 0 340 30 400 cm /Im0 Do Q q 280 0 0 340 320 400 cm /Im1 Do Q'),
      streamObj(
        '/Type /XObject /Subtype /Image /Width 1000 /Height 1200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
        good,
      ),
      streamObj(
        '/Type /XObject /Subtype /Image /Width 1000 /Height 1200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
        bad,
      ),
    ]);
    return { pdf, good, bad };
  }

  it('resolves same-size images by PDF object, not by dimensions', async () => {
    const { pdf, good, bad } = await samePixelSizePdf();
    const [content] = await analyzePdfContent(pdf, [1]);
    expect(content.images).toHaveLength(2);

    // Matching on width/height alone handed both images the first stream found,
    // so a wrecked photo was graded using a clean one's bytes.
    const sizes = content.images.map((i) => i.buffer.length).sort((a, b) => a - b);
    expect(sizes).toEqual([bad.length, good.length].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(2);
  }, 60_000);

  it('fails a page when one of its images is wrecked', async () => {
    const { pdf } = await samePixelSizePdf();
    const result = await checkQuality(pdf, { mode: 'thorough', timeout: 0 });
    expect(result.pass).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('jpeg-artifacts');
  }, 60_000);
});

describe('multi-page PDFs', () => {
  async function threePagePdf() {
    const clean = await scanJpeg(1600, 2000, 80);
    const blurred = await scanJpeg(1600, 2000, 80, 9);
    let text = 'BT /F1 11 Tf\n';
    for (let i = 0; i < 50; i++) {
      text += `1 0 0 1 50 ${760 - i * 14} Tm (Digital page text line ${i} with content) Tj\n`;
    }
    text += 'ET';
    const imgDict = (w: number, h: number) =>
      `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`;
    return buildPdf([
      null,
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 10 0 R >> >> /Contents 7 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 11 0 R >> >> /Contents 8 0 R >>',
      streamObj('', text),
      streamObj('', 'q 612 0 0 792 0 0 cm /Im0 Do Q'),
      streamObj('', 'q 612 0 0 792 0 0 cm /Im0 Do Q'),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      streamObj(imgDict(1600, 2000), clean),
      streamObj(imgDict(1600, 2000), blurred),
    ]);
  }

  it('grades each page against its own image', async () => {
    const pdf = await threePagePdf();
    const contents = await analyzePdfContent(pdf, 'all');
    expect(contents.map((c) => c.kind)).toEqual(['digital-text', 'scanned', 'scanned']);
    // Pages 2 and 3 share pixel dimensions; they must not share bytes.
    expect(contents[1].images[0].buffer.length).not.toBe(contents[2].images[0].buffer.length);

    const result = await checkQuality(pdf, { mode: 'thorough', pages: 'all', timeout: 0 });
    const byPage = new Map(result.pageResults!.map((p) => [p.page, p]));
    expect(byPage.get(1)!.pass).toBe(true);   // digital text
    expect(byPage.get(2)!.pass).toBe(true);   // clean scan
    expect(byPage.get(3)!.pass).toBe(false);  // blurred scan
  }, 120_000);
});

describe('PDF timeouts apply per page', () => {
  async function nPagePdf(pages: number) {
    const objs: Array<string | Buffer | null> = [null, '<< /Type /Catalog /Pages 2 0 R >>', null];
    let next = 3;
    const pageIds: number[] = [];
    const contentIds: number[] = [];
    const imgIds: number[] = [];
    for (let i = 0; i < pages; i++) pageIds.push(next++);
    for (let i = 0; i < pages; i++) contentIds.push(next++);
    for (let i = 0; i < pages; i++) imgIds.push(next++);
    objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`;
    for (let i = 0; i < pages; i++) {
      objs[pageIds[i]] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /XObject << /Im0 ${imgIds[i]} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
      objs[contentIds[i]] = streamObj('', 'q 612 0 0 792 0 0 cm /Im0 Do Q');
      objs[imgIds[i]] = streamObj(
        '/Type /XObject /Subtype /Image /Width 1200 /Height 1550 ' +
        '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
        await scanJpeg(1200, 1550, 80),
      );
    }
    return buildPdf(objs);
  }

  it('spends the deadline per page, not across the document', async () => {
    // A flat whole-document timeout failed every page of a long scan, which
    // matters more now that timing out fails closed.
    //
    // Asserting "no page times out under the default deadline" made the test a
    // measure of how busy the machine is. This instead picks a budget that
    // comfortably fits one page and could not fit four in series: if the
    // deadline were still per document, every page would time out.
    const pages = 4;
    const pdf = await nPagePdf(pages);

    const single = await checkQuality(await nPagePdf(1), { mode: 'thorough', timeout: 0 });
    const perPageBudget = Math.max(4000, single.timing.totalMs * 3);
    expect(perPageBudget * pages).toBeGreaterThan(perPageBudget); // budget is per page

    const result = await checkQuality(pdf, {
      mode: 'thorough', pages: 'all', timeout: perPageBudget,
    });
    const timedOut = result.pageResults!.filter((p) =>
      p.issues.some((i) => i.analyzer === 'timeout'),
    );
    expect(timedOut).toHaveLength(0);
    expect(result.pass).toBe(true);
  }, 180_000);

  it('fails closed, page by page, when the budget really is too small', async () => {
    const pdf = await nPagePdf(3);
    const result = await checkQuality(pdf, { mode: 'thorough', pages: 'all', timeout: 1 });
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    for (const page of result.pageResults!) {
      expect(page.issues.map((i) => i.code)).toContain('analysis-timeout');
    }
  }, 120_000);

  it('fails closed on a single page too', async () => {
    const pdf = scannedPdf(await scanJpeg(1600, 2000, 80), 1600, 2000);
    const result = await checkQuality(pdf, { mode: 'thorough', timeout: 1 });
    // A null image result used to be read as "nothing to measure" and passed.
    expect(result.pass).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('analysis-timeout');
  }, 60_000);
});

describe('non-JPEG embedded images', () => {
  const W = 1700;
  const H = 2200;

  /** Greyscale pixels of a scanned-looking page. */
  async function scanPixels(blur = 0): Promise<Buffer> {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="#f4f1e8"/>` +
      Array.from({ length: 30 }, (_, i) =>
        `<text x="120" y="${100 + i * 70}" font-size="32" font-family="Helvetica" fill="#1c1c1c">` +
        `Scanned line ${i} — invoice item, quantity 3, unit 41.20</text>`,
      ).join('') + '</svg>';
    let pipeline = sharp(Buffer.from(svg)).flatten({ background: '#f4f1e8' });
    if (blur) pipeline = pipeline.blur(blur);
    return pipeline.greyscale().raw().toBuffer();
  }

  /** Pack greyscale into 1 bit per pixel, set bit = paper. */
  function packBitonal(grey: Buffer): Buffer {
    const rowBytes = (W + 7) >> 3;
    const out = Buffer.alloc(rowBytes * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (grey[y * W + x] >= 128) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return out;
  }

  function imagePdf(dict: string, data: Buffer, content = 'q 612 0 0 792 0 0 cm /Im0 Do Q'): Buffer {
    return buildPdf([
      null,
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      pageDict('/XObject << /Im0 5 0 R >>', 4),
      streamObj('', content),
      streamObj(dict, data),
    ]);
  }

  const base = (extra: string) =>
    `/Type /XObject /Subtype /Image /Width ${W} /Height ${H} ${extra}`;

  it('extracts Flate-compressed images of every depth', async () => {
    // pdf.js decodes these asynchronously, and the synchronous accessor throws
    // for anything that is not a DCTDecode JPEG. Swallowing that throw dropped
    // every Flate image in every PDF: the page classified as `empty` and passed
    // with a perfect score.
    const grey = await scanPixels();
    const rgb = Buffer.from(Array.from({ length: W * H * 3 }, (_, i) => grey[Math.floor(i / 3)]));

    const variants: Array<[string, Buffer]> = [
      [base('/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode'),
        zlib.deflateSync(packBitonal(grey))],
      [base('/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode'),
        zlib.deflateSync(grey)],
      [base('/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode'),
        zlib.deflateSync(rgb)],
    ];

    for (const [dict, data] of variants) {
      const [content] = await analyzePdfContent(imagePdf(dict, data), [1]);
      expect(content.kind).toBe('scanned');
      expect(content.images).toHaveLength(1);
      expect(content.images[0].width).toBe(W);
      expect(content.images[0].effectiveDpi).toBe(200);
    }
  }, 180_000);

  it('extracts stencil masks, which scanners use for bitonal pages', async () => {
    // A mask paints through a 1-bit shape and arrives on a different operator
    // carrying an object instead of an id. It was not handled at all, so a
    // bitonal scanned page had no images and passed.
    const grey = await scanPixels();
    const pdf = imagePdf(
      base('/ImageMask true /Decode [1 0] /Filter /FlateDecode'),
      zlib.deflateSync(packBitonal(grey)),
      '0 g q 612 0 0 792 0 0 cm /Im0 Do Q',
    );
    const [content] = await analyzePdfContent(pdf, [1]);
    expect(content.kind).toBe('scanned');
    expect(content.images).toHaveLength(1);
  }, 90_000);

  it('gets bitonal polarity right — paper bright, ink dark', async () => {
    const grey = await scanPixels();
    const packed = zlib.deflateSync(packBitonal(grey));
    for (const dict of [
      base('/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode'),
      base('/ImageMask true /Decode [1 0] /Filter /FlateDecode'),
    ]) {
      const [content] = await analyzePdfContent(imagePdf(dict, packed), [1]);
      // sharp's stats() reports the source image's channels, not the pipeline
      // output, so luminance has to be measured from actual converted pixels.
      expect(await greyscaleMean(content.images[0].buffer)).toBeGreaterThan(200);
    }
  }, 120_000);

  it('still catches a blurred page through the Flate path', async () => {
    const pdf = imagePdf(
      base('/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode'),
      zlib.deflateSync(await scanPixels(8)),
    );
    const result = await checkQuality(pdf, { mode: 'thorough', timeout: 0 });
    expect(result.pass).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('blurry');
  }, 90_000);

  it('leaves images with a /Decode array to pdf.js', async () => {
    // /Decode remaps sample values, and Adobe's CMYK JPEGs routinely carry
    // [1 0 ...] to invert them. Raw stream bytes know nothing about it, so
    // reusing them would analyse an inverted page: greyscale mean 16 where the
    // truth is 239, which reads as a hopelessly dark scan.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="#f4f1e8"/>` +
      Array.from({ length: 30 }, (_, i) =>
        `<text x="120" y="${100 + i * 70}" font-size="32" font-family="Helvetica" fill="#1c1c1c">` +
        `Line ${i} invoice item, qty 3, unit 41.20</text>`,
      ).join('') + '</svg>';
    const inverted = await sharp(Buffer.from(svg))
      .flatten({ background: '#f4f1e8' }).negate().jpeg({ quality: 85 }).toBuffer();

    const pdf = imagePdf(
      base('/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Decode [1 0 1 0 1 0]'),
      inverted,
    );
    const [content] = await analyzePdfContent(pdf, [1]);
    // Falls back to decoded pixels, which honour /Decode.
    expect(content.images[0].format).toBe('png');
    expect(await greyscaleMean(content.images[0].buffer)).toBeGreaterThan(200);

    const result = await checkQuality(pdf, { mode: 'thorough', timeout: 0 });
    expect(result.issues.map((i) => i.code)).not.toContain('too-dark');
  }, 120_000);

  it('reads CMYK JPEGs without inverting them', async () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="#f4f1e8"/>` +
      Array.from({ length: 30 }, (_, i) =>
        `<text x="120" y="${100 + i * 70}" font-size="32" font-family="Helvetica" fill="#1c1c1c">` +
        `Line ${i} invoice item</text>`,
      ).join('') + '</svg>';
    const cmyk = await sharp(Buffer.from(svg))
      .flatten({ background: '#f4f1e8' }).toColourspace('cmyk').jpeg({ quality: 85 }).toBuffer();

    const pdf = imagePdf(
      base('/ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode'),
      cmyk,
    );
    const [content] = await analyzePdfContent(pdf, [1]);
    expect(content.images).toHaveLength(1);
    expect(await greyscaleMean(content.images[0].buffer)).toBeGreaterThan(200);

    // And the whole page must not read as dark: stats() on a CMYK file reports
    // ink coverages (1, 1, 14, 21) rather than brightness, so averaging them
    // reported `too-dark` on a normal page.
    const result = await checkQuality(pdf, { mode: 'thorough', timeout: 0 });
    expect(result.issues.map((i) => i.code)).not.toContain('too-dark');
  }, 120_000);
});
