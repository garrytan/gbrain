# The brain store: entity resolver page reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the page reads the entity resolver (`src/core/entities/resolve.ts`) ran through `executeRaw`. PGLite and
Postgres run the SQL in `src/core/engine-sql/entity-reads.ts`, with the text the resolver sent. The store answers from
its page records (`crates/gbrain-store/src/cli_reads/resolve_reads.rs`) and has no keys of its own.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readLiveSlugs(sourceId, slugs, limit)` | the slugs among `slugs` at which a live page of the source sits, retired or not, each once, in list order (the SQL sets none); a `limit` stops at that many | `readLiveSlugs` |
| `brain.readLivePageTypes(sourceId, slugs, policy)` | `{ slug, type }` for each live page of the source among `slugs`, retired or not, that the page policy (when given) does not hide, each once, in list order | `readLivePageTypes` |
| `brain.readTrigramCandidates(sourceId, arm, titleLc, slugFragment, policy)` | `{ slug, title, type }` for the live, non-retired pages of the source whose lowered title is trigram-similar to `titleLc` or whose slug contains `slugFragment`, best similarity first, then by slug; five rows for `same_name` and `fuzzy`, twenty for `near`; only `fuzzy` adds `score` | `readTrigramCandidates` |
| `brain.readPrefixCandidates(sourceId, patterns, limit)` | `{ slug, connection_count }` for the live, non-retired pages of the source whose slug matches any LIKE pattern, most connected first (inbound plus outbound ranking links plus content chunks), then by slug, at most `limit` (ten for a pattern list, five for one pattern) | `readPrefixCandidates` |
| `brain.readPrefixDirs(sourceId, patterns)` | the distinct first slug segments (`split_part(slug, '/', 1)`) of the live, non-retired pages of the source whose slug matches any LIKE pattern, at most two (the SQL sets no order; the store answers in byte order) | `readPrefixDirs` |
| `brain.readPrefixTitleMatches(sourceId, patterns, title)` | `{ slug, title }` for the live, non-retired pages of the source whose slug matches any LIKE pattern and whose lowered title equals the lowered `title`, at most three (the SQL sets no order) | `readPrefixTitleMatches` |
| `brain.readNamedEntitySlugs(sourceId, slugs, policy)` | the slugs of the live, non-retired pages among `slugs` in the source that the page policy (when not `null`) does not hide, by slug bytes, at most five | `readNamedEntitySlugs` |

## Rules the store keeps from the SQL

- **Soft delete.** Every read answers live pages only (`deleted_at IS NULL`).
- **Source.** Every read takes one source.
- **Privacy.** `readLivePageTypes` and the `same_name` and `near` arms of `readTrigramCandidates` take the page policy of `facts/privacy.rs` that the TypeScript side derives from the
  resolver privacy; a read floor it cannot map to a store policy refuses typed before the call.
- **Similarity.** `lower(title) % $2` is the pg_trgm similarity (f32) against the 0.3 threshold, and
  `slug ILIKE '%' || $3 || '%'` keeps `%` and `_` in the fragment as wildcards. The rank is the larger of the title and
  slug similarities as a `real`, and `score` is that `real` as JavaScript reads it.
- **Retired pages.** `readTrigramCandidates`, `readPrefixCandidates`, `readPrefixDirs`, `readPrefixTitleMatches` and `readNamedEntitySlugs` skip retired pages (`retiredPageSql`): canonical false or no, a
  `superseded_by` or `merged_into` value, or an alias or redirect status.
- **Connection count.** A link counts when it may feed a ranking signal (`rankingLinkSql`: not an `amends` link), once
  inbound and once outbound, whatever the state of the page at its other end; every content chunk of the page counts.
- **Each page once.** `slug = ANY(...)` is a filter, so a slug listed twice answers once.
