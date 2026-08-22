# Live Sync: Keep the Index Current

## Goal

Every markdown change in the brain repo is searchable within minutes, automatically, with no manual intervention.

## What the User Gets

Without this: you correct a hallucination in a brain page, but the vector DB
keeps serving the old text because nobody ran `gbrain sync`. Stale search
results erode trust. The brain becomes unreliable.

With this: edits show up in search within minutes. The vector DB stays current
with the brain repo automatically. You never have to remember to run sync.

## Implementation

### Prerequisite: a reachable direct connection

GBrain is tuned for the Supabase **Transaction pooler** (port 6543): it
auto-disables prepared statements there and routes `engine.transaction()`
(migrations, DDL, sync imports) to a derived **direct** connection
(`db.<ref>.supabase.co:5432`). That direct host is IPv6-only, so on an
IPv4-only host it is unreachable. When that happens gbrain now falls back to
the pooler automatically (one stderr warning, then single-pool mode for the
rest of the process) — but the pooler's ~2-min statement timeout can truncate
very long migrations or bulk imports.

Fix: make the direct connection reachable over IPv4. Either set
`GBRAIN_DIRECT_DATABASE_URL` to the **Session pooler** string (port 5432 on the
`pooler.supabase.com` host, IPv4), or enable Supabase's IPv4 add-on.
`GBRAIN_DISABLE_DIRECT_POOL=1` skips the direct pool (and the fallback warning)
entirely. Verify by running `gbrain sync` and checking that the page count in
`gbrain stats` matches the syncable file count in the repo.

### The Primitives

Always chain sync + embed:

```bash
gbrain sync --repo /path/to/brain && gbrain embed --stale
```

- `gbrain sync --repo <path>` -- one-shot incremental sync. Detects changes via
  `git diff`, imports only what changed. **Commit-driven:** it imports
  *committed* changes; uncommitted edits and untracked files are counted and
  reported as drift, not silently ignored (see Tricky Spot 6). For small
  changesets (<= 100 files), embeddings are generated inline during import —
  unless the inline cost gate intervenes: when the estimated embedding spend
  crosses the configured floor in a non-interactive session (cron, `--json`),
  sync auto-defers embeds to a capped `embed-backfill` job instead of spending
  silently. Either way the chunks get embedded; a deferred run just finishes
  asynchronously. See [spend controls](../operations/spend-controls.md).
- `gbrain embed --stale` -- backfill embeddings for any chunks that don't have
  them. Safety net for large syncs (>100 files) or prior `--no-embed` runs.
  On a keyless brain (installed with `--no-embedding`), a bare stale embed
  refuses cleanly — exit 0 with a stderr note — so this chain is safe to
  schedule on keyless installs; keyword search keeps working. Explicit embed
  requests (a slug, `--slugs`, `--all`) still exit 1 on a keyless brain.
- `gbrain sync --watch --repo <path>` -- foreground polling loop, every 60s
  (configurable with `--interval N`). Embeds inline for small changesets. Exits
  after 5 consecutive failures, so run under a process manager or pair with a
  cron fallback.

### Approach 1: Cron Job (recommended)

Run every 5-30 minutes. Works with any cron scheduler.

```bash
gbrain sync --repo /data/brain && gbrain embed --stale
```

**OpenClaw:**
```
Name: gbrain-auto-sync
Schedule: */15 * * * *
Prompt: "Run: gbrain sync --repo /data/brain && gbrain embed --stale
  Log the result. If sync errors mention an unreachable host or timeout,
  the direct connection isn't reachable over IPv4 (set
  GBRAIN_DIRECT_DATABASE_URL to the Session pooler, or enable the IPv4 add-on)."
```

**Hermes:**
```
/cron add "*/15 * * * *" "Run gbrain sync --repo /data/brain &&
  gbrain embed --stale. Log the result." --name "gbrain-auto-sync"
```

### Approach 2: Long-Lived Watcher

For near-instant sync (60s polling). Run under a process manager that
auto-restarts on exit. Pair with a cron fallback since `--watch` exits
on repeated failures.

```bash
gbrain sync --watch --repo /data/brain
```

### Approach 3: Git Hook / Webhook

Triggers sync on push events for instant sync (<5s).

- **GitHub webhook:** Set up the webhook to call
  `gbrain sync --repo /data/brain && gbrain embed --stale`.
  Verify `X-Hub-Signature-256` against a shared secret.
- **Git post-receive hook:** If the brain repo is on the same machine.

### What Gets Synced

Sync only indexes "syncable" markdown files. These are excluded by design:
- Hidden paths (`.git/`, `.raw/`, etc.) and vendored/generated trees
  (`node_modules/`, `dist/`, `build/`, `venv/`)
- Meta files: `README.md`, `index.md`, `schema.md`, `log.md`, `RESOLVER.md`

Everything else is ordinary synced content — including `ops/` (the bundled
daily-task-manager skill files its canonical page under `ops/tasks`).

### Sync is Idempotent — and Resumable

Concurrent runs are safe. Two syncs on the same commit no-op because content
hashes match. If both a cron and `--watch` fire simultaneously, no conflict.

Long syncs also survive being killed: progress checkpoints into the database
as files drain, so a killed or aborted run resumes from where it stopped, and
the sync bookmark only advances on true completion. A progress-aware stall
watchdog (`GBRAIN_SYNC_STALL_ABORT_SECONDS`, default 900, `0` disables) aborts
a run that stops making forward progress and releases the per-source lock so
the next `gbrain sync` picks up from the checkpoint. The checkpoint cadence
and lock-steal grace are tunable via `GBRAIN_SYNC_*` / `GBRAIN_LOCK_*` env
vars — incident-time escape hatches, not everyday knobs.

## Tricky Spots

1. **Always chain sync + embed.** Running `gbrain sync` without
   `gbrain embed --stale` leaves new chunks without embeddings. They exist
   in the database but are invisible to vector search. Always run both
   commands together. The `&&` ensures embed only runs if sync succeeds.

2. **--watch polls, it doesn't stream.** The `--watch` flag polls every 60s
   (configurable). It is not a filesystem watcher or git hook. It exits after
   5 consecutive failures, so it needs a process manager (systemd, pm2) or a
   cron fallback to stay alive. Don't assume it runs forever.

3. **Webhook needs the server running.** If you use a GitHub webhook for
   instant sync, the receiving server must be running and reachable. If the
   server is down when a push happens, that sync is missed. Pair webhooks
   with a cron fallback that catches anything the webhook missed.

4. **A single un-parseable file can't wedge all indexing.** When a file fails
   to import (malformed YAML frontmatter, an unquoted colon, etc.), sync holds
   the bookmark and tells you exactly which file broke — a *fresh* failure
   fails closed so nothing is silently dropped. But a file that fails the same
   way `GBRAIN_SYNC_AUTOSKIP_AFTER` consecutive syncs (default 3, set `0` to
   disable) is auto-skipped so the rest of the brain keeps indexing past it.
   Skipped files don't disappear: `gbrain doctor` keeps warning until you fix
   or delete them, and fixing the file clears it on the next sync. A repository
   history rewrite still hard-blocks even with `--skip-failed`. Run
   `gbrain sync --skip-failed` to acknowledge a known-bad set yourself.

5. **Staleness can't read "fresh" forever.** A source whose content stopped
   moving (or whose local clone vanished) used to report fresh indefinitely
   off the stored content timestamp. Content-relative staleness now ramps
   toward stale once wall-clock time since the last sync passes a ceiling
   (default 72h; `GBRAIN_STALENESS_CEILING_HOURS` to tune — it tracks
   `GBRAIN_SYNC_FRESHNESS_FAIL_HOURS` unless set). The ramp is gradual, so
   the warn tier still fires before the fail tier. `gbrain status` source
   rows carry `hours_since_last_sync` (raw wall-clock truth) alongside the
   threshold-relative `staleness_hours` that drives the fresh/stale class.

6. **Import checkpoints name the import target, not the caller's CWD.**
   Interrupted `gbrain import <dir>` runs may leave
   `~/.gbrain/import-checkpoint.json` so the next import can resume. The
   checkpoint `dir` is the absolute, resolved import target captured when
   import starts. It is not a cleanup instruction and it must not be
   re-derived from the process working directory. Checkpoints written by
   gbrain include `schema_version: 1`, `owner: "gbrain"`, and
   `kind: "import"` so downstream tools can validate the contract before
   deciding whether to resume.

6. **Sync imports commits, not your working tree.** Files written into the
   brain repo but never committed are invisible to incremental sync. Sync
   won't stay silent about them: it prints a NOTE with the drift counts
   (`N uncommitted file(s) not synced`), the sync result object carries an
   `uncommitted` summary (surfaced via `sync_brain` over MCP and in
   `gbrain dream --json` phase details), and the nightly dream cycle reports
   the sync phase as `warn` instead of a clean run. The fix is to commit the files. If your
   workflow legitimately writes without committing, opt in to importing
   uncommitted state with `gbrain sync --working-tree` (one run) or
   `gbrain config set sync.include_working_tree true` (standing config,
   honored by every caller including the dream cycle). Caution before making
   it standing config: untracked means everything `git status` lists as
   untracked — unignored scratch files and secrets included — so review
   `git status` first. Gitignored files stay excluded either way (use
   `--include-gitignored` for those).

## How to Verify

1. **Edit a file and search for the change.** Edit a brain markdown file,
   commit, and push. Wait for the next sync cycle (cron interval or `--watch`
   poll). Run `gbrain search "<text from the edit>"`. The updated content
   should appear in results. If it returns old content, sync failed.

2. **Compare page count to file count.** Run `gbrain stats` and count the
   syncable markdown files in the brain repo. The page count in the database
   should match. If they diverge, files are being silently skipped (likely an
   unreachable direct connection on IPv4 — see the prerequisite above).

3. **Check embedded chunk count.** In `gbrain stats`, the embedded chunk
   count should be close to the total chunk count. A large gap means
   `gbrain embed --stale` isn't running after sync, leaving chunks invisible
   to vector search.

4. **Gate on the daemon's heartbeat.** If the built-in daemon runs your sync
   (`gbrain autopilot --install`), wire your scheduler's health check to
   `gbrain autopilot --status`. The exit code is the signal: 0 fresh (or
   nothing installed), 1 needs attention (stale heartbeat, never ran, or
   paused by a migration), 2 the daemon took itself out of rotation.
   `--json` emits the full report, including `heartbeat_age_seconds`. Status
   reads only the filesystem — no database connection — so it keeps working
   during the exact outages it exists to diagnose.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
