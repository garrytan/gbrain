# Tutorials

Step-by-step walkthroughs for taking a company tenant from zero to a working
hosted Cortex brain.

## Shipped

- [Set up Cortex as your company brain](company-brain.md) - federated,
  multi-user, OAuth-scoped institutional memory for a 10-50 person team.
- [Deploy the multi-tenant SaaS stack](../deploy/multi-tenant-saas.md) -
  Supabase Postgres, Railway or Docker services, hosted admin console,
  tenant/source conventions, and production preflight.
- [Package runtimes and onboarding URLs](../deploy/saas-runtime-packaging.md) -
  CLI/plugin packaging, invite payloads, runtime manifests, and agent parity.

## Roadmap

- Public signup with production identity, verified domains, email invites,
  and automated first-brain provisioning.
- Enterprise private deployments that keep the SaaS control-plane contract
  while running tenant runtimes in a customer's cloud.
- Connector ingestion with Composio, email, calendar, docs, Slack, GitHub,
  Notion, and repo sources.
- Quality promotion workflows for skills, sources, and brain readiness.
- Codebase indexing for teams that want Cortex-aware engineering agents.

## Related Documentation

- Reference: [`docs/architecture/`](../architecture/)
- Deployment: [`docs/deploy/`](../deploy/)
- Integrations: [`docs/integrations/`](../integrations/)
- MCP setup: [`docs/mcp/`](../mcp/)
- Hosted onboarding: [`INSTALL_FOR_AGENTS.md`](../../INSTALL_FOR_AGENTS.md)
