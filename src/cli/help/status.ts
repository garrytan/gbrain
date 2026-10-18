/** D3 curated help for `gbrain status` (flags read by src/commands/status.ts runStatus). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'One-screen operational snapshot: sync, cycle, locks, workers, queue and autopilot.',
  usage: 'gbrain status [--json] [--section sync|cycle|locks|workers|queue|autopilot] [--fast | --deadline-ms <ms>] | gbrain status --funnel [--json] [--enable | --delete]',
  flags: [
    { name: '--json', type: 'boolean', desc: 'Print the snapshot as one JSON document.' },
    { name: '--section', type: 'enum', values: ['sync', 'cycle', 'locks', 'workers', 'queue', 'autopilot'], desc: 'Report only this section.' },
    { name: '--fast', type: 'boolean', desc: 'Bound the snapshot to 2000 ms; a section past the budget returns stale with a warning.' },
    { name: '--deadline-ms', type: 'number', desc: 'Bound the snapshot to this many milliseconds (positive).' },
    { name: '--funnel', type: 'boolean', desc: 'Show the local, opt-in adoption funnel (counts per stage, never rates; nothing leaves this machine).' },
    { name: '--enable', type: 'boolean', desc: 'With --funnel: start recording funnel counts in ~/.gbrain/funnel.jsonl (off by default).' },
    { name: '--delete', type: 'boolean', desc: 'With --funnel: delete the funnel record, which stops recording.' },
  ],
  examples: [
    'gbrain status',
    'gbrain status --json --fast',
    'gbrain status --section queue --json',
    'gbrain status --funnel --json',
  ],
};
