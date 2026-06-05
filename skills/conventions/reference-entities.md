# Convention: Reference entities (canon figures)

Some person/company pages are people/orgs the user **reads about** but does not
personally interact with — a book's author, a historical figure, a company an
article discusses (Andy Grove, Kleiner Perkins, Intel…). They are real
knowledge, worth a page, but they have **no dated history in the user's own
life**, so the entity coverage metrics (`timeline_coverage`,
`entity_link_coverage`) flag them as permanently incomplete with no honest fix.

The `reference: true` frontmatter flag resolves this.

## What it does

- A page with `reference: true` is **exempt from the entity coverage metrics
  only** (`timeline_coverage`, `entity_link_coverage`, and their onboard
  nudges).
- It keeps its real `type` (`person` / `company`), so it stays **fully
  searchable, enrichable, linkable, and edge-resolvable**. NOTHING about
  retrieval changes — this is the whole reason it's a flag, not a new `type`.
- It is **opt-in**. Absent / `false` / anything-but-`true` = a normal entity
  that DOES count toward coverage. **This is the default — do not set it on real
  contacts.**

## When to set it

Set `reference: true` when the entity is a figure/org the user reads ABOUT, not
someone they deal with:

- authors and figures discussed in a book (book-mirror) or article
  (article-enrichment)
- historical / canon figures imported as reference knowledge
- companies named only as examples in source material

Do NOT set it for people the user actually meets, emails, or works with — those
are normal entities whose missing timeline/links is a real, actionable gap.

## How to set it

```bash
gbrain reference <slug>            # mark as reference
gbrain reference <slug> --unset    # back to a normal entity
```

The command writes the flag to BOTH the markdown frontmatter (durable; survives
re-ingest / engine rebuild — markdown is the source of truth) AND the engine
JSONB (so coverage reflects it immediately, no re-sync). It's idempotent. You
can also hand-edit frontmatter (`reference: true`) and re-ingest.

## Why a flag, not a type

A new `type: reference-person` would drop the page out of every
`type IN ('person','company')` filter — search, enrichment, whoknows, link
inference — so you'd lose the figure everywhere, not just the metric. The flag
narrows the change to exactly the coverage denominators and nothing else.

## Implementation

`src/core/reference-flag.ts` — `referenceExclusionSql(alias?)` is the single
source of truth for the predicate `(frontmatter->>'reference') IS DISTINCT FROM
'true'`, ANDed into both numerator and denominator at every coverage site
(getHealth in both engines, onboard/checks.ts, init-nudge.ts). Backed by the GIN
index on `pages.frontmatter`.
