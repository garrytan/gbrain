# Live Sync: Keep the Index Current

## Goal

Every markdown change in the brain repo is searchable within minutes, automatically, with no manual intervention.

## What the User Gets

Without this: you correct a hallucination in a brain page, but the vector DB
keeps serving the old text because nobody ran `gbrain sync`. Stale search
results erode trust. The brain becomes unreliable.

With this: edits show up in search within minutes. The vector DB stays current
with the brain repo automatically. You never have to remember to run sync.

## Catching up a large backlog on managed Postgres

On a managed brain (managed persistence on, Postgres), every changed file
publishes through its own durable write request, in manifest order. One
command drains the whole backlog:

```bash
gbrain sync --source <id> --no-pull --json
```

`--no-pull` is required on managed brains: the checkout is fast-forwarded by
`gbrain sources refresh <id>`, never by sync. Sync then catches the index up
to whatever the checkout holds.

The run prints one line before the first write and a progress line about
every 10 seconds on stderr:

```
[sync] managed catch-up: 9382 entries frozen, 9382 remaining; publishing in bulk groups (each page keeps its own request).
[sync] 1240/9382 processed (1200 written, 40 waived this run) · 42.1 pages/min · indexing ETA 3h13m
```

On Postgres the drain publishes in **bulk groups**: it freezes up to 16
following page imports and deletes with the current one, admits them in one
transaction, and the writer publishes the group in one transaction. Every
page still gets its own write request, receipt, attribution and failure
report; if one page fails, the pages before it commit, that page is reported,
and the pages after it are cancelled and re-frozen once it is fixed. Group size
adapts so a group takes about `sync.bulk_max_txn_ms` (default 15 s).

Groups publish in **lanes**: up to six groups at once, each in its own
transaction on its own connection (`--lanes N` from 1 to 8, `--no-lanes` for
one at a time, or `gbrain config set sync.lanes N` / `GBRAIN_SYNC_LANES`; the
count is capped by the connection pool, so a pool of 10 allows 6). Lanes apply
their pages at the same time but commit in file order: a group commits only
after the group before it has committed, so a reader never sees a later page
without the earlier ones. While lanes publish, the drain keeps freezing and
admitting the next groups. Nothing is admitted ahead while foreground writes
are recent (one was queued in the last minute), and a foreground write that
needs the worktree makes the lanes finish their current groups and step
aside. If a page fails, the groups after it are cancelled with the reason "An
earlier page of the same sync did not commit" and re-frozen once the failure
is fixed. A lock or statement timeout in a lane costs one lane for the rest of
the run. Turn bulk off with
`--no-bulk`, `GBRAIN_SYNC_BULK=0` or `gbrain config set sync.bulk false`. The
final JSON reports `drain.bulk` (`enabled`, `reason` when off, `groups`,
`largest_group`, `admitted_ahead`, and `lanes`: `configured`, `effective`,
`reason` when fewer, `step_down`, `overlapped_groups` and `fallbacks`, the
lane groups that published singly or went back to the queue). Finish a drain before downgrading gbrain:
an older version refuses a group this version admitted ahead, and the sync
stops there instead of publishing a page twice. PGLite publishes without network round trips and does not
use bulk groups.

*Written* pages published a change. *Waived* entries needed no write (an
unchanged file, or a delete of a page that is already deleted) and advanced
the cursor without a request. The ETA covers indexing only; embeddings and
extraction queued by the run drain afterwards. Measured throughput by database
distance is in [`docs/eval/managed-sync-catchup.md`](../eval/managed-sync-catchup.md).

The run ends in exactly one outcome:

| Outcome | Exit | Meaning | What to do |
| --- | --- | --- | --- |
| `synced` | 0 | The cursor reached its target. | Nothing. |
| `resumable` | 0 | A deadline, `--timeout` or Ctrl-C stopped it; the cursor and accepted writes are intact. | Rerun `next.command`; safe in a loop. |
| `blocked` | 1 | A page failed or the writer needs intervention. | Follow `next.why`, then run `next.command`. See [drain stops](write-refusals.md#managed-sync-drain-stops). |

**Say to your agent:** *"Catch up my managed brain's sync backlog and tell me
how long it will take."* or *"My managed sync stopped. Is it safe to rerun?"*

Timing knobs the drain uses:

| Knob | Scope | Default | At expiry |
| --- | --- | --- | --- |
| `--timeout <dur>` | Whole drain (per source under `--all`). Never extended by progress. | none | Stops as `resumable`. |
| `--hard-deadline <dur>` | Whole process, enforced out of band. | none | The drain stops itself about 15 s early as `resumable`; the watchdog stops a hung process. |
| `GBRAIN_SYNC_MAX_RUNTIME_SECONDS` | Whole process, non-interactive runs. Extends while pages keep committing. | 3600 (non-TTY) | Stops only after `GBRAIN_SYNC_STALL_ABORT_SECONDS` without progress. |
| `GBRAIN_SYNC_STALL_ABORT_SECONDS` | Progress window for the deadline above. | 900 | The watchdog stops the run and prints the resume command. |
| No-progress detector | Awaited write and checkout head unchanged. | 30 s and 3 passes | Stops as `blocked` / `drain_stalled` with diagnostics. |
| Page write wait | One page's (or group's) publication before the drain re-checks. | 30 s inside a drain (5 s, checkpoint 8 s, for a single pass) | The drain re-enters; this is not a stop, unless the page still waits for a process that can take the worktree lock, which stops it as `blocked` / `writer_lock_unavailable`. |
| `sync.bulk_max_txn_ms` / `GBRAIN_SYNC_BULK_MAX_TXN_MS` | Target time per bulk group; sizes the next group from the last one's time per page. | 15000 | A smaller next group. |
| `sync.bulk_size` / `GBRAIN_SYNC_BULK_SIZE` | Largest bulk group. | 16 | — |

Two more tips:

- **Run the catch-up near the database.** Each page costs several database
  round trips, so a host in the database's region drains far faster than a
  laptop across the internet.
- **Triage.** `gbrain sources writer status <id>` shows the oldest unfinished
  request and why it waits. `gbrain doctor` reports a managed cursor's
  remaining entries and ETA from any process.

A shell loop around `gbrain sync --source <id> --no-pull` until it prints
`synced` also works; each run drains as far as its deadline allows.

## Implementation

### Prerequisite: a reachable direct connection

GBrain is tuned for the Supabase **Transaction pooler** (port 6543): it
auto-disables prepared statements there and routes `engine.transaction()`
(migrations, DDL, sync imports) to a derived **direct** connection
(`db.<ref>.supabase.co:5432`). That direct host is IPv6-only, so on an
IPv4-only host it is unreachable. When that happens gbrain falls back to
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
  reported as drift, not silently ignored (see Tricky Spot 7). For small
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

A dot-directory you deliberately keep content in (say `.decisions/`) can be
waived back in with `--include-hidden '<glob>'` on `gbrain sync` — the glob
names exactly which hidden paths to admit
(`gbrain sync --include-hidden '.decisions/**'`); everything else hidden
stays pruned, and vendored/generated exclusions are never waived. The flag
scopes a single sync invocation and cannot combine with `--all`; to make the
waiver hold on every path — `sync --all`, autopilot, the dream cycle — persist
it as the `sync.include_hidden` config key (same dialect as `sync.exclude`; a
trailing `/` means the whole subtree). Unset admits nothing, and a per-call
flag unions with the persisted list rather than replacing it. One remaining
bound: neither form reaches a non-git directory's filesystem-walk import
fallback (every git-tracked source, the normal case, is covered).

**Say to your agent:** *"index my repo's .github folder on every sync"* — your
agent runs `gbrain config set sync.include_hidden '.github/'`.

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

<a id="held-files"></a>
4. **One broken file never blocks a sync: it is held.** When a file's content
   refuses deterministically (frontmatter gbrain cannot read without guessing,
   a frontmatter `slug:` naming another page, a file over the size limit,
   content the operator's `content_sanity.junk_disposition=reject` refuses, or
   on managed sync a facts or takes fence that cannot be imported without
   dropping rows), sync holds that file and keeps going: every other file imports, the
   checkpoint advances, and the run reports the hold (`Held <path>: <code> …
   Next: <command>`; JSON `held`, `held_count`, `holds_outstanding`). Files
   gbrain can read exactly after quoting an unquoted value (`author: a (b)
   (original: https://…)`) import and are counted under
   `recovered_frontmatter`, so the generator that writes them can be fixed.
   Holds are durable and visible everywhere an agent looks: `gbrain sources
   status <source>`, doctor `git_held_files`, `get_page` (`file_held`) and
   search (`stale` hits, the `held_files` notice). A held file's page keeps its
   last good revision and is read-only for `put_page` until the file is
   repaired. A hold clears when the file changes, is deleted, or a newer
   gbrain can read it; `gbrain sync --dry-run` lists would-be holds
   (`would_hold`) without writing anything. The backlog fix is one previewed,
   hash-bound command per kind of hold:

   ```bash
   gbrain sources status <source-id>                 # what is held and why
   gbrain repair frontmatter --source <source-id>    # frontmatter holds: preview; writes nothing
   gbrain repair fences --source <source-id>         # fence holds: preview; writes nothing, no model call
   ```

   A fence whose meaning is unambiguous (a missing end marker after the
   table, duplicate row numbers, an invented kind, an assistant holder, ...)
   is not held: managed sync rewrites it losslessly, commits the file and
   reports `fences_normalized` (`gbrain sync --dry-run` lists
   `would_normalize`; `gbrain config set fences.normalize false` turns it off).
   A fence hold (`invalid_fence`) names the fence, section, reason and row
   numbers, never a cell, and clears by itself: the maintenance run's
   `fence_repair` phase repairs it on the owner host (exact rules first, then
   the configured chat model for rows only a rewrite can realign, within
   the daily spend cap) and commits the file.
   `gbrain repair fences --source <source-id>` previews the same repair and
   prints its apply command, which needs no extra consent; frontmatter repair
   does not touch fences. A hold whose reason is `manual` needs a person: read
   the page (`gbrain get --source <source-id> -- <slug>`), edit that fence in
   the file, commit, and run `gbrain sync --source <source-id> --no-pull`. A
   fence refused only while being prepared against the stored page (for
   example a takes row number a stored take already uses) is held in the same
   run as `prepare_time`. See [fence holds](write-refusals.md#invalid_fence)
   and [fence repair](repair.md#fences).

   Walkthrough with real output: [held files](repair.md#held-files); codes:
   [content refusals](write-refusals.md#held-files-and-content-refusals).
   Managed and legacy sync behave the same for frontmatter, size and content
   holds; for fences, legacy sync stores the normalized fence in the database
   (it never rewrites the file), keeps importing a page whose fence cannot be
   normalized with its bad rows skipped (reported in `fence_issues`), and
   never holds it. The fence repair still repairs such a file: on a legacy
   source it re-reads the file, backs it up under `~/.gbrain/backups/`,
   writes and imports it, and leaves the change for you to commit
   (`gbrain sources status` names the `git add`/`git commit` command until
   you do). Holds never count toward the
   legacy auto-skip streak below. A source blocked by such a file before this
   release recovers on its next sync, or now with
   `gbrain sync --source <source-id> --no-pull`. Teams that want fail-closed
   blocking set `gbrain config set sync.holds fail` (a fence refusal then
   blocks with its typed `invalid_fence` text). Company-brain profile
   sources never hold: their approved manifest keeps blocking, and a fence
   refusal there is fixed in the repository and committed.

   Other failures still fail closed. In legacy sync a file that fails the
   same way `GBRAIN_SYNC_AUTOSKIP_AFTER` consecutive syncs (default 3, set `0`
   to disable) is auto-skipped so the rest of the brain keeps indexing past
   it; `gbrain doctor` keeps warning until you fix or delete it. A repository
   history rewrite still hard-blocks even with `--skip-failed`. For legacy
   sync only, `gbrain sync --skip-failed` acknowledges a known-bad set.
   **Managed sync never acknowledges or auto-skips failed cursors.** Its
   durable failed receipt remains immutable on ordinary replay. Correct the
   cause, inspect local `gbrain doctor`, then explicitly retry an idle
   ordinary-source cursor with the same full/working-tree/filter options:

   ```bash
   gbrain sync --source <source-id> --no-pull --retry-failed
   ```

   This retries with fresh admission; do not add `--skip-failed`. A successful
   full run does not clear a separate failed incremental cursor. Doctor reports
   the remaining run; CLI blocked results exit nonzero and local diagnostics
   include source/path/code/request/run/target. Counts are cumulative for the
   run, not evidence of repeated deletions. Remote doctor exposes only
   source-scoped aggregate diagnostics, not paths or receipt identifiers.

   **Say to your agent:** *"Some files in my notes source are held. Show me
   why and preview the fix."*

5. **Staleness can't read "fresh" forever.** A source whose content stopped
   moving (or whose local clone vanished) would otherwise report fresh
   indefinitely off the stored content timestamp. Content-relative staleness
   ramps toward stale once wall-clock time since the last sync passes a ceiling
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
   deciding whether to resume. For ordinary imports, completed paths record
   progress, not the revision imported: the next run re-reads current files
   and compares their content hashes with the database, including paths listed
   as completed.
   Unchanged files avoid re-import, but resuming a large import still pays
   the directory-walk, file-read, and hash-comparison cost. Checkpoint timestamps
   and file mtimes are not used as proof that content is unchanged.

   [Company-brain ingestion](company-brain-ingestion.md) uses a separate
   protected database checkpoint tied to an immutable approved committed
   manifest. It can skip paths completed for that admission receipt; it does
   not treat the ordinary import checkpoint as approval to read changed files.

7. **Sync imports commits, not your working tree.** Files written into the
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

8. **A managed brain pulls only through `gbrain sources refresh`.** Managed
   sync refuses to pull (`gbrain sync` needs `--no-pull`) and a cycle asked to
   pull syncs the checkout as it is, because a Git merge rewrites files that
   accepted writes may be publishing into. To take new upstream commits, run
   on the owner host:

   ```bash
   gbrain sources refresh <source-id>
   ```

   It fetches, refuses new writes to every source that shares the checkout
   (`worktree_refreshing`, retryable) until queued ones finish, fast-forwards
   with `git merge --ff-only` and runs the managed `--no-pull` sync for each of
   those sources. `--dry-run` fetches and previews. Uncommitted files the
   upstream does not touch are kept and listed; dirty files it does touch, a
   diverged branch or an unfinished sync cursor refuse with the command to run
   ([refusal reference](write-refusals.md#worktree-refresh-refusals)). Bounds:
   `--wait-drain <seconds>` (default 60; `sources.refresh_drain_wait_ms`,
   `GBRAIN_REFRESH_DRAIN_WAIT_MS`) and `--fetch-timeout-ms` (default 120000;
   `sources.refresh_fetch_timeout_ms`, `GBRAIN_REFRESH_FETCH_TIMEOUT_MS`).
   A refresh interrupted by a crash is finished by the restarted owner or by
   `gbrain sources refresh <source-id> --resume`. A cron that keeps a managed
   brain current runs the refresh instead of `git pull`.

   **Say to your agent:** *"Bring my notes source up to date with its remote."*

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

## Several brains on one host

Each brain gets its own autopilot job. The default brain (`~/.gbrain`, that
is `GBRAIN_HOME` unset or set to your home directory) keeps the shared names:
launchd label `com.gbrain.autopilot`, systemd unit `gbrain-autopilot.service`,
start script `~/.gbrain/start-autopilot.sh`, and an unmarked crontab line.
Any other brain gets names with a suffix: `com.gbrain.autopilot.<suffix>`,
`gbrain-autopilot-<suffix>.service`, `<brain>/.gbrain/start-autopilot-<suffix>.sh`,
and a crontab line ending in `# gbrain-autopilot:<suffix>`. The suffix is the
first 8 hex characters of a random id that `--install` records in
`<brain>/.gbrain/autopilot-install-id`. Every brain logs to its own
`<brain>/.gbrain/autopilot.log`.

`gbrain autopilot --status [--json]` prints the brain's job name, suffix,
install-id path, wrapper path and log path (`job` in `--json`). `--status`
and `--uninstall` act only on that brain's job.

- **Moving a brain** keeps its id and job. `--status` reports
  `needs_reinstall: wrapper_missing` until you run
  `GBRAIN_HOME=<new parent> gbrain autopilot --install`, which repoints the
  same job.
- **Copying a brain** (`cp -r`) gives the copy a new id on its first
  `--install`, so the original brain keeps its job.
- **Upgrading from an older gbrain**: a non-default brain installed before
  per-brain names ran under the shared names. `--status` reports
  `needs_reinstall: legacy_shared_job`; `GBRAIN_HOME=<parent> gbrain autopilot --install`
  replaces that shared job with the brain's own job and says so.
- **`autopilot_job_owned_by_other_brain`**: installing the default brain
  refuses when the shared job still runs another brain. Run the printed
  `GBRAIN_HOME=<parent> gbrain autopilot --install` for that brain first, then
  install the default brain again.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
