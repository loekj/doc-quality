import type { Issue } from './types.js';
import { ISSUE_GUIDANCE } from './guidance.js';

export interface OcrResult {
  medianConfidence: number;
  wordCount: number;
  lowConfidenceWords: number;
}

/**
 * Analyze OCR confidence using Tesseract.js.
 *
 * Dynamically imports tesseract.js (peer dependency). Creates a worker per
 * call unless an existing worker is passed for reuse.
 *
 * Returns null if fewer than 5 words are recognized (not enough text to judge)
 * or if median confidence is above threshold.
 */
export async function analyzeOcrConfidence(
  buffer: Buffer,
  threshold: number,
  language?: string,
  existingWorker?: unknown,
): Promise<Issue | null> {
  // Dynamic import — same pattern as pdf-to-png-converter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Tesseract: any;
  try {
    // String indirection prevents TS from resolving the module at compile time
    const moduleName = 'tesseract.js';
    Tesseract = await import(/* @vite-ignore */ moduleName);
  } catch {
    throw new Error(
      'tesseract.js is required for OCR confidence analysis. Install it: npm install tesseract.js',
    );
  }

  const lang = language ?? 'eng';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let worker: any;
  let ownWorker = false;

  if (existingWorker) {
    worker = existingWorker;
  } else {
    worker = await Tesseract.createWorker(lang);
    ownWorker = true;
  }

  try {
    const result = await worker.recognize(buffer);
    const words: Array<{ confidence: number }> = result.data.words ?? [];

    // Not enough text to judge
    if (words.length < 5) return null;

    // Collect per-word confidence (0-100)
    const confidences = words
      .map((w) => w.confidence)
      .sort((a, b) => a - b);

    const mid = confidences.length >>> 1;
    const median =
      confidences.length % 2 === 0
        ? (confidences[mid - 1] + confidences[mid]) / 2
        : confidences[mid];

    const lowConfidenceWords = confidences.filter((c) => c < threshold).length;

    if (median >= threshold) return null;

    return {
      analyzer: 'ocrConfidence',
      code: 'low-ocr-confidence',
      guidance: ISSUE_GUIDANCE['low-ocr-confidence'],
      message: `Low OCR confidence (median ${median.toFixed(0)}%, minimum ${threshold}%, ${lowConfidenceWords}/${words.length} words below threshold)`,
      value: median,
      threshold,
      penalty: 0.6,
    };
  } finally {
    if (ownWorker) {
      await worker.terminate();
    }
  }
}
