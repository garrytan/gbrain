---
id: fly-app-hosting
name: Fly.io App Hosting
version: 0.7.0
description: Always-on public hosting for webhook and collector services on Fly.io.
category: infra
requires: []
secrets: []
health_checks:
  - type: heartbeat_fresh
    max_age: 7d
    label: Fly hosting setup heartbeat
setup_time: 20 min
cost_estimate: "Fly.io account required; usage depends on selected machines and storage."
---

# Fly.io App Hosting: Always-On Webhook Infrastructure

Use this recipe when a webhook, voice, or deterministic collector service needs
a stable public HTTPS URL without a local tunnel. Fly.io runs the service as an
app and can keep at least one Machine warm for webhook traffic.

Bring your own HTTP service. The service must already expose an HTTP port and a
small health endpoint such as `/health`. This recipe does not turn stdio MCP into HTTP.
If the target is MBrain MCP, run `mbrain serve --http` first and host that HTTP
service. OAuth remains separate from this hosting recipe.

## IMPORTANT: Instructions for the Agent

You are setting up hosting infrastructure only. Do not add OAuth, do not create
a remote MCP promise, and do not assume OpenAI or Anthropic API keys are
available. Configure only the environment variables the user's service actually
requires.

Use official Fly.io docs while installing:

- Fly Launch: https://fly.io/docs/launch/create/
- Fly deploy: https://fly.io/docs/launch/deploy/
- Runtime secrets: https://fly.io/docs/apps/secrets/
- Autostop/autostart: https://fly.io/docs/launch/autostop-autostart/

## Prerequisites

Before touching Fly.io, verify the local service:

1. It has a `Dockerfile` or a framework that Fly Launch can scan.
2. It listens on a configurable port.
3. It has a health endpoint that returns HTTP 200.
4. It can run without secrets being printed to logs.

Example local smoke test:

```bash
PORT=3000 bun run start
curl -fsS http://localhost:3000/health
```

If the local service does not pass, stop and fix the service first.

## Setup Flow

### Step 1: Install and authenticate flyctl

Tell the user:
"I need Fly.io CLI access. You can either log in interactively with `fly auth
login`, or provide a scoped token for headless/CI deployment."

```bash
command -v fly >/dev/null 2>&1 || brew install flyctl
fly auth whoami || fly auth login
```

For headless setup, use `FLY_API_TOKEN` in the shell environment instead of
interactive login. Do not store token values in the recipe or setup logs.

### Step 2: Launch the app without deploying yet

Run from the service source directory, where the `Dockerfile`, app source, and
future `fly.toml` should live:

```bash
fly launch --no-deploy
```

Choose an app name the user recognizes, such as `mbrain-voice-service` or
`mbrain-collector-service`. Let Fly create or update `fly.toml`.

### Step 3: Check `fly.toml`

Open `fly.toml` and verify the service port matches the application. For a web
service, Fly uses the local `fly.toml` during `fly deploy`, and a Dockerfile in
the source directory can be used to build the image.

For webhook reliability, keep one Machine running in the primary region. In the
`[http_service]` section, use this pattern when it fits the generated config:

```toml
[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1
```

If the service has a different port, set `internal_port` to that value. If the
service must have every Machine running continuously, disable autostop instead
according to the Fly autostop/autostart docs.

### Step 4: Set runtime secrets

Only set secrets the service actually needs. Examples:

```bash
fly secrets set DATABASE_URL="$DATABASE_URL"
fly secrets set MBRAIN_TOKEN="$MBRAIN_TOKEN"
```

When typing a literal value instead of expanding an environment variable,
single-quote literal secret values that contain spaces or shell metacharacters.
If the value contains a single quote, verify the exact quoting form with
`fly secrets set --help` before running the command. Do not paste raw secret
values into setup logs.

Fly runtime secrets become environment variables for the app. Setting secrets
can update or restart Machines, so do this before the first production deploy
when possible.

### Step 5: Deploy

```bash
fly deploy
fly status
```

If deploy fails, inspect the build output and fix the app or Dockerfile before
continuing. Do not hide deploy failures behind webhook configuration changes.

### Step 6: Smoke test the public URL

Find the generated app hostname, usually `https://APP_NAME.fly.dev`, then run:

```bash
curl -fsS https://APP_NAME.fly.dev/health
```

This public smoke test is intentionally not part of `mbrain integrations doctor`.
Recipe `url_responds` checks are limited to localhost loopback targets.

### Step 7: Point webhooks at the stable URL

For voice-to-brain or a future collector, configure the provider webhook to the
service route, for example:

```text
https://APP_NAME.fly.dev/voice
https://APP_NAME.fly.dev/webhooks/provider
```

After changing the provider webhook, send one real test event and inspect the
service logs:

```bash
fly logs
```

Do not paste raw logs into chat, issues, PRs, or brain pages. Verify only the
status and error shape you need; redact tokens, headers, URLs, payloads, and
local paths before sharing any excerpt.

### Step 8: Log setup completion

```bash
mkdir -p ~/.mbrain/integrations/fly-app-hosting
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok","details":{"platform":"fly.io","app":"APP_NAME","url":"https://APP_NAME.fly.dev"}}' >> ~/.mbrain/integrations/fly-app-hosting/heartbeat.jsonl
```

## Troubleshooting

- If deploy cannot find the app, run from the directory containing `fly.toml`.
- If the public URL returns 502/503, confirm the app listens on the port named
  by `internal_port`.
- If webhooks arrive late after idle periods, keep `min_machines_running = 1`
  or disable autostop for the service.
- If secrets are missing at runtime, set them with `fly secrets set` and redeploy
  or restart as needed.
