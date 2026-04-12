# Local / Offline GBrain

This guide is for people who want to install and use GBrain **without Supabase, OpenAI, Anthropic, or any other required cloud service**.

In this profile:

- your markdown repo stays on disk as the source of truth
- GBrain stores its index in a local SQLite file
- `gbrain serve` exposes the same MCP tools over local stdio
- keyword search works immediately
- embeddings and local LLM rewrite are optional follow-up steps

If you want the same instructions in Korean, use [docs/local-offline.ko.md](local-offline.ko.md).

---

## 1. Choose the right profile

Use the **local/offline** profile when you want:

- a private brain on one machine
- no required recurring cloud cost
- Codex / Claude Code access through a local MCP server
- SQLite instead of Postgres

Use the **managed Postgres** profile when you want:

- hosted pgvector scale
- remote MCP over HTTP
- cloud file/storage workflows (`gbrain files ...`)

This guide only covers the **local/offline SQLite** path.

---

## 2. What `gbrain init --local` creates

Running `gbrain init --local` writes a config to `~/.gbrain/config.json` and boots the SQLite schema.

Typical result:

```json
{
  "engine": "sqlite",
  "database_path": "/Users/alice/.gbrain/brain.db",
  "offline": true,
  "embedding_provider": "local",
  "query_rewrite_provider": "heuristic"
}
```

Important detail:

- the saved `database_path` is an **expanded absolute path**
- GBrain does **not** persist a literal `~/.gbrain/brain.db` string

---

## 3. Quick start: install and query your first local brain

If you want the shortest path, copy these commands as-is:

```bash
# 1) Install Bun if you do not already have it
curl -fsSL https://bun.com/install | bash

# 2) Reload your shell so `bun` is on PATH
exec /bin/zsh

# 3) Install gbrain globally
bun add -g github:meghendra6/gbrain

# 4) Create a local/offline SQLite brain
gbrain init --local

# 5) Import a markdown repo
gbrain import ~/git/brain

# 6) Prove search works immediately
gbrain query "some phrase that should exist in my notes"

# 7) Start the local MCP server
gbrain serve
```

At this point:

- your notes are indexed locally
- keyword search is available
- Codex / Claude Code can attach through `gbrain serve`

You do **not** need embeddings to start using the brain.

---

## 4. Detailed installation steps

### Step 1: Install Bun

If `bun --version` already works, skip this step.

```bash
curl -fsSL https://bun.com/install | bash
exec /bin/zsh
bun --version
```

Expected result: Bun prints a version string.

### Step 2: Install GBrain

```bash
bun add -g github:meghendra6/gbrain
gbrain --version
```

Expected result: `gbrain` prints a version string.

### Step 3: Initialize a local brain

Default path:

```bash
gbrain init --local
```

Custom SQLite path:

```bash
gbrain init --local --path ~/brains/personal-brain.db
```

Expected result:

- GBrain creates the SQLite file
- GBrain writes `~/.gbrain/config.json`
- GBrain prints the resolved SQLite path

### Step 4: Import your markdown repo

```bash
gbrain import /path/to/your/brain
```

Examples:

```bash
gbrain import ~/git/brain
gbrain import ~/Documents/obsidian-vault
```

Expected result:

- pages and chunks are written to SQLite
- keyword search is usable immediately
- embeddings remain deferred until you run `gbrain embed`

### Step 5: Query the local brain

```bash
gbrain query "what do we know about competitive dynamics?"
gbrain search "Pedro"
gbrain stats
gbrain health
```

Expected result:

- `query` and `search` return local results
- `stats` shows page/chunk counts
- `health` reports embedding coverage honestly

---

## 5. Local embeddings are optional

By default, local/offline mode is **write-first**:

- `gbrain import` does **not** block on embeddings
- `gbrain sync` does **not** block on embeddings
- `gbrain embed` is the explicit backfill path

That means you can start with keyword search immediately, then turn on semantic backfill later.

### Option A: run without embeddings at first

Do nothing extra.

You still get:

- page CRUD
- keyword search
- links / graph / timeline / stats
- MCP access through `gbrain serve`

### Option B: configure a local embedding runtime later

GBrain looks for one of:

- `GBRAIN_LOCAL_EMBEDDING_URL`
- `OLLAMA_HOST` (uses `/api/embed`)

Common example with Ollama-compatible runtime:

```bash
export OLLAMA_HOST=http://127.0.0.1:11434
export GBRAIN_LOCAL_EMBEDDING_MODEL=nomic-embed-text
gbrain embed --stale
```

Optional tuning:

```bash
export GBRAIN_LOCAL_EMBEDDING_DIMENSIONS=768
```

Use these commands:

```bash
gbrain embed --stale         # only missing chunks
gbrain embed --all           # rebuild every chunk
gbrain embed notes/offline-demo
```

What to expect:

- `--stale` only embeds missing chunks
- page-level `gbrain embed <slug>` can rebuild that page explicitly
- if no runtime is configured, GBrain tells you that honestly instead of pretending embeddings succeeded

---

## 6. Local query rewrite is optional too

Local/offline defaults to:

```json
"query_rewrite_provider": "heuristic"
```

That means:

- search still works with no LLM runtime
- GBrain uses cheap deterministic rewrites only

If you want local LLM rewrite instead, switch config to:

```json
"query_rewrite_provider": "local_llm"
```

Then configure one of:

- `GBRAIN_LOCAL_LLM_URL`
- `OLLAMA_HOST` (uses `/api/generate`)

Optional model override:

```bash
export GBRAIN_LOCAL_LLM_MODEL=qwen2.5:3b
```

If the runtime is missing, returns malformed output, or responds with an error, GBrain falls back to the original query.

---

## 7. Connect Codex to the local MCP server

Initialize the brain first:

```bash
gbrain init --local
```

Then add the MCP server:

```bash
codex mcp add gbrain -- gbrain serve
```

What this does:

- Codex spawns `gbrain serve`
- `gbrain serve` reads `~/.gbrain/config.json`
- all MCP calls hit your local SQLite brain

Recommended sanity check after adding it:

- start a fresh Codex session
- ask it to list GBrain tools or query a page you know exists

If you use a non-default config directory, prefer a small wrapper script:

```bash
#!/bin/zsh
export GBRAIN_CONFIG_DIR="$HOME/.gbrain-alt"
exec gbrain serve
```

Then point Codex at that wrapper instead of assuming custom env support in every client.

---

## 8. Connect Claude Code to the local MCP server

The shortest path mirrors the Codex setup:

```bash
claude mcp add gbrain -- gbrain serve
```

What this does:

- Claude Code spawns `gbrain serve` on demand
- `gbrain serve` reads `~/.gbrain/config.json`
- all MCP calls hit your local SQLite brain

Recommended workflow:

1. run `gbrain init --local`
2. run `gbrain import /path/to/brain`
3. run `claude mcp add gbrain -- gbrain serve`
4. start a new Claude Code session
5. ask Claude Code to call a simple GBrain tool

Alternatively, you can add the server manually via JSON config. In `~/.claude.json` or a project `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
```

If you need a non-default config directory, use the same wrapper-script pattern described in the Codex section.

---

## 9. Using Codex and Claude Code simultaneously

Both clients can connect to the same local brain at the same time. Each spawns its own `gbrain serve` process, and both read from the same SQLite database at `~/.gbrain/brain.db`. SQLite WAL mode makes concurrent reads safe.

To set up both in one go:

```bash
# initialize once
gbrain init --local
gbrain import ~/git/brain

# register with Codex
codex mcp add gbrain -- gbrain serve

# register with Claude Code
claude mcp add gbrain -- gbrain serve
```

After this:

- Codex sessions have full access to your local brain
- Claude Code sessions have full access to your local brain
- reads are safe to share concurrently
- writes from one session are visible to the other immediately

No further configuration is needed. Both clients auto-spawn the server when they need it.

---

## 10. Suggested first-day workflow

A practical local/offline routine looks like this:

```bash
# one-time bootstrap
gbrain init --local

# first load
gbrain import ~/git/brain

# normal querying
gbrain query "what changed with the series A?"
gbrain search "Pedro"

# keep the index current as files change
gbrain sync --repo ~/git/brain

# optional semantic backfill later
gbrain embed --stale
```

If you use an MCP client daily:

```bash
gbrain serve
```

Or let Codex / Claude Code spawn it for you.

---

## 11. Verification checklist

Run these in order:

```bash
gbrain init --local
gbrain import /path/to/brain
gbrain query "phrase I know exists"
gbrain stats
gbrain health
```

Then verify MCP:

1. connect Codex or Claude Code to `gbrain serve`
2. confirm tool listing succeeds
3. confirm one simple call succeeds, for example:
   - `search`
   - `query`
   - `get_page`

If you configured embeddings:

```bash
gbrain embed --stale
gbrain health
```

You should see embedding coverage increase.

---

## 12. What is not supported in local/offline mode yet

These workflows are still managed/Postgres-oriented:

- remote MCP deployment over HTTP
- cloud file/storage migration workflows (`gbrain files ...`)
- Supabase admin / deployment helpers

In local/offline mode, these commands are expected to fail with honest guidance.

That is intentional. The current local profile is designed to be truthful, not to silently attempt cloud behavior.

---

## 13. Troubleshooting

### `gbrain init --local` succeeded, but query returns nothing

You probably have not imported anything yet.

Run:

```bash
gbrain import /path/to/brain
gbrain stats
```

### `gbrain embed --stale` says no embedding provider is available

You have not configured a local embedding runtime yet.

Set one of:

- `GBRAIN_LOCAL_EMBEDDING_URL`
- `OLLAMA_HOST`

Then rerun:

```bash
gbrain embed --stale
```

### `gbrain serve` works in the terminal but not from my MCP client

Most often this means the client is using a different environment/config location than your shell.

Use:

- the default `~/.gbrain/config.json`, or
- a wrapper script that exports the needed env vars before `exec gbrain serve`

### `gbrain files ...` fails in local mode

That is expected today.

Local/offline SQLite mode does not support the cloud file/storage workflow yet.

---

## 14. If you want the same guide in Korean

See:

- [docs/local-offline.ko.md](local-offline.ko.md)
