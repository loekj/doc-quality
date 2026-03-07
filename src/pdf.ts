/**
 * PDF support — page parsing and rendering.
 *
 * Requires `pdf-to-png-converter` as an optional peer dependency.
 * If not installed, PDF analysis throws a clear error.
 */

/** PDF magic bytes: %PDF */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]);

/** Check if a buffer is a PDF by magic bytes */
export function isPdf(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(PDF_MAGIC);
}

/**
 * Parse a page selector string into an array of 1-indexed page numbers.
 *
 * @param input - Page selector: `'1'`, `'1-5'`, `'1,4,8-12'`, `'all'`
 * @returns Sorted, deduplicated array of page numbers, or `'all'`
 *
 * @example
 * ```ts
 * parsePages('1')         // [1]
 * parsePages('1-5')       // [1, 2, 3, 4, 5]
 * parsePages('1,4,8-12')  // [1, 4, 8, 9, 10, 11, 12]
 * parsePages('all')       // 'all'
 * ```
 */
export function parsePages(input: string): number[] | 'all' {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'all') return 'all';
  if (!trimmed) throw new Error('Empty page selector');

  const pages = new Set<number>();

  for (const part of trimmed.split(',')) {
    const segment = part.trim();
    if (!segment) continue;

    if (segment.includes('-')) {
      const [startStr, endStr] = segment.split('-', 2);
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw new Error(`Invalid page range: "${segment}"`);
      }
      for (let i = start; i <= end; i++) pages.add(i);
    } else {
      if (!/^\d+$/.test(segment)) {
        throw new Error(`Invalid page number: "${segment}"`);
      }
      const page = parseInt(segment, 10);
      if (page < 1) {
        throw new Error(`Invalid page number: "${segment}"`);
      }
      pages.add(page);
    }
  }

  if (pages.size === 0) throw new Error(`No valid pages in: "${input}"`);
  return [...pages].sort((a, b) => a - b);
}

/** Rendered page from PDF */
export interface RenderedPage {
  /** 1-indexed page number */
  page: number;
  /** PNG image buffer */
  buffer: Buffer;
}

/**
 * Render specific PDF pages to PNG buffers.
 *
 * @param buffer - PDF file buffer
 * @param pages - Page numbers to render, or 'all'
 * @returns Array of rendered pages with their page numbers
 * @throws If pdf-to-png-converter is not installed
 */
export async function renderPdfPages(
  buffer: Buffer,
  pages: number[] | 'all',
): Promise<RenderedPage[]> {
  // Dynamic import — only fails if user actually tries to analyze a PDF
  let pdfToPng: typeof import('pdf-to-png-converter').pdfToPng;
  try {
    const mod = await import('pdf-to-png-converter');
    pdfToPng = mod.pdfToPng;
  } catch {
    throw new Error(
      'PDF support requires "pdf-to-png-converter". Install it:\n  npm install pdf-to-png-converter',
    );
  }

  // pdfToPng expects ArrayBuffer
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );

  const opts: { viewportScale: number; pagesToProcess?: number[] } = {
    viewportScale: 2,
  };
  if (pages !== 'all') {
    opts.pagesToProcess = pages;
  }

  const rendered = await pdfToPng(arrayBuffer, opts);

  const results: RenderedPage[] = [];
  for (let i = 0; i < rendered.length; i++) {
    const p = rendered[i];
    if (p.content) {
      results.push({
        page: pages === 'all' ? i + 1 : pages[i],
        buffer: p.content,
      });
    }
  }

  return results;
}
