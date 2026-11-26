# The brain store: write attribution reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the reads of `get_write_attribution` (`src/core/ops/attribution.ts`), which ran eight `executeRaw` statements.
PGLite and Postgres run the same SQL as before, now in `src/core/engine-sql/write-attribution.ts`. The store answers
them from the write receipts its page, version, fact, take and timeline writes stamp
(`crates/gbrain-store/src/write_receipt.rs`) and from its journal records (`crates/gbrain-store/src/write_attribution.rs`).
The TypeScript members are in `src/core/rust-engine/store-members/write-attribution.ts`.

## Receipts the store stamps

Every write in a context that names a principal (`gbrain.write_request`, `gbrain.write_principal_kind`,
`gbrain.write_principal_id`) stamps what PGLite's attribution triggers stamp:

| Row | Stamped | Mirrors |
| --- | --- | --- |
| page | the request and principal of the live revision, kept when a write leaves the revision unchanged | `gbrain_stamp_revision_attribution` |
| version | the receipt of the snapshotted revision (`write_*`) and the actor that archived it (`archived_*`) | `gbrain_stamp_version_attribution` |
| fact, take, timeline entry | the first writer (`write_*`) and the last content writer (`last_write_*`, `last_written_at`) | `gbrain_stamp_write_attribution` |

A request id that is not a UUID refuses the write with `invalid_argument`, as the trigger's `::uuid` cast does.

## Methods

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readWriteRequestAttributions(ids)` | `{ id, operation, completed_at, agent_label }` per journal request whose id is in `ids` | `persistence_write_requests WHERE id = ANY(ids)` |
| `brain.readLocalWriterLanes(ids)` | `{ id, lane }` per local writer whose id is in `ids`, exact match; a revoked writer too | `persistence_local_writers WHERE id = ANY(ids)` (no `revoked_at` filter) |
| `brain.readPageRevisionAttribution(pageId)` | `{ revision, req, kind, pid, trust_tier, write_origin }`, or `null` for an unknown page | `pages WHERE id = $1` |
| `brain.readVersionAttributions([[pageId, id], ...])` | `{ id, w_req, w_kind, w_id, a_req, a_kind, a_id, trust_tier }` per version found under its page; a repeated id once | `page_versions WHERE id = ANY(ids)` |
| `brain.readOldestVersionAttribution(pageId)` | `{ req, kind, pid }` of the oldest snapshot by `(snapshot_at, id)`, or `null` | `ORDER BY snapshot_at, id LIMIT 1` |
| `brain.readRowAttribution(target)` | `{ id, w_*, l_*, created_at, last_written_at, trust_tier, write_origin }`, or `null` | the fact, take or timeline statement |

`readRowAttribution` filters before the pick, as the SQL does:

- A fact must have the id, the source and the slug (`entity_slug` or `source_markdown_slug`). `worldOnly` keeps world
  facts only. `excludePrivate` is the reader's private-provenance policy, which hides a fact whose provenance page is private.
- A take must be on the page at the row number. `holders`, when present, admits only those holders; an empty list admits none.
- A timeline entry must have the id and be on the page.
- A take or timeline entry read under excludePrivate by a caller who is not the owner carries its own owner-only form
  (`ownerOnly`). The closed form hides the row while the brain holds an owner-only source or a mark. The function form
  hides a row only by its own lineage, and the store has none for these rows (no take or timeline marks, no
  `derivation_inputs`). A target that names no form takes the closed form.

A stored tier of none reads `unknown`: the column default of pages, facts, takes and timeline entries, and the tier a
version snapshot copies from a page with no tier.

## TypeScript members

| Member | Answer on this engine | Why |
| --- | --- | --- |
| `readWriteAttributionNames(ids)` | requests and writers from the two methods; clients from `brain.readOauthClientNames` and legacy tokens from `brain.readAccessTokenNames` (a revoked token included) | The names come from the store's `oauth_clients` ([oauth-clients.md](oauth-clients.md)) and `access_tokens` ([access-tokens.md](access-tokens.md)) rows. |
| `readWriteAttributionNames` with an OAuth client id or a legacy token id | refuses with `engine_capability_missing` | The store keeps OAuth clients and access tokens, but this read does not look their names up yet. An empty answer would say "no name" for a client that exists. |
| `readPageRevisionAttribution`, `readOldestVersionAttribution` | the method | |
| `readVersionAttributions(refs)` | the method, each version under its `page_id` | The store keys versions by page. |
| `readRowAttribution(target)` | the method; the fact's `excludePrivate` becomes the store privacy policy | A policy the store cannot judge refuses (`storePrivacyPolicy`). |

## Known gaps

- PGLite's attribution trigger exempts a withdrawal stamp (`gbrain.fact_withdrawal_stamp`) from the content check.
  The store keeps no withdrawal ledger, so it does not model that exemption. It stamps `last_write_*` when the fact's
  content columns change (`WRITE_ATTRIBUTION_CONTENT_COLUMNS.facts`), and no parity case covers a withdrawal.
