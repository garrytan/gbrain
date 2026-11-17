# Minion schedules (deferred design)

Status: deferred. This is an evaluation for issue #7242, item 3 ("native
schedules"), written so a later wave can build it without redoing the survey.

## Problem

An agent running long work on a large deployment keeps its own cron entries
for recurring foresights work: sync wrappers, embed batches, enrichment fan-outs,
landing watchers, progress gates. Each entry brings its own overlap control,
spend control and run history, none of which foresights can see. About a third of
those entries exist only to watch or prod foresights's own jobs.

The ask is a built-in primitive: a cron spec, an overlap policy
(`skip` | `queue` | `replace`), a `max_usd` per schedule and per run,
and run history readable over the CLI and MCP.

## What autopilot already schedules

`foresights autopilot` is already a scheduler, but only for foresights's own
maintenance, and its cadence is fixed in code rather than declared per job:

- **Host install.** `foresights autopilot --install` writes one long-running
  daemon per brain: a launchd agent with `KeepAlive` on macOS, a systemd user
  unit on Linux, a start script for ephemeral containers, or a crontab line that
  runs the wrapper every 5 minutes (`src/commands/autopilot.ts`,
  `src/commands/autopilot/jobs.ts`). The brain-repo durability job is the one
  launchd `StartInterval` job (`src/core/brain-repo-durability.ts`).
- **Tick loop.** The daemon ticks every `--interval` seconds (default 300),
  stretched by brain score (`adaptiveInterval` in
  `src/commands/autopilot-daemon.ts`). Each tick (`dispatchAutopilotTick` in
  `src/commands/autopilot-dispatch.ts`) submits per-source freshness syncs,
  the extract_atoms auto-drain, then either sleeps, fans out per-source
  `autopilot-cycle` jobs or submits targeted remediation handlers.
- **Overlap control.** Every submission carries a slot idempotency key
  (`autopilot-sync:<source>:<slot>`, `autopilot-cycle:<source>:<slot>`,
  `autopilot-global:<slot>`), where the slot is the tick time floored to the
  base interval, plus `maxPending: 1` single-flight or `maxWaiting: 1`. That
  is the `skip` policy, applied by the queue's admission path.
- **Floors and backoff.** A full cycle runs at least every 60 minutes
  (`AUTOPILOT_FULL_CYCLE_FLOOR_MINUTES`), brain-wide maintenance at its own
  floor (`resolveGlobalFloorMin`), and a failing source backs off
  exponentially (`autopilot.failure_cooldown_min`, in
  `src/commands/autopilot-fanout.ts`).
- **Daily probes.** The nightly quality probe is rate-limited to once per 24
  hours with its own `max_usd` config key (`src/commands/autopilot-probes.ts`).
- **Per-job timing.** Jobs already carry `delay`, `quiet_hours` (skip or
  defer) and `stagger_key` (`src/core/minions/types.ts`).
- **Spend.** Consent-gated producers store a spend authorization on each row
  (`src/core/minions/spend-authorization.ts`): one group, one approved total,
  each provider call reserved against `group:<id>` in the durable meter.

What is missing is a user-declared recurring job: any handler name, a cron
spec, a policy, a budget that renews per run, and a history of fires that
includes the fires that did not submit anything.

## Proposed design

### Storage

Two tables, added by one migration.

`minion_schedules`:

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial` | |
| `name` | `text unique` | Operator-chosen, `[a-z0-9-]`, shown in run history and `submitted_by`. |
| `job_name` | `text` | Must be a registered handler; protected names follow the trust rules below. |
| `data` | `jsonb` | Job params, validated by the same path as `jobs submit`. |
| `queue`, `priority`, `timeout_ms`, `max_attempts` | | Copied onto each job. |
| `cron` | `text` | Five-field cron spec. |
| `tz` | `text` | IANA zone; default the host zone at creation. |
| `overlap` | `text` | `skip` \| `queue` \| `replace`. |
| `max_usd_per_run` | `numeric null` | Required for paid job names. |
| `max_usd_per_day` | `numeric null` | Optional ceiling across runs. |
| `spend_authorization` | `jsonb null` | The consent record taken at creation. |
| `submission_authority` | `jsonb` | Who created it; every run inherits it. |
| `enabled` | `boolean` | `schedules pause` / `resume`. |
| `next_run_at` | `timestamptz` | Indexed, partial on `enabled`. |
| `last_run_at`, `last_job_id` | | |
| `created_at`, `updated_at` | | |

`minion_schedule_runs`: `schedule_id`, `fire_at` (the cron slot),
`job_id` (null when nothing was submitted), `outcome`
(`submitted` | `skipped_overlap` | `replaced` | `refused_budget` |
`refused_disabled` | `missed`), `detail jsonb`, `created_at`. Pruned
by the cycle's `purge` phase after a retention window. Job outcomes stay on
`minion_jobs`; a run row only links to its job.

### Tick and submit path

1. A ticker claims due rows:
   `SELECT ... FROM minion_schedules WHERE enabled AND next_run_at <= now() ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT n`,
   so several workers can tick one brain safely.
2. For each row it computes the slot (`fire_at`) and advances
   `next_run_at` to the next cron time after `now()`. Missed slots during
   downtime coalesce into one fire; the skipped slots are recorded as one
   `missed` run with a count, never replayed.
3. It applies the overlap policy against the schedule's live jobs (waiting,
   delayed or active with a live lock):
   - `skip`: record `skipped_overlap` with the live job id.
   - `queue`: submit behind it (`maxWaiting: 1`, so at most one queued run).
   - `replace`: cancel the live job through `cancelJob` (its terminal
     path, children and inbox included), then submit.
4. It submits through `MinionQueue.add` with
   `idempotency_key: schedule:<id>:<fire_at>`, so a second ticker or a
   retried tick coalesces instead of double-submitting, and records
   `submitted` in the same transaction as the `next_run_at` update.

Where the ticker runs: inside `foresights jobs work` (every worker, gated by the
row lock) and inside the autopilot tick. PGLite has no resident worker, so a
PGLite brain ticks from autopilot's inline loop or from an explicit
`foresights schedules tick` a host cron can run.

### Spend

`schedules add` for a paid job name runs the same consent gate as
`jobs submit enrich|subagent --max-usd` and stores the record on the schedule.
Each fire stamps a fresh spend authorization on its job: group
`schedule:<id>:<fire_at>`, approved total `max_usd_per_run`. Before it
submits, the ticker sums the meter's settled and reserved spend for the
schedule's groups over the trailing 24 hours (`readGroupSpend`) and records
`refused_budget` when another run would exceed `max_usd_per_day`. A
schedule never spends without a stored authorization: a paid job name with no
`max_usd_per_run` is refused at creation.

### Lineage

Each submitted job carries `submitted_by: { kind: 'schedule', name, run_id }`
(the producer field #7241 asks for), so `jobs get` names the schedule that
fired it and `jobs list --schedule <name>` filters on it.

## CLI and MCP surface

CLI (trusted local, `remote = false`):

- `foresights schedules add <name> --job <job-name> --cron '<spec>' [--tz <zone>] [--overlap skip|queue|replace] [--max-usd <n>] [--max-usd-per-day <n>] [--params <json>] [--queue <q>]`
- `foresights schedules list [--json]`, `foresights schedules get <name> [--runs N] [--json]`
- `foresights schedules pause|resume|remove <name>`, `foresights schedules run <name>` (fire now, same policy)
- `foresights schedules tick` (for PGLite and host cron)

MCP: `list_schedules` and `get_schedule` (with recent runs) at `admin` scope,
read-only. Creating, changing or removing a schedule stays on the trusted local
CLI in the first version. A schedule is standing authority: it submits jobs and
spends money with nobody present, long after the call that created it. Remote
`submit_job` already refuses protected names, rewrites remote params to what
the grant allows and records the remote authority on the row; a remote
`create_schedule` would need the same rules plus an expiry and a per-grant
cap on schedules and spend, which is a trust-posture change that needs its own
review. Shell jobs keep their worker-side `--allow-shell-jobs` gate.

## Why it is deferred

- It needs two tables and a migration, a cron parser (none is a dependency
  today), and ticker placement that is correct with several workers on
  Postgres and with no worker on PGLite.
- The autopilot overlap and budget machinery works through slot keys and
  single-flight admission; schedules should reuse those paths rather than add a
  second scheduler with different semantics. Moving autopilot's own cadence onto
  schedules is a separate, later decision.
- Unattended spend needs the consent and meter design above reviewed as a
  trust change, not added as a flag.
- The parts of #7241 and #7242 that remove most polling today are smaller and
  land first: `foresights jobs wait`, the terminal-state hook, job progress and
  lineage. With those, an external scheduler can at least wait and be notified
  instead of polling.

## What it needs

- **Migration:** `minion_schedules` and `minion_schedule_runs` with the
  `next_run_at` partial index, in `src/schema.sql` as well (CONTRIBUTING.md,
  "Schema migration").
- **Core:** a `src/core/minions/schedules.ts` module (claim, policy, submit,
  record), a cron parser with tests for DST transitions and the five fields,
  the ticker hook in the worker loop and the autopilot tick.
- **CLI:** the `schedules` command record in `CLI_COMMANDS`, the flag
  registry, CLI goldens.
- **MCP:** the two read ops in a domain module under `src/core/ops/`, scope
  `admin`, with a test that a remote caller cannot create or change a
  schedule.
- **Doctor:** a check for a schedule whose runs keep failing, or that keeps
  skipping because its previous run never finishes.
- **Tests:** PGLite and Postgres coverage for two tickers racing one due row
  (one submit), each overlap policy, missed-slot coalescing after downtime,
  the per-day budget refusal, `replace` cancelling a running job's children,
  and the purge retention of run history.
