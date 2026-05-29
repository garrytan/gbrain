# Deploy Cortex Hosted MCP

Cortex exposes every tenant brain through hosted HTTP MCP with OAuth 2.1. This
is the production path for ChatGPT, Claude Desktop, Claude Code, Cursor,
Perplexity, and custom agents.

## Endpoints

For a tenant at `https://<tenant-host>`:

```text
GET  /.well-known/oauth-authorization-server
GET  /.well-known/oauth-protected-resource
POST /token
POST /mcp
GET  /runtime-manifest.json
GET  /admin/
GET  /health
```

The admin console and agent runtime setup both use the same tenant metadata. The
runtime manifest is public and contains no secrets.

## Start The Hosted Server

Production deployments should set the public URL explicitly so OAuth discovery
metadata matches the origin clients use:

```bash
cortex serve --http --public-url https://<tenant-host>
```

Set these environment variables in the platform secret manager:

```bash
CORTEX_DATABASE_URL='postgresql://...'
CORTEX_PUBLIC_URL='https://<tenant-host>'
CORTEX_HTTP_CORS_ORIGIN='https://<tenant-host>'
CORTEX_HTTP_TRUST_PROXY=1
CORTEX_ADMIN_BOOTSTRAP_TOKEN='<random-hex>'
CORTEX_SUPPRESS_BOOTSTRAP_TOKEN=1
CORTEX_HOME=/data/cortex
```

For Supabase pooler URLs, also set:

```bash
CORTEX_DISABLE_DIRECT_POOL=1
CORTEX_PREPARE=false
```

## Create Scoped Agent Clients

Preferred paths:

- Public owner signup: `POST /admin/api/signup` (`POST /api/signup` remains compatible)
- Admin UI: `/admin/team`, `/admin/invites`, or `/admin/agents`
- MCP with `users_admin`: `users_create_invite` or
  `users_register_agent_client`

Each client should carry:

- `client_id`
- one-time `client_secret`
- write source
- federated-read source list
- scopes such as `read write`
- onboarding URL

Do not put `client_secret` in the onboarding URL. Show it once, then rely on the
OAuth token endpoint.

## Connect Runtime Clients

Hosted runtime manifest:

```bash
cortex runtime install cursor --manifest-url https://<tenant-host>/runtime-manifest.json
cortex runtime install claude-desktop --manifest-url https://<tenant-host>/runtime-manifest.json
cortex runtime install claude-code --manifest-url https://<tenant-host>/runtime-manifest.json
```

One-time onboarding:

```bash
cortex connect 'https://<tenant-host>/admin/onboarding?invite=...' --client-secret '<one-time-secret>'
```

Generic OAuth clients use:

```text
MCP URL:   https://<tenant-host>/mcp
Token URL: https://<tenant-host>/token
Client ID: cortex_cl_...
Scopes:    read write
```

## Client Notes

- **ChatGPT:** use OAuth 2.1 discovery and the tenant MCP URL.
- **Claude Desktop:** install through the runtime manifest or integration UI.
- **Claude Code:** add an HTTP MCP server pointed at the tenant `/mcp` URL.
- **Cursor:** write `.cursor/mcp.json` through `cortex runtime install cursor`.
- **Perplexity/custom clients:** use client credentials against `/token`, then
  call `/mcp` with the bearer token.

## Scope Enforcement

Remote MCP callers are untrusted. Cortex enforces:

- OAuth scopes.
- Per-client write source.
- Federated-read source list.
- Skill policy status, allowed clients, and source access when calls include
  `_skill_id` or `skill_id`.
- Filesystem confinement for remote upload-style operations.

Legacy bearer tokens are migration-only. New runtime setup should use OAuth
clients created by signup, invite, or agent registration flows.

## Verify

Run the hosted smoke harness:

```bash
CORTEX_PUBLIC_URL=https://<tenant-host> \
CORTEX_ADMIN_BOOTSTRAP_TOKEN=<token> \
CORTEX_COMPOSIO_WEBHOOK_SECRET=<secret> \
CORTEX_BILLING_WEBHOOK_SECRET=<secret> \
bun run smoke:saas-live -- --json
```

The smoke test creates a tenant signup, admin session, invite delivery outbox
records, delivery claim/result updates, provider drain readiness check, billing
reconciliation event, invite, source, skill policy update, agent OAuth client,
Composio webhook event, token exchange, and MCP `tools/list` call.

## Troubleshooting

**OAuth issuer mismatch**

Set `CORTEX_PUBLIC_URL` to the exact public origin clients use.

**`missing_auth` or `invalid_token`**

Exchange the client credentials at `/token`, then call `/mcp` with
`Authorization: Bearer <access-token>`.

**Supabase pooler prepared statement errors**

Use `?prepare=false` in `CORTEX_DATABASE_URL` or set `CORTEX_PREPARE=false`.

**Railway cannot reach direct Supabase database**

Use the Supavisor pooler URL and set `CORTEX_DISABLE_DIRECT_POOL=1`.

**Client receives no Cortex tools**

Confirm the client has `read` or `write` scope, the OAuth token is current, and
the MCP request body is JSON-RPC against `/mcp`.
