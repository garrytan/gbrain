---
name: enrich-sweep
version: 1.0.0
description: |
  One-shot sweep that reads every page in the brain, extracts every
  person/company/concept/project mentioned via Haiku NER, dedupes, tiers
  by mention count + context, and creates stub pages for entities that
  lack one. Tier 2 candidates get Tavily web-search augmentation; Tier 3
  stays brain-only (confidence: low). This is the primary G1 payoff skill
  from JARVIS-NEXT-STEPS.md §5.
triggers:
  - "enrich sweep"
  - "entity sweep"
  - "build people pages"
tools:
  - list_pages
  - get_page
  - put_page
  - embed
  - query
mutating: true
---

# enrich-sweep

> **Convention:** see [conventions/brain-first.md](../../conventions/brain-first.md) — enrich-sweep scans the brain (Phase A) and dedups via `gbrain query` (Phase D) before any Tier 2 Tavily / Tier 1 Crustdata external augmentation.

Batch-scan the brain, extract entity mentions, fill the gap between
"86 pages, 3 entity pages" and "86 pages, ~30 entity pages" in one run.

See `docs/JARVIS-NEXT-STEPS.md` §5 for full context and exit criteria.

## When to run

- **One-shot on existing corpus** (current state: 86 pages → ~20-40 stubs)
- **After any large import** (e.g. post-Phase 4 calendar ingest) — pick
  up the new entities the import brought in
- **Nightly cron is a future possibility** but not wired in v1.0; too
  expensive to run every day at full-brain scale. A future lightweight
  variant could sweep only `--since <date>`.

## Prerequisites

1. **`GOOGLE_GENERATIVE_AI_API_KEY` in env** — native v0.27 Vercel AI SDK gateway
   (`google:gemini-embedding-001` + 1536 dim) auto-embeds new chunks
2. **kos-compat-api (or gbrain CLI) available** — reading existing pages
3. **`ANTHROPIC_API_KEY`** in env — Haiku 4.5 does NER
4. **`TAVILY_API_KEY`** in env — Tier 2 web augmentation
   (missing → all Tier 2 candidates degrade to Tier 3 "brain-only")

## Algorithm

Five phases, each idempotent and safely re-runnable.

### Phase A — Collect candidates

- `gbrain list --limit 10000` → every slug + kind + title
- `gbrain get <slug>` → full markdown
- Send body to Haiku 4.5 (`claude-haiku-4-5-20251001`) with a structured
  prompt requesting `{name, kind, context}` JSON array
- Emit `{name, kind, source_slug, mention_context}` per extraction

Cost: ~86 Haiku calls × ~2k tokens = trivial (< $0.10 for full sweep)

### Phase B — Dedupe and count

- Normalize name: lowercase, strip punctuation, drop common honorifics
- Fuzzy-merge obvious variants ("Sarah Guo" + "sarah guo" + "@sarahdoingthings")
- Use alias hints from queue and existing brain pages
- Count mentions per canonical entity
- Drop entities with single mention + no contextual weight (headers,
  asides, role titles without a name)

### Phase C — Tier classification

Per NEXT-STEPS §5. This sweep runs with `TAVILY_API_KEY` present but
**no** Crustdata/Proxycurl, so:

- **Tier 1 candidate** (mention≥8 OR appears in decisions/meetings):
  *degraded* to Tier 2 processing in this run. Flag in report as
  "wants Tier 1, blocked on missing Crustdata."
- **Tier 2 candidate** (mention 3-7 across ≥2 source files):
  Tavily search (1-2 results), distill into State section.
- **Tier 3 candidate** (mention 1-2):
  Brain-only cross-ref stub. State populated from mention_context.

### Phase D — Write stubs

For each new entity (no existing page, resolved via `gbrain query` on
the canonical name + known aliases):

1. Pick target "directory" via `skills/kos-jarvis/type-mapping.md`:
   - `person` → `people/<slug>`
   - `company` → `companies/<slug>`
   - `concept` → `concepts/<slug>`
   - `project` → `projects/<slug>`
2. Render markdown from template (see `report.template.md` for the
   person/company templates reused from
   `docs/GBRAIN_RECOMMENDED_SCHEMA.md`)
3. Frontmatter: `kind`, `confidence: low` (Tier 3) or `medium` (Tier 2),
   `source_of_truth: brain-synthesis` or `tavily+brain`, `aliases`, `id`
4. Timeline: first mention timestamp (from source page `updated`)
5. Links: reverse mentions from every source that referenced the entity
6. `gbrain put <slug> --content <md>` → auto-embeds via Gemini shim

### Phase E — Report

Write `~/brain/agent/reports/enrich-sweep-<YYYY-MM-DD>.md` (mkdir -p):

- New pages created (count + list by dir)
- Existing pages updated (count + list)
- Tier distribution
- Tavily calls + cost estimate
- "Blocked by missing Tier 1 API" candidate list (for Lucien's decision
  on whether to get a Crustdata key)
- Confidence distribution (low / medium)

## Flags

- `--dry` — Phase A NER runs in **mock mode** (reads cached or emits
  empty), Phase B/C/D plan printed, no `gbrain put`, no Tavily. Sanity
  check for the 86-page pipeline.
- `--plan` — Real Haiku NER runs, candidates + Tier decisions printed,
  no stub writes, no Tavily. Pre-flight for Lucien to review before
  spending Tavily budget.
- `--max-tier2 N` — Cap Tavily calls (default 30)
- `--kind K` — Restrict to one kind (person / company / concept / project)
- `--since DATE` — Only consider pages with `updated >= DATE`
- `--limit N` — Process only the first N source pages (dev smoke test)

## Exit codes

- `0` — clean, report written, at least one stub created or plan printed
- `1` — fatal (shim down, ANTHROPIC_API_KEY missing, gbrain unreachable)
- `2` — partial (some Haiku calls failed, some stubs rejected by gbrain)

## Pre-flight checks (run.ts asserts)

1. `curl -s http://127.0.0.1:7222/health` OK → else exit 1
2. `gbrain list --limit 1` succeeds → else exit 1
3. `ANTHROPIC_API_KEY` set → else exit 1
4. `TAVILY_API_KEY` set OR `--tier3-only` flag → else warn
5. Idempotency lock `~/.cache/kos-jarvis/enrich-sweep.lock` absent
   → else exit 1 (another sweep running)

## Cost envelope (full 86-page sweep)

| Phase | Calls | Est. cost |
|-------|-------|-----------|
| A — Haiku NER | 86 × ~2k in / 1k out tokens | ~$0.10 |
| C — Tavily (≤30 cap) | ≤30 × 1 req | ~$0.03 |
| D — `gbrain put` + Gemini embed | ~30 × embed | free (Gemini free tier) |
| E — report write | 1 file | 0 |
| **Total** | | **< $0.20** |

## Delegates

- `skills/enrich/SKILL.md` (upstream) — canonical Tier 1/2/3 contract.
  enrich-sweep IS the bulk-mode variant; it does not fork that logic,
  it wraps it.
- `skills/signal-detector/SKILL.md` (upstream) — mental model for NER
- `skills/kos-jarvis/type-mapping.md` — KOS kind ↔ GBrain dir
- `skills/kos-jarvis/_archived/pending-enrich/SKILL.md` — archived
  2026-05-05: queue-file v1.1 input was retired with the OpenClaw
  Feishu signal-detector extension; enrich-sweep now relies on brain
  scan only.

## Rollback

Every stub creation is recorded in the report. To roll back a bad sweep:

```bash
jq -r '.newly_created[]' ~/brain/agent/reports/enrich-sweep-<date>.md.json \
  | xargs -I{} gbrain delete {}
```

(The JSON sidecar is written alongside the human-readable .md report.)

## Related output

- Dashboard integration: `skills/kos-jarvis/kos-patrol/run.ts` consumes
  the new stubs in the next daily run; gap detection will newly see
  entities that now HAVE a page and won't report them as missing.
