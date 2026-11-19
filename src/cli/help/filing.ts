/** D3 curated help for `foresights filing` (flags read by src/commands/filing.ts runFiling). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'Choose how a source files NEW pages (generic, para, lyt or zettelkasten) and ask where a new page goes; existing pages never move.',
  usage: 'foresights filing [show | set <generic|para|lyt|zettelkasten> | route <type> <title>] [--project <name>] [--area <name>] [--archived] [--source <id>] [--json]',
  flags: [
    { name: '--source', type: 'string', desc: 'The source (default: default).' },
    { name: '--project', type: 'string', desc: 'With route under para: the project the page serves (projects/<project>/).' },
    { name: '--area', type: 'string', desc: 'With route under para: the ongoing area it belongs to (areas/<area>/).' },
    { name: '--archived', type: 'boolean', desc: 'With route under para: the page is finished or inactive (archives/).' },
    { name: '--json', type: 'boolean', desc: 'One JSON document on stdout.' },
  ],
  examples: [
    'foresights filing',
    'foresights filing set para',
    'foresights filing route concept "Flywheel effect" --project launch',
    'foresights filing route note "Pricing idea" --source notes --json',
  ],
};
