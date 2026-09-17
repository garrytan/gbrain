---
name: brain-ingest-gate
version: 1.0.0
description: >
  Pre-write quality gate for content entering the brain. No raw copies: a bare
  cp/mv into the brain repo is a bug. Before any new page lands, resolve named
  entities registry-first (a vector score is a floor for prose, never a gate
  for named things), then run the read-the-top-hit dedup decision tree
  (clear-dup / plausible-dup / clear). Owns dedup; delegates enrichment to the
  shipped ingestion skills. Routing convention, not an operation-boundary
  enforcement.
triggers:
  - "move this to brain"
  - "migrate to brain"
  - "copy these files into the brain"
  - "is this already in the brain"
  - "check for duplicates before writing"
  - "dedup before saving"
  - "raw copy to brain"
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - concepts/
  - projects/
upstream: brain-ingest-gate@fc834ee
# Brain-first applies in its purest form here: the entire gate IS a
# brain-first lookup performed at write time (entity card, alias-expanded
# search, read the top hit) before anything external or new is written.
brain_first: true
---

# Brain Ingest Gate — Resolve and Dedup Before Anything Enters the Brain

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) —
> the lookup chain (`gbrain entity` → `search` → `query` → `get`) is the same
> chain this gate runs before every write.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) —
> when the gate's verdict is "write", the primary subject picks the directory.
>
> **Convention:** `skills/conventions/quality.md` owns the cross-cutting page
> rules (citations, Iron Law back-linking, notability) — every page the gate
> lets through follows them. Gate-specific delta: the gate only decides
> write/link/skip; the admitting skill applies the quality rules on write.

## The Rule

**No content enters the brain without passing this gate. A raw `cp` or `mv`
into the brain repo is a bug.**

One insight, one place. If it already exists, link to it — don't clone it.
Before any new page is written (file migration, bulk import, manual
`gbrain put`, subagent output), two checks run in order:

1. **Named-Entity Resolution Gate** — is this about a named thing that
   already has a page under its chosen name?
2. **Dedup Gate** — does the brain already state this insight somewhere?

**Scope honesty:** this gate is a routing convention — the harness resolves it
into context when an ingest-shaped intent matches, and a well-behaved agent
follows it. Nothing in the gbrain runtime mechanically blocks an unenriched or
duplicate write if the skill never loads.

## Why gbrain needs this gate

The native pipeline does NOT do semantic dedup for you:

- **`gbrain import` / `gbrain sync` skip only matching frontmatter IDs.**
  Identical content under a different slug or ID indexes twice — every
  duplicate becomes a second search hit competing with the canonical page.
- **`gbrain capture`'s dedup is a 24-hour exact content-hash** — it catches
  re-captures of identical bytes, not the same insight reworded.
- **The `remember` verb dedupes facts, not pages.**

Semantic dedup and named-entity resolution are this skill's job, in full.

## When This Gate Fires

1. **File migration** — moving files already in the workspace into the brain
   repo ("move this to brain").
2. **Bulk imports** — batch moves of any kind into brain directories, BEFORE
   `gbrain sync` or `gbrain import` indexes them. For batches, also read
   [conventions/test-before-bulk.md](../conventions/test-before-bulk.md):
   gate 3-5 items and inspect the decisions before running the rest.
3. **Manual writes** — `gbrain put` or `gbrain capture` of rich content, or
   direct file writes into the brain repo.
4. **Subagent output** — background agents writing notes or pages into the
   brain.

## What This Gate Owns vs Delegates

This skill is a **gate**, not a pipeline. It owns the pre-write checks below.
Everything downstream of a "write" verdict is delegated to shipped skills —
do not restate their steps here or inline:

| Concern | Delegate to |
|---|---|
| Routing new external content (meetings, articles, media) | [ingest](../ingest/SKILL.md) |
| Entity detection + notability on inbound content | [signal-detector](../signal-detector/SKILL.md) |
| Creating/updating person + company pages, tiered effort, backlinks | [enrich](../enrich/SKILL.md) |
| Concept pages, tiering, cluster synthesis | [concept-synthesis](../concept-synthesis/SKILL.md) |
| Back-link enforcement (Iron Law) | [conventions/quality.md](../conventions/quality.md) |
| Which directory the page lands in | [_brain-filing-rules.md](../_brain-filing-rules.md) |

## Named-Entity Resolution Gate (runs FIRST)

**Fires whenever the content is about a NAMED project, place, company, person,
or anything someone "wants to build / found / make."**

Vector similarity alone cannot be trusted to catch named-entity dupes: a page
stored under its chosen NAME will not embed close to the generic English
phrase someone happens to describe it with. The classic failure: a search for
a descriptive phrase scores the canonical named page below the prose floor, so
a duplicate stub gets written on top of a years-old page. Stored by named
meaning; retrieval attempted by literal generic phrase.

### The rules

1. **Resolve registry-first, not by the generic phrase.** gbrain's native
   registry is the entity surface:

   ```bash
   gbrain entity "<name>"        # zero-LLM card: page, aka list, near-miss suggestions
   ```

   A card hit means the page exists — STOP, link, don't clone. On a miss (or
   for concept-shaped nouns), fall through to `gbrain query "<name>" --limit 3`.
   If the brain also keeps an explicit index of named initiatives (e.g. a page
   under `concepts/`), read it before concluding anything is new.

2. **Expand through aliases before searching.** Named pages should carry an
   `aliases:` frontmatter list (generic label + chosen name + any nickname +
   signature phrase). Search EACH alias and the generic label, not just the
   phrase the user happened to say.

3. **A vector score is a floor for prose, NEVER a gate for named things.**
   If there is ANY plausible named match, open and read the candidate page
   (`gbrain get <slug>`) before concluding it doesn't exist. A named page can
   be the right answer at a score that would be a clear miss for prose.

4. **When a NEW named thing appears, bake its aliases in the same write.**
   Create the page with the full `aliases:` list so every future synonym
   resolves through `gbrain entity`. One frontmatter list covers all future
   phrasings — O(1), not a per-instance reminder.

### Why a gate and not a memory note

A memory reminder ("query the real name, not the generic phrase") is a
per-instance sticky note: it only works if it happens to be in hot context
that turn, doesn't generalize to the next named entity, and rots. This skill
loads when an ingest-shaped task routes here. Process rules belong in the
triggered gate, not in hot memory.

## Dedup Gate (runs SECOND)

Before writing ANY new page (for named things, the resolution gate above runs
first and takes precedence):

1. **Extract the core claim** — 1-2 sentences capturing what's novel about the
   new content.

2. **Search for it:**

   ```bash
   gbrain search "<core claim>" --limit 5
   ```

3. **OPEN AND READ the top hit** (`gbrain get <slug>`). Never band on the
   score alone. Donor systems publish cosine cutoffs for this step — do NOT
   port them: `gbrain search` returns fused hybrid rank scores, not cosine
   similarity, and no numeric threshold maps across. The band comes from
   reading, not from the number.

4. **Assign a band:**

   | Band | Meaning | Action |
   |---|---|---|
   | **clear-dup** | The top hit already states the same insight about the same subject | STOP. Link to the existing page (`gbrain link` / `gbrain timeline-add`) instead of writing. |
   | **plausible-dup** | Same territory; possibly a new angle | Read both fully. Same insight → link, don't write. Genuinely new angle → write WITH a cross-link to the existing page. |
   | **clear** | Nothing in the top results covers the claim | Write normally through the delegated enrichment skills. |

### Decision tree

```
New content to write
  ├─ Named thing? → Named-Entity Resolution Gate first
  │    (entity card → alias-expanded search → READ the candidate)
  ├─ Extract core claim (1-2 sentences)
  ├─ gbrain search "<core claim>" --limit 5
  └─ OPEN AND READ the top hit (gbrain get <slug>)
      ├─ clear-dup     → STOP. Link to existing. Report "duplicate".
      ├─ plausible-dup → Read both. Same insight?
      │    ├─ yes → STOP. Link to existing. Report "duplicate".
      │    └─ no  → Write with cross-link. Report "new angle".
      └─ clear         → Write via enrichment skills. Report "unique".
```

### When to skip dedup

- **Operational/state files** — time-series records, not knowledge.
- **Meeting transcripts** — each meeting is unique by definition (entities
  INSIDE it still go through the named-entity gate via the delegated skills).
- **Timeline entries on existing pages** — back-links are additive, not
  duplicative.
- **Media files** — dedup by filename/hash, not semantic similarity.

## Verification

After the batch, verify the gate's output holds:

```bash
gbrain check-backlinks check            # mentioned entities link back (fix with: check-backlinks fix)
gbrain backlinks <new-slug>             # each new page has inbound links
gbrain search "<core claim>" --limit 3  # the insight has exactly ONE home
```

If `check-backlinks check` reports gaps on pages the gate just admitted, the
enrichment delegation was skipped — route back through
[enrich](../enrich/SKILL.md) before declaring the ingest done.

## Contract

This skill guarantees:

- No new page enters the brain through this skill's flows without the
  named-entity resolution check and the dedup check running first.
- Every "duplicate" verdict names the matched slug and produces a link or
  timeline entry instead of a clone.
- New named-entity pages carry an `aliases:` frontmatter list in the same
  write that creates them.
- Dedup bands are assigned by READING the top hit, never by score alone; no
  numeric similarity thresholds are used against gbrain's fused scores.
- Enrichment is delegated to shipped skills (ingest, enrich, signal-detector,
  concept-synthesis) — never restated or reimplemented inline.
- Batches end with a `gbrain check-backlinks check` verification pass.
- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:`.
- Privacy contract preserved: no real names, no fork-specific filesystem path
  literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this
section exists for the conformance test.

## Output Format

One decision line per item checked, then the verification result:

```
Ingest gate — 3 item(s) checked

| item | entity resolution | band | action |
|---|---|---|---|
| notes-on-widget-co.md | resolved: companies/widget-co | clear-dup | linked (timeline entry on companies/widget-co) |
| pricing-thesis.md | n/a (prose) | plausible-dup | new angle — written to concepts/ with cross-link to concepts/pricing-power |
| charlie-example-intro.md | miss (near-miss: people/charlie-example) | — | read near-miss; same person → linked, no new page |

Verification: check-backlinks check → 0 gaps on admitted pages
```

Every "linked" or "duplicate" row MUST name the matched slug. If any row says
"written", the enrichment delegation (which skill handled it) should be
recoverable from the conversation.

## Anti-Patterns

- ❌ `cp file.md <brain-repo>/concepts/` — raw copy, no gate, no enrichment.
- ❌ Bulk `mv` of a folder into the brain repo, then `gbrain sync` — sync
  happily indexes every duplicate; matching-ID skip will not save you.
- ❌ Trusting a low vector score as proof a named thing has no page — named
  pages don't embed near generic descriptions of them.
- ❌ Banding on the search score without opening the top hit.
- ❌ Porting numeric dedup thresholds from other systems onto gbrain's fused
  scores.
- ❌ Writing a new named page without its `aliases:` list — the next synonym
  creates the next duplicate.
- ❌ Reimplementing entity detection, backlinking, or concept linking inline
  instead of delegating to the shipped skills.
- ❌ Skipping the gate because the write is "just one page" via `gbrain put` —
  single manual writes are where duplicate stubs come from.

## Dedup (sharp boundaries)

- **[capture](../capture/SKILL.md)** — the quick-save front door; its dedup is
  a 24h exact content-hash on identical bytes. This gate is the SEMANTIC +
  named-entity layer for content entering the brain as real pages (migrations,
  bulk imports, inbox graduation). "capture this thought" → capture; "migrate
  these files into the brain" → this gate.
- **[ingest](../ingest/SKILL.md)** — the router for NEW external content
  (meetings, articles, media) and its enrichment pipeline. ingest decides what
  to DO with content; this gate decides whether a page should EXIST at all.
  The gate fires before the write; ingest and its specialized skills handle
  everything after a "write" verdict.
- **[enrich](../enrich/SKILL.md)** — page creation/update mechanics (tiers,
  citations, timelines, backlinks) AFTER this gate says "write" or "link".
- **[concept-synthesis](../concept-synthesis/SKILL.md)** — retroactive,
  at-scale dedup of concept stubs that already slipped in. This gate is
  prevention at write time; concept-synthesis is the cleanup pass. "dedupe my
  existing concepts" → concept-synthesis.
- **frontmatter-guard (host-side)** — the same standalone-gate pattern on an
  orthogonal axis: structural validity of what's written vs (here) semantic
  novelty of whether to write.
- **[bulk-ingestion](../bulk-ingestion/SKILL.md)** — the bulk sibling. Its
  pipeline dedup key (`source + source_id`) only makes RE-RUNS idempotent; it
  does not catch cross-source duplicates or resolve named entities. This gate
  is the semantic + named-entity layer bulk-ingestion runs on its Phase 3 trial
  items and bakes into the codified pipeline (its Phase 1d/6). "Build a
  large-corpus pipeline" → bulk-ingestion; "does this page already exist before
  I write it" → this gate.
- **[data-loss-gate](../data-loss-gate/SKILL.md)** — the inverse gate: it
  stops data LEAVING the brain without confirmation; this gate stops data
  ENTERING without resolution + dedup.
