# Connect GBrain to Prime Agent

Prime Agent is a personal agent harness (Python REPL control loop with
spawnable sub-agents) that connects to remote MCP servers declared in its
`~/.prime/agent/settings.json` under `mcpServers` — plain JSON with an HTTP
transport and a Bearer header. GBrain's `gbrain serve --http` speaks exactly
that shape, so Prime connects over the standard remote path with either a
legacy bearer token or an OAuth 2.1 client-credentials token.

This page covers only the Prime-specific parts. Server setup (starting
`gbrain serve --http`, tunnels, `--public-url`) lives in
[DEPLOY.md](DEPLOY.md). Profile/permission guidance lives in
[hosted-harness-access.md](../guides/hosted-harness-access.md).

## Setup

### 1. Provision access on the brain host

Use the standard grant lane; the harness identifier is `prime-agent`:

```bash
gbrain mcp grant prime --harness prime-agent --profile memory-writer \
  --source default --url https://brain.example.com/mcp \
  --credentials-out /absolute/private/prime.json --json
```

Profiles work like every other manual-HTTP adapter. For a multi-agent Prime
setup where sub-agent workers should inherit fenced delegation, use
`delegating-agent` and pass `--bound-tools`/`--delegated-slug-prefixes`
explicitly.

### 2. Install the connection inside Prime Agent

Prime has no CLI and no connector wizard: the `mcpServers` block lives in
`~/.prime/agent/settings.json`, and it is also written by the Prime app
itself — treat it as a shared file, keep a backup, and merge by hand:

```json
{
  "mcpServers": {
    "gbrain": {
      "type": "http",
      "url": "https://brain.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Keep unrelated keys (`defaultProvider`, `agentTraces`, …) untouched. Restart
the Prime session afterward; connections are read at session start.

### 3. Verify

`gbrain mcp verify --client <client-id> --harness prime-agent --url <url>
--credentials-file <file>` proves transport, auth, scopes, and a write/readback
round trip from the brain side. Server checks are not harness evidence: the
actual evidence is a `remember` → new session → `recall` round trip inside a
real Prime conversation (see [harness-access step 3](../guides/hosted-harness-access.md#3-prove-a-memory-round-trip)).

## Prime-specific notes

- **No hooks, no always-loaded config file.** Prime has no per-turn hook
  surface (no Stop/SessionStart/pre-LLM hooks) and no user-scope instruction
  file the way Claude Code (`CLAUDE.md`) or Codex (`AGENTS.md`) have. The
  ambient-memory surfaces therefore differ from other harnesses:
  - **Write side:** run with `memory.auto_writeback` enabled and the writeback
    contract arrives through the MCP `instructions` handshake on every request
    (HTTP transports resolve it per request). Capture is agent-executed —
    contract plus agent discipline, not machinery.
  - **Backstop:** none wired. A periodic agent-owned timer (or heartbeat)
    calling `delta` and saving salient session facts is the equivalent lane;
    expect whole-session latency between capture opportunities, like Codex.
  - **Ambient recall:** pull path only. Call `context_pack` at session start
    (after the harness's own compaction digest) and `delta(session_id)` on a
    periodic timer; establish the `delta` cursor once per session id, then
    later calls return only newer changes.
- **Compaction is harness-managed.** Prime compacts sessions and re-injects a
  harness-digest. Pair that boundary with the same rehydration advice as other
  harnesses: after a digest, run `context_pack` + `delta` again instead of
  trusting the digest alone.
- **Session identity.** Prime sessions have stable ids; pass one as the
  `delta` `session_id` so the cursor survives across heartbeats. A new session
  id re-establishes the cursor (stateless, no registration needed).

## Observed configuration shape (2026-09-23, live install)

`settings.json` fragment as shipped by a working connection (token redacted):

```json
{
  "mcpServers": {
    "gbrain": {
      "type": "http",
      "url": "https://tower.example.org:8444/mcp",
      "headers": { "Authorization": "Bearer gbrain_…" }
    }
  }
}
```

Observed against a real Prime Agent install running against a hosted
Postgres brain over HTTP; the full catalog (~50 ops), the brain-resident
skill protocol (`list_skills`/`get_skill`), and the seven memory verbs all
verified live in an actual session. Observations contradicting this file
win — update both together, as with the CLI pin docs.
