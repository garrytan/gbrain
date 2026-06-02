---
title: "Cloud Code Node Modules"
type: note
created: 2026-01-21
updated: 2026-01-21
source: chatgpt-export
conversation_id: 6970fba7-fa54-8329-9f9d-331e10efecb4
message_count: 2
tags: [chatgpt, import, code]
---
# Cloud Code Node Modules

> Conversation ID: 6970fba7-fa54-8329-9f9d-331e10efecb4
> Created: 2026-01-21T16:15:36Z
> Updated: 2026-01-21T18:22:39Z
> Messages: 2

---

## User

cloud code cloud missing node modules

---

## Assistant

Mr. White — this usually means your **Cloud Code deployment does not include installed dependencies**. Common causes and fixes below (Node.js / Parse-style Cloud Code).

### Most common causes
1. **`node_modules` not installed before deploy**
   - Cloud runtimes don’t magically install deps unless configured.

2. **`node_modules` excluded**
   - `.gitignore`, `.npmignore`, or platform rules exclude it.

3. **Wrong Node version**
   - Native modules fail to install/build on the cloud runtime.

4. **Platform expects install-at-build**
   - Some providers require `package.json` only, not committed `node_modules`.

---

### Fixes (pick what matches your platform)

#### A. Platform installs deps for you (most common)
- **Do NOT upload `node_modules`**
- Ensure:
  ```bash
  package.json
  package-lock.json
  ```
- Set Node version explicitly:
  ```json
  {
    "engines": { "node": "18.x" }
  }
  ```
- Redeploy.

#### B. Platform expects bundled deps
- Run locally:
  ```bash
  rm -rf node_modules
  npm ci --only=production
  ```
- Ensure `node_modules` is **not ignored**
- Deploy including `node_modules`.

#### C. Native modules failing
- Avoid native deps if possible.
- Or rebuild for Linux:
  ```bash
  npm ci --only=production --platform=linux --arch=x64
  ```

#### D. Wrong entry path
- Cloud Code often expects:
  ```
  cloud/
    main.js
  ```
- Imports must be relative to deployed structure.

---

### Quick checklist
- `require()` path correct
- Dependency listed in **dependencies**, not devDependencies
- Node version matches cloud runtime
- Fresh deploy after install

If you tell me **which platform** (Parse Server, Back4App, AWS, GCP, etc.) and **error message**, I’ll give you the exact fix.
