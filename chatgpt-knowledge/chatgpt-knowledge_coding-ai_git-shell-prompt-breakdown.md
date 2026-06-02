---
title: "Git shell prompt breakdown"
type: guide
created: 2025-12-20
updated: 2025-12-20
source: chatgpt-export
topic: coding-ai
message_count: 6
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# Git shell prompt breakdown

> **Source:** ChatGPT conversation
> **Date:** 2025-12-20T05:24:08Z
> **Messages:** 6
> **Topic:** coding-ai

## Question

Git: > jovie@0.1.0 next:proxy-guard /Users/timwhite/Documents/GitHub/TBF/Jovie

## Answer

Mr. White, that line is your **shell prompt**, not an error. It summarizes your current Git and Node project state.

Breakdown:

- **`jovie@0.1.0`**  
  The Node.js package name and version from `package.json`.

- **`next:proxy-guard`**  
  An npm script currently running or the active script context (likely `next` with a custom name `proxy-guard`).

- **`/Users/timwhite/Documents/GitHub/TBF/Jovie`**  
  Your current working directory.

- **`Git:` (implied by your theme)**  
  Indicates this directory is a Git repository. Your prompt theme likely also shows branch/status elsewhere (or only when dirty).

If you were expecting output (e.g., from `git status`, `npm run`, or `next dev`) and didn’t get it, paste the **full command you ran and any output below this line**.

## Question

getting this when cursor tries to commit

## Answer

Mr. White, I need the **exact error message** Cursor is showing.

What you pasted earlier is only your **terminal prompt**, not the commit failure. Cursor’s Git commit errors usually include one of these (but I won’t guess):

- `error: gpg failed to sign the data`
- `nothing to commit, working tree clean`
- `pre-commit hook failed`
- `husky - pre-commit hook exited with code 1`
- `permission denied`
- `fatal: not a git repository`
- `Author identity unknown`

Please paste **verbatim**:
- The **Cursor commit popup error**, or  
- The **full terminal output** if Cursor opens one when committing.

Once I see the exact text, I’ll tell you precisely:
- what’s broken,
- why Cursor is triggering it,
- and the minimal fix (no hand-waving).

## Question

> git -c user.useConfigOnly=true commit --quiet --allow-empty-message --file -

> jovie@0.1.0 next:proxy-guard /Users/timwhite/Documents/GitHub/TBF/Jovie
> node scripts/next-proxy-guard.mjs

[STARTED] Backing up original state...
[COMPLETED] Backed up original state in git stash (fb0bcb36)
[STARTED] Running tasks for staged files...
[STARTED] package.json — 25 files
[STARTED] drizzle/migrations/**/*.{sql,ts} — 0 files
[STARTED] *.{js,jsx,ts,tsx} — 23 files
[STARTED] *.{json,css} — 1 file
[STARTED] ignore — 0 files
[SKIPPED] drizzle/migrations/**/*.{sql,ts} — no files
[SKIPPED] ignore — no files
[STARTED] biome format --write --no-errors-on-unmatched
[STARTED] biome format --write --no-errors-on-unmatched
[COMPLETED] biome format --write --no-errors-on-unmatched
[COMPLETED] *.{json,css} — 1 file
[COMPLETED] biome format --write --no-errors-on-unmatched
[STARTED] eslint --fix --max-warnings=0 --no-warn-ignored --cache --cache-location .eslintcache
[COMPLETED] eslint --fix --max-warnings=

## Answer

Mr. White, this is **not a Git or Cursor bug**.  
Your commit is being **blocked by `commitlint` via Husky**.

### What’s happening (factually)
- Cursor runs:  
  `git commit --file -` (it pipes the commit message)
- Husky’s **`commit-msg` hook** runs `commitlint`
- Your commit message **violates the rule**:

```
body-max-line-length: 100 characters
```

Specifically, **one line in the commit body exceeds 100 chars**, so the hook exits with code 1 and Git aborts the commit.

### Why Cursor triggers this
Cursor auto-generates **long, paragraph-style commit bodies**.  
Your repo enforces **Conventional Commits + strict formatting**.  
They are incompatible unless you shorten the body.

---

## Minimal, correct fix (recommended)

### Option 1 — Shorten the commit body (best practice)

Edit the commit message so **every body line ≤ 100 chars**.

Example (safe):

```
chore: update test performance baseline and optimize test setup

- Update performance metrics after recent improvements
- Streamline test setup and remove unnecessary mocks
- Centralize cleanup logic in setup
- Hoist shared mocks and ensure browser globals load correctly
```

Then commit again.

---

## Fast bypass (when you know what you’re doing)

If you intentionally want to skip checks:

```bash
git commit --no-verify
```

⚠️ This bypasses **all** Husky hooks (lint, tests, formatting).

---

## Structural fix (if Cursor keeps failing)

If you want Cursor to stop generating verbose bodies:

- Use **short subject + bullet points**
- Or relax commitlint:

```js
// commitlint.config.js
rules: {
  'body-max-line-length': [2, 'always', 120],
}
```

---

### Bottom line
✔ Git is fine  
✔ Cursor is fine  
❌ Your commit message violates enforced policy  

If you want, paste your **commitlint config** and I’ll tell you exactly how strict your repo is and whether it matches your workflow.
