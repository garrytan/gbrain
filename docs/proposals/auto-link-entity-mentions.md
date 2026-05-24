# Proposal: Auto-Link Entity Mentions (Orphan Reduction)

## Problem

In a production brain with 165K+ pages, approximately 88% of pages are orphans — they have zero inbound links. This happens because the current link extraction only recognizes explicit markdown links (`[Name](path)`). When a page mentions an entity by name in body text (e.g., "we discussed Acme Corp's growth trajectory"), no link is created.

This means the vast majority of a brain's knowledge graph is disconnected, making it impossible to traverse relationships, find related content, or build meaningful entity profiles through link analysis.

### Scale of Impact

| Metric | Value |
|--------|-------|
| Total pages | ~165,000 |
| Orphan pages (0 inbound links) | ~146,000 (88%) |
| Entity link coverage | ~32% |

## Proposed Solution

Add a `link-by-mention` pass in the dream/extract cycle that creates `mentions` links from text references to known entities.

### How It Works

1. **Build a gazetteer** from existing entity pages (person, company, etc.): collect each entity's title + aliases from frontmatter
2. **Scan recently-synced pages** for text mentions of those entity names using case-insensitive fuzzy matching
3. **Create `mentions` links** from the mentioning page to the mentioned entity page, with deduplication to avoid duplicates
4. **Gate behind a config flag**: `gbrain config set auto_link_mentions true`

### CLI Interface

```bash
# One-time backfill for existing pages
gbrain extract links --by-mention

# Enable ongoing auto-linking in dream cycle
gbrain config set auto_link_mentions true

# Dry run to preview what would be linked
gbrain extract links --by-mention --dry-run
```

### Implementation Notes

- The gazetteer is built from the brain's own pages — no external NER model needed for this pass
- Fuzzy matching should handle common variations (e.g., "Acme" matching "Acme Corp", "Acme Corporation")
- Dedup ensures running the command multiple times is safe (idempotent)
- Performance: process in batches; for 165K pages, scanning all pages could take time so support `--batch-size` and `--since` flags

## Agent Onboarding

### Doctor Detection

`gbrain doctor` should detect orphan ratio >50% and surface a recommendation:

```
⚠ High orphan ratio: 88% of pages have no inbound links
  Recommendation: Run `gbrain extract links --by-mention` to create links from text mentions
  Or enable auto-linking: `gbrain config set auto_link_mentions true`
```

### Fresh Install

On fresh install, the setup wizard should ask:
```
Would you like to enable automatic entity mention linking? 
This creates links when pages mention known entities by name. [y/N]
```

### Migration Prompt (v0.41+)

Add a one-time migration that runs after upgrade:

```
Your brain has 88% orphan pages. 
Run `gbrain extract links --by-mention` to create links from text mentions? [y/N]
```

The migration records completion in the `kv` table so it doesn't prompt again.

## Evidence

This proposal is based on production data from a 165K-page brain where orphan pages accumulated over months of operation. The operator discovered the issue only after running `gbrain doctor` — by then, 146K pages had no connections despite being rich with entity references in their body text.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| False positive matches (e.g., "Apple" the fruit vs "Apple" the company) | Require minimum name length, prefer exact matches, allow an ignore list |
| Performance on large brains | Batch processing, `--since` flag for incremental runs |
| Link spam on frequently-mentioned entities | Cap mentions per source page, or only link first mention |
