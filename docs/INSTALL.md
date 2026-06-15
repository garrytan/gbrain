# Install and operate GBrain

This is the human path for installing, configuring, verifying, and operating
GBrain. Coding agents should use [`../INSTALL_FOR_AGENTS.md`](../INSTALL_FOR_AGENTS.md)
instead. That file has extra stop-and-ask gates for agent-run installs.

Current version: [`../VERSION`](../VERSION). Release history:
[`../CHANGELOG.md`](../CHANGELOG.md).

## Start with the right shape

Pick the operating model, then the deployment topology, before you run install
commands. The branchable decision trees live in
[`architecture/topologies.md#operating-model-decision-tree`](architecture/topologies.md#operating-model-decision-tree)
and
[`architecture/topologies.md#deployment-topology-decision-tree`](architecture/topologies.md#deployment-topology-decision-tree).

| If you want | Start here | Why |
|---|---|---|
| A personal brain on one machine | [Local install](#local-install) | PGLite is the zero-config default and works well for solo use. |
| A personal brain with many repos or sources | [Local install](#local-install), then [brain repo and sources](#brain-repo-and-sources) | One brain can hold many sources. Use source routing instead of creating extra databases. |
| A team, family, household, or company brain | [Production and shared-brain branch](#production-and-shared-brain-branch) | Shared use needs a single-agent vs auth-scoped choice, plus backups and a remote MCP plan when exposed. |
| A laptop or agent that should consume a remote brain only | [Thin-client branch](#thin-client-branch) | The local machine gets MCP config, not a local database. |
| Per-worktree code brains plus a shared artifact brain | [`architecture/topologies.md#deployment-topology-decision-tree`](architecture/topologies.md#deployment-topology-decision-tree) | Split-engine setups need explicit `GBRAIN_HOME` and MCP alias discipline. |
| A solo user with agent-isolation or cloud-client security needs | [`architecture/topologies.md#deployment-topology-decision-tree`](architecture/topologies.md#deployment-topology-decision-tree) | Solo ownership can still need thin-client, split-engine, or isolated homes. |

Two concepts matter throughout:

- A **brain** is the database. See
  [`architecture/brains-and-sources.md`](architecture/brains-and-sources.md).
- A **source** is a named repo of content inside a brain. One brain can hold
  many sources.

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

Recommended starting shape for a personal brain:

```text
brain/
  people/
  companies/
  meetings/
  concepts/
  decisions/
  notes/
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

## Connect an agent

For a local coding agent on the same machine:

```bash
claude mcp add gbrain -- gbrain serve
codex mcp add gbrain -- gbrain serve
```

This uses stdio MCP. It needs no token, no tunnel, and no HTTP server.

For an agent that connects to a remote brain:

```bash
gbrain connect https://your-host/mcp --token gbrain_xxx --install
gbrain connect https://your-host/mcp --token gbrain_xxx --agent codex --install
```

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

## Production and shared-brain branch

Use this branch for a family brain, household brain, team brain, company
brain, or any install exposed to more than one client.

Production checklist:

- Use Postgres or Supabase for shared or multi-machine operation.
- Decide whether the shared unit is one source with folder conventions, many
  sources with OAuth scoping, or multiple mounted brains. See
  [`architecture/topologies.md`](architecture/topologies.md),
  [`architecture/brains-and-sources.md`](architecture/brains-and-sources.md)
  and [`tutorials/company-brain.md`](tutorials/company-brain.md).
- Use `gbrain serve --http` only when you need remote MCP. Local agents should
  use stdio.
- For remote HTTP, configure OAuth clients and scopes through
  [`mcp/DEPLOY.md`](mcp/DEPLOY.md). Keep Dynamic Client Registration off unless
  you have a reviewed reason to enable it.
- Set `--public-url` to the URL clients actually use. If the server must accept
  non-loopback connections, bind explicitly with `--bind`.
- Keep secrets in env vars or `~/.gbrain/config.json` with 0600 permissions.
  Do not put long-lived tokens in shared agent config.
- Back up all three layers: the Markdown brain repos, the database, and
  `~/.gbrain/config.json` plus OAuth/client configuration.
- Test restore on a separate machine or home directory. A backup you have not
  restored is only an archive.
- Run `gbrain doctor --json`, model/provider checks, and live-sync verification
  after deploy and after upgrades.

Supabase pooler gotcha:

- Use the Transaction pooler for the main database URL when appropriate.
- Sync, migrations, DDL, and bulk work need a direct/session-capable path.
- On IPv4-only hosts, set `GBRAIN_DIRECT_DATABASE_URL` to the Supabase Session
  pooler URL, or enable Supabase's IPv4 add-on.
- If reads work but sync imports very few pages, suspect this first. The
  detailed runbook is [`guides/live-sync.md`](guides/live-sync.md).

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
- live sync if this install owns a brain repo
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
| Remote agent cannot connect | HTTP server bound to loopback or issuer URL mismatch | Set `--public-url`; use `--bind` only when remote access is intended. |
| Token works for too much | Client has broad scopes or legacy bearer access | Register a scoped OAuth client and revoke old tokens. |
| Local checkout's `.env` points GBrain at the wrong DB | Generic `DATABASE_URL` belongs to another app | Use `GBRAIN_DATABASE_URL` for deliberate GBrain DB overrides. |

## Reference map

- [`architecture/topologies.md`](architecture/topologies.md): operating model
  and deployment topology decision trees.
- [`architecture/brains-and-sources.md`](architecture/brains-and-sources.md):
  database vs source routing.
- [`integrations/embedding-providers.md`](integrations/embedding-providers.md):
  provider setup, dimensions, and base URL overrides.
- [`guides/live-sync.md`](guides/live-sync.md): sync, embed, Supabase poolers,
  and verification.
- [`guides/search-modes.md`](guides/search-modes.md): command-level lookup
  choices.
- [`mcp/DEPLOY.md`](mcp/DEPLOY.md): HTTP MCP, OAuth clients, scopes, and
  remote deployment.
- [`GBRAIN_VERIFY.md`](GBRAIN_VERIFY.md): install verification runbook.
