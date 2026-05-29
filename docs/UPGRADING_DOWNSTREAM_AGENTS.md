# Upgrading Cortex Runtime Plugins

Cortex ships one hosted SaaS control plane and several thin runtime adapters.
Those adapters should stay boring: they read the runtime manifest, write native
client configuration, and point the agent at the hosted MCP endpoint. They do
not fork the backend, duplicate source filtering, or store OAuth secrets in
runtime config files.

Use this guide when releasing or updating the Cortex CLI, connector templates,
or runtime plugins for customer agents.

## Release Contract

Every package must consume the same onboarding contract:

```text
https://<tenant-host>/admin/onboarding?invite=<base64url-json>
```

The decoded payload contains the tenant MCP URL, token URL, OAuth client id,
role, scopes, write source, federated-read list, organization id, and brain id.
The one-time secret is delivered separately by signup, invite, or a trusted
agent handoff.

The public runtime manifest is the machine-readable package index:

```text
GET https://<tenant-host>/runtime-manifest.json
MCP saas_runtime_manifest
```

## Packages We Ship

| Package | Shape | Responsibility |
| --- | --- | --- |
| Cortex CLI | npm/Bun package exposing `cortex` | Connect onboarding URLs, store thin-client profiles, install runtime configs, run diagnostics. |
| Cursor adapter | config writer | Write `.cursor/mcp.json` with the hosted MCP URL and no secret. |
| Claude Desktop adapter | config writer | Write `claude_desktop_config.json` with the hosted MCP URL and no secret. |
| Claude Code adapter | command helper | Emit `claude mcp add --transport http cortex <mcp-url>`. |
| ChatGPT connector template | connector instructions | Show OAuth metadata and server URL from the manifest. |
| Perplexity connector template | connector instructions | Show OAuth metadata and server URL from the manifest. |

Future package managers can wrap the same manifest. The compatibility boundary
is the manifest schema, not a specific client.

## Upgrade Checklist

1. Build and publish the CLI package with the `cortex` binary name.
2. Verify `cortex connect '<onboarding-url>' --client-secret '<secret>'` writes a
   thin-client profile and does not create a local database.
3. Verify `cortex runtime install cursor --manifest-url <url>` writes only the
   hosted MCP URL.
4. Verify `cortex runtime install claude-desktop --manifest-url <url>` writes
   only the hosted MCP URL.
5. Verify `cortex runtime install claude-code --mcp-url <url> --json` emits the
   expected command.
6. Verify ChatGPT and Perplexity connector payloads contain `server_url`,
   `token_url`, `client_id`, and scopes, but not the client secret.
7. Verify skill-backed runtime calls pass `_skill_id`, `skill_id`, or
   `_meta.skill_id` so dispatch can enforce persisted skill policy.
8. Run the hosted SaaS smoke against a tunnel or production URL:
   `bun run smoke:saas-live -- --json`.

## Agent Parity Requirements

Do not ship a UI-only capability. Any action visible in the console must have an
agent-callable path:

- Signup: `saas_signup_create`.
- Organization and brain management: `saas_orgs_*`, `saas_brains_*`.
- Team and invites: `saas_team_list`, `users_create_invite`,
  `saas_invites_list`.
- Invite delivery: `saas_invite_delivery_queue`,
  `saas_invite_deliveries_claim`, `saas_invite_delivery_mark`,
  `saas_invite_deliveries_drain`.
- Agent clients: `users_register_agent_client`,
  `users_update_agent_client_ttl`, `users_revoke_agent_client`.
- Tenant sources: `saas_sources_create`, `saas_sources_list`.
- Source diagnostics: `sources_status`; reserve low-level source row operations
  for operator migration work.
- Integrations: `saas_integrations_status` for Composio connector readiness,
  webhook URL, required environment, and source-link state.
- Skills: `saas_skills_list`, `saas_skills_upsert`.
- Runtime setup: `saas_runtime_manifest`.
- Plan and quality: `saas_plan_get`, `saas_plan_update`,
  `saas_console_snapshot`, `run_onboard`.

## Backward Compatibility Policy

- Keep `cortex.runtime-manifest.v1` additive. New fields are optional for older
  clients.
- Keep runtime config files secret-free.
- Keep source filtering on the hosted control plane. Runtime adapters should not
  reimplement authorization.
- Keep OAuth discovery URLs stable for each brain.
- Keep old aliases only inside implementation compatibility layers, never in
  customer-facing package copy.

## Demo Gate

A runtime release is demo-ready only when an agent can:

1. Create an organization.
2. Receive an onboarding URL and one-time secret.
3. Connect with `cortex connect`.
4. Install at least one runtime config.
5. Invite a teammate.
6. Create a scoped agent client.
7. Add or inspect a source.
8. Inspect skill policy.
9. Call MCP tools through OAuth.

If any step requires manual backend access, the package is not ready for a SaaS
customer demo.
