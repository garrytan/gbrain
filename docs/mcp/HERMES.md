# Connect GBrain to Hermes

> This page is the MCP-registration reference for Hermes (the NousResearch
> `hermes-agent`). For the full brain install — CLI, engine, skills, dream
> cycle — follow [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md) first;
> this page wires the finished brain into Hermes over stdio MCP.

Hermes spawns `gbrain serve` as a local stdio subprocess. No server, no tunnel,
no token needed. Works with both PGLite and Supabase engines.

## Register (recommended)

```bash
printf 'Y\n' | hermes mcp add gbrain --env GBRAIN_HOME=$HOME --connect-timeout 60 --command $(which gbrain) --args serve
```

`hermes mcp add` performs a real MCP handshake and tool discovery at add time,
then prompts `Enable all N tools? [Y/n/select]:`. Three gotchas, all observed:

- **`--args` must be the LAST option.** Everything after it — including a
  misplaced `--env` — is swallowed into the server argv. To pass several
  environment variables, list them all after ONE `--env` flag
  (`--env A=1 B=2`); repeating the flag replaces the earlier values and the
  server is saved disabled when its handshake then fails. Put `--env` and
  `--connect-timeout` before `--command`, exactly as above.
- **Pipe the `Y` in non-interactive contexts.** EOF on the enable-tools prompt
  prints `Cancelled.` and saves nothing. The piped `Y` saves the server with
  all tools enabled.
- **The exit code is 0 even on connection failure or cancel.** Never assert on
  `mcp add`'s exit status — verify with `hermes mcp list` and
  `hermes mcp test gbrain` (below).

## Direct config (equally supported)

The add command writes an `mcp_servers` block into `$HERMES_HOME/config.yaml`
(default `~/.hermes/config.yaml`). You can write it yourself instead:

```yaml
mcp_servers:
  gbrain:
    command: gbrain
    args:
      - serve
    env:
      GBRAIN_HOME: /home/alice-example
    connect_timeout: 60.0
    enabled: true
```

To remove gbrain, delete this block (or set `enabled: false` to disable
without losing the config).

## Verify

```bash
hermes mcp list           # table row: gbrain ... ✓ enabled
hermes mcp test gbrain    # exits 0 and prints the discovered tool list
```

Then one real round-trip:

```bash
hermes -z "ask my gbrain brain: what did I import most recently?"
```

`hermes -z` prints the final answer on stdout (benign notices may appear on
stderr). Inside Hermes, gbrain's tools appear namespaced as
`mcp_gbrain_<tool>` (e.g. `mcp_gbrain_search`).

## Headless auth + model pin

For cron jobs, CI, or any non-TTY run, Hermes needs a provider key and a
default model configured without the interactive picker:

- Put the key in `$HERMES_HOME/.env`:

  ```bash
  ANTHROPIC_API_KEY=sk-ant-...
  # or OPENROUTER_API_KEY / OPENAI_API_KEY
  ```

- Pin the model non-interactively (`hermes model` is interactive-only — never
  use it in scripts or CI):

  ```bash
  hermes config set model.default anthropic/claude-haiku-4.5
  hermes config get model.default   # reads it back
  ```

## Pair with cron

Hermes cron is fully non-interactive, which makes it a natural scheduler for
brain maintenance:

```bash
hermes cron create --name gbrain-sync '0 */4 * * *' 'Run gbrain sync and report anything unusual'
hermes cron tick    # run due jobs once and exit — deterministic testing
hermes cron list
```

See [docs/guides/cron-schedule.md](../guides/cron-schedule.md) for the full
brain maintenance protocol (sync, embed, dream cycle).

## Troubleshooting

- **`hermes doctor`** — global health check (installation, config, providers).
  It's not a per-server assertion; use `hermes mcp test gbrain` for that.
- **`agent failed: No inference provider configured`** (exit 1) — Hermes has
  no model key. Set one in `$HERMES_HOME/.env` and pin `model.default` as
  above.
- **Relocating Hermes** — both the installer and the runtime honor
  `HERMES_HOME`. All state (`config.yaml`, `.env`, `SOUL.md`, cron, logs)
  lives under it; the default is `~/.hermes`. Export it consistently or the
  gbrain registration lands in a config file the runtime never reads.

---

Documented against **Hermes Agent v0.20.0 (2026.8.3)**. Dev-facing observed-behavior
notes (exact flag semantics, exit-code caveats, CI pin values) live in
[HERMES-CLI-PIN.md](HERMES-CLI-PIN.md).
