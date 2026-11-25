# The brain store: held-concept rebuild

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A purge that hides a synthesized concept marks it `needs_rederive` at its own delete instant; while that mark is open
and no owner purge is owed on it, the concept is held, and the next synthesis rebuilds it as a new page
(`src/core/persistence/concept-rebuild.ts`). PGLite and Postgres run the rebuild's reads and link carry from
`src/core/engine-sql/concept-rebuild.ts`. The store answers the same members from its page, fact, take, timeline, link,
alias, file, raw-data, write-gate, edge-proposal, identity, secret-store, label-guard, derivation-input, re-derive and
checkpoint records (`crates/gbrain-store/src/concept_rebuild.rs`); it adds no keys.

A held concept is a page with `deleted_at` set, type `concept`, frontmatter `synthesized_by` LIKE `synthesize_concepts%`,
a `needs_rederive` row for it whose `marked_at` is its `deleted_at`, and no `op_checkpoints` parent under the owed-purge op
(`OWED_PURGE_OP`, passed in by the TypeScript member) with its page id. A page id outside `integer` is refused as the
cast refuses it; zero or below names no page. The store runs one write at a time, so the SQL's `FOR UPDATE` and
`FOR SHARE` take no lock here.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readHeldConcept(pageId, owedOp)` | `{ deleted_us }` (the delete instant in microseconds since the epoch, as text) while the page is held, else `null` | `readHeldConcept` |
| `brain.isConceptStillHeld(pageId, deletedUs, owedOp)` | whether the page is held at that delete instant | `isConceptStillHeld` |
| `brain.lockHeldConcept(pageId, sourceId, slug, deletedUs, owedOp)` | whether the page at that source and slug is held at that delete instant | `lockHeldConcept` |
| `brain.lockLiveConceptMembers(sourceId, members)` | how many of `members` (`{ slug, revision }`, repeats counted) are live in the source at that `knowledge_revision` (lowercase text, as `uuid::text`) | `lockLiveConceptMembers` |
| `brain.listLiveConceptMemberRevisions(sourceId, slugs)` | `[{ slug, revision }]`, the live pages among the distinct slugs, in byte order of the slug (PGLite sets no order) | `listLiveConceptMemberRevisions` |
| `brain.listConceptIncomingLinks(pageId)` | the links into the page from other live pages, except `concept-provenance`, as rows in the `links` column names (`created_at` as ISO text, `assertion_tense` `present` when unset), in link id order (PGLite sets no order) | `listConceptIncomingLinks` |
| `brain.carryConceptIncomingLinks(sourceId, slug, incoming, oldId)` | `{ id, carried }`, or `null` when no page is live at the slug (nothing inserted). Inserts each row onto the fresh page (`to_page_id`, and an `origin_page_id` naming `oldId`, become its id); a row equal to a stored link under `links_from_to_type_source_origin_unique` is skipped. A gone from or origin page is `constraint_violation`, as the foreign keys refuse it | `carryConceptIncomingLinks` |
| `brain.readTombstoneWindow(pageId, hours)` | `{ until, past }`: the delete plus `hours`, UTC, to the second, and whether that is at or before now; `null` for a live or missing page. A `hours` that is not finite is `invalid_argument` | `readTombstoneWindow` |
| `brain.readConceptStatedKinds(pageId, sourceId, slug, lists)` | `{ kinds, lead, segmented }`, `STATED_SQL`: the stated kinds in its array order, the bounded body lead (`boundedBodyPrefixSql`) and whether the body is segmented; `lead` and `segmented` are `null` for no page | `readConceptStatedKinds` |
| `brain.readRebuildAccess(pageId, openPolicy)` | `{ open, public_part, readers, page_readers, folder_rule_ids }` for the page row (live or deleted), or `null`. `open` is the no-caller page policy read off `privatePagesFilterFragment('p')`; `public_part` the privacy part with the same alias setting; `readers` and `page_readers` are `gbrain_access_readers(frontmatter)` (null without `readable_by`); `folder_rule_ids` the stamped `source:rule_id` list | `readRebuildAccess` |
| `brain.readHeldConceptRows(owedOp, privateAliases, memberPolicy)` | `[{ id, source_id, slug, private, members_private }]`, every held concept: `private` when its privacy part hides it, `members_private` when a live input page of its derivation fails `memberPolicy` | `readHeldConceptRows` |

## Differences from PGLite

- **Stores the store does not keep.** `core_edit_notices`, `guest_marks` and `guest_promotions` hold no rows here, and a
  page never has a withheld source path, so those stated kinds never apply.
- **Write-gate holds.** A hold here keeps no `page_id` or `page_candidates`, so it reaches the concept by its slug, or
  through the source's slug aliases (alias to canonical) and rename record (old to new), as `holdReachCte` follows them.
- **Order of the held report.** Rows come by source then slug in byte order; Postgres orders them by its database
  collation, which can differ for slugs that differ only in punctuation or case.
