---
name: data-research
version: 1.0.0
description: |
  Structured data research: search sources, extract structured data,
  archive raw sources, maintain canonical tracker pages, deduplicate.
  Parameterized via YAML recipes for investor updates, donations,
  company updates, or any email-to-structured-data pipeline.
triggers:
  - "research"
  - "track"
  - "extract from email"
  - "investor updates"
  - "donations"
  - "build a tracker"
  - "data dig"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - put_raw_data
  - file_upload
mutating: true
---

# Data Research

Structured research pipeline: search sources, extract structured data,
archive raw, deduplicate, update canonical trackers, backlink entities.

## Contract

One skill for any email-to-structured-data pipeline. The only differences
between tracking investor updates, expenses, and company metrics
are the **search queries**, **extraction schemas**, and **tracker page format**.
All three use the same 7-phase pipeline with parameterized recipes.

## When to Use

- User wants to track structured data from email, web, or API sources
- User says "research", "track", "extract from email", "build a tracker"
- User mentions investor updates, donations, company metrics, filings
- User wants to set up recurring data collection (with cron recipe)

## Phases

### Phase 1: Define Research Recipe

Ask the user what they want to track. Either:
- Pick a built-in recipe: investor-updates, expense-tracker, company-updates
- Define a custom recipe with: source queries, classification rules, extraction schema,
  tracker page path, tracker format

Recipes are YAML files at `~/.gbrain/recipes/{name}.yaml`. Use `gbrain research init`
to scaffold a new one.

### Phase 2: Search Sources

Brain first (maybe we already have this data). Then:
- **Email** via credential gateway: windowed queries (quarterly, monthly if truncated)
- **Web** via search: public filings, press releases, regulatory data
- **APIs**: any structured data source the recipe defines
- **Attachments**: PDF extraction, HTML stripping

### Phase 3: Classify

Deterministic first (regex patterns from recipe), LLM fallback.
Log every LLM fallback for future regex improvement (fail-improve loop).
Skip marketing, newsletters, noise based on recipe's classification rules.

### Phase 4: Extract Structured Data

**EXTRACTION INTEGRITY RULE:**
1. Save raw source immediately (before any extraction)
2. Extract fields using deterministic regex first, LLM fallback
3. When summarizing batch results: **re-read from saved files**
4. Never trust LLM working memory after batch processing

This prevents a known hallucination bug where batch-processed amounts were
13/13 wrong from LLM working memory while saved files were correct.

### Phase 5: Archive Raw Sources

- `put_raw_data` for email bodies, API responses
- `file_upload` for PDF attachments, documents
- Create `.redirect.yaml` pointers for large files in storage
- Every tracker entry must link back to its raw source

### Phase 6: Deduplicate

Before adding to tracker:
- Exact match (same key fields) → skip
- Fuzzy match (same entity + date + similar amount within tolerance) → flag for review
- Different amount for same entity+date → add with note (could be correction)

### Phase 7: Update Canonical Tracker + Backlink

- Parse existing tracker page (markdown table)
- Append new entries in correct section (grouped by year/quarter/entity)
- Compute running totals
- Backlink every mentioned entity (person → people/ page, company → companies/ page)
- Uses enrichment service for entity pages

## Built-In Recipes

Three example recipes ship with GBrain (see `~/.gbrain/recipes/`):

1. **investor-updates** — extract MRR, ARR, growth, burn, runway, headcount from investor update emails
2. **expense-tracker** — extract amounts, recipients, platforms from receipt emails (subscriptions, services, recurring charges)
3. **company-updates** — extract revenue, users, key metrics from portfolio company update emails

## Anti-Patterns

- Trusting LLM working memory for amounts after batch processing (use extraction integrity rule)
- Creating tracker entries without raw source links
- Running without deduplication (leads to double-counted entries)
- Hardcoding source-specific patterns in the pipeline code (use recipes)

## Output Format

Brain page at the recipe's `tracker_page` path with markdown tables:

```markdown
### 2026

| Date | Company | MRR | ARR | Growth | Status |
|------|---------|-----|-----|--------|--------|
| 2026-04-01 | Example Co | $188K | $2.3M | +14.7% MoM | [Source](link) |
```

Each entry links to its raw source. Running totals at the bottom of each section.

## Conventions

References `skills/conventions/quality.md` for citation and back-linking rules.
