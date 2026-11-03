/** D3 curated help for `gbrain ingest-undo` (src/commands/ingest-undo.ts). Docs: docs/guides/ingest.md#undo. */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'Preview (exit 3), then retract what one ingest attempt created; edited, promoted or relied-on pages and claims are kept.',
  usage: 'gbrain ingest-undo <attempt_id> [--yes --expect <plan_hash>] [--json]',
  flags: [
    { name: '--yes', type: 'boolean', desc: 'Apply the undo; requires --expect with the plan_hash the preview printed.' },
    { name: '--expect', type: 'string', desc: 'The plan_hash of the preview being applied; a changed plan refuses.' },
    { name: '--json', type: 'boolean', desc: 'Print the preview or result as JSON.' },
  ],
  examples: ['gbrain ingest-undo <attempt_id>', 'gbrain ingest-undo <attempt_id> --yes --expect <plan_hash>'],
};
