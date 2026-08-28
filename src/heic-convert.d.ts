/**
 * `heic-convert` ships no types and has no @types package.
 *
 * Only the one call shape this library uses is declared. See src/heif.ts for
 * why the dependency exists at all.
 */
declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer;
    format: 'PNG' | 'JPEG';
    /** JPEG only, 0–1. Unused here: analysis converts losslessly. */
    quality?: number;
  }
  const convert: (options: ConvertOptions) => Promise<ArrayLike<number>>;
  export default convert;
}
