---
name: confidence-score
version: 1.0.0
description: |
  Auto-score a page's confidence (high/medium/low) based on evidence levels,
  backlinks, recency, and citation density. Also assigns a compile grade
  (A/B/C/F) for the latest ingest event touching this page. Driven primarily
  by dikw-compile and kos-patrol; exposed as a standalone command too.
triggers:
  - "score this page"
  - "what's the confidence"
  - "grade the compile"
tools:
  - get_page
  - backlinks
  - list_pages
mutating: false
---

# Confidence Score Skill

Port of KOS v1 `knowledge/agents/shared/quality-criteria.md` scoring logic.

## Confidence formula (high/medium/low)

Inputs:
- `E_max` — highest evidence level on page (E0-E4)
- `backlinks_in` — count of pages linking TO this page
- `age_days` — days since `updated`
- `citation_density` — inline citations / paragraphs

Thresholds:

| Confidence | Condition |
|------------|-----------|
| `high` | `E_max ≥ E3` AND `backlinks_in ≥ 2` AND `age_days ≤ 90` AND `citation_density ≥ 0.5` |
| `medium` | `E_max ≥ E2` AND `backlinks_in ≥ 1` AND `age_days ≤ 180` |
| `low` | otherwise |

Auto-write `confidence: <value>` to frontmatter on every skill-driven page update.

## Compile grade (per ingest event)

Same rubric as `dikw-compile` Phase 5:

| Grade | Ingest event outcome |
|-------|---------------------|
| A | 3+ impacted pages updated AND at least 1 new synthesis/decision |
| B | 1-2 impacted pages updated with precise strong links |
| C | Only source page created, no downstream propagation |
| F | Source page fails `evidence-gate` |

Written to source page frontmatter as `compile_grade: A|B|C|F` + `compile_notes: <short>`.

## Rollup metrics (for kos-patrol)

Daily rollup computed by `kos-patrol`:
- `compilation_rate` = pages_with_grade_A_or_B / total_pages_ingested_this_week
- `confidence_distribution` = {high, medium, low} counts
- `stale_count` = count where `age_days > 180` AND `status=active`

KOS v1 reported ~63% compilation rate as of 2026-04-15. Maintain or improve.

## CLI

```bash
bun run ~/Projects/jarvis-knowledge-os-v2/skills/kos-jarvis/confidence-score/run.ts <slug>
# Output: {confidence, evidence_max, backlinks, age_days, reasons}
```
