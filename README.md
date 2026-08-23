# doc-quality

**The** most comprehensive -- arguably over-engineered -- document image quality checker for pre-OCR and AI extraction pipelines. 24 analyzers, 38 issue codes, FFT spectral analysis, zone-based uniformity checks, per-text-line legibility measurement, document boundary cropping, PDF content classification, and a 3KB browser preflight. All so your users never upload a blurry receipt photo that burns $0.15 and 45 seconds on Textract just to return `"confidence": 0.12`.

Stop feeding garbage to expensive AI. Catch it first.

---

**The problem:** Managed OCR and document AI services (AWS Textract, Google Document AI, Azure Form Recognizer) charge per page and take 30-60s per call. A dark photo, a blank page, a motion-blurred scan -- they all cost the same as a perfect one, except you get nothing back. Multiply by thousands of uploads and you're lighting money on fire.

**The fix:** `doc-quality` catches bad images in milliseconds -- in the browser before upload, or on the server before the expensive pipeline -- and gives users actionable guidance to retake the photo. Every rejection saves a round-trip, a service call, and a frustrated user staring at "processing..." for a minute.

Three tiers: a **browser preflight** (~3KB, zero deps, <10ms) for instant upload validation, a **backend check** (sharp-based, 24 analyzers, FFT frequency-domain analysis) for server-side gating, and a **deep pass** that measures whether each line of text can actually be read. If preflight rejects an image, the backend is guaranteed to reject it too.

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
| **Speed** | <10ms on mobile | ~50ms fast, ~350ms thorough, ~380ms deep |
| **Bundle size** | ~3KB gzipped | N/A (server) |
| **Checks** | 8 core checks | 24 analyzers |
| **Dependencies** | None | sharp (+ optional pdf, ocr) |
| **Use case** | Reject clearly bad uploads instantly | Server-side validation, and `deep` for asynchronous work |

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

console.log(result.pass);       // true/false
console.log(result.score);      // 0-1
console.log(result.confidence); // 'high' | 'medium' | 'low' — distance from the pass threshold
console.log(result.preset);     // 'document' | 'receipt' | 'card'
console.log(result.issues);     // Issue[]
console.log(result.metadata);   // { width, height, megapixels, fileSize, format? }
console.log(result.timing);     // { totalMs, analyzers: { brightness: 2, sharpness: 5, ... } }

// Present when relevant
console.log(result.boundary);      // { detected, region, cropped, edgesDetected }
console.log(result.pdfKind);       // 'digital-text' | 'scanned' | 'mixed' | 'empty'
console.log(result.effectiveDpi);  // true scan resolution, from PDF page geometry
console.log(result.pageResults);   // per-page breakdown (multi-page PDFs)
console.log(result.worstPageScore);
```

Each issue carries a `severity`:

```typescript
for (const issue of result.issues) {
  issue.code;      // 'blurry', 'too-dark', 'text-too-small', ...
  issue.guidance;  // user-facing text
  issue.message;   // diagnostic text with the measured value
  issue.value;     // what was measured
  issue.threshold; // what it was measured against
  issue.penalty;   // score multiplier, graded by how badly the threshold was missed
  issue.severity;  // 'error' (lowers the score) | 'advisory' (reported only)
}
```

`advisory` issues are reported and fed to the feature vector but never lower the
score. Some signals fire on perfectly good documents -- printed text is periodic
and anisotropic, so a clean page looks like moire and directional blur to a
global detector -- and a clean born-digital PDF scored 0.44 when they gated it.
`grayscale-in-color`, `fft-moire`, `directional-blur` and `distorted-char-shapes`
are advisory.

### Options

```typescript
const result = await checkQuality(buffer, {
  mode: 'thorough',           // 'fast' (default), 'thorough' (FFT + zone), or 'deep' (per-text-line)
  cropToBounds: true,         // analyse only the detected document, not the desk (default: true)
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
  pdfStrategy: 'content',      // 'content' (default) or 'render' — see PDF Support
  ocrConfidence: false,        // Run OCR and check word confidence (needs tesseract.js)
});
```

**Timeouts fail closed.** A check that did not finish tells you nothing about the
image, so it returns `pass: false, score: 0` with an `analysis-timeout` issue
rather than a perfect score. For PDFs the deadline applies **per page**: a
20-page scan legitimately takes ~18s, and one page that hangs no longer sinks
the rest.

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

### Native-Resolution Passes

Most analysis runs on a copy resized to `analysisMaxPx`. Three things do not,
because a resize destroys exactly what they measure:

| What | Why |
|---|---|
| JPEG blockiness | The 8x8 block grid does not survive resampling. Measured on the resized copy it returned 0.000 for every image wider than 1500px -- every phone photo. |
| Per-text-line metrics (`deep`) | x-height and stroke width are the detail a resize removes. |
| Embedded PDF images | Graded at the resolution the file actually holds. |

Transient cost is about 1 byte per pixel: 12 MB for a 12 MP photo, 84 MB at 33 MP.

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
// Auto-detection order:
// 1. Much longer than wide (aspect <= 0.45 or >= 2.2)  -> 'receipt'
// 2. A standard paper ratio (A-series, Letter, Legal)  -> 'document'
// 3. Close to ISO 7810 ID-1 and under 4 MP             -> 'card'
// 4. Everything else                                    -> 'document'

const result = await checkQuality(buffer, { preset: 'auto' });
```

Paper is checked before cards because their shapes overlap and paper is far more
common. A4 portrait is 0.707 and a portrait passport is 0.704; A4 landscape is
1.414 and an open passport is 1.420. Nothing separates those from dimensions
alone, so paper wins -- `document` holds the lenient thresholds, and a card
graded as a document under-detects where a document graded as a card
over-rejects. The cost is that a photographed passport grades as a document.

When boundary detection finds the page, the ratio is taken from the document
rather than the frame, which makes this considerably more reliable for photos.

| Preset | Use Case | Stricter On |
|---|---|---|
| `document` | Tax forms, contracts, letters | Default thresholds |
| `receipt` | Thermal paper, register receipts | Brightness, sharpness, resolution |
| `card` | ID cards, credit cards, driving licences | Edge density, contrast, sharpness uniformity |

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
<summary>All 45 thresholds</summary>

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
| `compressionBppMin` | 0.3 | Minimum bits-per-pixel |
| `compressionBlockinessMin` | 0.1 | Blockiness needed to confirm low bpp is real damage |
| `colorSaturationMin` | 0.01 | Grayscale-in-color detection |
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
| `zoneContentStdevMin` | 5 | Greyscale spread a quadrant needs before its sharpness counts |
| `baselineDeviationMax` | 0.02 | Max text baseline wobble, as a fraction of height |
| `charSizeCVMax` | 0.5 | Max variation in character area |
| `charShapeCVMax` | 0.4 | Max variation in character circularity (advisory) |
| `laplacianEdgeThreshold` | 30 | Magnitude above which a pixel counts as an edge |
| `binarizationThreshold` | 128 | Greyscale cutoff for text binarization |
| `textXHeightMin` | 8 | Minimum lowercase body height in px (`deep`) |
| `textStrokeWidthMin` | 1.2 | Minimum stroke thickness in px (`deep`) |
| `textLineContrastMin` | 40 | Minimum per-line ink-to-paper separation (`deep`) |
| `textStrokeSharpnessMin` | 0.4 | Minimum contrast-normalised stroke edge gradient (`deep`) |
| `textIllegibleFractionMax` | 0.15 | Share of lines allowed to fail legibility (`deep`) |

</details>

Penalties are **graded by severity**, not flat. A JPEG that misses the
bits-per-pixel floor by a little is penalised a little; one that misses it by 4x
is penalised much harder. Flat penalties meant quality 25 and quality 8 both
scored 0.7, so a quality 4 file passed. The ladder now runs:

| JPEG quality | 92 | 50 | 25 | 12 | 8 | 4 | 1 |
|---|---|---|---|---|---|---|---|
| score | 1.00 | 1.00 | 0.67 | 0.57 | 0.51 | 0.29 | 0.15 |

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
| `wavy-text-lines` | The text lines appear wavy or uneven. Flatten the document and retake the photo on a flat surface. |
| `inconsistent-char-size` | Characters vary in size across the document, suggesting the paper is crumpled or folded. Flatten and retake. |
| `distorted-char-shapes` | Characters appear distorted or warped. Smooth out the document and photograph it on a flat surface. |
| `text-too-small` | The text is too small to read reliably. Please move closer, or scan at a higher DPI. |
| `illegible-text` | Some lines of text cannot be read. Please retake the photo with better focus and lighting. |
| `analysis-timeout` | The quality check did not finish in time. Please try again, or upload a smaller file. |
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

### Content, Not Rendered Pixels

By default each page is classified and its **embedded images** are graded at
native resolution. Rasterising the page instead answers the wrong question
twice: a born-digital PDF has an exact text layer, and rendering resamples
embedded scans to the viewport then emits PNG, which erases the blocking and the
bits-per-pixel that made a scan bad.

A 300 DPI scan saved at JPEG quality 4, in the same file:

| | size analysed | format | score | |
|---|---|---|---|---|
| rendered page | 1224x1584 | png | **1.00** | PASS |
| embedded image | 2550x3300 | jpeg | **0.29** | FAIL |

```typescript
const result = await checkQuality(pdfBuffer);
result.pdfKind;      // 'digital-text' | 'scanned' | 'mixed' | 'empty'
result.effectiveDpi; // 300 — native pixels over placed page size

// Rasterise every page instead (the old behaviour)
await checkQuality(pdfBuffer, { pdfStrategy: 'render' });
```

- **`digital-text`** pages pass with score 1 and no pixel analysis. Their text
  layer is exact, so image quality does not apply.
- **`scanned`** and **`mixed`** pages are graded on their embedded images. On a
  mixed page only the images are graded, not the typeset text around them.
- Classification uses **image coverage**, not the presence of text: an OCR'd
  scan carries both a full-page image and a text layer.
- `effectiveDpi` is real scan resolution, derived from native pixels over placed
  size. The low-DPI check honours it and skips the camera-EXIF guard, because
  PDF page geometry is trustworthy where EXIF density is not.

Original DCTDecode streams are recovered byte for byte, so file size,
bits-per-pixel and the 8x8 block grid stay meaningful. Everything else --
Flate, CCITT, JPEG 2000, stencil masks, CMYK, and anything carrying a `/Decode`
array -- comes through pdf.js, decoded. Falls back to rendering automatically
when `pdfjs-dist` is unavailable or a file cannot be parsed.

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

Built-in boundary detection finds where a document sits within a photo, and
analysis then runs on that region instead of the whole frame.

This matters more than it sounds. A correctly exposed page photographed on a
dark desk scores **0.70 with `shadow-on-edges`** when the desk is graded along
with it. Cropped to its own edges the same page scores **1.00 with nothing
flagged** -- the shadow was the table. It holds across dark, mid-grey, brown and
black surfaces.

```typescript
const result = await checkQuality(buffer); // detectBounds and cropToBounds default to true

if (result.boundary?.detected) {
  result.boundary.region;         // { x, y, width, height }
  result.boundary.cropped;        // true when analysis ran on that region
  result.boundary.edgesDetected;  // how many of the four edges resolved
}

// Report the region without letting it change what is measured
await checkQuality(buffer, { cropToBounds: false });

// Turn detection off entirely
await checkQuality(buffer, { detectBounds: false });

// Or use it directly
import { detectDocumentBounds } from 'doc-quality';
const bounds = await detectDocumentBounds(buffer);
// { x: 144, y: 176, width: 1512, height: 1848, edgesDetected: 4 } or null
```

Detection is deliberately conservative: five safety gates, and null unless all
of them pass. Measured against known rectangles it lands within 1% of the truth
(IoU 0.987-0.998), and it declines outright on a near-white surface where there
is no transition to find.

**Cropping needs all four edges.** An undetected edge falls back to the frame
edge, so a region built from two or three still contains whatever sat along the
others -- and a hard dark strip down one side reads as a shadow, which is worse
than the uncropped frame it replaced. A page flush to the bottom of the frame
resolves three edges and is left alone. Cropping is also skipped when the region
already covers 95% of the frame, and whenever a custom `boundaryDetector` is
supplied, since that detector owns the decision.

### Custom Boundary Detector

Bring your own detector for more accurate cropping. When provided it replaces the
built-in one entirely, `cropToBounds` does not apply, and quality checks run on
whatever `croppedBuffer` you return.

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


## Modes

Three tiers, meant for three places in a pipeline.

| Mode | Typical latency | What it adds | Where it belongs |
| --- | --- | --- | --- |
| `fast` | ~50 ms | Resolution, file size, brightness, sharpness, DPI, blank page, compression | A request someone is waiting on |
| `thorough` | ~350 ms | FFT blur/noise, zone uniformity, shadow, skew, text geometry, JPEG artifacts | A request someone is waiting on, when latency allows |
| `deep` | ~380 ms | Per-text-line legibility on native-resolution pixels | Background or asynchronous work |

`deep` exists because page-level statistics cannot answer the question that
matters before OCR: *can each line actually be read?* A page captured at 96 DPI
is clean by every page-level measure — correctly exposed, level, sharp, no
noise — and still unreadable. `fast` and `thorough` both pass it.

```ts
const result = await checkQuality(buffer, { mode: 'deep' });
// Text too small to read (median x-height 7.0px, minimum 8px, across 46 lines)
// 34 of 46 text lines are not legible (74%, maximum 15%)
```

It measures, per line: the height of the lowercase body in pixels, stroke
thickness, ink-to-paper separation, and a contrast-normalised edge gradient.
That last one is the blur test — normalising by the line's own contrast keeps
pale-but-crisp text apart from soft text, which a raw gradient conflates.

x-height is the headline number, because it maps directly to an instruction:

| Capture DPI | x-height of 10pt text | Verdict |
| --- | --- | --- |
| 72 | 5 px | unreadable |
| 96 | 7 px | unreadable |
| 120 | 9 px | marginal |
| 150 | 11 px | fine |
| 300 | 22 px | comfortable |

`deep` costs only ~30 ms more than `thorough` — it shares the same decode and
FFT work. The tier is about capability, not time spent.

## CLI

```bash
npx doc-quality photo.jpg
# Output: PASS (score: 0.92, preset: document)

npx doc-quality scan.pdf --pages all --mode thorough
npx doc-quality scan.jpg --mode deep
# Output: FAIL (score: 0.35, preset: document)
#   Page 1: blurry — Laplacian stdev 8.2 is below minimum 15
#   Page 3: too-dark — Mean brightness 32 is below minimum 50

npx doc-quality photo.jpg --json
# { "pass": true, "score": 0.92, ... }
```

**Options:** `-m, --mode` (fast|thorough|deep), `-p, --pages` (1, 1-5, all), `--preset` (auto|document|receipt|card), `-j, --json`, `-h, --help`

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

## Training Dataset

The scoring model is trained on the [doc-quality-dataset](https://zenodo.org/records/18907841?token=eyJhbGciOiJIUzUxMiJ9.eyJpZCI6Ijk0OTM1NzhjLTZjMDUtNDY2OC1iMzdjLTYxYzVjOGVkYmY3YiIsImRhdGEiOnt9LCJyYW5kb20iOiI0YjczMTdiYTAyZWZhZjA5ODYyMWY5NDQ5MDUwY2ZkYiJ9.1Fxp-V0ZsJTzv_h4dxS7wt-AlvN9SEaEjWKwpunSsHuBJTAnyTQOmlS93bcNyJRuS5Zmvv3vcXtl0_sAxRXEog) — 5,000+ labeled document, receipt, card, and photo images across quality tiers (very-good, good, bad, very-bad), including synthetically degraded variants.

## Supported Formats

**Images:** JPEG, PNG, WebP, TIFF, GIF, AVIF, HEIF, SVG (via sharp)

**PDF:** Via `pdf-to-png-converter` (optional peer dependency)

## License

MIT
