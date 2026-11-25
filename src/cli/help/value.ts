/** D3 curated help for `gbrain value` (flags read by src/commands/value.ts runValue). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'What your brain holds and has done for you, as counts: conversations archived, pages by kind, links, facts kept, lookups served, pages brought up on their own and later retrieved, nightly items and the brain score. Each row is measured, off (with the command that turns it on) or unavailable (with a code and cause). Reads only; stamps nothing. Runs on the brain host only.',
  usage: 'gbrain value [--json]',
  flags: [
    { name: '--json', type: 'boolean', desc: 'Print the card as one JSON document (schema gbrain.value, schema_version 1).' },
  ],
  examples: [
    'gbrain value',
    'gbrain value --json',
  ],
};
