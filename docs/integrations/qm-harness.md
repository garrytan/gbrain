# qm (multi-user agent harness) — gbrain as the company brain

Connect gbrain to [qm](https://github.com/yc-software/qm) — the multiplayer
agent harness where each employee and each channel gets an isolated agent
scope — so every scope's agent can search and write one shared, indexed,
isolation-enforced company brain. The same recipe fits any harness with
per-person sandboxes that can run a CLI.

**Shape:** one central `gbrain serve --http` (OAuth 2.1) next to qm's core;
the `gbrain` binary baked into qm's sandbox image as a thin client; one OAuth
client per employee, read-fenced by source federation and write-fenced by
`bound_slug_prefixes`. Zero qm code changes — everything lives in the qm
*deployment directory*.

qm's native memory (per-scope notebook) stays as-is for fast per-turn recall.
gbrain adds what qm doesn't have: semantic + hybrid search, cross-scope
knowledge, entity graphs, and durable memory that outlives a scope.

## Topology

| gbrain concept | qm concept |
|---|---|
| one brain (one Postgres/Supabase DB) | the org |
| source `agents` (path-less, shared) | all agent-written memory |
| slug prefix `emp-<slug>/` in `agents` | an employee's personal scope |
| slug prefix `chan-<slug>/` in `agents` | a channel/room scope |
| source `org-wiki` (git-backed, read-only) | company docs |
| OAuth client `qm-emp-<slug>` | one employee's agent identity |

Isolation model:

- **Reads** are source-granular, SQL-enforced (`federated_read`): every
  employee client reads `agents` + the read-only sources you grant.
- **Writes** are slug-prefix-granular, server-enforced (`bound_slug_prefixes`,
  v0.42.72.0+): a client can only mutate pages under its own `emp-<slug>/`
  and its channels' `chan-<x>/` prefixes — on `put_page`, `delete_page`,
  `restore_page`, `add_tag`, `remove_tag`, `add_link`/`remove_link`,
  `add_timeline_entry`, `revert_version` and `put_raw_data`, plus the
  `POST /ingest` webhook route. Not by convention.
- **Every op that is not a plain read is denied unless allow-listed.** Ops
  that write by a key other than a slug — `extract_entities` and
  `extract_facts` (which mutate `people/*` and `companies/*`), `forget_fact`
  (targets a fact by numeric id, across sources), `ontology_propose`, and the
  `sources_admin` pair `sources_add`/`sources_remove` — cannot be fenced by
  slug, so a bound client gets `permission_denied` at dispatch. The gate keys
  on "not a pure read", not on a list of scope strings, so a write op added
  later (or one carrying a bespoke scope) is denied until it is explicitly
  fenced and added to `CLIENT_FENCED_WRITE_OPS` (`src/core/operations.ts`).
  `think` is allow-listed because remote callers cannot persist from it;
  `submit_agent` because it enforces this same column itself.
- **Indirect write paths are gated too, not just the ops.** `put_page`'s
  facts backstop would otherwise extract entities from the page body and
  write fact rows (and a `## Facts` fence on git-backed sources) onto
  `people/*` pages the caller never named — the same capability
  `extract_facts` is denied for, reached through an in-prefix write. It is
  skipped for bound clients. `POST /ingest` is refused outright: its handler
  bypasses the op layer, so `enforceClientSlugFence` never runs and a bound
  client could write any slug inside its granted source.
### Known limitations — read these before you rely on the fence

The write fence is a **write** boundary within a source. It is not a privacy
boundary, and it does not make every side effect prefix-clean. As of
v0.42.73.2:

- **The fence follows a delegated write.** When a client with `agent` scope
  hands work to a subagent via `submit_agent`, that subagent runs under its own
  slug confinement rather than the parent's OAuth binding. Both confinements are
  enforced, including on the path where deduplication redirects a write onto an
  existing page: the redirected target is checked against whichever confinement
  the calling context actually carries, so delegation does not widen what a
  client can write.

- **`add_link`/`remove_link` fence the `from` endpoint only.** A bound client
  can create an edge pointing AT a page it cannot write; the edge's `context`
  text surfaces in that page's backlinks and contributes to its search
  ranking. Fencing `to` would break legitimate cross-referencing into
  `org-wiki`, so this is deliberate — treat inbound-edge context as untrusted
  content, the same way you treat page bodies.
- **Reads are source-granular, never prefix-granular.** Everyone entitled to
  a source can read every prefix in it. If a scope needs genuine read
  privacy, give it its own source.
- **`put_page` can create one reverse graph edge outside the fence.** If a
  page body cites a code location (`src/x.ts:42`) and a code page for it
  exists *in the same source*, doc↔impl reconciliation adds an edge
  originating from that code page. It affects graph/backlink ranking, not
  page content. Unreachable in the layout above (the `agents` source is
  path-less and holds no code pages); it applies only if you point employee
  writes at a code-synced source.
- **A few read ops are still brain-wide** and ignore the federated grant:
  `get_recent_salience`, `find_anomalies`, `find_contradictions`, and
  `sources_list`/`sources_status` (which expose source ids, paths and URLs).
  A read-scoped client can learn facts derived from sources it was not
  granted. Pre-existing, not introduced by the fence; if that matters for
  your deployment, withhold those tools at the harness layer for now.
- **Reads touch `last_retrieved_at`** on the pages they return, including
  pages in read-only sources. Freshness/usage signals are therefore
  writable-by-reading; nothing else about the page is.
- **`POST /ingest` writes land in the calling client's granted source.** The
  write source is resolved server-side from `oauth_clients.source_id`; the
  caller-supplied `X-Gbrain-Source-Id` header does not route anything, so a
  client cannot choose its own write partition. A client registered without a
  source writes to `default`, and a write falls back to `default` if its
  source is unregistered, archived, or deleted mid-write (the job result
  reports this via `source_fallback`). If you point a webhook integration at
  this route, give its client an explicit `--source` so its captures do not
  accumulate in the brain's `default` source. Bound clients are still refused
  the route outright, because the slug fence cannot run on this path.
- **Tradeoff to state out loud:** read isolation is per-source, so within the
  shared `agents` source every employee can *read* every prefix (including
  other employees' `emp-*/`). That matches qm's transparent-by-default,
  everything-audited posture. If you need hard read privacy for personal
  memory, give those employees their own write source instead of a prefix
  (one `sources add emp-<slug>` + `--source emp-<slug>` per client) and keep
  channel prefixes in `agents` via a second, channels-only client — at the
  cost of two credentials in that sandbox.

## Host setup (the machine running qm's core, or any box its sandboxes can reach)

```bash
# 1. Engine: Postgres/Supabase. PGLite is single-process and cannot serve
#    many concurrent sandboxes.
gbrain init --supabase --embedding-model voyage:voyage-4-large

# 2. Modes + gates (publish_* default OFF and fail as silent 403s):
gbrain config set search.mode balanced
gbrain config set mcp.publish_skills true
gbrain config set mcp.publish_advisor true

# 3. Read-only org sources + first sync:
gbrain sources add org-wiki --path ~/brains/org-wiki
gbrain sync --all        # cron this

# 4. Serve over HTTP MCP (OAuth 2.1):
gbrain serve --http --bind 0.0.0.0 --port 3131 \
  --public-url https://brain.acme-example.com
```

Never hand sandboxes `DATABASE_URL` — direct DB access bypasses OAuth, source
federation, and the write fence entirely.

## Provision scopes from a roster

[`qm-harness-snippets/provision-scopes.sh`](qm-harness-snippets/provision-scopes.sh)
converges the brain to a roster file
([`roster.example.tsv`](qm-harness-snippets/roster.example.tsv)):

```bash
bash provision-scopes.sh roster.tsv --read-sources org-wiki
```

- Creates the path-less `agents` source (agent-written memory needs no git
  clone; if the host has `sync.repo_path` configured, pages also write
  through to `.sources/agents/` for git-backed durability).
- Registers `qm-emp-<slug>` clients: `--scopes "read write"`,
  `--source agents`, `--federated-read agents,org-wiki`,
  `--bound-slug-prefixes emp-<slug>/,chan-<a>/,...`, per-day budget.
- **Idempotent:** re-run after every roster edit; existing clients are
  `rescope-client`ed in place (channel joins/leaves update the write fence
  without rotating secrets).
- New client secrets land once in `<roster>.new-credentials.tsv` — deliver
  each row to its scope (qm keychain / one-time secret drop), then delete
  the file.

## qm deployment directory

In the org's qm deployment repo (the directory `qm init` produced):

1. **Tool:** copy [`qm-harness-snippets/tool.json`](qm-harness-snippets/tool.json)
   to `sandbox/tools/gbrain/tool.json` and drop the compiled `gbrain` binary
   beside it (`bun build --compile --outfile gbrain src/cli.ts`, built for
   the sandbox image's OS/arch). `auth.credentialPaths` marks
   `~/.gbrain/config.json` as the scope's resident credential file;
   `auth.check` wires `gbrain whoami` into qm's connector status (read-scope;
   see the note below on why `remote doctor` cannot be used here).
2. **Skill:** copy [`qm-harness-snippets/SKILL.md`](qm-harness-snippets/SKILL.md)
   to `sandbox/skills/gbrain/SKILL.md` (edit slug conventions to taste).
3. Ship it: `qm sandbox build && qm sandbox publish && qm up`.

Per scope, one-time (agent- or operator-run, credentials from the handoff):

```bash
gbrain init --mcp-only \
  --issuer-url https://brain.acme-example.com \
  --mcp-url https://brain.acme-example.com/mcp \
  --oauth-client-id gbrain_cl_... --oauth-client-secret gbrain_cs_...
gbrain whoami                       # must succeed
```

Use `--oauth-client-secret`, not `GBRAIN_REMOTE_CLIENT_SECRET`: an env-sourced
secret is deliberately not written to `~/.gbrain/config.json`
(`src/commands/init.ts`), so with the env var alone every later command fails
once it leaves scope — and qm's `sandbox.secretEnv` is org-wide, so there is no
per-scope env to keep it in. With the flag, the credential lands in the config
file on the scope's durable disk and this runs once per scope, ever.

`gbrain remote doctor` is **not** the health check here: `run_doctor` is an
`admin`-scope op and these clients are `read write` on purpose. `gbrain whoami`
is read-scope and reports the client's identity, source, and grants.

## Verify isolation before rollout

From two differently-scoped sandboxes (or two thin-client configs):

```bash
# alice-example (bound to emp-alice-example/, chan-eng/):
gbrain put emp-alice-example/notes/test --content "mine"        # OK
gbrain put chan-eng/notes/test --content "shared"               # OK
gbrain put emp-bob-example/notes/test --content "not mine"      # permission_denied
gbrain put chan-product/notes/test --content "not my channel"   # permission_denied
gbrain search "test"                                            # sees agents + org-wiki only
```

## Cost + operations

- `search.mode balanced` (12K token budget, relational retrieval on) is the
  right default for a startup fleet; see `docs/guides/search-modes.md` for
  the cost matrix before changing it.
- Budgets: `--budget-usd-per-day` is recorded on the client but only enforced
  on the `submit_agent` path (`src/core/minions/budget-meter.ts`), which these
  `read write` clients cannot reach — so it does **not** cap spend from
  ordinary `search`/`put_page` traffic. Treat runaway-agent containment as an
  open item: watch the admin SPA (`/admin`) and `gbrain search stats`, and cap
  at the model/harness layer.
- Backfills on a live brain: `gbrain embed --stale --pace` (see Pace Mode in
  CLAUDE.md / `docs/operations/spend-controls.md`).

## Deliberately deferred

- **qm `MemoryService` decorator** (mirror notebook captures into gbrain,
  fan `recall` out and merge, `volunteer_context` push): needs a qm code
  change; today's integration is agent-initiated via the CLI + skill.
- **MCP-native attach:** qm pins `strictMcpConfig` with only its in-process
  server, so gbrain's MCP-discovered brain-resident skillpacks don't reach
  qm agents; the sandbox skill above covers it.
- **Read-side prefix fencing** (hard privacy for `emp-*/` inside a shared
  source) — tracked upstream; the roster layout is forward-compatible with
  it.
