# Proposal: Smart Embed Scheduling (Stale Page Catch-Up)

## Problem

`gbrain embed --stale` processes pages one at a time with no prioritization. In a production brain with 165K+ pages, the stale embedding backlog can grow to 24K+ pages. The daily cron runs `gbrain embed --stale` but can only process a fraction of the backlog before timing out or hitting rate limits, meaning the brain falls further behind every day.

Stale embeddings mean semantic search returns outdated results — a page that was updated last week still has embeddings from its original content. For brains that rely on semantic search for entity resolution, content discovery, and agent workflows, this is a silent quality degradation.

### Scale of Impact

| Metric | Value |
|--------|-------|
| Total pages | ~165,000 |
| Stale pages (outdated embeddings) | ~24,700 (15%) |
| Daily cron throughput | ~500-1000 pages |
| Days to clear backlog at current rate | 25-50 days |

## Proposed Solution

### 1. Prioritized Batch Processing

Add `--priority` flag to `gbrain embed --stale`:

```bash
# Process stale pages, most recently modified first
gbrain embed --stale --batch-size 500 --priority recent

# Process stale pages, oldest embeddings first  
gbrain embed --stale --batch-size 500 --priority oldest

# Process stale pages for a specific type first
gbrain embed --stale --batch-size 500 --priority-type company,person
```

### 2. Catch-Up Mode

Add `gbrain embed --catch-up` that runs until all stale pages are processed:

```bash
# Process ALL stale pages with rate limiting
gbrain embed --catch-up --rate-limit 100/min

# Catch up with a specific concurrency
gbrain embed --catch-up --concurrency 5

# Catch up but stop after N pages (resume later)
gbrain embed --catch-up --max 5000
```

### 3. Dream Cycle Auto-Escalation

The dream cycle should monitor the stale count and automatically escalate:

```
Stale count < 100:   normal batch (default --batch-size)
Stale count 100-1K:  2x batch size
Stale count 1K-10K:  5x batch size + warning in doctor
Stale count > 10K:   10x batch size + alert
```

### Implementation Notes

- Batch processing should use concurrent embedding calls where the provider supports it
- Rate limiting should respect the embedding provider's limits (configurable)
- Progress reporting: show a progress bar or periodic status during catch-up mode
- Interruption handling: catch-up mode should be safely interruptible (Ctrl+C) and resumable
- Track last-processed page so catch-up can resume where it left off

## Agent Onboarding

### Doctor Detection

`gbrain doctor` should flag stale counts:

```
⚠ 24,712 pages have stale embeddings (15% of total)
  Semantic search quality is degraded for these pages.
  Run `gbrain embed --catch-up` to refresh all stale embeddings.
  Estimated time: ~2 hours at default rate.
```

### Migration Prompt (on upgrade)

```
You have 24,712 stale embeddings.
Run `gbrain embed --catch-up` to refresh them? 
This may take a while depending on your embedding provider. [y/N]
```

## Evidence

In the production brain, the stale count grew from 0 to 24K over several months because:
1. Pages are modified frequently (meeting notes, company updates, etc.)
2. The daily cron only processes ~500-1000 pages per run
3. No alerting existed to warn the operator about the growing backlog
4. The operator discovered the issue only after noticing degraded search results

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| High API costs during catch-up | `--rate-limit` flag, `--max` flag to cap per-run |
| Provider rate limiting | Built-in backoff, configurable concurrency |
| Long-running catch-up blocking other operations | Run in background, interruptible, progress saved |
