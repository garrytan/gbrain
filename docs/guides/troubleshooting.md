# Troubleshooting

**Say to your agent first:** *"Run a brain health check and fix what you find"* — this routes to the maintain skill, which runs `gbrain doctor` and either auto-fixes or prints the exact repair command; your agent can run the whole loop (*"Get my brain health score to 90"* uses the remediation planner with a cost cap). The sections below are for when you want the manual path.

**PGLite crashes at startup with `RuntimeError: Aborted()` (often right after a macOS upgrade)?** Not a macOS incompatibility — the OS-upgrade reboot killed gbrain mid-write and tore the data dir's WAL. gbrain repairs this automatically on the next command (data preserved, backup kept); if auto-repair is disabled or skipped, run `gbrain pglite-repair --dry-run` to diagnose and `gbrain pglite-repair --yes` to repair in place. Full recovery ladder (repair → rebuild → engine switch) in [`docs/ENGINES.md` — Troubleshooting: startup abort](../ENGINES.md#troubleshooting-startup-abort-runtimeerror-aborted) and [`docs/INSTALL.md`](../INSTALL.md#pglite-crashes-at-startup-runtimeerror-aborted).

**`gbrain import` fails with `expected N dimensions, not M`?** Run `gbrain doctor`. It will print the exact `gbrain config set ...` or `gbrain migrate embeddings` command to repair the mismatch. You should not need to delete `~/.gbrain`. Fresh `gbrain init --pglite` auto-detects your embedding provider from API keys: set `VOYAGE_API_KEY` (or `OPENAI_API_KEY` / another provider key) in the environment — or in `~/.gbrain/config.json`, which init also reads — before running init, or pass `--embedding-model <provider>:<model>` explicitly. With multiple keys set, init fires an interactive picker (non-TTY auto-picks the Voyage default when its key is present). With no keys at all, init continues keyless (keyword-only search) with a loud notice; add a key later and re-run `gbrain init --force --embedding-model voyage:voyage-4` to enable embeddings, or pass `--no-embedding` up front to make keyless explicit. See [`docs/integrations/embedding-providers.md`](../integrations/embedding-providers.md) for the full provider matrix and [`docs/operations/headless-install.md`](../operations/headless-install.md) for Docker/CI sequencing.

**`gbrain doctor` warns `default_source_local_path`?** Your `default` source has no `local_path` AND that null pointer is provably breaking write-through (the repo fallback is another source's own working tree, or file-backed default pages have no resolvable root). A null `local_path` on its own is the designed fallback topology and reports ok. The repair is a pointer update, never a file move: `gbrain sources set-path default <path>` prints the prior value before changing it and refuses a path that nests inside or swallows another source's tree (exit 6; `--force` bypasses). **Say to your agent:** *"Run a brain health check and fix what you find"* — the maintain skill runs `gbrain doctor` and applies the printed repair.

**A Gmail, Calendar or GitHub connector source still has an old `local_path`?** Connector sources sync from their provider, so autopilot ignores their `local_path`: once a connector has synced (or tried to) at least once, autopilot syncs it on every interval and runs its database phases with no checkout. A connector that has never synced stays idle until you run `gbrain sync --source <id>` once; autopilot prints that command the first time it skips one. To remove the stale pointer, run `gbrain sources set-path <id> --clear` (connector sources only; it refuses a filesystem source and a connector bound to a canonical owner). `config.syncEnabled=false` still opts a source out. **Say to your agent:** *"My Gmail source points at an old folder. Clear it and keep it syncing."*

**A save, sync or background effect was refused with a named reason?** Reasons such as `file_database_drift`, `ambiguous_source_path`, `physical_root_device_changed`, `cursor_processing_options_conflict`, `take_row_collision`, `invalid_source_uri`, `queue_capacity` and parked effects (`targets_parked`, doctor `parked_effects`) each come with a recovery step in the error's `suggestion`. [Write refusal reasons](write-refusals.md) explains each one and its recovery. **Say to your agent:** *"My save was refused. Explain the reason and show me the fix before you run it."*

**`gbrain doctor` warns `timeline_history`, `derived_visibility`, or unsealed pages under `contextual_retrieval_coverage`?** Preview the fix with `gbrain repair`, then apply one kind at a time with `gbrain repair <kind> --apply` on the brain host. See [repair residual damage](repair.md).

**`gbrain doctor` warns `timeline_orphans`?** Timeline rows from an earlier version of a page are still in the database after the dated bullet was edited or deleted. Preview with `gbrain extract timeline --prune-orphans --dry-run`, then remove them with `gbrain extract timeline --prune-orphans` (add `--source-id <id>` to limit it). Rows no page version ever produced, such as enrichment and meeting fan-out, are kept.

**`gbrain doctor` warns `slug_collisions`, or sync prints slug collisions?** Two or more files in a source map to the same page slug (for example `notes/Foo Bar.md` and `notes/foo-bar.md`), and only one is indexed. Rename all but one file in each group, commit, then sync.

**Managed writes refused with `queue_capacity`, or doctor warns `persistence_capacity`?** A per-principal or per-brain write-journal limit (`persistence.limits.*`) is full (`queue_capacity`), or doctor sees lifetime request IDs or receipt bytes at 80% or more (`persistence_capacity`). For the cumulative limits (lifetime request IDs and receipt bytes), the warning and the refusal print a `gbrain config set persistence.limits.<limit> <value>` sized for about one more year; run it on the brain host, then retry with the same request ID. For outstanding-request or queued-byte limits, let outstanding writes finish and check `gbrain sources writer status`. Receipt compaction age is `persistence.receipt_retention_days` (default 30). Limits and defaults: [bounded admission and retention](concurrent-writes.md#bounded-admission-and-retention).

**Dream keeps skipping one transcript, or doctor warns `dream_paid_loop`?** A dream key died `dream.breaker.max_dead_submissions` times (default 3) in 24 hours and is refused so it stops billing you. Fix the cause, then `gbrain dream reset-key --list` and `gbrain dream reset-key '<key>'`. See [the paid-loop breaker](../operations/spend-controls.md#dream-paid-loop-breaker-dreambreakermax_dead_submissions).

**Hourly cron sync keeps timing out on a federated brain?** Switch your
cron to a per-source loop with shell `timeout(1)` doing the OS-level kill
and gbrain self-terminating gracefully half-a-minute earlier:

```bash
gbrain sync --break-lock --all --max-age 1800
for src in $(gbrain sources list --json | jq -r '.[].id'); do
  timeout 600 gbrain sync --source "$src" --timeout 540 || true
done
```

When `--timeout` fires mid-import, `gbrain sync` exits 0 with status
`partial` and `last_commit` UNCHANGED — the next run re-walks the same
diff and `content_hash` short-circuits already-imported files. The
`--max-age 1800` first command self-heals any wedged-but-alive locks
left by a hung previous run, keyed on the lock's last refresh time
(NOT when it was acquired) so healthy long-running holders are safe by
construction. Scope note: the extract + embed phases still run to
completion once started; `--timeout` interrupts the import walk only.

**Dream cycle silently losing wiki links on Supabase?** The engine
self-retries every bulk batch write (`addLinksBatch` /
`addTimelineEntriesBatch` / `upsertChunks`) on Supavisor pooler blips,
with a 12s worst-case wait that covers the full 5-10s circuit-breaker
recovery window. `gbrain doctor` surfaces incidents via the
`batch_retry_health` check (reads the last 24h of
`~/.gbrain/audit/batch-retry-YYYY-Www.jsonl`). To tune for an unusually
slow pooler:

```bash
# Defaults: 3 retries, base 1s, max 10s, decorrelated jitter.
# Override per operator without a release:
export GBRAIN_BULK_MAX_RETRIES=5       # int >= 0; 0 disables retries
export GBRAIN_BULK_RETRY_BASE_MS=2000  # int > 0
export GBRAIN_BULK_RETRY_MAX_MS=15000  # int >= base
```

Bad values surface at `gbrain doctor` startup with a paste-ready fix
(not at first-retry mid-cycle). PGLite-only installs pay zero cost — the
retry wrap is engine-level, but PGLite has no pooler so retries never
fire in practice.

**Dream cycle losing ~150 link rows per run with `'No database
connection: connect() has not been called'` errors in the log?** The
retry layer self-heals on a nulled-out database singleton: a
`reconnect` callback on `withRetry` rebuilds the connection between
attempts, and `PostgresEngine.batchRetry` injects `() => this.reconnect()`
so engine-level batch writes survive a mid-cycle disconnect by something
else in the same process. `gbrain capture` does not trail a
`'No database connection'` stderr line from a background facts:absorb
worker firing after CLI exit, because op dispatch awaits
`getFactsQueue().drainPending({timeout: 1000})` before
`engine.disconnect()`. To find which code path is still calling
disconnect mid-process, run `gbrain doctor --json | jq '.checks[] |
select(.id=="batch_retry_health")'`; the check surfaces the
24h disconnect-call count and the most-recent caller frame from the
`~/.gbrain/audit/db-disconnect-YYYY-Www.jsonl` audit.

**`gbrain brainstorm` returning `judge_failed: true` with 0 scored
ideas?** You are on an outdated build; `gbrain upgrade` is the whole
fix (no config change, no schema migration). Current builds size the
judge's output cap to the idea count instead of truncating mid-JSON
past ~40 ideas, and slash-form model ids (`gbrain brainstorm
--judge-model anthropic/claude-sonnet-4-6 --max-cost 5`) resolve
pricing the same as the colon form instead of failing with
`BudgetExhausted reason=no_pricing`.

**`gbrain reindex --markdown` wiped your auto/dream/signal-detector
tags?** Run `gbrain upgrade`. Tag reconciliation is add-only: re-import
and `reindex --markdown` ADD current frontmatter tags and never delete,
so enrichment tags written to the DB (auto-tag, dream synthesize,
signal-detector) survive a re-chunk. The reindex DB-only fallback also
reconstructs the full markdown (frontmatter + body + timeline) before
re-chunking, so a page with no on-disk source keeps its frontmatter,
title, and timeline instead of getting overwritten with empty
frontmatter. Trade-off: removing a tag from a page's frontmatter does
not remove it from the DB on the next sync (frontmatter-tag removal
needs a provenance column, deferred).

**`gbrain sync` wedges on a large brain (no progress, high CPU)?**
Three tools. First, name the stalling file:

```bash
GBRAIN_SYNC_TRACE=1 gbrain sync --no-pull --no-embed --yes
```

The last `[sync] begin import: <path>` line with no following completion
is the file being processed when the hang hit. Second, if you suspect a
schema-pack `inference.regex` with catastrophic backtracking, complete
the sync with the pack disabled and re-run extraction later:

```bash
gbrain sync --no-schema-pack --no-pull --no-embed --yes
```

`gbrain schema lint` warns on the classic nested-quantifier ReDoS
shapes (`(a+)+`, `(a*)*`, …) in pack regexes, and the runtime caps
inference-regex input length (override via `GBRAIN_MAX_REGEX_INPUT_CHARS`).
Third, on a PGLite brain with a live `gbrain serve` (your agent's MCP
server), `gbrain sync` delegates through authenticated local IPC to the
owner, whether it serves HTTP or stdio. If the client exits, accepted page
requests can finish; repeat the same options to resume the managed sync
cursor. Embeds defer to the owner's background work. See
[`docs/architecture/serve-sync-concurrency.md`](../architecture/serve-sync-concurrency.md)
for supported flags, managed-mode limits and the full triage.

**`gbrain init --migrate-only` / a schema migration fails on Windows
with `getaddrinfo ENOTFOUND`?** Run `gbrain upgrade`. Schema bring-up
runs its phases in-process rather than spawning a child `gbrain init
--migrate-only` per phase; a spawned child is what dies on
Windows + bun + Supabase pooler with a DNS-resolution failure even
though the parent connects fine, and running in-process removes the
spawn entirely. The grandfather migration runs as a chunked bulk SQL
pass (keyed on the page PK, soft-delete-filtered, source-safe) and
completes in seconds on an 80K-page PGLite brain.
