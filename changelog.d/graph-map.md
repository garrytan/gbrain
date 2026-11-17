**`foresights graph-map` shows a brain as one graph of pages and concepts, with every link labelled by where it came from, clusters across the whole source, and a self-contained HTML map.**

### Added
- `foresights graph-map` prints the source's nodes, its links by evidence (stated, inferred, tool output), its largest clusters and how many pages reach a concept so far. `foresights graph-map clusters` lists every cluster with its best-connected members. `foresights graph-map export --out map.html` writes one HTML file with no network requests: pan, zoom, search, and switch link kinds and concepts on and off. Concept pages built by the dream cycle are joined straight to the pages they come from. Private and deleted pages, and any link touching them, never appear. No AI calls. See [the graph map](docs/guides/graph-map.md).

<!-- behavior-change: graph_map -->
