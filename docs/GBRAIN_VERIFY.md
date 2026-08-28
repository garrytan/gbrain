# GBrain Installation Verification Runbook

> **One-command equivalent:** `gbrain bootstrap verify` runs the whole install
> contract (round-trip, graph floor, and more) automatically and exits non-zero
> on failure — it is the modern first thing to run after any install. See
> [docs/guides/bootstrap.md](guides/bootstrap.md). This runbook is the
> **manual, deep-verification** companion: use it when `bootstrap verify` fails
> and you need to isolate which layer broke, or when you want to understand
> what "healthy" looks like check by check.

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
- `rls`: enabled on all tables (Postgres/Supabase brains only — PGLite brains
  skip this check; the embedded engine has no remote surface)
- `schema_version`: current
- `embeddings`: coverage percentage

**If it fails:** The doctor output includes specific fix instructions for each
check. See `skills/setup/SKILL.md` Error Recovery table.

### 1a. Migration Plan and DB Probe

**Command:**

```bash
gbrain apply-migrations --list      # per-version status: applied / partial / wedged / pending / future
gbrain apply-migrations --dry-run   # what a real run would apply or resume
```

Both surfaces are read-only — they never run orchestrators or schema
migrations, even when combined with `--yes`. Each prints a `Database:` probe
line above the plan, so an unreachable database is distinguishable from a
clean one (the two used to render the identical all-pending plan):

- `Database: connected, schema vN (latest M)` — the pre-flight probe
  connected. N behind M means schema migrations are pending; a plain run with
  `--yes` applies them.
- `Database: UNREACHABLE (<reason>)` — the pre-flight connect failed. The
  reason is scrubbed through both credential redactors (URL userinfo +
  connection-info), so it is safe to paste into issues and CI logs.
- `Database: not probed (<reason>)` — no probe was attempted. Normal on
  PGLite (`pglite manages schema in-process`): the orchestrators handle the
  schema lifecycle internally there, and the probe would briefly hold the
  single-writer lock.

**Expected:** `Database: connected, schema vN (latest N)` on Postgres, or
`Database: not probed (pglite manages schema in-process)` on PGLite, followed
by `All migrations up to date.`

**If it fails:** an unreachable database does not stop a default run —
orchestrator migrations still run their filesystem-only phases. Scripts and
CI that need a hard signal add `--require-db`: with it, `--list` and
`--dry-run` exit 1 when the probe failed, and a real run prints the probe
line and aborts with exit 1 before any orchestrator runs. The observational
sibling is `gbrain doctor --no-migrate`, which connects probe-only so a
clean-or-behind schema is reported on as-is instead of being auto-migrated
before the health checks run.

---

## 2. Skillpack Loaded

**Check:** Ask the agent: "What is the brain-agent loop?"

**Expected:** The agent describes the read-write cycle documented in
[docs/guides/brain-agent-loop.md](guides/brain-agent-loop.md): detect entities,
read brain, respond with context, write brain, sync.

**If it fails:** The agent hasn't loaded the skillpack. Have it read
`docs/GBRAIN_SKILLPACK.md` (the index) and follow the Core Patterns links.

---

## 3. Auto-Update Configured

**Command:**

```bash
gbrain check-update --json
```

**Expected:** Returns JSON with `current_version`, `latest_version`,
`update_available` (boolean). The cron `gbrain-update-check` is registered.

**If it fails:** See [docs/guides/upgrades-auto-update.md](guides/upgrades-auto-update.md)
for how to register the update-check cron.

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

**If page count is way too low (Supabase/Postgres brains):** The #1 cause is an
unreachable direct connection on an IPv4-only host. (PGLite brains have no
network layer — for them, check that the sync cron/watch is actually running.) GBrain uses the Transaction pooler (port 6543)
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
# Example: fix a line in alice-example's page
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

## 6. Brain-First Lookup Protocol

**Check:** Ask the agent about a person or concept that exists in the brain.

**Expected:** The agent uses `gbrain search` or `gbrain query` FIRST, not grep
or external APIs. The response includes brain-sourced context with source
attribution.

**If it fails:** The brain-first lookup protocol isn't injected into the agent's
system context. See `skills/setup/SKILL.md` Phase D.

---

## 7. Knowledge Graph Wired

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

## 8. JSONB Frontmatter Integrity (v0.12.2)

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

**Bonus check** — the doctor's dedicated JSONB scan agrees:

```bash
gbrain doctor --json | grep -o '"name":"jsonb_integrity"[^}]*'
```

**Expected:** the fragment contains `"status":"ok"` ("All JSONB columns store
objects/arrays"). If it reports double-encoded rows, run `gbrain repair-jsonb`.

---

## Quick Verification (all checks in one pass)

```bash
# 0. The one-command contract check (exits non-zero on failure)
gbrain bootstrap verify

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
