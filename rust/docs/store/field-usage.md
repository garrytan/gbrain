# The brain store: Field usage

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The page sample read of `gbrain schema detect --fields` (`src/core/schema-pack/field-usage.ts` runFieldUsage). The
TypeScript statements are in `src/core/engine-sql/field-usage.ts`; the store module is
`rust/crates/gbrain-store/src/field_usage.rs`; the addon method is in `rust/crates/gbrain-napi/src/families/field_usage.rs`.

Keys: none of its own. The read scans the core page rows once. It decodes only a page's id, source,
type and deletion stamp to count it, and decodes the whole record only for a page that enters a
type's sample. Memory holds at most `samplePerType` sampled pages per type, and no page body when
`countsOnly` is set.

Two behaviours are kept as the PGLite read has them (TODOS.md): the read does not look at `sources`, so pages of an
archived source count and are sampled; and a segmented page (NULL compiled_truth) samples a null body, which the
caller reads as empty.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readFieldUsageSamples({ sourceId?, maxTypes, samplePerType, type?, countsOnly? })` | one `{ type, pages, rows }` per page type over the live pages (no `deleted_at`) with a non-empty type, of `sourceId` or of every source when it is absent or empty. Types come most pages first, ties in byte order (`COLLATE "C"`), at most `maxTypes` (floored; 0 or less gives none). `rows` holds `{ frontmatter, compiled_truth }` of at most `samplePerType` pages (floored, at least 1) in page id order; `compiled_truth` is null for a segmented page. `type` keeps only that page type; `countsOnly` returns every `rows` empty and reads no sample. No page id is returned | `readFieldUsageSamples` |
