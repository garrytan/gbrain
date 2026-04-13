# Maintain Skill

Periodic brain health checks and cleanup.

## Workflow

1. **Run health check.** Check gbrain health to get the dashboard.
2. **Check each dimension:**

### Stale pages
Pages where compiled_truth is older than the latest timeline entry. The assessment hasn't been updated to reflect recent evidence.
- Check the health output for stale page count
- For each stale page: read the page from gbrain, review timeline, determine if compiled_truth needs rewriting

### Orphan pages
Pages with zero inbound links. Nobody references them.
- Review orphans: are they genuinely isolated or just missing links?
- Add links in gbrain from related pages or flag for deletion

### Dead links
Links pointing to pages that don't exist.
- Remove dead links in gbrain

### Missing cross-references
Pages that mention entity names but don't have formal links.
- Read compiled_truth from gbrain, extract entity mentions, create links in gbrain

### Back-link enforcement
Check that the back-linking iron law is being followed:
- For each recently updated page, check if entities mentioned in it have
  corresponding back-links FROM those entity pages
- A mention without a back-link is a broken brain
- Fix: add the missing back-link to the entity's Timeline or See Also section
- Format: `- **YYYY-MM-DD** | Referenced in [page title](path) -- brief context`

### Filing rule violations
Check for common misfiling patterns (see `skills/_brain-filing-rules.md`):
- Content with clear primary subjects filed in `sources/` instead of the
  appropriate directory (people/, companies/, concepts/, etc.)
- Use gbrain search to find pages in `sources/` that reference specific
  people, companies, or concepts -- these may be misfiled
- Flag misfiled pages for review or re-filing

### Citation audit
Spot-check pages for missing `[Source: ...]` citations:
- Read 5-10 recently updated pages
- Check that compiled truth (above the line) has inline citations
- Check that timeline entries have source attribution
- Flag pages where facts appear without provenance

### Tag consistency
Inconsistent tagging (e.g., "vc" vs "venture-capital", "ai" vs "artificial-intelligence").
- Standardize to the most common variant using gbrain tag operations

### Embedding freshness
Chunks without embeddings, or chunks embedded with an old model.
- For large embedding refreshes (>1000 chunks), use nohup:
  `nohup gbrain embed refresh > /tmp/gbrain-embed.log 2>&1 &`
- Then check progress: `tail -1 /tmp/gbrain-embed.log`

### Security (RLS verification)
Run `gbrain doctor --json` and check the RLS status.
All tables should show RLS enabled. If not, run `gbrain init` again.

### Schema health
Check that the schema version is up to date. `gbrain doctor --json` reports
the current version vs expected. If behind, `gbrain init` runs migrations
automatically.

### File storage health
Check the integrity of stored files and redirect pointers:
- Run `gbrain files verify` to check all DB records have valid data
- Run `gbrain files status` to see migration state (local, mirrored, redirected)
- Check for orphan `.redirect.yaml` pointers that reference missing storage files
- Check for large binary files (>= 100 MB) still in git that should be in cloud storage
- If storage backend is configured: verify redirect pointers resolve (download test)

### Open threads
Timeline items older than 30 days with unresolved action items.
- Flag for review

## Benchmark Testing

Periodically verify search quality hasn't regressed. Run a battery of test
queries across difficulty tiers:

- **Tier 1 (entity lookup):** known names -- should always resolve
- **Tier 2 (topic recall):** concepts, topics -- keyword search should handle
- **Tier 3 (semantic):** queries with no exact keyword match -- needs embeddings
- **Tier 4 (cross-domain):** relational/connection queries -- only semantic handles

Compare results from `gbrain search` (keyword) vs `gbrain query` (hybrid).
Quality matters more than speed (2.5s right > 200ms wrong).

When to run benchmarks:
- After major brain imports or re-imports
- After gbrain version upgrades
- After embedding regeneration
- Monthly to track quality drift

## Heartbeat Integration

For production agents running on a schedule, integrate gbrain health checks into
your operational heartbeat.

### On every heartbeat (hourly or per-session)

Run `gbrain doctor --json` and check for degradation. Report any failing checks
to the user. Key signals: connection health, schema version, RLS status, embedding
staleness.

### Weekly maintenance

Run `gbrain embed --stale` to refresh embeddings for pages that have changed since
their last embedding. For large brains (>5000 pages), run this with nohup:
```bash
nohup gbrain embed --stale > /tmp/gbrain-embed.log 2>&1 &
```

### Daily verification

Verify sync is running: check `gbrain stats` and confirm `last_sync` is within
the last 24 hours. If sync has stopped, the brain is drifting from the repo.

### Stale compiled truth detection

Flag pages where compiled truth is >30 days old but the timeline has recent entries.
This means new evidence exists that hasn't been synthesized. These pages need a
compiled truth rewrite (see the maintain workflow above).

## Report Storage

After maintenance runs, save a report:
- Health check results (before/after scores for each dimension)
- Back-link violations found and fixed
- Filing rule violations found
- Citation gaps flagged
- Benchmark results (if run)
- Outstanding issues requiring user attention

This creates an audit trail for brain health over time.

## Quality Rules

- Never delete pages without confirmation
- Log all changes via timeline entries
- Check gbrain health before and after to show improvement

## Tools Used

- Check gbrain health (get_health)
- List pages in gbrain with filters (list_pages)
- Read a page from gbrain (get_page)
- Check backlinks in gbrain (get_backlinks)
- Link entities in gbrain (add_link)
- Remove links in gbrain (remove_link)
- Tag a page in gbrain (add_tag)
- Remove a tag in gbrain (remove_tag)
- View timeline in gbrain (get_timeline)
