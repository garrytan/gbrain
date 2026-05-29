# Connect Cortex To Claude Desktop

Claude Desktop should connect to the hosted Cortex MCP endpoint from the tenant
runtime manifest. Do not configure a local server for normal SaaS onboarding.

## Setup

1. Get the teammate or owner onboarding URL from the Cortex console or invite.
2. Connect the Cortex CLI:

   ```bash
   cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
   ```

3. Install the Claude Desktop config:

   ```bash
   cortex runtime install claude-desktop
   ```

4. Restart Claude Desktop.

The generated config contains the hosted Cortex MCP URL. It does not contain the
one-time OAuth client secret.

## Manifest-Only Setup

Agents can configure Claude Desktop without a prior local profile when they have
the tenant manifest URL:

```bash
cortex runtime install claude-desktop \
  --manifest-url https://<tenant-host>/runtime-manifest.json
```

## Verify

Ask Claude Desktop to use Cortex for a company question that should hit the
tenant brain. The request should appear in the Cortex Activity page, and the
client id should match the invite or agent client.

## Notes

- Use one OAuth client per teammate or agent runtime.
- Keep source scoping in Cortex; do not duplicate authorization rules in the
  desktop config.
- Re-run with `--force` only when replacing an existing `mcpServers.cortex`
  entry intentionally.
