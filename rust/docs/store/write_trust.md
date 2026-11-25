# The brain store: Write trust context

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

PGLite's trust triggers, write attribution triggers and the fence guard's reads take the writer's trust and actor
from nine transaction-local settings, which `src/core/persistence/context.ts` sets with
`set_config(name, value, true)` and reads with `current_setting(name, true)`. The store has no SQL session, so
`gbrain_store::write_trust` holds the same nine settings on the open store. It writes no records and has no keys.

| Setting | Read as | Reader |
| --- | --- | --- |
| `gbrain.write_trust_tier` | the writer's declared tier | the fence reads (`FenceContext::writer`), `trust::stamp` |
| `gbrain.write_origin` | the write origin JSON | `trust::stamp` |
| `gbrain.write_trust_promotion` | the owner-confirmed raise ceiling | `trust::stamp` |
| `gbrain.write_trust_backfill` | `on` turns the backfill rule on | `trust::stamp` |
| `gbrain.write_trust_keep` | the tables whose content changes keep the tier | `trust::stamp` |
| `gbrain.write_open_facts` | the fact ids `gbrain repair open-facts` opens | the fence reads (`FenceContext::opened`) |
| `gbrain.write_request` | the persistence request the write runs for (a UUID) | the timeline write receipt (`WriteAttribution::request_id`); the page, version, fact and take writers check it is a UUID |
| `gbrain.write_principal_kind` | the kind of the writing principal | the timeline write receipt (`WriteAttribution::principal_kind`) |
| `gbrain.write_principal_id` | the id of the writing principal | the timeline write receipt (`WriteAttribution::principal_id`) |

## Methods

- `apply_write_trust(names, values)` (napi `applyWriteTrust`): `applyTransactionSettings` for these names. Sets
  each named setting to the text at its index, all or nothing.
- `read_write_trust(names)` (napi `readWriteTrust`): `readTransactionSettings` for these names. The text each
  setting was last set to, in `names` order; `null` where it was never set, `''` where it was set empty.
- `clear_write_trust()` (napi `clearWriteTrust`): ends the context, as the end of a transaction ends `SET LOCAL`.
  Every setting reads as never set again.
- `fence_context()`: the `FenceContext` the napi `listFenceFactRows` and `listFenceRetireCandidates` pass. An empty
  or unset tier is an undeclared writer (`unknown`). The opened ids are the pieces of the comma list that are the
  canonical text of an id: `f.id::text = ANY(string_to_array(setting, ','))` compares text, so `007`, ` 7` and `x`
  open nothing.
- `write_trust()` (crate-only): the `WriteTrust` that `trust::stamp` takes. `Store::write` opens it as the
  stamp context (`stamp_context::open`) on the bound path and the unbound path, and `pages::write_page` reads it
  with `stamp_context::current()`. A store write with no declared writer stamps `unknown` and no origin. A page write
  with no context open at all (a writer on a bare transaction) refuses with `invalid_argument`, "a page write ran
  outside a store write transaction", as the projection queue's clock read does. Its `attribution` is the
  `WriteAttribution` the row writers stamp: each of the three attribution settings with `''` read as unset
  (`NULLIF(current_setting(name, true), '')`), and the request id in lower case, as a `uuid` reads back.

## Page stamping

Every page write stamps the page's `trust_tier` and `write_origin` the way the PGLite page trigger does
(`trust::stamp`):

- An insert takes the tier of the writer. An undeclared writer stores `unknown` (kept as no tier) and no origin.
- An update starts from the stored tier and origin. The record's own trust fields are ignored, because no store
  writer sets them, so a record read before the write cannot lower the tier.
- An update changes the tier and origin only when the content changes: source, slug, type, kind, title, compiled
  truth, timeline, the deleted time, or the frontmatter without its ephemeral keys (`page_frontmatter_content`). A
  rewrite of only an ephemeral key, such as `captured_at`, keeps both.
- A writer that claims a tier it may not set (for example `user_confirmed`) is refused with
  `trust_raise_refused`, and nothing is written.

- A tag change rewrites the page with a new knowledge revision only, as PGLite's tag trigger runs `UPDATE pages`.
  The content is unchanged, so the tier and origin stay, and a writer that may not declare its tier still refuses,
  as the PGLite page trigger refuses that `UPDATE`.
- A version snapshot copies the page's tier and origin (`snapshot_version_trust`), whatever the snapshot writer
  declares.

`readPageTrustRows` returns the stamped tier and origin ([`cli-reads-import.md`](cli-reads-import.md)), and the
retrieval coverage reads apply a trust floor and the flagged-page filter to them.

## Lifetime

PGLite's settings end with the transaction. Each store has its own context. A store bound to a transaction
(`begin_transaction`, `transactions.rs`) starts with an empty context, and the shared store never sees it, so two
transactions never share one. Once the transactions family lands, the engine's `applyTransactionSettings` and `readTransactionSettings` route these nine
names to the transaction's handle; in this landing the engine serves no transaction, so only the store-level context exists. The transaction clears the context when it ends, at commit and at
rollback, and a savepoint rollback sets the nine back to what they were when the savepoint opened.

## Rust guesses and gaps (1x parity)

- Stricter than PGLite, on purpose. A value the trust rules would refuse when they read it is refused when it is
  set, with `invalid_argument`, and the context is unchanged:
  - a tier or promotion name that is no tier (PGLite accepts it in `set_config`, raises `22023` in the stamp
    trigger, and ranks it 0 in the fence read);
  - a `write_origin` that is not JSON (PGLite raises at the trigger's `::jsonb` cast);
  - a setting name outside the nine (the engine routes no other name here);
  - lists of different lengths.
  TypeScript sets none of these.
- A `write_request` that is not a UUID is kept as set, as `set_config` keeps it. A page, page version, fact, take or
  timeline write then refuses with `invalid_argument` and writes nothing, as PGLite's attribution triggers raise at
  their `::uuid` cast on those tables (`WriteAttribution::refuse_request_not_uuid`).
- The page, page version, fact, take and timeline writers all stamp a write receipt from the attribution settings
  ([write_attribution.md](write_attribution.md)). A trust proposal the store files still reads
  `proposer_principal_kind`, `proposer_principal_id` and `write_request_id` NULL ([trust.md](trust.md#trust-proposals-trustproposals)).
