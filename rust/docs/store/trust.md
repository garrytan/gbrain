# The brain store: Trust

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The trust family owns the trust tier and write origin of pages, facts, takes and timeline entries, fact
withdrawals, the write gate (holds and receipts), trust review and the belief ledger. Its records start with
`keys::TRUST` (`t`); the key layout of each record is listed in its section below.

## The tier stamp (`trust::stamp`)

`crate::trust::stamp(ctx, table, row)` (crate-only) applies the rules of PGLite's `gbrain_stamp_trust_tier` BEFORE ROW
trigger (src/core/trust/schema.ts) to one row and returns the tier and origin to store. It reads and writes
nothing. The writer of the row calls it; the write context (`WriteTrust`) belongs to the caller, as PGLite's
transaction-local `gbrain.write_trust_tier`, `gbrain.write_origin`, `gbrain.write_trust_promotion`,
`gbrain.write_trust_backfill` and `gbrain.write_trust_keep` settings do.

| Case | PGLite trigger | `stamp` |
| --- | --- | --- |
| Writer above `operator_curated`, no covering promotion | raises `trust_raise_refused:` | `Err` code `trust_raise_refused` |
| INSERT | tier := writer or `unknown`, origin := setting | `Stamped { tier, origin: Set(origin) }` |
| INSERT under backfill | keeps the supplied tier; refuses one above `operator_curated` without promotion | `origin: Keep` |
| UPDATE raising the tier, promotion covers it | keeps the raise, stops | `origin: Keep` |
| UPDATE raising `unknown` under backfill, not to `user_confirmed` | keeps the raise, stops | `origin: Keep` |
| UPDATE raising the tier, no writer | raises `trust_raise_refused:` | `Err` |
| UPDATE raising the tier, a writer | clamps to the old tier, goes on | same |
| UPDATE changing content, table not kept | owner writer stamps its tier; a lower writer takes min(old, writer); a lowering in the same write also counts; origin replaced unless the write set it | same; `origin_set` tells `stamp` the write set it |

`TrustTier::from_setting` reads a setting as PGLite does: empty or absent is no tier, other text that names no
tier is refused with `invalid_argument` ("gbrain trust setting names no tier"; PGLite raises SQLSTATE 22023).
`TrustTable::content_columns` is `TRUST_CONTENT_COLUMNS`; a page's frontmatter counts without
`TRUST_EPHEMERAL_FRONTMATTER_KEYS` (`page_frontmatter_content`). `snapshot_version` is
`gbrain_snapshot_version_trust`: a new version row takes the page's tier and origin, and keeps a supplied one
only under backfill.

The caller decides `content_changed` by comparing the content columns of the old and new row; `stamp` does not
see the row.

Rust guesses and gaps (1x parity):

- The guest-source rules of the trigger are not built: `source_writer_restricted`, `guest_attribution_missing`,
  `guest_page_immutable`, the per-source tier ceiling and the `writer_coordinator_required` refusal of a role
  that cannot read `guest_sources`. The Rust store has no `guest_sources` table, so every source reads as a
  non-guest source.
- A refusal carries the trigger's message without the `trust_raise_refused: ` prefix (the code holds it) and
  without the trigger's DETAIL JSON (`op`, `writer`, `from`, `to`, `backfill`).
- A stored tier that names no tier reads as `unknown` (`TrustTier::stored`, as `storedTrustTier`); PGLite's
  trigger ranks such text 0, below `external_untrusted`. The Rust store never stores such text.
- A non-object frontmatter cannot occur: the Rust page record holds a JSON object.
