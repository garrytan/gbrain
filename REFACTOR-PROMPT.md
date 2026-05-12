# Takes Extraction Refactor — Claude Code Prompt

## What We're Building

Build takes extraction as a **first-class gbrain feature** that ships out of the box. Any gbrain user should be able to run `gbrain extract-takes` and get takes extracted from their brain pages, written into the markdown, and synced to the DB.

The core architectural principle: **brain repo markdown files are the system of record**, not the database. The DB becomes a read cache that can be rebuilt from repo at any time via `gbrain sync`.

This is NOT a standalone script or a Wintermute-specific tool. It's a gbrain command that lives in the gbrain repo, uses gbrain's existing AI gateway/recipe infrastructure for LLM calls, and follows gbrain's patterns for CLI commands.

## Current State

Takes are extracted from brain pages by an LLM and stored as a markdown table section inside each brain page, between HTML comment markers:

```markdown
<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | AI will replace 50% of coding by 2030 | bet | people/garry-tan | 0.85 | 2025-11-12 | Circleback #4907018 |
| 2 | Clipboard's execution quality is still below standard | take | people/bo-ren | 0.85 | 2025-12-16 | Clipboard BoD |
<!--- gbrain:takes:end -->
```

This section lives at the bottom of each brain page `.md` file. ~3,910 pages already have this format baked in. ~24,000 more pages need extraction.

## The Format

### Kinds
- **take** — opinion, assessment, evaluation. The core value of the system.
- **fact** — verifiable. Keep minimal, identity-defining only.
- **bet** — forward-looking prediction with testable outcome.
- **hunch** — speculative pattern-matching, gut intuition.

### Holder (who column)
The holder is WHO HOLDS the belief, not who it's about:
- `people/garry-tan` — a person's own stated/implied belief
- `companies/clipboard` — institutional facts only (SEC filings, etc.)
- `world` — verifiable consensus facts
- `brain` — the system's own analysis/inference

### Weight
Rounded to 0.05 increments (0.35–0.95 for opinions, 1.0 only for verifiable facts). Use the full range.

## What Needs to Happen

### 0. `gbrain extract-takes` as a first-class CLI command

Add a new gbrain CLI command: `gbrain extract-takes`

Behavior:
- `gbrain extract-takes` — extract takes for all pages that don't have them yet
- `gbrain extract-takes --slug people/garry-tan` — extract for one page
- `gbrain extract-takes --type meeting` — extract for all meeting pages
- `gbrain extract-takes --force` — re-extract even if takes section already exists
- `gbrain extract-takes --concurrency 5` — parallel extraction
- `gbrain extract-takes --dry-run` — show what would be extracted without writing

This command should:
1. Use gbrain's existing AI gateway/recipe infrastructure for LLM calls (NOT hardcoded Azure endpoints)
2. Use the chat model configured in the user's gbrain recipe (respecting model preferences)
3. Follow the same patterns as other gbrain CLI commands (src/commands/)
4. Write progress to `_takes-extraction/checkpoint.json` and `_takes-extraction/progress.jsonl` in the brain repo
5. Auto-commit every N pages (configurable, default 500)
6. Resume from checkpoint on restart
7. Skip pages that already have `gbrain:takes:begin` markers (unless --force)

### 1. `gbrain sync` reads takes from markdown → DB

When `gbrain sync` processes a page, it should:
1. Check if the page content contains `<!--- gbrain:takes:begin -->` markers
2. Parse the markdown table between the markers
3. Upsert each row into the `takes` table in the DB
4. The page slug + row number is the natural key for dedup

The takes table schema (already exists):
- `id` (uuid)
- `page_slug` (text) — source brain page
- `claim` (text)
- `kind` (text) — take/fact/bet/hunch
- `holder` (text) — people/slug, companies/slug, world, brain
- `weight` (numeric)
- `since` (date)
- `source` (text)

### 2. `gbrain extract-takes` writes to markdown, not DB

The extraction command should:
1. Read brain page content
2. Send to LLM with the extraction prompt (see below)
3. Write the takes section directly into the brain page markdown file
4. If the page already has a takes section, replace it
5. Track progress in `_takes-extraction/checkpoint.json` and `_takes-extraction/progress.jsonl` (both in the brain repo)
6. Auto-commit every N pages

The extraction should NOT write directly to the DB. `gbrain sync` handles that.

### 3. DB can be rebuilt from repo

`gbrain sync --rebuild-takes` (or similar) should:
1. Scan all `.md` files in the brain repo
2. Find all `gbrain:takes:begin/end` sections
3. Parse and load into DB
4. This means the DB can be nuked and rebuilt at any time

## The Extraction Prompt

Here's the full system prompt used for extraction (proven in production, extracted 100K+ takes):

```
You are an extraction engine for gbrain's "takes" system — v2, post-eval. You read a brain page and distill it to the CORE BELIEFS, ASSESSMENTS, and PREDICTIONS that matter.

Takes are a BELIEF SYSTEM, not a data lake. Think of them as the 5-10 things you'd tell someone if they asked "what's the essential read on this person/company/topic?" Every row must pass the test: "Would Garry want to see this when querying his beliefs about X?"

OUTPUT FORMAT — produce ONLY this markdown block, nothing else:

<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | [claim text] | [kind] | [holder] | [weight] | [date] | [source] |
<!--- gbrain:takes:end -->

FIELD RULES:
- **claim**: Specific, concrete, self-contained, ATOMIC. One claim per row. Split compound claims.
- **kind**: fact (verifiable, MINIMAL), take (opinion/assessment, CORE VALUE), bet (prediction), hunch (speculative)
- **who**: The HOLDER — who holds/stated this belief. NOT who it's about.
- **weight**: Round to 0.05 increments. Only verifiable facts get 1.0. Opinions max 0.95.
- **since**: ISO date. **source**: Brief reference.

HOLDER ATTRIBUTION:
- holder = who HOLDS this belief, NOT who the belief is ABOUT
- "Did this person SAY or CLEARLY IMPLY this?" YES → people/slug. NO → brain
- people/slug = person's own stated opinion
- companies/slug = institutional facts only
- world = verifiable consensus
- brain = system's analysis/inference

SIGNAL DENSITY:
- "So what" test: would removing this change how someone thinks about this entity?
- No caps on count. Let content drive it.
- Collapse related claims. Skip metadata. Prioritize takes/bets over facts.
- Empty is OK. Don't manufacture takes from nothing.

WEIGHT CALIBRATION (use full range):
0.95 near-certainty | 0.85 high confidence | 0.75 solid | 0.65 cautious | 0.55 uncertain | 0.45 leaning negative | 0.35 gut negative | 0.25 speculative | 1.0 ONLY verifiable facts
```

## Real Example

Here's what a brain page looks like with takes baked in (from `meetings/2025-12-16-confirmed-zoom-clipboard-bod.md`):

```markdown
---
title: "Clipboard Board Meeting Q4 2025"
type: meeting
date: 2025-12-16
---

# Clipboard Board Meeting Q4 2025

[... page content ...]

<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Clipboard is on plan for 2025 at roughly 25% revenue growth. | fact | people/bo-ren | 0.85 | 2025-12-16 | Clipboard BoD, Circleback #5555373 |
| 2 | Clipboard's execution quality is still below management's standard. | take | people/bo-ren | 0.85 | 2025-12-16 | Clipboard BoD, Circleback #5555373 |
| 3 | Clipboard should move more of its sales motion into the field. | take | people/warren-min | 0.90 | 2025-12-16 | Clipboard BoD, Circleback #5555373 |
<!--- gbrain:takes:end -->
```

## File Locations

- Extraction prompt: `/data/.openclaw/workspace/skills/takes-extraction/extract-takes.mjs` (the SYSTEM_PROMPT constant)
- Previous extraction script (Azure GPT-5.5): `/data/gbrain/takes-extract-v3.ts`
- Existing takes in brain pages: `grep -rl "gbrain:takes:begin" /data/brain/` (~3,910 pages)
- Progress tracking: `/data/brain/_takes-extraction/`

## Key Principles

1. **Repo is system of record.** If it's not in a `.md` file, it doesn't exist.
2. **DB is a cache.** Can be rebuilt from repo at any time.
3. **Extraction writes to markdown.** Never directly to DB.
4. **Sync reads from markdown.** `gbrain sync` parses takes markers and loads to DB.
5. **Same pattern for future extractions.** Facts, hunches, bets — all use the same `<!--- gbrain:X:begin/end -->` marker pattern in markdown.
6. **First-class gbrain command.** `gbrain extract-takes` ships with gbrain. Not a separate script. Uses gbrain's AI gateway, recipe system, and CLI patterns. Any gbrain user can run it out of the box.
7. **No hardcoded provider endpoints.** Use gbrain's recipe/gateway infrastructure for all LLM calls. The user's configured model is the model that runs.
