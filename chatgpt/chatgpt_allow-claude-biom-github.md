---
conversation_id: 69608de2-525c-8326-82b7-63f88a412bbd
created: 2026-01-09
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Allow Claude Biom GitHub
type: guide
updated: 2026-01-09
---

# Allow Claude Biom GitHub

> Conversation ID: 69608de2-525c-8326-82b7-63f88a412bbd
> Created: 2026-01-09T05:11:06Z
> Updated: 2026-01-09T05:12:16Z
> Messages: 4

---

## User

allow claude code to run biom in github actions

---

## Assistant

Mr. White,

To allow **Claude Code** to run **Biom** inside **GitHub Actions**, you must explicitly permit it. By default, Claude Code runs in a restricted (deny-by-default) mode.

### Option 1 — One-time allow (interactive)
```bash
claude --allow-run biom
```
This grants permission for the current session only.

### Option 2 — Project config (recommended for CI)
Create or edit:

**`.claude/config.yaml`**
```yaml
allow:
  run:
    - biom
```

This is the correct approach for **GitHub Actions**, since CI is non-interactive.

### Option 3 — Inline command allow
```bash
claude --allow-run biom run
```
Useful for quick tests, not ideal for CI.

---

### Minimal GitHub Actions example
```yaml
name: Claude Biom
on: [push]

jobs:
  biom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Run Biom
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: claude run biom
```

---

### Key constraints (facts)
- Claude Code **will not** execute binaries unless explicitly allowed.
- Allow-lists are **command-name based**, not path-based.
- CI requires config or flags—no prompts.
- Secrets **must** be injected via GitHub Secrets.

If you want tighter security, you can scope allows to a wrapper script instead of the raw `biom` binary.

---

## User

like if i comment claude to fix a PR on github website how can i get it to run biome and fix lint with biome

---

## Assistant

Mr. White,

To make **Claude fix a PR by running Biome lint/format when you comment on GitHub**, you need **three things wired together**:

1. **Claude Code running in GitHub Actions**
2. **Biome explicitly allowed**
3. **A comment-triggered workflow that runs Claude on the PR**

Below is the **correct, minimal, production-safe setup**.

---

## 1. Allow Biome for Claude (required)

Claude **will refuse** to run Biome unless it’s allow-listed.

**`.claude/config.yaml`**
```yaml
allow:
  run:
    - biome
```

If Biome is invoked via `npx biome`, allow that too:
```yaml
allow:
  run:
    - biome
    - npx
```

---

## 2. Comment → Action trigger

Use a workflow triggered by **PR comments**, filtered to a magic phrase like:

> `@claude fix lint`

### `.github/workflows/claude-fix.yml`
```yaml
name: Claude Fix PR

on:
  issue_comment:
    types: [created]

jobs:
  fix:
    if: >
      github.event.issue.pull_request &&
      contains(github.event.comment.body, '@claude fix lint')

    runs-on: ubuntu-latest

    permissions:
      contents: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4
        with:
          ref: refs/pull/${{ github.event.issue.number }}/head

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install deps
        run: npm ci

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Claude fix with Biome
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude run "
            Run 'biome check --write .' to fix lint and formatting.
            Commit all fixes with message 'chore: fix biome lint'.
          "

      - name: Push fixes
        run: git push
```

---

## 3. How it works (important details)

- Comment on the PR **on the entity["company","GitHub","code hosting platform"] website**
- Action checks out the PR branch
- Claude runs **Biome locally**
- Claude commits fixes
- Action pushes back to the same PR

No bots, no apps, no webhooks required.

---

## 4. Biome must already exist

Claude does **not** install Biome unless you tell it to.

You must already have one of:
- `biome` in `devDependencies`
- or a local `node_modules/.bin/biome`

Recommended:
```json
"devDependencies": {
  "@biomejs/biome": "^1.6.0"
}
```

---

## 5. Common failure causes (facts)

| Issue | Cause |
|-----|------|
| Claude refuses to run biome | Missing `.claude/config.yaml` |
| Action runs but no changes | Biome already clean |
| Push fails | Missing `contents: write` |
| Nothing triggers | Comment text mismatch |
| Works locally, fails CI | Biome not installed |

---

## 6. Hardening (optional but smart)

- Restrict who can trigger (check `comment.author_association`)
- Use a wrapper script instead of raw `biome`
- Add `--changed` to limit scope
- Require `@claude fix biome` exact match

---

If you want, I can:
- Lock this to org members only
- Add dry-run comments before commit
- Make Claude respond back with a summary
- Support **check-only vs fix**

Say the word.


**Topic:** [[chatgpt-clusters/coding_ai]]
