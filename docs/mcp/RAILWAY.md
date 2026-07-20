# Deploy GBrain on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.app/new/template/TEMPLATE_ID)

> **Note:** The one-click template ID will be filled after the template is
> published on Railway. Until then, follow the manual steps below.

## What gets deployed

| Service | Description |
|---------|-------------|
| **GBrain** | HTTP MCP server (Bun runtime) with OAuth 2.1 + Dynamic Client Registration |
| **Postgres** | PostgreSQL 16 with pgvector for hybrid RAG search |

Railway wires the two together automatically via the `DATABASE_URL` reference
variable.

## Quick start (manual deploy)

1. **Fork the repo** — fork [garrytan/gbrain](https://github.com/garrytan/gbrain)
   to your GitHub account.
2. **Create a Railway project** — go to [railway.app/new](https://railway.app/new),
   select "Deploy from GitHub Repo", and pick your fork.
3. **Add Postgres with pgvector** — in the same project, click "+ New" →
   "Database" → "PostgreSQL". Railway provisions pgvector automatically.
4. **Wire the database** — in the GBrain service's Variables tab, add:
   ```
   DATABASE_URL = ${{Postgres.DATABASE_URL}}
   ```
5. **Set the remaining env vars** (see below).
6. **Deploy** — Railway builds from the Dockerfile and starts the server.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | Auto-wired from Railway Postgres: `${{Postgres.DATABASE_URL}}` |
| `PUBLIC_URL` | ✅ | Your Railway public domain, e.g. `https://gbrain-xxxx.up.railway.app`. **Critical** — the OAuth issuer derives from this. |
| `OPENAI_API_KEY` | ✅ | Required for vector search / embeddings |
| `ANTHROPIC_API_KEY` | ❌ | Optional — improves query expansion via Claude |
| `PORT` | — | Injected by Railway automatically (do not override) |

## Post-deploy setup

### 1. Run schema migrations (one-time)

GBrain's `postinstall` script handles initial setup, but you may need to run
migrations explicitly on first deploy. Open the Railway service shell
(**Settings → Shell**) or use `railway run`:

```bash
bun run src/cli.ts apply-migrations --yes --non-interactive
```

### 2. Bootstrap admin access

Visit `https://<your-railway-domain>/admin` in your browser. The admin panel
will display a bootstrap token on first load — use it to create your first
OAuth client and configure access tokens.

### 3. Verify

```bash
curl https://<your-railway-domain>/health
# → {"status":"ok"}
```

## Connecting Claude Desktop

1. Open Claude Desktop → **Settings** → **Integrations** → **Add**.
2. Enter your Railway URL with the `/mcp` path:
   ```
   https://gbrain-xxxx.up.railway.app/mcp
   ```
3. Claude Desktop will walk through the OAuth flow automatically.

## Connecting Claude Code

For a fully cloud-hosted setup, pair this with the companion
[Claude Code Railway template](https://github.com/curaition/claude-code-template)
— it gives you Claude Code running on Railway that connects to your GBrain
instance as a remote MCP server.

## Cost estimate

| Component | Monthly cost |
|-----------|-------------|
| Railway (GBrain + Postgres) | ~$5–10 |
| OpenAI embeddings | ~$0–5 (depends on volume) |
| **Total** | **~$5–15/mo** |

Railway's Hobby plan ($5/mo) includes enough compute for personal use. The
Postgres plugin is included in the plan. OpenAI embedding costs scale with
how much content you ingest — a personal knowledge base typically stays under
$5/mo.

## Architecture

```
┌─────────────┐       ┌────────────────────────┐
│ Claude       │──────▶│  GBrain MCP Server      │
│ Desktop/Code │  MCP  │  (Bun on Railway)       │
└─────────────┘       │  0.0.0.0:$PORT          │
                       │  OAuth 2.1 + DCR        │
                       └──────────┬─────────────┘
                                  │ DATABASE_URL
                       ┌──────────▼─────────────┐
                       │  PostgreSQL + pgvector   │
                       │  (Railway plugin)        │
                       └──────────────────────────┘
```

## Troubleshooting

- **OAuth errors / issuer mismatch** — make sure `PUBLIC_URL` exactly matches
  your Railway public domain (including `https://`, no trailing slash).
- **Health check failing** — check that `DATABASE_URL` is wired correctly and
  Postgres is running. The health endpoint requires a live DB connection.
- **Migrations not applied** — run `bun run src/cli.ts apply-migrations --yes --non-interactive`
  from the Railway shell.
- **Cold starts** — Railway keeps your service running 24/7 on the Hobby plan.
  No cold starts, no sleep timeouts.
