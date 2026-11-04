/** D3 curated help for `gbrain ingest-show` (src/commands/ingest-show.ts). Docs: docs/guides/ingest.md. */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'Read an ingest report (read-only, no provider calls).',
  usage: 'gbrain ingest-show <attempt_id> [--json]',
  flags: [
    { name: '--json', type: 'boolean', desc: 'Print the report as JSON.' },
  ],
  examples: ['gbrain ingest-show <attempt_id>', 'gbrain ingest-show <attempt_id> --json'],
};
