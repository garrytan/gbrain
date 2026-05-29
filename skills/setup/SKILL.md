---
name: setup
description: Set up Cortex SaaS onboarding for an organization, including signup, first brain, sources, invites, runtime manifest, and agent-client verification
triggers:
  - "set up cortex"
  - "create cortex org"
  - "initialize company brain"
  - "cortex setup"
tools:
  - saas_signup_create
  - saas_orgs_list
  - saas_brains_list
  - sources_list
  - users_create_invite
  - users_register_agent_client
  - saas_runtime_manifest
  - run_onboard
mutating: true
---

# Setup Cortex

Set up Cortex as a hosted company-brain tenant. The target is not a local-only
setup; the target is an organization that can invite teammates,
connect sources, issue scoped OAuth clients, and point agent runtimes at the
hosted MCP endpoint.

## Contract

Setup is complete only when all of these are true:

- An organization exists.
- At least one brain exists for the organization.
- At least one source exists or the default source is intentionally selected.
- The owner has an onboarding URL and one-time client secret.
- A teammate invite or agent client can be created from the same control plane.
- The runtime manifest is reachable and names Cortex only.
- `cortex connect '<onboarding-url>' --client-secret '<secret>'` is the install
  path for agents and humans.
- The agent can perform the same setup actions through MCP that a human can
  perform through the console.

## Product Model

Use these boundaries:

- **Organization**: billing, domain, members, invites, roles, and plan limits.
- **Brain**: hosted deployment and database boundary. Create multiple brains only
  for hard isolation, region, retention, or scale needs.
- **Source**: team, integration, repository, department, or project boundary
  inside one brain. Use sources as the normal "sub-brain" model.
- **Agent client**: OAuth identity for a teammate, bot, integration, or customer
  agent runtime.
- **Skill policy**: source/client-scoped capability rule enforced by MCP
  dispatch when runtime calls include a skill id.

## Preferred Setup Path

1. Create the tenant:

   ```bash
   curl -X POST https://<tenant-host>/api/signup \
     -H 'content-type: application/json' \
     -d '{"orgName":"Acme AI","email":"owner@acme.ai","domain":"acme.ai"}'
   ```

   Agent path: call `saas_signup_create` with the same fields.

2. Capture the returned `onboarding_url`, `client_id`, and one-time
   `client_secret`. The secret must not be embedded in the URL.

3. Connect the owner's runtime:

   ```bash
   cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
   cortex runtime install cursor
   cortex runtime install claude-desktop
   ```

4. Open `/admin/onboarding` with the invite payload and confirm the decoded
   tenant endpoint, token URL, client id, scopes, write source, and
   federated-read list.

5. Create the first teammate invite:

   ```bash
   cortex users create-invite \
     --email teammate@acme.ai \
     --role member \
     --source engineering \
     --federated-read engineering,default
   ```

   Agent path: call `users_create_invite`.

6. Create a non-human agent client when no teammate invite is needed:

   ```bash
   cortex auth register-client acme-build-agent \
     --grant-types client_credentials \
     --scopes read,write \
     --source engineering \
     --federated-read engineering,default
   ```

   Agent path: call `users_register_agent_client`.

7. Fetch and inspect runtime packaging:

   ```bash
   curl https://<tenant-host>/runtime-manifest.json
   cortex runtime install cursor --manifest-url https://<tenant-host>/runtime-manifest.json
   ```

   Agent path: call `saas_runtime_manifest`.

8. Run onboarding checks:

   ```bash
   cortex onboard --check --json
   ```

   Agent path: call `run_onboard`.

## Supabase And Hosting Notes

Cortex talks to Postgres directly over the database connection string. The
Supabase anon key is not enough for the server. Production deployments should
store `CORTEX_DATABASE_URL`, `CORTEX_PUBLIC_URL`, the bootstrap token, email
delivery secret, billing webhook secret, Composio webhook secret, and provider
keys in the host secret manager.

Use Supabase for managed Postgres plus pgvector. Use Railway, Docker, or another
host for the Cortex HTTP server. Public signup can run on a shared hosted brain;
dedicated enterprise brains can be provisioned later as separate deployments.

## Agent Parity Checklist

Before considering onboarding done, verify both paths:

- Human console can create orgs, brains, sources, invites, clients, skills, and
  runtime setup.
- Agent MCP can call `saas_signup_create`, `saas_orgs_list`,
  `saas_brains_list`, `sources_list`, `users_create_invite`,
  `users_register_agent_client`, `saas_skills_list`, `saas_skills_upsert`,
  `saas_runtime_manifest`, and `run_onboard`.
- Invite delivery records can be listed, claimed, marked, and drained through
  the console or MCP worker operations.
- Runtime configs contain the hosted MCP URL, not OAuth secrets.
- Source access is enforced by OAuth scopes and federated-read lists, not by
  local runtime conventions.

## Troubleshooting

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| Signup returns an onboarding URL without a client id | Old provisioning receipt or failed client creation | Re-run signup or create a client with `users_register_agent_client`. |
| Runtime install cannot find an MCP URL | `cortex connect` was not run and no manifest URL was passed | Pass `--manifest-url` or run `cortex connect` first. |
| Teammate can query the wrong source | Client has a broad `federated_read` list | Revoke and recreate the client with the intended sources. |
| Skill runs for the wrong agent | Runtime did not pass `_skill_id` or policy allows too many clients | Update the runtime adapter and tighten the skill policy. |
| Email delivery stays queued | Provider env is missing | Configure Resend and run invite delivery drain. |

## Anti-Patterns

- Do not create a local-only setup when the request is for a tenant.
- Do not place the one-time client secret inside an onboarding URL.
- Do not create a human-only console path without a matching MCP/control-plane operation.
- Do not widen source access to make onboarding easier; issue the right scoped client.
- Do not hand database credentials to agents that only need runtime onboarding.

## Output Format

Return:

- Signup URL or admin onboarding URL.
- Organization id and default brain id when available.
- Client id and scopes.
- Whether the one-time secret was shown out of band.
- Runtime manifest URL.
- Verification commands the agent or teammate should run.

## Handoff

Give the user the signup URL, the owner onboarding URL, and the admin invite
screen. Give agents the same onboarding URL plus one-time secret and the runtime
manifest URL. Do not give anyone database credentials unless they are operating
the hosted Cortex deployment.
