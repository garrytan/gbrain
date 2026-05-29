# Connect Cortex To Perplexity

Perplexity connects to Cortex as a remote MCP connector using the hosted tenant
URL and OAuth metadata.

## Setup

1. Create an invite or agent client in Cortex.
2. Copy the onboarding URL and one-time secret.
3. Fetch the runtime manifest:

   ```bash
   curl https://<tenant-host>/runtime-manifest.json
   ```

4. In Perplexity connector setup, use the values from
   `runtimes.perplexity.connector`:
   - Server URL: `https://<tenant-host>/mcp`
   - Token URL: `https://<tenant-host>/token`
   - Client id: from the invite
   - Client secret: one-time secret delivered out of band
   - Scopes: from the invite

## Verify

Ask Perplexity to use Cortex for a company-brain question. Confirm the request
appears in the Cortex Activity page and respects the client's source scope.

## Notes

- Use separate OAuth clients for separate teammates, bots, or workspaces.
- Keep source authorization in Cortex.
- Rotate or revoke the client from the Agents page when access should end.
