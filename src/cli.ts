import { parseArgs } from 'node:util';
import { checkQuality } from './index.js';
import type { Mode, PresetName } from './types.js';

const HELP = `
doc-quality — Document & image quality analysis

Usage:
  doc-quality <file> [options]

Options:
  -m, --mode <mode>      Analysis mode: fast | thorough (default: fast)
  -p, --pages <pages>    Pages to analyze for PDFs: 1, 1-5, all (default: 1)
      --preset <preset>  Threshold preset: auto | document | receipt | card (default: auto)
  -j, --json             Output JSON instead of human-readable text
  -h, --help             Show this help message

Examples:
  doc-quality scan.png
  doc-quality invoice.pdf --mode thorough --pages all
  doc-quality receipt.jpg --preset receipt --json
`.trim();

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string', short: 'm', default: 'fast' },
      pages: { type: 'string', short: 'p', default: '1' },
      preset: { type: 'string', default: 'auto' },
      json: { type: 'boolean', short: 'j', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const file = positionals[0];
  if (!file) {
    console.error('Error: No file specified.\n');
    console.error(HELP);
    process.exit(1);
  }

  const result = await checkQuality(file, {
    mode: values.mode as Mode,
    preset: values.preset as PresetName,
    pages: values.pages,
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`File:   ${file}`);
    console.log(`Preset: ${result.preset}`);
    console.log(`Mode:   ${values.mode}`);
    console.log(`Score:  ${result.score}`);
    console.log(`Result: ${result.pass ? 'PASS' : 'FAIL'}`);

    if (result.issues.length > 0) {
      console.log(`\nIssues (${result.issues.length}):`);
      for (const issue of result.issues) {
        const page = issue.page ? ` [page ${issue.page}]` : '';
        console.log(`  - [${issue.analyzer}] ${issue.message}${page}`);
      }
    }
  }

  process.exit(result.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
