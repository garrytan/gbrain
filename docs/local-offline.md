# Local / Offline GBrain

GBrain now has a fully local profile: SQLite on disk, stdio MCP on your machine, and no required cloud services. This is the fastest path to a private brain for Codex or Claude Code.

## What local/offline mode means

When you run `gbrain init --local`, GBrain writes a config like this to `~/.gbrain/config.json` (the stored `database_path` is an expanded absolute path, not a literal `~` string):

```json
{
  "engine": "sqlite",
  "database_path": "/Users/alice/.gbrain/brain.db",
  "offline": true,
  "embedding_provider": "local",
  "query_rewrite_provider": "heuristic"
}
```

That profile gives you:

- markdown repo remains the source of truth
- SQLite-backed local indexing and retrieval
- `gbrain serve` over stdio for MCP clients
- no required Supabase, OpenAI, Anthropic, or remote storage
- honest feature gating when a workflow is still Postgres/cloud-only

## Bootstrap a local brain

```bash
bun add -g github:garrytan/gbrain
gbrain init --local
gbrain import ~/git/brain
gbrain query "what do we know about competitive dynamics?"
```

Optional custom database path:

```bash
gbrain init --local --path ~/brains/personal-brain.db
```

After that, the default config lives in `~/.gbrain/config.json`, and both CLI commands and `gbrain serve` read the same SQLite profile.

## Local MCP setup

### Codex

Add GBrain as a local stdio MCP server:

```bash
codex mcp add gbrain -- gbrain serve
```

Codex will spawn `gbrain serve`, which reads your local SQLite config from `~/.gbrain/config.json`.

### Claude Code

Use the local stdio MCP JSON shape in your Claude Code config:

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

If you stick to the default config location (`~/.gbrain/config.json`), no extra environment wiring is required. If you need a non-standard config directory, prefer a tiny wrapper script that exports the env you need and then execs `gbrain serve`, rather than assuming every MCP client supports the same env configuration fields.

## Offline workflow guidance

A practical local/offline workflow looks like this:

1. `gbrain init --local` once
2. `gbrain import <dir>` for the first load
3. `gbrain sync --repo <dir>` as your markdown repo changes
4. `gbrain serve` (or Codex / Claude Code spawning it) for agent access
5. `gbrain embed --stale` when your local embedding runtime is available and you want semantic backfill

Important local-mode truths:

- **Keyword search is immediate.** You do not need embeddings to start querying.
- **Embeddings are optional and backfill-driven.** Import/sync keep working even if no local runtime is available yet.
- **Query rewriting defaults to heuristics.** If you want local model-based rewrite, set `query_rewrite_provider` to `local_llm` and point GBrain at a local runtime.
- **`check-update` is disabled in the offline profile.** It should not phone home unexpectedly.
- **File/storage operations are not supported in sqlite/local mode yet.** Commands under `gbrain files ...` and related MCP file tools return honest unsupported-capability guidance instead of pretending to work.

## Local embedding and query-rewrite caveats

Local semantic retrieval depends on a configured local runtime. GBrain does not bundle one.

### Embeddings

GBrain looks for one of these:

- `GBRAIN_LOCAL_EMBEDDING_URL`
- `OLLAMA_HOST` (uses `/api/embed`)

Optional tuning env vars:

- `GBRAIN_LOCAL_EMBEDDING_MODEL` (default: `nomic-embed-text`)
- `GBRAIN_LOCAL_EMBEDDING_DIMENSIONS`

If no local embedding runtime is configured, GBrain stays usable but semantic backfill is unavailable until you provide one.

### Query rewrite

Local LLM rewrite is optional. If you want it, configure either:

- `GBRAIN_LOCAL_LLM_URL`
- `OLLAMA_HOST` (uses `/api/generate`)

Default local rewrite model: `qwen2.5:3b`

If that runtime is missing or returns bad output, GBrain falls back to the original query instead of breaking search.

## What is still Postgres / cloud oriented

Use the managed Postgres path when you need:

- pgvector-backed hosted scale
- remote MCP deployment over HTTP
- storage/file migration workflows (`gbrain files ...`)
- Supabase admin / deployment helpers

Those workflows still exist; they are just not part of the local/offline contract yet.

## Suggested verification checklist

For a local install, verify these in order:

```bash
gbrain init --local
gbrain import /path/to/brain
gbrain query "some phrase that should exist"
gbrain embed --stale   # only after a local embedding runtime is configured
```

Then confirm your MCP client can connect to `gbrain serve` and list/call tools against the SQLite profile.
