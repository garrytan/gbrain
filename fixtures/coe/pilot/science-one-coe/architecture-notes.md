# ScienceOne CoE Lite — internal architecture note

Classification: `derived_internal`. This note is an implementation aid, not primary evidence for claims about ScientistOne.

The Phase 2 pilot maps the public material to four registry properties:

- a logical source is distinct from each immutable byte-level snapshot;
- HTML and PDF are separate representations even when they describe one paper;
- lifecycle changes are append-only events while raw bytes and canonical records remain unchanged;
- PostgreSQL and PGLite tables are rebuildable projections, not the system of record.

The bounded official-source set is the versioned arXiv HTML and PDF, the project page linked by arXiv, and the commit-addressed Git tree (`721f1fbe3b39a558dff13386c50621a357e6f9a7`) of the generated-artifacts repository linked by that project page. The tree inventories every published path and blob identity without relying on GitHub's byte-unstable landing HTML. Secondary summaries are intentionally excluded.

Exact-title discovery on 2026-08-04 did not yield an independently addressable ScientistOne article or publication record on `research.google`. No Google Research URL is invented or treated as acquired; such a source can be added only after it is directly verified.
