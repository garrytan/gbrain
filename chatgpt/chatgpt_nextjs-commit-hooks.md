---
title: "Next.js commit hooks"
type: note
created: 2025-09-27
updated: 2025-09-27
source: chatgpt-export
conversation_id: 68d73a9a-a248-8328-8bf1-3a014a0ca8da
message_count: 3
tags: [chatgpt, import, code]
---
# Next.js commit hooks

> Conversation ID: 68d73a9a-a248-8328-8bf1-3a014a0ca8da
> Created: 2025-09-27T01:15:28Z
> Updated: 2025-09-27T01:16:17Z
> Messages: 3

---

## User

For our next.js ops site that's basically just a documentation site. What recommit hooks shoud we set?

---

## User

For our next.js ops site that's basically just a documentation site. What precommit hooks shoud we set?

---

## Assistant

Mr. White — here’s a tight, fast setup that won’t slow commits but still keeps the Next.js docs repo clean.

# What to run where
**pre-commit (fast, staged files only)**
- `prettier` — format everything
- `eslint` — JS/TS/TSX with `--fix`
- `markdownlint-cli2` — `.md/.mdx`
- `cspell` — spell-check `.md/.mdx` (project dictionary)

**pre-push (slower, whole repo)**
- `tsc --noEmit` — full typecheck
- `eslint .` — full lint
- `vitest` (or skip if no tests)
- `secretlint` — simple secret scan

**commit-msg**
- `commitlint` — enforce Conventional Commits

# Copy-paste setup (pnpm)
```bash
pnpm add -D husky lint-staged eslint prettier typescript \
 markdownlint-cli2 cspell secretlint secretlint-rule-preset-recommend \
 @commitlint/cli @commitlint/config-conventional vitest

pnpm dlx husky init
```

**package.json (scripts + lint-staged)**
```json
{
  "scripts": {
    "prepare": "husky",
    "format": "prettier --cache --write .",
    "lint": "eslint . --max-warnings=0",
    "lint:md": "markdownlint-cli2 \"**/*.mdx?\" \"!node_modules\"",
    "spell": "cspell --no-progress --no-must-find-files \"**/*.{md,mdx}\"",
    "typecheck": "tsc --noEmit",
    "test": "vitest -r",
    "secrets": "secretlint \"**/*\""
  },
  "lint-staged": {
    "*.{js,jsx,ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{md,mdx}": ["markdownlint-cli2", "cspell --no-progress --no-must-find-files", "prettier --write"],
    "*.{json,yml,yaml,css,scss}": ["prettier --write"]
  }
}
```

**.husky/pre-commit**
```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"
pnpm lint-staged
```

**.husky/pre-push**
```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"
pnpm typecheck
pnpm lint
pnpm test -r || true
pnpm secrets
```

**.husky/commit-msg**
```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"
pnpm commitlint --edit "$1"
```

**commitlint.config.cjs**
```js
module.exports = { extends: ['@commitlint/config-conventional'] };
```

**.cspell.json** (seed with your project terms)
```json
{
  "version": "0.2",
  "language": "en",
  "words": ["Next.js", "Jovie", "Vault", "KDS", "Sysco"]
}
```

**.secretlintrc.json**
```json
{ "rules": { "@secretlint/secretlint-rule-preset-recommend": true } }
```

# Notes
- Keep typecheck in **pre-push**, not pre-commit (speed). Next’s `build` will also type-check, but running `tsc` pre-push catches issues earlier.
- If you don’t have tests, drop `vitest` lines.
- If you use MDX/remark plugins with front-matter rules, add those checks to CI, not pre-commit.

That’s it—clean commits, safe pushes, minimal friction.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
