---
title: "Git worktrees and pushing"
type: guide
created: 2026-02-23
updated: 2026-02-23
source: chatgpt-export
conversation_id: 699bede5-e4c8-8333-a4e4-289deed9e620
message_count: 4
tags: [chatgpt, import, code]
---
# Git worktrees and pushing

> Conversation ID: 699bede5-e4c8-8333-a4e4-289deed9e620
> Created: 2026-02-23T06:04:52Z
> Updated: 2026-02-23T06:09:14Z
> Messages: 4

---

## User

Yo dawg, do git worktrees get included when I push, or are they get ignored by default?

---

## Assistant

No — **Git worktrees are not “pushed”** and they’re not ignored either.

They simply **don’t exist on the remote at all**.

Here’s why:

### What a worktree actually is
A Git worktree is just:
- Another working directory
- Attached to the same local repository
- Pointing to a branch or commit

It’s a **local filesystem construct**, not part of the Git object database.

---

### What *does* get pushed
When you run:

```bash
git push
```

Git pushes:
- Commits
- Trees
- Blobs
- Tags (if specified)
- Branch references

It does **not** push:
- Your working directory
- Your `.git/worktrees` folder
- Any worktree metadata

---

### What happens if someone clones your repo?
They will:
- Get the commits and branches you pushed
- **Not** get your worktrees
- Create their own worktrees if they want

---

### Key takeaway
Worktrees are purely local workflow tools.  
They have **zero effect** on remotes.

---

If you want, I can also explain how worktrees affect branch deletion and pruning — that’s where people usually get tripped up.

---

## User

Our type check is currently 80 seconds. Um, should we go incremental or use build cache or anything, or like, is that fine?

---

## Assistant

Mr. White — 80s is *usually* too slow for “every PR / every push” type-checking. You don’t need to accept it; you can almost always cut it a lot with the right combo of **incremental + caching + scoping**.

Here’s the decision tree that works in practice.

## What “fine” looks like
- **Pre-push / local inner loop:** 5–15s (or people stop running it)
- **PR required check:** ~10–30s is tolerable
- **Main branch / nightly full:** can be longer

If your *required* PR check is 80s, I’d optimize.

## Do incremental vs build cache?
Do both, but in the right order.

### 1) Scope the check (highest ROI)
If you’re type-checking the whole monorepo on every PR, you’re paying unnecessary cost.
- Run type-check only for **affected packages** / changed paths
- Keep a scheduled (nightly) full type-check as a safety net

This alone can drop 80s to 10–30s on most PRs.

### 2) Add CI caching (easy win)
Cache whatever your typechecker reuses:
- dependency installs (obvious)
- tool caches (common)
- any “incremental state” directories (if your tool supports it)

This is especially effective in CI where cold starts are common.

### 3) Use incremental mode (situational, but often worth it)
Incremental helps most when:
- PRs are small
- CI cache hit rate is good
- your typechecker actually benefits from saved state

If your CI is frequently cold / caches miss, incremental alone won’t save you much.

## Tool-specific guidance (quick heuristics)
Tell me which checker you use (TypeScript `tsc`, mypy/pyright, Flow, etc.) and CI (GitHub Actions, Buildkite, Circle) and I’ll give exact cache paths + config. Meanwhile, the common patterns:

- **TypeScript (`tsc`)**
  - Use project references + incremental builds (`tsBuildInfo`)
  - Cache the `*.tsbuildinfo` files
  - Consider `--pretty false` + `--noEmit` speed tweaks aren’t huge; structure is the big lever

- **Python**
  - **pyright** is already pretty fast; 80s suggests huge workspace or slow CI
  - **mypy** can benefit from incremental cache; cache `.mypy_cache`
  - Also consider running only on changed modules / packages

- **Monorepos**
  - Use a task runner with remote cache (Bazel / Pants / Nx / Turborepo) if you have many packages
  - If you’re not ready for that, “affected-only” + CI cache gets you 70% of the benefit

## A pragmatic setup I recommend
- **PR check:** affected-only typecheck + cached deps + cached typechecker state
- **Main branch:** full typecheck (cached) to catch cross-package drift
- **Nightly:** full clean typecheck (no cache) as a “truth run” if you’re paranoid

## How to know if it’s worth it (2 metrics)
1) **Cache hit rate** in CI (if <50%, fix caching before incremental)
2) **Median PR time** after scoping (if already <30s, stop there)

If you reply with:
- language/tooling (tsc? mypy? pyright?)
- repo shape (mono? how many packages?)
- CI provider

…I’ll tell you exactly what to turn on and what directories to cache, and what kind of speedup you should expect.


## See Also
- [[chatgpt/chatgpt_claude-code-worktrees-git]]
- [[chatgpt/chatgpt_claude-code-worktrees-overview]]
- [[chatgpt/chatgpt_claude-code-worktrees-setup]]
- [[chatgpt/chatgpt_claude-code-worktrees]]
- [[chatgpt/chatgpt_claude-desktop-worktrees]]
