# Install

**Recommended door: the agent bootstrap.** Open your agent (Codex, Claude Code,
or any harness) in the folder that will become its home and paste the block
from the [README's install section](../README.md) — the agent fetches
`BOOTSTRAP_FOR_AGENTS.md` from the `latest-stable` tag, installs the CLI,
initializes a local PGLite brain, wires MCP, and isn't done until
`gbrain bootstrap verify` exits 0. Full contract, security posture, and
uninstall: [docs/guides/bootstrap.md](guides/bootstrap.md).

The paths below are the manual equivalents and deep-dive detail. Pick one.
Mix later if needed.

## 1. Run with an agent platform

Already running [OpenClaw](https://github.com/garrytan/openclaw) or [Hermes](https://github.com/garrytan/hermes)?

```bash
bun install -g github:garrytan/gbrain#latest-stable
gbrain init --pglite                  # 2 seconds; no server
gbrain skillpack scaffold --all       # scaffolds every bundled skill (skills/manifest.json) into your agent workspace
gbrain doctor                         # green checks all the way down
```

Your agent now reads `skills/RESOLVER.md` once per request, routes intent to the right skill, executes. New entity mentions create new pages. Daily cron runs enrichment overnight.

Scaffolded skills are first-class files in your agent repo — edit freely. To pull upstream gbrain improvements later, `gbrain skillpack reference <name>` diffs your local copy vs the bundle. The legacy `skillpack install` managed-block model was retired in v0.36.0.0; if you're upgrading from an older release, run `gbrain skillpack migrate-fence` once to strip the legacy fence and keep your existing skill rows.

To upgrade later: `gbrain upgrade` runs schema migrations + post-upgrade prompts (chunker bumps, provider-sunset notices). Always TTY-only; non-TTY upgrades skip prompts with informational stderr lines.

## 2. CLI standalone

No agent platform, just shell + MCP-aware editor.

```bash
bun install -g github:garrytan/gbrain#latest-stable
gbrain init --pglite
```

> **If `bun install -g` hits a postinstall error** (Bun blocks postinstall hooks in some environments), the CLI prints a recovery hint pointing at [#218](https://github.com/garrytan/gbrain/issues/218). Run `gbrain doctor` to diagnose, then `gbrain apply-migrations --yes` manually. The deterministic fallback is `git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain && bun install && bun link`.

The init flow detects your repo size and suggests Supabase for brains > 1000 markdown files. To switch later:

```bash
gbrain migrate --to supabase     # PGLite → Postgres
gbrain migrate --to pglite       # Postgres → PGLite (rare)
```

For shared / large / multi-machine deployments (a team or company brain with multiple users hitting one server over HTTP MCP with OAuth scoping per user), follow the dedicated walkthrough: **[Tutorial: set up GBrain as your company brain](tutorials/company-brain.md)**.

API keys live in `~/.gbrain/config.json` (file plane) or env vars (`VOYAGE_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`). Set them via env or by editing `~/.gbrain/config.json` directly — do NOT use `gbrain config set` for API keys (that writes the DB plane, which the embedding pipeline never reads):

```bash
export VOYAGE_API_KEY=pa-...          # default embedding (voyage-4) + reranker (rerank-2.5) — one key
export OPENAI_API_KEY=sk-...          # alternative embeddings; also powers automatic fact extraction + chat models
export ANTHROPIC_API_KEY=sk-ant-...   # automatic fact extraction + chat models; also improves search via query expansion
```

Chat-shaped features (automatic fact extraction, enrichment, synthesis, query
expansion) route to whichever supported chat key is present (Anthropic or
OpenAI) — Anthropic when both are set, OpenAI when it is the only one; other
chat providers need an explicit `models.*` pin. With neither key, they stay off
calmly and memory comes from agent-authored `## Facts` fences and the
`remember` verb.

`ZEROENTROPY_API_KEY` is still honored but deprecated — the ZeroEntropy hosted API shuts down 2026-09-04. Off-ramp: the agent playbook at [`skills/migrations/v0.46.3.0.md`](../skills/migrations/v0.46.3.0.md) (one command migrates embeddings + reranker) with the full reference in [`docs/guides/embedding-migration.md`](guides/embedding-migration.md).

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
```

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
