# Connect Cortex To ChatGPT

ChatGPT should connect to Cortex as a remote OAuth MCP connector. The tenant
runtime manifest provides the hosted MCP URL, token URL, scopes, and client id.
The one-time client secret is delivered by signup or invite and should not be
stored in the onboarding URL.

## Setup

1. Create or invite a teammate from Cortex.
2. Copy the onboarding URL and one-time secret.
3. Decode or open the onboarding page to inspect:
   - MCP URL
   - token URL
   - OAuth client id
   - scopes
   - write source
   - federated-read list
4. In ChatGPT connector setup, use:
   - Server URL: `https://<tenant-host>/mcp`
   - Authentication: OAuth 2 client credentials
   - Token URL: `https://<tenant-host>/token`
   - Client id: from the invite
   - Client secret: the one-time secret shown out of band
   - Scopes: from the invite

## Agent Path

An admin agent can fetch the same setup object through:

```text
MCP saas_runtime_manifest
```

or:

```bash
curl https://<tenant-host>/runtime-manifest.json
```

Use `runtimes.chatgpt.connector` as the connector template.

## Scopes

Recommended scopes for ChatGPT are `read write` unless the connector is operated
by an admin agent. Admin operations should use a separate OAuth client with
explicit admin scopes.

## Verify

Ask ChatGPT to use Cortex for a tenant question. In the Cortex console, confirm:

- Activity shows the request.
- The client id matches the ChatGPT connector.
- Returned results are limited to the client's federated-read sources.

## Troubleshooting

- If token exchange fails, revoke and recreate the agent client from Cortex.
- If results are missing, inspect the client's write source and federated-read
  list.
- If ChatGPT asks for OAuth metadata, use the tenant manifest and OAuth
  discovery URLs shown in the Runtime page.
