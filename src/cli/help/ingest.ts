/** D3 curated help for `gbrain ingest` (flags read by src/commands/ingest.ts). Docs: docs/guides/ingest.md. */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'Save a pasted document: a source page, proposed entity pages and facts, with one report.',
  usage: 'gbrain ingest (--file <path> | --stdin) [--type <type>] [--title <title>] [--slug <slug>] [--source <id>] [--valid-from <date>] [--visibility world|private] [--no-facts] [--trusted-extraction] [--max-usd <n>] [--request-id <id>] [--resume --attempt <id>] [--dry-run] [--json]',
  flags: [
    { name: '--file', type: 'string', desc: 'The document to read (text, at most 200,000 characters).' },
    { name: '--stdin', type: 'boolean', desc: 'Read the document from standard input.' },
    { name: '--type', type: 'string', desc: 'Page type of the source page (default note; the active pack must declare it).' },
    { name: '--title', type: 'string', desc: 'Title of the source page.' },
    { name: '--slug', type: 'string', desc: 'Slug of the source page (default inbox/ingest-<hash>).' },
    { name: '--source', type: 'string', desc: 'Source to write (default: the current source).' },
    { name: '--valid-from', type: 'string', desc: 'When the document\'s facts became true (ISO date).' },
    { name: '--visibility', type: 'enum', values: ['world', 'private'], desc: 'Visibility of what the ingest writes (default world).' },
    { name: '--no-facts', type: 'boolean', desc: 'Save the document and its entity pages without facts.' },
    { name: '--trusted-extraction', type: 'boolean', desc: 'Create model-typed new entities as real pages instead of proposed (owner only).' },
    { name: '--max-usd', type: 'number', desc: 'Spend cap for this ingest (default ingest.max_usd, 0.50).' },
    { name: '--request-id', type: 'string', desc: 'Idempotency key: a repeat with the same key returns the same attempt.' },
    { name: '--resume', type: 'boolean', desc: 'Continue an incomplete attempt named by --attempt (pass the same document).' },
    { name: '--attempt', type: 'string', desc: 'The attempt id --resume continues.' },
    { name: '--dry-run', type: 'boolean', desc: 'Keyless preview: candidate names, windows and estimated cost; no provider call, nothing written.' },
    { name: '--json', type: 'boolean', desc: 'Print the report as JSON.' },
  ],
  examples: [
    'gbrain ingest --file notes/meeting.txt --dry-run',
    'gbrain ingest --stdin --title "Board memo" < memo.txt',
    'gbrain ingest-show <attempt_id>',
  ],
};
