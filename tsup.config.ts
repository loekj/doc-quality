import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    external: ['sharp', 'pdf-to-png-converter', 'pdfjs-dist'],
  },
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    clean: false,
    splitting: false,
    sourcemap: false,
    banner: { js: '#!/usr/bin/env node' },
    external: ['sharp', 'pdf-to-png-converter', 'pdfjs-dist'],
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
