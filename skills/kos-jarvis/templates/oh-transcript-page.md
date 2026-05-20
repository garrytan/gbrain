---
id: oh-transcript-template
kind: source
status: draft
created: YYYY-MM-DD
updated: YYYY-MM-DD
owners:
  - jarvis
confidence: medium
source_of_truth: raw
source_refs: []
tags:
  - oh-transcript
holders:
  - <founder-slug>      # e.g. people/jane-doe
  - <company-slug>      # e.g. companies/acme-corp
---

# <Founder Name> @ <Company> — <YYYY-MM-DD> OH

## Summary

<1-3 paragraph summary of the conversation; what they're building, what
stage, what the conversation centered on.>

## Holders

- Person: [[people/<founder-slug>]]
- Company: [[companies/<company-slug>]]

## Facts

> **Typed-claim fence (v0.35.7.0)** — when a claim carries a metric
> assertion (MRR, ARR, headcount, runway, burn, CAC, LTV, MAU, DAU,
> churn, revenue, fundraise, gross_margin, users), use the **14-column**
> form below. For prose-only claims (no metric), drop the four typed
> columns. `gbrain eval trajectory <entity>` and `gbrain founder
> scorecard <entity>` ingest these rows.
>
> `claim_metric` normalizes to lowercase snake_case from the closed
> vocabulary above; unknown labels lowercase + underscore-collapse and
> pass through verbatim.

| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|
| 1 | <claim text — e.g. "MRR hit $50K (Jan 2026)"> | fact | 1.0 | private | high | YYYY-MM-DD | | OH transcript | | mrr | 50000 | USD | monthly |
| 2 | <commitment text — e.g. "Targeting $1M ARR by Q4"> | commitment | 0.6 | private | high | YYYY-MM-DD | YYYY-MM-DD | OH transcript | predicted | arr | 1000000 | USD | annual |
| 3 | <prose-only claim — drop 4 typed cols> | fact | 0.8 | private | medium | YYYY-MM-DD | | OH transcript | | | | | |

## Quotes

> Verbatim excerpts worth preserving.
>
> — <Founder>

## Linked entities

<list links to people / companies / concepts surfaced in the
conversation; each `[[path/slug]]` style>

## Linked concepts

<concepts the conversation touched — frameworks, hypotheses, decisions>

## Open questions / follow-ups

- [ ] <question to revisit / experiment to track>

## Source references

- Recording: <local path or URL>
- Transcript ingest: YYYY-MM-DD HH:MM
