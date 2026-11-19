# The graph map: your brain as one picture

`foresights graph-map` shows the pages and concepts in a brain as one graph,
groups them into clusters, and writes a single HTML file you can open in any
browser. It makes no AI calls: it reads links and concepts the brain already
has.

```bash
foresights graph-map                          # counts, links by evidence, largest clusters
foresights graph-map clusters --limit 10      # each cluster and its best-connected members
foresights graph-map export --out map.html    # one self-contained HTML map
```

**Say to your agent:** *"Show me a map of my brain."* (your agent runs `foresights graph-map export`)
**Say to your agent:** *"What are the main clusters in my notes?"* (your agent runs `foresights graph-map clusters`)

## Two levels: pages and concepts

Every page is a node. Concept pages are a second kind of node: the dream
cycle builds them by reading each page (the `extract_atoms` and
`synthesize_concepts` phases, with their own spending limits). Each page is
joined straight to the concepts drawn from it. Concepts appear as each page is
processed, so the map shows partial results as they come in: `show` and the
HTML say how many pages reach a concept so far.

## Every link says where it came from

| Label | Meaning | Drawn as |
|---|---|---|
| stated | Someone wrote it: a markdown or wiki link, a frontmatter field, `add_link` | solid line |
| inferred | The brain worked it out: a mention, a typed-entity link, a concept drawn from the page | dashed line |
| tool output | An outside tool reported it over MCP | dotted line |

The label never hides a link. In the HTML you can switch each kind off with
its checkbox to see what is left.

## Clusters

Clusters are groups of pages that link to each other more than to the rest.
They are found across the whole source, the same graph always gives the same
clusters, and stated links count double. A cluster is named after its
best-connected concept, or its best-connected page when it has none.

## The HTML file

- One file, no network requests: it works offline and can be emailed.
- Drag to pan, scroll to zoom, click a node to see what it links to, search by
  title or slug, and switch link kinds and concepts on and off.
- `--max-nodes` (default 3000) keeps the best-connected nodes on very large brains.

## What it never shows

Private pages (`visibility: private`) and deleted pages are never read, so
neither they nor any link touching them appear in `show`, `clusters` or the
HTML file. `--source` picks the source; without it the current source is used.
