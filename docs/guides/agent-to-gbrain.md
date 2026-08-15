# How a downstream agent should talk to gbrain

This guide is for authors of downstream agents (hermes, openclaw, future
forks) that need to call gbrain operations from their own runtime. Reading
this first will save you a debugging cycle: gbrain has **two distinct
surfaces**, and which one you pick depends on the operation.

## The two surfaces

```
                       ┌─────────────────────────────────────────────┐
                       │                gbrain process                │
                       │                                              │
   Agent (hermes,      │  ┌──────────────────┐    ┌────────────────┐ │
   openclaw, fork) ────┼──▶  MCP ops surface  │    │  local-only    │ │
                       │  │ (HTTP + OAuth)    │    │  commands      │ │
                       │  │                   │    │                │ │
                       │  │  search, query,   │    │  sync, embed,  │ │
                       │  │  put_page,        │    │  extract,      │ │
                       │  │  get_page,        │    │  dream,        │ │
                       │  │  find_experts,    │    │  enrich, ...   │ │
                       │  │  ...              │    │                │ │
                       │  └──────────────────┘    └────────────────┘ │
                       │           ▲                       ▲          │
                       │           │                       │          │
                       │           │                       │          │
                       │     thin-client OAuth      shell-job `inherit:`│
                       │     (preferred for          (only path for   │
                       │      MCP-equivalent ops)    local-only work) │
                       └─────────────────────────────────────────────┘
```

The two surfaces are **not interchangeable**. Pick by op, not by preference.

## Surface 1 — MCP ops over HTTP (thin-client + OAuth)

Use for any operation that has an MCP equivalent: `search`, `query`,
`put_page`, `get_page`, `find_experts`, `find_orphans`, `find_anomalies`,
`get_recent_salience`, `find_trajectory`, and so on. The canonical list is
the set of ops in `src/core/operations.ts` whose `localOnly` flag is unset
(or `false`).

### Setup

The host runs gbrain as a long-lived HTTP server:

```bash
gbrain serve --http --port 3131
```

The agent registers as an OAuth client (one-time):

```bash
gbrain auth register-client hermes \
  --grant-types client_credentials \
  --scopes read,write
# Prints client_id + client_secret one-time. Store securely.
```

The agent's runtime calls `/mcp` with a bearer token from `client_credentials`
grant. Secrets stay in the gbrain serve process; the agent never sees
DATABASE_URL or API keys.

Thin-client mode (`gbrain init --mcp-only`) gives the agent the same
client-credentials wiring, plus the `gbrain` CLI itself routes MCP-eligible
commands through the configured remote MCP. The agent can call
`gbrain search` / `gbrain query` directly and the CLI does the OAuth dance.

### Why this is preferred for MCP ops

- Secrets never leave the server process.
- OAuth scopes give you `read`, `write`, `admin` separation — agent only gets
  what it needs.
- Source-scoped tokens (`--source dept-x` on `register-client`) confine the
  agent to a specific source within a federated brain.
- One audit surface (`mcp_request_log`) covers every op call uniformly.

## Surface 2 — local-only work via shell-job `inherit:`

Two mechanisms keep local-only work off the remote surface, and they operate
at different layers:

- **Op layer:** operations flagged `localOnly: true` in
  `src/core/operations.ts` are filtered out of the HTTP MCP surface entirely
  — a remote caller never sees them.
- **CLI layer:** on a thin-client install (remote MCP configured, no local
  engine), commands that require a local engine or the local filesystem are
  refused at dispatch with a pinpoint hint naming the closest alternative.
  The authoritative set is `THIN_CLIENT_REFUSED_COMMANDS` in `src/cli.ts` —
  read it there rather than trusting any list copied into a doc; it covers
  `sync`, `embed`, `extract`, `dream`, `enrich`, `serve`, `config`, and a
  couple dozen more.

Notable non-members: `doctor` is NOT refused on a thin client — it reroutes
to an outbound-HTTP probe set (`src/core/doctor-remote.ts`); `bootstrap` and
`hook` are engine-free and work on any install shape.

For refused commands, the agent cannot route through HTTP MCP. The path is to run
`gbrain` as a CLI subprocess. The recommended pattern is to submit the
subprocess as a shell job to the gbrain Minions worker so retry / backoff /
DLQ / audit trail all come for free.

### Setup

```bash
gbrain jobs submit shell --params '{
  "cmd": "gbrain sync --skip-failed && gbrain embed --stale",
  "cwd": "/data/gbrain",
  "inherit": ["database_url"]
}'
```

The `inherit: ["database_url"]` field tells the worker to look up
`database_url` from its `loadConfig()` and inject the value into the child
env as `GBRAIN_DATABASE_URL`. The DB row in `minion_jobs.data` carries the
names only — `inherit: ["database_url"]` — never the value. See
[minions-shell-jobs.md#secrets](./minions-shell-jobs.md#secrets) for the
full validation rules and error catalog.

### Why this is preferred over writing secrets into `env:` per-job

- Passing `env: { GBRAIN_DATABASE_URL: "postgresql://..." }` per job would
  land the URL plaintext in `minion_jobs.data` and the shell-audit JSONL —
  visible to anyone with brain-DB read access (or a brain dump, or a shared
  brain via mounts). Pre-enqueue validation rejects it; the error message
  names `inherit: ["database_url"]` as the replacement.

### Worker setup (one-time, per host)

The agent's host needs a worker that processes shell jobs:

```bash
# One-shot inline execution (PGLite or Postgres):
gbrain jobs submit shell --params '{...}' --follow

# Persistent worker (Postgres only — PGLite uses --follow inline):
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs work
```

`GBRAIN_ALLOW_SHELL_JOBS=1` is the worker-side opt-in. Without it, shell jobs
sit in `waiting` indefinitely. Set it on the worker process env (or in your
deploy unit / launchd plist), not per-submission — submitter env is a weak
proxy for worker env.

## Decision table

| Operation | Surface | Why |
|---|---|---|
| `search` / `query` | HTTP MCP via thin-client | Has MCP op; OAuth-scoped. |
| `get_page` / `list_pages` | HTTP MCP | Same. |
| `put_page` | HTTP MCP | Same; respects subagent allow-list when applicable. |
| `find_experts` / `find_orphans` | HTTP MCP | Same. |
| `sync` / `embed` / `extract` | Shell job + `inherit:` | Thin-client refused; needs local engine + FS. |
| `dream` | Shell job + `inherit:` | Thin-client refused; synthesis runs on the host. |
| `doctor` | Run directly (any install) | Not refused: thin clients get the remote probe set. |
| `autopilot` | Run as a daemon directly on the host | Long-lived, not job-shaped. |
| `init` / `config` | One-time host setup | Operator action, not agent action. |

## Recommended patterns

- **Prefer `inherit:` for secrets you don't want in the row.** Names land in
  `minion_jobs.data`; values resolve at child-spawn from the worker's config.
  If a brain DB ever traverses a trust boundary, secrets stay out.
- **Free-form names.** `inherit:` accepts any snake_case config-key on your
  worker — `database_url`, `anthropic_api_key`, `openai_api_key`,
  `openrouter_api_key`, `voyage_api_key`, `groq_api_key`,
  `zeroentropy_api_key`, or any custom
  field you stuff into `~/.gbrain/config.json`. The agent picks what it
  needs.
- **`env:` still works** for non-secret values, or for cases where you
  WANT the value in the row (e.g. an opaque correlation token your audit
  flow needs to read back later). The validator doesn't second-guess you.
- **Never try to route a refused command through a thin client.** The CLI
  refuses it at dispatch with a hint. Use shell-job + `inherit:` (for
  secrets) or `env:` (for non-secrets) on the host instead.
- **Push-based context.** Beyond request/response ops, MCP clients can
  receive volunteered context via the `volunteer_context` op — see
  [push-context.md](./push-context.md).

## Migration: from `env:`-passed secrets

If your agent submits shell jobs that pass secrets via `env:`:

```jsonc
// Rejected at submit: the URL would persist in minion_jobs.data plaintext.
{
  "cmd": "gbrain sync --skip-failed",
  "cwd": "/data/gbrain",
  "env": { "GBRAIN_DATABASE_URL": "postgresql://..." }
}
```

Switch to (recommended):

```jsonc
// Name in row, value resolved at child-spawn from worker config.
{
  "cmd": "gbrain sync --skip-failed",
  "cwd": "/data/gbrain",
  "inherit": ["database_url"]
}
```

Make sure the worker host has `database_url` configured (either via
`gbrain config set database_url <value>` or via `GBRAIN_DATABASE_URL` /
`DATABASE_URL` env on the worker process). If the worker can't resolve the
key, the validator rejects the job at submit time with a paste-ready hint.
