# GBrain Operating Models and Deployment Topologies

GBrain has two separate setup decisions:

1. **Operating model:** who owns or uses the brain, and what access policy they
   need.
2. **Deployment topology:** where the database, server, and clients run, and how
   agents connect.

Do not collapse those into one choice. A solo user may still need a remote,
split-engine, or isolated topology because an agent runs on another machine, a
cloud client requires HTTPS, or a security boundary needs a separate home. A
family, household, team, or company brain can start with one trusted shared
agent and later move to OAuth-scoped clients without changing the basic concept
of a shared brain.

Pair this doc with `docs/architecture/brains-and-sources.md`. That doc explains
the brain/source axes: WHICH database and WHICH repo inside that database. This
doc helps choose the operating model first, then the deployment topology.

## Operating model decision tree

```
   "Who owns or uses this brain?"
        │
        ├── One person only
        │     ├── One repo or knowledge stream ───▶ Solo personal brain
        │     └── Many repos or domains ─────────▶ Personal multi-source brain
        │
        └── More than one person, household,
            family, team, or company
              ├── One trusted agent/interface
              │   serves everyone ───────────────▶ Shared group brain,
              │                                      single-agent shared mode
              │
              └── Multiple users, agents, or
                  clients need independent
                  credentials ───────────────────▶ Auth-scoped shared mode
```

| Operating model | Who uses it | Typical organization | Access model |
|---|---|---|---|
| Solo personal brain | One owner, one local or trusted agent | One source, or a small default brain repo | The local operator controls the brain. |
| Personal multi-source brain | One owner with many repos, projects, or domains | One brain with many sources (`notes`, `work`, `essays`, `code`) | Source routing keeps repos separate without creating new databases. |
| Shared group brain | A family, household, team, fund, or company | One shared brain, or a few owned brains mounted together | Pick single-agent shared mode or auth-scoped mode below. |
| Single-agent shared mode | Many people through one trusted agent or interface | One source with folder conventions such as `partners/alice-example/` | Simpler ops; isolation is convention and agent-policy enforced. |
| Auth-scoped shared mode | Many people or agents with their own clients | Multiple sources with `--source` and `--federated-read` grants | OAuth scopes and SQL/source filters enforce read/write boundaries. |

## Deployment topology decision tree

```
   "Where should the brain run?"
        │
        ├── Same machine as the user or agent,
        │   with no extra separation need ───────▶ Topology 1: local/default
        │
        ├── Brain host is remote and clients
        │   should stay thin ───────────────────▶ Topology 2: remote/thin client
        │
        ├── Worktrees need isolated code indexes
        │   plus a shared artifact brain ───────▶ Topology 3: split-engine/worktree
        │
        ├── Independently owned brains need to be
        │   visible side by side ───────────────▶ Topology 4: mounted/cross-team brains
        │
        └── Trust, client exposure, or agent safety
            requires separation even for solo use ▶ Security-driven isolated setup
```

The topology choice is composable. A thin-client install can also use
per-worktree code engines. A per-worktree code engine can point its artifact
brain at a remote server. A shared company brain can mount another team's brain
for separately governed context. `GBRAIN_HOME`, MCP aliases, source scopes, and
mounts are the primitives that keep those choices explicit.

## How operating models map to topology

| Operating model | Common starting topology | When to branch |
|---|---|---|
| Solo personal brain | Topology 1: local/default | Use Topology 2 if the agent runs elsewhere or a cloud MCP client requires HTTPS. Use security isolation if an agent should not share the operator's default home. |
| Personal multi-source brain | Topology 1 with multiple sources | Use Topology 3 when code worktrees need disposable code indexes. Use Topology 4 when another owner publishes a separate brain. |
| Family or household brain | Topology 1 or 2, depending on where the shared agent runs | Use single-agent shared mode for one household assistant; use auth-scoped mode if family members run separate clients. |
| Team or company brain | Topology 2 with Postgres/Supabase and HTTP MCP | Use auth-scoped mode for separate user/agent credentials. Use mounted brains when teams own separate databases. |
| Cross-team/company network | Topology 4 plus source scoping inside each brain | Keep ownership at the brain boundary; use sources when the owner stays the same and only the repo/domain changes. |

## Topology 1 — Local/default single brain

```
  ┌────────────────┐
  │   one machine  │
  │  ┌──────────┐  │
  │  │  gbrain  │──┼──→  ~/.gbrain/  →  PGLite  or  Supabase
  │  │   CLI    │  │
  │  └──────────┘  │
  └────────────────┘
```

What you get: one local DB (PGLite for small brains, Supabase or Postgres for
larger brains). All commands work directly against it. `gbrain serve` exposes it
to a local agent over stdio MCP.

When it fits: solo use, a first install, a local coding-agent memory, or a
shared brain that is not exposed beyond one trusted machine yet. This is the
default; `gbrain init` (no flags) gives you this.

Setup:

```
gbrain init           # interactive — defaults to PGLite
gbrain init --pglite  # explicit local
gbrain init --supabase  # remote Supabase (recommended for 1000+ files)
```

Nothing else here is special. The other topologies are variations on "where does
the DB live?" and "how does the agent talk to it?"

## Topology 2 — Cross-machine thin client

```
  ┌────────────┐                    ┌──────────────────┐
  │ neuromancer│                    │    brain-host    │
  │ ┌────────┐ │ HTTP MCP / OAuth   │  ┌────────────┐  │
  │ │ Hermes │─┼───────────────────→│  │   gbrain   │──┼──→ Supabase
  │ │ agent  │ │                    │  │ serve --http│  │
  │ └────────┘ │                    │  └────────────┘  │
  │            │                    │   (with autopilot)│
  │  no local  │                    │                  │
  │  gbrain DB │                    │                  │
  └────────────┘                    └──────────────────┘
```

What you get: the agent on one machine ("neuromancer") consumes a brain
hosted on another machine ("brain-host") over HTTP MCP with OAuth. The
agent's machine has NO local engine. All queries, searches, embeddings,
and indexing happen on the host.

When it fits:

- Heavy brain (Supabase + autopilot) lives on a beefy machine; agents
  elsewhere just consume it.
- You want one source of truth across many machines.
- Spinning up a parallel local install would create source-ID contention or
  duplicate work.

The thin client's `~/.gbrain/config.json` carries a `remote_mcp` field
instead of a local DB connection:

```jsonc
{
  "engine": "postgres",  // ignored — never used
  "remote_mcp": {
    "issuer_url": "https://brain-host.local:3001",
    "mcp_url":    "https://brain-host.local:3001/mcp",
    "oauth_client_id": "neuromancer-...",
    "oauth_client_secret": "..."  // or set the env var instead
  }
}
```

The CLI dispatch guard refuses any DB-bound command (`sync`, `embed`,
`extract`, `migrate`, `apply-migrations`, `repair-jsonb`, `orphans`,
`integrity`, `serve`) on a thin-client install with a clear error pointing
at the remote host. `gbrain doctor` runs a dedicated thin-client check set
(OAuth discovery, token round-trip, MCP smoke).

### Setup

**Step 1 — On the host (brain-host):**

```bash
gbrain init --supabase                         # or --pglite, doesn't matter
gbrain serve --http --port 3001 --bind 0.0.0.0 # v0.34: bind explicitly for remote access
                                                # (defaults to 127.0.0.1 since v0.34)
gbrain auth register-client neuromancer \
  --grant-types client_credentials \
  --scopes read,write,admin                    # admin needed for ping/doctor

# v0.34: source-scoped client (write to one source, federate reads across
# multiple sources). Omit both flags for a v0.33-compatible super-client.
gbrain auth register-client neuromancer-dept \
  --grant-types client_credentials \
  --scopes read,write \
  --source dept-x \
  --federated-read dept-x,shared,parent-canon
```

The `register-client` command prints a `client_id` and `client_secret`.
Note both. **Scope must include `admin`** — `submit_job` (used by
`gbrain remote ping`) and `run_doctor` (used by `gbrain remote doctor`)
both require it.

**Step 2 — On the thin client (neuromancer):**

```bash
gbrain init --mcp-only \
  --issuer-url https://brain-host.local:3001 \
  --mcp-url https://brain-host.local:3001/mcp \
  --oauth-client-id <id> \
  --oauth-client-secret <secret>
```

Pre-flight smoke runs three probes (OAuth discovery, token round-trip,
MCP initialize). If any fails, init exits with an actionable error. On
success, `~/.gbrain/config.json` gets `remote_mcp` set and NO local DB
is created.

**Step 3 — Configure your agent's MCP client.**

For Claude Desktop / Hermes / openclaw, add a single MCP server entry
pointing at the host's `mcp_url` with the bearer token from `register-client`.
Example for Claude Desktop's `~/.config/claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "gbrain": {
      "type": "url",
      "url": "https://brain-host.local:3001/mcp",
      "headers": { "Authorization": "Bearer <client_secret>" }
    }
  }
}
```

**Step 4 — Verify.**

```bash
gbrain doctor             # runs thin-client checks (no local DB needed)
gbrain remote ping        # triggers an autopilot cycle on the host (Tier B)
gbrain remote doctor      # asks the host to run its own doctor (Tier B)
```

`gbrain sync` and friends will refuse with a clear thin-client error
naming the `mcp_url`. That's the correct behavior — those commands need
a local engine that doesn't exist here.

### Re-run guard

Running `gbrain init` (no flags) on a machine that already has thin-client
config set refuses without `--force`. This catches the scripted-setup-loop
friction where an orchestrator keeps trying to create a local DB. Use
`gbrain init --mcp-only --force` to refresh thin-client config.

### Storing the OAuth secret

Three storage paths in priority order:

1. **`GBRAIN_REMOTE_CLIENT_SECRET` env var** (preferred for headless agents).
   When set, overrides whatever's in the config file. The init flow doesn't
   persist a config-file copy when the env var was the source.
2. **`~/.gbrain/config.json` with 0600 perms** (default for interactive
   setup; mirrors how Supabase keys are stored today).
3. macOS Keychain integration is on the roadmap; not in v1.

## Topology 3 — Split-engine, per-worktree code + remote artifacts

```
  ┌──────────────────────────────────────────────────────┐
  │                  one machine                         │
  │                                                      │
  │  ┌─ worktree A ──────────────┐                       │
  │  │  GBRAIN_HOME=A/.conductor │                       │
  │  │  gbrain serve --port 3001 │── PGLite (code A)     │
  │  └───────────────────────────┘                       │
  │                                                      │
  │  ┌─ worktree B ──────────────┐                       │
  │  │  GBRAIN_HOME=B/.conductor │                       │
  │  │  gbrain serve --port 3002 │── PGLite (code B)     │
  │  └───────────────────────────┘                       │
  │                                                      │
  │  ┌─ default ~/.gbrain ───────┐    HTTP MCP / OAuth   │
  │  │  gbrain serve --port 3000 │──────────────────────→ remote artifacts
  │  └───────────────────────────┘                        (Supabase / brain-host)
  │                                                      │
  │  Agent's MCP config (Hermes / Claude Desktop):       │
  │    mcp__gbrain_code__*       → http://localhost:3001 │
  │    mcp__gbrain_artifacts__*  → http://brain-host/mcp │
  └──────────────────────────────────────────────────────┘
```

What you get: each Conductor worktree has its own per-worktree code index
(local PGLite, disposable when the worktree dies). Artifacts (plans,
learnings, transcripts) still live in a shared brain that all worktrees
can see and write to.

When it fits:

- Multiple Conductor worktrees on one machine, all touching the same code
  repo.
- You don't want each worktree's code-import to clobber the others'
  `last_commit`, source IDs, or symbol tables.
- You DO want artifacts (plans, learnings, retros, transcripts) to be
  visible across worktrees.

### How it works

`GBRAIN_HOME` selects which `~/.gbrain` directory is active. Set per worktree:

```bash
export GBRAIN_HOME=/path/to/worktree-A/.conductor/gbrain
gbrain init --pglite
gbrain serve --http --port 3001
```

Each worktree's `gbrain serve` instance binds its own port and indexes its
own DB. Multiple `gbrain serve` processes coexist fine — they're separate
OS processes with separate config and separate connection pools.

The artifact brain runs as a separate `gbrain serve` instance with the
default `~/.gbrain` (no GBRAIN_HOME override) — or remote, in which case
it's a Topology 2 setup.

The agent's MCP client config lists multiple servers, each with a unique
alias. Tool names are namespaced as `mcp__<alias>__<tool>`, so the agent
calls `mcp__gbrain_code__search` for code lookups and `mcp__gbrain_artifacts__search`
for artifact lookups.

### Recommended embedding model

Per-worktree code brains index source files only — no meeting notes,
no people pages, no transcripts. Configure each code brain to use
Voyage's code-tuned model at init time so the config can't be lost to a
later `init` overwrite:

```bash
export GBRAIN_HOME=/path/to/worktree-A/.conductor/gbrain
gbrain init --pglite \
  --embedding-model voyage:voyage-code-3 \
  --embedding-dimensions 1024
```

`voyage-code-3` is Voyage's code-specialized embedding model with
head-to-head numbers above their general flagships on code retrieval
([voyageai.com/blog](https://voyageai.com/blog)). For already-initialized
brains, switch with the one-command wipe-and-reinit (preserves every
other config field):

```bash
gbrain reinit-pglite --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024
gbrain reindex --code --yes
```

(`gbrain config set embedding_model` is refused as of v0.37.11.0 because
the schema column has to resize alongside the config.)

`gbrain reindex --code` prints a recommendation when the configured
embedding model isn't code-tuned. Suppress with
`GBRAIN_NO_CODE_MODEL_NUDGE=1` if you've intentionally chosen another
provider (single-vendor procurement, compliance, no Voyage key).

### CRITICAL: alias-level routing is manual

Topology 3 has no smart per-tool routing inside gbrain. The agent picks
which brain to query when it picks the alias. **A wrong alias writes (or
queries) the wrong brain silently.** This is intentional (explicit beats
magic) but real:

- If the agent calls `mcp__gbrain_artifacts__put_page` with code-shaped
  content, that page lands in the artifact brain forever.
- If the agent calls `mcp__gbrain_code__search` for a question that
  actually wants artifact context, the search comes back empty.

Mitigations:

- Name aliases clearly. `gbrain_code` vs `gbrain_artifacts` is unambiguous;
  `gbrain` vs `gbrain_local` is not.
- Document in your agent's system prompt or rules which alias goes where.
  Be explicit about "code questions → `gbrain_code`; everything else →
  `gbrain_artifacts`."
- Pair Topology 3 with `gstack`'s per-worktree wiring (which sets the
  alias names + agent rules consistently across worktrees).

### Setup (manual; gstack automates this side)

The gbrain side requires zero new code — `GBRAIN_HOME` and `--port` already
exist. Setup looks like:

```bash
# Start the artifact brain (default ~/.gbrain) on port 3000
gbrain serve --http --port 3000 &

# Start a per-worktree code brain on port 3001
export GBRAIN_HOME=/path/to/worktree-A/.conductor/gbrain
gbrain init --pglite
gbrain serve --http --port 3001 &
unset GBRAIN_HOME
```

Then configure the agent's MCP config with two entries (different aliases,
different ports). For Claude Desktop:

```jsonc
{
  "mcpServers": {
    "gbrain_artifacts": {
      "type": "url",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer <token-A>" }
    },
    "gbrain_code": {
      "type": "url",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer <token-B>" }
    }
  }
}
```

The gstack-side wiring (per-worktree home setup, port allocation, automatic
MCP config generation, gitignore for the per-worktree DB) is in the gstack
repo's setup-gbrain skill — it composes these primitives, gbrain doesn't
have to know about Conductor.

## Topology 4 — Mounted/cross-team brains

```
  ┌──────────────────────────────────────────────┐
  │ host brain — user's personal or primary DB   │
  │  ├── source: notes                           │
  │  └── source: work                            │
  └──────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────┐
  │ mount: team-brain                            │
  │  └── sources: shared, customers, internal    │
  └──────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────┐
  │ mount: partner-brain                         │
  │  └── sources: published, diligence           │
  └──────────────────────────────────────────────┘
```

What you get: multiple independently owned brains visible to the operator or
agent. Each brain keeps its own database, lifecycle, OAuth surface, backup plan,
and access policy. Sources still exist inside each brain.

When it fits:

- A team publishes a brain that a teammate mounts next to their personal brain.
- A company has separate department brains with separate owners.
- A family, fund, or operating group wants one primary shared brain but also
  needs to reference a separately governed brain.
- Cross-brain reads should be deliberate and attributed instead of hidden SQL
  federation.

This is not the same choice as "personal vs shared." Use a new brain when the
data owner, lifecycle, or access policy changes. Use a new source when the owner
stays the same and only the repo or domain changes.

Setup primitives:

```bash
gbrain mounts add team-brain --path /path/to/team-brain --db-url postgresql://...
gbrain query "latest customer update" --brain team-brain
```

Inside a mounted checkout, a `.gbrain-mount` dotfile can pin commands to that
brain. Inside a source subdirectory, a `.gbrain-source` dotfile can pin commands
to a source within that brain. See `docs/architecture/brains-and-sources.md` for
the full routing precedence.

Agent rule: cross-brain federation is explicit. The agent chooses when to query
another brain, synthesizes the answer, and cites `brain:source:slug` or otherwise
surfaces which brain answered. If a remote or subagent context lacks permission
to read mounts, it must stay local-only.

## Topology modifier — Security-driven isolation

Security isolation is not a separate database engine; it is a reason to choose a
more complex topology even when the operating model is simple.

Use isolation when:

- A solo user runs coding agents that should not share the operator's default
  `~/.gbrain`.
- A cloud client requires HTTP MCP and OAuth even though the brain is personal.
- A worktree agent needs a disposable code index but durable artifacts should
  land in a separate brain.
- A shared brain has sensitive sources that require different OAuth scopes or a
  separate mounted brain.
- You need to test restore, upgrade, or schema-pack changes without touching the
  production brain home.

Common patterns:

| Need | Pattern |
|---|---|
| Keep an agent away from the default local brain | Separate `GBRAIN_HOME` plus a distinct MCP alias. |
| Let a laptop consume a stronger host without local DB access | Topology 2 thin client. |
| Keep code indexing disposable while preserving decisions and learnings | Topology 3 split-engine. |
| Keep ownership or access policy separate | Topology 4 mounted brain instead of another source. |
| Expose a personal brain to a cloud MCP client | HTTP MCP with OAuth, loopback or public binding chosen deliberately. |

## Combining topologies

The topologies compose. A single machine can run:

- A thin-client default config pointing at a remote artifact brain
  (Topology 2).
- Plus per-worktree code brains under their own `GBRAIN_HOME` (Topology 3).
- Mounted team or family brains for deliberately cross-owned context
  (Topology 4).
- Each worktree's `gbrain serve` instance is local; the agent's MCP config lists
  them alongside the remote artifact brain and any mounted-brain workflow.

`GBRAIN_HOME` controls which config file is active for any one CLI
invocation. `gbrain serve --port` controls which port a server listens on.
The agent's MCP client picks the alias and thus the destination per tool
call. There's no global gbrain orchestrator that knows about all of them
simultaneously — that's by design.

## When NOT to use these topologies

- **Don't use Topology 2 just because it sounds more production-grade.** Use it
  when host/client separation, cloud-client exposure, machine capacity, or a
  security boundary actually matters. Otherwise a local `gbrain` install +
  `gbrain serve` (stdio) is simpler and faster.
- **Don't use Topology 3 if you only have one Conductor worktree at a
  time and no isolation need.** Per-worktree engines exist to prevent
  contention or isolate agent code indexes; one-at-a-time use without that
  boundary has no contention.
- **Don't use Topology 4 when a source is enough.** If the data owner and access
  policy are the same, add a source inside the existing brain. A mounted brain
  is for separate ownership, lifecycle, or policy.
- **Don't use a `remote_mcp` thin client AND a local engine on the same
  machine in the same `GBRAIN_HOME`.** The dispatch guard refuses DB-bound
  commands when `remote_mcp` is set. If you genuinely want both modes on
  one machine, use `GBRAIN_HOME` to separate them (one home for the thin
  client, another for the local engine).

## See also

- `docs/architecture/brains-and-sources.md` — in-brain organization (brains
  vs sources axes).
- `docs/tutorials/company-brain.md` — worked auth-scoped shared-brain example
  with single-agent shared mode as the simpler alternative.
- `docs/mcp/CLAUDE_DESKTOP.md` and siblings — per-client MCP setup.
- `gbrain init --help` and `gbrain auth --help` for command-level details.
- [`docs/tutorials/`](../tutorials/) — end-to-end walkthroughs that combine
  these topologies into working setups (company brain, personal brain,
  agent integration, etc.).
