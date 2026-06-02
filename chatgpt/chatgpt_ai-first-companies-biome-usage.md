---
title: "AI-first Companies Biome Usage"
type: note
created: 2025-12-27
updated: 2025-12-27
source: chatgpt-export
conversation_id: 694f5849-2418-832a-b595-b2d755dd7d2c
message_count: 2
tags: [chatgpt, import, code]
---
# AI-first Companies Biome Usage

> Conversation ID: 694f5849-2418-832a-b595-b2d755dd7d2c
> Created: 2025-12-27T03:55:04Z
> Updated: 2025-12-27T03:59:15Z
> Messages: 2

---

## User

I want to concrete examples of big ai first companies like antrhopic or vercel or open ai or any of the fat growing ai companies use for biome settings and rules or pre-commit hooks etc.

---

## Assistant

Mr. White — here are **real, public** examples of “AI-first / fast-growing” companies using **Biome** + git hooks patterns, plus copy-pasteable setups.

## Concrete public examples

- **OpenAI (codex repo)**: their `bun` pipeline runs Biome in CI mode, e.g. `bunx biome ci src tests tools docs`. citeturn23view0  
- **Vercel (flags repo)**: the repo has a `biome.json` (Biome config) checked in. citeturn17search2turn7search0  
- **Hugging Face (aisheets repo)**: the repo has both `biome.json` **and** a `.husky/` directory (git hooks). citeturn14view1  
- **Jina AI (MCP repo)**: the repo includes `biome.json` at the root. citeturn14view0  

I didn’t find public Anthropic repos clearly showing Biome configs via web search (they may use different tooling or keep that internal).

## What these setups usually look like (copy/paste)

### 1) `biome.json` baseline (rules + formatting + git awareness)
Biome config lives in `biome.json` / `biome.jsonc`. citeturn18search9turn22view0  
Also, enabling git integration is a standard pattern. citeturn18search6

```jsonc
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": { "enabled": true, "clientKind": "git" },
  "files": { "ignoreUnknown": true },
  "formatter": { "enabled": true, "lineWidth": 100 },
  "linter": { "enabled": true }
}
```

### 2) `package.json` scripts (local vs CI)
Biome has `check` (dev) and `ci` (CI-optimized). citeturn18search1turn19search0

```jsonc
{
  "scripts": {
    "lint": "biome check --write .",
    "lint:ci": "biome ci ."
  }
}
```

### 3) Pre-commit hook (Husky) that only checks staged files
Biome `check` supports `--staged`. citeturn19search0turn19search1

`.husky/pre-commit`:
```sh
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx biome check --staged --write
git add -A
```

If you want, tell me your stack (**pnpm/yarn/npm/bun**, monorepo or not, TS/JS) and I’ll tailor a *battle-tested* `biome.json` + hook setup (including per-folder overrides for `tests/**`, generated code, etc.).


## See Also
- [[chatgpt/chatgpt_airbnb-ai-usage]]
- [[chatgpt/chatgpt_api-usage-and-plan-optimization]]
- [[chatgpt/chatgpt_backslash-usage-overview]]
- [[chatgpt/chatgpt_capture-one-usage]]
- [[chatgpt/chatgpt_cheapest-codex-usage-options]]
