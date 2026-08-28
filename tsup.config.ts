import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    // The HEIC worker resolves heic-convert through `import.meta.url`, which
    // CJS does not have. This shims it so both builds resolve from the
    // installed package rather than the application's working directory.
    shims: true,
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    external: ['sharp', 'pdf-to-png-converter', 'pdfjs-dist', 'heic-convert'],
  },
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    clean: false,
    splitting: false,
    sourcemap: false,
    banner: { js: '#!/usr/bin/env node' },
    external: ['sharp', 'pdf-to-png-converter', 'pdfjs-dist', 'heic-convert'],
  },
  {
    entry: { preflight: 'src/preflight.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'browser',
  },
]);
