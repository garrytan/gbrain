# Multi-Source Company Brains

A Cortex brain can contain many sources. Sources are the normal way to model
teams, customers, repos, functions, or sensitive domains inside one tenant.
Create another brain only when the boundary needs separate lifecycle,
residency, backup, or administration.

## Common Patterns

| Pattern | Shape |
| --- | --- |
| Shared company knowledge | One brain, federated sources for docs, meetings, Slack, and repos. |
| Team workspaces | One brain, source per team, OAuth clients scoped to their team plus shared sources. |
| Customer partitions | One brain, source per customer or account segment, limited federated reads. |
| Hard isolation | Separate brain when legal, residency, or admin ownership requires it. |

## Source Fields

Each source has:

- Stable `id`.
- Display name.
- Optional remote URL or connector metadata.
- Federated-read setting.
- Sync/ingestion state.

## Console And Agent Operations

Humans manage sources from the Sources tab. Agents use the same control plane:

- `saas_sources_list`
- `saas_sources_create`
- `saas_brains_list`
- `saas_brains_create`
- `saas_team_list`
- `users_register_agent_client`
- `users_create_invite`

OAuth clients declare one write source and a federated-read list. Reads may span
allowed sources; writes must resolve to exactly one source.

## CLI Examples

```bash
cortex sources status
cortex sources add engineering --name "Engineering" --federated
cortex sync --source engineering
```

For hosted tenants, prefer creating sources through the admin console or MCP
control-plane operations so the change is audited with org/brain context.

## Citation Format

Agents should cite multi-source results with source context, for example
`[engineering:adr/service-split]` or `[customers/acme:renewal-notes]`. Source
IDs are stable even when display names change.
