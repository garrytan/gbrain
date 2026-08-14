# Connect GBrain to OpenClaw

> This page is the MCP-registration reference card. For the full brain install
> — CLI, engine, skills, dream cycle — follow
> [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md); the README covers the
> bootstrap and connect paths.

Two supported shapes, both stdio.

## Option 1: ClawHub bundle plugin

GBrain ships [`openclaw.plugin.json`](../../openclaw.plugin.json) at the repo
root. Installing the bundle plugin registers the MCP server for you — the
manifest carries an `mcpServers.gbrain` entry (`./bin/gbrain serve`) plus the
bundled skills — and declares the `gbrain-context` context engine. To route
OpenClaw's context-engine slot through gbrain, set:

```
plugins.slots.contextEngine = gbrain-context
```

## Option 2: Direct `~/.openclaw/config.json`

The same shape gbrain's own CI uses (see the "Configure OpenClaw MCP" step in
`.github/workflows/e2e.yml`):

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "GBRAIN_HOME": "/home/alice-example"
      }
    }
  }
}
```

The `env` block is optional: a PGLite brain needs no `DATABASE_URL`, and
`GBRAIN_HOME` only matters when the brain home isn't `~/.gbrain`. Append
`"--surface", "verbs"` to `args` for the seven-verb memory protocol
([MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md)) instead of the full
operation catalog.

## Verify

Start an agent turn and ask it to use the brain:

```
Call get_brain_identity, then search my brain for [topic].
```

If the tools respond, the wiring works. `list_skills` shows everything the
brain can do (gated by `mcp.publish_skills` on the host).

## Remove

Delete the `mcpServers.gbrain` block from `~/.openclaw/config.json`, or
uninstall the bundle plugin.
