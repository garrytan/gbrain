# Install and operate GBrain

This guide takes a person from no installation to a working GBrain. You do not
need to understand the internal architecture before you begin. Choose the row
that describes your situation, follow that route from start to finish, and use
the linked detail only when your route asks for it.

If a coding agent is doing the installation for you, give it
[`../INSTALL_FOR_AGENTS.md`](../INSTALL_FOR_AGENTS.md). That guide follows the
same routes but adds stop-and-ask gates so an agent cannot silently choose your
cost, access, or deployment settings.

Current version: [`../VERSION`](../VERSION). Release history:
[`../CHANGELOG.md`](../CHANGELOG.md).

## Before you begin

For the first local route you need:

- a terminal on macOS or Linux; on Windows, use WSL 2 for the command journey
  on this page;
- permission to install Bun and the `gbrain` CLI for your user;
- a writable folder for Markdown notes;
- Git only if you use the source-install fallback or want to version the notes.

Before initialization, decide whether you want semantic retrieval and
synthesis now or only a local keyword-search test:

- **Semantic retrieval:** prepare an embedding provider before `gbrain init`.
  This enables meaning-based search and provider-dependent reranking.
- **Synthesis:** `gbrain think` also needs a usable chat provider. One provider
  can supply both capabilities, but embedding-only providers such as Voyage or
  ZeroEntropy do not enable synthesis by themselves.
- **Keyword-only first test:** initialize with `--no-embedding`. You can import
  and search exact words without a provider, then add one later by rebuilding
  the PGLite index with `gbrain reinit-pglite`.

Keep provider keys out of Markdown, Git, screenshots, and shared chat.

## Choose your install route

Start with the simplest route that meets your needs. You can move to a shared or
remote setup later without learning every advanced option now.

**If this is your first installation and the brain is only for you on this
computer, choose Route A.** Choose Route C only when a remote host already
exists. Choose Routes D or E only when sharing, remote access, or isolation is a
current requirement.

| Your situation | Start here | What you will have at the end |
|---|---|---|
| This is my first GBrain and it is only for me on this computer | [A. Local personal brain](#route-a-local-personal-brain-end-to-end) | A local database, searchable Markdown, and an optional connection to your coding agent |
| I own the brain, but its knowledge lives in several folders or repos | [B. Personal multi-source brain](#route-b-personal-multi-source-brain-end-to-end) | One database with separately routed sources |
| The brain already runs on another machine | [C. Thin client](#route-c-thin-client-end-to-end) | This computer can use the remote brain without creating a local database |
| A family, household, team, or company will share the brain, and an operator will manage it | [D. Shared group or production brain](#route-d-shared-group-or-production-brain-end-to-end) | A shared database with an explicit access, backup, and client model |
| My security or implementation needs require extra isolation | [E. Advanced topology modifiers](#route-e-advanced-topology-modifiers) | One of the routes above, modified with split, mounted, or isolated components |

Three terms are enough to get started:

- A **brain** is the database GBrain searches.
- A **brain repo** is the Git-backed folder of Markdown that you own and edit.
- A **source** is one named repo or content area inside a brain. A brain can
  contain several sources.

Other terms appear only when a route needs them. Bun installs and runs the
GBrain CLI. PGLite is the embedded local database. An embedding is a numeric
representation that lets GBrain find related meaning, not only matching words.
MCP is the connection an AI client uses to call GBrain. OAuth gives each remote
client an identity and permissions.

The operating model answers who uses the brain. The deployment topology answers
where its parts run. You only need these terms for Routes D and E. Their full
decision trees are in
[`architecture/topologies.md`](architecture/topologies.md).

## Route A. Local personal brain, end to end

Use this if the brain belongs to you and will run on this computer. This is the
right first route for most people.

1. Install the CLI with [Install GBrain](#install-gbrain).
2. Choose either a complete provider-backed setup or a keyword-only first test,
   then initialize the local database with [Local install](#local-install).
3. During initialization, review the recommended search mode. For a first
   install, you can accept the recommendation after reading the three options.
   You can change it later.
4. Create one sample note, import it, and search for a known phrase.
5. If you started without providers, add embeddings for meaning-based search
   and a chat-capable provider for synthesis or maintenance phases that call an
   LLM.
6. Replace the sample with your real
   [brain repo and sources](#brain-repo-and-sources).
7. Connect an agent with [Connect an agent](#connect-an-agent) if you want one
   to use the brain.
8. Finish with the [route-aware local verification](#verify). Provider probes
   apply only after you configure the corresponding providers.

The following commands use the keyword-only path so the first test does not
require an account or API key:

On Windows, install WSL 2 with a current Linux distribution, open its terminal,
and run the same commands there. Paths such as `~/gbrain-notes`, `export`, and
shell redirection below are Linux shell syntax, not native PowerShell syntax.

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install -g github:garrytan/gbrain
gbrain --version
gbrain init --pglite --no-embedding
gbrain doctor --json
gbrain search modes
sample_dir="$(mktemp -d "$HOME/gbrain-install-sample.XXXXXX")"
printf '# First note\n\nThe cedar lighthouse is the verification beacon for this guide.\n' \
  > "$sample_dir/first-note.md"
gbrain import "$sample_dir" --no-embed
gbrain search "cedar lighthouse"
```

`gbrain init` validates option names before it starts migration work. If it
reports `Unknown option`, correct the command and run it again; the rejected
invocation did not begin migrations.

Check each milestone:

- `gbrain --version` prints a version number.
- `doctor` reports an initialized PGLite brain with a non-zero schema version.
  It also reports that embeddings are not configured, which is expected on
  this route.
- `gbrain search modes` reports the mode selected during initialization. With
  no OpenAI key, the current installer normally recommends `conservative`.
- The final search returns `first-note` or the phrase `cedar lighthouse`.

If the final search returns the sample, the basic local path works. You can now
replace `~/gbrain-notes` with your own Markdown folder and repeat the import.

To start with semantic retrieval and synthesis instead, create an account with
a provider recipe that supports both embedding and chat, or configure one
provider for each capability. Provider use may incur charges. The following
example uses OpenAI; replace `replace_me` with your real key
before running it:

```bash
export OPENAI_API_KEY=replace_me
gbrain init --pglite \
  --embedding-model openai:text-embedding-3-large \
  --embedding-dimensions 1536
```

If you already completed the keyword-only path, use `reinit-pglite` instead of
changing the embedding model in config:

```bash
export OPENAI_API_KEY=replace_me
gbrain reinit-pglite \
  --embedding-model openai:text-embedding-3-large \
  --embedding-dimensions 1536
```

The reinitialization keeps the previous database at `<path>.bak` and syncs the
configured brain repo. If you have not configured a repo, import the sample
folder again. Then create embeddings and try semantic retrieval:

```bash
gbrain embed --stale
gbrain search "where is the verification beacon described?"
```

`gbrain embed --stale` may take time on a large brain. The search should find
the sample note even though the query does not repeat its exact phrase. To ask
for a written answer based on brain evidence, first confirm that a chat model
is configured, then run `gbrain think "<question>" --json` and verify that
`synthesisOk` is `true`. Exit status alone is not proof of synthesis: without a
usable chat provider, `think` can return gather-only output.
If embedding reports a provider or dimension problem, stop and use
[Configure providers and keys](#configure-providers-and-keys).

If you also want a coding agent on this computer to use the brain, add the
relevant MCP connection:

```bash
claude mcp add gbrain -- gbrain serve
codex mcp add gbrain -- gbrain serve
```

## Route B. Personal multi-source brain, end to end

Use this when one person owns the brain, but its knowledge lives in several
repos, folders, or areas of life and work. A source lets you search each area
alone without creating a separate database.

1. Complete [Route A](#route-a-local-personal-brain-end-to-end) through local
   database initialization.
2. Keep one database unless the data owner, lifecycle, or access policy changes.
3. Add each repo/domain as a source in
   [Brain repo and sources](#brain-repo-and-sources).
4. Add `.gbrain-source` in source checkouts that should default to a specific
   source.
5. If this brain existed before `v0.42.62.0`, run `gbrain extract all` once
   after upgrading so existing pages receive current source identity.
6. Sync and verify each source independently with
   [Import, sync, and operate](#import-sync-and-operate) and [Verify](#verify).

Minimum source-routing shape, using two new collision-safe sample repos:

```bash
notes_dir="$(mktemp -d "$HOME/gbrain-notes.XXXXXX")"
work_dir="$(mktemp -d "$HOME/gbrain-work.XXXXXX")"
printf '# Notes source\n\nThe cedar lighthouse belongs to the notes source.\n' \
  > "$notes_dir/first-note.md"
printf '# Work source\n\nThe amber compass belongs to the work source.\n' \
  > "$work_dir/work-note.md"

git -C "$notes_dir" init
git -C "$notes_dir" add first-note.md
git -C "$notes_dir" -c user.name="GBrain User" \
  -c user.email="gbrain-user@example.invalid" commit -m "docs: add first note"

git -C "$work_dir" init
git -C "$work_dir" add work-note.md
git -C "$work_dir" -c user.name="GBrain User" \
  -c user.email="gbrain-user@example.invalid" commit -m "docs: add work note"

gbrain sources add notes --path "$notes_dir"
gbrain sources add work --path "$work_dir"
gbrain sync --repo "$notes_dir" --source notes
gbrain sync --repo "$work_dir" --source work
gbrain search "cedar lighthouse" --source notes
gbrain search "amber compass" --source work
```

Both directories must be Git repos with committed tracked files before
registration. Replace the sample paths with existing committed repos when you
already have them. A source-specific result proves that GBrain is routing the
query to the intended content area.

## Route C. Thin client, end to end

Use this when someone already operates the brain on another machine and this
computer only needs to use it. A thin client stores connection settings, not a
second copy of the database.

1. Confirm the host operator has deployed HTTP MCP and registered an OAuth
   client. Use [mcp/DEPLOY.md](mcp/DEPLOY.md) for host-side mechanics.
2. Install the CLI with [Install GBrain](#install-gbrain) if `gbrain` is not
   already available on this machine.
3. Initialize the local config as MCP-only with
   [Thin-client branch](#thin-client-branch).
4. Run `gbrain doctor`, then call `get_brain_identity` through the connected
   MCP client as the read-only smoke test. Run `gbrain remote doctor` only
   when the client has the required admin scope.
5. Let local agents call the thin-client `gbrain` CLI directly, or point their
   MCP config at the host's `/mcp` URL using [`mcp/DEPLOY.md`](mcp/DEPLOY.md)
   and the client-specific pages under [`mcp/`](mcp/). Do not configure local
   stdio MCP with `gbrain serve` on the thin client.

Client-side command shape:

```bash
# Load GBRAIN_REMOTE_CLIENT_SECRET from your secret manager or protected
# process environment before running this block.
: "${GBRAIN_REMOTE_CLIENT_SECRET:?set GBRAIN_REMOTE_CLIENT_SECRET first}"
gbrain init --mcp-only \
  --issuer-url https://brain-host.example.com \
  --mcp-url https://brain-host.example.com/mcp \
  --oauth-client-id your_oauth_client_id_here
gbrain doctor
```

From the connected MCP client, call `get_brain_identity`. If the identity call
fails, do not initialize a local brain as a workaround. Check the host URL,
client credentials, and server-side access with the host operator. Do not use
`gbrain remote ping` as a connectivity probe: it submits an
`autopilot-cycle` that can sync, extract, embed, mutate the remote brain, and
incur provider costs.

## Route D. Shared group or production brain, end to end

Use this for a family brain, household brain, team brain, company brain, or any
installation exposed to more than one client.

This is an operator-led route. If nobody is responsible for the database,
access policy, backups, and recovery, complete Route A first and do not expose
the brain to a network yet.

Choose one of two access patterns:

- **One trusted agent or service:** the group shares the knowledge, but one
  controlled client accesses GBrain on everyone’s behalf.
- **Several people or agents:** each client receives its own OAuth identity,
  scopes, source boundaries, and optional tool or budget constraints.

The second pattern takes more setup, but it lets you revoke or narrow one client
without disrupting everyone else.

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

Do not hand a shared brain to people or agents until you have proved the chosen
sync path, client access, backup and restore path, and remote MCP connection.

## Route E. Advanced topology modifiers

These are modifiers on top of Routes A to D. They do not answer who owns or uses
the brain:

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

The final command should print a version number. If the shell cannot find
`gbrain`, restart the terminal or add `$HOME/.bun/bin` to `PATH`.

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
export ZEROENTROPY_API_KEY=replace_me
export OPENAI_API_KEY=replace_me
export VOYAGE_API_KEY=replace_me
export ANTHROPIC_API_KEY=replace_me
```

Replace a placeholder only for a provider account you actually use. A key is a
secret and may authorize paid requests. ZeroEntropy, OpenAI, and Voyage can
supply embeddings. Anthropic is used for language-model work such as synthesis;
it is not an embedding-provider choice.

Provider setup is source-backed in
[`integrations/embedding-providers.md`](integrations/embedding-providers.md).
Use it for the full provider matrix, dimensions, local providers, and
enterprise options such as Azure OpenAI.

For a first provider-backed setup, configure one embedding provider, follow its
row in the provider guide, and use the model and dimension values shown there.
If exactly one configured provider is available, interactive `gbrain init` can
select it. You can also choose explicitly. This OpenAI example requires an
OpenAI account and may create billable usage:

```bash
gbrain init --pglite \
  --embedding-model openai:text-embedding-3-large \
  --embedding-dimensions 1536
```

Providers whose models are supplied by the user, including LiteLLM and
`llama-server`, require both flags. GBrain cannot infer their vector size.

Embedding dimensions are part of the database schema. Do not use
`gbrain config set embedding_model` or
`gbrain config set embedding_dimensions` on an existing brain. Those commands
are refused because changing only the setting would leave the schema at the old
size.

To change an existing PGLite brain, use:

```bash
gbrain reinit-pglite \
  --embedding-model your_provider:your_model \
  --embedding-dimensions 1234
```

The command keeps the previous PGLite database at `<path>.bak`, recreates the
schema, and syncs the configured brain repo unless you pass `--no-sync`. For
Postgres, follow [`embedding-migrations.md`](embedding-migrations.md).

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

For a provider-backed setup, export the provider key first. Interactive
`gbrain init` chooses among providers whose required environment variables are
available. You can also pass `--embedding-model` and
`--embedding-dimensions` explicitly, as shown above.

For a deterministic keyword-only setup:

```bash
gbrain init --pglite --no-embedding
gbrain doctor --json
```

`gbrain init` defaults to PGLite. It suggests Postgres or Supabase for large
brains, multi-machine use, or shared deployments.

When initialization finishes, `doctor` should report the PGLite engine and a
non-zero schema version. On the keyword-only path, a missing embedding provider
is expected. Keep PGLite to one active GBrain process at a time. If PGLite
reports lock corruption, use `gbrain reinit-pglite`; do not delete lock files
by hand.

To initialize against Supabase or Postgres instead:

```bash
gbrain init --supabase
```

Use a namespaced database URL when you deliberately point GBrain at Postgres:

```bash
export GBRAIN_DATABASE_URL='postgresql://user:password@host:5432/database'
```

GBrain ignores a `DATABASE_URL` that Bun auto-loaded from the current
checkout's `.env` if it looks like it belongs to that project. This protects
you from accidentally migrating an unrelated app database. Set
`GBRAIN_DATABASE_URL` for deliberate overrides.

Non-interactive Postgres initialization requires an explicit `--url` or
`GBRAIN_DATABASE_URL`. Schema commands in current releases also respect a custom
PGLite `database_path`.

## Choose search mode

Search mode controls how much context GBrain returns and which retrieval
features it uses. It affects answer quality, latency, provider calls, and the
number of downstream tokens. Choose it deliberately.
Agents must follow the stop-and-ask protocol in
[`../INSTALL_FOR_AGENTS.md#step-35-confirm-search-mode-with-the-user-do-not-skip`](../INSTALL_FOR_AGENTS.md#step-35-confirm-search-mode-with-the-user-do-not-skip).
For day-to-day command selection after install, use
[`guides/mode-selection.md`](guides/mode-selection.md). It separates raw
retrieval, synthesis, maintenance, and push-based context.

| Mode | Choose it when | Current default shape |
|---|---|---|
| `conservative` | You want the smallest and cheapest context for frequent lightweight calls | 4K token budget, 10 results, no expansion or reranker |
| `balanced` | You want a moderate general-purpose starting point | 12K token budget, 25 results, reranking, graph signals, and title context |
| `tokenmax` | Missing relevant material costs more than extra latency or spend | No token cap, 50 results, expansion, reranking, graph signals, and per-chunk context |

For a first human install, read the table and accept the installer's
recommendation unless you already have a cost or recall requirement. The
recommendation is a starting point, not a permanent choice.

`gbrain init` recommends a mode from the providers and model tiers it can
detect. In current releases it normally recommends `tokenmax`, but recommends
`conservative` for a Haiku-class subagent or when no OpenAI key is configured.
Interactive installs let you choose; non-interactive installs apply the
recommendation and print an `[AGENT]` instruction to confirm it with the
operator. This recommendation is distinct from the internal `balanced`
fallback used only when `search.mode` is unset.

`gbrain init` also prints the current mode and downstream-model cost matrix. Treat
that live matrix as the source for cost estimates because model prices and mode
features change.

Inspect and change the mode:

```bash
gbrain search modes
gbrain config set search.mode balanced
```

Run `gbrain search modes` again after changing the setting. The active mode and
resolved values should reflect your choice.

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
gbrain search "known concept from these documents"
gbrain think "What are the key themes across these documents?"
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

After upgrading a multi-source brain from a release before `v0.42.62.0`, run
this once:

```bash
gbrain extract all
```

That rebuilds derived facts with the current source identity. Then search each
source separately and check `gbrain sources status`.

Maintenance commands:

```bash
gbrain dream
gbrain autopilot --install
gbrain doctor --remediation-plan --json
```

`gbrain dream` and autopilot run maintenance, extraction, synthesis, and
consolidation flows. `doctor --remediation-plan` previews fix work before
you let GBrain apply it.

Before installing the autopilot daemon, make Bun available to non-interactive
shells. On macOS with zsh, put this in `~/.zshenv`:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

The generated daemon wrapper sources `~/.zshenv`, but it does not add Bun to
`PATH`. Without this setting, the scheduled process can fail with
`env: bun: No such file or directory`.

On current `master`, the human remediation-plan output can print both "Target
unreachable" and "Brain is at target" when no autonomous step can raise the
score. Use the JSON fields as the authority. Check `target_unreachable`,
`max_reachable_score`, and `blocked` before deciding that remediation is
complete.

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
gbrain connect https://brain-host.example.com/mcp \
  --token your_legacy_bearer_token_here --install
gbrain connect https://brain-host.example.com/mcp \
  --token your_legacy_bearer_token_here --agent codex --install
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
# Load GBRAIN_REMOTE_CLIENT_SECRET from your secret manager or protected
# process environment before running this block.
: "${GBRAIN_REMOTE_CLIENT_SECRET:?set GBRAIN_REMOTE_CLIENT_SECRET first}"
gbrain init --mcp-only \
  --issuer-url https://brain-host.example.com \
  --mcp-url https://brain-host.example.com/mcp \
  --oauth-client-id your_oauth_client_id_here
```

Thin-client installs refuse DB-bound commands such as local sync, embed,
migrate, and serve. `gbrain doctor` runs remote-MCP checks instead. See
[`architecture/topologies.md`](architecture/topologies.md).

Agents running on the thin-client machine can either call `gbrain search`,
`gbrain query`, and other MCP-eligible CLI commands directly, or connect their
own MCP client to the remote host's `/mcp` endpoint. They should not launch a
local `gbrain serve` process from the thin-client home.

## Production and shared-brain branch

Use this branch for a family brain, household brain, team brain, company brain,
or any installation exposed to more than one client. Complete all nine steps
before giving clients access.

This section is for the person operating that shared service. It assumes you
can provision Postgres or Supabase, control the host and network, manage OAuth
clients, and test backups. Other users of the brain do not need to perform
these steps.

### 1. Choose the production shape

- Pick the operating model first: solo, personal multi-source, shared group,
  single-agent shared mode, or auth-scoped shared mode. See
  [`architecture/topologies.md#operating-model-decision-tree`](architecture/topologies.md#operating-model-decision-tree).
- Pick the deployment topology second: local/default, remote/thin client,
  split-engine/worktree, mounted/cross-team brains, or security-driven
  isolation. See
  [`architecture/topologies.md#deployment-topology-decision-tree`](architecture/topologies.md#deployment-topology-decision-tree).
- Use Postgres or Supabase for shared, multi-machine, or remote HTTP operation.
  Treat PGLite as a single-machine database with one active GBrain process.
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
  `GBRAIN_PACE_MODE=balanced`. Do not persist `pace.mode` with `--force`; the
  current config allowlist does not accept it as a supported persistent key.
- Use `gbrain advisor` after install or upgrade for a read-only ranked list of
  actions with the largest expected effect. Expose it to thin clients only when
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
- Keep Dynamic Client Registration off unless clients need to register
  themselves.
- `--enable-dcr` permits the browser and consent based
  `authorization_code` flow. `--enable-dcr-insecure` also permits
  `client_credentials`, which bypasses user consent. Use the insecure option
  only inside a boundary where that tradeoff is explicitly accepted.
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
- Bind agent clients more narrowly when needed:

  ```bash
  gbrain auth register-client team-agent \
    --scopes "read write agent" \
    --source team \
    --federated-read team,shared \
    --bound-tools search,get_page,put_page \
    --bound-source team \
    --bound-slug-prefixes team/ \
    --bound-max-concurrent 1 \
    --budget-usd-per-day 5
  ```

  These `bound-*` flags constrain `submit_agent`; they do not replace ordinary
  `read` and `write` scopes. Add `--redirect-uri` for an authorization-code
  client. GBrain then includes `authorization_code,refresh_token` as the grant
  types.
- Remote agents cannot bypass `localOnly` or protected-job refusals. If a tool
  is refused over MCP, switch to a trusted local host operation only when the
  operator approves that path.
- Smoke-test remote clients before handoff. Run `gbrain connect` with the
  approved connection arguments and `--install`
  performs a token probe for Claude Code and Codex; connector-style clients
  should use the setup checks in `docs/mcp/`.

### 5. Configure providers and secrets

- Keep provider keys in environment variables or the protected GBrain config.
  Do not paste long-lived tokens into shared agent config, issue comments,
  documentation, or transcripts.
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
  pooler, pace the work with `gbrain embed --stale --pace` or
  `GBRAIN_PACE_MODE=balanced`.
- `gbrain sync --watch` is a polling loop, not a filesystem watcher. It exits
  after repeated failures. Pair it with a scheduler or process manager.
- For Supabase, use the Transaction pooler for normal reads when appropriate,
  but give sync, migrations, DDL, and bulk work a direct/session-capable path.
- On IPv4-only hosts, set `GBRAIN_DIRECT_DATABASE_URL` to the Supabase Session
  pooler URL, or enable Supabase's IPv4 add-on.
- If reads work but sync imports only a few pages, check the direct connection
  first. The detailed runbook is [`guides/live-sync.md`](guides/live-sync.md).
- `gbrain doctor` distinguishes an active sync from a stale lock. Treat a live
  process as work to observe, not a lock to break.
- `gbrain sources status` shows active work per source. Use
  `gbrain status --fast` or `gbrain status --deadline-ms=<n>` when monitoring
  needs a bounded response time.
- The sync stall watchdog releases a source lock after no file progress for
  `GBRAIN_SYNC_STALL_ABORT_SECONDS` seconds, which defaults to 900. The next
  sync resumes from its checkpoint.
- Current multi-source sync preserves source identity across links, timeline
  events, webhooks, background jobs, renames, and nested source trees. If an
  upgraded brain contains older derived facts, run `gbrain extract all` once.
- Malformed sync checkpoints are repaired and structurally constrained by
  upgrade migrations. If sync still appears wedged after upgrade, use `doctor`
  and the live-sync runbook before reaching for `--force-break-lock`.
- Review `gbrain doctor --remediation-plan --json` before running automated
  remediation. If `target_unreachable` is true, resolve the entries in
  `blocked`; an empty `plan` does not mean the brain reached the target.

### 8. Verify production health

Run after deploy and after upgrades:

```bash
gbrain --version
gbrain doctor --json
gbrain models
gbrain models doctor
gbrain stats
gbrain status --fast
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
- Run `gbrain doctor` on mcp-only clients, call `get_brain_identity` through
  the connected MCP client for a read-only smoke test, and run
  `gbrain remote doctor` only for clients with the required admin scope.

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
| Sync aborts at the first checkpoint on managed Postgres | Upgrade first, rerun sync, then inspect the checkpoint and JSONB path if it still fails. |
| Search costs are higher than expected | Search mode is too broad for the downstream model or push context is overused. Review [`guides/mode-selection.md`](guides/mode-selection.md). |
| Embed backfill starves other jobs | Enable pacing with `gbrain embed --stale --pace` or `GBRAIN_PACE_MODE=balanced`. |
| Status polling hangs or is too slow | Use `gbrain status --fast` or `gbrain status --deadline-ms=<n>` and treat partial sections as an observability budget, not data loss. |
| Sync looks stale during a long import | Run `gbrain doctor --json` and `gbrain sources status --json`. Break a lock only after confirming that its process is dead. |
| Sync aborts with `stall_timeout` | Inspect the last file or provider operation, then rerun sync to resume from checkpoint. |
| Autopilot submits repeated dead jobs | Upgrade before tuning. Current releases recover stale locks from live process state and back off failed sources. |
| Brain repo writes stay local-only | Harden repo-backed sources with `gbrain sources harden <source-id>` or `gbrain sources harden --all`, then use the committed `scripts/brain-commit-push.sh` helper. |
| Admin dashboard or logs show unexpected clients | Revoke the client, rotate affected secrets, and review DCR, CORS, and proxy exposure. Confidential OAuth clients can revoke their own tokens in current releases. |

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
- spend-control posture and process-level pacing if this installation runs
  large embed backfills or syncs
- sync freshness and checkpoint health with `gbrain doctor --json`
- active per-source sync state with `gbrain status --fast` and
  `gbrain sources status --json`
- live sync if this install owns a brain repo
- brain repo durability hardening if this install owns source Git repos
- MCP connectivity if this install serves agents

Current upgrade notes that require an operator action:

- Brains created before migrations `v120`, `v121`, or `v122` should use
  `gbrain upgrade` so security, Life Chronicle, and schema migrations are
  applied together.
- Multi-source brains upgraded from before `v0.42.62.0` should run
  `gbrain extract all` once, then check `gbrain doctor --json`,
  `gbrain stats`, and a source-scoped search.
- A custom PGLite `database_path` is respected by current schema commands.
  Upgrade before diagnosing migrations against the wrong PGLite file.

## Verify

Minimum local verification for every route:

```bash
gbrain doctor --json
gbrain stats
gbrain search "known phrase from your brain"
```

After configuring embedding or chat providers, also verify their routing and
credentials:

```bash
gbrain models
gbrain models doctor
```

Do not run provider probes as a success condition for the keyword-only route.
That route intentionally has no provider credentials.

For a synced repo, confirm the content changed after sync:

1. Edit a Markdown file in the brain repo.
2. Let the sync path run.
3. Search for text from the edit.
4. Confirm the updated text appears.

Use [`GBRAIN_VERIFY.md`](GBRAIN_VERIFY.md) for the full runbook.

## Common failure modes

### PGLite fails to initialize

Read the complete error before changing the database engine. Current releases
classify common failures and print a next step:

1. **The message names a Bun virtual filesystem or `pglite.data` problem.**
   Run `bun upgrade`, open a new terminal, and retry the same GBrain command.
   If the error remains, use the source-install fallback under
   [Install GBrain](#install-gbrain) and follow the Node instruction printed by
   the error.
2. **The message names the macOS 26.3 WASM regression.** Check
   [issue #223](https://github.com/garrytan/gbrain/issues/223) for the current
   compatibility status. If you need an immediate alternative, use the
   [Postgres or Supabase route](#route-d-shared-group-or-production-brain-end-to-end)
   even when the brain is personal.
3. **The message says the PGLite store is corrupted.** Restore a known-good
   backup if you have one, or rebuild it from the Markdown brain repo with
   `gbrain reinit-pglite --embedding-model <provider:model> --embedding-dimensions <number>`.
   This command preserves the previous database as `<path>.bak`. Do not delete
   `.gbrain-lock` or `postmaster.pid`; that does not repair a damaged store.
   On a fresh install with no important data, rebuilding is normally the
   simpler path.
4. **The cause is unknown.** Run `gbrain doctor --json` and keep both its output
   and the original initialization error when opening an issue.

Retry `gbrain doctor --json` after the selected recovery. The database is usable
when doctor reports an initialized engine and a non-zero schema version. A
missing embedding provider is still expected if you deliberately chose the
keyword-only route.

| Symptom | Likely cause | Next step |
|---|---|---|
| `gbrain` command not found | Bun bin path not in the shell | Add `$HOME/.bun/bin` to `PATH` or restart the shell. |
| `schema_version: 0` | Global postinstall hook did not run | Run `gbrain apply-migrations --yes`; fall back to source install if needed. |
| Semantic search returns little or nothing | Embeddings missing or provider misconfigured | Run `gbrain doctor --json`, then `gbrain embed --stale` after fixing the provider. |
| Keyword search works but `query` is weak | Embeddings or reranker are stale/missing | Check provider keys, dimensions, and `gbrain stats`. |
| Sync says it ran but page count is low | Direct/session DB path unreachable on an IPv4-only Supabase host | Set `GBRAIN_DIRECT_DATABASE_URL` to the Session pooler or enable IPv4. |
| `sync --force-break-lock` says no lock was held | No active sync lock existed | Use `gbrain doctor --json` and the live-sync runbook to inspect the actual stale or wedged condition. |
| Remote agent cannot connect | HTTP server bound to loopback or issuer URL mismatch | Set `--public-url`; use `--bind` only when remote access is intended. |
| Token works for too much | Client has broad scopes or legacy bearer access | Register a scoped OAuth client and revoke old tokens. |
| Local checkout's `.env` points GBrain at the wrong DB | Generic `DATABASE_URL` belongs to another app | Use `GBRAIN_DATABASE_URL` for deliberate GBrain DB overrides. |
| Large embed jobs block queue progress | Unpaced backfill on a busy pooler | Use `gbrain embed --stale --pace` or `GBRAIN_PACE_MODE=balanced`. |
| PGLite reports lock corruption | More than one process opened the database, or a previous process ended uncleanly | Stop other GBrain processes and use `gbrain reinit-pglite`. Do not delete lock files manually. |
| Changing the embedding model with `config set` is refused | Embedding dimensions are part of the schema | Use `gbrain reinit-pglite` or the Postgres embedding migration guide. |
| An upgraded multi-source brain returns content under the wrong source | Older derived facts predate current source identity | Run `gbrain extract all` once, then verify each source independently. |
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
