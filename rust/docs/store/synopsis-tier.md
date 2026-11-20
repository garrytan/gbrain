# The brain store: Synopsis tier

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The configuration read of the per-chunk synopsis tier (`src/core/synopsis-sweep.ts` readSynopsisTierConfig, reached by
`gbrain doctor` and `gbrain search modes`). The TypeScript statement is in `src/core/engine-sql/synopsis-tier.ts`; the
store module is `rust/crates/gbrain-store/src/synopsis_tier.rs`; the addon method is in
`rust/crates/gbrain-napi/src/families/synopsis_tier.rs`.

Keys: none of its own. The read scans the core page rows (`all_pages`), the source rows (`all_sources`) and the source
modes (`source_cr_mode.rs`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readSynopsisTierSources({ skipFrontmatter })` | `{ sourceIds, frontmatterPicks }`. `sourceIds` lists the sources that are not archived and whose own mode ([source-cr-mode.md](source-cr-mode.md)) is `per_chunk_synopsis`, by id in byte order. `frontmatterPicks` is false when `skipFrontmatter` is true; otherwise it is true when a live markdown page (no `deleted_at`, `page_kind` markdown) whose source is not archived (a page with no source row counts as not archived) has the frontmatter string `contextual_retrieval: per_chunk_synopsis` and is on the `default` source. The store keeps no `trust_frontmatter_overrides`, so no other source's frontmatter is trusted | `readSynopsisTierSources` |

The SQL engines order the source ids by bytes (`COLLATE "C"`), so a hyphenated id sorts the same on a Postgres
database with a linguistic collation as on PGLite.
