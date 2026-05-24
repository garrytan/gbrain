# Proposal: NER-Based Entity Link Extraction

## Problem

A production brain with 165K+ pages and a custom schema pack (30 types, 8 link verbs) has only 32% entity link coverage — meaning 68% of entities have no typed links at all. The schema pack defines rich relationship verbs (`works_at`, `founded`, `invested_in`, `advises`, etc.) but the data isn't populated because typed link extraction only works when frontmatter explicitly declares the relationship.

Body text is full of implicit relationships: "Alice is the CEO of Acme Corp", "Bob invested in Acme's Series A", "Alice previously worked at BigCo". None of these become typed links today.

### Scale of Impact

| Metric | Value |
|--------|-------|
| Total pages | ~165,000 |
| Entity link coverage | ~32% |
| Entities with zero typed links | ~68% |
| Schema verbs defined but underused | 8 |

## Proposed Solution

### NER Extraction Using the Brain's Own Gazetteer

Rather than adding an external NER model dependency, use the brain's own entity pages as the gazetteer:

1. **Build entity index**: Collect all person and company page titles + aliases
2. **Scan page body text** for co-occurrences of entities with relationship signals
3. **Extract typed links** based on context clues:
   - "CEO of Acme" → `works_at` (with role annotation)
   - "founded Acme" → `founded`
   - "invested in Acme" → `invested_in`
   - "advisor to Acme" → `advises`
   - "acquired by BigCo" → `acquired_by`
4. **Create links** with confidence scores; only auto-create above threshold

### CLI Interface

```bash
# Extract typed links from all pages
gbrain extract links --ner

# Extract from specific page types only
gbrain extract links --ner --type meeting,company

# Dry run to preview extractions
gbrain extract links --ner --dry-run

# Only extract specific verb types
gbrain extract links --ner --verbs works_at,founded

# Set confidence threshold (default: 0.7)
gbrain extract links --ner --threshold 0.8
```

### Relationship Pattern Matching

The extraction engine should recognize common patterns per verb type:

| Verb | Patterns |
|------|----------|
| `works_at` | "CEO of X", "engineer at X", "joined X", "works at X" |
| `founded` | "founded X", "co-founded X", "started X in 2020" |
| `invested_in` | "invested in X", "led X's Series A", "backed X" |
| `advises` | "advisor to X", "advises X", "on X's board" |
| `acquired_by` | "acquired by X", "bought by X", "X acquired" |

### Schema Pack Integration

Schema packs should be able to declare custom extraction patterns per verb:

```yaml
verbs:
  works_at:
    extraction_patterns:
      - "{person} is (the )?(CEO|CTO|COO|VP|engineer|designer) (of|at) {company}"
      - "{person} (joined|works at|leads) {company}"
```

## Agent Onboarding

### Features Detection

`gbrain features` should detect low link coverage:

```
⚠ Entity link coverage: 32%
  Your schema defines 8 relationship verbs but 68% of entities have no typed links.
  Run `gbrain extract links --ner` to extract relationships from page text.
```

### Migration Prompt

```
Entity link coverage is 32%.
Run `gbrain extract links --ner` to extract typed links from page text? [y/N]
```

## Evidence

The production brain has a fully installed schema pack with 30 types and 8 link verbs. The infrastructure for typed links is complete — the data just isn't there because no automated extraction exists. Meeting notes, company profiles, and person pages all contain relationship information in natural language that could be extracted.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| False positive relationships | Confidence threshold, dry-run mode, manual review option |
| Ambiguous entity names | Prefer longer/more specific matches, use page context |
| Pattern fragility | Schema-declared patterns allow customization per deployment |
| Performance on large brains | Batch processing, incremental (only scan modified pages) |
