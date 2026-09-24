# Install

Start by choosing the setup you need:

- **Add memory to the agent you already use (recommended):** [Grok Bot](guides/grok-bot.md), [Muse](guides/muse.md), or [Codex / Claude Code](tutorials/connect-coding-agent.md). Keep the existing identity; start keyless, without a personal-agent repository.
- **Connect to your existing hosted brain:** [private handoff and harness access](guides/hosted-harness-access.md). Provision on the host, install in the client environment.


**Optional: create a new persistent personal agent.** If you want identity
files and a private repository, use the separate
[bootstrap guide](guides/bootstrap.md) in a supported harness. The recommended
memory-only setup above preserves your existing agent's identity and needs
neither a bootstrap interview nor a private repository.

The paths below are the manual equivalents and deep-dive detail. Pick one.
Mix later if needed.

Before enabling capabilities, read [memory boundaries](guides/memory-boundaries.md):
durable preferences can be shared, but harness configuration stays local;
remote writes need graph maintenance, cloud providers can receive text, and
Markdown export is not a full database backup.

## 1. Run with an agent platform

Already running [OpenClaw](https://github.com/garrytan/openclaw) or [Hermes](https://github.com/garrytan/hermes)?

```bash
bun install -g github:garrytan/gbrain#latest-stable
gbrain init --pglite --no-embedding   # keyless; no server
gbrain skillpack scaffold --all       # scaffolds every bundled skill (skills/manifest.json) into your agent workspace
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
For a clone linked with Bun, use `git pull --ff-only`, then
`GBRAIN_NO_AUTOPILOT_INSTALL=1 bun install`,
`gbrain apply-migrations --yes --no-autopilot-install`, and
`GBRAIN_NO_REEMBED=1 gbrain post-upgrade --no-autopilot-install`.
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
gbrain migrate --to supabase     # PGLite → Postgres
gbrain migrate --to pglite       # Postgres → PGLite (rare)
```

If Postgres access ever breaks at runtime, `gbrain engine status --probe` diagnoses it and `gbrain db-repair` fixes it — see the "Engine detection and access repair" section of [`docs/ENGINES.md`](ENGINES.md).

For shared / large / multi-machine deployments (a team or company brain with multiple users hitting one server over HTTP MCP with OAuth scoping per user), follow the dedicated walkthrough: **[Tutorial: set up GBrain as your company brain](tutorials/company-brain.md)**.

Optional provider setup: API keys live in `~/.gbrain/config.json` (file plane) or env vars (`VOYAGE_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`). Set them only after choosing the capability and approving its text disclosure and cost. Vendor API keys (and `database_url`/`database_path`) are file-plane routed, so `gbrain config set <KEY> <value>` writes where the pipeline reads it:

```bash
export VOYAGE_API_KEY=pa-...          # default embedding (voyage-4) + reranker (rerank-2.5) — one key
export OPENAI_API_KEY=sk-...          # alternative embeddings; also powers automatic fact extraction + chat models
export ANTHROPIC_API_KEY=sk-ant-...   # automatic fact extraction + chat models; also improves search via query expansion
```

For a brain initialized with `--no-embedding`, adding a key alone does not enable
embeddings. Follow the CLI's explicit activation path, for example
`gbrain init --force --embedding-model voyage:voyage-4`, after reviewing the
provider and dimension choice. Keyword retrieval needs none of these keys.

Reading a value back: `gbrain config get <key>` prints redacted by default — sensitive keys (any `key`/`secret`/`token`/`password`-segmented name) print `***`, and a `postgres://` / `postgresql://` value like `database_url` has its `user:password` userinfo replaced with `***` (host, port, database, and query string preserved) — because `get` output lands in agent transcripts and shell history. Scripts that need the real value pass `--raw` (accepted before or after the key). `config show` and the `Set <key> = ...` confirmation that `config set` prints redact the same way. `get` keeps stdout a bare value and reports which plane answered (file/env or DB) on stderr.

Chat-shaped features (automatic fact extraction, enrichment, synthesis, query
expansion) route to whichever supported chat key is present (Anthropic or
OpenAI) — Anthropic when both are set, OpenAI when it is the only one; other
chat providers need an explicit `models.*` pin. With neither key, they stay off
calmly and memory comes from agent-authored `## Facts` fences and the
`remember` verb.

For the autopilot daemon specifically, keys and process-level env (`NODE_EXTRA_CA_CERTS`, proxy vars, custom base URLs) belong in `~/.gbrain/env` — a 0600 file created by `gbrain autopilot --install` and sourced by the daemon wrapper (interactive shell rc files never reach daemon shells; the path honors `GBRAIN_HOME`). Re-run `gbrain autopilot --install` after editing it so the daemon reloads.

To change an existing brain's embedding provider, follow the explicit-consent playbook at [`skills/migrations/v0.46.3.0.md`](../skills/migrations/v0.46.3.0.md), with the full reference in [`docs/guides/embedding-migration.md`](guides/embedding-migration.md). Preview the work and cost before approving a migration; do not repoint existing vectors at a different model.

Common follow-ups:

```bash
gbrain import ~/my-knowledge      # bulk-import a markdown folder
gbrain sync --watch               # live-sync a git repo (autopilot mode)
gbrain autopilot --install        # background daemon for nightly enrichment
```

**Wire this same local brain into your coding agent** — zero server, zero token:

```bash
claude mcp add gbrain -- gbrain serve --surface verbs    # Claude Code
codex  mcp add gbrain -- gbrain serve --surface verbs    # Codex
```

The agent spawns `gbrain serve` as a stdio subprocess against your local brain. `--surface verbs` gives the agent the seven-verb memory protocol (`recall`, `remember`, `entity`, `synthesize`, `forget`, `context_pack`, `delta` — [MEMORY_VERBS v1](protocol/MEMORY_VERBS_v1.md)) instead of the full tool catalog; `--surface starter` adds the daily-driver set on top of the verbs (~27 ops total); drop the flag (default `full`) for every operation. Full walkthrough (both this local path and connecting to a remote brain), plus the brain-first protocol to paste into `CLAUDE.md` / `AGENTS.md`: **[Give your coding agent a memory](tutorials/connect-coding-agent.md)**.

## 3. MCP server (any MCP client)

```bash
gbrain serve                      # stdio MCP (Claude Desktop / Code / Cursor)
gbrain serve --surface verbs      # stdio MCP, just the 7 memory verbs (quickstart)
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
