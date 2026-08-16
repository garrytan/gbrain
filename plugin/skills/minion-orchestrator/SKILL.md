---
name: minion-orchestrator
version: 1.1.0
description: |
  Unified Minions skill for both deterministic shell jobs and LLM subagent
  orchestration. Replaces the older `gbrain-jobs` routing intent. Use when:
  submitting gbrain jobs, shell/background tasks, spawning subagents,
  checking progress, steering running work, pausing/resuming, parallel
  fan-out. One durable, observable, steerable queue interface. Also carries
  the durable-execution doctrine for any operation expected to exceed ~2
  minutes: capability ladder, deadman checks that verify the result was
  reported, and content-addressed stage checkpoints for expensive pipelines.
triggers:
  - "gbrain jobs submit"
  - "submit a gbrain job"
  - "submit a shell job"
  - "shell job"
  - "run shell command in background"
  - "deterministic background task"
  - "spawn agent"
  - "background task"
  - "run in background"
  - "check on agent"
  - "agent progress"
  - "what's running"
  - "steer agent"
  - "change direction"
  - "tell the agent"
  - "pause agent"
  - "stop agent"
  - "resume agent"
  - "parallel tasks"
  - "fan out"
  - "do these in parallel"
  - "long operation"
  - "durable execution"
  - "arm a deadman"
  - "the job went silent"
  - "operation died in the background"
  - "make this pipeline resumable"
tools:
  - submit_job
  - get_job
  - list_jobs
  - cancel_job
  - pause_job
  - resume_job
  - replay_job
  - send_job_message
  - get_job_progress
mutating: true
upstream: long-ops@fc834ee, subagent-deadman@fc834ee, pipeline-stage-cache@fc834ee
---

# Minion Orchestrator

## Contract

Minions is a Postgres-native job queue for durable, observable background work.
This single skill handles two lanes:
- Deterministic shell jobs (`gbrain jobs submit shell ...`)
- LLM subagent jobs (`gbrain agent run ...`)

When to route to Minions: durable, observable work that must survive restarts,
fan out across many parallel tasks, or persist across sessions. Routing policy
is defined in `skills/conventions/subagent-routing.md` — the project default is
`pain_triggered` (native subagents first, Minions after specific pain signals
fire); Mode A (all-through-Minions) is opt-in.

Guarantees:
- Jobs survive gateway restart (Postgres-backed)
- Every job has structured progress, token accounting, and session transcripts
- Running agents can be steered mid-flight via inbox messages
- Jobs can be paused, resumed, or cancelled at any time
- Parent-child DAGs with configurable failure policies

Durable-execution doctrine (routing convention the agent follows — nothing
mechanically enforces it; see "Durable execution" below):
- Operations expected to exceed ~2 minutes route through the capability
  ladder, never a bare background shell that dies with the session.
- A deadman check verifies the result was REPORTED to the user, not merely
  that the process exited — a swallowed completion event looks identical to
  a dead job from the user's side.
- The deadman is second-line insurance, not a delivery guarantee: it can
  itself die before firing (scheduler restart, deleted entry). Backstop:
  on the next turn, sweep `gbrain jobs list --status active` and recent
  completions for overdue work whose result never reached the user.
- Deadman checks are idempotent. A double-fire, or a fire that races the
  normal completion report, produces silence — it checks reported-state
  first and tags any recovery report with the job ID so duplicates are
  detectable.
- A checkpoint or progress file is trusted only with a freshness check.
  A stale checkpoint reads as "still running" forever; compare its
  timestamp against the expected progress interval and against
  `gbrain jobs get <id>`.

## Route the Request: Shell Job vs Subagent

| Condition | Action |
|---|---|
| User asks for deterministic command/script run | Shell job (CLI: `gbrain jobs submit shell ...`) |
| User asks to "run in minions" + explicit command/argv | Shell job (CLI, `--params` with `cmd` or `argv`) |
| User asks for research/reasoning/iterative agent | Subagent job (CLI: `gbrain agent run`) |
| User asks to steer/pause/resume an agent | Subagent job lifecycle tools (MCP-callable) |
| Single simple operation under ~30s | Consider inline execution first |
| Needs restart durability/observability | Submit as Minion job |
| Operation expected to exceed ~2 minutes | Route through the Durable execution ladder (below) |
| Parallel work (2+ streams) | `gbrain agent run --fanout-manifest` or parent + child subagents |

If intent is ambiguous, ask one clarification:
"Do you want a deterministic shell command job, or an LLM agent job?"

## Shell Jobs (Deterministic Scripts)

Use for reproducible command execution, ETL steps, cron work, and scriptable
tasks where no LLM reasoning loop is needed.

### Preconditions (read before submitting your first shell job)

- **`GBRAIN_ALLOW_SHELL_JOBS=1` must be set on the worker environment.**
  Without it, the shell handler refuses to register and submissions sit in
  `waiting` silently. Gate lives in `src/core/minions/handlers/shell.ts`.
- **Security:** flipping `GBRAIN_ALLOW_SHELL_JOBS=1` authorizes arbitrary
  command execution on the worker. On a shared queue, this is a remote code
  execution surface. Treat as privileged infrastructure authorization.
- **Execution mode — pick one:**
  - **Postgres + daemon:** `gbrain jobs work` runs a persistent worker that
    claims and executes jobs from the queue.
  - **PGLite + --follow:** `gbrain jobs submit ... --follow` runs inline.
    The daemon mode is not available on PGLite (exclusive file lock). See
    `docs/guides/minions-shell-jobs.md`.
- **MCP boundary:** shell-job submission is CLI-only. `submit_job name="shell"`
  over MCP throws an `OperationError` with code `permission_denied` ("'shell'
  jobs cannot be submitted over MCP") because `shell` is in `PROTECTED_JOB_NAMES`.
  Agents CAN observe shell jobs via `get_job` / `list_jobs` / `get_job_progress`
  (not protected), but cannot submit them. Operator or autopilot submits;
  agent observes.
- **Verify setup:** after configuration, run `gbrain jobs stats` (CLI) to
  confirm the worker is registered and consuming the queue.

### Submit (CLI, operator or autopilot)

Shell jobs take their command via `--params` as a JSON object with `cmd` (string)
or `argv` (array), plus `cwd` and optional `env`.

Command string form:
```
gbrain jobs submit shell --params '{"cmd":"echo hello","cwd":"/abs/path"}'
```

Argv form (no shell expansion):
```
gbrain jobs submit shell --params '{"argv":["bash","-lc","echo hello"],"cwd":"/abs/path"}'
```

Inline execution on PGLite or any one-shot deployment:
```
gbrain jobs submit shell --params '{"cmd":"echo hello","cwd":"/tmp"}' --follow
```

Queue/lifecycle flags exposed by `gbrain jobs submit --help`: `--queue`,
`--priority`, `--delay`, `--max-attempts`, `--max-stalled`, `--backoff-type`,
`--backoff-delay`, `--backoff-jitter`, `--timeout-ms`, `--idempotency-key`,
`--dry-run`.

### Monitor (agents or operator)

These operations are MCP-callable and safe for agent use:

```
list_jobs --name shell --status active
get_job ID
get_job_progress ID
```

Check structured result fields (exit code, stdout/stderr tails, attempts,
timings) from `get_job`. Use `gbrain jobs stats` (CLI) for worker/queue
health dashboard.

### Control (MCP-callable)

```
cancel_job id=ID
replay_job id=ID
```

`replay_job` is not protected — only shell *submission* is. Agents can
cancel or replay a shell job without CLI access.

Use idempotency keys for recurring shell workloads to avoid duplicate runs.

## Subagent Jobs (LLM Orchestration)

Use for open-ended reasoning, tool-using research, and fan-out synthesis.

**User-facing entrypoint:** `gbrain agent run <prompt>` is the canonical way
to submit subagent work. It handles the elevated-trust plumbing — `subagent`
and `subagent_aggregator` are both in `PROTECTED_JOB_NAMES`, so direct MCP
submission requires `{allowProtectedSubmit: true}`, which `gbrain agent run`
supplies.

## Phase 1: Submit

```
gbrain agent run "Research Acme Corp revenue" --tools "search,query"
```

`--tools` accepts a comma-separated subset of `BRAIN_TOOL_ALLOWLIST` (see
`src/core/minions/tools/brain-allowlist.ts`): `query`, `search`, `get_page`,
`list_pages`, `file_list`, `file_url`, `get_backlinks`, `traverse_graph`,
`resolve_slugs`, `get_ingest_log`, `put_page`. Anything outside the allow-list
is rejected at submit time with `allowed_tools references unknown tool`.

For parallel work with a fan-out manifest:
```
gbrain agent run --fanout-manifest companies.json
```

The manifest describes N children + 1 aggregator. Each child runs
`name="subagent"` under the hood; the aggregator runs `name="subagent_aggregator"`
and claims AFTER every child terminates. See
`src/core/minions/handlers/subagent.ts` and
`src/core/minions/handlers/subagent-aggregator.ts`.

Flags (from `src/commands/agent.ts`):
- `--subagent-def <name>` — named subagent definition
- `--model <id>` — override model
- `--max-turns <N>` — cap the LLM loop
- `--tools <csv>` — allow-listed brain tools (see above)
- `--timeout-ms <N>` — hard timeout per job
- `--fanout-manifest <file>` — N children + 1 aggregator
- `--follow` / `--no-follow` — stream logs + wait (default on TTY)
- `--detach` — submit and return immediately

Queue/priority/retry tuning is not exposed by `gbrain agent run`; submit the
raw `subagent` handler via `gbrain jobs submit` (requires CLI trust) if you
need those knobs.

## Phase 2: Monitor

```
list_jobs --status active          # MCP — what's running?
get_job ID                         # MCP — full details + logs + tokens
get_job_progress ID                # MCP — structured progress snapshot
gbrain jobs stats                  # CLI — queue health dashboard
gbrain agent logs ID --follow      # CLI — streaming transcript + heartbeat
```

Progress includes: step count, total steps, message, token usage, last tool called.

## Phase 3: Steer

Send a message to redirect a running agent:
```
send_job_message id=ID payload={"directive":"focus on revenue, skip headcount"}
```

The agent handler reads inbox messages on each iteration and injects them as
context. Messages are acknowledged (read receipts tracked).

Only the parent job or admin can send messages (sender validation).

## Phase 4: Lifecycle

```
pause_job id=ID                    # freeze without losing state
resume_job id=ID                   # pick up where it left off
cancel_job id=ID                   # hard stop
replay_job id=ID                   # re-run with same or modified params
replay_job id=ID data_overrides={"depth":"deep"}  # replay with changes
```

All lifecycle ops are MCP-callable.

## Phase 5: Review Results

```
get_job ID                         # result, token counts, transcript
```

Token accounting: every job tracks `tokens_input`, `tokens_output`, `tokens_cache_read`.
Child tokens roll up to parent automatically on completion.

## Durable execution (operations >2 minutes)

Background shells die silently: session compaction, harness restart, tool
timeout. Long gbrain operations (`extract all`, `embed --stale`, a full
`sync --all`) routinely run 10-60 minutes — past every one of those
ceilings. And even when the work survives, the *completion event* can be
swallowed (worker restart, dropped notification), leaving the user staring
at silence while a finished result sits unreported. Durable execution
covers both halves: the work survives, and the report provably lands.

Route any operation expected to exceed ~2 minutes through the **highest
rung of this ladder the deployment supports**. This is a harness-routing
convention the agent follows, not a mechanical guarantee — nothing stops a
bare background shell except this skill saying don't.

### Rung 1 — Minion job + deadman (Postgres + worker)

Requires: Postgres engine, a running `gbrain jobs work` worker, and — for
the shell lane — `GBRAIN_ALLOW_SHELL_JOBS=1` on the worker. All the
Preconditions above still hold: the flag defaults OFF, shell submission is
CLI-only across the MCP trust boundary, and PGLite has no worker daemon
(see Rung 3). Nothing in this section loosens that contract.

1. **Submit as a job** so the work survives restarts:

   ```
   gbrain jobs submit shell \
     --timeout-ms 3600000 \
     --params '{"cmd":"gbrain extract all","cwd":"/abs/path","inherit":["database_url"]}'
   ```

   Work that needs LLM judgment goes through the subagent lane
   (`gbrain agent run`, above) instead — a submitted agent job you never
   check on is the same bug as an unwatched shell job.

2. **Arm a deadman in the same action block** (pattern below). Submitting
   without arming is the classic half-fix: the job survives, the silence
   doesn't.

### Rung 2 — cron-checked progress file (no agent-waking scheduler)

When no scheduler can wake the agent but the host has a plain crontab (or
the work runs outside the queue entirely): make the operation write a
progress/heartbeat file as it advances (or rely on `get_job_progress` for
queue jobs), and register a recurring host-cron check that compares the
file's freshness against the expected progress interval. The agent also
checks it at the start of the next turn. A checkpoint that stops advancing
means **stalled**, not "still running" — the freshness comparison is the
entire value of this rung.

### Rung 3 — foreground + output buffering (PGLite / no worker / no scheduler)

Run the operation inline in the foreground — on PGLite that's
`gbrain jobs submit ... --follow`, or just the raw command — and buffer
all output to a file, reading bounded slices, per
`skills/conventions/exec-output.md`. An empty tool result after a long
command is truncation, not a dead shell. This rung has no silent-death
insurance, so keep the operation in the foreground and stay with it;
backgrounding here recreates the exact failure the ladder exists to
prevent.

### The deadman pattern

A one-shot, self-deleting scheduled check that fires at
expected-finish-plus-margin and verifies the **result was reported** — not
just that the process exited. Arm it **in the same action block as the
submission** (not after, not "if I remember").

1. Estimate `expected_minutes` honestly; round up.
2. Deadline = now + estimate + margin, where `margin = max(10 min, 50% of
   estimate)`. Restarts delay delivery — too tight false-fires, hours-late
   defeats the point.
3. Create the check with whatever one-shot scheduler the host offers: a
   harness cron tool with delete-after-run semantics, `at`, or a crontab
   entry the check removes on first fire. The check's instruction:
   - Verify the result was **already reported to the user**. `gbrain jobs
     get <id>` gives the job state; the reported-check asks whether a
     completion message actually reached the user.
   - **Reported** → do nothing, stay silent, self-delete.
   - **Completed but unreported** (swallowed event) → pull the result via
     `gbrain jobs get <id>` and post the recovery report now, tagged with
     the job ID.
   - **Still running** → post a one-line status with a new ETA and arm ONE
     follow-up deadman at +50% of the original estimate. One follow-up
     max — no infinite chains.
   - **Dead/failed** → report what it produced before dying (`stderr_tail`
     from `gbrain jobs get <id>`) and offer `gbrain jobs retry <id>`.
4. **Disarm on normal completion.** When the completion arrives and you
   report it, remove the deadman. If it fires anyway, the reported-check
   makes it a silent no-op — belt and suspenders.

Failure modes the pattern must own (mirrored in Contract and
Anti-Patterns): the deadman itself dying before it fires (second-line
insurance, backstopped by the next-turn overdue sweep), double-fire
(idempotent reported-check + job-ID-tagged reports), and stale checkpoints
(freshness check before trusting "still running").

Eval contract, imported with the pattern — a deadman deployment is judged
on:

- **ARMED_ON_SPAWN** — created in the same action block as the long
  submission?
- **SELF_DELETING** — one-shot, and silent when all is well?
- **DETECTS_SWALLOWED** — verifies the result was reported, not just that
  the job exited?
- **RECOVERS** — on a swallowed event, pulls the output and posts the
  recovery report?
- **RIGHT_DEADLINE** — expected finish + sane margin, neither false-firing
  nor hours late?

Hard fails: a long user-facing operation with no deadman armed; a deadman
that posts noise when the completion arrived normally; emulating the timer
with `sleep` or a poll loop instead of a scheduler entry (a sleeping
process dies with the session — the exact failure being insured against).

### Sequencing and locks

Maintenance operations share locks (`sync`, `embed`, `extract`,
`integrity`). Run them **sequentially, chained**: submit job 1, arm its
deadman; on completion, submit job 2, arm the next; finish with
`gbrain doctor` and report the health delta. If a job dies mid-operation
its lock expires at TTL (a live, recently-refreshed holder is protected by
the steal grace) — never hand-delete lock rows to "unstick" a queue.

### Typical long operations

Durations scale with corpus size; treat these as order-of-magnitude
anchors for `--timeout-ms`, not promises.

| Operation | Typical duration | Suggested `--timeout-ms` |
|---|---|---|
| `extract all` | 30-60 min on large brains | 3600000 |
| `embed --stale` | 5-30 min (scales with missing count) | 1800000 |
| `sync --all` | 5-20 min | 1200000 |
| `integrity auto` | 10-30 min | 1800000 |
| `dream` | 5-15 min | 900000 |

### Appendix: content-addressed stage checkpoints

For a multi-stage pipeline with an expensive middle (extract → score →
explain → render → verify, where the scoring stage burns real LLM spend),
make each stage a content-addressed checkpoint so a crash — or a
deadman-triggered retry, or a `replay_job` — **resumes** instead of
re-spending:

- **Key each stage** on a hash of (the stage's own logic + its params +
  the hashes of its upstream artifacts). Store artifacts under a `.cache/`
  directory in the pipeline's working tree, addressed by content hash.
- **Warm re-run is a no-op**: every key matches, nothing recomputes, the
  whole pipeline replays in well under a second.
- **Busting cascades correctly**: a param change or a logic edit changes
  that stage's key, recomputing it and every downstream stage whose
  upstream hashes changed. The stage's own source must be part of the
  key — omit it and logic edits silently reuse stale artifacts.
- **Record provenance**: a provenance file per run records each stage's
  key, inputs, outputs, and computed-at, so every artifact traces to the
  exact logic + data that produced it and "which stage recomputed and
  why" stays answerable.
- **Verify integrity on restore**: check live artifacts against recorded
  checksums; a mismatch means recompute or restore from cache, never
  silent reuse.

Judged on: **IDEMPOTENT** (warm re-run recomputes nothing),
**CORRECT_BUSTING** (a change recomputes exactly the affected stages),
**PROVENANCE** (every artifact traces to logic + params + upstreams),
**INTEGRITY** (corrupted artifacts detected, never silently reused).

This composes with the ladder rather than replacing it: the ladder keeps
the pipeline running and reported; stage checkpoints keep a retry cheap.
Pair them whenever a single stage costs more than pocket change in LLM
spend.

## Output Format

When reporting job status to the user:

```
Job #ID (name) — status
Progress: step/total — last action
Tokens: input_count in / output_count out (+ cache_read cached)
Runtime: Xs
Children: N pending, M completed
```

When reporting completion:

```
Job #ID completed in Xs
Tokens used: input / output / cache_read
Result: <summary>
```

When reporting batch status (parent with children):

```
Parent #ID — waiting-children
  #A subagent(Acme) — active, 3/5 steps, 2.5k tokens
  #B subagent(Beta) — completed, 1.8k tokens
  #C subagent(Gamma) — paused
Total tokens so far: 4.3k
```

## Anti-Patterns

- Don't spawn a Minion for a single search query (use search tool directly)
- Don't fire-and-forget without checking results
- Don't spawn > 5 concurrent agents without checking `gbrain jobs stats` first
- For subagent work, don't use `sessions_spawn` with `runtime: "subagent"` when Minions is available (use `gbrain agent run` instead)
- Don't poll `get_job` in a tight loop (use `get_job_progress` for lightweight checks)
- Don't run an operation expected to exceed ~2 minutes as a bare background shell — it dies with the session; route through the Durable execution ladder
- Don't say "I'll report back when it finishes" without an armed deadman or a scheduled check that will actually fire
- Don't let a deadman post noise when the completion arrived normally — check reported-state first, stay silent, self-delete
- Don't emulate the deadman timer with `sleep` or a poll loop — a sleeping process dies with the session, which is the exact failure being insured against
- Don't trust a checkpoint or progress file without a freshness check — a stale checkpoint reads as "still running" forever
- Don't run lock-acquiring maintenance ops (`sync`, `embed`, `extract`, `integrity`) simultaneously, and don't hand-delete lock rows to unstick them (locks expire at TTL)

## Tools Used

- Submit a background job — `submit_job` (MCP, non-protected names only; shell jobs are CLI-only, subagent jobs via `gbrain agent run`)
- Get job details — `get_job` (MCP)
- List jobs with filters — `list_jobs` (MCP)
- Cancel a job — `cancel_job` (MCP)
- Pause a job — `pause_job` (MCP)
- Resume a paused job — `resume_job` (MCP)
- Replay a completed/failed job — `replay_job` (MCP)
- Send sidechannel message — `send_job_message` (MCP)
- Get structured progress — `get_job_progress` (MCP)
- Queue stats — `gbrain jobs stats` (CLI; no MCP equivalent)
