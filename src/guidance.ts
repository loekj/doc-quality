import type { IssueCode } from './types.js';

/**
 * User-facing guidance messages for each issue code.
 * Suitable for display in upload UIs, validation feedback, etc.
 *
 * @example
 * ```ts
 * import { checkQuality, ISSUE_GUIDANCE } from 'doc-quality';
 *
 * const result = await checkQuality(buffer);
 * for (const issue of result.issues) {
 *   showToast(issue.guidance); // or ISSUE_GUIDANCE[issue.code] for the default
 * }
 * ```
 */
export const ISSUE_GUIDANCE: Record<IssueCode, string> = {
  'low-resolution': 'The image resolution is too low. Please use a higher quality camera or move closer to the document.',
  'too-dark': 'The image is too dark. Please retake in better lighting.',
  'overexposed': 'The image is overexposed. Avoid direct light on the document and retake.',
  'blurry': 'The image is blurry. Hold the camera steady and ensure the document is in focus.',
  'noisy': 'The image has too much noise. Use better lighting instead of digital zoom.',
  'low-edge-density': 'No legible content was detected. Make sure the document is visible and in frame.',
  'high-edge-density': 'The image has excessive visual noise. Retake on a clean, flat surface.',
  'low-contrast': 'The text contrast is too low. Ensure the document is well-lit and the text is visible.',
  'too-dark-content': 'Most of the image is very dark. Check that the document is face-up and well-lit.',
  'file-too-small': 'The file is suspiciously small. It may be corrupted or a thumbnail — please upload the original.',
  'uneven-focus': 'Part of the image is out of focus. Hold the camera parallel to the document, not at an angle.',
  'uneven-lighting': 'The lighting is uneven across the image. Move to a uniformly lit area and retake.',
  'low-dpi': 'The scan resolution is too low. Please re-scan at 300 DPI or higher.',
  'blank-page': 'This appears to be a blank page. Please upload a page with content.',
  'heavy-compression': 'The image is heavily compressed and may be unreadable. Please upload a less compressed version.',
  'shadow-on-edges': 'There are shadows on the edges of the document. Retake in even lighting without objects casting shadows.',
  'dark-shadow': 'The document has shadows and is too dim overall. Move to a brighter, evenly lit area.',
  'tilted': 'The document appears tilted. Place it flat and take the photo directly from above.',
  'grayscale-in-color': 'The image appears to be grayscale stored in a color format. This is not a problem but may indicate a copy of a copy.',
  'moire-pattern': 'A moiré pattern was detected, likely from photographing a screen or printed halftone. Retake directly from the original document.',
  'dim-background': 'The document background is too dim. Use brighter lighting so the paper appears white.',
  'fft-blur': 'The image shows signs of blur across the whole frame. Hold the camera steady and tap to focus before shooting.',
  'fft-noise': 'The image has high-frequency noise throughout. Use better lighting to avoid camera sensor noise.',
  'fft-moire': 'A repeating pattern interference was detected. Avoid photographing screens or printed halftone images.',
  'jpeg-artifacts': 'Visible JPEG compression blocks were detected. Use PNG format or a higher JPEG quality setting.',
  'uneven-zone-brightness': 'One area of the image is significantly darker than the rest. Ensure even lighting across the entire document.',
  'uneven-zone-sharpness': 'One area of the image is blurrier than the rest. Hold the camera flat and parallel to the document.',
  'directional-blur': 'Motion blur was detected — the camera moved during capture. Hold the device steady or use a support.',
  'low-ocr-confidence': 'The text in this image is difficult to read. Ensure the document is sharp, well-lit, and high resolution.',
  'file-too-large': 'The file is too large. Please reduce the file size or compress the image before uploading.',
  'resolution-too-high': 'The image resolution is excessively high. Please resize or downsample before uploading.',
  'wavy-text-lines': 'The text lines appear wavy or uneven. Flatten the document and retake the photo on a flat surface.',
  'inconsistent-char-size': 'Characters vary in size across the document, suggesting the paper is crumpled or folded. Flatten and retake.',
  'distorted-char-shapes': 'Characters appear distorted or warped. Smooth out the document and photograph it on a flat surface.',
  'custom': 'A quality issue was detected with this image.',
};
