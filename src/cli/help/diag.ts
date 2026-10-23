/** D3 curated help for `gbrain diag` (flags read by src/commands/diag.ts runDiag). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'One bounded diagnostic bundle: version and build skew, each source\'s freshness and HEAD lag, held files by code, database connections, and the stage timing of one search. Read-only.',
  usage: 'gbrain diag [--json] [--budget-ms <ms>] [--query <text>]',
  flags: [
    { name: '--json', type: 'boolean', desc: 'Print the bundle as one JSON document; every section carries elapsed_ms and a status (ok, not_read with its reason, not_applicable, error).' },
    { name: '--budget-ms', type: 'number', desc: 'Total time for the bundle (default 30000); a section the budget cuts off says not_read.' },
    { name: '--query', type: 'string', desc: 'Query for the timed search (default a fixed probe); the bundle shows its result count, never its results.' },
  ],
  examples: [
    'gbrain diag --json',
    'gbrain diag --json --budget-ms 60000',
    'gbrain diag --query "acme-example pricing"',
  ],
};
