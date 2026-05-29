# Cortex Integrations

Cortex integrations bring external systems into a tenant brain through
source-scoped ingestion. The MVP integration strategy uses Composio as the
connector layer and Cortex sources as the authorization and indexing boundary.

## Ingestion Flow

```text
Third-party event
  |
  v
Composio connector
  |
  v
Cortex webhook
  |
  v
Tenant source
  |
  v
Chunking, embedding, facts, links, activity
  |
  v
Scoped MCP retrieval for humans and agents
```

The source id is mandatory. It decides where content lands and which OAuth
clients can read it.

## Integration Objects

| Object | Purpose |
| --- | --- |
| Provider | Composio, Slack, Google Drive, GitHub, Linear, Notion, or another connector source. |
| Source | Cortex team/integration boundary such as `engineering`, `support`, or `integrations-composio`. |
| Ingestion event | Provider payload with external id, content, timestamps, source id, and provenance metadata. |
| Job | Background processing record for chunking, embedding, extraction, and retries. |
| Agent client | OAuth identity allowed to inspect or administer connector state. |

## Composio Webhook

Configure Composio to send events to:

```text
POST https://<tenant-host>/webhooks/composio
```

Set:

```text
CORTEX_COMPOSIO_WEBHOOK_SECRET=<shared-secret>
```

Each event should include enough metadata to resolve:

- organization or tenant
- brain
- source id
- provider
- external object id
- content or content URL
- author/user
- observed timestamp
- raw provider metadata

## Source Scoping

Create a source per team or integration boundary:

```bash
cortex sources add integrations-composio --name "Composio imports"
cortex sources add support --name "Support"
cortex sources add engineering --name "Engineering"
```

Agent path:

```text
sources_add
sources_list
sources_status
```

Then issue OAuth clients with only the sources they should read:

```bash
cortex auth register-client support-agent \
  --grant-types client_credentials \
  --scopes read,write \
  --source support \
  --federated-read support,default
```

## Console Workflow

1. Open Integrations.
2. Confirm provider webhook secret status.
3. Create or select a source.
4. Connect the provider in Composio.
5. Send a test event.
6. Confirm Activity shows ingestion.
7. Confirm Sources shows updated page/job counts.
8. Confirm an agent with the right federated-read list can retrieve it.

## Agent Workflow

An admin agent can:

- create the source
- create an agent client
- fetch runtime setup
- send or validate a test webhook
- inspect source status
- inspect activity through `saas_console_snapshot`
- invite teammates who should read the connected source

The agent should not bypass Cortex authorization by filtering provider data in
the runtime. Provider permissions and Cortex OAuth source scopes both matter;
Cortex remains the enforcement boundary for brain access.

## Reliability

Ingestion should be idempotent by provider and external object id. Retries should
not create duplicate pages. Failed jobs should appear in Jobs and Quality so a
human or agent can replay them.

Before a demo, run:

```bash
bun run smoke:saas-live -- --json
```

The smoke sends a Composio-style event and verifies it queues into a Cortex
source.
