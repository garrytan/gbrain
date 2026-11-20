# The brain store: page, mention and fact-pool reads by byte order

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`crates/gbrain-store/src/collate_reads.rs` serves nine typed members whose SQL sorts or limits text by byte
(`COLLATE "C"`). The SQL lives in `src/core/engine-sql/collate-page-reads.ts`; the napi family is
`crates/gbrain-napi/src/families/collate_reads.rs`; the TypeScript side is `src/core/rust-engine/store-members/collate-reads.ts`.

| Member | Reads |
| --- | --- |
| `listPageTypePairs` | the distinct `(source, type)` pairs of live pages, by source then type |
| `countPagesWithMentionLinks` | the live pages that have a `mentions` link |
| `listGazetteerSourceIds` | the source ids the gazetteer walks |
| `listGazetteerPages` | live pages of the listed types, with the handle keys read from frontmatter |
| `listGazetteerAliasRows` | the alias rows of those pages |
| `listStaleMentionPages` | the byte-first pages with a `mentions` link, under the limit, by (slug, id) |
| `listStaleMentionLinks` | the `mentions` links of those pages, by byte |
| `listPoolEntityPairs` | the `(source, entity slug)` pairs the fact pool holds, by byte |
| `listPoolUnbackedKeys` | the byte-first pool pairs that have no live page, under the limit |

Rules:

- Rust text orders by byte, as `COLLATE "C"` does. A read that names no order returns rows by `(source, slug)`, the key
  order. The gazetteer and alias SQL keep no `ORDER BY` because the text moved into the typed member unchanged; callers
  sort the rows themselves.
- A page whose body is segmented reads its text through `segmented_reference`, so a mention scan sees the whole body.
- The pool reads apply the pool policy of [facts](facts.md): a candidate `(source, entity slug)` is kept only
  when the entity-arm read of the pool returns a row for it. That is one read per candidate pair. A soft-deleted entity
  page hides its facts from the pool, as on the SQL engines.
- `listPoolUnbackedKeys` also requires the pair to be in the asked keys and to have no live page at `(source, slug)`,
  then applies the limit.
