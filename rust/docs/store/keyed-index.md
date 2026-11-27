# The brain store: Keyed lookups

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Store format 9 keeps a few small indexes beside the records, so these members look their rows up by key instead of
reading every page, chunk, link or link transition record (`crates/gbrain-store/src/keyed_index.rs`, two-byte tag `~k`). The answers do not
change: each member reads the records an index names and applies its own test to them, then sorts as before.

| Kind | Entry | Derived from | Read by |
|---|---|---|---|
| `0x01` | chunk id, page id, chunk index | each chunk record (`K page_id index`), by its `id` | `cosinesByChunkIds`, `getEmbeddingsByChunkIds` |
| `0x02` | lower-cased title, NUL, page id | each page record: `title.to_lowercase()` and `pg_lower(title)`, each when at most 512 bytes | `findPagesByTitles`, `listPagesTitledIn` |
| `0x03` | page id | each page record whose text projection is not served (`served` in `link_queries/retrieval_coverage.rs`) | `readProjectionReadiness` |
| `0x04` | from page id, link id | each link record (`L from link`) with `link_type = 'supersedes'` | `hasSupersedeEdges` |
| `0x05` | h(source, content hash), page id | each page record with a content hash | `findDuplicatePage`, `findDuplicatePages` |
| `0x06` | h(source, frontmatter `id`), page id | each page record whose frontmatter `id` is not null | `findDuplicatePage`, `findDuplicatePages` |
| `0x07` | h(lower-cased title), page id | the `0x02` titles longer than 512 bytes | `findPagesByTitles`, `listPagesTitledIn` |
| `0x08` | origin page id, the transition's record key | each link transition record (`q source NUL T ...`, as `link_temporal.rs` `scan_tag` picks them) with an origin page | `applyLinkTemporalRows` (the page's own transitions it replaces), `linkRelationshipKeysForOrigin` |

`h` is the first 16 bytes of the SHA-256 of the parts joined by NUL. Every value is empty. Soft-deleted pages keep
their entries; the members filter them as before.

## How the entries stay right

- Every entry is a pure function of one record, and its key holds that record's identity (page id, chunk key, link
  key or transition key), so no two records derive the same entry.
- `KeyedWriter` wraps every `Store::write` handle (the write chain in `lib.rs`, inside the keyword and flagging
  writers). For each page, chunk, link or transition key a statement puts or deletes, it remembers the entries the record derived
  before the statement's first write of that key and the entries its last value derives. At the end of the statement
  it deletes and puts only the difference, in the same statement, so the entries commit or roll back with the records.
  A savepoint rollback drops both; an OCC rerun starts a fresh writer.
- Store format 9's upgrade (`upgrade_format`) builds every entry from the records in the upgrade's one write
  transaction. A build without the lookups refuses a format-9 brain, as its writes would leave them stale.
- An entry is only a candidate: `hasSupersedeEdges` reads the link record back, the page reads read the page record
  through its id, and each member applies its full test. A stale entry could add no row; a missing one would drop a
  row, which `keyed_index/tests.rs` guards against by checking the entries against what the records derive after every
  write of a random workload (and under concurrent writers and rollbacks).

## The substring read

`listPagesTitledIn` keeps pages whose `pg_lower(title)` (three characters or more) is a substring of the query. For
each character position of the query, the titles that are prefixes of the rest of the query sort between the raw
entry of its first three characters and the end of the entries that start with the whole rest, so the read walks only
that range of keys and reads the pages whose title bytes match. A query that holds a NUL or is longer than 512 bytes
reads every page, as before.

## Tests

`keyed_index/tests.rs` runs a seeded workload of page puts, chunk writes, links, soft and hard deletes, restores and
renames. After every write the stored entries equal the entries the records derive, and every 25 writes each member
above answers exactly as the whole-store scan it replaced (a test switch, `FULL_SCAN`, turns the lookups off for the
comparison). It also covers savepoint and transaction rollback, four concurrent writers, the rebuild, and a format-8
brain that opens and gets its entries.
