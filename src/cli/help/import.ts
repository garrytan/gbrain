/** D3 curated help for `gbrain import` (flags read by src/commands/import.ts runImport). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'Import a directory (or one file) of markdown into the brain.',
  usage: 'gbrain import <dir> [--source <id> | --source-id <id>] [--no-embed] [--workers <n>] [--fresh] [--include-gitignored] [--allow-noncanonical-root] [--log-noop] [--json]',
  flags: [
    { name: '--source', type: 'string', desc: 'Write into this source id (must already exist; see `gbrain sources list`).' },
    { name: '--source-id', type: 'string', desc: 'Same as --source; pass one or the other.' },
    { name: '--no-embed', type: 'boolean', desc: 'Skip embeddings (no provider calls); embed the new pages later with `gbrain embed`.' },
    { name: '--workers', type: 'number', desc: 'Parallel import workers (positive integer, default 1; clamped to the connection budget).' },
    { name: '--fresh', type: 'boolean', desc: 'Ignore the resume checkpoint and walk every file again.' },
    { name: '--include-gitignored', type: 'boolean', desc: 'Also import files git ignores.' },
    { name: '--allow-noncanonical-root', type: 'boolean', desc: 'Import even when the directory is not the source\'s configured root.' },
    { name: '--log-noop', type: 'boolean', desc: 'Write an ingest_log row even when nothing changed.' },
    { name: '--json', type: 'boolean', desc: 'Print the import summary as JSON on stdout (progress stays on stderr).' },
  ],
  examples: [
    'gbrain import ~/notes',
    'gbrain import ~/notes --source notes --no-embed',
    'gbrain import ./brain --workers 4 --json',
  ],
};
