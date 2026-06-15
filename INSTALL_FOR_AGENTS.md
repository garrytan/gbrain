# GBrain agent installation and operation guide

Read this entire file, then follow the branch that matches the user's setup.
Ask the user for API keys, deployment choices, and search mode when prompted.
Target for a normal local install: about 30 minutes to a working brain.

This is the canonical coding-agent protocol. Human operators use
[`docs/INSTALL.md`](docs/INSTALL.md).

Machine-readable context:

- [`llms.txt`](llms.txt) is the curated documentation map.
- [`llms-full.txt`](llms-full.txt) is the same map with core docs inlined for
  one-shot ingestion.
- [`AGENTS.md`](AGENTS.md) is the non-Claude-agent repo protocol.
- [`CLAUDE.md`](CLAUDE.md) is the Claude Code orientation and resolver.

## Agent operating map

Classify the user's operating model before choosing a deployment topology. Use
[`docs/architecture/topologies.md#operating-model-decision-tree`](docs/architecture/topologies.md#operating-model-decision-tree)
and
[`docs/architecture/topologies.md#deployment-topology-decision-tree`](docs/architecture/topologies.md#deployment-topology-decision-tree)
when the setup is not the simple local default.

| User situation | Agent path | Extra gate |
|---|---|---|
| User wants a local personal brain | Follow Steps 1 through 9. | Stop at Step 3.5 and confirm search mode. |
| User already has a human-installed brain | Read `docs/INSTALL.md`, then run only the verification and agent-wiring steps the user approves. | Do not reinitialize or migrate unless asked. |
| User wants a remote or thin-client setup | Use the [deployment-topology decision tree](docs/architecture/topologies.md#deployment-topology-decision-tree) and [`docs/mcp/DEPLOY.md`](docs/mcp/DEPLOY.md). | Confirm OAuth/scopes and remote MCP exposure before configuring clients. |
| User wants a team, family, household, or company brain | Use the [operating-model decision tree](docs/architecture/topologies.md#operating-model-decision-tree), the production branch in [`docs/INSTALL.md`](docs/INSTALL.md), and [`docs/tutorials/company-brain.md`](docs/tutorials/company-brain.md). | Confirm single-agent vs auth-scoped mode, source/brain ownership, scopes, backups, and restore plan. |
| User is upgrading an existing brain | Use [Upgrade](#upgrade). | Stop on the search-mode post-upgrade banner and ask the user. |

## Safety gates for agents

- Never invent API keys, tokens, provider URLs, or hostnames.
- Do not silently accept the search-mode default. Step 3.5 is mandatory.
- Do not turn a local-only install into remote HTTP MCP without user approval.
- Do not widen OAuth scopes, enable Dynamic Client Registration, or bind
  `gbrain serve --http` beyond loopback unless the user chose a remote setup.
- Do not install cron, `--watch`, autopilot, or recurring jobs without the
  operator confirming the cadence.
- Do not treat `gbrain doctor` success as proof that live sync works. Use the
  live-sync verification in Step 9 or `docs/GBRAIN_VERIFY.md`.

## Trust boundary

GBrain distinguishes trusted local CLI callers from untrusted agent-facing
callers:

- Local CLI calls set `OperationContext.remote = false` in `src/cli.ts`.
- MCP calls set `remote = true` in `src/mcp/server.ts`.
- Operations declare scopes in `src/core/operations.ts`.
- HTTP dispatch enforces scopes and `localOnly` before handlers run.
- Security-sensitive operations such as file upload use stricter confinement
  unless the caller is explicitly trusted local CLI.

Agent rule: do not work around `localOnly`, scope, or protected-job refusals.
They are the contract. For detail, read `AGENTS.md`, `CLAUDE.md`,
[`docs/mcp/DEPLOY.md`](docs/mcp/DEPLOY.md), and
[`docs/architecture/thin-client.md`](docs/architecture/thin-client.md).

## Step 0: If you are not Claude Code

Read `AGENTS.md` at the repo root first. It's the non-Claude-agent operating
protocol (install, read order, trust boundary, common tasks). Claude Code reads
`CLAUDE.md` automatically and can skip ahead.

If you fetched this file by URL without cloning yet, the companion files live at:
- `https://raw.githubusercontent.com/garrytan/gbrain/master/AGENTS.md` — start here
- `https://raw.githubusercontent.com/garrytan/gbrain/master/llms.txt` — full doc map
- `https://raw.githubusercontent.com/garrytan/gbrain/master/llms-full.txt` — same map, inlined
- `https://raw.githubusercontent.com/garrytan/gbrain/master/docs/INSTALL.md` — human install and operating center

## Step 1: Install GBrain

Default path (Bun is required — gbrain is a Bun + TypeScript runtime):

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install -g github:garrytan/gbrain
```

Verify: `gbrain --version` should print a version number. If `gbrain` is not found,
restart the shell or add the PATH export to the shell profile.

> **If `bun install -g` aborts or `gbrain doctor` reports `schema_version: 0`** (Bun
> occasionally blocks the top-level postinstall hook on global installs, so schema
> migrations don't run automatically), the CLI prints a recovery hint pointing at
> [#218](https://github.com/garrytan/gbrain/issues/218). Run `gbrain apply-migrations --yes`
> to recover. If that doesn't work, fall back to the deterministic install path:
>
> ```bash
> git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain
> bun install && bun link
> ```

## Step 2: API Keys

Ask the user for these. GBrain defaults to the ZeroEntropy embedding + reranker
stack. OpenAI and Voyage are supported fallbacks via
`gbrain config set embedding_model <provider:model>`.

```bash
export ZEROENTROPY_API_KEY=ze-...     # default embedding + reranker (v0.36.2.0+)
export OPENAI_API_KEY=sk-...          # fallback for vector search; also used for chat models
export ANTHROPIC_API_KEY=sk-ant-...   # optional, improves search quality via query expansion
```

Save keys to the user's shell profile or the GBrain config file plane. Do not
paste secrets into shared agent config, chat transcripts, Git commits, or issue
comments. Without any embedding provider, keyword search still works. Without
Anthropic, search works but skips query expansion.

Provider and base URL rules:

- Full provider matrix: `docs/integrations/embedding-providers.md`.
- Prefer provider-specific env vars where they exist:
  `OPENROUTER_BASE_URL`, `LITELLM_BASE_URL`, `OLLAMA_BASE_URL`,
  `LLAMA_SERVER_BASE_URL`, and `LLAMA_SERVER_RERANKER_BASE_URL`.
- Persistent overrides use `provider_base_urls.<provider-id>`, for example
  `provider_base_urls.dashscope`.
- Do not assume a generic `OPENAI_BASE_URL` retargets every provider.
- Azure OpenAI needs `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, and
  `AZURE_OPENAI_DEPLOYMENT`.

## Step 3: Create the Brain

```bash
gbrain init                           # PGLite, no server needed
gbrain doctor --json                  # verify all checks pass
```

The user's markdown files (notes, docs, brain repo) are SEPARATE from this tool repo.
Ask the user where their files are, or create a new brain repo:

```bash
mkdir -p ~/brain && cd ~/brain && git init
```

Read `docs/architecture/brain-repo-layout.md` for the Brain Repo Layout before
creating folders. Set up the editable Markdown structure inside the user's brain
repo, NOT inside the GBrain tool repo. Use `docs/GBRAIN_RECOMMENDED_SCHEMA.md`
only as the long-form design reference; the active schema pack decides the
current path/type mapping.

## Step 3.5: Confirm search mode with the user (DO NOT SKIP)

`gbrain init` auto-applied a default search mode (`tokenmax` unless your subagent
tier is Haiku-class or no OpenAI key is configured). The init output included the
cost matrix below preceded by `[AGENT]` markers. You must NOT silently accept the
default. Stop and ask the operator.

**Present this matrix verbatim:**

```
Per-query cost @ 10K queries/mo (typical single-user volume):

                  Haiku 4.5     Sonnet 4.6    Opus 4.7
                  ($1/M)        ($3/M)        ($5/M)
  conservative    $40/mo        $120/mo       $200/mo
  balanced        $100/mo       $300/mo       $500/mo
  tokenmax        $200/mo       $600/mo       $1,000/mo

(scales linearly: ×10 for 100K/mo, ÷10 for 1K. 25x corner-to-corner spread.
 Natural diagonal pairings — cheap/cheap → frontier/frontier — span ~4x.)
```

**Ask the operator (paraphrase if needed):**

> Your gbrain just installed with search mode `<auto-applied default>`. This is
> a one-time setup decision that controls retrieval payload size. Which mode
> do you want?
>
>   1) conservative — tight 4K budget, no LLM expansion, 10 chunks max.
>      Best for Haiku subagents, cost-sensitive setups, high-volume loops.
>
>   2) balanced — 12K budget, no expansion, 25 chunks. Sonnet-tier sweet spot.
>
>   3) tokenmax (recommended default — preserves v0.31.x retrieval shape) —
>      no budget, LLM expansion ON, 50 chunks. Best for Opus/frontier models.
>
> Cost depends on BOTH the mode AND the downstream model you run. See the
> matrix above for the 9-cell breakdown.

If the operator picks a non-default mode, run:
```bash
gbrain config set search.mode <mode>
```

If they pick tokenmax AND want to preserve the literal v0.31.x default
(limit=20 instead of tokenmax's 50), also run:
```bash
gbrain config set search.searchLimit 20
```

Verify the choice with `gbrain search modes` before continuing.

**Why this matters:** the cost spread between corners of the matrix is 25x.
An agent that silently accepts the default and starts running queries against
a user who didn't expect tokenmax-class context loads can rack up surprise
spend. Confirm before continuing.

## Step 4: Import and Index

```bash
gbrain import ~/brain/ --no-embed     # import markdown files
gbrain embed --stale                  # generate vector embeddings
gbrain query "key themes across these documents?"
```

## Step 4.5: Wire the Knowledge Graph

If the user already had a brain repo (Step 3 imported existing markdown), backfill
the typed-link graph and structured timeline. This populates the `links` and
`timeline_entries` tables that future writes will maintain automatically.

```bash
gbrain extract links --source db --dry-run | head -20    # preview
gbrain extract links --source db                         # commit
gbrain extract timeline --source db                      # dated events
gbrain stats                                             # verify links > 0
```

For brand-new empty brains, skip this step — auto-link populates the graph as the
agent writes pages going forward. There is nothing to backfill yet.

After this step:
- `gbrain graph-query <slug> --depth 2` works (relationship traversal)
- Search ranks well-connected entities higher (backlink boost)
- Every future `put_page` auto-creates typed links and reconciles stale ones

If a user has a very large brain (>10K pages), `extract --source db` is idempotent
and supports `--since YYYY-MM-DD` for incremental runs.

### Obsidian-style bare wikilinks (opt-in)

If the user imported an Obsidian or Notion vault that uses **bare** `[[note-name]]`
wikilinks — where `[[struktura]]` written in one folder means the page that lives
at `projects/struktura.md` in another — GBrain does NOT connect those by default.
Out of the box it only resolves path-qualified refs like `[[projects/struktura]]`,
so a vault full of bare links shows up as a thin, broken graph. Turn on basename
resolution so the cross-folder links connect:

```bash
gbrain config set link_resolution.global_basename true
gbrain extract links --source db          # re-run so the new edges land
```

`gbrain doctor` surfaces a `link_resolution_opportunity` hint with the exact count
("47 of 60 bare wikilinks would resolve") so you know whether it's worth enabling
before you flip it. When a bare name matches more than one page (`[[struktura]]` →
both `projects/struktura` and `archive/struktura`), GBrain emits one edge to each
rather than guessing a winner — review and prune the duplicates with
`gbrain graph-query <slug>`. The mode is also honored on the filesystem-walk path
(`gbrain extract links` with no `--source db`) and by auto-link on every future
`put_page`.

## Step 5: Load Skills

If you're running an agent platform (OpenClaw, Hermes, or any repo with a workspace),
scaffold the bundled skills into it:

```bash
cd /path/to/agent/workspace
gbrain skillpack scaffold --all       # copy bundled skills + RESOLVER.md
```

Scaffolded skills are first-class files in your repo. Edit freely; re-running scaffold
refuses to overwrite anything that exists. Use `gbrain skillpack reference <name>` to
diff against gbrain's bundle when you want upstream improvements. (The legacy
`gbrain skillpack install` managed-block model was retired in v0.36.0.0 — run
`gbrain skillpack migrate-fence` once if upgrading from an older release.)

Whether you scaffolded or not, read `skills/RESOLVER.md` (in your workspace, or the
bundled copy at `~/gbrain/skills/RESOLVER.md` when running from the cloned repo). It's
the skill dispatcher — tells you which skill to read for any task. Save this to your
memory permanently.

The three most important skills to adopt immediately:

1. **Signal detector** (`skills/signal-detector/SKILL.md`) — fire this on EVERY
   inbound message. It captures ideas and entities in parallel. The brain compounds.

2. **Brain-ops** (`skills/brain-ops/SKILL.md`) — brain-first lookup on every response.
   Check the brain before any external API call.

3. **Conventions** (`skills/conventions/quality.md`) — citation format, back-linking
   iron law, source attribution. These are non-negotiable quality rules.

## Step 6: Identity (optional)

Run the soul-audit skill to customize the agent's identity:

```
Read skills/soul-audit/SKILL.md and follow it.
```

This generates SOUL.md (agent identity), USER.md (user profile), ACCESS_POLICY.md
(who sees what), and HEARTBEAT.md (operational cadence) from the user's answers.

If skipped, minimal defaults are installed automatically.

## Step 7: Recurring Jobs

Set up using your platform's scheduler (OpenClaw cron, Railway cron, crontab), or skip the
platform glue entirely with `gbrain autopilot --install` (built-in self-maintaining daemon):

- **Live sync** (every 15 min): `gbrain sync --repo ~/brain && gbrain embed --stale`
  — or `gbrain sync --watch` for a continuous loop.
- **Auto-update** (daily): `gbrain check-update --json` (tell user, never auto-install).
- **Dream cycle** (nightly): `gbrain dream` runs the 8-phase overnight maintenance cycle.
  Entity sweep, citation fixes, memory consolidation, plus (v0.23+) overnight conversation
  synthesis and cross-session pattern detection. One cron-friendly command. This is what
  makes the brain compound. Do not skip it. See `docs/guides/cron-schedule.md` for the
  full protocol.
- **Weekly**: `gbrain doctor --json && gbrain embed --stale`

## Step 8: Integrations

Run `gbrain integrations list`. Each recipe in `~/gbrain/recipes/` is a self-contained
installer. It tells you what credentials to ask for, how to validate, and what cron
to register. Ask the user which integrations they want (email, calendar, voice, Twitter).

Verify: `gbrain integrations doctor` (after at least one is configured)

## Step 9: Verify

Read `docs/GBRAIN_VERIFY.md` and run all 7 verification checks. Check #4 (live sync
actually works) is the most important.

## MCP, auth, and remote operation

Use local stdio MCP when the agent and brain are on the same machine:

```bash
claude mcp add gbrain -- gbrain serve
codex mcp add gbrain -- gbrain serve
```

Use HTTP MCP only when the user chose a remote, shared, or cloud-client path.
Before configuring it, confirm:

- public URL and bind address;
- OAuth client type;
- scopes: `read`, `write`, `admin`, or narrower source-scoped grants;
- whether Dynamic Client Registration stays disabled;
- where the token or OAuth secret will be stored;
- which brain/source the client may read and write.

Remote setup references:

- `docs/mcp/DEPLOY.md` for HTTP MCP, OAuth 2.1, scopes, localOnly behavior, and
  remote deployment.
- `docs/mcp/CODEX.md`, `docs/mcp/CLAUDE_CODE.md`,
  `docs/mcp/CLAUDE_DESKTOP.md`, `docs/mcp/CHATGPT.md`, and
  `docs/mcp/PERPLEXITY.md` for client-specific setup.
- `docs/architecture/topologies.md` for operating-model, thin-client,
  split-engine, mounted-brain, and security-isolation decision trees.

Remote-call boundary:

- `sync_brain`, `file_upload`, `file_list`, and `file_url` are `localOnly` and
  rejected over HTTP regardless of scope.
- Protected job submissions are CLI-only. If MCP refuses a protected job, do
  not retry through another route unless the user explicitly switches to local
  CLI operation.
- `run_onboard` is remote-callable with admin scope, but protected LLM-bearing
  onboard handlers require the extra `run_protected_onboard` scope.

Thin-client verification:

```bash
gbrain doctor
gbrain remote ping
gbrain remote doctor
```

These require the scopes described in `docs/architecture/topologies.md`.

## Safe verification checklist

Use the strongest check that matches the branch:

- Local install: `gbrain --version`, `gbrain doctor --json`, `gbrain models`,
  `gbrain models doctor`, `gbrain search modes`, `gbrain stats`.
- Search mode: `gbrain search modes` after the user chooses.
- Provider setup: `gbrain models doctor` or the provider-specific test in
  `docs/integrations/embedding-providers.md`.
- Live sync: edit a brain markdown file, let sync run, then search for text
  from the edit. Do not claim live sync works from `gbrain sync` output alone.
- Remote MCP: use the client's smoke test or `gbrain connect --install`, then
  call `get_brain_identity` from the agent.
- Production/shared brain: verify OAuth scopes with a least-privilege client
  before giving the endpoint to users.

## Upgrade

If you installed via `bun install -g`:

```bash
gbrain upgrade                        # self-updates the binary, runs schema migrations,
                                      # and prints post-upgrade notes for the version range
```

If you installed via `git clone + bun link`:

```bash
cd ~/gbrain && git pull origin master && bun install
gbrain apply-migrations --yes         # apply schema migrations (idempotent)
gbrain post-upgrade                   # show migration notes for the version range
```

Then read `~/gbrain/skills/migrations/v<NEW_VERSION>.md` (and any intermediate
versions you skipped) and run any backfill or verification steps it lists. Skipping
this is how features ship in the binary but stay dormant in the user's brain.

**v0.32.3 search modes (one-time upgrade prompt):** if the user's brain was
created before v0.32.3, `gbrain post-upgrade` prints a banner including the
9-cell cost matrix (mode × downstream model) preceded by `[AGENT]` markers.
**Do NOT silently move past the banner.** Present the matrix to the operator
verbatim, ask which mode they want (recommended default: `tokenmax` to preserve
v0.31.x retrieval shape), then run `gbrain config set search.mode <mode>`. See
Step 3.5 above for the full ask-the-user protocol — the upgrade path uses the
same matrix and same default.

For v0.12.0+ specifically: if your brain was created before v0.12.0, run
`gbrain extract links --source db && gbrain extract timeline --source db` to
backfill the new graph layer (see Step 4.5 above).

For v0.12.2+ specifically: if your brain is Postgres- or Supabase-backed and
predates v0.12.2, the `v0_12_2` migration runs `gbrain repair-jsonb`
automatically during `gbrain post-upgrade` to fix the double-encoded JSONB
columns. PGLite brains no-op. If wiki-style imports were truncated by the old
`splitBody` bug, run `gbrain sync --full` after upgrading to rebuild
`compiled_truth` from source markdown.

## v0.42.0+ onboard surface (NEW)

`gbrain onboard` is the activation surface gbrain did not have before.
Once your brain has any content, run `gbrain onboard --check --json` to
see structured recommendations across 5 brain-health axes (orphans,
stale embeddings, entity link coverage, timeline coverage, takes count).

**On first connect (after `gbrain init`):**
```bash
gbrain onboard --check --json
```
The JSON envelope (`schema_version: 1`) carries `recommendations[]` with
`apply_policy` per item: `auto_apply` (safe to run unattended),
`prompt_required` (needs explicit user consent), or `manual_only`
(LLM-bearing, user must run themselves).

**After every `gbrain upgrade`:**
```bash
gbrain onboard --check --json
```
New versions may surface new opportunities. The post-upgrade banner
nudges the user when it runs, but agents should re-probe as a hygiene
step regardless.

**Unattended remediation (cron / autopilot):**
```bash
gbrain onboard --auto --max-usd 5
```
Refuses without `--max-usd N`. Runs auto-eligible items only. The
autopilot daemon also consults onboard recommendations on its tick — no
explicit agent action needed for the autonomous path.

**Remote / federated brain installs (MCP):**
The `run_onboard` MCP op (admin scope) lets thin-client agents probe
brain health + drive remediation over OAuth-authenticated MCP. Protected
LLM-bearing handlers (synthesize, patterns, consolidate, takes-bootstrap,
contextual_reindex_per_chunk) require the additional `run_protected_onboard`
scope — admin alone is insufficient. The MCP op returns
`skipped_missing_scope[]` listing what would have run with the right
grants.

**Privacy + consent gates:**
- `gbrain takes extract --from-pages` sends concept/atom/lore/briefing/
  writing/originals page content to your configured chat model (default
  Anthropic Haiku). Refuses to run unless `takes.bootstrap_enabled=true`
  is set in config AND `--yes` is passed. Two-gate opt-in by design.
- Autopilot's auto-apply tier for takes-bootstrap stays `manual_only`
  until v0.42.1's eval gate (do not bypass).

**Suppress nudges in CI / scripted environments:**
```bash
export GBRAIN_NO_ONBOARD_NUDGE=1
```
Init + upgrade banners auto-skip in non-TTY too.
