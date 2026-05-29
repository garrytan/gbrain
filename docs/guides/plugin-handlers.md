# Worker Plugin Handlers

Cortex workers include built-in handlers for sync, embedding, imports,
extraction, backlinks, and maintenance. Host-specific jobs can register
additional handlers in code, not in agent-writable data files.

## Why Code, Not Data

A JSON file that maps job names to shell commands is an unnecessary execution
risk. Handler registration must happen in reviewed worker code or a trusted
runtime plugin.

## Handler Contract

Handlers receive job data, the job row, an abort signal, and an inbox. They
return serializable JSON or throw for retry.

```ts
worker.register('tenant-digest', async (ctx) => {
  const orgId = String(ctx.data.orgId);
  const sourceId = String(ctx.data.sourceId);
  return { orgId, sourceId, ok: true };
});
```

Register handlers before starting the worker so queued jobs can be claimed
safely.

## Trust Boundary

Handler code runs with the worker process privileges. Review it like production
code that can touch tenant data. Agents can submit approved jobs through Cortex,
but they should not be able to write new handler code at runtime.

## Related

- [Worker Deployment Guide](minions-deployment.md)
- [Scheduled Tenant Work](cron-schedule.md)
- [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md)
