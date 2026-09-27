# GBrain Deployment Topologies

GBrain supports three deployment shapes. They compose: a single user can mix
all three on the same machine without conflict, because every shape resolves
to "which `~/.gbrain/config.json` is active right now?" and `GBRAIN_HOME`
controls that selection.

This page covers the three topologies, when each fits, and concrete setup
recipes. Pair this doc with `docs/architecture/brains-and-sources.md` (which
covers the in-brain organization axes) — that doc is about WHICH database;
this doc is about WHERE that database lives.

## Quick decision tree

```
   "I'm setting up gbrain..."
        │
        ▼
  Just for me, on one machine? ─── yes ───▶ Topology 1 (single brain)
        │
        no
        │
        ▼
  Will a remote machine host the brain
  while my agent runs locally? ──── yes ───▶ Topology 2 (cross-machine thin client)
        │
        no
        │
        ▼
  Multiple Conductor worktrees that
  shouldn't share a code index? ─── yes ───▶ Topology 3 (split-engine)
```

Topologies 2 and 3 stack: a thin-client install can also host per-worktree
code engines, and a per-worktree code engine can also point its artifact
brain at a remote server.

## Topology 1 — Single brain (the default)

```
  ┌────────────────┐
  │   one machine  │
  │  ┌──────────┐  │
  │  │  gbrain  │──┼──→  ~/.gbrain/  →  PGLite  or  Supabase
  │  │   CLI    │  │
  │  └──────────┘  │
  └────────────────┘
```

What you get: one local DB (PGLite for small brains, Supabase for ~1000+
files). All commands work directly against it. `gbrain serve` exposes it
to a single agent over MCP.

When it fits: solo use, single machine, one agent, no Conductor parallelism.
This is the default; `gbrain init` (no flags) gives you this.

Setup:

```
gbrain init           # interactive — defaults to PGLite
gbrain init --pglite  # explicit local
gbrain init --supabase  # remote Supabase (recommended for 1000+ files)
```

Nothing else here is special. The other two topologies are variations on
"who owns the DB" and "how does the agent talk to it."

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
    "oauth_client_secret": "..."  // or set GBRAIN_REMOTE_CLIENT_SECRET
  }
}
```

The CLI dispatch guard refuses every DB-bound command (`sync`, `embed`,
`extract`, `migrate`, `serve`, `enrich`, `jobs`, `sources`, `pages`,
`files`, `eval`, and the rest of the local-only surface — the full hint
table is `THIN_CLIENT_REFUSE_HINTS` in `src/cli.ts`) on a thin-client
install with a clear error pointing at the remote host. `gbrain doctor`
runs a dedicated thin-client check set (OAuth discovery, token round-trip,
MCP smoke). See [`thin-client.md`](./thin-client.md) for the routing seam.

### Setup

**Step 1 — On the host (brain-host):**

```bash
gbrain init --supabase                         # or --pglite, doesn't matter
gbrain serve --http --port 3001 --bind 0.0.0.0 # bind explicitly for remote access
                                                # (default bind is 127.0.0.1)
gbrain auth register-client neuromancer \
  --grant-types client_credentials \
  --scopes read,write,admin                    # admin needed for ping/doctor

# source-scoped client (write to one source, federate reads across
# multiple sources). Omit both flags for an unscoped super-client.
gbrain auth register-client neuromancer-dept \
  --grant-types client_credentials \
  --scopes read,write \
  --source dept-x \
  --federated-read dept-x,shared,parent-canon
```

The `register-client` command prints a `client_id` and `client_secret`.
Note both. **Scope must include `admin`** for `run_doctor` (used by
`gbrain remote doctor`) and generic background jobs. `submit_job` accepts
only `sync`, `import`, `lint`, and `lint-fix` with the authenticated source's
registered root. `gbrain remote ping` no longer submits an autopilot cycle;
run maintenance on the brain host. See the
[authorization upgrade guide](../guides/authorization-upgrade.md#generic-remote-background-jobs).

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
3. macOS Keychain integration is not supported (roadmap item).

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
gbrain reindex-code --yes
```

(`gbrain config set embedding_model` is refused because the schema column
has to resize alongside the config.)

`gbrain reindex-code` prints a recommendation when the configured
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

## Combining topologies

The three shapes compose. A single machine can run:

- A thin-client default config pointing at a remote artifact brain
  (Topology 2).
- Plus per-worktree code brains under their own `GBRAIN_HOME` (Topology 3).
- Each worktree's `gbrain serve` instance is local; the agent's MCP config
  lists them alongside the remote artifact brain.

`GBRAIN_HOME` controls which config file is active for any one CLI
invocation. `gbrain serve --port` controls which port a server listens on.
The agent's MCP client picks the alias and thus the destination per tool
call. There's no global gbrain orchestrator that knows about all of them
simultaneously — that's by design.

## Writer administration is not routine repair

An `owner_unavailable` write error means that the selected source cannot currently
publish through its designated owner. It is not permission to claim a checkout,
activate managed persistence, or transfer ownership. Start with read-only inspection
on the selected brain host:

```bash
gbrain sources writer status --brain host --json
```

Keep the brain and source selection explicit. Inspect the existing owners, source
bindings, epochs, enabled state and outstanding recovery before asking the operator
what should change. `doctor`, `doctor --fix`, startup checks, scheduled maintenance
and retries must leave these identities and epochs alone. Never remove ownership
markers, recreate identities, or edit database rows to bypass a refusal.

`writer_status.onboarding` reports each source's binding, legacy-lock state and
the next deliberate step. A configured but unbound Postgres source refuses writes;
claiming it alone does not restore legacy sync. Claim the intended canonical path,
inspect a **fresh** status and fingerprint, then activate only after quiescing
older writers. Neither repair nor startup auto-claims or activates sources.

### Deliberate topology changes

Only the trusted local CLI administration lane can perform these operations.
Ordinary remote tokens and stdio agent credentials cannot administer ownership,
even when they supply the flags below. Local shell access is already trusted:
these flags record deliberate, state-bound intent, not proof that a human is
typing. A TTY or a generic `--yes` is neither required nor sufficient.

For a planned change, the operator must review `status` and retain its `admin_state`
fingerprint. Each non-dry-run action requires both an exact `--admin-intent` and
`--expected-state` containing that reviewed fingerprint:

| Action | Required intent |
|---|---|
| `claim` | `writer_claim` |
| `activate` | `writer_activate` |
| `transfer prepare` | `writer_transfer_prepare` |
| `transfer accept` | `writer_transfer_accept` |

For example, after reviewing the target host and canonical directory:

```bash
gbrain sources writer claim default --brain host --path /absolute/canonical/source --dry-run --json
gbrain sources writer claim default --brain host --path /absolute/canonical/source \
  --admin-intent writer_claim --expected-state <reviewed-admin-state> --json
```

Inspect status again after each change. The fingerprint covers the brain identity,
managed mode, source incarnations and paths, owner identities and epochs, worktree
membership and transfer manifests. It excludes heartbeats and ordinary queue
traffic. A changed fingerprint refuses with `writer_admin_state_changed`, including
a change racing the final transaction. Re-inspect and re-review; do not blindly
substitute the new value and retry. Dry runs do not grant permission to apply.

Activation additionally requires every older writer and maintenance process on
every host to be upgraded and stopped, filesystem sources to have their intended
owners, and outstanding locks and recovery to be resolved. Preview activation
with `--confirm-quiesced --dry-run`, then, only when approved:

```bash
gbrain sources writer activate --brain host --confirm-quiesced \
  --admin-intent writer_activate --expected-state <reviewed-admin-state> --json
```

`--confirm-quiesced` remains an attestation about all hosts, not a way to bypass the
intent and state checks. Explicit noninteractive provisioning uses the same
procedure and preconditions. A transfer still requires the prepared epoch and an
exact successor manifest; stale heartbeats never authorize takeover.

Live, young or foreign legacy locks block activation regardless of expiry. For
exact dead same-host holders only, preview with
`--cleanup-dead-local-locks --dry-run` and explicitly opt in on the reviewed
activation; preview never deletes locks. Do not use TTL alone as liveness proof.

For same-owner physical-root drift, `transfer prepare --self-transfer` records
the exact before-state and intended repair in a durable manifest; inspect a
fresh status and use `transfer accept --self-transfer` with the new reviewed
state and exact manifest. Both phases still require their corresponding
`writer_transfer_prepare` or `writer_transfer_accept` intent and expected state.
This is not an automatic takeover or a way to rewrite the original reservation
owner. Wrong identity, changed tokens, malformed physical records or uncertain
liveness refuse. The native lock derives from the database binding.

```bash
gbrain sources writer transfer prepare default --brain host --self-transfer \
  --admin-intent writer_transfer_prepare --expected-state <reviewed-admin-state> --dry-run --json
# After separate approval, rerun prepare without --dry-run; then inspect fresh status.
gbrain sources writer transfer accept default --brain host --self-transfer \
  --path /absolute/canonical/source --expected-epoch <prepared-epoch> \
  --manifest <prepared-sha256> --admin-intent writer_transfer_accept \
  --expected-state <fresh-reviewed-admin-state> --dry-run --json
# After separate approval, rerun accept without --dry-run.
```

For containers, persist the canonical source root, its sibling-reservation
parent, persistence home and stable lock/coordination directory together across
recreation. Storage preflight reports each location and can identify Linux
overlay/tmpfs backing, but a mount shown as present is **not** attested durable.

### Supported managed work and explicit repair

Once active, ordinary authorized local atom extraction, fact fences/backstop,
synthesis, patterns and consolidation use journaled resident publication. Atom
admission retains output for provider-free publication replay; a malformed
extraction needs a separately approved retry identity. After inspecting the
failed receipt, a trusted local operator can submit:

```bash
gbrain jobs submit extract-atoms-drain --params '{"sourceId":"default","retryRequestId":"<receipt-request-id>"}' --follow --max-attempts 1 --idempotency-key <unique-approval-key>
```

Replace the source and receipt with the inspected values and choose a unique
approval key for that action. Inspect a submitted retry with `gbrain jobs get
<job-id>` rather than resubmitting it. Completed submissions replay their result;
a newly submitted job after failure is a new approval to attempt extraction.
An approved malformed-output retry permits one new extraction attempt;
publication retry reuses admitted output without another model call. Neither
overrides source identity, changed content or grants. For a failed embedding
effect, preview the exact original request first, then separately approve the
same command without `--dry-run`:

```bash
gbrain sources writer retry-effects default --request-id <original-request-uuid> --dry-run --json
```

Only an unclaimed failed nonrecovering embedding effect is eligible. Current
valid vectors reconcile without provider work; otherwise the additional
allowance is one-shot and covers worker attempts, which may contain provider
sub-batches. It remains bounded by selected-brain policy, original/current
authority, source/page revision and effect CAS. This changes no canonical
receipt, content or ownership. Healthy embedding work renews its token-guarded
claim every ten seconds without holding a worktree lock or database transaction
over provider work. Losing the claim cancels that invocation; the final
installation still verifies its token. Caller cancellation, per-provider
timeouts and budget admission remain effective without a whole-page deadline.

Direct `--brain <mount>` retry uses only the selected database's validated active
column and recorded model provenance for inspection and explicit queue approval.
Unknown or inconsistent provenance refuses the action; the host brain's model
and policy are never borrowed. The receipt identifies this as
`approval: selected_database_provenance` and `execution: owner_file_and_database`.
Queue approval is not permission to bypass the eventual owner's selected file
configuration: both that configuration and the database `embedding_disabled`
setting must permit each provider attempt and final installation. A disable in
either effective policy stops further provider work. Existing valid vectors can
still reconcile without a provider while embeddings are disabled.

Fact NULL-vector backfill is a separate
source-scoped preview/approved-cost operation in
[embedding migrations](../embedding-migrations.md).

Local enabled synthesis and patterns publish through the admitted page path;
consolidation uses a single source-scoped take/fact transaction. A retired or
resolved matching take is skipped, not silently reopened. Only world-visible
facts backed by live non-private evidence are eligible for public consolidation;
this is no guarantee that private facts will be consolidated. Remote maintenance
authority is not added. Legacy fence reconciliation (`dream --phase
extract_facts`), bulk `extract-conversation-facts`,
`conversation_facts_backfill`, and `loops_extract` remain unsupported under
managed persistence, including preview paths that could spend. Their preflight
refuses with `writer_coordinator_required`; writer status and activation preview
list them in `unsupported_maintenance`. The restored `extract_facts` operation
and page backstop are separate from the legacy cycle fence reconciler. Do not
infer that every dream or job writer is restored from the named lanes above.

Google and GitHub API sources route through managed connector checkpoints,
not a Git cursor. A deliberately unbound API source uses reviewed
`connector_database` DB-only authority; an existing bound source retains
canonical file publication and physical-root fences. Activation/status expose
that distinction, and neither mode invents a binding. Managed connector
`--dry-run`, `--skip-failed`, and Git filtering/working-tree/code options refuse
before credentials or network access rather than pretending to preview.
After repairing a terminal connector storage failure, explicitly run
`gbrain sync --source <connector-source-id> --retry-failed` with the same options.
Ordinary replay does not reopen a failed receipt. Explicit retry authorizes a
new, linked attempt after current and originally accepted grants, source,
canonical owner and idle state are checked. The old receipt stays immutable,
including after receipt compaction. A durable retry pointer is committed with
the new admission; repeated or restarted calls reuse its pending attempt rather
than granting another one. Retry does not reset the API bookmark or bypass
canonical-file drift checks, and both connector cursors and retry pointers
survive generic checkpoint TTL cleanup. A newly failed replacement requires
another explicit retry after inspecting and repairing its cause; cancelled
receipts are not retry-approved. No connector API data is fetched before the
source/owner and active-work preflight, although deriving exact matching input
can require a normal API fetch before retry approval.
For PGLite, `dream` and `jobs --follow` still need exclusive engine access:
stop the resident owner and any supervisor using their normal shutdown path,
wait for writes to drain, run the inline command, then restart the owner. The
disk-brain CLI regression verifies refusal with a live owner, malformed-output
recovery, idempotent replay and fresh readback after a clean restart. Do not
disable persistence to bypass this, and do not confuse live fact-backfill IPC
with live-owner dream delegation.

## When NOT to use these topologies

- **Don't use Topology 2 if your agent only ever runs on the same machine
  as the brain.** A local `gbrain` install + `gbrain serve` (stdio) is
  simpler and faster.
- **Don't use Topology 3 if you only have one Conductor worktree at a
  time.** Per-worktree engines exist to prevent contention; one-at-a-time
  use has no contention.
- **Don't use a `remote_mcp` thin client AND a local engine on the same
  machine in the same `GBRAIN_HOME`.** The dispatch guard refuses DB-bound
  commands when `remote_mcp` is set. If you genuinely want both modes on
  one machine, use `GBRAIN_HOME` to separate them (one home for the thin
  client, another for the local engine).

## See also

- `docs/guides/bootstrap.md` — `gbrain bootstrap`, the paved-road paste-in
  install for Topology 1 with a desktop coding agent (interview, hooks,
  MCP registration, verify).
- `docs/architecture/brains-and-sources.md` — in-brain organization (brains
  vs sources axes).
- `docs/mcp/CLAUDE_DESKTOP.md` and siblings — per-client MCP setup.
- `gbrain init --help` and `gbrain auth --help` for command-level details.
- [`docs/tutorials/`](../tutorials/) — end-to-end walkthroughs that combine
  these topologies into working setups (company brain, personal brain,
  agent integration, etc.).
