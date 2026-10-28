# Connect GBrain to Cursor

Adding memory to an existing Cursor agent preserves its identity and needs no private repository. Use the [memory-only walkthrough](../tutorials/connect-coding-agent.md). Connecting an existing hosted brain? Choose [native OAuth or a private machine handoff](../guides/hosted-harness-access.md). Opening the owner dashboard or managing clients uses [MCP administration](ADMIN.md) with its separate owner credential.

## Install as a Cursor plugin

gbrain ships a Cursor plugin manifest, `.cursor-plugin/plugin.json`, next to the Codex and Claude Code manifests. It registers the same MCP server and the same curated brain-first skill set as those lanes.

Cursor discovers local plugins in `~/.cursor/plugins/local/` after a reload. Clone the plugin branch into that folder:

```bash
git clone --depth 1 --branch codex-plugin https://github.com/garrytan/gbrain.git ~/.cursor/plugins/local/gbrain
```

Then run **Developer: Reload Window** (or restart Cursor) and open **Customize**. The `gbrain` MCP server and the gbrain skills appear there.

The `codex-plugin` branch is the history-less plugin dist that every release force-publishes. Despite its name it carries the manifests of every plugin lane, the Cursor one included. A clone of the full repository also works, but it downloads the whole development tree and tracks master. Cursor skips a symlink in the local plugin folder when it points outside that folder, so clone or copy the files instead of linking a checkout. On Teams and Enterprise plans, an admin controls local plugins with **Allow Local Plugin Imports** (Dashboard → Settings → Security & Identity → Marketplace and Plugins), which is off by default on Enterprise.

To update the plugin, delete `~/.cursor/plugins/local/gbrain` and clone it again. Each release replaces the branch with a new single commit, so `git pull` cannot fast-forward it. Refresh the binary separately with the `gbrain-upgrade` skill or by re-running `bun install -g github:garrytan/gbrain#latest-stable`.

**Prerequisites.** The plugin cannot ship the gbrain binary. Install it once with `bun install -g github:garrytan/gbrain#latest-stable` (the npm package named `gbrain` is unrelated, so never run `npm install -g gbrain`) and create a brain with `gbrain init`, which defaults to a zero-config local PGLite brain. The bundled `setup` skill walks through both.

**Say to your agent:** *"set up gbrain"*

Without a binary, the plugin's MCP server exits and prints that install command on stderr; without a brain, it exits with "No brain configured. Run: gbrain init". The plugin runs on macOS and Linux only.

**What ships.** The MCP server runs `gbrain serve --surface full --source-guard` through the bundled launcher, `.agents/gbrain-launcher`, with `${CURSOR_PLUGIN_ROOT}` as both the command root and the working directory. The launcher tries `$GBRAIN_BIN`, then `~/.bun/bin/gbrain`, then `gbrain` on `PATH`, so it does not depend on the `PATH` Cursor was started with. `full` is every operation, the surface every registration gbrain writes pins. The skills are the committed `plugin/skills/` tree that the Codex and Claude Code plugins also ship.

**Routing.** The server runs from the plugin folder, so per-project `.gbrain-source` and `.gbrain-mount` dotfiles do not apply. With `--source-guard`, write and admin operations on a brain that has several sources and no bound source fail with an error that explains how to bind a source, and reads always pass. The [Codex plugin notes](CODEX.md#install-as-a-codex-plugin-recommended) describe the binding rules, which are the same in both lanes.

## One server per brain

A PGLite brain accepts one writer. The first running `gbrain serve` owns its data directory, and a second `serve` against the same brain fails on the lock. Keep exactly one `gbrain` server in Cursor:

- Remove a hand-written `gbrain` entry from `~/.cursor/mcp.json` or a project's `.cursor/mcp.json` before you install the plugin.
- Cursor also loads Claude Code plugins when **Settings → Agents → Third-Party Imports → Include Third-Party Plugins, Skills, and Other Configs** is on, which is the default. If gbrain's Claude Code plugin is installed on the same machine, check **Customize** for a `gbrain` server that came from it.
- `gbrain doctor` does not inspect Cursor's configuration, so it cannot warn about a second registration there.

When several processes need the brain at once, run one shared `gbrain serve --http` and point every client at it, or move to the Postgres engine. See [serve and sync concurrency](../architecture/serve-sync-concurrency.md).

## Connect without the plugin

To get the MCP server without the skills, add an entry to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "/absolute/path/to/gbrain",
      "args": ["serve", "--surface", "full"]
    }
  }
}
```

Use the absolute path that `command -v gbrain` prints. A bare `gbrain` resolves against Cursor's own `PATH`, which may not include `~/.bun/bin`. For a brain on another machine, publish it with `gbrain mcp expose` ([remote MCP guide](../guides/remote-mcp.md)) and follow [hosted harness access](../guides/hosted-harness-access.md).

## Verify

Open **Customize** and confirm that the `gbrain` MCP server is enabled and lists its tools. Then ask the agent:

```
Call get_brain_identity, then search my brain for [topic].
```

`get_brain_identity` confirms whose brain you are connected to. A new conversation that recalls something saved in an earlier one proves the memory persists.

**Say to your agent:** *"remember that I prefer short commit subjects"*, then in a new conversation, *"what do I prefer for commit subjects?"*

## Remove

Delete `~/.cursor/plugins/local/gbrain` and reload the window. For the plugin-free setup, delete the `gbrain` entry from `~/.cursor/mcp.json`.

## Notes

- The persona variants (`gbrain-coding`, `gbrain-daily`) are Claude Code marketplace entries. The Cursor plugin installs the full skill set.
