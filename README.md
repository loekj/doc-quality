# doc-quality

**The** most comprehensive -- arguably over-engineered -- document image quality checker for pre-OCR and AI extraction pipelines. 23 analyzers, 30 issue codes, FFT spectral analysis, zone-based uniformity checks, boundary detection, and a 3KB browser preflight. All so your users never upload a blurry receipt photo that burns $0.15 and 45 seconds on Textract just to return `"confidence": 0.12`.

Stop feeding garbage to expensive AI. Catch it first.

---

**The problem:** Managed OCR and document AI services (AWS Textract, Google Document AI, Azure Form Recognizer) charge per page and take 30-60s per call. A dark photo, a blank page, a motion-blurred scan -- they all cost the same as a perfect one, except you get nothing back. Multiply by thousands of uploads and you're lighting money on fire.

**The fix:** `doc-quality` catches bad images in milliseconds -- in the browser before upload, or on the server before the expensive pipeline -- and gives users actionable guidance to retake the photo. Every rejection saves a round-trip, a service call, and a frustrated user staring at "processing..." for a minute.

Two entry points: a **browser preflight** (~3KB, zero deps, <10ms) for instant upload validation, and a **full backend** (sharp-based, 23 analyzers, FFT frequency-domain analysis) for thorough server-side quality gating. If preflight rejects an image, the backend is guaranteed to reject it too.

```
npm install doc-quality sharp
```

## Quick Start

```typescript
import { checkQuality } from 'doc-quality';

const result = await checkQuality(buffer);
if (!result.pass) {
  console.log(result.issues[0].guidance);
  // "The image is blurry. Hold the camera steady and ensure the document is in focus."
}
```

## Preflight + Backend (Recommended)

The ideal flow: reject bad images in the browser *before* upload, then validate on the server *before* calling your OCR/AI service. Each layer saves money and time by filtering earlier.

```typescript
// ── Browser (instant, free) ──────────────────────────────────────
import { preflight } from 'doc-quality/preflight';

const file = fileInput.files[0];
const result = await preflight(file);

if (!result.pass) {
  // Ask the user to retake — don't waste their upload bandwidth
  showError(result.issues[0].guidance);
  // e.g. "The image is too dark. Please retake in better lighting."
  return;
}

await uploadToServer(file);

// ── Server (before OCR/AI) ───────────────────────────────────────
import { checkQuality } from 'doc-quality';

const result = await checkQuality(buffer);
if (!result.pass) {
  // Don't send to Textract/Document AI — it'll fail or return garbage.
  // Return actionable guidance so the frontend can prompt a retake.
  return res.status(422).json({ issues: result.issues });
}

// Image is good — now it's worth spending the 30-60s + $$ on OCR
const ocrResult = await callTextract(buffer);
```

### Monotonic Guarantee

If `preflight(x)` rejects, `checkQuality(x)` **always** rejects. The reverse is not true — preflight is slightly more lenient to account for Canvas vs sharp measurement differences. This means preflight never gives false confidence: if it says the image is bad, it *is* bad.

### When to Use Which

| | Preflight | Full Backend |
|---|---|---|
| **Environment** | Browser (Canvas API) | Node.js (sharp) |
| **Speed** | <10ms on mobile | 50-200ms |
| **Bundle size** | ~3KB gzipped | N/A (server) |
| **Checks** | 8 core checks | 23 analyzers |
| **Dependencies** | None | sharp (+ optional pdf, ocr) |
| **Use case** | Reject clearly bad uploads instantly | Thorough server-side validation |

## Full Backend API

### `checkQuality(input, options?)`

Analyzes an image or PDF. Auto-detects format from magic bytes.

```typescript
import { checkQuality } from 'doc-quality';

// Buffer, Uint8Array, file path, file:// URL, or web URL
const result = await checkQuality(buffer);
const result = await checkQuality('/path/to/image.jpg');
const result = await checkQuality(new URL('file:///path/to/image.png'));
const result = await checkQuality('https://my-bucket.s3.amazonaws.com/scan.jpg');
const result = await checkQuality(new URL('https://cdn.example.com/doc.png'));

console.log(result.pass);     // true/false
console.log(result.score);    // 0-1
console.log(result.preset);   // 'document' | 'receipt' | 'card'
console.log(result.issues);   // Issue[]
console.log(result.metadata); // { width, height, megapixels, fileSize, format? }
console.log(result.timing);   // { totalMs, analyzers: { brightness: 2, sharpness: 5, ... } }
```

### Options

```typescript
const result = await checkQuality(buffer, {
  mode: 'thorough',           // 'fast' (default) or 'thorough' (enables FFT + zone analysis)
  preset: 'receipt',           // 'auto' (default), 'document', 'receipt', 'card'
  timeout: 5000,               // ms, default 10000. Set to 0 to disable.
  thresholds: {                // Override any threshold (merged on top of preset)
    brightnessMin: 60,
    sharpnessMin: 20,
  },
  penalties: {                 // Override score penalty per analyzer (0-1 multiplier)
    brightness: 0.8,           // Less harsh penalty for brightness issues
  },
  detectBounds: true,          // Built-in document boundary detection (default: true)
  boundaryDetector: myFn,      // Custom boundary detector (replaces built-in)
});
```

### `createChecker(defaults?)`

Create a reusable checker with fixed options:

```typescript
import { createChecker } from 'doc-quality';

const checker = createChecker({
  preset: 'card',
  mode: 'thorough',
  thresholds: { sharpnessMin: 20 },
});

const r1 = await checker.check(buffer1);
const r2 = await checker.check(buffer2);
const r3 = await checker.check(buffer3, { preset: 'document' }); // Override per call
```

## Preflight API

Browser-side quality gate. Zero dependencies, uses Canvas API.

```typescript
import { preflight } from 'doc-quality/preflight';

// Accepts Blob, File, ImageBitmap, or loaded HTMLImageElement
const result = await preflight(file);
const result = await preflight(imgElement);
const result = await preflight(blob, {
  thumbnailSize: 300,          // Analysis resolution (default: 200). Larger = slower but more accurate.
  thresholds: {                // Override any preflight threshold
    brightnessMin: 40,
  },
});
```

Preflight runs 8 checks: resolution, file size, brightness (dark/overexposed), blank page, sharpness, edge density, and contrast. Each failed check includes a `guidance` string suitable for showing to users.

### Preflight Thresholds vs Backend Thresholds

Preflight thresholds are slightly more lenient than the backend defaults. Most use 7-20% margins. Sharpness and edge density use wider margins because the 200px analysis thumbnail produces lower Laplacian values than the backend's 1500px analysis.

| Check | Preflight | Backend | Margin |
|---|---|---|---|
| Resolution min (MP) | 0.28 | 0.3 | 7% |
| Resolution max (MP) | 220 | 200 | 10% |
| File size min (bytes) | 13500 | 15000 | 10% |
| File size max (bytes) | 110 MB | 100 MB | 10% |
| Brightness min | 45 | 50 | 10% |
| Brightness max | 247 | 245 | 2pt |
| Blank page stdev | 1.7 | 2.0 | 15% |
| Contrast min | 0.008 | 0.01 | 20% |
| Sharpness min | 5 | 15 | wider |
| Edge density min | 0.005 | 0.015 | wider |

## Upload Gate

All thresholds are configurable — use `doc-quality` as a single-package upload validator for both quality *and* size/dimension limits:

```typescript
const result = await checkQuality(buffer, {
  thresholds: {
    fileSizeMax: 10_000_000,  // Reject > 10 MB
    resolutionMax: 25,         // Reject > 25 MP
    resolutionMin: 0.1,        // Reject < 316×316
  },
});
// result.issues[0].guidance → "The file is too large. Please reduce the file size..."
```

Works in preflight too — one package, browser + server, quality + limits.

## Limits — File Size, Dimensions, and Auto-Resize

### Maximum Limits (rejection)

Images or files exceeding these thresholds are **rejected** with an actionable issue:

| Limit | Default | Issue Code | What to Do |
|---|---|---|---|
| **File size** | 100 MB (`fileSizeMax`) | `file-too-large` | Compress the image or reduce quality before uploading |
| **Resolution** | 200 MP (`resolutionMax`) | `resolution-too-high` | Resize/downsample the image before uploading |

These are configurable — override them in `thresholds`:

```typescript
const result = await checkQuality(buffer, {
  thresholds: {
    fileSizeMax: 50_000_000,   // 50 MB
    resolutionMax: 100,         // 100 MP
  },
});
```

### Minimum Limits (rejection)

Images below these thresholds are rejected — they're too small to produce useful OCR/AI results:

| Limit | Default | Preset: receipt | Preset: card |
|---|---|---|---|
| **Resolution** | 0.3 MP (~548x548) | 0.5 MP | 0.3 MP |
| **File size** | 15 KB | 50 KB | 30 KB |

### Auto-Resize for Analysis (no rejection)

Images of **any** dimension are automatically resized to a maximum of **1500px** (longest edge) for analysis. This is not a rejection — it's an internal optimization:

- A 50 MP (8000x6000) photo is downscaled to 1500x1125 before running analyzers
- Analysis time stays constant (~50-200ms) regardless of input size
- Original dimensions are preserved in `result.metadata.width/height`
- Original file size is preserved in `result.metadata.fileSize`

The resize cap is configurable via `analysisMaxPx`:

```typescript
const result = await checkQuality(buffer, {
  thresholds: {
    analysisMaxPx: 2000,  // Higher accuracy, slower analysis
  },
});
```

### Practical Platform Limits

Beyond the configurable thresholds, these hard limits apply:

| Constraint | Limit | Notes |
|---|---|---|
| **sharp/libvips memory** | ~256 MP (~16000x16000) | sharp throws `VipsError` above this — set `resolutionMax` lower to reject gracefully |
| **Node.js Buffer** | ~2 GB | Maximum file size loadable into memory |
| **Browser preflight** | Browser memory limit | Canvas/ImageBitmap allocation; analysis thumbnail capped at 200px |

### Preflight Limits

The browser preflight uses slightly more lenient max limits (10% higher) to maintain the monotonic guarantee:

| Limit | Preflight | Backend |
|---|---|---|
| File size max | 110 MB | 100 MB |
| Resolution max | 220 MP | 200 MP |

## Presets

Presets adjust thresholds for different document types. Use `preset: 'auto'` (default) to infer from aspect ratio and dimensions.

```typescript
// Auto-detection logic:
// - Narrow/tall images (aspect < 0.4 or > 2.5) -> 'receipt'
// - Credit-card-shaped + small (< 2 MP)        -> 'card'
// - Everything else                             -> 'document'

const result = await checkQuality(buffer, { preset: 'auto' });
```

| Preset | Use Case | Stricter On |
|---|---|---|
| `document` | Tax forms, contracts, letters | Default thresholds |
| `receipt` | Thermal paper, register receipts | Brightness, sharpness, resolution |
| `card` | ID cards, credit cards, passports | Edge density, contrast, sharpness uniformity |

## Thresholds

Every threshold is configurable. Pass `thresholds` to override any value -- it merges on top of the preset.

```typescript
import { DEFAULT_THRESHOLDS, resolveThresholds } from 'doc-quality';

// See all defaults
console.log(DEFAULT_THRESHOLDS);

// Resolve thresholds for a preset with overrides
const t = resolveThresholds('receipt', { brightnessMin: 70 });
```

<details>
<summary>All 34 thresholds</summary>

| Threshold | Default | Description |
|---|---|---|
| `resolutionMin` | 0.3 | Minimum megapixels |
| `resolutionMax` | 200 | Maximum megapixels |
| `brightnessMin` | 50 | Dark image threshold (0-255) |
| `brightnessMax` | 245 | Overexposed threshold (0-255) |
| `sharpnessMin` | 15 | Minimum Laplacian stdev |
| `sharpnessMax` | 80 | Maximum Laplacian mean (noise) |
| `edgeDensityMin` | 0.015 | Minimum edge pixel ratio |
| `edgeDensityMax` | 0.5 | Maximum edge pixel ratio (noise) |
| `contrastMin` | 0.01 | Minimum foreground ratio |
| `contrastMax` | 0.85 | Maximum foreground ratio |
| `fileSizeMin` | 15000 | Minimum file size (bytes) |
| `fileSizeMax` | 100000000 | Maximum file size (bytes, 100 MB) |
| `uniformitySharpnessRatio` | 3.5 | Max sharpness ratio between halves |
| `uniformityBrightnessDiff` | 45 | Max brightness diff between halves |
| `passThreshold` | 0.5 | Score at or above = pass |
| `analysisMaxPx` | 1500 | Max dimension for analysis resize |
| `dpiMin` | 150 | Minimum DPI from metadata |
| `blankVarianceMax` | 2.0 | Max channel stdev (blank page) |
| `skewAngleMax` | 10.0 | Max estimated skew (degrees) |
| `shadowBrightnessDiff` | 60 | Edge vs center brightness diff |
| `compressionBppMin` | 0.5 | Minimum bits-per-pixel |
| `colorSaturationMin` | 0.01 | Grayscale-in-color detection |
| `moireCorrelationMax` | 0.65 | Moire pattern autocorrelation |
| `backgroundP90Min` | 170 | 90th-percentile brightness |
| `darkShadowCenterMax` | 150 | Compound shadow center brightness |
| `darkShadowDiffMin` | 20 | Compound shadow diff |
| `fftBlurHighFreqMin` | 0.005 | FFT high-freq energy (blur) |
| `fftNoiseHighFreqMax` | 0.85 | FFT high-freq energy (noise) |
| `fftMoirePeaksMax` | 15000 | FFT spectral peaks (moire) |
| `fftJpegGridMax` | 0.5 | FFT JPEG grid energy |
| `zoneBrightnessMaxDiff` | 60 | Quadrant brightness spread |
| `zoneSharpnessMinRatio` | 0.25 | Weakest/strongest quadrant sharpness |
| `directionalBlurRatioMax` | 4.0 | Directional energy concentration |
| `ocrConfidenceMin` | 60 | Minimum OCR word confidence (0-100) |

</details>

## Issue Codes and Guidance

Every issue includes a machine-readable `code` and a user-facing `guidance` string suitable for display in upload UIs.

```typescript
import { ISSUE_GUIDANCE } from 'doc-quality';

const result = await checkQuality(buffer);
for (const issue of result.issues) {
  console.log(issue.code);      // 'blurry'
  console.log(issue.guidance);  // 'The image is blurry. Hold the camera steady...'
  console.log(issue.message);   // 'Laplacian stdev 8.2 is below minimum 15'
  console.log(issue.value);     // 8.2
  console.log(issue.threshold); // 15
  console.log(issue.penalty);   // 0.5
}
```

<details>
<summary>All 32 issue codes</summary>

| Code | Guidance |
|---|---|
| `low-resolution` | The image resolution is too low. Please use a higher quality camera or move closer to the document. |
| `too-dark` | The image is too dark. Please retake in better lighting. |
| `overexposed` | The image is overexposed. Avoid direct light on the document and retake. |
| `blurry` | The image is blurry. Hold the camera steady and ensure the document is in focus. |
| `noisy` | The image has too much noise. Use better lighting instead of digital zoom. |
| `low-edge-density` | No legible content was detected. Make sure the document is visible and in frame. |
| `high-edge-density` | The image has excessive visual noise. Retake on a clean, flat surface. |
| `low-contrast` | The text contrast is too low. Ensure the document is well-lit and the text is visible. |
| `too-dark-content` | Most of the image is very dark. Check that the document is face-up and well-lit. |
| `file-too-small` | The file is suspiciously small. It may be corrupted or a thumbnail -- please upload the original. |
| `uneven-focus` | Part of the image is out of focus. Hold the camera parallel to the document, not at an angle. |
| `uneven-lighting` | The lighting is uneven across the image. Move to a uniformly lit area and retake. |
| `low-dpi` | The scan resolution is too low. Please re-scan at 300 DPI or higher. |
| `blank-page` | This appears to be a blank page. Please upload a page with content. |
| `heavy-compression` | The image is heavily compressed and may be unreadable. Please upload a less compressed version. |
| `shadow-on-edges` | There are shadows on the edges of the document. Retake in even lighting without objects casting shadows. |
| `dark-shadow` | The document has shadows and is too dim overall. Move to a brighter, evenly lit area. |
| `tilted` | The document appears tilted. Place it flat and take the photo directly from above. |
| `grayscale-in-color` | The image appears to be grayscale stored in a color format. This is not a problem but may indicate a copy of a copy. |
| `moire-pattern` | A moire pattern was detected, likely from photographing a screen or printed halftone. Retake directly from the original document. |
| `dim-background` | The document background is too dim. Use brighter lighting so the paper appears white. |
| `fft-blur` | The image shows signs of blur across the whole frame. Hold the camera steady and tap to focus before shooting. |
| `fft-noise` | The image has high-frequency noise throughout. Use better lighting to avoid camera sensor noise. |
| `fft-moire` | A repeating pattern interference was detected. Avoid photographing screens or printed halftone images. |
| `jpeg-artifacts` | Visible JPEG compression blocks were detected. Use PNG format or a higher JPEG quality setting. |
| `uneven-zone-brightness` | One area of the image is significantly darker than the rest. Ensure even lighting across the entire document. |
| `uneven-zone-sharpness` | One area of the image is blurrier than the rest. Hold the camera flat and parallel to the document. |
| `directional-blur` | Motion blur was detected -- the camera moved during capture. Hold the device steady or use a support. |
| `low-ocr-confidence` | The text in this image is difficult to read. Ensure the document is sharp, well-lit, and high resolution. |
| `file-too-large` | The file is too large. Please reduce the file size or compress the image before uploading. |
| `resolution-too-high` | The image resolution is excessively high. Please resize or downsample before uploading. |
| `custom` | A quality issue was detected with this image. |

</details>

## FFT Analyzers (Bring Your Own)

In `thorough` mode, the pipeline computes a 2D FFT magnitude spectrum and runs frequency-domain analyzers for blur, noise, moire patterns, and JPEG artifacts. You can register custom analyzers that receive the shared spectrum.

```typescript
import {
  registerFFTAnalyzer,
  clearFFTAnalyzers,
  computeSpectrum2D,
} from 'doc-quality';
import type { AnalysisContext, Thresholds } from 'doc-quality';

// Register a custom analyzer
registerFFTAnalyzer('fftBlur', (ctx, thresholds) => {
  const spectrum = ctx.fftSpectrum;
  if (!spectrum) return [];

  // Your custom frequency-domain analysis here
  const energy = analyzeSpectrum(spectrum.magnitude, spectrum.fftW, spectrum.fftH);

  if (energy < myThreshold) {
    return [{
      analyzer: 'fftBlur',
      code: 'fft-blur',          // Optional — defaults to 'custom'
      guidance: 'Custom message', // Optional — defaults to generic
      message: `Energy ratio ${energy.toFixed(3)}`,
      value: energy,
      threshold: myThreshold,
      penalty: 0.6,
    }];
  }
  return [];
});

// Run with thorough mode to trigger FFT analyzers
const result = await checkQuality(buffer, { mode: 'thorough' });

// Use the spectrum directly for your own analysis
const spectrum = computeSpectrum2D(greyPixels, width, height, 512);
// spectrum.magnitude: Float64Array (row-major, fftH x fftW)
// spectrum.totalEnergy: number
// spectrum.fftW, spectrum.fftH: padded dimensions (power of 2)
```

The `MagnitudeSpectrum2D` contains the centered log-magnitude spectrum after Hann windowing. The `computeSpectrum2D` function handles downsampling, power-of-2 padding, windowing, and 2D FFT internally.

## PDF Support

Requires the `pdf-to-png-converter` peer dependency.

```typescript
const result = await checkQuality(pdfBuffer);                      // First page only (default)
const result = await checkQuality(pdfBuffer, { pages: '1-5' });   // Pages 1 through 5
const result = await checkQuality(pdfBuffer, { pages: '1,4,8' }); // Specific pages
const result = await checkQuality(pdfBuffer, { pages: 'all' });   // Every page
```

### Multi-Page Results

Single-page PDFs return a flat result. Multi-page PDFs include per-page breakdown:

```typescript
const result = await checkQuality(pdfBuffer, { pages: 'all' });

console.log(result.pass);           // true only if ALL pages pass
console.log(result.score);          // Average score across pages
console.log(result.worstPageScore); // Lowest individual page score
console.log(result.pageResults);    // PageResult[] — per-page pass/fail/issues

for (const page of result.pageResults!) {
  console.log(`Page ${page.page}: ${page.pass ? 'PASS' : 'FAIL'} (${page.score})`);
}
```

### Concurrency and Progress

```typescript
const result = await checkQuality(pdfBuffer, {
  pages: 'all',
  maxConcurrency: 4,     // Analyze 4 pages at a time (default: all at once)
  onPage: (page, total, pageResult) => {
    console.log(`[${page}/${total}] ${pageResult.pass ? 'OK' : 'FAIL'}`);
  },
});
```

## Boundary Detection

Built-in lightweight document boundary detection identifies where a document sits within a photo (e.g., on a desk). Detected bounds are used for preset auto-detection and returned in the result.

```typescript
const result = await checkQuality(buffer); // detectBounds defaults to true

if (result.boundary?.detected) {
  console.log(result.boundary.region); // { x, y, width, height }
}

// Disable it
const result = await checkQuality(buffer, { detectBounds: false });

// Or use directly
import { detectDocumentBounds } from 'doc-quality';
const bounds = await detectDocumentBounds(buffer);
// { x: 120, y: 80, width: 1600, height: 2200 } or null
```

### Custom Boundary Detector

Bring your own boundary detector for more accurate cropping. When provided, all quality checks run on the cropped region.

```typescript
const result = await checkQuality(buffer, {
  mode: 'thorough',
  boundaryDetector: async (buf) => {
    const region = await myMLModel.detect(buf);
    return {
      detected: true,
      region: { x: region.x, y: region.y, width: region.w, height: region.h },
      confidence: region.score,
      croppedBuffer: await crop(buf, region),
    };
  },
});
```

## OCR Confidence

Requires the `tesseract.js` peer dependency. Disabled by default.

```typescript
const result = await checkQuality(buffer, {
  ocrConfidence: true,
  ocrLanguage: 'eng',       // Default: 'eng'
});
// May emit 'low-ocr-confidence' issue if median word confidence < 60

// Reuse a Tesseract worker across calls for performance
import Tesseract from 'tesseract.js';
const worker = await Tesseract.createWorker('eng');

const r1 = await checkQuality(buf1, { ocrConfidence: true, ocrWorker: worker });
const r2 = await checkQuality(buf2, { ocrConfidence: true, ocrWorker: worker });

await worker.terminate();
```

## CLI

```bash
npx doc-quality photo.jpg
# Output: PASS (score: 0.92, preset: document)

npx doc-quality scan.pdf --pages all --mode thorough
# Output: FAIL (score: 0.35, preset: document)
#   Page 1: blurry — Laplacian stdev 8.2 is below minimum 15
#   Page 3: too-dark — Mean brightness 32 is below minimum 50

npx doc-quality photo.jpg --json
# { "pass": true, "score": 0.92, ... }
```

**Options:** `-m, --mode` (fast|thorough), `-p, --pages` (1, 1-5, all), `--preset` (auto|document|receipt|card), `-j, --json`, `-h, --help`

**Exit codes:** 0 = pass, 1 = fail or error.

## Installation

```bash
# Full backend (most users)
npm install doc-quality sharp

# With PDF support
npm install doc-quality sharp pdf-to-png-converter

# With OCR
npm install doc-quality sharp tesseract.js

# Preflight only (browser apps — no native deps)
npm install doc-quality
```

All peer dependencies are optional. The preflight subpath (`doc-quality/preflight`) has zero native dependencies and works without sharp installed. The main entry point throws at runtime if sharp is not available.

## Supported Formats

**Images:** JPEG, PNG, WebP, TIFF, GIF, AVIF, HEIF, SVG (via sharp)

**PDF:** Via `pdf-to-png-converter` (optional peer dependency)

## License

MIT
