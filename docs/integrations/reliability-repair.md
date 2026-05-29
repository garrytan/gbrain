# Reliability Repair

Older deployments may contain mechanically repairable data issues from early
JSONB and markdown parsing bugs. Cortex exposes detection through `cortex doctor`
and repair through `cortex repair-jsonb`.

## What Can Be Repaired

- JSONB rows that were stored as JSON strings instead of objects.
- Imported markdown pages that should be re-synced after parser fixes.

## Detect

```bash
cortex doctor
```

The doctor output reports affected tables and points to the repair command when
the issue can be fixed mechanically.

## Repair

```bash
cortex repair-jsonb
cortex sync --force
```

For hosted tenants, take a database backup before running repair commands and
capture the doctor output in the tenant operations log.

## Verify

```bash
cortex doctor
```

The relevant integrity checks should return green before you resume normal sync
or ingestion jobs.
