---
title: "Doppler pnpm setup"
type: note
created: 2026-02-04
updated: 2026-02-05
source: chatgpt-export
conversation_id: 69839a29-8e64-8327-bda5-6b1f8871f134
message_count: 2
tags: [chatgpt, import, code]
---
# Doppler pnpm setup

> Conversation ID: 69839a29-8e64-8327-bda5-6b1f8871f134
> Created: 2026-02-04T19:12:42Z
> Updated: 2026-02-05T07:22:48Z
> Messages: 2

---

## User

doppler and pnpm setup script

---

## Assistant

Got it, Mr. White. Here’s a **clean, practical setup script** for **Doppler + pnpm**, suitable for local dev and CI.

---

## 1) One-time prerequisites
- Doppler CLI installed
- pnpm installed
- Doppler project + config already created

---

## 2) `setup.sh` (local dev friendly)

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- Config ---
DOPPLER_PROJECT="your-project"
DOPPLER_CONFIG="dev"
NODE_VERSION="20"

echo "▶ Checking Doppler auth..."
doppler me >/dev/null

echo "▶ Setting Doppler project/config..."
doppler setup \
  --project "$DOPPLER_PROJECT" \
  --config "$DOPPLER_CONFIG" \
  --no-interactive

echo "▶ Enabling Corepack & pnpm..."
corepack enable
corepack prepare pnpm@latest --activate

echo "▶ Installing dependencies..."
pnpm install

echo "▶ Done. Run with:"
echo "doppler run -- pnpm dev"
```

Make executable:
```bash
chmod +x setup.sh
```

---

## 3) `package.json` scripts (recommended)

```json
{
  "scripts": {
    "dev": "doppler run -- pnpm exec next dev",
    "build": "doppler run -- pnpm build",
    "start": "doppler run -- pnpm start"
  }
}
```

This keeps **secrets injection consistent** across all commands.

---

## 4) CI example (GitHub Actions)

```yaml
- name: Install Doppler
  run: curl -Ls https://cli.doppler.com/install.sh | sh

- name: Install pnpm
  run: corepack enable

- name: Install deps
  run: pnpm install

- name: Build
  env:
    DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN }}
  run: doppler run -- pnpm build
```

---

## 5) Common best practices (facts, no fluff)
- **Never** commit `.env` when using Doppler
- Use **one Doppler config per environment** (`dev`, `staging`, `prod`)
- Prefer `doppler run -- <command>` over exporting env vars
- Pin pnpm via Corepack for reproducibility

---

If you want:
- a **monorepo (pnpm workspace) variant**
- a **Dockerfile version**
- or a **Next.js / Node / Vite–specific script**

Say the word.


## See Also
- [[chatgpt/chatgpt_accelerator-tracking-setup]]
- [[chatgpt/chatgpt_ai-ops-setup-inquiry]]
- [[chatgpt/chatgpt_ai-setup-instructions]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part1]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part10]]
