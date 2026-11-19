# Sync resumability + lock tuning

`foresights sync` is resumable and converges under pool exhaustion + repeated kills.
Progress banks into the append-only `op_checkpoint_paths` table (one row per drained
path, written via the direct session pool so it survives `EMAXCONNSESSION`); a killed
run resumes from the checkpoint and `last_commit` only advances on true completion. The
per-source lock heartbeats through the direct pool and refuses to steal a live,
recently-refreshed holder. Six env knobs tune it (all env-only, incident-time escape
hatches — no config-dashboard surface by design):

| Env var | Default | What it does |
|---|---|---|
| `GBRAIN_SYNC_CHECKPOINT_EVERY` | 1000 | Flush the checkpoint every N drained files. |
| `GBRAIN_SYNC_CHECKPOINT_SECONDS` | 10 | Also flush every N seconds (whichever comes first) — bounds worst-case loss regardless of throughput. Flush also fires after the first file. |
| `GBRAIN_SYNC_MAX_CHECKPOINT_FAILURES` | 3 | Consecutive failed flushes (each already retried ~12s) before the run aborts with `reason: 'checkpoint_unavailable'` instead of importing work it can never bank. |
| `GBRAIN_SYNC_YIELD_EVERY` | 64 | Yield the event loop (`setTimeout(0)`, NOT `setImmediate` — Bun starves the timers phase under a tight setImmediate loop) every N files so the lock-refresh `setInterval` heartbeat fires mid-import. |
| `GBRAIN_LOCK_STEAL_GRACE_SECONDS` | derived (~600 at 30min TTL) | A holder that refreshed within this window is NOT stolen even if its TTL lapsed (starved-but-alive). Dead holders stop refreshing, age past the grace, and become stealable; TTL stays the backstop. |
| `GBRAIN_SYNC_STALL_ABORT_SECONDS` | 900 | Progress-aware stall watchdog: if the import drain makes no forward progress (keyed on file-import progress, NOT the lock heartbeat) for N seconds, abort the run and release the per-source lock so the next `foresights sync` resumes from the checkpoint. Reports `reason: 'stall_timeout'`. Observed BETWEEN files; a hang inside one file's import isn't interrupted until it returns (the hard deadline is that backstop). 0 disables. Also the progress window of the default hard deadline (see [Large brains](#large-brain-deadlines)); when this is 0 the window stays 900. |

<a id="large-brain-deadlines"></a>
## Large brains: deadlines and budgets

A brain with tens of thousands of pages legitimately runs past the bounds that
keep small brains safe. Each bound below stops only work that has stopped
making progress, or stops loudly with the exact command to finish.

**Say to your agent:** *"Import my whole notes repo, even if it takes hours."*
**Say to your agent:** *"Finish embedding everything that's still missing."*

| Bound | What happens on a large brain | What the agent sees and runs |
|---|---|---|
| `foresights sync` hard deadline (non-TTY default 3600 s, `GBRAIN_SYNC_MAX_RUNTIME_SECONDS`) | Past the deadline the sync keeps running while it keeps importing; it stops only after `GBRAIN_SYNC_STALL_ABORT_SECONDS` (default 900 s) without progress. A loop-starved process sends no progress and is still killed. | On a stop, stdout carries `code=sync_deadline_stop` (one JSON object under `--json`) with the cause and the resume command, for example `foresights sync --source notes --no-pull`. Pages imported before the stop are kept. `--hard-deadline <N>` is a strict wall-clock cap with no extension; `--no-hard-deadline` removes the bound. |
| `foresights embed --stale` time budget (`GBRAIN_EMBED_TIME_BUDGET_MS`, default 30 min) | The run stops at the budget. If stale chunks remain, the stop is reported, not silent. | stdout: `[embed] stopped (reason: time_budget)` with the remaining count and `foresights embed --stale --catch-up [--source <id>]`, which runs until the backlog is empty; exit status 11. It makes paid embedding calls, so confirm with the user unless embedding spend is already approved. `foresights doctor` reports the backlog on the `embeddings` check (`details.code: embedding_backlog`). |
| `foresights serve` boot deadline (`GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS`, default 60 s) | The window restarts at every boot phase, progress note and answered tool call, so a slow but advancing boot finishes. | Only a boot with no progress for a full window exits 1 with [`serve_boot_timeout`](../ENGINES.md#serve-boot-timeout). |
| `foresights sources add` manifest | Stored manifests hold a digest and a file count, so checkouts of any size register. | No action. |

## Pace Mode (DB-contention-aware backfill pacing)

A naive `foresights embed --stale` / large `sync` can saturate a PgBouncer
transaction-mode pooler and starve the minion supervisor's lock renewals
(`lock-renewal-failed` → dead jobs). Pacing is built in and composable, so no
external SIGSTOP/SIGCONT wrapper script is needed. **Opt-in: default mode `off`.**

The composable primitive is `src/core/db-pacer.ts` (`createDbPacer`):
- **Concurrency cap is the real lever** (caps simultaneous in-flight DB writes =
  pooler slots held). Embed paths set their worker count to `maxConcurrency`
  (single pool, no permit); `sync` uses the shared `acquire()` **permit** because
  each parallel worker owns a separate engine (one budget must span pools).
- **In-band signal** (`observe(ms)` EWMA from the work's own queries). There is
  no out-of-band probe pool, probe loop, or `probeLatency` engine method.
- **Cooperative `pace()` sleep** on `setTimeout` (keeps the lock heartbeat
  firing), jittered to avoid a thundering-herd resume. `acquire()`/`pace()` throw
  `AbortError` on cancel; everything else is fail-open (a pacer bug never kills a
  backfill, never throws an unhandledRejection).

Named bundles resolve through `src/core/pace-mode.ts` (`resolvePaceMode`), mirror
of the search-mode pattern but with **env ABOVE config** (incident escape hatch):

    per-call flag → GBRAIN_PACE_* env → config (pace.*) → PACE_BUNDLES[mode] → off

| Knob | off | gentle | balanced | aggressive |
|---|---|---|---|---|
| `maxConcurrency` | (off) | 4 | 8 | 16 |
| `paceAtMs` (EWMA → sleep) | — | 250 | 500 | 1000 |
| `maxSleepMs` (jittered cap) | — | 2000 | 1500 | 1000 |

**Surfaces.** `foresights embed --stale --pace[=mode]` (bare `--pace` = balanced),
`--pace-max-concurrency=N`. `--background` carries explicit pace OVERRIDES (not
the resolved bundle) into the `embed` job payload; the handler re-resolves
env>config>bundle at execution so `GBRAIN_PACE_*` still wins. Config-level
`pace.mode` paces EVERY `runEmbedCore` caller (cycle embed, embed-catch-up,
sync-auto-embed) and the prod `embed-backfill` job automatically. `sync` reads
env/config. PGLite / mode `off` → no-op pacer.

**Correctness guards for paced runs** (longer paced runs widen these races): CLI
`embed --stale` single-flights via the SAME per-source lock key as the
`embed-backfill` handler (`src/core/embed-backfill-lock.ts`; all-source runs lock
every source in sorted order) so a hand-run backfill and a queued job can't race
the NULL→non-NULL upsert; a **bounded** end-of-run keyset re-entry
(max 3 + forward-progress, paced runs only) catches rows inserted behind the
cursor; and the embed wall-clock budget timer is re-armed around
`pace()` sleeps so paced time doesn't burn the work budget.

`EmbedResult.pacing` carries the end-of-run telemetry (cap, samples, EWMA, slept
ms, max waiters) for `--json`; a one-line summary prints to stderr.
