# Deploying GBrain to Fly.io

A self-contained recipe for running gbrain as a remote MCP server reachable from
any AI client (Claude Desktop, Claude Code, Perplexity, etc.). One Fly machine
runs both the HTTP wrapper and the autopilot sync loop; Supabase Postgres holds
the brain.

## Architecture

```
AI client (Claude Desktop, etc.)
  → https://your-app.fly.dev/mcp           (Bearer auth)
      → http-wrapper.ts (Bun, port 8080)
          → operation handlers → Supabase Postgres (pgvector)
      ‖
      autopilot loop: git pull /notes → sync → extract → embed
```

Both processes share the same container; if either dies, Fly restarts the
machine.

## Files

| File | Purpose |
|------|---------|
| `http-wrapper.ts` | Streamable HTTP MCP server, bearer-token gated |
| `start.sh` | Container entrypoint: clone notes, run wrapper + autopilot |
| `Dockerfile` | Bun runtime + git + ssh client |
| `fly.toml` | Fly app config (lhr, shared-cpu-1x, 512mb, always-on) |
| `.dockerignore` | Keeps tests/docs/node_modules out of the image |

## Deploy from scratch

### 1. Supabase project

Create a project (Pro tier, region close to Fly — `eu-west-2` for `lhr`). Then:

```bash
# Get the Session pooler connection string from Supabase dashboard
# (Settings → Database → Connection string → Session pooler, port 6543)
export DATABASE_URL='postgresql://postgres.PROJECT:PWD@aws-1-eu-west-2.pooler.supabase.com:6543/postgres'

# Initialize the schema (creates tables, pgvector extension, indexes)
gbrain init --supabase --url "$DATABASE_URL"
```

If `CREATE EXTENSION vector` fails, run it manually in the Supabase SQL Editor
and re-run `gbrain init`.

### 2. GitHub notes repo

```bash
gh repo create my-notes --private --clone
cd my-notes
echo "# Notes" > README.md
git add README.md && git commit -m "init" && git push -u origin main
```

Generate a deploy key for Fly to clone with:

```bash
ssh-keygen -t ed25519 -C "fly-pareen-brain" -f ~/.ssh/gbrain_fly_deploy -N ""
gh repo deploy-key add ~/.ssh/gbrain_fly_deploy.pub --repo OWNER/my-notes -t "fly-pareen-brain"

# Encode for Fly secret
SSH_DEPLOY_KEY_B64=$(base64 -w0 ~/.ssh/gbrain_fly_deploy)
```

### 3. Fly app

```bash
brew install flyctl
fly auth login

cd deploy/
fly apps create pareen-brain --org personal

fly secrets set --app pareen-brain \
  DATABASE_URL="$DATABASE_URL" \
  OPENAI_API_KEY="sk-..." \
  ANTHROPIC_API_KEY="sk-ant-..." \
  NOTES_REPO="git@github.com:OWNER/my-notes.git" \
  SSH_DEPLOY_KEY_B64="$SSH_DEPLOY_KEY_B64"

fly deploy
```

### 4. Bearer token

Tokens live in the same Postgres as the brain. Generate one per AI client:

```bash
DATABASE_URL="$DATABASE_URL" bun run src/commands/auth.ts create "claude-desktop"
# Save the gbrain_… token — shown only once.
```

### 5. Verify

```bash
DATABASE_URL="$DATABASE_URL" bun run src/commands/auth.ts test \
  https://pareen-brain.fly.dev/mcp \
  --token "gbrain_…"
```

Expected: ✓ Initialize ✓ tools/list ✓ get_stats.

### 6. Connect Claude Desktop

Settings → Integrations → Add custom integration:

- Name: `pareen-brain`
- URL: `https://pareen-brain.fly.dev/mcp`
- OAuth: off; use bearer token
- Token: the `gbrain_…` from step 4

(Claude Desktop requires this through Settings, **not** via
`claude_desktop_config.json` — that file is stdio-only.)

## Operations

### Watch logs
```bash
fly logs --app pareen-brain
```

### Trigger an immediate sync
```bash
fly ssh console --app pareen-brain
cd /notes && git pull && bun run /app/src/cli.ts sync --repo /notes --no-pull
```

### Rotate a token
```bash
DATABASE_URL=… bun run src/commands/auth.ts revoke "claude-desktop"
DATABASE_URL=… bun run src/commands/auth.ts create  "claude-desktop"
```

### Restart
```bash
fly machine restart --app pareen-brain
```

## Costs

| Item | Approx cost |
|------|-------------|
| Fly shared-cpu-1x 512mb (always-on, lhr) | ~$3.20/mo |
| Supabase Pro | $25/mo |
| OpenAI embeddings (text-embedding-3-large) | ~$0.13 / 1M tokens — pennies for personal use |
| Total baseline | ~$28/mo |

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `missing_auth` 401 | Missing `Authorization: Bearer` header |
| `invalid_token` 403 | Token revoked or never created in this DB |
| 502 from Fly URL | Container crash. `fly logs` to see why; usually a missing secret |
| Notes never sync | `NOTES_REPO` unreachable — check the deploy key, run `fly ssh console` and try `git -C /notes pull` |
| `tools/list` returns 0 tools | Operations module failed to import. `fly logs` for stack trace |
| Healthz works, /mcp times out | Postgres pooler connection lost. Restart the machine; if persistent, check Supabase pooler status |

## Security notes

- All MCP callers run with `OperationContext.remote = true`, which tightens the
  `file_upload` sandbox to the container's working directory. Symlinks, `..`,
  and absolute paths outside cwd are rejected.
- Tokens are SHA-256 hashed at rest. The plaintext token is shown only at
  creation time.
- DNS rebinding protection is disabled (irrelevant for a server-to-server bearer
  flow). Don't expose this from a browser without adding origin validation.
- Rotate the bearer token if you ever paste it into chat or log it.
