---
name: maintain
version: 1.0.0
description: |
  Brain health checks: back-link enforcement, citation audit, filing validation,
  stale info detection, orphan pages, and benchmarks. Use when asked to check
  brain health, run maintenance, or audit quality.
triggers:
  - "brain health"
  - "check backlinks"
  - "maintenance"
  - "orphan pages"
  - "stale pages"
  - "extract links"
  - "build link graph"
  - "populate timeline"
  - "populate links"
  - "backfill graph"
  - "extract timeline entries"
tools:
  - get_health
  - get_page
  - put_page
  - list_pages
  - get_backlinks
  - add_link
  - search
mutating: true
---

# Maintain Skill

Periodic brain health checks and cleanup.

## Contract

This skill guarantees:
- All health dimensions are checked (stale, orphan, dead links, cross-refs, backlinks, citations, filing, tags)
- Each issue found has a specific fix action
- Back-link iron law is enforced
- Citation format is validated against the standard
- Results are reported with counts per dimension

## Phases

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

### Link graph extraction
If link_count is 0 or low relative to page_count, run batch extraction:
```bash
gbrain extract links --dir ~/brain
```
This scans all markdown files for entity references, See Also sections, and
frontmatter fields, then creates typed links in the database.

### Timeline extraction
If timeline_entry_count is 0, extract structured timeline from markdown:
```bash
gbrain extract timeline --dir ~/brain
```
Parses `- **YYYY-MM-DD** | Source — Summary` and `### YYYY-MM-DD — Title` formats.
Note: extracted entries improve structured queries (`gbrain timeline`), not vector search.

### Autopilot check
Verify autopilot is running:
```bash
gbrain autopilot --status
```
If not running, install it:
```bash
gbrain autopilot --install --repo ~/brain
```
Autopilot runs sync, extract, and embed in a continuous loop with adaptive scheduling.
In v0.11.1+, autopilot dispatches each cycle as a single `autopilot-cycle`
Minion job and supervises the worker child — one install step gives you
sync + extract + embed + backlinks + durable job processing.

### Fix a half-migrated install
A v0.11.0 install where the migration skill never fired leaves Minions
partially set up: schema is applied, but `~/.gbrain/preferences.json`
doesn't exist, autopilot runs inline, host manifests still reference
`agentTurn`. Repair:

```bash
# Check migration status
gbrain apply-migrations --list

# Apply pending migrations (idempotent; safe on healthy installs)
gbrain apply-migrations --yes

# If host-specific handlers are flagged in ~/.gbrain/migrations/pending-host-work.jsonl:
# walk them per skills/migrations/v0.11.0.md + docs/guides/plugin-handlers.md,
# ship handler registrations in the host repo, then re-run apply-migrations.
```

Full troubleshooting guide: `docs/guides/minions-fix.md`.

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

### Graph population (v0.10.3+)

The `links` and `timeline_entries` tables are the structured graph layer.
Populate them periodically or after major imports:

- `gbrain extract links --source db` — backfill structured links by walking pages
  from the engine. Reads `[Name](people/slug)` / `[Name](companies/slug)` references
  and infers relationship types (`attended`, `works_at`, `invested_in`, `founded`,
  `advises`, `mentions`, `source`). Idempotent. Use `--source fs --dir <brain>`
  if you have a markdown checkout to walk instead.
- `gbrain extract timeline --source db` — backfill structured timeline entries.
  Parses `- **YYYY-MM-DD** | summary` lines from page content. Idempotent (DB
  UNIQUE constraint).
- `gbrain extract all --source db` — both in one run.
- `gbrain graph-query <slug> --depth 2` — verify connectivity (use any well-known
  entity slug as a probe).
- `gbrain stats` — verify `link_count > 0` and `timeline_entry_count > 0` after extraction.
- `gbrain health` — review `link_coverage` and `timeline_coverage` percentages
  on entity pages (person/company). Below 50% means more extraction is needed.

Available link types (use with `gbrain graph-query --type`):
`attended`, `works_at`, `invested_in`, `founded`, `advises`, `mentions`, `source`.

Going forward, every `gbrain put` call auto-creates and reconciles links via the
auto-link post-hook (default on; disable: `gbrain config set auto_link false`).
So link-extract is mostly a one-time backfill. timeline-extract should be re-run
after bulk imports or content edits that add new dated entries.

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

## Anti-Patterns

- Fixing pages without reading them first -- you must understand context before editing
- Silently skipping dimensions -- every dimension must be checked and reported, even if clean
- Deleting orphan pages without checking if they should be linked instead
- Running embedding refresh during peak usage hours
- Batch-fixing back-links without verifying the relationship is real
- Marking a dimension "clean" without actually querying it
- Rewriting compiled truth without reading the full timeline first
- Removing tags without checking if other pages use the same tag consistently

## Output Format

The maintenance report follows this structure:

```
## Brain Health Report — YYYY-MM-DD

| Dimension           | Issues Found | Fixed | Remaining |
|----------------------|-------------|-------|-----------|
| Stale pages          | N           | N     | N         |
| Orphan pages         | N           | N     | N         |
| Dead links           | N           | N     | N         |
| Missing cross-refs   | N           | N     | N         |
| Back-link violations | N           | N     | N         |
| Citation gaps        | N           | N     | N         |
| Filing violations    | N           | N     | N         |
| Tag inconsistencies  | N           | N     | N         |
| Embedding staleness  | N           | N     | N         |
| Security (RLS)       | N           | N     | N         |
| Schema health        | N           | N     | N         |
| File storage         | N           | N     | N         |
| Open threads         | N           | N     | N         |

### Details
[Per-dimension breakdown with specific pages and actions taken]

### Benchmark Results (if run)
[Tier 1-4 query results with pass/fail]

### Outstanding Issues
[Items requiring user attention or confirmation]
```

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
