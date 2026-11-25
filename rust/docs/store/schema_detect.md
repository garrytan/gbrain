# Schema detect page-shape reads (`schema_detect.rs`)

`gbrain schema detect` (src/core/schema-pack/detect.ts) reads the shape of one source's pages to suggest a schema pack.
The three members are typed engine members with one SQL implementation for PGLite and Postgres
(src/core/engine-sql/schema-detect.ts). The Rust store serves them from `rust/crates/gbrain-store/src/schema_detect.rs`.
They read the page records only; no record of their own is stored.

| Member | Result |
| --- | --- |
| `pageTypeTotals({ sourceId })` | `{ total, typed, untyped }`: the live pages of the source, the ones with a type and the ones with the empty type. |
| `pagePrefixSamples({ sourceId, minPages, limit })` | `[{ prefix, cnt, sample_types }]`: each slug prefix of a live page whose slug holds a `/`, with at least `minPages` pages, at most `limit`. |
| `countPagesByTypeForSource({ sourceId, limit })` | `[{ type, cnt }]`: each type of the live typed pages, at most `limit`. |

- A prefix is the slug up to and including its first `/` when at least one character comes before it
  (`substring(slug from '^[^/]+/')`). A slug that starts with `/` has the null prefix.
- `pages.type` is NOT NULL, so an untyped page has the empty type. `sample_types` holds the distinct non-empty types
  under the prefix.
- Order: counts sort largest first. A tie sorts by the prefix or the type in byte order (`COLLATE "C"`); the null
  prefix sorts last. `sample_types` is in byte order. Postgres in any database locale, PGLite and the store agree.
- Each read scans every page record (the store has no index of pages by source). The read runs once per detect.
