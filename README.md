# gbrain-company

This fork adds company-wide GBrain support.

The contribution is an organization brain flow where each member keeps an
individual GBrain, controls what is shared, and a separate company GBrain pulls
only signed, sanitized exports into company-visible member sources.

## What This Adds

- `gbrain init --mode individual|company`
- `gbrain company-share` for member export policy, member registration, and
  company pulls
- `company_share_export` for signed, sanitized member exports over MCP
- Company-mode MCP filtering so remote company agents only get the company-safe
  tool surface
- `skills/COMPANY_RESOLVER.md` for company agents
- Docker and Railway deployment files for a multi-service company setup

## Install

Install the GBrain software once. The same codebase runs both individual and
company mode; the role is chosen by runtime configuration.

### On an agent platform (recommended)

GBrain is designed to be installed and operated by an AI agent. For this branch,
tell the agent which role you are deploying:

```text
Deploy company-wide GBrain from this branch.
Use one shared GBrain codebase, but create separate services:

- gbrain-alice: individual mode, Alice DB, Alice markdown repo
- gbrain-bob: individual mode, Bob DB, Bob markdown repo
- gbrain-company: company mode, Company DB, Company markdown repo

The company brain must learn from members only through company-share pull.
Read README.md, AGENTS.md, and INSTALL_FOR_AGENTS.md before changing anything.
```

For hosted deployment, the agent should follow:

- [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) for install and role selection
- [`docs/deploy/railway-company-gbrain.md`](docs/deploy/railway-company-gbrain.md) for Railway/Supabase variables

The important split is:

```text
same GBrain code checkout/container
  gbrain-alice   -> --mode individual, Alice DB, Alice markdown repo
  gbrain-bob     -> --mode individual, Bob DB, Bob markdown repo
  gbrain-company -> --mode company, Company DB, Company markdown repo
```

Do not create separate GBrain software forks for each person and the company.
Deploy the same GBrain code multiple times with isolated homes, databases, and
markdown source repos.

### Standalone CLI (no agent)

Use this path for local testing or a manually operated server.

```bash
git clone https://github.com/yongchand/gbrain-company.git ~/gbrain
cd ~/gbrain
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install && bun link
```

Create separate homes and databases:

```bash
export ALICE_HOME=/var/lib/gbrain/alice
export COMPANY_HOME=/var/lib/gbrain/company
export ALICE_DATABASE_URL=<alice-postgres-url>
export COMPANY_DATABASE_URL=<company-postgres-url>

GBRAIN_HOME="$ALICE_HOME" \
  gbrain init --mode individual --url "$ALICE_DATABASE_URL" --non-interactive

GBRAIN_HOME="$COMPANY_HOME" \
  gbrain init --mode company --url "$COMPANY_DATABASE_URL" --non-interactive
```

Sync each role's own markdown source repo:

```bash
GBRAIN_HOME="$ALICE_HOME" gbrain sync --repo /repos/alice-brain --yes
GBRAIN_HOME="$COMPANY_HOME" gbrain sync --repo /repos/company-brain --yes
```

Configure sharing from Alice to Company:

```bash
export ALICE_COMPANY_SHARE_SECRET=$(openssl rand -hex 32)

GBRAIN_HOME="$ALICE_HOME" \
  gbrain company-share secret set --secret "$ALICE_COMPANY_SHARE_SECRET"

GBRAIN_HOME="$ALICE_HOME" \
  gbrain company-share set-page <shared-slug> --mode summary

GBRAIN_HOME="$COMPANY_HOME" \
  gbrain company-share members add alice \
    --issuer-url https://gbrain-alice.example.com \
    --mcp-url https://gbrain-alice.example.com/mcp \
    --oauth-client-id <alice-client-id> \
    --oauth-client-secret <alice-client-secret> \
    --manifest-secret "$ALICE_COMPANY_SHARE_SECRET"

GBRAIN_HOME="$COMPANY_HOME" gbrain company-share pull --member alice
```

### MCP server with company mode

Run one HTTP MCP server per brain. The individual servers expose each member's
private brain to that member's own trusted agents. The company server exposes
only the company aggregate and imported `member-*` snapshots.

Individual member MCP:

```bash
GBRAIN_HOME="$ALICE_HOME" \
  gbrain serve --http \
  --bind 0.0.0.0 \
  --port 3131 \
  --public-url https://gbrain-alice.example.com
```

Company MCP:

```bash
GBRAIN_HOME="$COMPANY_HOME" \
  gbrain serve --http \
  --bind 0.0.0.0 \
  --port 3132 \
  --public-url https://gbrain-company.example.com
```

Configure Hermes/OpenClaw against the company endpoint when you want company
knowledge:

```text
name: company-gbrain
issuer_url: https://gbrain-company.example.com
mcp_url: https://gbrain-company.example.com/mcp
oauth_client_id: <company-client-id>
oauth_client_secret: <company-client-secret>
```

Do not also configure Alice's individual MCP endpoint in the company agent unless
that agent is intentionally acting as Alice's private assistant.

Company mode also filters the remote MCP tool list to company-safe read and
analysis operations. Normal company agents can query company-owned pages and
imported `member-*` snapshots; setup, private ingestion, and direct member-source
mutation remain local/admin workflows.

### Cloud Environment

```text
gbrain-alice:
  GBRAIN_MODE=individual
  DATABASE_URL=<alice-db>
  BRAIN_REPO_URL=<alice-markdown-brain-repo>

gbrain-company:
  GBRAIN_MODE=company
  DATABASE_URL=<company-db>
  BRAIN_REPO_URL=<company-markdown-brain-repo>
```

The company service should only connect to member brains through
`gbrain company-share pull`; it should not mount or sync a member's private
markdown repo directly.

## Model

```text
member-example GBrain           gbrain-company
---------------------           --------------
mode: individual                mode: company
own GBRAIN_HOME                 own GBRAIN_HOME
own database                    own database
own markdown brain repo         own markdown brain repo
private by default              imports member-* sources
exports approved pages   --->   queries company-visible snapshots
```

The company brain does not open a member database or markdown repo directly. It
pulls through the member's MCP/OAuth endpoint and imports the approved export
into a source such as `member-example`.

## Minimal Setup

```bash
export MEMBER_HOME=/var/lib/gbrain/member-example
export COMPANY_HOME=/var/lib/gbrain/company
export MEMBER_DATABASE_URL=<member-postgres-url>
export COMPANY_DATABASE_URL=<company-postgres-url>
export SHARED_SECRET=$(openssl rand -hex 32)

GBRAIN_HOME="$MEMBER_HOME" gbrain init --mode individual \
  --url "$MEMBER_DATABASE_URL" --non-interactive

GBRAIN_HOME="$COMPANY_HOME" gbrain init --mode company \
  --url "$COMPANY_DATABASE_URL" --non-interactive
```

Set the member's company-sharing policy:

```bash
GBRAIN_HOME="$MEMBER_HOME" gbrain company-share secret set \
  --secret "$SHARED_SECRET"

GBRAIN_HOME="$MEMBER_HOME" gbrain company-share set-source default \
  --default summary

GBRAIN_HOME="$MEMBER_HOME" gbrain company-share set-page notes/private \
  --mode private

GBRAIN_HOME="$MEMBER_HOME" gbrain company-share set-page notes/company-visible \
  --mode full
```

Register the member on `gbrain-company` and pull:

```bash
GBRAIN_HOME="$COMPANY_HOME" gbrain company-share members add member-example \
  --issuer-url https://member-example-gbrain.example.com \
  --mcp-url https://member-example-gbrain.example.com/mcp \
  --oauth-client-id <member-client-id> \
  --oauth-client-secret <member-client-secret> \
  --manifest-secret "$SHARED_SECRET"

GBRAIN_HOME="$COMPANY_HOME" gbrain company-share pull --member member-example
```

Inspect the company agent surface:

```bash
GBRAIN_HOME="$COMPANY_HOME" gbrain company-share skill-policy --json
```

## Company Skills

Individual brains use the normal `skills/RESOLVER.md`. Company brains use
`skills/COMPANY_RESOLVER.md`, which keeps the agent surface narrower because a
company brain is an aggregate, shared knowledge system rather than a user's
private assistant.

Company mode enables skills for company-visible work:

```text
brain-ops
query
data-research
perplexity-research
concept-synthesis
strategic-reading
briefing
reports
maintain
frontmatter-guard
citation-fixer
skillpack-check
smoke-test
ask-user
```

These are admin/operator-only on the host brain, not normal Hermes/company-agent
skills:

```text
setup
cold-start
migrate
cron-scheduler
minion-orchestrator
webhook-transforms
skill-creator
skillify
testing
publish
brain-pdf
soul-audit
functional-area-resolver
```

These are disabled for normal company agents because they are personal-ingestion,
personal-tasking, or direct member-source mutation workflows:

```text
ingest
idea-ingest
media-ingest
meeting-ingestion
enrich
repo-architecture
daily-task-manager
daily-task-prep
cross-modal-review
book-mirror
article-enrichment
archive-crawler
academic-verify
voice-note-ingest
```

Company-mode MCP also filters the remote tool list to company-safe read and
analysis operations. A company agent can query company-owned pages and imported
`member-*` snapshots, but it cannot use member-private ingestion or setup
skills unless an operator runs those locally with admin intent.

## Deployment

This fork includes:

- `Dockerfile`
- `railway.json`
- `scripts/railway-start.sh`
- `docs/deploy/railway-company-gbrain.md`

The Railway runbook deploys three isolated services:

```text
gbrain-member-a     mode: individual
gbrain-member-b     mode: individual
gbrain-company      mode: company
```

Each service needs its own `GBRAIN_HOME`, database, and public MCP/OAuth issuer
URL. It should also have its own markdown source-of-truth repo. Use explicit MCP names such as `company-gbrain` and
`member-example-gbrain` so agents do not confuse the aggregate company brain
with a member's private brain.

Full runbook: [`docs/deploy/railway-company-gbrain.md`](docs/deploy/railway-company-gbrain.md)

## Files Changed

- `src/commands/company-share.ts`
- `src/core/company-share.ts`
- `src/core/company-skill-policy.ts`
- `src/commands/init.ts`
- `src/commands/serve-http.ts`
- `src/core/operations.ts`
- `src/mcp/dispatch.ts`
- `src/mcp/server.ts`
- `skills/COMPANY_RESOLVER.md`
- `docs/deploy/railway-company-gbrain.md`
- `Dockerfile`
- `railway.json`
- `scripts/railway-start.sh`
- `test/company-share.test.ts`
- `test/company-skill-policy.test.ts`

## Tests

```bash
bun test test/company-share.test.ts test/company-skill-policy.test.ts
```
