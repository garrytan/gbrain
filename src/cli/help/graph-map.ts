/** D3 curated help for `foresights graph-map` (flags read by src/commands/graph-map.ts runGraphMap). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'See the brain as one graph of pages and concepts: links labelled stated, inferred or tool output, clusters, and a self-contained HTML map.',
  usage: 'foresights graph-map [show | clusters | export] [--out <file.html>] [--max-nodes <n>] [--limit <n>] [--source <id>] [--json]',
  flags: [
    { name: '--source', type: 'string', desc: 'The source (default: the current source).' },
    { name: '--out', type: 'string', desc: 'With export: the HTML file to write (default graph-map-<source>.html in this folder).' },
    { name: '--max-nodes', type: 'string', desc: 'With export: keep the n best-connected nodes (default 3000).' },
    { name: '--limit', type: 'string', desc: 'With clusters: how many clusters to list (default 20).' },
    { name: '--json', type: 'boolean', desc: 'One JSON document on stdout.' },
  ],
  examples: [
    'foresights graph-map',
    'foresights graph-map clusters --limit 10',
    'foresights graph-map export --out ~/brain-map.html',
  ],
};
