---
name: compress-agents-md
version: 1.0.0
prompt_version: 1
description: |
  Compress AGENTS.md by converting granular skill-per-row resolver tables
  into functional-area dispatchers. Each area lists sub-skills in a
  "(dispatcher for: ...)" clause. The LLM reads one area entry and routes
  to the correct sub-skill — proven 100% routing accuracy at ~50% file size.
triggers:
  - compress agents.md
  - slim down agents.md
  - agents.md too large
  - resolver too big
  - context-health agents
  - reduce context budget
  - functional area resolver
tools:
  - exec
  - read
  - write
  - edit
mutating: true
---

# Compress AGENTS.md — Functional-Area Resolver Pattern

## Problem

AGENTS.md grows as skills are added. Each skill gets its own resolver row
(trigger → skill path). At ~200+ skills this hits 25-30KB — eating context
budget that should go to actual work.

## Solution: Functional-Area Dispatchers

Replace N rows per area with **one entry per functional area**. Each entry
lists all sub-skills it can dispatch to in a `(dispatcher for: ...)` clause.

### Before (270 rows, 25KB)
```
- Creating/enriching a person or company page → `enrich`
- Fix broken citations in brain pages → `citation-fixer`
- Publish/share a brain page as link → `brain-publish`
- Generate PDF from brain page → `brain-pdf`
- Read a book through lens of a problem → `strategic-reading`
- Personalized book analysis → `book-mirror`
- Brain integrity → `brain-librarian`
...
```

### After (13 rows, 13KB)
```
- **Brain & knowledge**: create/enrich/search/export brain pages, filing,
  citations, publishing, book analysis, strategic reading, concept synthesis,
  archive mining → `brain-ops` (dispatcher for: enrich, query, brain-pdf,
  brain-publish, brain-export, brain-librarian, citation-fixer, book-mirror,
  strategic-reading, concept-synthesis, archive-crawler, ...)
```

## Why It Works

The LLM doesn't need one row per sub-skill. It needs:
1. **Area recognition** — "this is about brain pages" → Brain & Knowledge
2. **Sub-skill visibility** — the `(dispatcher for: ...)` list shows what's available
3. **The skill file itself** — once the LLM reads `brain-ops/SKILL.md`, it has full routing detail

This is a **two-layer dispatch**: AGENTS.md routes to the area, the area skill
routes to the specific sub-skill. Each layer does one job well.

## A/B Eval Results

Tested three architectures with LLM eval (Sonnet, 20 routing fixtures):

| Variant | Accuracy | Size | Verdict |
|---------|----------|------|---------|
| Baseline (270 bullet rows) | 95% | 25KB | ⚠️ Verbose |
| **Functional areas** (this pattern) | **100%** | **13KB** | ✅ Winner |
| Resolver-of-resolvers (pipe table) | 15% | 10KB | ❌ Broken |

The resolver-of-resolvers variant failed because the pipe table format didn't
convey the dispatch relationship — the LLM picked area names instead of
drilling into sub-skills. The `(dispatcher for: ...)` clause is the key insight.

## How To Compress

### Step 1: Identify functional areas

Group skills by domain. Typical areas (adjust per deployment):

- **Brain & Knowledge** — brain-ops as dispatcher
- **Content Ingestion** — ingest as dispatcher  
- **Calendar & Scheduling** — google-calendar as dispatcher
- **Email & Comms** — executive-assistant as dispatcher
- **Research & Investigation** — perplexity-research as dispatcher
- **X/Twitter & Social** — x-ingest as dispatcher
- **Places & Travel** — checkin as dispatcher
- **Product & Building** — acp-coding as dispatcher
- **Infrastructure** — healthcheck as dispatcher
- **Tasks & Logistics** — daily-task-manager as dispatcher
- **People & Contacts** — google-contacts as dispatcher

### Step 2: Build the area entry format

Each area entry follows this template:

```
- **{Area Name}**: {comma-separated trigger phrases} → `{dispatcher-skill}`
  (dispatcher for: {comma-separated sub-skill names})
```

Rules:
- Trigger phrases should be broad enough to catch intent ("brain pages, enrich,
  search, filing, citations, book analysis")
- Sub-skill list should be comprehensive — this is how the LLM knows what's available
- The dispatcher skill file should have its own internal routing table

### Step 3: Keep always-on entries separate

Gates and always-on entries (acknowledge, multi-user, entity-detector, etc.)
stay as individual rows — they're checked on every message, not dispatched.

### Step 4: Eval the result

Run routing fixtures against the compressed resolver:

```bash
# LLM-based eval (recommended)
node /path/to/resolver-llm-eval.mjs

# Structural eval (gbrain native — reads RESOLVER.md pipe tables)
gbrain routing-eval --json
```

Target: ≥95% accuracy on existing fixtures. If accuracy drops, the trigger
phrases or sub-skill lists need tuning.

### Step 5: Verify context-health

```bash
node scripts/daily-doctor.mjs --check context-health
```

Should show AGENTS.md under 95% of the 30KB limit.

## Anti-Patterns

❌ **Resolver-of-resolvers with pipe tables** — Tested and failed (15% accuracy).
   The LLM picks area names from the table instead of drilling into sub-skills.

❌ **Removing sub-skill names** — Without the `(dispatcher for: ...)` list,
   the LLM can't route to specific sub-skills. The list is the routing signal.

❌ **Too few areas** — Collapsing to <5 areas makes each area too broad.
   12-15 areas is the sweet spot.

❌ **Too many areas** — Defeats the purpose. If you have 50 areas, just keep
   individual rows.

## Maintenance

When adding a new skill:
1. Identify its functional area
2. Add the skill name to that area's `(dispatcher for: ...)` list
3. Update the area's skill file with routing detail
4. Run the routing eval to verify

When adding a new functional area:
1. Create the dispatcher skill with internal routing
2. Add the area entry to AGENTS.md
3. Run the routing eval to verify

## Changelog

### v1.0.0 — 2026-05-11
- Initial version. Proven via A/B eval: 100% accuracy at 48% size reduction.
