---
name: dikw-compile
version: 1.0.0
description: |
  KOS-flavored post-ingest compilation pass. After any ingest skill creates
  a source page, walk the DIKW (Data → Information → Knowledge → Wisdom)
  compilation: identify impacted concept/synthesis/decision pages, enforce
  strong-link type annotations (supplements/contrasts/implements/extends),
  2-5 link budget per page, and bidirectional citations.
  Runs after idea-ingest / media-ingest / meeting-ingestion.
triggers:
  - "compile this source"
  - "dikw compile"
  - "after ingest"
tools:
  - get_page
  - put_page
  - search
  - backlinks
  - add_link
mutating: true
---

# DIKW Compile Skill

Port of KOS v1 `knowledge/agents/prompts/compile-agent.md`. The core insight:
**a meaningful source should usually update more than one page.** If ingest
only produces a disconnected summary, compilation hasn't happened yet.

## Contract

Guarantees on every run:
- Source page has at least one downstream link (to concept/synthesis/decision)
- Every new or updated link carries a type annotation
- Link budget per page: 2-5 strong links, not a dump of weak associations
- Back-links are symmetric (iron law, from `maintain` skill)
- Compile grade is recorded in source page frontmatter (A/B/C/F)

## Link types (port from KOS `meta/link-rules.md`)

| Type | When to use |
|------|------------|
| `supplements` | new evidence reinforces existing page |
| `contrasts` | new evidence challenges or disagrees |
| `implements` | source is concrete realization of abstract concept |
| `extends` | source adds scope/depth previously missing |

Do **NOT** create links of type "see also" or "related" — that's the
weak-link anti-pattern KOS v1 explicitly banned.

## Protocol (6 phases)

### Phase 1 — Impact analysis

Given new source page `<source-slug>`:
```
gbrain query "<source-title-keywords>" --no-expand | head -20
```
Collect candidate impact pages (>= 0.5 similarity).

### Phase 2 — Classify candidates

For each candidate, read its compiled truth. Decide:
- Is the source new evidence for an existing claim? → `supplements`
- Does it challenge an existing claim? → `contrasts`
- Is it a concrete instance of an abstract framework? → `implements`
- Does it open a new facet not covered before? → `extends`
- **If none of the above**, skip. Don't force a weak link.

### Phase 3 — Enforce budget

Sort candidates by strength. Keep top 5. If you can't find 2 strong links,
the source may not be compilation-worthy yet; flag for later re-try rather
than manufacture weak links.

### Phase 4 — Write links

```
gbrain link <source-slug> <target-slug> --type <supplements|contrasts|implements|extends>
```

Update target page's `See Also` or equivalent section with inverse reference,
preserving citation format from `skills/conventions/quality.md`.

### Phase 5 — Grade

Grade this compilation event and write `compile_grade` to source frontmatter:

| Grade | Condition |
|-------|-----------|
| A | 3+ targets updated AND at least 1 new synthesis/decision created |
| B | 1-2 targets updated with precise strong links |
| C | Only source page written, no downstream updates |
| F | Source page itself fails `evidence-gate` check |

### Phase 6 — Propose writebacks

If the source contains a reusable insight spanning multiple existing pages,
propose a new `synthesis` or `comparison` page. Do NOT auto-create; emit
the proposal to the user (or to the briefing cron for daily review).

## Output

Append to `~/brain/log.md`:
```
<YYYY-MM-DD> | dikw-compile | <source-slug> | grade=<A|B|C|F> | links=[<type>:<target>, ...]
```

## Delegation

- Citation format: `skills/conventions/quality.md`
- Back-link iron law: `skills/maintain/SKILL.md`
- Evidence level prerequisite: `skills/kos-jarvis/evidence-gate/SKILL.md`
- Type mapping (where new synthesis/decision lives in GBrain dirs):
  `skills/kos-jarvis/type-mapping.md`
