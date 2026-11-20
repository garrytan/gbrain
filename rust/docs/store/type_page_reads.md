# The brain store: Schema-pack page reads that order by byte

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These reads were statements the schema-pack conversions (`page-to-link`, `page-to-alias`, `retype`) ran through `executeRaw`,
ordered by byte (`COLLATE "C"`) so the page a conversion takes first is the same on every engine whatever the database locale
is. The TypeScript statements are in `src/core/engine-sql/collate-type-page-reads.ts`; the store module is
`rust/crates/gbrain-store/src/type_page_reads.rs`.

Keys: this module adds none. Each read scans the page records ([pages.md](pages.md)); text compares in byte order, as a Rust
`String` does. Text holding a NUL byte is `invalid_argument`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listTypePageBodies({type, sourceId?, limit})` | `{slug, compiled_truth, frontmatter}` of the live pages of one type (in one source when `sourceId` is non-empty), ordered by slug in byte order then id, cut at `limit` (a negative `limit` is `invalid_argument`). `compiled_truth` is null on a segmented page | `listTypePageBodies` |
| `brain.listSourceTypePageBodies({type, sourceId, limit})` | the same rows for one source (`sourceId` is required), ordered by slug in byte order | `listSourceTypePageBodies` |
| `brain.countRetypeCandidates({fromType, pathFilter?, slugFilter?, sourceId?})` | how many live pages of `fromType` match the filters: `pathFilter` and `slugFilter` are `LIKE` patterns over `source_path` and `slug` (a page with no `source_path` fails a path filter), `sourceId` is exact; an empty filter is no filter | `countRetypeCandidates` |
| `brain.listRetypeSampleSlugs({fromType, pathFilter?, slugFilter?, sourceId?})` | the slugs of the first ten pages the same filters match, in byte order | `listRetypeSampleSlugs` |
