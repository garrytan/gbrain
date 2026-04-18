---
name: minion-orchestrator
version: 1.0.0
description: |
  Manage background agents via Minions job queue. Use when: spawning subagents,
  checking agent progress, steering running agents, pausing/resuming work,
  parallel task execution, fan-out research. Replaces sessions_spawn for
  durable, observable, steerable agents.
triggers:
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
  - get_job_stats
mutating: true
---

# Minion Orchestrator

## Contract

Minions is a Postgres-native job queue for durable, observable agent orchestration.
Every background agent task goes through Minions. No in-memory subagent spawning.

Guarantees:
- Jobs survive gateway restart (Postgres-backed)
- Every job has structured progress, token accounting, and session transcripts
- Running agents can be steered mid-flight via inbox messages
- Jobs can be paused, resumed, or cancelled at any time
- Parent-child DAGs with configurable failure policies

## When to Use Minions vs Inline Work

| Condition | Action |
|---|---|
| Single tool call, < 30s | Do it inline |
| Multi-step, any duration | Submit as Minion job |
| Parallel work (2+ streams) | Submit N Minion jobs with shared parent |
| Needs to survive restart | Submit as Minion job |
| User wants progress updates | Submit as Minion job with progress tracking |
| Research / bulk operation | Submit as Minion job, always |
| File imports, bulk embeds | Submit as Minion job |

**Rule of thumb:** If it takes more than 3 tool calls, use a Minion.

## Phase 1: Submit

```
submit_job name="research" data={"prompt":"Research Acme Corp revenue","tools":["search","web_search"]}
```

Options:
- `queue` — queue name (default: 'default')
- `priority` — lower = higher priority (default: 0)
- `max_attempts` — retry limit (default: 3)
- `delay` — ms delay before eligible

For parallel work, submit a parent then children:
```
submit_job name="orchestrate" data={"task":"research 5 companies"}
# Returns parent_id

submit_job name="research" data={"company":"Acme"} parent_job_id=PARENT_ID
submit_job name="research" data={"company":"Beta"} parent_job_id=PARENT_ID
submit_job name="research" data={"company":"Gamma"} parent_job_id=PARENT_ID
```

Parent auto-enters `waiting-children` and unblocks when all children finish.

## Phase 2: Monitor

```
list_jobs --status active          # what's running?
get_job ID                         # full details + logs + tokens
get_job_progress ID                # structured progress snapshot
get_job_stats                      # health dashboard
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

## Phase 5: Review Results

```
get_job ID                         # result, token counts, transcript
```

Token accounting: every job tracks `tokens_input`, `tokens_output`, `tokens_cache_read`.
Child tokens roll up to parent automatically on completion.

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
  #A research(Acme) — active, 3/5 steps, 2.5k tokens
  #B research(Beta) — completed, 1.8k tokens
  #C research(Gamma) — paused
Total tokens so far: 4.3k
```

## Anti-Patterns

- Don't spawn a Minion for a single search query (use search tool directly)
- Don't fire-and-forget without checking results
- Don't spawn > 5 concurrent agents without checking `get_job_stats` first
- Don't use `sessions_spawn` with `runtime: "subagent"` when Minions is available
- Don't poll `get_job` in a tight loop (use `get_job_progress` for lightweight checks)

## Tools Used

- Submit a background job (submit_job)
- Get job details (get_job)
- List jobs with filters (list_jobs)
- Cancel a job (cancel_job)
- Pause a job (pause_job)
- Resume a paused job (resume_job)
- Replay a completed/failed job (replay_job)
- Send sidechannel message (send_job_message)
- Get structured progress (get_job_progress)
- Get job queue stats (get_job_stats)
