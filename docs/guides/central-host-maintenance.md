# Optional central-host maintenance ownership

Use this recipe only when an existing, monitored maintenance process already
owns the work that `gbrain serve` would sweep. A central Postgres host may keep
MCP serving interactive requests while an operator controls maintenance windows
and budgets separately. Making that choice explicit at the service boundary
helps preserve it across terminal sessions without a private wrapper patch.

The normal [remote MCP setup](remote-mcp.md) remains the default. These examples
are manual, opt-in configuration; they install no scheduler and change no
GBrain defaults, model selection, authentication, source routing or database
policy. A running Autopilot alone is **not** proof of equivalent coverage.

## What this setting does

`GBRAIN_SWEEP=0` is a process environment variable, not a `gbrain config set`
key. It disables serve-resident startup/idle maintenance sweeps and the HTTP
corpus drain. It does not turn the server into a read-only service, disable
explicit writes or model calls, or turn off separately running workers,
Autopilot or cron jobs. It also does not disable opted-in hook capture or
immediate writeback extraction. See [ambient writeback](ambient-writeback.md).

Before choosing it, record who handles each sweep responsibility:

| Work | Evidence to keep from the chosen maintenance owner |
| --- | --- |
| Facts-fence reconciliation | Source coverage, completed run and remaining backlog |
| Link/timeline extraction | Sources/pages covered and successful completion |
| Corpus ingestion and failed-turn catch-up | Capture consent, pending files, failures and spend limits |

The sweep implementation is [`src/core/sweep.ts`](../../src/core/sweep.ts).
This table identifies ownership work; it does not assert that another scheduler
already implements it. Disabling the drain without a replacement can leave
failed or deferred writeback files pending. On PGLite, a separate maintenance
CLI cannot simply open the brain while serve owns its single-writer lock;
retain the normal sweeps unless an appropriate lifecycle is already arranged.

## Configure only the serving service

First complete the normal `gbrain mcp expose` setup and verify the existing
service. Keep its generated wrapper: it loads the protected environment and
reads the admin token at runtime. Do not copy keys, tokens, database URLs or
private endpoint names into a service definition or this repository.

**macOS launchd:** the [plist example](central-host-snippets/com.gbrain.serve.plist.example)
shows the `EnvironmentVariables` entry alongside placeholders for the existing
wrapper, working directory and logs. It is a reference, not a replacement for
an installed plist. Back up `~/Library/LaunchAgents/com.gbrain.serve.plist`,
then merge only `GBRAIN_SWEEP` as string `0` into its existing
`EnvironmentVariables` dictionary, preserving other settings. Paths in a plist
must be absolute: launchd does not expand `~` or `$HOME`. If rendering the
example separately, replace every `@...@` token and XML-escape path values.

Validate the edited plist with `plutil -lint`, then reload this service in its
existing GUI domain during an approved maintenance window. Do not load a
second agent under a different label. Re-running `gbrain mcp expose` regenerates
the plist, so recheck the override after reinstallation or upgrades.

**Linux systemd user service:** copy the [drop-in](central-host-snippets/maintenance.conf.example)
to `~/.config/systemd/user/gbrain-serve.service.d/maintenance.conf` after
backing up any file already there. Run `systemctl --user daemon-reload`, then
restart only `gbrain-serve.service` during an approved maintenance window.
The drop-in keeps the generated `ExecStart`, authentication and log settings.
It applies to a user unit, not a system-wide unit.

The generated wrapper sources shell profiles, then `~/.gbrain/env` (or the
installed `GBRAIN_HOME` equivalent); those assignments can override the
supervisor's value. Remove any conflicting `GBRAIN_SWEEP` assignment before
relying on these examples. Putting `GBRAIN_SWEEP=0` into that shared env file
instead affects every process that sources it, including Autopilot's wrapper;
service-local configuration makes the intended scope easier to review.

## Verify and undo

1. Check the supervisor's loaded configuration and the serving process's
   effective `GBRAIN_SWEEP` value without dumping its secret-bearing environment.
   A plist or drop-in on disk alone does not prove the running value changed.
2. Run `gbrain mcp expose --status --json` and verify an authorized MCP read
   from the intended client. A healthy endpoint proves reachability, not that
   maintenance is covered.
3. Observe an actual scheduled maintenance run, its receipts and backlog for
   every source it should handle. Run `gbrain doctor --json`; keep any warnings
   and failures rather than changing thresholds to accept the deployment.

To undo, restore the previous plist entry or drop-in, check for remaining env
overrides, and reload/restart the same service. With no `GBRAIN_SWEEP=0` in the
effective environment, normal serve sweeps resume. Pending corpus work may
then use configured models and budget; restoring the timer is not proof that
the backlog completed.

These templates do not provide a complete deployment, a backup/restore plan,
an upgrade coordinator, a cost cap, or a retention/hard-delete policy. They
cannot prove model quality or the replacement scheduler's equivalence. Validate
those choices separately against the installed release and local requirements.
