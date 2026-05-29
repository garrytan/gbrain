# Queue Operations Runbook

Use this when Cortex jobs are waiting, stalled, failed, or dead-lettered.

## Quick Checks

```bash
cortex doctor --json
cortex jobs stats
cortex jobs list --status waiting --limit 50
cortex jobs list --status active --limit 20
```

## Common Actions

| Situation | Action |
| --- | --- |
| Worker not running | `cortex jobs supervisor start --detach --json` |
| Job stuck active | Inspect with `cortex jobs get <id>` and cancel if needed. |
| Many waiting jobs | Confirm worker capacity and provider health. |
| Dead jobs | Inspect error, fix the source/provider issue, then resubmit. |

## Shell Jobs

Shell jobs are disabled unless the worker is started with explicit consent:

```bash
CORTEX_ALLOW_SHELL_JOBS=1 cortex jobs supervisor start --detach --json
```

Keep this disabled in hosted tenants unless the workflow requires it.

## Verify

```bash
cortex jobs stats
cortex doctor --json
```

The admin Jobs and Activity tabs should show the same state operators see from
the CLI.
