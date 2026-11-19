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
| `getOntology` | The best row per dimension as of `asof` (default now): `valid_from <= asof < valid_until`, active unless `includeQuarantined`, at or above `minConfidence`, filtered by the visibility list, `excludeDiary` (`life/diary/` sources) and soft-deleted provenance pages. Dimensions come out in byte order. |
| `discoverOntologyDimensions` | Per dimension, the distinct entities and the observation count of open slot rows. Most entities first, then dimension. |
| `findOntologyConflicts` | Open, active slot rows grouped by entity and dimension, kept when they hold two or more distinct values from two or more distinct sources. Values come out in id order. A null entity sorts last. |

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
