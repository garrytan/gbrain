# Cortex Release Notifications

Cortex updates are SaaS release events, not per-user local package chores. The
hosted control plane is upgraded by the operator, while agents and teammates use
runtime manifests to detect whether their thin client or connector setup needs a
refresh.

## Goal

Notify admins and admin agents when a Cortex tenant can use a new capability,
then guide them through any required operational action: runtime package update,
schema migration, source connector refresh, billing limit change, or skill policy
review.

## Release Surfaces

| Surface | Owner | Update Path |
| --- | --- | --- |
| Hosted MCP/API server | Cortex operator | Deploy new server build and run migrations. |
| Admin console | Cortex operator | Rebuild and embed the Next.js static admin app. |
| Runtime manifest | Cortex server | Published at `/runtime-manifest.json`. |
| CLI package | Cortex operator | Publish package exposing the `cortex` binary. |
| Runtime configs | Customer/agent | Re-run `cortex runtime install <target>`. |
| Skills | Tenant admin/agent | Review `saas_skills_list` and update policies. |
| Schema packs | Tenant admin/agent | Propose, approve, and sync through schema operations. |

## Notification Flow

1. Operator deploys a new Cortex version.
2. Hosted health and smoke checks pass.
3. Tenant admins see release notes in the console.
4. Admin agents can call `saas_runtime_manifest`, `saas_console_snapshot`, and
   `run_onboard` to determine whether action is needed.
5. If runtime setup changed, the agent asks permission and then runs the relevant
   `cortex runtime install` command.
6. If schema or skill policy changed, the agent proposes a review plan and waits
   for approval before mutating tenant configuration.

## Agent Prompt

When a release requires tenant action, the agent should say what changed in
terms of customer capability:

```text
Cortex has a runtime update available for your tenant.

What changes:
- Cursor and Claude Desktop configs now read the hosted package manifest.
- Runtime configs stay secret-free.
- Skill-backed calls can include skill ids for policy enforcement.

Want me to refresh the runtime config for this workspace?
```

Never silently mutate tenant configuration. Runtime config refreshes, schema
backfills, and skill policy updates all need explicit approval unless the tenant
has granted an automation policy for that exact action.

## Runtime Refresh

```bash
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
cortex runtime install cursor --manifest-url https://<tenant-host>/runtime-manifest.json
cortex runtime install claude-desktop --manifest-url https://<tenant-host>/runtime-manifest.json
cortex runtime install claude-code --manifest-url https://<tenant-host>/runtime-manifest.json --json
```

The runtime manifest is additive. Older clients should ignore unknown fields.
New package metadata lives under `packages`.

## Verification

After any release or tenant refresh:

```bash
curl https://<tenant-host>/health
curl https://<tenant-host>/runtime-manifest.json
bun run smoke:saas-live -- --json
```

Then verify in the console:

- Overview is healthy.
- Runtime page shows package channels.
- Agents page lists expected OAuth clients.
- Skills page shows enforced policies.
- Activity page receives MCP calls from refreshed runtimes.

## Rollback

If a tenant refresh causes issues:

1. Revert the runtime config file from backup or re-run the previous package.
2. Revoke the affected OAuth client if credentials may have leaked.
3. Restore skill policy from the previous `saas_skills_list` snapshot.
4. Restore schema pack with the previous active pack or inverse mutation.
5. Re-run hosted smoke before declaring the tenant healthy.

## Related

- `docs/CORTEX_AGENT_RUNTIME.md`
- `docs/deploy/saas-runtime-packaging.md`
- `docs/CORTEX_VERIFY.md`
