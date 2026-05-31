---
id: railway-app-hosting
name: Railway App Hosting
version: 0.7.0
description: Always-on public hosting for webhook and collector services on Railway.
category: infra
requires: []
secrets: []
health_checks:
  - type: heartbeat_fresh
    max_age: 7d
    label: Railway hosting setup heartbeat
setup_time: 20 min
cost_estimate: "Railway account required; usage depends on selected service resources."
---

# Railway App Hosting: Stable Webhook Infrastructure

Use this recipe when a webhook, voice, or deterministic collector service needs
a stable public HTTPS URL without a local tunnel. Railway can deploy local code,
manage service variables, and expose the service through Railway-provided or
custom domains.

Bring your own HTTP service. The service must already expose an HTTP port and a
small health endpoint such as `/health`. This recipe does not turn stdio MCP into HTTP.
If the target is `mbrain serve`, build or use an HTTP wrapper first; future
`mbrain serve --http` work is a separate runtime feature.

## IMPORTANT: Instructions for the Agent

You are setting up hosting infrastructure only. Do not add OAuth, do not create
a remote MCP promise, and do not assume OpenAI or Anthropic API keys are
available. Configure only the environment variables the user's service actually
requires.

Use official Railway docs while installing:

- CLI deploys: https://docs.railway.com/cli/up
- Service variables: https://docs.railway.com/cli/variable
- Public networking: https://docs.railway.com/networking/public-networking
- Healthchecks: https://docs.railway.com/deployments/healthchecks
- Application failed to respond: https://docs.railway.com/networking/troubleshooting/application-failed-to-respond

## Prerequisites

Before touching Railway, verify the local service:

1. It has a `Dockerfile`, Railpack-compatible project, or another Railway-supported build path.
2. It listens on `0.0.0.0` and the `PORT` environment variable.
3. It has a health endpoint that returns HTTP 200.
4. It can run without secrets being printed to logs.

Example local smoke test:

```bash
HOST=0.0.0.0 PORT=3000 bun run start
curl -fsS http://localhost:3000/health
```

If the local service does not pass, stop and fix the service first.

## Setup Flow

### Step 1: Install and authenticate Railway CLI

Tell the user:
"I need Railway CLI access. You can log in interactively with `railway login`,
or use `RAILWAY_TOKEN` / `RAILWAY_API_TOKEN` for headless deployment."

```bash
command -v railway >/dev/null 2>&1 || npm i -g @railway/cli
railway whoami || railway login
```

Do not store token values in the recipe or setup logs.

### Step 2: Create or link a Railway project

Run from the service source directory:

```bash
railway init
railway status
```

If the user already has a Railway project, use:

```bash
railway link
railway service
```

Confirm the selected project, environment, and service before deploying.

### Step 3: Configure service variables

Only set variables the service actually needs. Examples:

```bash
railway variable set DATABASE_URL="$DATABASE_URL"
railway variable set MBRAIN_TOKEN="$MBRAIN_TOKEN"
```

When typing a literal value instead of expanding an environment variable,
single-quote literal secret values that contain spaces or shell metacharacters.
If the value contains a single quote, verify the exact quoting form with
`railway variable set --help` before running the command. Do not paste raw
secret values into setup logs.

For CI/headless deploys, Railway supports token-based CLI auth through
`RAILWAY_TOKEN` for project-level actions or `RAILWAY_API_TOKEN` for
account/workspace-level actions.

### Step 4: Verify listener behavior

Railway injects a `PORT` environment variable. The app should bind to
`0.0.0.0` and listen on that port. For a Node/Express-style service:

```javascript
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0");
```

If the app listens only on `localhost`, Railway public networking can fail even
when the process starts.

### Step 5: Deploy

```bash
railway up
```

`railway up` deploys the current directory. If the service lives in a
subdirectory, pass that path explicitly:

```bash
railway up ./service
```

If deploy fails, inspect the Railway build and deploy logs before continuing.

### Step 6: Configure public networking

In the Railway dashboard:

1. Open the service.
2. Go to Settings -> Networking -> Public Networking.
3. Generate a Railway domain, or attach a custom domain.
4. Confirm the domain points to the service port.

Railway healthchecks are deployment activation checks, not continuous
monitoring. Configure a `/health` path so Railway waits for HTTP 200 before
making the new deployment active.

### Step 7: Smoke test the public URL

```bash
curl -fsS https://YOUR-RAILWAY-DOMAIN/health
railway logs
```

This public smoke test is intentionally not part of `mbrain integrations doctor`.
Recipe `url_responds` checks are limited to localhost loopback targets.

### Step 8: Point webhooks at the stable URL

For voice-to-brain or a future collector, configure the provider webhook to the
service route, for example:

```text
https://YOUR-RAILWAY-DOMAIN/voice
https://YOUR-RAILWAY-DOMAIN/webhooks/provider
```

After changing the provider webhook, send one real test event and inspect logs:

```bash
railway logs
```

Do not paste raw logs into chat, issues, PRs, or brain pages. Verify only the
status and error shape you need; redact tokens, headers, URLs, payloads, and
local paths before sharing any excerpt.

### Step 9: Log setup completion

```bash
mkdir -p ~/.mbrain/integrations/railway-app-hosting
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok","details":{"platform":"railway","service":"SERVICE_NAME","url":"https://YOUR-RAILWAY-DOMAIN"}}' >> ~/.mbrain/integrations/railway-app-hosting/heartbeat.jsonl
```

## Troubleshooting

- If Railway reports "Application failed to respond", confirm the service binds
  to `0.0.0.0:$PORT`.
- If the public domain exists but healthchecks fail, confirm `/health` returns
  HTTP 200 during startup.
- If variables are missing, inspect `railway variable list` and set only the
  values the service actually requires.
- If the wrong service is selected, re-run `railway status` and `railway service`
  before deploying again.
