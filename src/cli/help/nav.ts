/** D3 curated help for `gbrain nav` (flags read by src/commands/nav.ts runNav). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: "Write the brain's index.md, log.md and hot.md (the source's folder, or ~/.gbrain/nav/<source> when gbrain manages it); only the marked block is rebuilt.",
  usage: 'gbrain nav [build] [--source <id>] [--out <dir>] [--dry-run] [--json]',
  flags: [
    { name: '--source', type: 'string', desc: 'The source whose files to write (default: default).' },
    { name: '--out', type: 'string', desc: "The folder to write into (default: the source's folder, or ~/.gbrain/nav/<source> when gbrain manages it)." },
    { name: '--dry-run', type: 'boolean', desc: 'Say what would be created or updated; write nothing.' },
    { name: '--json', type: 'boolean', desc: 'One JSON document on stdout: the folder and each file with its action.' },
  ],
  examples: [
    'gbrain nav',
    'gbrain nav --dry-run',
    'gbrain nav --source notes --json',
  ],
};
