# Ontology store (`ontology.rs`)

Typed entity dimensions (role, location, and so on) over the `facts` table of the PGLite
engine. Each member gives the answer PGLite gives today, odd behavior included.

## Layout

The ontology owns no records. An observation is a `facts` row with `dimension`, `value`,
`value_hash` and `dim_status` set. It is written with the facts row writer and read through
the facts indexes (see [facts.md](facts.md)). The unique stint key
`idx_facts_ontology_stint_dedup` is the facts `F 0x07` entry. No key starts with
`keys::ONTOLOGY` (`N`).

The TypeScript member (`src/core/rust-engine/store-members/ontology.ts`) does the work that
PGLite does in TypeScript: it normalises the dimension, computes the value hash, picks the
status (`quarantined` for a novel dimension), writes the fact text `dimension: value`, applies
the defaults (confidence 0.7, visibility `private`, source `default`) and turns each time into
microsecond ISO text.

## Members

| Member | What it does |
|---|---|
| `mergeOntologyFact` | Finds the current row of the dimension: the newest open, active, non-conversation row (by `valid_from`, then confidence, then id). The same value from a new provenance is stored expired with `consolidated_into` the current row (`corroborated`); a repeat of a seen provenance is a `noop`. A different value is stored live. When it is forward of an active current row, the current row closes at the new `valid_from` (or now) with `superseded_by` the new row (`superseded_prior`); else the result is `inserted`. A dated observation first frees the stint key from conversation-slot rows. A taken stint key is a `noop`. |
| `getOntology` | The best row per dimension as of `asof` (default now): `valid_from <= asof < valid_until`, active unless `includeQuarantined`, at or above `minConfidence` (compared as a 32-bit float, as SQL's `REAL` column is, so a stored 0.7 meets a floor of 0.7), filtered by the visibility list, `excludeDiary` (`life/diary/` sources) and soft-deleted provenance pages. Dimensions come out in byte order. |
| `discoverOntologyDimensions` | Per dimension, the distinct entities and the observation count of open slot rows. Most entities first, then dimension. |
| `findOntologyConflicts` | Open, active slot rows grouped by entity and dimension, kept when they hold two or more distinct values from two or more distinct sources. Values come out in id order. A null entity sorts last. |
| `listOntologyStreamSlugs` | For `belief/writers.ts` `ontologyStreamSlugs`: the distinct non-null `source_markdown_slug` of every open (unexpired, unclosed), non-conversation row of one entity's dimension in one source, in byte order. The dimension comes in normalised. |
| `readOntologyRival` | For `trust/supersede-handlers.ts` `contestOntologySupersession`: `{ id, trust_tier }` of the newest open, active, non-conversation row of one entity's dimension in one source other than `excludeId` (the same order as `mergeOntologyFact`), or null. A non-integer `excludeId` is refused before the store is read. |
| `listBeliefStreamSlugs` | For `belief/writers.ts` `beliefStreamSlugs`: the ledger stream slug of each listed row found, by id, once each: a fact's `source_markdown_slug` else its `entity_slug` (null when it has neither), a take's page slug, a page's own slug (deleted pages included). An unknown or negative id answers nothing; the caller drops invalid slugs, removes repeats and sorts. |

`sourceIds` scopes every read to a list of sources; with neither `sourceIds` nor `sourceId`
every source is read. An empty `visibility` list matches no rows.

`ONTOLOGY_SUPERSEDE_GUARD` is evaluated: `mergeOntologyFact` closes the current observation only when its trust rank is no higher than
the writer's (an undeclared writer ranks as `unknown`). A lower-trust writer still inserts its observation, but it does not close the
higher-trust row, and the call returns `action: inserted` with `supersededId: null`.

## Known divergences

These do not show in the parity cases. Each is a documented edge, not a normaliser.

- The Rust write is one transaction. In PGLite the stint-key release of a conversation row
  stays when the following INSERT fails.
- The backdated and forward checks compare at milliseconds in PGLite (JavaScript `Date`) and
  at microseconds in Rust.
- PGLite reads naive times in the session time zone. The Rust member assumes UTC.
- Time text outside the ISO forms the member accepts (date, optional `T` or space time,
  up to six fraction digits, `Z` or `+HH[:MM]`) is refused, not parsed by Postgres rules.
- `excludePrivate` on `getOntology` and `findOntologyConflicts` applies the private-provenance
  policy of `facts.md` ("Private-provenance policy"), as `privateFactFilterForReader('facts')`
  does at `src/core/pglite-engine.ts:2225` and `:2269`. A caller with only a reader identity and a
  private-readable grant is served (`callerReaders`): the entity gate reads both; this form has no
  member-page CASE. Any other caller whose policy differs refuses. `requireSafeChunks`, `minTrust`, `suppressFlagged` and
  `takesHoldersAllowList` are ignored: the member does not yet route the trust and suppression reads to this lookup.
- The Rust `now()` is one value per member call. PGLite takes one value per statement.

## Ontology re-key and repair statements (`src/core/engine-sql/ontology-repair.ts`)

Six members for the statements `src/core/facts/ontology-rekey.ts` and `src/core/repair/ontology-facts.ts` ran as raw SQL are
served from `facts/ontology_repair.rs`: `listRekeyLosers`, `repointSupersededToKept`, `clearOntologySlots`,
`deleteRekeyLosers`, `listOntologyFactCandidates` and `restoreOntologyFact`. (`listSourceIncarnations` is the facts-repair
member, `facts/captured.rs`.) Every method takes one JSON object in `camelCase` and refuses an unknown key. The writes
go through the fact writer, so the trust stamp, the purge guard and the unique indexes run.

| Method | Result |
| --- | --- |
| `listRekeyLosers` `{ sourceId, where, entity, sms, params }` | `[{ id, keep }]` by id: of each set of rows that would share `(entity, page, dimension, value_hash, valid_from)` once the move applies (the moving rows plus the rows already at the target key), every row but the survivor. The survivor is the one that is not a conversation slot, then the active one, then the one already at the target, then the lowest id. A row with no target entity, page, hash or `valid_from` is never ranked. |
| `repointSupersededToKept` `{ ids, keeps }` | Rows that name `ids[i]` as `superseded_by` name `keeps[i]` instead, or none when the row is `keeps[i]`. A repeated id keeps its first survivor. Lists of different lengths pad with nulls as `unnest` does. Answers null. |
| `clearOntologySlots` `{ ids }` | The named conversation slots (`cli:extract-conversation-facts`) lose `dimension`, `value`, `value_hash` and `dim_status` and keep their row. Any other row is left alone. |
| `deleteRekeyLosers` `{ ids }` | Deletes the named facts that hold a `dimension`. An id below 1 names nothing. |
| `listOntologyFactCandidates` `{ sourceIds }` | The ontology rows with an entity of these sources that are fence-held (`row_num`) or whose page is not their `source`, and are not conversation slots, by id: `{ id, source_id, entity_slug, dimension, source, page, row_num, expired_at, withdrawn, consolidated, duplicate }`. `expired_at` is UTC microsecond text. `duplicate` is another row of the entity with the key this one would have on its own provenance. |
| `restoreOntologyFact` `{ id, sourceId, rowNum, page, expiredAt }` | Sets `row_num` null, the page to the row's `source` and `expired_at` null, only while the row, source, row number, page and expiry text are as given, it holds a slot, is not a conversation slot and duplicates nothing. Runs the withdrawal guard, so a withdrawal that landed since expires the row again. Answers `[{ id, expired }]`, none when nothing matched. |

A re-key move is one of the closed shapes `engine-sql/ontology-repair.ts` lists (`REKEY_WHERE_SHAPES`,
`REKEY_ENTITY_SHAPES`, `REKEY_SMS_SHAPES`). The TypeScript member sends each by name (`where`: `entity_unfenced`,
`unbacked_id`, `entity_off_page`, `entity`, `page`, `page_live`; `entity`: `param3`, `own`, `param2`; `sms`: `own`,
`param3`, `param2`) and `params` as text or null, and refuses any other text with the SQL module's message. A bigint
parameter that is not an integer refuses with `invalid_argument`.

The conversation-slot and not-conversation-slot predicates are Postgres text only; the store reads them as the fact's
`conversation_slot()`.
