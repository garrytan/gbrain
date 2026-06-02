---
title: "Pnpm in CI"
type: note
created: 2025-12-22
updated: 2025-12-22
source: chatgpt-export
conversation_id: 694974d5-ab44-832f-abe8-a9efba3ab164
message_count: 2
tags: [chatgpt, import, code]
---
# Pnpm in CI

> Conversation ID: 694974d5-ab44-832f-abe8-a9efba3ab164
> Created: 2025-12-22T16:41:58Z
> Updated: 2025-12-22T16:43:09Z
> Messages: 2

---

## User

pnpm in ci

---

## Assistant

Here’s a **practical, concise guide to using `pnpm` in a CI environment** (like GitHub Actions, GitLab CI, Azure, etc.):

---

## 📌 CI-Friendly pnpm Installation

1. **Install pnpm first** (runner doesn’t have it by default):

   **GitHub Actions example:**
   ```yaml
   - uses: pnpm/action-setup@v4
     with:
       version: 10  # optional: use pnpm version from package.json instead
   ```  
   This sets up pnpm in the CI runner. citeturn0search2

2. **Install Node.js** (required):
   ```yaml
   - uses: actions/setup-node@v4
     with:
       node-version: '20'
       cache: 'pnpm'  # speeds up installs by caching
   ```  
   Caching greatly speeds CI by reusing dependencies. citeturn0search26

---

## 📦 Installing Dependencies (Equivalent to `npm ci`)

- Use pnpm’s install with frozen lockfile to ensure deterministic installs (CI will fail if lockfile doesn’t match `package.json`):
  ```sh
  pnpm install --frozen-lockfile
  ```
  This is effectively pnpm’s answer to `npm ci`. citeturn0search3

- In native CI mode, pnpm already defaults to `--frozen-lockfile` behavior, so plain `pnpm install` behaves like a “locked” install. citeturn0search1

---

## 📁 Example: GitHub Actions CI Workflow

```yaml
name: CI

on:
  push:
    branches: ['main']
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - run: pnpm test
```

This checks out code, sets up pnpm + Node, installs deps, and runs tests in CI. citeturn0search2turn0search26

---

## ⚙️ Caching Tips

- **pnpm store** cache can be saved between CI runs to avoid re-downloading packages:
  - On GitHub Actions: `actions/cache` with the pnpm store path (e.g., `~/.pnpm-store`) keyed by `pnpm-lock.yaml` hash. citeturn0search5
- Many CI providers support caching. For GitLab, stash both the pnpm store and `node_modules` as appropriate.

---

## 🛠 Notes & Best Practices

- Always commit **pnpm-lock.yaml** — CI installs rely on this for reproducible builds. citeturn0search12  
- If lockfile and `package.json` are out of sync, `--frozen-lockfile` will throw errors (intended). citeturn0search1  
- Use the version in `package.json#packageManager` to sync dev/CI pnpm versions automatically. citeturn0search2

---

If you want a ready-to-copy CI config for a platform other than GitHub Actions (GitLab, Azure, CircleCI, etc.), just tell me your target!
