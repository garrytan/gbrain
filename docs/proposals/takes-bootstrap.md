# Proposal: Takes Bootstrap from Existing Content

## Problem

The takes system in gbrain — typed claims with weights, calibration tracking, and attribution — has full infrastructure but zero data in production. Despite being fully supported in the schema and having CLI commands, no agent or workflow ever populates it because there's no automated bootstrap path.

The brain contains thousands of concept pages, atom pages, and lore entries that are rich with claims, opinions, and predictions. These exist as unstructured text but aren't captured as takes.

### Scale of Impact

| Metric | Value |
|--------|-------|
| Total pages | ~165,000 |
| Takes in the brain | 0 |
| Concept/atom/lore pages (estimated) | ~2,000+ |
| Claims embedded in those pages | Thousands |

## Proposed Solution

### Takes Extraction from Existing Pages

Add `gbrain takes extract --from-pages` that scans content-rich pages and extracts structured claims.

### How It Works

1. **Scan eligible pages**: concept, atom, lore, and analysis page types
2. **Identify claims**: Statements that express a position, prediction, observation, or fact
3. **Classify each claim** by kind:
   - `fact`: Verifiable statement ("Acme has 500 customers")
   - `take`: Opinion or analysis ("Remote work will become the default")
   - `bet`: Prediction with implicit timeline ("AI will replace 30% of coding by 2026")
   - `hunch`: Low-confidence intuition ("Something feels off about this market")
4. **Extract metadata**:
   - Claim text
   - Attribution (who said/wrote it, if identifiable)
   - Source page
   - Optional weight (0.0-1.0 confidence)
   - Tags/topics
5. **Store as takes** in the brain's takes system

### CLI Interface

```bash
# Bootstrap takes from all concept/atom/lore pages
gbrain takes extract --from-pages

# Extract from specific page types
gbrain takes extract --from-pages --type concept,atom

# Dry run to preview extractions
gbrain takes extract --from-pages --dry-run

# Extract with a specific confidence threshold
gbrain takes extract --from-pages --min-confidence 0.6

# Extract takes from a specific page
gbrain takes extract --from-page "concepts/remote-work-thesis"
```

### Schema Pack Integration

Schema packs should be able to declare:
1. **Custom takes kinds** (already supported)
2. **Extraction rules per type**: which page types to scan, what patterns indicate claims

```yaml
takes:
  kinds:
    - fact
    - take
    - bet
    - hunch
    - thesis  # custom kind
  extraction:
    eligible_types:
      - concept
      - atom
      - lore
      - analysis
    patterns:
      bet: ["will", "by 20\\d{2}", "predict", "expect"]
      take: ["should", "believe", "think", "argue"]
      hunch: ["might", "could", "feels like", "wonder if"]
```

### Dream Cycle Integration

Add a takes extraction step to the dream cycle for recently-modified pages:

```
dream cycle:
  ...
  6. extract takes (new) — only for recently modified concept/atom/lore pages
```

## Agent Onboarding

### Features Detection

`gbrain features` should detect zero takes:

```
ℹ Takes system: 0 takes recorded
  Your brain has ~2,000 concept/atom/lore pages with extractable claims.
  Run `gbrain takes extract --from-pages` to bootstrap the claims system.
```

### Migration Prompt

```
Your brain has 2,000+ concept/atom pages but 0 takes.
Run `gbrain takes extract --from-pages` to bootstrap the claims system? [y/N]
```

## Evidence

The production brain has a fully functional takes system — the schema supports it, the CLI commands exist, the storage is ready. But zero takes have been recorded because:
1. No agent workflow includes takes extraction
2. No dream cycle step populates takes
3. Manual takes entry is too high-friction for daily use
4. There's no bootstrap command to seed from existing content

Meanwhile, the brain's concept and atom pages contain hundreds of extractable claims that would make the takes system immediately useful for calibration tracking and knowledge synthesis.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Low-quality extractions | Confidence threshold, dry-run preview, review mode |
| Duplicate takes from overlapping pages | Dedup by claim similarity |
| Misclassified claim types | Allow reclassification, learn from corrections |
| Attribution errors | Default to page author, flag uncertain attributions |
