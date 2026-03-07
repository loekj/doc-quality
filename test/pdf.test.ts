import { describe, it, expect } from 'vitest';
import { parsePages, isPdf } from '../src/pdf.js';
import { checkQuality } from '../src/index.js';
import sharp from 'sharp';

// ── isPdf ────────────────────────────────────────────────────────

describe('isPdf', () => {
  it('detects PDF from magic bytes', () => {
    const pdfHeader = Buffer.from('%PDF-1.4 fake content');
    expect(isPdf(pdfHeader)).toBe(true);
  });

  it('rejects non-PDF buffers', async () => {
    const png = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 200, b: 200 } },
    }).png().toBuffer();
    expect(isPdf(png)).toBe(false);
  });

  it('rejects empty buffer', () => {
    expect(isPdf(Buffer.alloc(0))).toBe(false);
  });

  it('rejects short buffer', () => {
    expect(isPdf(Buffer.from('abc'))).toBe(false);
  });
});

// ── parsePages ───────────────────────────────────────────────────

describe('parsePages', () => {
  it('parses single page', () => {
    expect(parsePages('1')).toEqual([1]);
    expect(parsePages('5')).toEqual([5]);
  });

  it('parses page range', () => {
    expect(parsePages('1-5')).toEqual([1, 2, 3, 4, 5]);
    expect(parsePages('3-3')).toEqual([3]);
  });

  it('parses comma-separated pages', () => {
    expect(parsePages('1,3,5')).toEqual([1, 3, 5]);
  });

  it('parses mixed ranges and singles', () => {
    expect(parsePages('1,4,8-12')).toEqual([1, 4, 8, 9, 10, 11, 12]);
  });

  it('deduplicates overlapping ranges', () => {
    expect(parsePages('1-5,3-7')).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('handles "all"', () => {
    expect(parsePages('all')).toBe('all');
    expect(parsePages('ALL')).toBe('all');
    expect(parsePages('  All  ')).toBe('all');
  });

  it('handles whitespace', () => {
    expect(parsePages(' 1 , 3 , 5 ')).toEqual([1, 3, 5]);
    expect(parsePages(' 1 - 3 ')).toEqual([1, 2, 3]);
  });

  it('sorts output', () => {
    expect(parsePages('5,1,3')).toEqual([1, 3, 5]);
  });

  it('throws on invalid input', () => {
    expect(() => parsePages('')).toThrow();
    expect(() => parsePages('   ')).toThrow();
    expect(() => parsePages('0')).toThrow();
    expect(() => parsePages('-1')).toThrow();
    expect(() => parsePages('abc')).toThrow();
    expect(() => parsePages('5-3')).toThrow(); // reversed range
    expect(() => parsePages('1.5')).toThrow();
  });
});

// ── checkQuality with images (not PDFs) ──────────────────────────

describe('checkQuality — pages option ignored for images', () => {
  it('ignores pages option for image buffers', async () => {
    const buffer = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 200, b: 200 } },
    }).png().toBuffer();

    // Should not throw even with pages option
    const result = await checkQuality(buffer, { pages: '1-5' });
    expect(result).toHaveProperty('pass');
    expect(result.pageResults).toBeUndefined();
  });
});

// ── checkQuality with PDFs ───────────────────────────────────────
// Note: These tests require pdf-to-png-converter to be installed.
// We test with a minimal PDF that has a single colored page.

describe('checkQuality — PDF concurrency and progress', () => {
  /** Create a minimal valid PDF with a single page containing a colored rectangle */
  function makePdf(): Buffer {
    const pdf = `%PDF-1.0
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]
   /Contents 4 0 R /Resources << >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
0.8 0.8 0.8 rg
0 0 612 792 re f
endstream
endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000236 00000 n
trailer
<< /Size 5 /Root 1 0 R >>
startxref
330
%%EOF`;
    return Buffer.from(pdf);
  }

  it('maxConcurrency: 1 still produces correct results', async () => {
    const pdf = makePdf();
    const result = await checkQuality(pdf, { maxConcurrency: 1 });
    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('score');
  });

  it('onPage callback fires for single-page PDF', async () => {
    const pdf = makePdf();
    const pages: number[] = [];
    await checkQuality(pdf, {
      onPage: (page, total) => {
        pages.push(page);
        expect(total).toBe(1);
      },
    });
    expect(pages).toEqual([1]);
  });
});

describe('checkQuality — PDF support', () => {
  /** Create a minimal valid PDF with a colored page */
  function makeMinimalPdf(): Buffer {
    // Minimal valid PDF with a single page containing a colored rectangle
    const pdf = `%PDF-1.0
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]
   /Contents 4 0 R /Resources << >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
0.8 0.8 0.8 rg
0 0 612 792 re f
endstream
endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000236 00000 n
trailer
<< /Size 5 /Root 1 0 R >>
startxref
330
%%EOF`;
    return Buffer.from(pdf);
  }

  it('auto-detects PDF and analyzes first page', async () => {
    const pdf = makeMinimalPdf();
    const result = await checkQuality(pdf);

    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('score');
    expect(result.metadata.fileSize).toBe(pdf.length);
    // Single page — no pageResults
    expect(result.pageResults).toBeUndefined();
  });

  it('tags issues with page number', async () => {
    const pdf = makeMinimalPdf();
    const result = await checkQuality(pdf);

    for (const issue of result.issues) {
      expect(issue.page).toBe(1);
    }
  });

  it('handles pages option for single-page PDF', async () => {
    const pdf = makeMinimalPdf();
    // Page 1 is the only page — should work fine
    const result = await checkQuality(pdf, { pages: '1' });
    expect(result).toHaveProperty('pass');
  });
});
