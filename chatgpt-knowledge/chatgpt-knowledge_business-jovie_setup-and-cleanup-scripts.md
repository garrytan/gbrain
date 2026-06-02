---
title: "Setup and Cleanup Scripts"
type: guide
created: 2026-04-22
updated: 2026-04-22
source: chatgpt-export
topic: business-jovie
message_count: 7
tags: [chatgpt, knowledge, business-jovie]
---
**Topic:** [[chatgpt-knowledge/_topics/business-jovie]]

# Setup and Cleanup Scripts

> **Source:** ChatGPT conversation
> **Date:** 2026-04-22T15:50:47Z
> **Messages:** 7
> **Topic:** business-jovie

## Question

tell me the exact setup and clean up scripts to add to my local codex enviroment for the jovie repo

## Answer

I’ll verify Codex local-environment conventions first, then tailor copy-pasteable setup and cleanup scripts for the Jovie repo based on its likely Node/TypeScript structure.

## Answer

I found the current repo sources and I’m following `AGENTS.md` as canonical: use `./scripts/setup.sh` with Node 22.13.0+ and pnpm 9.15.4. I’m ignoring the older `CODEX.md` Node 24 guidance and folding in Doppler `jovie-web` / `dev` for the local scripts.

## Answer

Mr. White, add this from the **Jovie repo root**. Codex local env config belongs under `.codex`, setup scripts run when Codex creates a worktree, and actions appear as runnable commands in the Codex app; cleanup should be a manual action because the documented local environment surface is setup scripts plus actions. citeturn749561view0 Jovie already has a Codex-specific setup script at `scripts/codex-setup.sh`, with Node 22.x, pnpm `9.15.4`, and Doppler handling baked in. citeturn635057view0turn635057view1 The actions below map to Jovie’s current package scripts such as `dev:web:local`, `test:web`, `typecheck`, `lint`, `build:web`, and DB migration. citeturn635057view4

```bash
mkdir -p .codex/environments

cat > .codex/environments/environment.toml <<'EOF'
version = 1
name = "Jovie local"

[setup]
script = '''
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

SETUP_SCRIPT="$REPO_ROOT/scripts/codex-setup.sh"

if [ ! -x "$SETUP_SCRIPT" ] && [ -f "$SETUP_SCRIPT" ]; then
  chmod +x "$SETUP_SCRIPT"
fi

if [ ! -x "$SETUP_SCRIPT" ]; then
  echo "[codex-env] setup script not found or not executable: $SETUP_SCRIPT" >&2
  exit 127
fi

"$SETUP_SCRIPT"
'''

[[actions]]
name = "Dev Web"
icon = "run"
command = "pnpm run dev:web:local"

[[actions]]
name = "Dev Web Browse"
icon = "run"
command = "pnpm run dev:web:browse"

[[actions]]
name = "DB Migrate Web"
icon = "run"
command = "pnpm run db:web:migrate"

[[actions]]
name = "Test Web"
icon = "test"
command = "pnpm run test:web"

[[actions]]
name = "Smoke Test Web"
icon = "test"
command = "pnpm run test:web:smoke"

[[actions]]
name = "Typecheck"
icon = "check"
command = "pnpm run typecheck"

[[actions]]
name = "Lint"
icon = "check"
command = "pnpm run lint"

[[actions]]
name = "Build Web"
icon = "build"
command = "pnpm run build:web"

[[actions]]
name = "Clean"
icon = "run"
command = "bash scripts/codex-cleanup.sh"

[[actions]]
name = "Full Clean"
icon = "run"
command = "bash scripts/codex-cleanup.sh --full"
EOF

cat > scripts/codex-cleanup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

echo "[codex-cleanup] repo: $REPO_ROOT"

echo "[codex-cleanup] running turbo clean when available"
if command -v pnpm >/dev/null 2>&1; then
  pnpm exec turbo clean >/dev/null 2>&1 || pnpm turbo clean >/dev/null 2>&1 || true
fi

echo "[codex-cleanup] removing generated build/test/cache outputs"
rm -rf \
  .turbo \
  .next \
  .cache \
  coverage \
  playwright-report \
  test-results \
  .codex-artifacts \
  apps/*/.next \
  apps/*/.turbo \
  apps/*/.cache \
  apps/*/coverage \
  apps/*/playwright-report \
  apps/*/test-results \
  packages/*/.turbo \
  packages/*/.cache \
  packages/*/coverage \
  packages/*/dist

find . \
  -path './.git' -prune -o \
  -path './node_modules' -prune -o \
  -path './apps/*/node_modules' -prune -o \
  -path './packages/*/node_modules' -

*(Answer truncated — 3828 chars total)*

## Question

sepeare te into actions and setup and clean

## Answer

I’ll split it into three copy-paste blocks: setup, cleanup, and Codex actions/config that references both.

## Answer

Mr. White, use **three separate pieces**.

Codex local environments support setup scripts and actions; setup runs for new worktrees, and actions appear in the Codex app top bar. The generated config lives under `.codex` in the repo. citeturn462023view0 Jovie already has `scripts/codex-setup.sh`, and the repo’s scripts include the commands below such as `dev:web:local`, `test:web`, `typecheck`, `lint`, `build:web`, and `db:web:migrate`. citeturn860939view0turn860939view1

## 1. Setup

Path:

```bash
.codex/environments/environment.toml
```

Top of the file:

```toml
version = 1
name = "Jovie local"
```

Setup section:

```toml
[setup]
script = '''
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

SETUP_SCRIPT="$REPO_ROOT/scripts/codex-setup.sh"

if [ ! -x "$SETUP_SCRIPT" ] && [ -f "$SETUP_SCRIPT" ]; then
  chmod +x "$SETUP_SCRIPT"
fi

if [ ! -x "$SETUP_SCRIPT" ]; then
  echo "[codex-env] setup script not found or not executable: $SETUP_SCRIPT" >&2
  exit 127
fi

"$SETUP_SCRIPT"
'''
```

## 2. Actions

Append this below the setup section in the same file:

```toml
[[actions]]
name = "Dev Web"
icon = "run"
command = "pnpm run dev:web:local"

[[actions]]
name = "Dev Web Browse"
icon = "run"
command = "pnpm run dev:web:browse"

[[actions]]
name = "DB Migrate Web"
icon = "run"
command = "pnpm run db:web:migrate"

[[actions]]
name = "Test Web"
icon = "test"
command = "pnpm run test:web"

[[actions]]
name = "Smoke Test Web"
icon = "test"
command = "pnpm run test:web:smoke"

[[actions]]
name = "Typecheck"
icon = "check"
command = "pnpm run typecheck"

[[actions]]
name = "Lint"
icon = "check"
command = "pnpm run lint"

[[actions]]
name = "Build Web"
icon = "build"
command = "pnpm run build:web"

[[actions]]
name = "Clean"
icon = "run"
command = "bash scripts/codex-cleanup.sh"

[[actions]]
name = "Full Clean"
icon = "run"
command = "bash scripts/codex-cleanup.sh --full"
```

## 3. Clean

Path:

```bash
scripts/codex-cleanup.sh
```

Script:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

echo "[codex-cleanup] repo: $REPO_ROOT"

echo "[codex-cleanup] running turbo clean when available"
if command -v pnpm >/dev/null 2>&1; then
  pnpm exec turbo clean >/dev/null 2>&1 || pnpm turbo clean >/dev/null 2>&1 || true
fi

echo "[codex-cleanup] removing generated build/test/cache outputs"
rm -rf \
  .turbo \
  .next \
  .cache \
  coverage \
  playwright-report \
  test-results \
  .codex-artifacts \
  apps/*/.next \
  apps/*/.turbo \
  apps/*/.cache \
  apps/*/coverage \
  apps/*/playwright-report \
  apps/*/test-results \
  packages/*/.turbo \
  packages/*/.cache \
  packages/*/coverage \
  packages/*/dist

find . \
  -path './.git' -prune -o \
  -path './node_modules' -prune -o \
  -path './apps/*/node_modules' -prune -o \
  -path './packages/*/node_modules' -prune -o \
  -name '*.tsbuildinfo' -type f -delete

i

*(Answer truncated — 3561 chars total)*
