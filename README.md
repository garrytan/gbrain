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

```bash
git clone https://github.com/garrytan/gbrain.git ~/gbrain
cd ~/gbrain
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install && bun link
```

Do not create separate GBrain software forks for each person and the company.
Deploy the same GBrain code multiple times with isolated homes, databases, and
markdown source repos:

```text
gbrain-alice   -> --mode individual, Alice DB, Alice markdown repo
gbrain-bob     -> --mode individual, Bob DB, Bob markdown repo
gbrain-company -> --mode company, Company DB, Company markdown repo
```

For local or server installs, choose the mode during init:

```bash
GBRAIN_HOME=/var/lib/gbrain/alice \
  gbrain init --mode individual --url "$ALICE_DATABASE_URL" --non-interactive

GBRAIN_HOME=/var/lib/gbrain/company \
  gbrain init --mode company --url "$COMPANY_DATABASE_URL" --non-interactive
```

For cloud deployments, set the equivalent environment variables per service:

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
