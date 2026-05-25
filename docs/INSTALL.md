# Install

Three install paths. Pick one. Mix later if needed.

## 1. Run with an agent platform (recommended)

Already running [OpenClaw](https://github.com/garrytan/openclaw) or [Hermes](https://github.com/garrytan/hermes)?

```bash
bun install -g github:garrytan/gbrain
gbrain init --pglite                  # 2 seconds; no server
gbrain skillpack scaffold --all       # 43 skills scaffolded into your agent workspace
gbrain doctor                         # green checks all the way down
```

Your agent now reads `skills/RESOLVER.md` once per request, routes intent to the right skill, executes. New entity mentions create new pages. Daily cron runs enrichment overnight.

Scaffolded skills are first-class files in your agent repo — edit freely. To pull upstream gbrain improvements later, `gbrain skillpack reference <name>` diffs your local copy vs the bundle. The legacy `skillpack install` managed-block model was retired in v0.36.0.0; if you're upgrading from an older release, run `gbrain skillpack migrate-fence` once to strip the legacy fence and keep your existing skill rows.

To upgrade later: `gbrain upgrade` runs schema migrations + post-upgrade prompts (chunker bumps, the v0.36.2.0 ZeroEntropy switch). Always TTY-only; non-TTY upgrades skip prompts with informational stderr lines.

## 2. CLI standalone

No agent platform, just shell + MCP-aware editor.

```bash
bun install -g github:garrytan/gbrain
gbrain init --pglite
```

> **If `bun install -g` hits a postinstall error** (Bun blocks postinstall hooks in some environments), the CLI prints a recovery hint pointing at [#218](https://github.com/garrytan/gbrain/issues/218). Run `gbrain doctor` to diagnose, then `gbrain apply-migrations --yes` manually. The deterministic fallback is `git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain && bun install && bun link`.

The init flow detects your repo size and suggests Supabase for brains > 1000 markdown files. To switch later:

```bash
gbrain migrate --to supabase     # PGLite → Postgres
gbrain migrate --to pglite       # Postgres → PGLite (rare)
```

For shared / large / multi-machine deployments (a team or company brain with multiple users hitting one server over HTTP MCP with OAuth scoping per user), follow the dedicated walkthrough: **[Tutorial: set up GBrain as your company brain](tutorials/company-brain.md)**.

API keys live in `~/.gbrain/config.json` (file plane) or env vars (`OPENAI_API_KEY`, `ZEROENTROPY_API_KEY`, `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`). Set via CLI:

```bash
gbrain config set zeroentropy_api_key sk-...
gbrain config set anthropic_api_key sk-ant-...
```

Common follow-ups:

```bash
gbrain import ~/my-knowledge      # bulk-import a markdown folder
gbrain sync --watch               # live-sync a git repo (autopilot mode)
gbrain autopilot --install        # background daemon for nightly enrichment
```

## 3. MCP server (any MCP client)

```bash
gbrain serve                      # stdio MCP (Claude Desktop / Code / Cursor)
gbrain serve --http               # HTTP MCP with OAuth 2.1 + admin dashboard
```

Per-client setup guides live in [`docs/mcp/`](mcp/):

- [`docs/mcp/CLAUDE_CODE.md`](mcp/CLAUDE_CODE.md)
- [`docs/mcp/CLAUDE_DESKTOP.md`](mcp/CLAUDE_DESKTOP.md)
- [`docs/mcp/CHATGPT.md`](mcp/CHATGPT.md)
- [`docs/mcp/PERPLEXITY.md`](mcp/PERPLEXITY.md)
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
gbrain doctor --json              # full health check
gbrain models                     # which AI models are configured for what
gbrain models doctor              # 1-token probe per configured model
```

If anything's yellow, `gbrain doctor` names the fix command in the message. Most issues are missing API keys or stale schema (`gbrain upgrade --force-schema`).
