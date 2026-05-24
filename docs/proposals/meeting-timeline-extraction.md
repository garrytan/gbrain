# Proposal: Timeline Extraction from Meeting Transcripts

## Problem

In a production brain with 165K+ pages, 31% of entities have no timeline entries at all. Meeting transcripts and notes discuss entities extensively — milestones, decisions, status changes — but none of this becomes structured timeline data on the entity pages.

The timeline system exists and works well when populated manually, but there's no automated path from "we discussed Acme's launch date" in a meeting transcript to a timeline entry on Acme's page.

### Scale of Impact

| Metric | Value |
|--------|-------|
| Total pages | ~165,000 |
| Timeline coverage | ~69% |
| Entities with zero timeline entries | ~31% |
| Meeting/transcript pages (estimated) | ~5,000+ |

## Proposed Solution

### Meeting-to-Timeline Extraction

Add a timeline extraction pass to the dream cycle that processes meeting transcripts and creates timeline entries on discussed entity pages.

### How It Works

1. **Identify meeting pages**: Pages with type `meeting`, `transcript`, or `note` that have a date in frontmatter
2. **Extract entity mentions**: Find references to known entities (people, companies) in the meeting text
3. **Identify timeline-worthy events**: Look for temporal markers and significant events:
   - Milestones: "launched", "raised Series A", "hit $1M ARR"
   - Decisions: "decided to pivot", "chose to expand to Europe"  
   - Status changes: "promoted to CTO", "left the company"
   - Plans: "planning to launch in Q3", "targeting 100 customers by EOY"
4. **Create timeline entries** on the entity pages with:
   - Date (from meeting date or extracted temporal reference)
   - Event description
   - Source link back to the meeting page
   - Confidence score

### CLI Interface

```bash
# Extract timeline entries from all meeting pages
gbrain extract timeline --from-meetings

# Process only recent meetings
gbrain extract timeline --from-meetings --since 2024-01-01

# Dry run to preview extractions
gbrain extract timeline --from-meetings --dry-run

# Process specific meeting pages
gbrain extract timeline --from-meetings --page "meetings/2024-03-15-acme-oh"
```

### Timeline Entry Format

```yaml
timeline:
  - date: 2024-03-15
    event: "Launched v2.0 of their product"
    source: "meetings/2024-03-15-weekly-review"
    extracted: true
    confidence: 0.85
```

### Dream Cycle Integration

The dream cycle should include a timeline extraction step for recently-synced meeting pages:

```
dream cycle:
  1. sync
  2. extract links
  3. extract timeline (new)
  4. embed
  5. score
```

## Agent Onboarding

### Doctor Detection

`gbrain doctor` should detect low timeline coverage:

```
⚠ Timeline coverage: 69%
  31% of entities have no timeline entries.
  You have ~5,000 meeting pages that could provide timeline data.
  Run `gbrain extract timeline --from-meetings` to backfill.
```

### Migration Prompt

```
Timeline coverage is 69%. 
Run `gbrain extract timeline --from-meetings` to backfill 
timeline entries from meeting transcripts? [y/N]
```

## Evidence

The production brain has thousands of meeting transcripts spanning months of operation. Each meeting discusses multiple entities — companies, people, deals — with temporal context. This information exists but is locked in unstructured text. Meanwhile, entity pages have empty timeline sections that could be rich with history if extraction existed.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Incorrect date extraction | Default to meeting date, flag uncertain dates |
| Duplicate timeline entries | Dedup by date + entity + event similarity |
| Low-quality extractions from noisy transcripts | Confidence threshold, dry-run preview |
| Performance with many meetings | `--since` flag for incremental processing |
