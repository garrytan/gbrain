# Model-Agnostic Agent Runtime

GBrain is not a Claude Code plugin, a Codex plugin, or a wrapper around one model.
It is a portable knowledge runtime for any agent that can read instructions and call
trusted tools.

The model is replaceable. The brain is the durable layer.

## The contract

An agent only needs four capabilities to use GBrain:

1. **Read markdown instructions** — start at `AGENTS.md`, then use `skills/RESOLVER.md`
   to route work to the right skill file.
2. **Call tools** — either through MCP (`gbrain serve`) or through the CLI
   (`gbrain query`, `gbrain put`, `gbrain sync`, `gbrain jobs ...`).
3. **Respect the trust boundary** — local CLI callers are trusted; remote MCP callers
   are scoped and logged. Sensitive operations stay local-only.
4. **Persist work** — use the database, the markdown brain repo, and Minions jobs for
   state instead of hoping the chat transcript survives.

If an agent has those four things, it can run GBrain. Claude Code, Codex-style coding
agents, OpenClaw, Cursor, Windsurf, Continue, Aider, ChatGPT, Perplexity, and custom
internal agents are just different harnesses around the same runtime.

## Why this is model-agnostic

GBrain keeps the durable logic outside the LLM:

- **Knowledge storage:** Postgres/PGLite tables plus a markdown source repo.
- **Retrieval:** deterministic hybrid search, graph traversal, timelines, and ranking.
- **Workflows:** markdown skills that any model can read.
- **Execution:** CLI/MCP operations with typed inputs, not provider-specific chat magic.
- **Background work:** Minions jobs that survive restarts and do not burn reasoning tokens
  for deterministic tasks.

That means you can switch the reasoning model without moving the memory layer. Use Claude
for planning, GPT for summarization, Qwen/DeepSeek/Kimi for high-throughput work, or a
local model for private drafts. They all call the same brain.

## Local coding agents

Use stdio MCP when the client supports MCP:

```json
{
  "mcpServers": {
    "gbrain": { "command": "gbrain", "args": ["serve"] }
  }
}
```

This pattern works for MCP-capable coding environments. If the harness does not support
MCP yet, give it shell access and use the CLI:

```bash
gbrain query "what do we know about this repo?"
gbrain get projects/my-repo
gbrain sync --repo ~/my-brain && gbrain embed --stale
```

`AGENTS.md` is the canonical non-Claude protocol. `CLAUDE.md` is a compatibility overlay
for Claude Code, not the source of truth.

## Remote AI clients

For clients that run outside your machine, use HTTP MCP:

```bash
gbrain serve --http --port 3131 --public-url https://your-brain.example.com
```

Then register scoped OAuth clients from the admin dashboard. ChatGPT, Claude Desktop,
Perplexity, Cowork, and other OAuth-aware clients can connect without getting full local
filesystem access.

## OpenAI-compatible embeddings

Embedding providers are configurable too. The default remains OpenAI
`text-embedding-3-large` at 1536 dimensions, but any OpenAI-compatible endpoint can be
used with environment variables:

```bash
export GBRAIN_EMBEDDING_API_KEY=...
export GBRAIN_EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export GBRAIN_EMBEDDING_MODEL=text-embedding-v4
export GBRAIN_EMBEDDING_TARGET_DIMENSIONS=1024
```

`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_EMBEDDING_MODEL`, and
`OPENAI_EMBEDDING_DIMENSIONS` are also supported. Provider-specific quirks should live in
configuration, not in the agent prompt.

## Porting checklist for a new agent

1. Give the agent `AGENTS.md` and `llms.txt`.
2. Install `gbrain` with `git clone + bun install + bun link`.
3. Configure database and embedding env vars.
4. Expose tools through MCP if available; otherwise expose the CLI.
5. Teach the agent the brain-first rule: search/query before external APIs.
6. Schedule `gbrain sync`, `gbrain embed --stale`, and the dream cycle.
7. Run `gbrain doctor --json` and fix warnings before calling it production.

The pitch is simple: bring any model. Keep the same brain.
