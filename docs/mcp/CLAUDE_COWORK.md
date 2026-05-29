# Connect Cortex To Claude Team Workspaces

For team-wide Claude deployments, use a Cortex organization invite or dedicated
agent client per workspace. The connector should point at the hosted Cortex MCP
endpoint, not a teammate's local machine.

## Setup

1. In Cortex, create an agent client for the workspace:

   ```bash
   cortex auth register-client claude-workspace \
     --grant-types client_credentials \
     --scopes read,write \
     --source default \
     --federated-read default
   ```

   Agent path: `users_register_agent_client`.

2. Fetch the runtime manifest:

   ```bash
   curl https://<tenant-host>/runtime-manifest.json
   ```

3. Configure the Claude workspace connector with:
   - Server URL: `https://<tenant-host>/mcp`
   - Token URL: `https://<tenant-host>/token`
   - Client id and secret from the Cortex agent client
   - Scopes from the agent client

## Verify

Ask the workspace connector to query Cortex and confirm the Activity page shows
the dedicated workspace client. Use the Agents page to revoke or rotate access.

## Policy

Create separate clients for separate departments or workspaces when source
access differs. Do not share an owner/admin client for broad team usage.
