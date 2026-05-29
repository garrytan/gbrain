# Credential Gateway

Cortex should receive third-party data through scoped connectors and webhooks,
not through agent runtimes holding raw provider credentials.

## Recommended Model

- Store provider credentials in the provider, Composio, Supabase, Railway, or a
  dedicated secret manager.
- Send ingestion events to Cortex webhooks with shared webhook secrets.
- Map every event to an organization, brain, and source.
- Keep OAuth client secrets separate from connector secrets.

## Composio

Composio is the first ingestion integration for the SaaS MVP. The webhook posts
tool events into Cortex:

```http
POST /webhooks/composio
x-cortex-webhook-secret: <secret>
content-type: application/json
```

The endpoint queues ingestion into a Cortex source and is covered by
`scripts/saas-live-smoke.ts`.

## Agent Rule

Agents may request connector setup, inspect integration status, and trigger
approved ingestion flows. They should not receive raw OAuth refresh tokens or
provider API keys in chat, runtime config, or onboarding URLs.
