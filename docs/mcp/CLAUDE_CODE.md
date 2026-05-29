# Connect Cortex To Claude Code

Claude Code connects to Cortex through the hosted MCP URL in the runtime
manifest.

## Setup

After signup or invite:

```bash
cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
cortex runtime install claude-code --json
```

The command returns the native Claude Code registration command:

```bash
claude mcp add --transport http cortex https://<tenant-host>/mcp
```

Run the emitted command if your Claude Code environment does not already have
the Cortex server entry.

## Agent-Driven Setup

An admin agent can use the manifest endpoint directly:

```bash
cortex runtime install claude-code \
  --manifest-url https://<tenant-host>/runtime-manifest.json \
  --json
```

## Verify

Ask Claude Code to list Cortex tools or search the company brain. Confirm the
request appears in the Cortex Activity page under the expected OAuth client.

## Remove

```bash
claude mcp remove cortex
```
