# Local / Offline MBrain

This guide is for people who want to install and use MBrain **without Supabase, OpenAI, Anthropic, or any other required cloud service**.

In this profile:

- your markdown repo stays on disk as the source of truth
- MBrain stores its index in a local SQLite file
- `mbrain serve` exposes the same MCP tools over local stdio
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
- cloud file/storage workflows (`mbrain files ...`)

This guide only covers the **local/offline SQLite** path.

---

## 2. What `mbrain init --local` creates

Running `mbrain init --local` writes a config to `~/.mbrain/config.json` and boots the SQLite schema.

Typical result:

```json
{
  "engine": "sqlite",
  "database_path": "/Users/alice/.mbrain/brain.db",
  "offline": true,
  "embedding_provider": "local",
  "embedding_model": "nomic-embed-text",
  "query_rewrite_provider": "heuristic"
}
```

Important detail:

- the saved `database_path` is an **expanded absolute path**
- MBrain does **not** persist a literal `~/.mbrain/brain.db` string

---

## 3. Quick start: install and query your first local brain

If you want the shortest path, copy these commands as-is:

```bash
# 1) Install Bun if you do not already have it
curl -fsSL https://bun.com/install | bash

# 2) Reload your shell so `bun` is on PATH
exec /bin/zsh

# 3) Install mbrain globally
bun add -g github:meghendra6/mbrain

# 4) Create a local/offline SQLite brain
mbrain init --local

# 5) Import a markdown repo
mbrain import ~/git/brain

# 6) Prove search works immediately
mbrain query "some phrase that should exist in my notes"

# 7) Start the local MCP server
mbrain serve
```

At this point:

- your notes are indexed locally
- keyword search is available
- Codex / Claude Code can attach through `mbrain serve`

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

### Step 2: Install MBrain

```bash
bun add -g github:meghendra6/mbrain
mbrain --version
```

Expected result: `mbrain` prints a version string.

If you are working from a local source checkout, build and install the
standalone binary instead of relying on a source symlink:

```bash
bun install
bun run build
mkdir -p "$HOME/.local/bin"
install -m 755 bin/mbrain "$HOME/.local/bin/mbrain"
command -v mbrain
mbrain --version
```

`bun link` points the global command back to `src/cli.ts`, which means the
checkout must have its dependencies installed. The compiled binary is the stable
local checkout install path. If `command -v mbrain` does not resolve to
`$HOME/.local/bin/mbrain`, add `$HOME/.local/bin` to your shell `PATH` before
continuing.

### Step 3: Initialize a local brain

Default path:

```bash
mbrain init --local
```

Custom SQLite path:

```bash
mbrain init --local --path ~/brains/personal-brain.db
```

Expected result:

- MBrain creates the SQLite file
- MBrain writes `~/.mbrain/config.json`
- MBrain prints the resolved SQLite path

### Step 4: Import your markdown repo

```bash
mbrain import /path/to/your/brain
```

Examples:

```bash
mbrain import ~/git/brain
mbrain import ~/Documents/obsidian-vault
```

Expected result:

- pages and chunks are written to SQLite
- keyword search is usable immediately
- embeddings remain deferred until you run `mbrain embed`

### Step 5: Query the local brain

```bash
mbrain query "what do we know about competitive dynamics?"
mbrain search "Pedro"
mbrain stats
mbrain health
```

Expected result:

- `query` and `search` return local results
- `stats` shows page/chunk counts
- `health` reports embedding coverage honestly

---

## 5. Local embeddings are optional

By default, local/offline mode is **text-first and embed-later**:

- `mbrain import` does **not** block on embeddings
- `mbrain sync` does **not** block on embeddings
- `mbrain embed` is the explicit backfill path

That means you can start with keyword search immediately, then turn on semantic backfill later.

Markdown remains the durable source of truth. After `mbrain import <repo>` or
`mbrain sync --repo <repo>`, MBrain remembers that markdown repo path. Future
`put_page` writes from the CLI or MCP server write the corresponding
`<slug>.md` file first, then re-import that file into SQLite. If the markdown
file changed independently after the last import, `put_page` rejects the write
with a conflict instead of overwriting the user's file.

### Option A: run without embeddings at first

Do nothing extra.

You still get:

- page CRUD
- keyword search
- links / graph / timeline / stats
- MCP access through `mbrain serve`

### Option B: configure a local embedding runtime later

MBrain resolves the embedding runtime in this order:

1. `MBRAIN_LOCAL_EMBEDDING_URL`
2. `OLLAMA_HOST` (uses `/api/embed`)
3. default Ollama endpoint `http://127.0.0.1:11434/api/embed`

If Ollama is already running on the default host/port and you are using the default model, no extra runtime URL configuration is required:

```bash
mbrain embed --stale
```

The default model is `nomic-embed-text`. MBrain applies the retrieval prefixes
internally, so document chunks use `search_document:` and search queries use
`search_query:` automatically.

If you need a custom host/port or a non-default model, override only those pieces:

```bash
export OLLAMA_HOST=http://127.0.0.1:11434
export MBRAIN_LOCAL_EMBEDDING_MODEL=nomic-embed-text
mbrain embed --stale
```

Optional tuning:

```bash
export MBRAIN_LOCAL_EMBEDDING_DIMENSIONS=768
```

Use these commands:

```bash
mbrain embed --stale         # only missing chunks
mbrain embed --all           # rebuild every chunk
mbrain embed notes/offline-demo
```

What to expect:

- `--stale` only embeds missing chunks
- page-level `mbrain embed <slug>` can rebuild that page explicitly
- if Ollama is not running on the default endpoint, use `OLLAMA_HOST` or `MBRAIN_LOCAL_EMBEDDING_URL`
- if the runtime is reachable but the model is missing, Ollama returns that error directly

---

## 6. Inspect the execution envelope

Use doctor to confirm which public contract surfaces are supported in your current profile:

```bash
mbrain doctor --json
```

Look for:

- `execution_envelope`
- `contract_surface`

If `files` or `check-update` are unsupported, the doctor output should explain why.

---

## 7. Local query rewrite is optional too

Local/offline defaults to:

```json
"query_rewrite_provider": "heuristic"
```

That means:

- search still works with no LLM runtime
- MBrain uses cheap deterministic rewrites only

If you want local LLM rewrite instead, switch config to:

```json
"query_rewrite_provider": "local_llm"
```

Then configure one of:

- `MBRAIN_LOCAL_LLM_URL`
- `OLLAMA_HOST` (uses `/api/generate`)

Optional model override:

```bash
export MBRAIN_LOCAL_LLM_MODEL=qwen2.5:3b
```

If the runtime is missing, returns malformed output, or responds with an error, MBrain falls back to the original query.

---

## 8. Connect Codex to the local MCP server

Initialize the brain first:

```bash
mbrain init --local
```

Then add the MCP server:

```bash
codex mcp add mbrain -- mbrain serve
```

What this does:

- Codex spawns `mbrain serve`
- `mbrain serve` reads `~/.mbrain/config.json`
- all MCP calls hit your local SQLite brain

Recommended sanity check after adding it:

- start a fresh Codex session
- ask it to list MBrain tools or query a page you know exists

If you use a non-default config directory, prefer a small wrapper script:

```bash
#!/bin/zsh
export MBRAIN_CONFIG_DIR="$HOME/.mbrain-alt"
exec mbrain serve
```

Then point Codex at that wrapper instead of assuming custom env support in every client.

---

## 9. Connect Claude Code to the local MCP server

The shortest path mirrors the Codex setup:

```bash
claude mcp add -s user mbrain -- mbrain serve
```

What this does:

- Claude Code spawns `mbrain serve` on demand
- `mbrain serve` reads `~/.mbrain/config.json`
- all MCP calls hit your local SQLite brain

The `-s user` flag makes the MCP server available to Claude Code user-wide. If
you intentionally want a project-local registration, use:

```bash
claude mcp add -s local mbrain -- mbrain serve
```

Recommended workflow:

1. run `mbrain init --local`
2. run `mbrain import /path/to/brain`
3. run `claude mcp add -s user mbrain -- mbrain serve`
4. start a new Claude Code session
5. ask Claude Code to call a simple MBrain tool

Alternatively, you can add the server manually via JSON config. In `~/.claude.json` or a project `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "mbrain": {
      "command": "mbrain",
      "args": ["serve"]
    }
  }
}
```

If you need a non-default config directory, use the same wrapper-script pattern described in the Codex section.

---

## 10. One-command agent setup: `mbrain setup-agent`

Instead of manually registering MCP and copying behavioral rules, run:

```bash
mbrain setup-agent
```

This single command:

1. **Detects** which AI clients are installed (`~/.claude/` and/or `~/.codex/`)
2. **Registers** the MCP server with each detected client (if not already registered)
3. **Injects** the MBrain agent rules into each client's global config
4. **Installs** the Claude Code Stop hook that prompts for end-of-session mbrain writeback

The agent rules teach your AI client the brain-agent loop: read brain when MBrain is relevant, write back durable new information with provenance, and back-link durable entity mentions. They also tell the agent to skip MBrain for purely code editing, git operations, file management, public library docs, or general programming when no durable knowledge was learned.

### Options

```bash
mbrain setup-agent              # auto-detect and set up all installed clients
mbrain setup-agent --claude     # Claude Code only
mbrain setup-agent --codex      # Codex only
mbrain setup-agent --claude --scope local  # Claude project-local MCP registration
mbrain setup-agent --skip-mcp   # inject rules only, skip MCP registration
mbrain setup-agent --print      # print the rules to stdout instead of writing files
mbrain setup-agent --json       # machine-readable output
```

### What gets written

| Client | MCP registration | Rules injected into |
|--------|-----------------|---------------------|
| Claude Code | `claude mcp add -s user mbrain -- mbrain serve` | `~/.claude/CLAUDE.md` |
| Codex | `codex mcp add mbrain -- mbrain serve` | `~/.codex/AGENTS.md` |

Claude Code registration defaults to user scope. Pass
`mbrain setup-agent --claude --scope local` when you want MBrain registered only
for the current Claude Code project.

Rules are wrapped in `<!-- MBRAIN:RULES:START -->` / `<!-- MBRAIN:RULES:END -->` markers so existing content is never touched. Running `setup-agent` again updates the mbrain section in place.

For Claude Code, `setup-agent` also installs:

- `~/.claude/scripts/hooks/stop-mbrain-check.sh`
- `~/.claude/scripts/hooks/lib/mbrain-relevance.sh`
- `~/.claude/mbrain-skip-dirs`
- `~/.claude/settings.json` Stop hook entry `stop:mbrain-check`

The Stop hook runs once at session end, blocks once for eligible sessions, and asks Claude Code to either write durable session knowledge back to mbrain or respond with `MBRAIN-PASS: <reason>`.

When the Stop hook blocks a response, Claude Code may display the message under a `Stop hook error` prefix. In this case, the MBrain hook is not crashing; it is asking the agent to do one final memory check. The agent should not write just because the hook fired: it should write durable session knowledge to MBrain and sync only when there is something worth saving, otherwise respond exactly `MBRAIN-PASS: <short reason>`.

To disable the reminder for one Claude session:

```bash
MBRAIN_STOP_HOOK=0 claude
```

To disable it for specific working directories, add absolute paths to `~/.claude/mbrain-skip-dirs`.

### After setup

Start a new session in your AI client and verify:

- ask it to list MBrain tools (should see `search`, `query`, `get_page`, etc.)
- ask it about someone or something in your brain
- confirm it checks the brain before answering

---

## 11. Using Codex and Claude Code simultaneously

Both clients can connect to the same local brain at the same time. Each spawns its own `mbrain serve` process, and both read from the same SQLite database at `~/.mbrain/brain.db`. SQLite WAL mode makes concurrent reads safe.

The quickest way to set up both:

```bash
mbrain init --local
mbrain import ~/git/brain
mbrain setup-agent               # registers MCP + injects rules for both clients
```

Or manually:

```bash
codex mcp add mbrain -- mbrain serve
claude mcp add -s user mbrain -- mbrain serve
```

After this:

- Codex sessions have full access to your local brain
- Claude Code sessions have full access to your local brain
- reads are safe to share concurrently
- writes from one session are visible to the other immediately

Both clients auto-spawn the server when they need it.

---

## 12. Suggested first-day workflow

A practical local/offline routine looks like this:

```bash
# one-time bootstrap
mbrain init --local

# first load
mbrain import ~/git/brain

# normal querying
mbrain query "what changed with the series A?"
mbrain search "Pedro"

# keep the index current as files change
mbrain sync --repo ~/git/brain

# agent/MCP page writes now write back into ~/git/brain before indexing
mbrain put concepts/example < page.md

# optional semantic backfill later
mbrain embed --stale
```

If you use an MCP client daily:

```bash
mbrain serve
```

Or let Codex / Claude Code spawn it for you.

---

## 13. Verification checklist

Run these in order:

```bash
mbrain init --local
mbrain import /path/to/brain
mbrain query "phrase I know exists"
mbrain doctor --json
mbrain stats
mbrain health
```

`doctor --json` should show the `local_offline` execution envelope. Managed/Postgres-only surfaces such as cloud file storage may appear as unsupported capabilities; pgvector and RLS checks are not applicable in SQLite mode and should not make the local profile look unhealthy.

Then verify MCP:

1. connect Codex or Claude Code to `mbrain serve`
2. confirm tool listing succeeds
3. confirm one simple call succeeds, for example:
   - `search`
   - `query`
   - `get_page`

For an installed-command smoke check that exercises the stdio MCP server without
running the full lifecycle E2E test:

```bash
MBRAIN_SMOKE_COMMAND=mbrain bun run smoke:installed-mcp
```

If you configured embeddings:

```bash
mbrain embed --stale
mbrain health
```

You should see embedding coverage increase.

---

## 14. What is not supported in local/offline mode yet

These workflows are still managed/Postgres-oriented:

- remote MCP deployment over HTTP
- cloud file/storage migration workflows (`mbrain files ...`)
- Supabase admin / deployment helpers

In local/offline mode, these commands are expected to fail with honest guidance.

That is intentional. The current local profile is designed to be truthful, not to silently attempt cloud behavior.

---

## 15. Troubleshooting

### `mbrain init --local` succeeded, but query returns nothing

You probably have not imported anything yet.

Run:

```bash
mbrain import /path/to/brain
mbrain stats
```

### `mbrain embed --stale` fails while trying to reach Ollama

By default, MBrain tries `http://127.0.0.1:11434/api/embed`.

If your local runtime is on a different host or port, set one of:

- `MBRAIN_LOCAL_EMBEDDING_URL`
- `OLLAMA_HOST`

Then rerun:

```bash
mbrain embed --stale
```

### `mbrain serve` works in the terminal but not from my MCP client

Most often this means the client is using a different environment/config location than your shell.

Use:

- the default `~/.mbrain/config.json`, or
- a wrapper script that exports the needed env vars before `exec mbrain serve`

### `mbrain files ...` fails in local mode

That is expected today.

Local/offline SQLite mode does not support the cloud file/storage workflow yet.

---

## 16. If you want the same guide in Korean

See:

- [docs/local-offline.ko.md](local-offline.ko.md)
