---
title: "Automate lint typecheck"
type: note
created: 2025-12-11
updated: 2025-12-11
source: chatgpt-export
conversation_id: 693b2b48-5200-832f-b98e-2b20c75404fc
message_count: 2
tags: [chatgpt, import, code]
---
# Automate lint typecheck

> Conversation ID: 693b2b48-5200-832f-b98e-2b20c75404fc
> Created: 2025-12-11T20:36:25Z
> Updated: 2025-12-11T22:44:39Z
> Messages: 2

---

## User

set up cacade hooks to automate lint and typecheck fix after every change

---

## Assistant

Mr. White, here’s the cleanest and most common way to automate **lint** + **type-check** (and auto-fix lint) on every change using Git hooks.

## 1. Install tooling
Use **Husky** (Git hooks) + **lint-staged** (run only changed files):

```bash
npm install -D husky lint-staged
```

Enable Husky:

```bash
npx husky init
```

This creates `.husky/` and a pre-commit hook.

## 2. Configure lint-staged
Add to `package.json`:

```json
{
  "lint-staged": {
    "*.{js,ts,jsx,tsx}": [
      "eslint --fix",
      "prettier --write"
    ]
  }
}
```

If you don’t use Prettier, remove that line.

## 3. Add type-checking
You normally don’t want full TS type-check in `pre-commit` (too slow). Best practice:

- Run **eslint + prettier** on staged files (fast)
- Run full **type-check** in `pre-push` (slower, but ensures correctness)

Create hooks:

### `.husky/pre-commit`
```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

npx lint-staged
```

### `.husky/pre-push`
```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

npm run typecheck
```

Add a script:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

## 4. (Optional) Auto-run on every file save
If you meant **automate after every change**, not just Git commits:

### Option A — `eslint --fix` + `tsc --watch`
Run:

```bash
npm run dev
npm run lint:watch
npm run typecheck:watch
```

with scripts:

```json
{
  "scripts": {
    "lint:watch": "chokidar 'src/**/*.{ts,tsx,js,jsx}' -c 'eslint --fix {{path}}'",
    "typecheck:watch": "tsc --watch --noEmit"
  }
}
```

### Option B — Editor integration  
Let your IDE auto-fix on save + run TS server — fastest workflow.

---

If you tell me your stack (**React? Next.js? pnpm? turborepo?**), I’ll tailor the exact setup.
