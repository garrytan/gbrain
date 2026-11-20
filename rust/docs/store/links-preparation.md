# The brain store: Link preparation reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Saving a page prepares its automatic links first (`src/core/persistence/links-preparation.ts`). That step made three reads through `executeRaw`; they are now typed members (`src/core/engine-sql/links-preparation.ts`), so a Rust brain can save a page that holds a `[[wikilink]]`. The family keeps no records of its own: it reads the page rows (`keys::PAGE`) and the slug alias rows (`keys::ALIAS`, [aliases.md](aliases.md)).

| Method | Returns | Mirrors |
| --- | --- | --- |
| `brain.readLiveSlugAliases(sourceId, targets)` | `[{ alias_slug, canonical_slug }]`, one per distinct target that is an alias slug of the source, in target byte order | the `slug_aliases` read: no page of the source that is not soft-deleted sits at the alias slug, and one does at the canonical slug |
| `brain.probeSourceSlugFingerprint(sourceId, afterId)` | `{ n, h, m, added, added_h }` | the incremental probe: the source's fingerprint, with the slugs of the pages whose id is above `afterId` and their hash sum |
| `brain.readSourceSlugFingerprint(sourceId)` | `{ n, h, m, slugs }` | the full read: the fingerprint with every slug |

Rules:

- Live in `readLiveSlugAliases` means `deleted_at IS NULL` only, as the SQL tests it. A quarantined page counts as live there; the live tests of [aliases.md](aliases.md) (`aliasCanonicalRefs`) also exclude quarantined pages and archived sources, and this read does not.
- The fingerprint counts every page row of the source, a soft-deleted page too, with no live filter, as the SQL does and as `getAllSlugs` lists. `n` is the row count, `m` the highest page id (0 when the source has no page) and `h` the sum of `hashtextextended(slug, 0)` as a decimal string. The sum is exact: PostgreSQL's `sum(bigint)` is a `numeric`, and the store adds in 128 bits.
- `hashtextextended` is PostgreSQL's `hash_any_extended` (lookup3) with seed 0 over the slug's UTF-8 bytes, ported in `links_preparation.rs`. Its unit test pins 23 values read from PostgreSQL 16 on a UTF8 database: every tail length from 0 to 11 bytes, the 12-byte block edge, several blocks, and multibyte text. A cache of the slug index that one engine built therefore fingerprints the same on another.
- `added`, `slugs` and the alias rows come back in slug byte order. The SQL engines state no order, and the one caller builds a set from them.
- A source or slug holding a NUL byte cannot be part of a key: it names no page and no alias, so the reads return nothing for it (`n` 0).
- A brain with no `slug_aliases` table has no aliases. The SQL engines return that through a missing-table fallback; the store has no table to miss.

Tests: `rust/crates/gbrain-store/tests/links_preparation.rs`, and the parity cases in `test/engine-parity/links-preparation.test.ts` (saving a page with a `[[wikilink]]` to a page, an alias and a missing page) and `test/engine-parity/links-preparation-fingerprint.test.ts` (the fingerprint compared across engines).
