import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
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
