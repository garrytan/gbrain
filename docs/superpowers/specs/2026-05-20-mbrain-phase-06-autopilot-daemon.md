# Phase 06: Autopilot Daemon

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 05

## Goal

Provide a local autopilot that runs memory maintenance automatically using the
durable runtime. Autopilot is configured through guided onboarding and can run
under launchd, systemd, cron fallback, or manual development mode.

## Design Decisions

- Autopilot is a core capability but not silently enabled.
- Guided onboarding chooses whether to enable it.
- Autopilot submits idempotent maintenance cycle jobs.
- Autopilot does not perform canonical writes directly; jobs call policy
  services.
- Host scheduler integration is profile-based.

## In Scope

- `mbrain autopilot` command family.
- launchd profile.
- systemd user service profile.
- cron fallback profile.
- manual foreground mode.
- daemon status and health.
- schedule configuration.
- quiet-hours configuration.
- worker liveness checks.
- cycle submission with idempotency and backpressure.

## Out Of Scope

- Dream phase internals.
- Personal data connectors.
- Restricted Claude/Codex runner implementation.
- Web dashboard.

## CLI Surface

Required capabilities:

```text
mbrain autopilot enable
mbrain autopilot disable
mbrain autopilot start
mbrain autopilot stop
mbrain autopilot status
mbrain autopilot install
mbrain autopilot uninstall
mbrain autopilot logs
mbrain autopilot config
mbrain autopilot run-once
```

Exact command names can follow local CLI conventions.

## Onboarding

Guided onboarding asks:

- enable autopilot now?
- preferred scheduler profile detected for this host?
- allow LLM maintenance according to configured budget?
- allow local Claude Code/Codex runner when available?
- confirm source consent defaults?

It should not ask source-by-source advanced policy questions.

## Scheduler Profiles

Launchd:

- user-level plist
- restarts on failure
- logs to MBrain log directory
- uses configured Postgres DSN reference

Systemd:

- user service and timer or long-running service
- restart on failure
- environment file or config reference
- logs through journal plus MBrain logs

Cron fallback:

- submits one-shot `autopilot-cycle` job
- relies on idempotency key
- no long-running worker guarantee unless worker profile configured

Manual:

- foreground loop
- useful for development and debugging

## Cycle Submission

Autopilot submits:

```text
memory_job.name = autopilot_cycle
idempotency_key = autopilot-cycle:<time-slot>
max_waiting = 1
timeout = configured cycle timeout
```

Autopilot should not create unbounded cycles when workers are dead.

## Health And Status

Status includes:

- scheduler installed
- daemon running
- active cycle lock
- last cycle result
- next scheduled run
- worker heartbeat
- queue depth
- failed jobs
- stuck jobs
- Postgres health
- source health
- LLM/runner availability

## Safety

- No autopilot writes outside the configured brain.
- No source processing without consent.
- No LLM use unless configured.
- No raw source access outside source policy.
- Disable stops new job submission but does not corrupt active job state.
- Stop should gracefully release daemon locks.

## Tests

Required tests:

- install profile renders expected service file without secrets
- enable records config and starts/submits as configured
- repeated tick dedupes by idempotency key
- no worker warning surfaces when jobs pile up
- status reports active lock and last cycle
- disable prevents future submissions
- run-once uses same cycle primitive as daemon

## Acceptance Criteria

- Autopilot can be enabled through guided onboarding.
- It submits safe idempotent maintenance cycles.
- launchd/systemd/cron/manual modes have clear behavior.
- Users can inspect and disable it.
