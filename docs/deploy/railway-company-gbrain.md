# Railway Company GBrain Deployment

This runbook deploys three isolated GBrain services:

```text
gbrain-alice      individual mode
gbrain-bob        individual mode
gbrain-company    company mode
```

Each service must have its own `GBRAIN_HOME`, Supabase Postgres database,
markdown brain repo, and public MCP/OAuth issuer URL. Do not point two services
at the same database or the same markdown source-of-truth repo.

## Required Inputs

Use Supabase **Session Pooler** connection strings, not direct IPv6 URLs:

```text
ALICE_DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
BOB_DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
COMPANY_DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Generate member export signing secrets:

```bash
openssl rand -hex 32 # ALICE_COMPANY_SHARE_SECRET
openssl rand -hex 32 # BOB_COMPANY_SHARE_SECRET
```

## Railway Services

Create one Railway project with three services from this repository/branch.
Use the same Dockerfile for all three services and set different environment
variables per service.

The GBrain code repo is shared. The markdown source-of-truth repos are separate
and are configured per service with `BRAIN_REPO_URL`.

### gbrain-alice

```text
GBRAIN_HOME=/data/gbrain
GBRAIN_MODE=individual
DATABASE_URL=<ALICE_DATABASE_URL>
PUBLIC_URL=https://gbrain-alice.up.railway.app
BRAIN_REPO_URL=https://github.com/<org>/gbrain-alice-brain.git
BRAIN_REPO_BRANCH=main
BRAIN_REPO_PATH=/data/brain-repo
BRAIN_REPO_SYNC_INTERVAL_SECONDS=300
BRAIN_REPO_TOKEN=<read-only-github-token>
COMPANY_SHARE_SECRET=<ALICE_COMPANY_SHARE_SECRET>
```

### gbrain-bob

```text
GBRAIN_HOME=/data/gbrain
GBRAIN_MODE=individual
DATABASE_URL=<BOB_DATABASE_URL>
PUBLIC_URL=https://gbrain-bob.up.railway.app
BRAIN_REPO_URL=https://github.com/<org>/gbrain-bob-brain.git
BRAIN_REPO_BRANCH=main
BRAIN_REPO_PATH=/data/brain-repo
BRAIN_REPO_SYNC_INTERVAL_SECONDS=300
BRAIN_REPO_TOKEN=<read-only-github-token>
COMPANY_SHARE_SECRET=<BOB_COMPANY_SHARE_SECRET>
```

### gbrain-company

```text
GBRAIN_HOME=/data/gbrain
GBRAIN_MODE=company
DATABASE_URL=<COMPANY_DATABASE_URL>
PUBLIC_URL=https://gbrain-company.up.railway.app
BRAIN_REPO_URL=https://github.com/<org>/gbrain-company-brain.git
BRAIN_REPO_BRANCH=main
BRAIN_REPO_PATH=/data/brain-repo
BRAIN_REPO_SYNC_INTERVAL_SECONDS=300
BRAIN_REPO_TOKEN=<read-only-github-token>
```

`BRAIN_REPO_TOKEN` is preferred for Railway because it uses outbound HTTPS. If
you use SSH instead, set `BRAIN_REPO_URL=git@github.com:<org>/<repo>.git` and
`BRAIN_REPO_SSH_KEY=<read-only-deploy-key-private-key>`.

The container start command is:

```bash
bash scripts/railway-start.sh
```

It runs:

```bash
gbrain init --mode "$GBRAIN_MODE" --url "$DATABASE_URL" --non-interactive
gbrain sync --repo "$BRAIN_REPO_PATH" --yes
gbrain serve --http --bind 0.0.0.0 --port "$PORT" --public-url "$PUBLIC_URL"
```

When `BRAIN_REPO_URL` is set, startup makes a fresh shallow clone of that
markdown repo, syncs it into the service's own database, and runs a background
sync loop. This does not change the company-share boundary: `gbrain-company`
still only learns from Alice through the signed export/import path unless the
company markdown repo itself contains company-authored pages.

For a single member, the company service can also bootstrap the member registry
from Railway variables at startup:

```bash
COMPANY_SHARE_MEMBER_ID=alice
COMPANY_SHARE_MEMBER_ISSUER_URL=https://gbrain-alice.up.railway.app
COMPANY_SHARE_MEMBER_MCP_URL=https://gbrain-alice.up.railway.app/mcp
COMPANY_SHARE_MEMBER_OAUTH_CLIENT_ID=<alice-client-id>
COMPANY_SHARE_MEMBER_OAUTH_CLIENT_SECRET=<alice-client-secret>
COMPANY_SHARE_MEMBER_MANIFEST_SECRET=<ALICE_COMPANY_SHARE_SECRET>
```

## First-Time Member Wiring

After `gbrain-alice` and `gbrain-bob` are live, create a company-pull OAuth
client on each individual brain. From the Railway shell for each individual
service:

```bash
bun src/cli.ts auth register-client company-share \
  --grant-types client_credentials \
  --scopes read
```

Save each returned `oauth_client_id` and `oauth_client_secret`.

Then open a Railway shell for `gbrain-company` and register the members:

```bash
bun src/cli.ts company-share members add alice \
  --issuer-url https://gbrain-alice.up.railway.app \
  --mcp-url https://gbrain-alice.up.railway.app/mcp \
  --oauth-client-id <alice-client-id> \
  --oauth-client-secret <alice-client-secret> \
  --manifest-secret <ALICE_COMPANY_SHARE_SECRET>

bun src/cli.ts company-share members add bob \
  --issuer-url https://gbrain-bob.up.railway.app \
  --mcp-url https://gbrain-bob.up.railway.app/mcp \
  --oauth-client-id <bob-client-id> \
  --oauth-client-secret <bob-client-secret> \
  --manifest-secret <BOB_COMPANY_SHARE_SECRET>
```

Pull both members:

```bash
bun src/cli.ts company-share pull
```

Imported member pages land in `member-alice` and `member-bob` sources.

## Hermes

Register a Hermes OAuth client on `gbrain-company`:

```bash
bun src/cli.ts auth register-client hermes \
  --grant-types client_credentials \
  --scopes read
```

Configure Hermes with only the company MCP endpoint:

```text
name: company-gbrain
issuer_url: https://gbrain-company.up.railway.app
mcp_url: https://gbrain-company.up.railway.app/mcp
oauth_client_id: <hermes-client-id>
oauth_client_secret: <hermes-client-secret>
```

Do not add `gbrain-alice` or `gbrain-bob` to Hermes unless Hermes is intended to
act as that user's private agent.

## Recurring Pull

For the simple Railway deployment, set this variable on `gbrain-company`:

```bash
COMPANY_SHARE_PULL_INTERVAL_SECONDS=900
```

The web service will run a background pull loop every 15 minutes. The loop uses
the member registered by `COMPANY_SHARE_MEMBER_ID` when present; otherwise it
pulls every registered member.

You can also run this from a Railway cron service or external scheduler:

```bash
bun src/cli.ts company-share pull
```

The company copy is updated only through the signed export/import path. If a
member marks a previously shared page private, the next successful pull
soft-deletes the company copy.
