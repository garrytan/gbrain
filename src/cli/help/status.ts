/** D3 curated help for `gbrain status` (flags read by src/commands/status.ts runStatus). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'One-screen operational snapshot: sync, cycle, locks, workers, queue and autopilot.',
  usage: 'gbrain status [--json] [--section sync|cycle|locks|workers|queue|autopilot] [--fast | --deadline-ms <ms>]',
  flags: [
    { name: '--json', type: 'boolean', desc: 'Print the snapshot as one JSON document.' },
    { name: '--section', type: 'enum', values: ['sync', 'cycle', 'locks', 'workers', 'queue', 'autopilot'], desc: 'Report only this section.' },
    { name: '--fast', type: 'boolean', desc: 'Bound the snapshot to 2000 ms; a section past the budget returns stale with a warning.' },
    { name: '--deadline-ms', type: 'number', desc: 'Bound the snapshot to this many milliseconds (positive).' },
  ],
  examples: [
    'gbrain status',
    'gbrain status --json --fast',
    'gbrain status --section queue --json',
  ],
};
