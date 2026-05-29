# How Agents Should Talk To Cortex

This guide is for authors of agent runtimes that need to operate a Cortex tenant:
Claude Code, Cursor, ChatGPT connectors, Perplexity, internal bots, and custom
MCP clients.

The product has one preferred surface: hosted HTTP MCP with OAuth. Local shell
execution exists for operator-only maintenance, but customer and teammate
runtimes should use scoped OAuth clients.

## Preferred Surface: Hosted MCP

Use hosted MCP for:

- search and retrieval
- writing pages or events
- source inspection
- teammate invites
- agent client lifecycle
- runtime manifest retrieval
- skill policy inspection and update
- plan and console snapshots
- onboarding checks

Setup:

```bash
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
cortex runtime install cursor
cortex runtime install claude-desktop
cortex runtime install claude-code --json
```

Custom runtimes should read:

```text
GET https://<tenant-host>/runtime-manifest.json
```

Then call:

```text
POST https://<tenant-host>/token
POST https://<tenant-host>/mcp
```

with the OAuth client id, secret, and scopes issued by Cortex.

## Admin Agent Surface

Admin agents use MCP operations rather than private database access:

| Capability | MCP Operation |
| --- | --- |
| Create tenant | `saas_signup_create` |
| Create/list orgs | `saas_orgs_create`, `saas_orgs_list` |
| Create/list brains | `saas_brains_create`, `saas_brains_list` |
| Invite teammate | `users_create_invite` |
| Create agent client | `users_register_agent_client` |
| Revoke/update client | `users_revoke_agent_client`, `users_update_agent_client_ttl` |
| Tenant source management | `saas_sources_create`, `saas_sources_list` |
| Source diagnostics | `sources_status` |
| Integration readiness | `saas_integrations_status` |
| Skill policy | `saas_skills_list`, `saas_skills_upsert` |
| Runtime setup | `saas_runtime_manifest` |
| Plan state | `saas_plan_get`, `saas_plan_update` |
| Health/activity | `saas_console_snapshot`, `run_onboard` |

## Source Scoping

Every OAuth client should have:

- one write source
- explicit federated-read sources
- minimal scopes
- a clear role and owner
- token TTL where appropriate

Do not share an owner/admin client across multiple agents. Create distinct
clients so Activity, rate limits, revocation, and source access stay auditable.

## Skill Calls

If a runtime invokes a skill-backed operation, include one of:

- `_skill_id`
- `skill_id`
- `_meta.skill_id`

Cortex dispatch checks the persisted skill policy before running the underlying
operation. Draft skills, disallowed clients, and disallowed sources fail closed.

## Operator-Only Shell Jobs

Some host maintenance work may still run as jobs on the Cortex worker, such as
embedding backfills or migration checks. Use this only for operator-owned
deployment work, not normal customer runtime behavior.

```bash
CORTEX_ALLOW_SHELL_JOBS=1 cortex jobs work
```

When a shell job needs secrets, use inherited config names instead of embedding
secret values in the job row:

```json
{
  "cmd": "cortex embed --stale",
  "cwd": "/data/cortex",
  "inherit": ["database_url"]
}
```

The worker resolves `database_url` to `CORTEX_DATABASE_URL` at child-spawn time.
The job record stores only the name.

## Do Not

- Do not ask customers to run a separate backend for normal use.
- Do not put client secrets in onboarding URLs.
- Do not put OAuth secrets in Cursor or Claude Desktop config files.
- Do not duplicate Cortex source filtering inside the runtime.
- Do not use local shell jobs for actions already exposed through MCP.
- Do not grant admin scope to generic team connectors.

## Verification

An agent integration is ready when it can:

1. Fetch the runtime manifest.
2. Exchange OAuth credentials for a token.
3. Call `tools/list`.
4. Read and write only within its source scope.
5. Invite or create clients only when it has admin scopes.
6. Pass skill ids on skill-backed calls.
7. Show activity in the Cortex console.
