# GBrain for Codex Desktop

This package makes GBrain available to Codex Desktop as a local plugin.

It is intentionally thin:

- Codex launches `node ./scripts/launch-gbrain-serve.mjs`
- that launcher resolves a local `gbrain` executable
- then it runs the canonical server via `gbrain serve`

There is no second MCP server here, and no forked search or write logic inside
the plugin package. Codex sees the same GBrain MCP surface that other stdio
hosts see.

## What You Get

- the current GBrain MCP tool surface
- the current repo skill tree, linked into the installed plugin by
  `scripts/install-codex-plugin.mjs`
- the same remote/untrusted MCP behavior GBrain already applies to stdio calls

## Resolution Order

The launcher resolves `gbrain` in this order:

1. `GBRAIN_CODEX_BIN`
2. repo-local `bin/gbrain`
3. `gbrain` on `PATH` with `$HOME/.bun/bin` prepended

If none resolve, the launcher fails with an install hint. This plugin is an
adapter over a local GBrain install, not a standalone runtime bundle.

## Install In Codex Desktop

From the GBrain repo root:

```bash
bun install
bun link
node scripts/install-codex-plugin.mjs
```

Then restart Codex Desktop.

The installer creates `~/plugins/gbrain-codex`, links this package plus the
repo's current `skills/` tree, and updates
`~/.agents/plugins/marketplace.json`.

For a fresh checkout:

```bash
git clone https://github.com/garrytan/gbrain.git ~/gbrain
cd ~/gbrain
bun install
bun link
node scripts/install-codex-plugin.mjs
```

Restart Codex Desktop after install so the local marketplace entry reloads.

## Local Repo Smoke

From the GBrain repo root:

```bash
bun install
test -x "$HOME/.bun/bin/gbrain" || bun link
node plugins/gbrain-codex/scripts/rehearsal.mjs
```

The rehearsal script creates a temp `GBRAIN_HOME`, initializes PGLite, connects
to the plugin over stdio MCP, checks `tools/list`, and exercises `put_page`,
`get_page`, `search`, `query`, `sync_brain`, and the `whoami` fail-closed path.

## Safety Boundary

This plugin does not add or loosen GBrain permissions.

- Codex calls arrive through MCP stdio
- GBrain treats those calls as `remote: true`
- operation-level guards stay inside GBrain core

That means Codex gets the full tool surface, but the same stdio-MCP trust
boundary and restrictions still apply.
