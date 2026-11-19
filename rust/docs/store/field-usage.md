# The brain store: Field usage

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The page sample read of `gbrain schema detect --fields` (`src/core/schema-pack/field-usage.ts` runFieldUsage). The
TypeScript statements are in `src/core/engine-sql/field-usage.ts`; the store module is
`rust/crates/gbrain-store/src/field_usage.rs`; the addon method is in `rust/crates/gbrain-napi/src/families/field_usage.rs`.

Keys: none of its own. The read scans the core page rows (`all_pages`).

Two behaviours are kept as the PGLite read has them (TODOS.md): the read does not look at `sources`, so pages of an
archived source count and are sampled; and a segmented page (NULL compiled_truth) samples a null body, which the
caller reads as empty.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readFieldUsageSamples({ sourceId?, maxTypes, samplePerType })` | one `{ type, pages, rows }` per page type over the live pages (no `deleted_at`) with a non-empty type, of `sourceId` or of every source when it is absent or empty. Types come most pages first, ties in byte order (`COLLATE "C"`), at most `maxTypes` (floored; 0 or less gives none). `rows` holds `{ frontmatter, compiled_truth }` of at most `samplePerType` pages (floored, at least 1) in page id order; `compiled_truth` is null for a segmented page. No page id is returned | `readFieldUsageSamples` |
