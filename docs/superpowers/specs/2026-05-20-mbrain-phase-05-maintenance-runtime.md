# Phase 05: Maintenance Runtime

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 04

## Goal

Build a Postgres-backed runtime for memory maintenance work. This runtime gives
MBrain durable jobs, cycle locks, leases, retries, progress, and backpressure
without turning MBrain into a general shell job or arbitrary agent platform.

## Design Decisions

- Runtime is scoped to memory maintenance.
- It uses Postgres-native coordination.
- It borrows proven gbrain Minions ideas: idempotency, locks, timeout, progress,
  parent/child structure where needed, backpressure, and stale recovery.
- It does not expose unrestricted shell job execution.
- Restricted LLM/agent runners are introduced later and must use this runtime.

## In Scope

- `memory_jobs` table.
- job status lifecycle.
- job progress and result schema.
- idempotency keys.
- retry/backoff.
- timeouts.
- lock token and lock expiration.
- cycle lock table.
- worker heartbeat.
- backpressure and max-waiting controls.
- failure classification.
- structured job logs.
- foreground pressure yielding.

## Out Of Scope

- launchd/systemd/cron installation.
- dream phase implementation.
- local Claude/Codex runner.
- shell command execution.
- personal data connectors.

## Job Schema

Core tables:

- `memory_jobs`
- `memory_job_events`
- `memory_job_logs`
- `memory_job_artifacts`
- `memory_cycle_locks`
- `memory_worker_heartbeats`

`memory_jobs` fields:

- `id`
- `name`
- `queue`
- `status`
- `priority`
- `payload_json`
- `result_json`
- `progress_json`
- `max_attempts`
- `attempts_started`
- `attempts_finished`
- `backoff_type`
- `backoff_delay_ms`
- `lock_token`
- `lock_owner`
- `lock_expires_at`
- `timeout_ms`
- `timeout_at`
- `idempotency_key`
- `parent_job_id`
- `created_at`
- `started_at`
- `finished_at`
- `updated_at`

Statuses:

- `waiting`
- `active`
- `completed`
- `failed`
- `dead`
- `cancelled`
- `delayed`
- `paused`
- `waiting_children`

## Cycle Locks

Maintenance cycles use a cycle lock separate from job locks.

`memory_cycle_locks` fields:

- `id`
- `cycle_name`
- `holder_pid`
- `holder_host`
- `holder_kind`
- `acquired_at`
- `ttl_expires_at`
- `heartbeat_at`

Rules:

- only one write-capable maintenance cycle per brain
- holders refresh TTL between phases
- stale holders can be reclaimed after TTL
- release only by matching holder
- read-only inspections do not require cycle lock

## Idempotency And Backpressure

Every recurring job must have an idempotency key.

Examples:

- `autopilot-cycle:<slot>`
- `dream:<phase>:<slot>`
- `projection:<target>:<assertion_hash>`
- `forgetting-review:<source>:<date>`

Backpressure:

- per job name max waiting
- per queue max active
- per source max active extraction
- per runner max active
- global maintenance pressure limit

If a queue is wedged, later periodic submissions coalesce instead of piling up.

## Failure Classification

Failure classes:

- `database`
- `lock_timeout`
- `runner_unavailable`
- `llm_unavailable`
- `policy_denied`
- `source_unavailable`
- `prompt_injection_quarantine`
- `secret_redaction_required`
- `projection_failed`
- `timeout`
- `cancelled`
- `internal`

Failure class affects retry policy and report severity.

## Foreground Pressure

Maintenance workers should yield when foreground agent sessions are performing
latency-sensitive operations.

Pressure inputs:

- active MCP write
- active interactive CLI operation
- active Codex/Claude session grant
- high database lock wait
- user-configured quiet hours

Workers can pause between jobs or phases. They should not abandon already
committed mutation state.

## Tests

Required tests:

- worker claims job with lock token
- stale lock can be reclaimed
- idempotency key dedupes repeated submissions
- max waiting prevents pile-up
- timeout moves active job to failed/dead according to policy
- retry increments attempts and applies backoff
- cycle lock prevents concurrent write cycles
- foreground pressure pauses job claiming
- job logs and events are append-only

## Acceptance Criteria

- MBrain can run durable maintenance jobs safely in Postgres.
- Recurring jobs are idempotent and backpressured.
- Stalled workers do not permanently wedge the queue.
- Later autopilot, dream, forgetting, projection, and runner phases can use the
  runtime.
