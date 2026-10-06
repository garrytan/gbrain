# Minions fix: repairing a blocked worker or half-migrated install

**Say to your agent:** *"Use `gbrain jobs supervisor status --json` and
`gbrain doctor --no-migrate` to find why my worker stopped. Show me the affected
installation and proposed repair before changing anything or retrying jobs."*

A local driver or child-CLI configuration failure is not a database outage.
Repair the installation that actually runs the worker, then explicitly restart
its owner. Repeated restarts or replaying the queue do not repair a missing
driver capability.

For a **half-migrated install** (no completed migration, autopilot still inline,
or cron jobs still on `agentTurn`), use the [migration repair](#migration-repair)
below. Do not use migrations as a substitute for repairing a broken driver.

## Identify the owner and installation first

Work in the same account, brain, `GBRAIN_HOME`, configuration and environment as
the affected owner. A healthy `gbrain` in an interactive shell does not prove a
service uses that executable. Preserve queue, concurrency, CLI-path and other
existing launch options throughout the repair.

| Owner | Inspect | Stop processing before repair | Explicit restart after verification |
|---|---|---|---|
| Foreground `gbrain jobs work` | Its startup output and terminal | Ctrl-C in that terminal; wait for shutdown | Run the same `gbrain jobs work` invocation again |
| Standalone jobs supervisor | `gbrain jobs supervisor status --json` | `gbrain jobs supervisor stop --json` | `gbrain jobs supervisor start --detach --json` with the original options |
| Autopilot under user systemd | `gbrain autopilot --status --json`; `systemctl --user status gbrain-autopilot.service` | `systemctl --user stop gbrain-autopilot.service` | `systemctl --user start gbrain-autopilot.service` |
| Autopilot under launchd | `gbrain autopilot --status --json`; `launchctl print "gui/$(id -u)/com.gbrain.autopilot"` | `launchctl bootout "gui/$(id -u)/com.gbrain.autopilot"` | `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.gbrain.autopilot.plist"` |

These are the default brain's user-service names. A brain under any other
`GBRAIN_HOME` uses its own suffixed names; `gbrain autopilot --status --json`
prints them under `job` ([several brains on one host](live-sync.md#several-brains-on-one-host)).
If the installation uses a different
service definition, use its actual name and recorded launcher. For a foreground
autopilot or a container/cron owner, stop and restart that owner through its
existing launcher; do not start a competing standalone supervisor. A timed-out
stop is not confirmation that work has stopped. Inspect remaining processes
before proceeding.

For systemd, inspect `systemctl --user cat gbrain-autopilot.service`. For
launchd, inspect the installed plist's `ProgramArguments`. Follow any wrapper
to the exact executable or checkout it invokes. Do not paste environment
files, credentials or database URLs into a public report.

### Upgrade and rollback ordering

Upgrading while an older owner (0.59.0.0 or earlier) is still running keeps
working: that owner respawns the upgraded worker, which processes jobs without
publishing readiness status. Restart the owner when convenient to get readiness
reporting and configuration blocking. Rolling a worker back below 0.59.3.0
under a 0.59.3.0 or later owner is different: the older worker never reports
readiness, so the owner's 120-second startup deadline stops and restarts it
repeatedly. Stop the owner first, roll back, then start the owner from the
rolled-back installation.

## Interpret the failure before choosing a repair

Workers check readiness before queue recovery or claiming jobs. In process
isolation, readiness also checks the selected job-child CLI. Periodic probes
continue to distinguish local configuration failures from database failures.

| Finding | Meaning | Action |
|---|---|---|
| `client_misconfigured` with `postgres_cancellation_unavailable` | The actual Postgres connection owner lacks the cancellation capability required for signalled SQL | Repair the worker's driver installation; also verify the selected job-child installation |
| `child_executable_invalid` | The selected child executable cannot be used | Follow [child executable repair](#child-executable-invalid) |
| `child_protocol_incompatible` | The selected child does not implement the required worker protocol/capabilities | Follow [child protocol repair](#child-protocol-incompatible) |
| `pool_starved` | The read lane failed while the direct lane answered | Follow [transient or slow retry diagnosis](#transient-or-slow-retry); do not label this a missing driver patch |
| `server_unreachable` | The database probes failed without evidence of a local capability failure | Diagnose reachability and allow bounded [transient retries](#transient-or-slow-retry) |
| `unknown` | The available probe evidence cannot distinguish the cause, for example without a direct lane | Inspect the diagnostic detail; do not guess a permanent configuration fault |

A reservation timeout, network error or ordinary cancellation alone does not
prove the driver is incompatible. A typed local capability fault on either
lane takes precedence over a generic outage diagnosis. PGLite does not require
the Postgres cancellation capability and does not use the standalone Postgres
supervisor.

### Configuration blocked

**Liveness is not readiness.** A supervisor or autopilot can be alive and
heartbeating while configuration-blocked and unable to start work. Read the
additive `processing_ready`, `processing_state`, `processing_stage`, `retry_at`,
`reason_code`, `blocked_since`, `worker_identity` and `child_identity` fields as
well as the existing running/freshness status.
`processing_state: configuration_blocked` means no
processing even when the liveness command exits successfully. Missing readiness
data is not evidence of readiness; standalone supervisor status reports
`unknown` for a live owner without that data and `stopped` when not running.
A blocked owner stays blocked: repairing files in place does not silently
resume processing. Repair, verify, then explicitly restart the owner.

These are **illustrative subsets**, not complete status responses. A healthy
standalone supervisor can report:

```json
{
  "running": true,
  "processing_ready": true,
  "processing_state": "ready",
  "processing_stage": "ready",
  "retry_at": null,
  "reason_code": null,
  "blocked_since": null,
  "worker_identity": { "executable": "/opt/gbrain/gbrain", "version": "1.2.3" },
  "child_identity": { "executable": "/opt/gbrain/gbrain", "version": "1.2.3", "protocol_version": 1 }
}
```

The same live owner can instead be blocked by a stale child override:

```json
{
  "running": true,
  "processing_ready": false,
  "processing_state": "configuration_blocked",
  "processing_stage": "configuration_blocked",
  "retry_at": null,
  "reason_code": "child_protocol_incompatible",
  "blocked_since": "2026-01-01T12:00:00.000Z",
  "worker_identity": { "executable": "/opt/gbrain/gbrain", "version": "1.2.3" },
  "child_identity": { "executable": "/opt/gbrain-old/gbrain", "version": "unknown" }
}
```

`unknown` does not identify an installed version; it means the handshake did
not establish one. Identities may also be `null` when unavailable. Autopilot
retains its own freshness `state` instead of the supervisor's `running` field;
its additive processing fields must be checked separately. Neither example
proves that queued jobs have completed.

### Transient or slow retry

Ordinary crashes still use the soft retry budget (`--max-crashes`) and capped
backoff. Crossing that budget means degraded retries, not a permanent stop.
The separate hard crash ceiling is terminal. A known local configuration fault
blocks immediately rather than consuming those generic crash budgets; a long
network outage is not reclassified as a local fault merely because it lasts.

`processing_state` remains the coarse `starting`, `ready` or
`configuration_blocked` verdict. `processing_stage` explains the current wait:

| `processing_stage` | What to inspect |
|---|---|
| `startup_readiness` | The owner is awaiting worker readiness; inspect subsequent stage updates and startup logs |
| `database_readiness` | Required database lanes are being checked; inspect connectivity and pool availability |
| `child_readiness` | The selected child is being checked; inspect its recorded identity and explicit override |
| `worker_startup` | Worker startup is not yet complete; wait for the actual `ready` transition |
| `ready` | Startup readiness completed; verify real queue progress separately |
| `startup_timeout` | Readiness exceeded the owner's startup budget; inspect logs, not a guessed permanent-fault diagnosis |
| `retry_backoff` | The owner is delaying another attempt; inspect `retry_at` |
| `configuration_blocked` | Automatic retries are disabled; repair and explicitly restart the owner |
| `stopped` | The worker is not processing; inspect owner liveness and why it stopped |

During `retry_backoff`, `retry_at` is the owner's next scheduled retry timestamp
in ISO format, or `null` when no timestamp is available. It is not a guarantee
that the database will be healthy or a job will run at that time. For example,
this live supervisor is waiting, not configuration-blocked:

```json
{
  "running": true,
  "processing_ready": false,
  "processing_state": "starting",
  "processing_stage": "retry_backoff",
  "retry_at": "2026-01-01T12:01:00.000Z",
  "reason_code": null
}
```

A configuration block has `retry_at: null` and still requires manual restart
after repair. A null timestamp alone does not mean blocked: a probe can still
be running. If the standalone owner has no current status record, both state
and stage fall back to `unknown` when alive or `stopped` when not running;
those fallback labels are not extra worker protocol states.

If readiness is still starting or the latest log says it is temporarily
unavailable, compare successive owner-status observations and the owner's
logs. A single slow probe or an expired handshake deadline is not a permanent
fault. Check `gbrain engine status --probe` with the actual launcher; distinguish
database/network failure from pool saturation. Restore connectivity or reduce
the identified competing work with approval, then let the existing owner retry.
Do not repeatedly start new supervisors to accelerate backoff. A foreground
worker that has exited needs an explicit rerun; it has no owner to retry it.

If status remains `unknown`, verify the owner account, `GBRAIN_HOME` and PID-file
selection before concluding the worker is ready or stopped. Missing diagnostics
do not authorize clearing a configuration block. Never reset crash/stall
counters or replay jobs merely because recovery is slow.

If the worker says readiness status could not be published, no jobs were
admitted. Check that its original owner is still running under the expected
account and that the owner's runtime directory is writable. Repair that path
and explicitly restart the owner; do not fabricate status files or copy an old
worker's internal status environment into a new process.

## Repair the installation that owns the failure

### Postgres cancellation unavailable

Stop the affected owner using the table above. Obtain approval for installation
changes separately from diagnostic commands. Choose the matching branch:

- **Bun global install:** reinstall a known-good GBrain release under the same
  account and Bun installation used by the service. The canonical GitHub path
  is `bun install -g github:garrytan/gbrain`; use an approved release ref when
  pinning. Do not substitute the unrelated npm package or change another
  account's global installation.
- **Checkout install:** switch that checkout to the approved fixed revision,
  then run `bun install` in that checkout. If the service uses a linked CLI,
  verify its link still points there. Updating Git without refreshing stale
  dependencies is not enough.
- **Compiled executable:** replace the exact executable named by the service
  with the approved fixed build. Updating a separate source checkout does not
  change an already compiled executable.

GBrain ships its cancellation-capable Postgres.js 3.4.9 in `vendor/postgres`,
with the upstream license. The package-private `#postgres` import maps directly
to that source; compiled builds embed the same resolved driver. The cancellation
changes are recorded in `patches/postgres@3.4.9.patch`. This avoids relying on
transitive local dependencies or a consuming global installation to reapply
GBrain's dependency patch. Repair the GBrain package
as a unit, not by installing stock `postgres` over it or editing another
installation's `node_modules`.

Maintainers should follow [driver provenance and update instructions](../../vendor/README.md)
and use `bash vendor/update-postgres.sh --check` to verify the vendored bytes.
A version string is not a substitute for validating the actual reserved
connection's capability.

Do not bypass the readiness check, remove AbortSignals or use an unsignalled
timeout race as a workaround. Safe cancellation must stop the underlying SQL
and discard its connection when required, not just abandon the caller's wait.

The default job-child CLI follows the current worker's installation. An explicit
`GBRAIN_JOB_CHILD_CLI` override remains authoritative and can keep selecting a
stale executable after the worker has been repaired. Check it in the service's
environment, not just the interactive shell. A compatible version difference
is diagnostic information; a protocol or required-capability mismatch blocks
startup. Do not clear an intentional override without the operator's approval.

### Child executable invalid

For `child_executable_invalid`, stop the original owner and compare its recorded
`child_identity.executable` with `GBRAIN_JOB_CHILD_CLI` in that owner's
environment. Check that the selected file exists and is executable by that
account. A path in a different interactive shell is not a repair. Use the
matching global, checkout or compiled-install branch above; change a stale
override or permissions only with approval. Then run the diagnostics below
against both installations and explicitly restart the original owner. Do not
fall back to a different PATH executable without explaining the change.

### Child protocol incompatible

For `child_protocol_incompatible`, repair the selected child with a compatible
GBrain release, not just the parent worker. A completed malformed reply or
missing required protocol/capability can cause this diagnosis; a timeout alone
does not. Inspect the explicit override first. Compare each executable's
reported version, but do not treat equal versions as proof of compatibility or
different versions as proof of failure. The automatic startup handshake is the
protocol/capability check. Keep the block in place until repair and explicit
owner restart; do not invoke the hidden handshake command as a public repair
API or bypass its guard.

## Verify, restart and watch actual progress

### Read-only readiness diagnostics

Run this Bash block under the owner's account, working directory and environment,
including its `GBRAIN_HOME`, brain selection and `GBRAIN_JOB_CHILD_CLI` if set.
Edit the absolute launcher and owner-status array first. For a checkout, use
`actual_cli=(/absolute/path/to/bun /absolute/path/to/gbrain/src/cli.ts)`.
Use the CLI itself, not the service start wrapper: a wrapper may ignore the
diagnostic arguments and start processing instead.
For autopilot, replace the status array with
`owner_status=(autopilot --status --json)`. For a standalone supervisor, retain
its actual `--queue` and `--pid-file` options. Do not source an arbitrary service
file as shell code or print its secrets.

```bash
(
  actual_cli=(/absolute/path/to/gbrain)
  owner_status=(jobs supervisor status --json)
  brain_args=()
  diagnostic_failed=0

  if [[ ! -x "${actual_cli[0]}" ]]; then
    printf 'Set actual_cli to the executable used by this owner.\n' >&2
    exit 2
  fi

  run_check() {
    local label="$1" code
    shift
    printf '\n--- %s ---\n' "$label"
    if "$@"; then code=0; else code=$?; diagnostic_failed=1; fi
    printf '\n[%s: exit %s]\n' "$label" "$code"
  }

  printf 'Worker invocation:'
  printf ' %q' "${actual_cli[@]}"
  printf '\n'
  run_check 'Worker version' "${actual_cli[@]}" --version
  run_check 'Owner status' "${actual_cli[@]}" "${brain_args[@]}" "${owner_status[@]}"
  run_check 'Worker doctor' "${actual_cli[@]}" "${brain_args[@]}" doctor --no-migrate --json
  run_check 'Database reachability' "${actual_cli[@]}" "${brain_args[@]}" engine status --probe

  if [[ -n "${GBRAIN_JOB_CHILD_CLI:-}" ]]; then
    printf '\nExplicit child invocation: %q\n' "$GBRAIN_JOB_CHILD_CLI"
    child_executable=$(command -v -- "$GBRAIN_JOB_CHILD_CLI") || child_executable=''
    if [[ -n "$child_executable" && -x "$child_executable" ]]; then
      printf 'Resolved child executable: %q\n' "$child_executable"
      run_check 'Selected child version' "$child_executable" --version
      run_check 'Selected child doctor' "$child_executable" "${brain_args[@]}" doctor --no-migrate --json
    else
      printf 'Selected child is missing or not executable by this account.\n' >&2
      diagnostic_failed=1
    fi
  else
    printf '\nNo explicit child override in this environment; compare child_identity with the worker installation.\n'
  fi
  exit "$diagnostic_failed"
)
```

If the original worker is foreground-only, use `owner_status=()` and omit the
`run_check 'Owner status'` line: there is no owning daemon status to query. Inspect
that worker's terminal diagnostics instead. Set `brain_args=(--brain example-brain)`
only when that matches the owner's original selection; otherwise leave it empty.

This block does not install, migrate, restart, claim or retry work. Nonzero
diagnostic exits are printed and retained in the block's final exit code, not
treated as proof that the next check cannot run. `doctor --no-migrate` reports
the current schema without applying migrations; do not add `--fix` or replace
it with plain `doctor` in this diagnostic block.
Supervisor status also skips schema migration when it needs a database lookup
because the local PID file is absent. These are observational commands, not a
filesystem-forensic read-only mode: opening an embedded database can touch its
raw database files or WAL, just as `doctor --no-migrate` can.
An exit of zero from the block is not a readiness verdict: owner status keeps
its liveness exit semantics, so a blocked owner can still return zero. Check
`processing_ready`, `processing_state` and the identity match below explicitly.

**Verify the identity match before interpreting health:** compare the printed
worker invocation and version with `worker_identity` in owner status. With a
source launcher, compare its CLI source path, not just the Bun executable. If
an override is set, compare its path and separately printed version with
`child_identity`; an absent/`unknown` identity is an unresolved check, not a
match. Follow symlinks or wrappers to the recorded installation if the spellings
differ. If status names another installation, stop and correct the diagnostic
context rather than repairing the one found by your interactive PATH.

These public diagnostics gather readiness evidence; they do not run or bypass
the internal protocol. The worker's automatic startup handshake validates the
selected child's protocol and database readiness before any claims. A parent's
doctor result does not certify a different child installation. With a live
PGLite owner, a separate DB-backed doctor may be unable to acquire the exclusive
file lock; report that limitation rather than stopping the owner automatically
or declaring the check passed. Review output locally and redact private paths,
URLs and credentials before sharing it.

An ordinary successful SQL query alone is not proof that cancellation works.
Doctor and database-repair diagnostics remain usable with a broken driver;
they must be able to explain the local failure. For a reachability failure,
follow [engine detection and access repair](../ENGINES.md#engine-detection-and-access-repair)
instead of repeatedly reinstalling.

After verification, explicitly restart only the original owner using the
table above. Confirm readiness, then inspect queue progress:

```bash
gbrain jobs stats --json
gbrain jobs list
```

Compare successive observations: completed jobs should increase when work is
available, without recurring worker restarts or growing stall counts. An empty
queue is valid; do not create paid or side-effecting work just to make a counter
move. A live process alone does not establish recovery.

**Say to your agent:** *"Verify the repaired worker and its selected child CLI,
restart only the original owner with my approval, and show whether existing
jobs complete without new restarts or stalls. Do not replay failed jobs."*

## In-flight work and limits of recovery

A local fault discovered after startup stops new claims first. Confirmed
stopped work can be returned to delayed state through an active-job and
ownership-token check, without charging an attempt or stall solely for this
configuration shutdown. A stale token must not overwrite a completed,
cancelled or newly owned job.

### Release-unconfirmed

**Unconfirmed shutdown or release is not a successful requeue.** An inline
handler may ignore cancellation; a child may leave descendants; a cleanup
signal or database release may fail. If execution stop or token-fenced release
cannot be confirmed within the shutdown budget, lease expiry is the fallback.
That fallback can still incur stalls, and surviving work may still perform
side effects. Inspect the per-job result before deciding what to retry.

Process-group cleanup and optional tini subreaper mode improve cleanup on
supported systems. Positive stop verification currently uses bounded Linux
`/proc` checks of known groups and observed descendants; unavailable or failed
checks retain the unconfirmed fallback. They do not guarantee containment of
descendants that escaped before observation, and running under tini does not
make every process PID 1. Per-child hard RSS enforcement remains a separate TODO; this repair
does not control every large job's memory use or eliminate autopilot's own
memory footprint.

Inspect dead-lettered and failed jobs individually. At-least-once execution
means a job can have performed side effects before it stopped. Do not reset
stall counts, retry all dead letters or replay the queue as part of installation
repair. Retry only explicitly selected work after reviewing its effects and
obtaining approval.

## Migration repair

Minions self-heals on upgrade. If an install is only partially
set up (no `~/.gbrain/preferences.json`, autopilot still inline, cron jobs
still on `agentTurn`), run:

```bash
gbrain apply-migrations --yes
```

It's idempotent. On an install that already migrated it's a cheap no-op.

## Context

The Minions schema, queue, worker, and migration skill ship together, and
the migration fires automatically on `gbrain upgrade` and via the
`postinstall` hook. An install is half-migrated when the schema is present
but the migration never completed: no `~/.gbrain/preferences.json`,
autopilot still runs inline, cron jobs still call `agentTurn`. This guide
covers detecting that state and finishing the migration.

## Detecting the half-migrated state

```bash
gbrain doctor
```

If the install is half-migrated, you'll see the `minions_migration` check
fail:

```
[FAIL] minions_migration: MINIONS HALF-INSTALLED (partial migration: 0.11.0). Run: gbrain apply-migrations --yes
```

Three or more partial records in a row read as `WEDGED MIGRATION(s)` and name
`gbrain apply-migrations --force-retry <version>`. After that retry the version
is pending again, and doctor warns that it has not run yet with the plain
`gbrain apply-migrations --yes` command. Doctor also warns when the ledger shows
a host migration that a newer one already ran past, so it never ran:

```
[WARN] minions_migration: 1 host migration(s) not run yet: 0.53.0. Run: gbrain apply-migrations --yes
```

(Missing `~/.gbrain/preferences.json` on a fresh install is a valid
pre-`apply-migrations` state — doctor deliberately does NOT fail on that
alone; the partial-migration record is the canonical half-migration signal.)

For a machine-readable report (cron-friendly):

```bash
gbrain skillpack-check --quiet && echo healthy || echo needs_action
gbrain skillpack-check | jq -r '.actions[]'    # prints proposed repairs, without executing them
```

Health checks report proposals only. Review the action and scope and obtain
separate approval before applying a repair, installing services or spending money.

## The fix

```bash
gbrain apply-migrations --yes
```

Reads `~/.gbrain/migrations/completed.jsonl`, diffs against the TS
migration registry, runs whatever's pending. Seven phases:

```
A. Schema        gbrain init --migrate-only
B. Smoke         gbrain jobs smoke
C. Mode          prompt (or --yes default pain_triggered)
D. Prefs         write ~/.gbrain/preferences.json
E. Host          AGENTS.md marker injection + cron rewrites for gbrain
                 builtins; JSONL TODOs for host-specific handlers
F. Install       gbrain autopilot --install (env-aware)
G. Record        append completed.jsonl status:"complete"
```

If Phase E emits TODOs for host-specific handlers (e.g. your OpenClaw's
own non-gbrain crons), the migration finishes with `status: "partial"`.
Your host agent walks the TODOs using `skills/migrations/v0.11.0.md` +
`docs/guides/plugin-handlers.md`, ships handler registrations in the
host repo, then re-runs `gbrain apply-migrations --yes`. Newly
registerable cron entries get rewritten and the JSONL rows mark
`status: "complete"`.

A failed phase makes the run exit nonzero and prevents that attempt from being
recorded as complete. Inspect the reported phase failure before retrying;
pending host work is not the only reason an attempt can remain partial.

## Verify the fix landed

```bash
# 1. Preferences exist and are readable
cat ~/.gbrain/preferences.json

# 2. Migration recorded
cat ~/.gbrain/migrations/completed.jsonl

# 3. Autopilot is supervising a Minions worker child
# (the exit code is the verdict — 0 fresh, 1 needs attention,
#  2 self-disabled — so a nonzero exit here IS the finding, not a
#  broken verify step. Under `set -e`, append `|| true` to keep going.)
gbrain autopilot --status
ps aux | grep 'jobs work'

# 4. Jobs show up in the queue
gbrain jobs list

# 5. Any host-specific TODOs still pending
cat ~/.gbrain/migrations/pending-host-work.jsonl 2>/dev/null || echo "(none — all host work is done)"

# 6. Doctor + skillpack-check should both be clean
gbrain doctor
gbrain skillpack-check --quiet && echo ok
```

## If the fix fails

Each phase is idempotent. Re-running is safe. Common failure modes:

- **Phase B smoke fails:** the schema didn't apply. Check
  `~/.gbrain/config.json` has a valid `database_url` (or `database_path`
  for PGLite). Run `gbrain init --migrate-only` directly and look at
  the error.
- **Phase F install fails:** your host environment doesn't match any
  detected target. Pass `--target <macos|linux-systemd|ephemeral-container|linux-cron>`
  explicitly.
- **Pending host work never clears:** your host agent hasn't shipped
  handler registrations yet. Read
  `~/.gbrain/migrations/pending-host-work.jsonl`, open
  `skills/migrations/v0.11.0.md`, and follow the host-agent instruction
  manual.

## Related

- `skills/migrations/v0.11.0.md` — full migration skill for host agents.
- `skills/skillpack-check/SKILL.md` — when and how to run the health check.
- `docs/guides/plugin-handlers.md` — plugin contract for host-specific
  handlers.
- `skills/conventions/cron-via-minions.md` — the canonical cron rewrite
  pattern.
