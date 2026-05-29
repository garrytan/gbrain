# Runtime And Knowledge Boundaries

Cortex separates agent runtime behavior from tenant knowledge, but the SaaS
boundary is no longer "two local repos." In production, the hosted Cortex brain
is the source-scoped knowledge service and local runtimes are thin clients.

## Boundaries

| Layer | Owns | Examples |
| --- | --- | --- |
| Cortex SaaS | Tenant knowledge and control-plane state | organizations, brains, sources, members, invites, OAuth clients, skill policies, request logs |
| Runtime package | Client setup and skills needed to connect | `cortex connect`, runtime manifest, setup/schema-author skills |
| Customer tools | External systems feeding sources | Slack, Google Drive, GitHub, Linear, meeting tools through Composio or webhooks |

The hosted brain is the durable knowledge layer. Local files are either source
inputs, generated runtime config, or development artifacts.

## Decision Test

When adding a new artifact, ask:

| Question | Location |
| --- | --- |
| Does it configure a tenant, member, source, invite, client, plan, or skill policy? | Cortex control plane |
| Is it customer knowledge that should be queryable by agents? | A scoped Cortex source |
| Is it a local client config for Claude, Cursor, ChatGPT, or another runtime? | Runtime package output |
| Is it an integration credential or webhook secret? | Host or provider secret manager |
| Is it a temporary job artifact or build output? | Ephemeral worker storage |

## Agent Rule

Agents should not create private company knowledge in their own local runtime
folders. They should write through Cortex using the scoped OAuth client they were
given during onboarding. That keeps source permissions, audit logs, and skill
policy enforcement consistent across humans and agents.

## Verification

Use the live SaaS smoke to prove the boundary:

```bash
bun run smoke:saas-live -- --json
```

The smoke creates an organization, brain, owner onboarding URL, teammate invite,
source, skill policy, agent OAuth client, Composio ingestion event, OAuth token,
and MCP `tools/list` call. Any new major console action should have an equivalent
agent-callable operation and should be added to this verification path when it is
part of onboarding or tenant operations.

## Related

- [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md)
- [SaaS Runtime Packaging](../deploy/saas-runtime-packaging.md)
- [Multi-Tenant SaaS Deployment](../deploy/multi-tenant-saas.md)
