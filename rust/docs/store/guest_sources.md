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
| `brain.hasGuestSourceRow(sourceId)` | whether the source has a row; a source whose config alone says guest has none | `hasGuestSourceRow` |

The row is also read by:

- The reads that ask whether a source is a guest source (`guestSourceSql`: the config says guest, or the source has a
  row): `listGuestSourceIds`, `hasGuestSource`, the `guest` flag of `readPageTrustRows` and `readSharedSourceRows`, and the
  guest skip of extraction (`extraction.rs` `guest_sources`).
- Page admission (`readAdmissionSource`), which joins the row's writers and ceiling as the SQL engines do.
- The source writers: a source with a row takes no local path (`upsert_source`, `attach_source_path`;
  `guest_source_database_only`, the guard trigger on `sources`).
- The trust stamp's guest-source rules ([trust.md](trust.md)): a page in a guest source is created or has a content column
  other than `deleted_at` changed only by a principal on the row's writers (`source_writer_restricted`), and only as a
  guest note, `gbrain.guest_note` equal to `gbrain.write_request` (`guest_attribution_missing`). A `putPage` of an existing
  page is checked as the insert attempt first, as the trigger fires `BEFORE INSERT` on `INSERT ... ON CONFLICT`. Every
  stamped page tier is capped at the row's ceiling. A fact, take or timeline row in a guest source is refused on insert and
  on a content change (`guest_page_immutable`). Each refusal is the store code `guest_source_guard:<table>` with the
  trigger's message; rust-engine/store-errors.ts gives it SQLSTATE `P0001` and constraint `guest_source_guard`.
- The seed: `guest_sources` rows are copied after the pages (seed/privacy.rs), so the seed's own page rows are not refused.

Not reachable: the fail-closed refusal of a role that row-level security keeps from reading `guest_sources`
(`writer_coordinator_required`). The store has no row-level security.

`initGuestSource` runs its steps inside `engine.transaction`; the Rust engine serves transactions, so the steps commit
together there too.
