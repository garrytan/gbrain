/** D3 curated help for `foresights inbox` (flags read by src/commands/inbox.ts runInbox). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'Turn files dropped into the inbox folder (~/.gbrain/inbox) into pages; originals move to .archived/<date>/.',
  usage: 'foresights inbox [status | run [--once]] [--dir <path>] [--source <id>] [--json]',
  flags: [
    { name: '--once', type: 'boolean', desc: 'With run: capture every file waiting now, then exit (a file is archived only after its capture landed).' },
    { name: '--dir', type: 'string', desc: 'The inbox folder (default ~/.gbrain/inbox).' },
    { name: '--source', type: 'string', desc: 'The source the pages land in (default: the default source).' },
    { name: '--json', type: 'boolean', desc: 'One JSON document on stdout (status: waiting files; run --once: captured, left unreadable, failed, skipped).' },
  ],
  examples: [
    'foresights inbox',
    'foresights inbox run --once',
    'foresights inbox run --once --source notes --json',
    'foresights inbox run',
  ],
};
