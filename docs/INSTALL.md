# Install

> [!TIP]
> **Fastest: hosted GBrain at [gbrain.io](https://gbrain.io/cli?ref=install-md), for any harness.** One command launches a GBrain hosted on gbrain.io; Claude Code, Codex, ChatGPT, Cursor and every other AI you use connect to it, with nothing to keep online.
>
> ```bash
> curl -sSL https://gbrainio.terminalwire.sh | bash
> gbrainio terminal connect      # in a new terminal
> gbrainio workspace new         # pick a plan in the browser
> claude mcp add --transport http --scope user gbrain https://gbrain.io/mcp
> codex mcp add gbrain --url https://gbrain.io/mcp
> ```
>
> The installer is a shell script for macOS and Linux; read it before you run it.

## Here's how to self-host it

GBrain is MIT-licensed and free to self-host. The recommended start adds memory to the agent you already use and keeps its identity: [Grok Bot](guides/grok-bot.md), [Muse](guides/muse.md), or [Codex / Claude Code](tutorials/connect-coding-agent.md) (`gbrain setup claude-code` or `gbrain setup codex`). An existing hosted brain connects through [harness access](guides/hosted-harness-access.md). A new personal agent with identity files and a private repo uses the [bootstrap guide](guides/bootstrap.md). Read [memory boundaries](guides/memory-boundaries.md) before enabling cloud providers.

The paths below are the manual equivalents. Pick one; mix later if needed.

## 1. Run with an agent platform

Already running [OpenClaw](https://github.com/garrytan/openclaw) or [Hermes](https://github.com/garrytan/hermes)?

```bash
bun install -g github:garrytan/gbrain#latest-stable
gbrain init --pglite --no-embedding   # keyless; no server
gbrain skillpack scaffold --harness openclaw --workspace <ws>   # OpenClaw: the five-skill brain-first core
gbrain skillpack scaffold --all       # Hermes or any other workspace: every bundled skill (skills/manifest.json)
gbrain doctor                         # inspect diagnostics and expected empty-brain warnings
```

Scaffolding creates skill files; it does not prove the harness has loaded them.
Connect and verify the intended harness before calling it activated. Entity
capture, recurring jobs and paid enrichment require separate opt-in; none of
the commands above schedules a daily enrichment job.

Scaffolded skills are first-class files in your agent repo — edit freely. To pull upstream gbrain improvements later, `gbrain skillpack reference <name>` diffs your local copy vs the bundle. If your `RESOLVER.md` / `AGENTS.md` still carries the managed `skillpack install` fence, `gbrain skillpack migrate-fence` strips it once and keeps the routing rows inside it.

To upgrade later, use the [memory-only upgrade path](#memory-only-upgrades)
unless services and provider work were deliberately configured. Upgrade runs
schema migrations and post-upgrade work; non-TTY execution is supported and
skips interactive prompts, not all side effects.

## Memory-only upgrades

```bash
GBRAIN_NO_AUTOPILOT_INSTALL=1 GBRAIN_NO_REEMBED=1 gbrain upgrade --no-autopilot-install
```

The autopilot opt-out reaches package postinstall hooks and migration
orchestrators, and skips existing service-unit rewrites. Other migrations still
run. `GBRAIN_NO_REEMBED=1` independently skips potentially paid reindexing.
The same command upgrades a clone linked with Bun: it fetches, checks the new
release's Bun floor, fast-forwards to the checked commit and runs
`bun install`. Avoid a bare `git pull`, which skips that check. When the new
release needs a newer Bun, `gbrain upgrade` refuses and changes nothing (exit
78): run `bun upgrade`, then the upgrade again
([Bun floor](guides/upgrades-auto-update.md#bun-floor)).
Verify a known keyword result, saved fact and process reopen after upgrading.
See the [agent upgrade steps](../INSTALL_FOR_AGENTS.md#upgrade).

## 2. CLI standalone

No agent platform, just shell + MCP-aware editor.

```bash
bun install -g github:garrytan/gbrain#latest-stable
gbrain init --pglite --no-embedding
```

> **If `bun install -g` hits a postinstall error** (Bun blocks postinstall hooks in some environments), the CLI prints a recovery hint pointing at [#218](https://github.com/garrytan/gbrain/issues/218). Run `gbrain doctor` to diagnose, then `gbrain apply-migrations --yes --no-autopilot-install` manually. The deterministic fallback is `git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain && GBRAIN_NO_AUTOPILOT_INSTALL=1 bun install && bun link`.

The init flow detects your repo size and suggests Supabase for brains > 1000 markdown files. Agent-harness installs that want Postgres first can run the ladder instead:

```bash
gbrain init --prefer-postgres    # env URL → Supabase token discovery → local Postgres → opt-in docker → PGLite
```

To switch later:

```bash
gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --json   # PGLite → Postgres: prints the plan, exits 3
gbrain migrate --to pglite                                        # Postgres → PGLite (rare; brains without write history)
```

The move to Postgres carries the brain's full history and runs after the user approves the plan (`--yes --expect <plan_hash>`). Walkthrough: [Move a PGLite brain to Postgres](guides/move-to-postgres.md).

If Postgres access ever breaks at runtime, `gbrain engine status --probe` diagnoses it and `gbrain db-repair` fixes it — see the "Engine detection and access repair" section of [`docs/ENGINES.md`](ENGINES.md).

For shared / large / multi-machine deployments (a team or company brain with multiple users hitting one server over HTTP MCP with OAuth scoping per user), follow the dedicated walkthrough: **[Tutorial: set up GBrain as your company brain](tutorials/company-brain.md)**.

Optional provider setup: API keys live in `~/.gbrain/config.json` (file plane) or env vars (`VOYAGE_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`). Set them only after choosing the capability and approving its text disclosure and cost. Vendor API keys (and `database_url`/`database_path`) are file-plane routed, so `gbrain config set <KEY> <value>` writes where the pipeline reads it:

```bash
export VOYAGE_API_KEY=pa-...          # default embedding (voyage-4) + reranker (rerank-3-lite) — one key
export OPENAI_API_KEY=sk-...          # alternative embeddings; also powers automatic fact extraction + chat models
export ANTHROPIC_API_KEY=sk-ant-...   # automatic fact extraction + chat models; also improves search via query expansion
```

For a brain initialized with `--no-embedding`, adding a key alone does not enable
embeddings. Follow the CLI's explicit activation path, for example
`gbrain init --force --embedding-model voyage:voyage-4`, after reviewing the
provider and dimension choice. Keyword retrieval needs none of these keys.

`gbrain config get <key>` redacts secrets and database passwords by default, because its output lands in transcripts and shell history; scripts that need the real value pass `--raw`.

Chat features (automatic fact extraction, enrichment, synthesis, query expansion) use the Anthropic key, else the OpenAI key; other chat providers need a `models.*` pin. With neither key they stay off, and memory comes from agent-authored `## Facts` fences and the `remember` verb.

The autopilot daemon reads keys and process env (`NODE_EXTRA_CA_CERTS`, proxy vars, custom base URLs) from `~/.gbrain/env`, a 0600 file that `gbrain autopilot --install` creates and bash sources at every daemon start (it honors `GBRAIN_HOME`; shell rc files never reach the daemon). A line there can fetch a key from your secret manager instead of storing it, for example `VOYAGE_API_KEY="$(op read ...)"` (#5196). Re-run `gbrain autopilot --install` after editing it.

To change an existing brain's embedding provider, follow the explicit-consent playbook at [`skills/migrations/v0.46.3.0.md`](../skills/migrations/v0.46.3.0.md), with the full reference in [`docs/guides/embedding-migration.md`](guides/embedding-migration.md). Preview the work and cost before approving a migration; do not repoint existing vectors at a different model.

Common follow-ups:

```bash
gbrain import ~/my-knowledge      # bulk-import a markdown folder
gbrain sync --watch               # live-sync a git repo (autopilot mode)
gbrain autopilot --install        # background daemon for nightly enrichment
```

**Wire this same local brain into your coding agent** — zero server, zero token:

```bash
claude mcp add gbrain -- "$(command -v gbrain)" serve --surface starter --advertise verbs  # Claude Code
codex  mcp add gbrain -- "$(command -v gbrain)" serve --surface starter --advertise verbs  # Codex
```

The agent spawns `gbrain serve` as a stdio subprocess against your local brain. `--surface starter --advertise verbs` is what every registration gbrain writes: the daily-driver set (40 ops) stays callable, and the tool list shows the seven memory verbs ([MEMORY_VERBS v1](protocol/MEMORY_VERBS_v1.md)) plus `request_tools`, which lists the other tools, returns any tool's full schema and reaches a left-out one. Drop `--advertise verbs` to list the whole starter set, or register `--surface full` (every operation) or `--surface verbs` (only the seven verbs, nothing else callable). Full walkthrough (both this local path and connecting to a remote brain), plus the brain-first protocol to paste into `CLAUDE.md` / `AGENTS.md`: **[Give your coding agent a memory](tutorials/connect-coding-agent.md)**.

## 3. MCP server (any MCP client)

```bash
gbrain serve --surface starter    # stdio MCP (Claude Desktop / Code / Cursor); full = every operation
gbrain serve --http               # HTTP MCP with OAuth 2.1 + admin dashboard
gbrain mcp expose                 # publish serve --http on your Tailscale tailnet (HTTPS + user service)
```

To reach the brain on this computer from your other devices, desktop apps or
cloud agents, `gbrain mcp expose` publishes the HTTP server on your Tailscale
tailnet and keeps it running as a user service (`--funnel` is the explicit
opt-in for agents that run in a vendor's cloud). Guide:
[use your brain from anywhere over MCP](guides/remote-mcp.md).
**Say to your agent:** *"use my brain over mcp"* — *"put my brain on tailscale"*.

**Wire a coding agent to a remote brain in one command** (when you have an HTTP
server + a bearer token): `gbrain connect` prints a paste-ready setup block, or
`--install` runs it and smoke-tests the token.

```bash
gbrain auth create "claude-code"
gbrain connect https://your-host/mcp --token gbrain_xxx                      # Claude Code (default)
gbrain connect https://your-host/mcp --token gbrain_xxx --agent codex        # Codex (env-var bearer)
gbrain connect https://your-host/mcp --agent perplexity --oauth --register   # Perplexity (OAuth)
```

Per-client setup guides live in [`docs/mcp/`](mcp/):

- [`docs/mcp/CLAUDE_CODE.md`](mcp/CLAUDE_CODE.md)
- [`docs/mcp/CODEX.md`](mcp/CODEX.md)
- [`docs/mcp/CLAUDE_DESKTOP.md`](mcp/CLAUDE_DESKTOP.md)
- [`docs/mcp/CHATGPT.md`](mcp/CHATGPT.md)
- [`docs/mcp/PERPLEXITY.md`](mcp/PERPLEXITY.md)
- [`docs/mcp/HERMES.md`](mcp/HERMES.md) — Hermes (Nous Research CLI)
- [`docs/mcp/GROK.md`](mcp/GROK.md) — Grok Build (xAI CLI)
- [`docs/mcp/OPENCODE.md`](mcp/OPENCODE.md) — opencode (opencode.ai / SST terminal agent)
- [`docs/mcp/OPENCLAW.md`](mcp/OPENCLAW.md) — OpenClaw (bundle plugin or stdio)
- [`docs/mcp/CLAUDE_COWORK.md`](mcp/CLAUDE_COWORK.md) — Claude Cowork (team plan)
- [`docs/mcp/DEPLOY.md`](mcp/DEPLOY.md) — production deploy patterns

The HTTP server ships with an admin SPA at `/admin`, an SSE activity feed at `/admin/events`, DCR-style client registration, scope-gated `read`/`write`/`admin` access, and rate limiting.

## Thin-client mode

Connect to someone else's brain without running a local engine:

```bash
gbrain init --mcp-only            # configures remote MCP, skips local DB
# requires: --issuer-url --mcp-url --oauth-client-id --oauth-client-secret
# (or GBRAIN_REMOTE_ISSUER_URL / GBRAIN_REMOTE_MCP_URL / ... env vars)
```

Useful for: team mounts, brain-as-a-service deployments, dev machines without disk space. Most local commands refuse with a paste-ready hint. See [`docs/architecture/topologies.md`](architecture/topologies.md).

## Verifying the install

```bash
gbrain bootstrap verify           # the whole install contract; exits non-zero on failure
gbrain doctor --json              # full health check
gbrain models                     # which AI models are configured for what
gbrain models doctor              # 1-token probe per configured model
```

If anything's yellow, `gbrain doctor` names the fix command in the message. Most issues are missing API keys or stale schema (`gbrain upgrade --force-schema`). For the manual check-by-check runbook, see [docs/GBRAIN_VERIFY.md](GBRAIN_VERIFY.md).

## Troubleshooting

### PGLite crashes at startup (`RuntimeError: Aborted()`)

This crash (typically first seen after a macOS upgrade) is **not** a
macOS/WASM incompatibility — an unclean shutdown tore the data dir's
write-ahead log, and every subsequent open fails WAL replay. The short
version of the recovery ladder:

1. **Auto-repair (default):** run any gbrain command — gbrain detects the
   abort, resets the WAL in place (data preserved, backup kept), and
   continues. Then run `gbrain doctor`.
2. **Manual repair:** `gbrain pglite-repair --dry-run`, then
   `gbrain pglite-repair --yes`.
3. **Rebuild:** `gbrain reinit-pglite`.
4. **Switch engines:** Supabase or native Homebrew Postgres + pgvector.

The full ladder — safety bounds, kill-switches, when WAL repair can't help,
and the Homebrew Postgres recipe — lives in
[docs/ENGINES.md](ENGINES.md#troubleshooting-startup-abort-runtimeerror-aborted).
