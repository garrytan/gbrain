# Connect GBrain to Hermes

> This page is the MCP-registration reference for Hermes (the NousResearch
> `hermes-agent`). For the full brain install — CLI, engine, skills, dream
> cycle — follow [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md) first;
> this page wires the finished brain into Hermes over stdio MCP.

Hermes spawns `gbrain serve` as a local stdio subprocess. No server, no tunnel,
no token needed. Works with both PGLite and Supabase engines.

## Register (recommended)

```bash
printf 'Y\n' | hermes mcp add gbrain --env GBRAIN_HOME=$HOME --connect-timeout 60 --command $(which gbrain) --args serve --surface starter --advertise verbs
```

The tool list shows the seven memory verbs (`recall`, `remember`, `entity`, …)
plus `request_tools`; every other operation stays callable, and `request_tools`
lists it and returns its schema. Drop `--advertise verbs` to list every
operation.

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

## Brain-first instructions

Registering the MCP server only makes the tools available. Agents seldom call a
brain nobody told them about, so finish the install with:

```bash
gbrain setup hermes --instructions-only
```

It writes one short marked block into `$HERMES_HOME/SOUL.md` (default `~/.hermes/SOUL.md`), after your identity
text, which stays first and unchanged: before answering any turn,
search the brain first, read the best hit, fill gaps with other tools, apply your own
access rules, then finish the task. Text outside the markers is never touched, a
re-run upgrades the block in place, `--dry-run` previews it,
`--no-instructions` opts out (and is remembered) and `--remove` takes it out.
`gbrain doctor` warns when the block is missing or out of date. Setup never
creates `SOUL.md`: Hermes uses a non-empty one instead of its default identity,
so start Hermes once (it seeds the file) or write your identity there first.

The same rule also rides every turn. Setup appends a marked `pre_llm_call` shell
hook to `$HERMES_HOME/config.yaml` and records its approval in Hermes's
`shell-hooks-allowlist.json` for that exact command:

```yaml
hooks:
  pre_llm_call:
    - command: "/bin/echo '{\"context\":\"GBrain: before answering this turn, check GBrain first ...\"}'"
      timeout: 10
```

The command is self-contained: it echoes the rule as Hermes's `{"context": ...}`
wire shape, starts no gbrain process and needs no path on the Hermes host but
`/bin/echo`. Hermes appends that context to each user message, so the rule
reaches the model next to the turn instead of only in the system prompt. Text
outside the markers is never touched, and a re-run after an upgrade rewrites the
command and moves its approval. When config.yaml already has a `hooks:` section,
setup prints the entry to add yourself instead; approve it when Hermes asks (or
set `HERMES_ACCEPT_HOOKS=1`). `hermes hooks doctor` checks it: setup runs it
when `hermes` is on PATH and exits non-zero with `turn_hook_not_loaded` when the
hook is not healthy ([repair](../guides/repair.md#turn-hook-not-loaded)).
`--no-instructions` and `--remove` take the hook and its approval out.

Hermes lists gbrain's tools only inside `tool_search`'s description, so with an
MCP connection the rule also names them (`mcp_gbrain_recall`, `mcp_gbrain_entity`
and the rest) and says to find them with `tool_search`.

Search results also carry `_meta.brain_hot_memory`, the brain's recent facts.
Hermes may pass them to the model; they can include other sessions' facts, so
see [the channel's contract](../protocol/MCP_META_CHANNELS.md#brain_hot_memory)
before relying on them.

## Direct config (equally supported)

The add command writes an `mcp_servers` block into `$HERMES_HOME/config.yaml`
(default `~/.hermes/config.yaml`). You can write it yourself instead:

```yaml
mcp_servers:
  gbrain:
    command: gbrain
    args:
      - serve
      - --surface
      - full
      - --advertise
      - verbs
    env:
      GBRAIN_HOME: /home/alice-example
    connect_timeout: 60.0
    enabled: true
```

To remove gbrain, delete this block (or set `enabled: false` to disable
without losing the config).

## Always-loaded core memory

Hermes does not read MCP server instructions, so core memory
([guide](../guides/core-memory.md)) reaches it through a project context file:

```bash
gbrain compile-context --target hermes --include-core
```

This writes `.hermes.md` at the git root and adds it to the repository's local
exclude file (`.git/info/exclude`), so it is never committed. Rerun it after
core changes; `gbrain doctor` names a stale copy.

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
