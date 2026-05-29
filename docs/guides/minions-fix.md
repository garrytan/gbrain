# Worker Migration Repair

Use this guide when a Cortex worker migration reports partial state or pending
host work.

## Steps

1. Stop active workers.
2. Run migrations.
3. Inspect pending host work.
4. Register any missing worker handlers in reviewed code.
5. Restart workers.
6. Re-run `cortex doctor`.

```bash
cortex jobs supervisor stop
cortex apply-migrations --yes
cortex doctor --json
cortex jobs supervisor start --detach --json
```

## Partial Handler Migration

If migration output says a handler is missing, add it to the worker plugin or
host worker bootstrap, deploy the worker, and rerun migrations. Do not add a
shell-command mapping file as a shortcut.

## Verify

```bash
cortex jobs stats
cortex jobs list --status waiting --limit 20
cortex doctor --json
```
