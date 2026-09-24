# Connect GBrain to OpenClaw

> This page is the MCP-registration reference card. For the full brain install
> — CLI, engine, skills, dream cycle — follow
> [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md); the README covers the
> bootstrap and connect paths.

Two supported shapes, both stdio.

## Option 1: ClawHub bundle plugin

GBrain ships [`openclaw.plugin.json`](../../openclaw.plugin.json) at the repo
root. Installing the bundle plugin registers the MCP server for you — the
manifest carries an `mcpServers.gbrain` entry that runs the bundled
`.agents/gbrain-launcher serve` (the same launcher the Codex and Claude Code
plugins use; it resolves your installed `gbrain` via `GBRAIN_BIN`, then
`~/.bun/bin/gbrain`, then `PATH`, so it works under launchd's bare PATH and
never needs a build step) plus the bundled skills — and declares the
`gbrain-context-engine` context engine. To route OpenClaw's context-engine slot
through gbrain, two steps, in this order:

1. Install and enable the plugin by its own id, `gbrain-context-engine`
   (the `id` in `openclaw.plugin.json`).
2. Set the slot to the engine id the plugin registers:

   ```
   plugins.slots.contextEngine = gbrain-context-engine
   ```

The current host requires the canonical plugin ID in the slot. The installed
plugin ID is unchanged and `gbrain-context` remains a registry alias for older
integrations, but it is not a slot alias on current hosts: migrate an old
`plugins.slots.contextEngine = gbrain-context` setting to
`gbrain-context-engine`. Setting the slot alone does not install/enable the
plugin. For a legacy host that cannot provide a per-session workspace, set
`plugins.entries.gbrain-context-engine.config.workspaceDir` to an absolute
workspace path; on multi-agent hosts prefer the host-supplied workspace. An
unbound or ambiguous workspace warns and reads no source rather than selecting
an arbitrary agent's memory.

The factory also accepts zero arguments from current hosts. Its `assemble`
keeps the current prompt separate from fenced stored transcript history; an
identical trailing legacy user message is already the current turn. The
admitted-turn acknowledgement is stateless and writes nothing. Reflex-only
pointer synthesis leaves returned messages unchanged; the turn acknowledgement
does not automatically capture conversation content (compaction has its own
explicit checkpoint path). Loading the plugin alone is not evidence of model
recall: verify saved-page retrieval after a restarted turn and source isolation
with the intended host. The loopback native test uses a deterministic provider,
so it does not certify paid-model recall or provenance.

## Option 2: `openclaw mcp add`

OpenClaw keeps MCP servers under `mcp.servers` in `~/.openclaw/openclaw.json`
(`openclaw config schema` shows the key path). Register gbrain with the CLI:

```bash
openclaw mcp add gbrain --command "$(command -v gbrain)" --arg serve --env GBRAIN_HOME=$HOME
```

Use an absolute `--command` path: the launchd-started gateway's `PATH` does
not include `~/.bun/bin`, so a bare `gbrain` fails to spawn. `--env` is
optional: a PGLite brain needs no `DATABASE_URL`
(`--env DATABASE_URL=postgresql://...` for Postgres), and `GBRAIN_HOME` only
matters when the brain home isn't `~/.gbrain`. For the seven-verb memory
protocol ([MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md)) instead of the
full operation catalog, pass `--surface verbs` as additional `--arg` values
(check `openclaw mcp add --help` for your version's spelling).

Leave `GBRAIN_SOURCE` unset in the MCP env unless you deliberately want
single-source retrieval: a pin scopes every tool (search, `get_brain_identity`
counts, …) to that one source, and nothing warns on reads.

## Verify

`openclaw mcp list` should show `gbrain`. Then start an agent turn and ask it
to use the brain:

```
Call get_brain_identity, then search my brain for [topic].
```

If the tools respond, the wiring works. `list_skills` shows everything the
brain can do (gated by `mcp.publish_skills` on the host).

## Remove

Delete `mcp.servers.gbrain` from `~/.openclaw/openclaw.json` (or run
`openclaw mcp remove gbrain` if your version has it), or uninstall the bundle
plugin.
