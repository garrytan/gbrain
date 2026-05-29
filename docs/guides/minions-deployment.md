# Worker Deployment Guide

Cortex background workers process tenant jobs such as sync, embedding,
extraction, webhook ingestion, and maintenance. In production SaaS, run workers
under the deployment platform supervisor and keep secrets in the host secret
manager.

## Recommended Production Shape

| Environment | Recommendation |
| --- | --- |
| Railway / Render / Fly / Heroku | Run `cortex jobs supervisor` as the worker process. |
| Linux VM | Let systemd supervise `cortex jobs supervisor`. |
| CI or one-off maintenance | Use `cortex jobs submit ... --follow`. |

## Required Environment

- Tenant database URL.
- Cortex public URL when workers need to emit tenant links.
- Provider secrets for embeddings, email, billing, and ingestion.
- `CORTEX_ALLOW_SHELL_JOBS=1` only when shell jobs are explicitly required.

## Commands

```bash
cortex jobs supervisor start --detach --json
cortex jobs supervisor status --json
cortex jobs supervisor stop
cortex jobs stats
```

## Deployment Notes

- Stop workers before schema migrations.
- Restart workers after changing provider secrets or runtime package config.
- Surface worker failures in the admin Jobs tab.
- Keep shell jobs disabled unless a tenant workflow explicitly needs them.

## Smoke

```bash
cortex jobs supervisor status --json
cortex jobs stats
cortex doctor --json
```

Hosted demo verification is covered by `scripts/saas-live-smoke.ts`.
