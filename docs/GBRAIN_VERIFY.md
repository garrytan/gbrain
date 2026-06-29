# GBrain Installation Verification Runbook

Run these checks after install to confirm every part of GBrain is working.
Each check includes the command, expected output, and what to do if it fails.

The most important check is #4 (live sync). "Sync ran" is not the same as
"sync worked." A sync that silently skips pages because of a pooler bug is
worse than no sync at all, because you think it's working.

---

## 1. Schema Verification

**Command:**

```bash
gbrain doctor --json
```

**Expected:** All checks return `"ok"`:
- `connection`: connected, N pages
- `pgvector`: extension installed
- `rls`: enabled on all tables
- `schema_version`: current
- `embeddings`: coverage percentage

**If it fails:** The doctor output includes specific fix instructions for each
check. See `skills/setup/SKILL.md` Error Recovery table.

---

## 2. Skillpack Loaded

**Check:** Ask the agent: "What is the brain-agent loop?"

**Expected:** The agent references GBRAIN_SKILLPACK.md Section 2 and describes
the read-write cycle: detect entities, read brain, respond with context, write
brain, sync.

**If it fails:** The agent hasn't loaded the skillpack. Run step 6 from the
install paste (read `docs/GBRAIN_SKILLPACK.md`).

---

## 3. Auto-Update Configured

**Command:**

```bash
gbrain check-update --json
```

**Expected:** Returns JSON with `current_version`, `latest_version`,
`update_available` (boolean). The cron `gbrain-update-check` is registered.

**If it fails:** Run step 7 from the install paste. See GBRAIN_SKILLPACK.md
Section 17.

---

## 4. Live Sync Actually Works

This is the most important check. Three parts.

### 4a. Coverage Check

Compare page count in the DB against syncable file count in the repo:

```bash
gbrain stats
```

Then count syncable files:

```bash
find /data/brain -name '*.md' \
  -not -path '*/.*' \
  -not -path '*/.raw/*' \
  -not -path '*/ops/*' \
  -not -name 'README.md' \
  -not -name 'index.md' \
  -not -name 'schema.md' \
  -not -name 'log.md' \
  | wc -l
```

**Expected:** Page count in `gbrain stats` should be close to the file count.
Some difference is normal (files added since last sync), but if page count is
less than half the file count, sync is silently skipping pages.

**If page count is way too low:** The #1 cause is an unreachable direct
connection on an IPv4-only host. GBrain uses the Transaction pooler (port 6543)
for reads, but routes migrations, DDL, and sync transactions to a derived direct
connection (`db.<ref>.supabase.co:5432`), which is IPv6-only.
- On an IPv4-only host, reads work but sync transactions fail and silently skip
  pages.
- Fix: set `GBRAIN_DIRECT_DATABASE_URL` to the **Session pooler** string (port
  5432 on the `pooler.supabase.com` host, IPv4), or enable Supabase's IPv4
  add-on. Then run `gbrain sync --full` to reimport everything.

### 4b. Embed Check

```bash
gbrain stats
```

**Expected:** Embedded chunk count should be close to total chunk count.

**If embedded is much lower than total:**

```bash
gbrain embed --stale
```

If `OPENAI_API_KEY` is not set, embeddings can't be generated. Keyword search
still works without embeddings, but hybrid/semantic search won't.

### 4c. End-to-End Test

This is the real test. Edit a brain page, push, wait, search.

1. Edit a page in the brain repo (e.g., correct a fact on a person's page):

```bash
# Example: fix a line in Gustaf's page
cd /data/brain
# Make a small edit to any .md file
git add -A && git commit -m "test: verify live sync" && git push
```

2. Wait for the next sync cycle (cron interval or `--watch` poll).

3. Search for the corrected text:

```bash
gbrain search "<text from the correction>"
```

**Expected:** The search returns the **corrected** text, not the old version.

**If it returns old text:** Sync failed silently. Check:
- Is the sync cron registered and running?
- Is `gbrain sync --watch` still alive (if using watch mode)?
- Run `gbrain config get sync.last_run` to see when sync last ran.
- Run `gbrain sync --repo /data/brain` manually and check for errors.
- If sync errors mention an unreachable host or connection timeout, the direct
  connection isn't reachable on IPv4 (see 4a above).

---

## 5. Embedding Coverage

**Command:**

```bash
gbrain stats
```

**Expected:** Embedded chunk count matches (or is close to) total chunk count.

**If zero or very low:** `OPENAI_API_KEY` may be missing or invalid. Check:

```bash
echo $OPENAI_API_KEY | head -c 10
```

If blank, set the key. Then:

```bash
gbrain embed --stale
```

---

## 6. Sequential Doctor Remediation

When full `gbrain doctor` reports `unhealthy`, fix rows in dependency order instead
of chasing the score directly:

1. **Resolver / skillpack checks.** If `resolver_health` reports gaps, validate the
   resolver against the real skill directory first:
   ```bash
   gbrain check-resolvable --json --skills-dir ./skills
   ```
   On Windows, skill frontmatter may be CRLF-normalized; the resolver parser must
   accept both LF and CRLF before treating a skill as missing triggers.
2. **Cycle freshness.** For many stale sources, prefer the source-scoped job path
   over ad-hoc `dream` calls. Submit `autopilot-cycle` with a concrete
   `source_id`, `pull:false`, and non-global phases, then verify
   `sources.config.last_full_cycle_at` moved.
3. **Sync freshness / ledger.** Run source-scoped syncs before touching failure
   ledgers. Retry transient `<head>` / `git HEAD verification failed` sentinels
   with `--no-pull`; only acknowledge intentional file-level failures after
   inspecting the files.
4. **Embedding lag.** After sync/cycle repair, run source-scoped or global stale
   embedding catch-up. If a catch-up says another backfill is running, verify the
   `gbrain-embed-backfill:<source>` lock holder PID before starting another run;
   do not clear a lock unless the exact holder PID is proven dead.
5. **Graph lag and quality warnings.** Once sync and embeddings are current, run
   `gbrain extract --stale` and then address lower-priority content quality rows
   such as frontmatter warnings, graph/timeline coverage, takes, and pack upgrade
   previews.

Repeat `gbrain doctor --json` after each tier. A source can be operationally fresh
while lower-priority content-quality warnings remain; report those separately from
P1 blockers.

For a code repository that is also registered as a GBrain source, re-pin the
source after landing a commit. Use the explicit code strategy so markdown test
fixtures or skill examples do not force the sync path through frontmatter-only
validation:

```bash
gbrain sync --source <source-id> --repo <repo-path> --no-pull --full \
  --workers 1 --yes --strategy code --no-embed --no-extract
gbrain embed --stale --source <source-id> --catch-up
gbrain extract --stale
gbrain status --json
```

The source is current only when `last_commit` equals `git rev-parse HEAD`,
`staleness_class` is `fresh`, and `chunks_unembedded` is `0`.

---

## 7. Brain-First Lookup Protocol

**Check:** Ask the agent about a person or concept that exists in the brain.

**Expected:** The agent uses `gbrain search` or `gbrain query` FIRST, not grep
or external APIs. The response includes brain-sourced context with source
attribution.

**If it fails:** The brain-first lookup protocol isn't injected into the agent's
system context. See `skills/setup/SKILL.md` Phase D.

---

## 8. Knowledge Graph Wired

The v0.12.0 graph layer needs to be populated for existing brains. New writes are
auto-linked, but historical pages need a one-time backfill.

**Command:**

```bash
gbrain stats | grep -E 'links|timeline'
```

**Expected:** Both `links` and `timeline_entries` are non-zero (assuming the brain
has content with entity references and dated markdown).

**If it's zero on a brain with imported content:** Run the backfill.

```bash
gbrain extract links --source db --dry-run | head -5    # preview
gbrain extract links --source db                         # commit
gbrain extract timeline --source db
gbrain stats                                             # confirm > 0
```

**Bonus check** — graph traversal works:

```bash
# Pick any well-connected slug from your brain
gbrain graph-query people/<some-person-slug> --depth 2
```

**Expected:** Indented tree of typed edges (`--attended-->`, `--works_at-->`, etc.).
If the slug has no inbound or outbound links, try a different one or run extract
again.

**If extract finds nothing:** Your pages may not use entity-reference syntax. The
extractor matches `[Name](people/slug)`, `[Name](../people/slug.md)`, and bare
`people/slug` references. If your brain uses a different format, the auto-link
heuristics won't find them — file an issue with a sample page.

---

## 9. JSONB Frontmatter Integrity (v0.12.2)

Postgres-backed brains created before v0.12.2 had double-encoded JSONB columns
(`frontmatter->>'key'` returned NULL, GIN indexes were inert). `gbrain upgrade`
runs `gbrain repair-jsonb` automatically via the `v0_12_2` orchestrator.
Verify the repair succeeded.

**Command:**

```bash
gbrain repair-jsonb --dry-run --json
```

**Expected:** `totalRepaired: 0` across all 5 columns (`pages.frontmatter`,
`raw_data.data`, `ingest_log.pages_updated`, `files.metadata`,
`page_versions.frontmatter`). A zero count means every row is properly-typed
JSON objects, not string-encoded JSON.

**If the count is > 0:** The repair didn't run or was interrupted. Re-run
without `--dry-run`:

```bash
gbrain repair-jsonb
```

Idempotent. PGLite brains always report 0 (unaffected by the original bug).

**Bonus check** — frontmatter-keyed queries actually resolve:

```bash
gbrain call list_pages '{"frontmatterKey": "type", "frontmatterValue": "person"}'
```

If this returns rows on a brain with person pages, the JSONB path is healthy.

---

## Quick Verification (all checks in one pass)

```bash
# 1. Schema
gbrain doctor --json

# 2. Sync recency
gbrain config get sync.last_run

# 3. Page count + embed coverage
gbrain stats

# 4. Search works
gbrain search "test query from your brain content"

# 5. Catch any unembedded chunks
gbrain embed --stale

# 6. Auto-update
gbrain check-update --json

# 7. Knowledge graph populated (links + timeline > 0)
gbrain stats | grep -E 'links|timeline'

# 8. JSONB integrity (v0.12.2 — Postgres only, PGLite always 0)
gbrain repair-jsonb --dry-run --json
```

If all eight return successfully, the installation is healthy. For the full
end-to-end sync test (4c), push a real change and verify it appears in search.
