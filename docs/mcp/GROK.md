# Connect GBrain to Grok Build

> This page is the MCP-registration reference for **Grok Build** — xAI's
> official `grok` CLI (early beta, subscriber-gated; not the community
> `superagent-ai/grok-cli`, which ships a colliding `grok` binary — see
> Troubleshooting). For the full brain install — CLI, engine, skills, dream
> cycle — follow [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md) first;
> this page wires the finished brain into Grok Build over stdio MCP.
> The `gbrain bootstrap` persistent-personal-agent path is **not yet
> supported for Grok** (Claude Code and Codex only today) — brain-only
> install is what this page delivers.

Grok Build spawns `gbrain serve` as a local stdio subprocess. No server, no
tunnel, no token needed. Works with both PGLite and Supabase engines.

## Register (recommended)

```bash
grok mcp add gbrain -e "GBRAIN_HOME=$HOME" -- gbrain serve --surface verbs
```

`--surface verbs` exposes the seven-verb memory protocol (`recall`,
`remember`, `entity`, `synthesize`, `forget`, `context_pack`, `delta` —
[MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md)) instead of the full
100+-op catalog — the recommended starting surface for coding agents.
Three facts about `grok mcp add`, all observed:

- **The env flag is repeatable, one `KEY=value` per flag** (`-e A=1 -e B=2`).
  Server argv goes after `--`.
- **Registration is lazy.** The add writes config and exits 0 without
  connecting — even for a nonexistent command. Verify with `grok mcp doctor`
  (below), never with the add's exit code.
- **Scope:** the default writes to `~/.grok/config.toml`; add `-s project`
  to write a committable `./.grok/config.toml` instead (reference secrets as
  `${VAR}` in project scope — values are stored verbatim).

## Direct config (equally supported)

The add command writes an `[mcp_servers.gbrain]` block into
`~/.grok/config.toml` (or `./.grok/config.toml` with project scope; the
`GROK_HOME` env var relocates the user config dir). You can write it
yourself instead:

```toml
[mcp_servers.gbrain]
command = "gbrain"
args = ["serve", "--surface", "verbs"]
startup_timeout_sec = 60
enabled = true

[mcp_servers.gbrain.env]
GBRAIN_HOME = "/home/alice-example"
```

`startup_timeout_sec` defaults to 30; raise it (or export
`GROK_MCP_STARTUP_TIMEOUT_SECS`) if gbrain runs from source via `bun run`,
which cold-transpiles on first spawn. To remove gbrain, delete the block (or
set `enabled = false` to disable without losing the config).

## Zero-config vendor fallback

Grok Build also reads MCP registrations from `~/.claude.json`, `.cursor/mcp.json`,
and a project `.mcp.json` — at lower priority than its own config, and **only
for folders you have trusted** in Grok (fresh folders report
`folder untrusted` until you accept the trust prompt). If you already
registered gbrain for Claude Code, Grok may pick it up with zero
configuration. `grok mcp doctor --json` reports every source it consulted
and which one each server came from — check the `source` field to see which
config won before assuming the native one did.

## Verify

```bash
grok mcp list --json        # entry: {"name":"gbrain","enabled":true,...}
grok mcp doctor gbrain      # THE real probe: spawns the server
```

`grok mcp doctor gbrain` performs the actual handshake — expect the checks
`command found`, `server started`, `handshake OK`, and `7 tools discovered`
(the seven verbs), exit 0. A broken registration exits 1 with a failing
check and a hint. Then one real round-trip:

```bash
grok -p "use the gbrain recall tool to answer: what did I import most recently?"
```

`grok -p` (single-turn headless) prints the final answer on stdout.

## Import session logs

Grok Build writes one `chat_history.jsonl` per session under
`~/.grok/sessions/<url-encoded-cwd>/<uuid>/` (`GROK_HOME` relocates the
user dir). Those dead logs import through the same `gbrain transcripts ingest`
lane as Claude Code / Codex / OpenClaw / Hermes:

```bash
gbrain transcripts ingest                    # discover, including ~/.grok/sessions
gbrain transcripts ingest --all              # import every discovered harness log
gbrain transcripts ingest ~/.grok/sessions --format grok --dry-run
```

**Say to your agent:** *"Archive my grok session transcripts"* — *"Import my Grok Build chat history into the brain."*

Sidecars (`updates.jsonl`, `events.jsonl`, `summary.json`, `prompt_history.jsonl`)
are skipped; only `chat_history.jsonl` is a session. User/assistant text
turns land as conversation pages; system prompts, reasoning, and tool
traffic do not.

## Headless auth + model pin

For cron jobs, CI, or any non-TTY run:

- **Auth:** export `XAI_API_KEY` (from console.x.ai). Keyless headless runs
  exit 1 with `Not signed in`; `grok login --device-code` is the
  interactive-terminal alternative, `grok login` the browser one.
- **Model pin:** pass `-m <model>` per call, or set it in config:

  ```toml
  [models]
  default = "grok-4.5"
  ```

- **Updates:** Grok self-updates by default. For pinned/reproducible
  environments, seed:

  ```toml
  [cli]
  auto_update = false
  ```

## Pair with cron

Grok Build has no built-in cron; schedule headless one-shots with your
system scheduler:

```bash
# crontab: brain maintenance every 4 hours
0 */4 * * * XAI_API_KEY=... grok -p "Run gbrain sync and report anything unusual" --output-format plain
```

See [docs/guides/cron-schedule.md](../guides/cron-schedule.md) for the full
brain maintenance protocol (sync, embed, dream cycle).

## Troubleshooting

- **Wrong `grok` on PATH** — the community `superagent-ai/grok-cli` also
  installs a `grok` binary. The official CLI answers `grok --version` with
  `grok X.Y.Z (buildhash)`; anything else is the other tool. Install the
  official one via `npm install -g @xai-official/grok` or
  `curl -fsSL https://x.ai/cli/install.sh | bash`.
- **grok ≠ groq ≠ ngrok** — Grok Build (xAI, `XAI_API_KEY`) is not Groq
  (the inference provider, `GROQ_API_KEY`) and not ngrok (tunnels). A
  mis-set key produces auth errors against the wrong service.
- **`Not signed in` (exit 1)** — no auth in a headless run. Export
  `XAI_API_KEY` or run `grok login --device-code`.
- **Doctor says `folder untrusted`** — the registration came from a vendor
  config (`.mcp.json` / `~/.claude.json`) in a folder Grok hasn't been told
  to trust. Trust the folder in an interactive session, or register
  natively with `grok mcp add`.
- **Doctor times out on `server started`** — raise `startup_timeout_sec`
  (or `GROK_MCP_STARTUP_TIMEOUT_SECS=90`) if gbrain runs via `bun run`.
- **Skills note:** `gbrain skillpack scaffold` writes `skills/<name>/SKILL.md`
  into your workspace, which Grok does **not** auto-discover as Grok skills
  (it reads `.grok/skills`, `~/.grok/skills`, `~/.agents/skills`, plugins).
  gbrain's skills still work as reference documents the agent reads;
  `grok inspect` shows what Grok actually discovered.
- **`grok inspect`** — the config-discovery audit: version, cwd trust,
  instructions, permissions, skills, agents, MCP sources.

---

Verified against **Grok Build v1.0.4** (early beta — expect churn; the pin
is enforced in CI). Dev-facing observed-behavior notes (exact flag
semantics, exit-code caveats, config schema, CI pin values) live in
[GROK-CLI-PIN.md](GROK-CLI-PIN.md).
