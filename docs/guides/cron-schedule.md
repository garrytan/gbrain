# Scheduled Tenant Work

Cortex scheduled jobs keep tenant sources fresh and maintain retrieval quality.
In SaaS deployments, these jobs run as hosted workers or provider schedules, not
as personal-machine cron entries.

## Core Jobs

| Cadence | Job | Purpose |
| --- | --- | --- |
| Every few minutes | Connector ingestion | Pull or receive updates from Composio-backed tools. |
| Hourly | Source sync | Reconcile repo/doc sources and enqueue embeddings. |
| Nightly | Maintenance | Reindex stale chunks, inspect failed jobs, refresh derived data. |
| Weekly | Quality review | Run doctor checks and summarize tenant health. |

## Guardrails

- Jobs must run with tenant/org/brain context.
- Jobs that notify humans must respect quiet-hours policy.
- Worker failures should land in the Jobs and Activity tabs.
- Agent-triggered jobs must use the same source and skill-policy checks as UI
  actions.

## Verification

```bash
cortex jobs list
cortex sources status
cortex doctor --json
```

The admin console should show waiting jobs, failed jobs, request volume, and
source freshness for operator review.
