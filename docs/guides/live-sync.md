# Live Source Sync

Cortex keeps tenant search current by syncing configured sources and embedding
stale chunks. Hosted tenants should use managed workers, webhooks, or provider
schedules rather than relying on a local machine.

## Prerequisite

For Supabase, use a connection mode compatible with transactions for sync
workers. Transaction-pooler URLs need the documented pooler settings; direct or
session-pooler URLs are safer for DDL and long maintenance jobs.

## Commands

```bash
cortex sources status
cortex sync --source <source-id>
cortex embed --stale
```

For hosted tenants, run these from a worker with the correct tenant database and
secret environment.

## Approaches

- **Webhook ingestion:** best for Slack, meetings, and SaaS tools.
- **Scheduled source sync:** best for repos and document stores.
- **Manual backfill:** best for migrations or large first imports.

## Verification

1. Create or update source content.
2. Run the configured sync or webhook.
3. Confirm `cortex sources status` shows fresh timestamps.
4. Search for text from the update through an OAuth client scoped to that
   source.
5. Confirm a client outside the source cannot retrieve it.
