# Install and operate GBrain

This is the human path for installing, configuring, verifying, and operating
GBrain. Coding agents should use [`../INSTALL_FOR_AGENTS.md`](../INSTALL_FOR_AGENTS.md)
instead. That file has extra stop-and-ask gates for agent-run installs.

Current version: [`../VERSION`](../VERSION). Release history:
[`../CHANGELOG.md`](../CHANGELOG.md).

## Choose your install route

Do not read this document as one linear script. Pick one route first, follow that
route end to end, then use the reference sections for details.

| Route | Use when | Follow |
|---|---|---|
| A. Local personal brain | One person, one machine, first install, local coding-agent memory | [Route A](#route-a-local-personal-brain-end-to-end) |
| B. Personal multi-source brain | One owner, many repos/domains in one database | [Route B](#route-b-personal-multi-source-brain-end-to-end) |
| C. Thin client | This machine should consume a remote hosted brain only | [Route C](#route-c-thin-client-end-to-end) |
| D. Shared group or production brain | Family, household, team, company, or any install exposed to more than one client | [Route D](#route-d-shared-group-or-production-brain-end-to-end) |
| E. Advanced topology modifier | Split-engine/worktree, mounted/cross-team brains, or security-driven isolation | [Route E](#route-e-advanced-topology-modifiers) |

Before choosing a route, separate the operating model from the deployment
topology. The branchable decision trees live in
[`architecture/topologies.md#operating-model-decision-tree`](architecture/topologies.md#operating-model-decision-tree)
and
[`architecture/topologies.md#deployment-topology-decision-tree`](architecture/topologies.md#deployment-topology-decision-tree).

Two concepts matter throughout:

- A **brain** is the database. See
  [`architecture/brains-and-sources.md`](architecture/brains-and-sources.md).
- A **source** is a named repo of content inside a brain. One brain can hold
  many sources.

## Route A. Local personal brain, end to end

Use this for the first install and for a local coding-agent memory.

1. Install the CLI with [Install GBrain](#install-gbrain).
2. Initialize the local database with [Local install](#local-install).
3. Pick a retrieval cost/recall posture in [Choose search mode](#choose-search-mode).
4. Configure model provider keys only if you need semantic search, reranking,
   `think`, or maintenance flows. See
   [Configure providers and keys](#configure-providers-and-keys).
5. Create or choose the Markdown brain repo described in
   [Brain repo and sources](#brain-repo-and-sources).
6. Load content and keep it fresh with
   [Import, sync, and operate](#import-sync-and-operate).
7. Connect the local agent over stdio MCP with
   [Connect an agent](#connect-an-agent).
8. Prove the install with [Verify](#verify).

Minimum command shape:

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install -g github:garrytan/gbrain
gbrain --version
gbrain init --pglite
gbrain doctor --json
gbrain search modes
gbrain import ~/brain --no-embed
gbrain search "<known term from your brain>"
```

After provider keys are configured, add embeddings:

```bash
gbrain embed --stale
gbrain query "key themes across these documents?"
```

If you are wiring Claude Code or Codex on the same machine, add:

```bash
claude mcp add gbrain -- gbrain serve
codex mcp add gbrain -- gbrain serve
```

## Route B. Personal multi-source brain, end to end

Use this when one person owns the brain, but the brain spans several repos,
domains, or work areas.

1. Complete [Route A](#route-a-local-personal-brain-end-to-end) through local
   initialization.
2. Keep one database unless the data owner, lifecycle, or access policy changes.
3. Add each repo/domain as a source in
   [Brain repo and sources](#brain-repo-and-sources).
4. Add `.gbrain-source` in source checkouts that should default to a specific
   source.
5. Sync and verify each source independently with
   [Import, sync, and operate](#import-sync-and-operate) and [Verify](#verify).

Minimum source-routing shape:

```bash
gbrain sources add notes --path ~/brain-notes
gbrain sources add work --path ~/work-brain
gbrain sync --repo ~/brain-notes
gbrain sync --repo ~/work-brain
gbrain search "<known term>" --source notes
```

## Route C. Thin client, end to end

Use this when the brain already lives on a remote host and this machine should
only consume it. Do not run the local init, sync, embed, migrate, or serve steps
from Route A on a thin client.

1. Confirm the host operator has deployed HTTP MCP and registered an OAuth
   client. Use [mcp/DEPLOY.md](mcp/DEPLOY.md) for host-side mechanics.
2. Install the CLI with [Install GBrain](#install-gbrain) if `gbrain` is not
   already available on this machine.
3. Initialize the local config as MCP-only with
   [Thin-client branch](#thin-client-branch).
4. Verify remote health with `gbrain doctor`, `gbrain remote ping`, and
   `gbrain remote doctor` when the client has the required admin scope.
5. Let local agents call the thin-client `gbrain` CLI directly, or point their
   MCP config at the host's `/mcp` URL using [`mcp/DEPLOY.md`](mcp/DEPLOY.md)
   and the client-specific pages under [`mcp/`](mcp/). Do not configure local
   stdio MCP with `gbrain serve` on the thin client.

Client-side command shape:

```bash
gbrain init --mcp-only \
  --issuer-url https://brain-host.example.com \
  --mcp-url https://brain-host.example.com/mcp \
  --oauth-client-id <id> \
  --oauth-client-secret <secret>
gbrain doctor
gbrain remote ping
```

## Route D. Shared group or production brain, end to end

Use this for a family brain, household brain, team brain, company brain, or any
install exposed to more than one client. This route starts with design choices,
not local commands.

1. Choose the operating model and deployment topology in
   [Production and shared-brain branch](#production-and-shared-brain-branch).
2. Choose Postgres or Supabase for shared, multi-machine, or remote HTTP use.
3. Define the brain repo and source layout before importing data. See
   [Brain repo and sources](#brain-repo-and-sources) and
   [`architecture/brain-repo-layout.md`](architecture/brain-repo-layout.md).
4. Configure provider keys and base URLs with
   [Configure providers and keys](#configure-providers-and-keys).
5. Expose MCP deliberately and scope clients before handoff. See
   [Production and shared-brain branch](#production-and-shared-brain-branch)
   and [`mcp/DEPLOY.md`](mcp/DEPLOY.md).
6. Back up the Markdown repos, database, config, OAuth inventory, and routing
   files, then prove restore.
7. Verify production health and remote clients with the checklist in
   [Production and shared-brain branch](#production-and-shared-brain-branch).

Do not hand a production/shared brain to agents until the chosen sync path,
OAuth scope model, backup/restore path, and remote MCP smoke test are proven.

## Route E. Advanced topology modifiers

These are modifiers on top of Routes A-D, not replacements for choosing an
operating model:

- Split-engine/worktree: separate local homes or MCP aliases for per-worktree
  code brains plus a shared artifact brain. Start with
  [`architecture/topologies.md#deployment-topology-decision-tree`](architecture/topologies.md#deployment-topology-decision-tree).
- Mounted/cross-team brains: add another governed brain beside the host brain.
  Start with
  [`architecture/topologies.md#topology-mounted-cross-team-brains`](architecture/topologies.md#topology-mounted-cross-team-brains).
- Security-driven isolation: choose thin client, split homes, source scoping, or
  mounted brains because of agent isolation, cloud-client exposure, or data
  boundary requirements. Start with
  [`architecture/topologies.md#topology-modifier-security-driven-isolation`](architecture/topologies.md#topology-modifier-security-driven-isolation).

## Install GBrain

GBrain is a Bun and TypeScript CLI.

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install -g github:garrytan/gbrain
gbrain --version
```

If `bun install -g` aborts, or `gbrain doctor` later reports
`schema_version: 0`, the global install may have skipped the postinstall
migration hook. Run:

```bash
gbrain apply-migrations --yes
```

If that still fails, use the deterministic source install:

```bash
git clone https://github.com/garrytan/gbrain.git ~/gbrain
cd ~/gbrain
bun install
bun link
```

## Configure providers and keys

GBrain can run keyword search without embeddings, but semantic search,
reranking, `gbrain think`, and maintenance flows need model providers.

Common env vars:

```bash
export ZEROENTROPY_API_KEY=ze-...      # default hosted embedding/reranker stack
export OPENAI_API_KEY=sk-...           # OpenAI embeddings and chat fallback
export VOYAGE_API_KEY=pa-...           # Voyage embeddings, useful for code-heavy brains
export ANTHROPIC_API_KEY=sk-ant-...    # optional chat/query-expansion provider
```

Provider setup is source-backed in
[`integrations/embedding-providers.md`](integrations/embedding-providers.md).
Use it for the full provider matrix, dimensions, local providers, and
enterprise options such as Azure OpenAI.

Base URL gotchas:

- Prefer provider-specific env vars where they exist:
  `OPENROUTER_BASE_URL`, `LITELLM_BASE_URL`, `OLLAMA_BASE_URL`,
  `LLAMA_SERVER_BASE_URL`, and `LLAMA_SERVER_RERANKER_BASE_URL`.
- Persistent GBrain overrides use config keys under
  `provider_base_urls.<provider-id>`, for example
  `provider_base_urls.dashscope` or
  `provider_base_urls.llama-server-reranker`.
- Do not assume a generic `OPENAI_BASE_URL` retargets every provider. Use the
  provider recipe and the docs above.
- Azure OpenAI needs `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, and
  `AZURE_OPENAI_DEPLOYMENT`.

## Local install

Use this for a solo machine, a local coding-agent memory, or a first install.

```bash
gbrain init --pglite
gbrain doctor --json
```

`gbrain init` defaults to PGLite. It suggests Postgres or Supabase for large
brains, multi-machine use, or shared deployments.

To initialize against Supabase or Postgres instead:

```bash
gbrain init --supabase
```

Use a namespaced database URL when you deliberately point GBrain at Postgres:

```bash
export GBRAIN_DATABASE_URL='postgresql://...'
```

GBrain ignores a `DATABASE_URL` that Bun auto-loaded from the current
checkout's `.env` if it looks like it belongs to that project. This protects
you from accidentally migrating an unrelated app database. Set
`GBRAIN_DATABASE_URL` for deliberate overrides.

## Choose search mode

Search mode controls how much retrieved context GBrain sends downstream and
which search features are enabled. Humans should choose it deliberately.
Agents must follow the stop-and-ask protocol in
[`../INSTALL_FOR_AGENTS.md#step-35-confirm-search-mode-with-the-user-do-not-skip`](../INSTALL_FOR_AGENTS.md#step-35-confirm-search-mode-with-the-user-do-not-skip).
For day-to-day command selection after install, use
[`guides/mode-selection.md`](guides/mode-selection.md). It separates raw
retrieval, synthesis, maintenance, and push-based context.

| Mode | Best fit | Shape |
|---|---|---|
| `conservative` | Haiku-class subagents, high-volume loops, cost-sensitive setups | Tight 4K budget, no LLM expansion, 10 chunks. |
| `balanced` | Most Sonnet-tier setups | 12K budget, no expansion, 25 chunks. |
| `tokenmax` | Frontier-model workflows where recall matters more than spend | No budget cap, LLM expansion on, 50 chunks. |

Cost depends on both GBrain mode and the downstream model:

| Mode / downstream model | Haiku 4.5 at $1/M | Sonnet 4.6 at $3/M | Opus 4.7 at $5/M |
|---|---:|---:|---:|
| `conservative` | $40/mo | $120/mo | $200/mo |
| `balanced` | $100/mo | $300/mo | $500/mo |
| `tokenmax` | $200/mo | $600/mo | $1,000/mo |

Those anchors assume 10K queries per month and scale linearly. Cache hits can
lower real spend, but mode choice still matters.

Inspect and change the mode:

```bash
gbrain search modes
gbrain config set search.mode balanced
```

## Brain repo and sources

Your Markdown files are separate from the GBrain tool repository. Keep them in
a normal Git repo that you can back up and review.

The central layout guide is
[`architecture/brain-repo-layout.md`](architecture/brain-repo-layout.md). Use
that for editable files, generated/managed surfaces, schema-pack expectations,
and backup implications.

Recommended starter shape for a personal brain:

```text
brain/
  README.md
  RESOLVER.md
  people/
  companies/
  projects/
  notes/
  sources/
  inbox/
  archive/
```

Use sources when one database should hold several repos or domains:

```bash
gbrain sources add notes --path ~/brain-notes
gbrain sources add work --path ~/work-brain
```

Source routing keeps slugs scoped per repo. Inside a source checkout, a
`.gbrain-source` file can pin commands to that source. Use a separate brain
when the data owner, lifecycle, or access policy changes.

For shared/team/company layouts, read:

- [`architecture/topologies.md`](architecture/topologies.md)
- [`architecture/brain-repo-layout.md`](architecture/brain-repo-layout.md)
- [`architecture/brains-and-sources.md`](architecture/brains-and-sources.md)
- [`tutorials/company-brain.md`](tutorials/company-brain.md)

Obsidian-style imports are supported, but "brain repo" and "source" are the
GBrain terms used in these docs.

## Import, sync, and operate

For a folder of existing Markdown:

```bash
gbrain import ~/brain --no-embed
gbrain embed --stale
gbrain query "key themes across these documents?"
```

For an ongoing brain repo, keep sync and embedding chained:

```bash
gbrain sync --repo ~/brain && gbrain embed --stale
```

For near-real-time local operation:

```bash
gbrain sync --watch --repo ~/brain
```

`--watch` polls. It is not a filesystem watcher and exits after repeated
failures, so production use should pair it with a scheduler or process
manager. The full sync guide is [`guides/live-sync.md`](guides/live-sync.md).

Maintenance commands:

```bash
gbrain dream
gbrain autopilot --install
gbrain doctor --remediation-plan --json
```

`gbrain dream` and autopilot run maintenance, extraction, synthesis, and
consolidation flows. `doctor --remediation-plan` previews fix work before
you let GBrain apply it.

To choose between `gbrain search`, `gbrain think`, maintenance cycles, and
push-context channels such as `volunteer_context` or `gbrain watch`, read
[`guides/mode-selection.md`](guides/mode-selection.md).

## Connect an agent

For a local coding agent on the same machine:

```bash
claude mcp add gbrain -- gbrain serve
codex mcp add gbrain -- gbrain serve
```

This uses stdio MCP. It needs no token, no tunnel, and no HTTP server.
Do not use this path on a thin-client install; thin-client homes have no local
database and refuse `serve`.

For an agent that connects to a remote brain with a bearer token:

```bash
gbrain connect https://your-host/mcp --token gbrain_xxx --install
gbrain connect https://your-host/mcp --token gbrain_xxx --agent codex --install
```

For OAuth remote clients, use [`mcp/DEPLOY.md`](mcp/DEPLOY.md) and the
client-specific pages under [`mcp/`](mcp/) instead of the local stdio command.

Full walkthrough:
[`tutorials/connect-coding-agent.md`](tutorials/connect-coding-agent.md).
HTTP MCP deployment and OAuth setup live in
[`mcp/DEPLOY.md`](mcp/DEPLOY.md).

## Thin-client branch

Use thin-client mode when this machine should consume a hosted brain without
creating a local database.

```bash
gbrain init --mcp-only \
  --issuer-url https://brain-host.example.com \
  --mcp-url https://brain-host.example.com/mcp \
  --oauth-client-id <id> \
  --oauth-client-secret <secret>
```

Thin-client installs refuse DB-bound commands such as local sync, embed,
migrate, and serve. `gbrain doctor` runs remote-MCP checks instead. See
[`architecture/topologies.md`](architecture/topologies.md).

Agents running on the thin-client machine can either call `gbrain search`,
`gbrain query`, and other MCP-eligible CLI commands directly, or connect their
own MCP client to the remote host's `/mcp` endpoint. They should not launch a
local `gbrain serve` process from the thin-client home.

## Production and shared-brain branch

Use this branch for a family brain, household brain, team brain, company
brain, or any install exposed to more than one client.

Keep this path centralized here. Use detail docs for setup mechanics, but do not
make operators assemble production safety from scattered snippets.

### 1. Choose the production shape

- Pick the operating model first: solo, personal multi-source, shared group,
  single-agent shared mode, or auth-scoped shared mode. See
  [`architecture/topologies.md#operating-model-decision-tree`](architecture/topologies.md#operating-model-decision-tree).
- Pick the deployment topology second: local/default, remote/thin client,
  split-engine/worktree, mounted/cross-team brains, or security-driven
  isolation. See
  [`architecture/topologies.md#deployment-topology-decision-tree`](architecture/topologies.md#deployment-topology-decision-tree).
- Use Postgres or Supabase for shared, multi-machine, or remote HTTP
  operation. PGLite is the local/default path and is best treated as
  single-machine.
- Decide the Brain Repo Layout for each source before importing data. See
  [`architecture/brain-repo-layout.md`](architecture/brain-repo-layout.md).
- Decide whether the shared unit is one source with folder conventions, many
  sources with OAuth scoping, or multiple mounted brains. See
  [`architecture/brains-and-sources.md`](architecture/brains-and-sources.md)
  and [`tutorials/company-brain.md`](tutorials/company-brain.md).

### 2. Choose production modes

Before wiring clients, choose the mode for each job:

- Use `gbrain search` for read-only agent context by default.
- Use `gbrain think` only where synthesized prose, citations, and gap analysis
  are required.
- Schedule `gbrain dream` or autopilot only after the operator approves
  cadence, provider keys, and cost boundaries.
- Use retrieval reflex or `volunteer_context` for agent push context. Use
  `gbrain watch` for transcript streams, and prefer Postgres when it must run
  concurrently with MCP serving.
- Choose `conservative`, `balanced`, or `tokenmax` based on downstream model
  tier, query volume, and recall tolerance.
- Choose spend posture separately from search mode. `spend.posture=tokenmax`
  makes embedding cost gates informational; `gated` remains the default. See
  [`operations/spend-controls.md`](operations/spend-controls.md).
- For large embed backfills or busy transaction-mode poolers, opt in to pacing
  per run with `gbrain embed --stale --pace` or for the current process with
  `GBRAIN_PACE_MODE=balanced`. v0.42.49.0 also defines persistent
  `pace.mode`; in current strict `config set` builds, persist it with
  `gbrain config set pace.mode balanced --force` until the allowlist catches up.
- Use `gbrain advisor` after install or upgrade for a read-only ranked list of
  high-leverage actions. Expose it to thin clients only when
  `mcp.publish_advisor` is deliberately enabled.

The central decision guide is
[`guides/mode-selection.md`](guides/mode-selection.md).

### 3. Expose MCP deliberately

- Use local stdio MCP for agents on the same machine:
  `claude mcp add gbrain -- gbrain serve` or
  `codex mcp add gbrain -- gbrain serve`.
- Use `gbrain serve --http` only when a remote client, cloud connector, shared
  user, or thin client needs network access.
- Set `--public-url` to the issuer URL clients actually use. OAuth discovery
  must match the external URL.
- If the server must accept non-loopback connections, bind explicitly with
  `--bind`. Do not assume a tunnel can reach a loopback-only server.
- Keep Dynamic Client Registration off unless you have a reviewed reason to
  enable it.
- For browser or cloud MCP clients, configure the CORS allowlist and reverse
  proxy trust deliberately. See [`SECURITY.md`](../SECURITY.md).
- Agent-specific setup lives in [`mcp/DEPLOY.md`](mcp/DEPLOY.md),
  [`mcp/CODEX.md`](mcp/CODEX.md), [`mcp/CLAUDE_CODE.md`](mcp/CLAUDE_CODE.md),
  [`mcp/CHATGPT.md`](mcp/CHATGPT.md), and
  [`../INSTALL_FOR_AGENTS.md#mcp-auth-and-remote-operation`](../INSTALL_FOR_AGENTS.md#mcp-auth-and-remote-operation).

### 4. Scope clients before handing them to agents

- Prefer OAuth clients with explicit scopes over legacy bearer tokens.
- Use `read` for search, query, get, list, and graph traversal.
- Add `write` only for clients that should write pages, links, or timeline
  entries.
- Add `admin` only for clients that must manage clients, run remote doctor, or
  submit admin-scoped work.
- For team or company brains, use source-scoped clients when one agent should
  write to one source but read a curated federated set.
- Remote agents cannot bypass `localOnly` or protected-job refusals. If a tool
  is refused over MCP, switch to a trusted local host operation only when the
  operator approves that path.
- Smoke-test remote clients before handoff. `gbrain connect ... --install`
  performs a token probe for Claude Code and Codex; connector-style clients
  should use the setup checks in `docs/mcp/`.

### 5. Configure providers and secrets

- Keep provider keys in env vars or `~/.gbrain/config.json` with 0600
  permissions. Do not paste long-lived tokens into shared agent config,
  issue comments, docs, or transcripts.
- Prefer provider-specific base URL env vars:
  `OPENROUTER_BASE_URL`, `LITELLM_BASE_URL`, `OLLAMA_BASE_URL`,
  `LLAMA_SERVER_BASE_URL`, and `LLAMA_SERVER_RERANKER_BASE_URL`.
- Persistent overrides use `provider_base_urls.<provider-id>`, for example
  `provider_base_urls.dashscope`.
- Do not assume `OPENAI_BASE_URL` retargets every provider.
- Azure OpenAI needs `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, and
  `AZURE_OPENAI_DEPLOYMENT`.
- Smoke-test provider configuration with `gbrain providers test`, `gbrain
  models`, or `gbrain models doctor` before scheduling maintenance.
- Use [`integrations/embedding-providers.md`](integrations/embedding-providers.md)
  for dimensions, provider constraints, and migration paths.

### 6. Back up and prove restore

Back up every layer that would be painful to rebuild:

1. Markdown brain repos for every source.
2. The database: PGLite file, Postgres dump, or Supabase backup.
3. `~/.gbrain/config.json`, OAuth client records, bearer-token inventory, and
   provider configuration.
4. Schema packs, `gbrain.yml`, `.gbrain-source`, `.gbrain-mount`, and source
   routing dotfiles.

A source Git remote is not a complete backup, but repo-backed sources can now
be hardened for source durability. For sources added from a GitHub URL with a
PAT, or existing sources audited with `gbrain sources harden <source-id>`,
GBrain installs local pull/push safety rails and a committed
`scripts/brain-commit-push.sh` helper. Keep token storage out of the repo and
still back up the database.

Do a restore test on a separate machine, user account, or home directory. A
backup that has not been restored is only an archive.

### 7. Keep sync and maintenance observable

- Always chain sync and embeddings for repo-backed brains:
  `gbrain sync --repo /path/to/brain && gbrain embed --stale`.
- If a large embed backlog or sync competes with a busy transaction-mode
  pooler, pace the work instead of relying on external pause/resume scripts:
  `gbrain embed --stale --pace` or `GBRAIN_PACE_MODE=balanced`. For persistent
  pacing, v0.42.49.0 defines `pace.mode`; in current strict `config set`
  builds, persist it with `gbrain config set pace.mode balanced --force`.
- `gbrain sync --watch` is a polling loop, not a filesystem watcher. It exits
  after repeated failures. Pair it with a scheduler or process manager.
- For Supabase, use the Transaction pooler for normal reads when appropriate,
  but give sync, migrations, DDL, and bulk work a direct/session-capable path.
- On IPv4-only hosts, set `GBRAIN_DIRECT_DATABASE_URL` to the Supabase Session
  pooler URL, or enable Supabase's IPv4 add-on.
- If reads work but sync imports very few pages, suspect the direct connection
  first. The detailed runbook is [`guides/live-sync.md`](guides/live-sync.md).
- On v0.42.51.0 and newer, `doctor` distinguishes an actively running sync
  from a truly stale one. Treat a live sync lock as progress to observe, not as
  a reason to break the lock.
- Malformed sync checkpoints are repaired and structurally constrained by
  upgrade migrations. If sync still appears wedged after upgrade, use `doctor`
  and the live-sync runbook before reaching for `--force-break-lock`.
- Review `gbrain doctor --remediation-plan --json` before running automated
  remediation.

### 8. Verify production health

Run after deploy and after upgrades:

```bash
gbrain --version
gbrain doctor --json
gbrain models
gbrain models doctor
gbrain stats
gbrain search modes
```

For synced repos, prove the end-to-end path:

1. Edit a Markdown page in the brain repo.
2. Let the production sync path run.
3. Search for text from the edit.
4. Confirm the new text appears, not the old version.

For remote clients:

- Verify OAuth discovery and token exchange.
- Verify a read call such as `search` or `get_page`.
- Verify a write call only for clients that should have `write`.
- Run thin-client checks with `gbrain doctor`, `gbrain remote ping`, and
  `gbrain remote doctor` on mcp-only clients that have the required scopes.

Use [`GBRAIN_VERIFY.md`](GBRAIN_VERIFY.md) for the full install verification
runbook.

### 9. Failure-mode checklist

| Symptom | First check |
|---|---|
| Remote client cannot connect | `--public-url`, bind address, tunnel/proxy routing, OAuth issuer URL, and token validity. |
| Browser connector fails before auth | CORS allowlist and redirect URI registration. |
| Client has too much access | OAuth scopes, source-scoped client settings, and old bearer tokens. |
| Reads work but writes fail | Missing `write` scope, source grant mismatch, or `localOnly` operation. |
| Thin-client commands return empty local results | Confirm `remote_mcp` config and rerun thin-client doctor; mcp-only clients should not open a local DB. |
| Search returns stale text | Live-sync path failed; edit/search verification is the deciding proof. |
| Page count is far below file count | Direct/session DB path is unreachable or sync is skipping files. |
| Embeddings are missing | Provider key/dimensions mismatch or `gbrain embed --stale` is not running after sync. |
| Search costs are higher than expected | Search mode is too broad for the downstream model or push context is overused. Review [`guides/mode-selection.md`](guides/mode-selection.md). |
| Embed backfill starves other jobs | Enable pacing with `gbrain embed --stale --pace` or `GBRAIN_PACE_MODE`; for persistent `pace.mode`, use `gbrain config set pace.mode balanced --force` until the allowlist catches up. |
| Sync looks stale during a long import | Run `gbrain doctor --json`; v0.42.51.0 reports live sync locks as active instead of stale. Break locks only when the holder is dead. |
| Brain repo writes stay local-only | Harden repo-backed sources with `gbrain sources harden <source-id>` or `gbrain sources harden --all`, then use the committed `scripts/brain-commit-push.sh` helper. |
| Admin dashboard or logs show unexpected clients | Revoke the client, rotate affected secrets, and review DCR, CORS, and proxy exposure. |

## Upgrade

```bash
gbrain upgrade
gbrain doctor --json
```

`gbrain upgrade` applies binary updates, schema migrations, and post-upgrade
prompts. It is TTY-oriented. Non-TTY upgrades skip prompts with informational
stderr lines, so production automation should review upgrade output.

If you only need schema recovery after a broken global install:

```bash
gbrain apply-migrations --yes
```

After an upgrade, re-check:

- `gbrain --version`
- `gbrain doctor --json`
- `gbrain search modes`
- provider/model checks with `gbrain models` and `gbrain models doctor`
- spend-control posture and any pacing config if this install runs large embed
  backfills or syncs
- sync freshness and checkpoint health with `gbrain doctor --json` after
  v0.42.51.0+ upgrades
- live sync if this install owns a brain repo
- brain repo durability hardening if this install owns source Git repos
- MCP connectivity if this install serves agents

## Verify

Minimum local verification:

```bash
gbrain doctor --json
gbrain models
gbrain models doctor
gbrain stats
gbrain search "<known term>"
```

For a synced repo, prove that sync works, not just that it ran:

1. Edit a Markdown file in the brain repo.
2. Let the sync path run.
3. Search for text from the edit.
4. Confirm the updated text appears.

Use [`GBRAIN_VERIFY.md`](GBRAIN_VERIFY.md) for the full runbook.

## Common failure modes

| Symptom | Likely cause | Next step |
|---|---|---|
| `gbrain` command not found | Bun bin path not in the shell | Add `$HOME/.bun/bin` to `PATH` or restart the shell. |
| `schema_version: 0` | Global postinstall hook did not run | Run `gbrain apply-migrations --yes`; fall back to source install if needed. |
| Semantic search returns little or nothing | Embeddings missing or provider misconfigured | Run `gbrain doctor --json`, then `gbrain embed --stale` after fixing the provider. |
| Keyword search works but `query` is weak | Embeddings or reranker are stale/missing | Check provider keys, dimensions, and `gbrain stats`. |
| Sync says it ran but page count is low | Direct/session DB path unreachable, often on IPv4-only Supabase hosts | Set `GBRAIN_DIRECT_DATABASE_URL` to the Session pooler or enable IPv4. |
| `sync --force-break-lock` says no lock was held | No active sync lock existed | Use `gbrain doctor --json` and the live-sync runbook to inspect the actual stale or wedged condition. |
| Remote agent cannot connect | HTTP server bound to loopback or issuer URL mismatch | Set `--public-url`; use `--bind` only when remote access is intended. |
| Token works for too much | Client has broad scopes or legacy bearer access | Register a scoped OAuth client and revoke old tokens. |
| Local checkout's `.env` points GBrain at the wrong DB | Generic `DATABASE_URL` belongs to another app | Use `GBRAIN_DATABASE_URL` for deliberate GBrain DB overrides. |
| Large embed jobs wedge queue progress | Unpaced backfill on a busy pooler | Use `gbrain embed --stale --pace` or `GBRAIN_PACE_MODE`; for persistent `pace.mode`, use `gbrain config set pace.mode balanced --force` until the allowlist catches up. |
| Brain repo changes do not reach GitHub | Source durability not hardened or push helper not used | Run `gbrain sources harden <source-id>` or `gbrain sources harden --all` for repo-backed sources and verify push access. |

## Reference map

- [`architecture/topologies.md`](architecture/topologies.md): operating model
  and deployment topology decision trees.
- [`architecture/brain-repo-layout.md`](architecture/brain-repo-layout.md):
  editable Markdown layout, managed surfaces, schema packs, and backups.
- [`architecture/brains-and-sources.md`](architecture/brains-and-sources.md):
  database vs source routing.
- [`integrations/embedding-providers.md`](integrations/embedding-providers.md):
  provider setup, dimensions, and base URL overrides.
- [`guides/live-sync.md`](guides/live-sync.md): sync, embed, Supabase poolers,
  and verification.
- [`guides/search-modes.md`](guides/search-modes.md): command-level lookup
  choices.
- [`guides/mode-selection.md`](guides/mode-selection.md): when to use
  retrieval, synthesis, maintenance, and push-based context commands.
- [`operations/spend-controls.md`](operations/spend-controls.md): embedding
  cost gates, `spend.posture`, and off/unlimited controls.
- [`mcp/DEPLOY.md`](mcp/DEPLOY.md): HTTP MCP, OAuth clients, scopes, and
  remote deployment.
- [`GBRAIN_VERIFY.md`](GBRAIN_VERIFY.md): install verification runbook.
