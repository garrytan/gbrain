# The brain store: Guest sources

Part of the store contract in [rust/README.md](../README.md) ("The brain store"): the rules there apply to every method here.

These were statements `gbrain guests init` and `promote_guest_note` ran through `executeRaw` on the `guest_sources` table
(`src/core/guests/schema.ts`). The TypeScript statements are in `src/core/engine-sql/collate-guest-sources.ts`; the store
module is `rust/crates/gbrain-store/src/guest_sources.rs`.

Keys: `keys::GUEST_SOURCE` (`0`, a digit because every letter tag is taken), then the source id, holds the source's one row as
JSON `{writers, trust_ceiling}`. A BTree scan of the tag is the source ids in byte order. A source delete removes its row
(`cascade::remove_source_rows`, the table's `ON DELETE CASCADE`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.upsertGuestSource(sourceId, writers, trustCeiling)` | `{source_id, writers, trust_ceiling}` after the write. With no row yet, the row stores the writers as passed (the caller sorts and de-duplicates them) and the ceiling. With a row, the writers become the union of the stored and the passed ones, each once, in byte order, and the stored ceiling stays. The source must exist, have no `local_path` (`guest_source_database_only`) and the ceiling must be one of the six tiers; each refusal is `constraint_violation`. Text holding a NUL byte is `invalid_argument` | `upsertGuestSource` |
| `brain.listGuestNotes(slug, guestSource)` | `{id, source_id}` of the live page at `slug` in each source that has a row (only `guestSource` when it is not null), by source id in byte order. A soft-deleted page is not listed | `listGuestNotes` |
| `brain.readGuestSourceRow(sourceId)` | the row `upsertGuestSource` wrote: `{hidden: false, source_id, writers, trust_ceiling}`, or the nulls when the source has none ([cli-reads-import.md](cli-reads-import.md)) | `readGuestSourceRow` |

Not modelled: the trust trigger that reads the row on a SQL engine. The store keeps the row for the members that read it and
stamps page trust as it did before ([trust.md](trust.md)).

`initGuestSource` runs its steps inside `engine.transaction` on a SQL engine. The Rust engine serves no transaction, so the
caller runs the same typed steps one after another, each atomic on its own. A page that lands in the source between the
page count and the guest write is not excluded there.
