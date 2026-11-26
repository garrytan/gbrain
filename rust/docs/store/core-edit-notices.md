# Core edit notices

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A core page is a page the owner keeps in the always-loaded core memory. When a remote principal edits one with
`memory.core.remote_edit` set to `notify` (the default), the edit commits and the core guard files a **core edit
notice**: one row that says "this actor changed this page; the owner has not looked yet". The notice holds the page's text
from before the edit, so `gbrain core diff` can show what changed. `gbrain core ack` closes notices, `gbrain core remove`
closes them when it takes the page out of core, and the doctor, `gbrain core status` and the core block list the pages that
still have an unacknowledged one.

The Rust store keeps this table (`core_edit_notices`, src/core/core-memory-schema.ts, migration v213) as a family of its own,
so a Rust brain answers all of it as PGLite and Postgres do.

Files: `gbrain-store/src/core_edit_notices.rs`, `gbrain-napi/src/families/core_edit_notices.rs`. Cargo tests:
`gbrain-store/tests/core_edit_notices.rs` (every member and every scrub), the unit tests in `core_edit_notices.rs`, and the seed
tests (`seed/history/tests.rs`, `seed/follow/tests.rs`). Parity: `test/engine-parity/core-page-member-reads.test.ts`.

## The table

```sql
CREATE TABLE core_edit_notices (
  id BIGSERIAL PRIMARY KEY, source_id TEXT NOT NULL, slug TEXT NOT NULL, page_id BIGINT, revision TEXT,
  base_revision TEXT, base_text TEXT, actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at TIMESTAMPTZ
);
CREATE INDEX core_edit_notices_pending_idx ON core_edit_notices (source_id, slug, id) WHERE acked_at IS NULL;
```

There is no foreign key. A notice names its source and page by text, outlives a rename, and goes away only when the page is
purged or hard-deleted, or when its source is removed. The store therefore never checks that a source or page exists when a
notice is written, copied or read.

## Keys (tag `2`, `keys::CORE_EDIT_NOTICE`)

The digit `2` was the dropped `embedding_holds` family's tag; no store holds a record under it, and the tag registry
(docs/designs/RUST_ENGINE_INTERFACES.md) lists it for this family. A text part of a key ends with a NUL byte, and no text
column may hold one (a NUL in any text is `invalid_argument`, as Postgres refuses it). Ids are 8 big-endian bytes.

| Key | Value | Plays |
| --- | --- | --- |
| `2 0x01 <id>` | the row: source, slug, page id, revision, base revision, base text, actor, `created_at` and `acked_at` as microseconds | the table, by `id` |
| `2 0x02 <source> \0 <slug> \0 <id>` | `0x01` for a pending notice, `0x00` for an acknowledged one | `core_edit_notices_pending_idx`, and the page's acknowledged rows |
| `M next_core_edit_notices_id` | the next id, 8 big-endian bytes | the `BIGSERIAL` sequence |

The index has an entry for every row. Reading a page's entries in key order reads its rows in id order, and the flag says
which are pending, so the list opens only the rows it returns (at most 50) and the oldest-pending read opens one. Every write goes
through one function (`put_notice`) that stores the row and its entry together, so the flag always agrees with `acked_at`.
An id is never reused: the counter only goes up, also after a delete.

Byte order of the index is the order the SQL asks for: `ORDER BY source_id COLLATE "C", slug COLLATE "C"`. A source or slug
that is a prefix of another sorts first, because the NUL that ends its part sorts below every other byte.

Format. The family writes nothing until a notice is filed, and an older build ignores tag `2`. Format 15 is allotted to this
family so that an older build refuses a brain that holds notices ([format.md](format.md), row 15, `reserved`); `FORMAT_VERSION`
is not changed here, and the step that ships 15 only moves the number (it creates nothing and rewrites nothing).

## Members

Each is one store call: a write is one write transaction, a read is one read. In the addon all are `Brain` methods and resolve
plain JSON; ids are JavaScript numbers.

| Member | Arguments | Resolves | The SQL it mirrors |
| --- | --- | --- | --- |
| `insertCoreEditNotice(input)` | `{ sourceId, slug, pageId: number \| null, revision: string \| null, baseRevision: string \| null, baseText: string \| null, actor }` (the four nullable fields may be missing) | the new id | `INSERT INTO core_edit_notices (source_id, slug, page_id, revision, base_revision, base_text, actor) VALUES ($1..$7)` of `record()`, src/core/persistence/core-guard.ts. `created_at` is the store clock (`now()`), `acked_at` is NULL. An unknown field is `invalid_argument`. |
| `listPendingCoreEditNotices(sourceIds)` | `string[] \| null` | `[{ source_id, slug, revision, actor, created_at }]` | `SELECT DISTINCT ON (source_id COLLATE "C", slug COLLATE "C") source_id, slug, revision, actor, created_at::text FROM core_edit_notices WHERE acked_at IS NULL [AND source_id = ANY($1)] ORDER BY source_id COLLATE "C", slug COLLATE "C", id DESC LIMIT 50` (`listPendingCoreEditNotices`, src/core/engine-sql/trust-tier-reads.ts). One row per page: its newest pending notice. A page whose notices are all acknowledged has none. An empty list matches no source; `null` reads every source. |
| `readOldestPendingCoreEditNotice(sourceId, slug)` | | `{ base_text, actor, created_at }` or `null` | `SELECT base_text, actor, created_at::text FROM core_edit_notices WHERE source_id = $1 AND slug = $2 AND acked_at IS NULL ORDER BY id LIMIT 1` (`core diff`, src/commands/core.ts). |
| `findCoreEditNoticeIdByRevision(sourceId, slug, revision)` | | the id or `null` | `SELECT id FROM core_edit_notices WHERE source_id = $1 AND slug = $2 AND revision = $3 ORDER BY id DESC LIMIT 1` (`core ack --revision`). It reads acknowledged rows too; a notice with no revision matches nothing. |
| `ackCoreEditNotices(sourceId, slug, maxId)` | `maxId: number \| null` | how many were closed | `UPDATE core_edit_notices SET acked_at = now() WHERE source_id = $1 AND slug = $2 AND acked_at IS NULL [AND id <= $3]` (`core ack`, and the close of `core remove`). Closed rows are not counted again; a `maxId` below every id closes none. |
| `blankPurgeCoreEditNotices(sourceId, loweredFact)` | | how many were blanked | `UPDATE core_edit_notices SET base_text = NULL WHERE source_id = $1 AND strpos(lower(base_text), $2) > 0 RETURNING 1` (`blankPurgeCoreEditNotices`, src/core/engine-sql/facts-purge.ts). `lower` is the PGLite table (`pg_lower`), not Rust's: `İ` lowers to `i`. A NULL base text never matches; an empty fact matches every non-NULL base text. The needle is matched as given: the caller lowers it. The notice stays open. |

`created_at` prints as `timestamptz::text` with the session time zone UTC (`2026-11-26 10:00:00.123456+00`, trailing zeros of
the fraction dropped), through `cli_reads::pg_text::timestamptz_text`.

## Paths that read or scrub the family

| Path | What it does with the notices | The SQL it mirrors |
| --- | --- | --- |
| Page purge sweep, `deletePurgedSlugStoreRows` (`facts/page_purge_sweep.rs`) | deletes the notices of the source on each slug, acknowledged ones too, and reports the count under `removed.core_edit_notices` (0 when there are none) | `DELETE FROM core_edit_notices WHERE source_id = $1 AND slug = ANY($2) RETURNING 1` (src/core/engine-sql/purge-slug-stores.ts) |
| Hard page delete (`deletePages`, `purgeDeletedPages`; `page_ops.rs`) | the same scrub, between the open loops and the aliases, as `scrubPurgedSlugStores` orders it | the same statement |
| Purge store probe `slug_key` (`facts/purge_store_probe.rs`) | counts the notices of the source on the slug, acknowledged ones included, at most `rows + 1` | `SELECT 1 FROM core_edit_notices WHERE source_id = .. AND slug = ..` (`slugKeySelect`, src/core/engine-sql/purge-verify.ts) |
| Purge store probe `claim_text` (`facts/purge_claim_probe.rs`) | counts the notices of the source whose lowered base text holds the claim, at most `rows + 1` | `SELECT 1 FROM core_edit_notices WHERE source_id = .. AND strpos(lower(base_text), claim) > 0` (`claimTextSelect`) |
| Concept rebuild (`concept_rebuild.rs`) | the stated kind `core_edit_notices` applies when any notice, pending or acknowledged, is filed on the page | `SELECT 1 FROM core_edit_notices c WHERE c.source_id = $2 AND c.slug = $3` (`STATED_SQL`, src/core/engine-sql/concept-rebuild.ts) |
| Source delete (`cascade::remove_source_rows`, `sources/archive.rs` rescrub) | deletes every notice of the source | `DELETE FROM core_edit_notices WHERE source_id = $1` (`scrub_core_edit_notices` of `removedSourceScrubCtes`, src/core/engine-sql/sources.ts) |
| Shadow seed and follower (`seed/history.rs`, `seed/follow/*`) | the relation `core_edit_notices` is copied with its ids, times and acknowledgement, its digest entries are kept, and the id counter is raised past every copied id | see [seed.md](seed.md) |
| Snapshot and verify (`snapshot.rs`, `verify.rs`) | tag `2` is copied and digested like every tag; a seeded store also lists the relation digest | see [snapshot.md](snapshot.md) |

The seed copies a row as it is: an id the store already holds is skipped, never overwritten, and a notice for a source that is
not stored is copied (there is no foreign key). The follower's remove deletes the row and its index entry together, by id.

## What stays different from the SQL engines

- Row-level security does not apply: the store has one writer and no roles.
- `created_at` of a notice written through `insertCoreEditNotice` is the store clock at the call (microseconds); on Postgres it
  is `now()` of the transaction. The two agree to the precision a person reads; a test must not compare them to the
  microsecond.
- The list reads at most 50 pages after reading every index entry of the pages before them, so a brain with very many
  acknowledged notices on the first pages in byte order reads those entries (not their rows) before it finds 50 pending pages.
