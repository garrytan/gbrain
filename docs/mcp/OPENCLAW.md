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
openclaw mcp add gbrain --command "$(command -v gbrain)" --arg serve --arg --surface --arg starter --arg --advertise --arg verbs --env GBRAIN_HOME=$HOME
```

Use an absolute `--command` path: the launchd-started gateway's `PATH` does
not include `~/.bun/bin`, so a bare `gbrain` fails to spawn. `--env` is
optional: a PGLite brain needs no `DATABASE_URL`
(`--env DATABASE_URL=postgresql://...` for Postgres), and `GBRAIN_HOME` only
matters when the brain home isn't `~/.gbrain`. `--surface starter --advertise verbs`
lists the seven-verb memory protocol ([MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md))
plus `request_tools`, which reaches every other tool; drop the
`--advertise verbs` values to list the starter set (`full` for the whole catalog) (check
`openclaw mcp add --help` for your version's `--arg` spelling).

Leave `GBRAIN_SOURCE` unset in the MCP env unless you deliberately want
single-source retrieval: a pin scopes every tool (search, `get_brain_identity`
counts, …) to that one source, and nothing warns on reads.

## Brain-first instructions

Registering the server only makes the tools available. Agents seldom call a
brain nobody told them about, so finish either option with:

```bash
gbrain setup openclaw   # --dry-run previews; --workspace <dir> picks the agent
```

It writes one short marked block into the workspace `AGENTS.md` (from
`OPENCLAW_CONFIG_PATH` or `~/.openclaw/openclaw.json`: a sole agent's
workspace, else `agents.defaults.workspace`, else `~/.openclaw/workspace`; with
several agents, pass `--workspace`). Text outside the markers is never touched,
a re-run upgrades the block in place, `--no-instructions` opts out and is
remembered, and `--remove` takes it out. A thin-client install puts the same
block at the top of `GBRAIN-INSTRUCTIONS.md`.

A rule in `AGENTS.md` reaches the system prompt only, so setup also puts it next
to every user turn with a hook-only OpenClaw plugin, `gbrain-turn-rule`: its
`before_prompt_build` handler returns the rule as `prependContext`. The plugin is
self-contained (the rule text is in its code; it reads and calls nothing) and
lives in `<OpenClaw state dir>/gbrain/gbrain-turn-rule`. Setup installs it with
OpenClaw's own CLI:

```bash
openclaw plugins install --link <state dir>/gbrain/gbrain-turn-rule --force --accept-capabilities
openclaw plugins enable gbrain-turn-rule
openclaw config set plugins.entries.gbrain-turn-rule.hooks.allowConversationAccess true
```

OpenClaw requires `allowConversationAccess` before a non-bundled plugin's
`before_prompt_build` runs. With no `openclaw` on PATH, setup writes the plugin
and prints those commands to run on the OpenClaw host; restart a running gateway
afterwards. `--no-instructions` and `--remove` uninstall the plugin and delete
its directory. A re-run after an upgrade rewrites the plugin with the new text.

OpenClaw lists no gbrain tool after `openclaw mcp set`: the model reaches them
only through `tool_search`, whose results it frames as external data. With an
MCP connection the rule therefore names the tools (`recall`, `entity`, `search`,
`query`) and says to find them with `tool_search` and run them with `tool_call`.
With `openclaw` on PATH, setup runs
`openclaw plugins inspect gbrain-turn-rule --runtime --json` and exits non-zero
with `turn_hook_not_loaded` unless the plugin shows as loaded with
`before_prompt_build` ([repair](../guides/repair.md#turn-hook-not-loaded)).

## Scheduled jobs and workspace scripts

OpenClaw cron jobs, workspace scripts and hooks run with another `HOME` and
environment than the gateway's MCP server. Route every one of them through a
single wrapper that sets `GBRAIN_HOME`, loads the brain's env file and runs the
installed `gbrain` by absolute path; log its stderr and check its exit code
([the wrapper and its rules](../guides/cron-schedule.md#calling-gbrain-unattended)).
On a managed brain, scripts commit the files they write with
`gbrain git commit-push -- <paths>` (never plain `git commit`); a scheduled
`gbrain sources refresh <id>`
keeps it current
([scripts and the managed checkout](../guides/shared-checkout-git.md#scripts-and-the-managed-checkout)).

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
