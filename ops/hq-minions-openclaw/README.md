# hq-minions-openclaw

Local-only OpenClaw/HQ operator layer for GBrain Minions.

## Tested baseline

This package was most recently validated against GBrain commit:

```text
ebfbd5e6f72c7854a3b0f393dd60a230edcd6f1e
```

Treat that commit as the current tested baseline for the local operator path until a newer commit is revalidated.

## Install

### Prerequisites

- Bun must be installed for host-native bootstrap, verify, and systemd worker usage.
- Docker + Docker Compose are required for the documented local Postgres bootstrap.

Copy this directory into:

```text
gbrain/ops/hq-minions-openclaw
```

Then:

```bash
cd gbrain/ops/hq-minions-openclaw
cp .env.example .env
bash scripts/bootstrap-local.sh
```

The bootstrap script now fails closed on migration-critical errors and upstream doctor failures.

If no global `gbrain` binary is on `PATH`, the scripts create a repo-local shim that runs `bun src/cli.ts` from the checked-out GBrain repo so nested migration calls still resolve correctly.

## Commands

```bash
bun src/cli.ts doctor
bun src/cli.ts health
bun src/cli.ts create-work-item --project hq --title "Example"
bun src/cli.ts board --project hq
bun run worker
```

## Verification

```bash
bash scripts/verify.sh
```

`scripts/verify.sh` treats typecheck as advisory by default because upstream import-surface failures may not reflect runtime health. To make typecheck fatal again:

```bash
HQ_MINIONS_STRICT_TYPECHECK=1 bash scripts/verify.sh
```

## Restore

Default restore:

```bash
bash scripts/restore.sh backups/gbrain-YYYYMMDDTHHMMSSZ.dump
```

Restore into a disposable DB inside the local compose-backed Postgres service:

```bash
bash scripts/restore.sh backups/gbrain-YYYYMMDDTHHMMSSZ.dump --db gbrain_restore_test
```

## Guardrails

- Postgres only for persistent worker.
- Shell jobs disabled.
- Queue API only for lifecycle/actions.
- Job IDs are integers.
- Default create is paused unless `--run-now`.
