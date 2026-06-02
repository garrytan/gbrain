---
title: "Update Branch Behind Scenes"
type: guide
created: 2026-01-18
updated: 2026-01-18
source: chatgpt-export
conversation_id: 696d51d7-9d28-8327-ad5c-54af6e958aa5
message_count: 2
tags: [chatgpt, import, code]
---
# Update Branch Behind Scenes

> Conversation ID: 696d51d7-9d28-8327-ad5c-54af6e958aa5
> Created: 2026-01-18T21:34:31Z
> Updated: 2026-01-18T21:35:01Z
> Messages: 2

---

## User

Explain what’s happens behind the scenes when I click update branch on a pr 

---

## Assistant

When you click **“Update branch”** on a pull request (PR), GitHub (or whatever host you’re using) is basically making your PR branch “catch up” with the PR’s base branch (often `main`) so it can merge cleanly and pass checks.

What happens depends on the repo settings and button behavior, but behind the scenes it’s one of these two operations:

## 1) Merge base → PR branch (most common)
GitHub creates a new merge commit on your PR branch that merges the latest base branch into it.

Conceptually:
- Base branch: `main`
- PR branch: `feature`

It does:
- fetch latest `main`
- create a merge commit on `feature` with parents `(feature_head, main_head)`
- push that merge commit to your PR branch

Result:
- Your PR gets a new commit like “Merge branch 'main' into feature”
- The PR now includes the latest `main` changes *without rewriting history*
- CI re-runs because the PR HEAD changed

Equivalent local commands (conceptually):
```bash
git checkout feature
git fetch origin
git merge origin/main
git push origin feature
```

## 2) Rebase PR branch onto base (less common / setting-dependent)
Some setups (or other hosts like GitLab / Bitbucket, or certain GitHub configurations) “update” by rebasing instead of merging.

It does:
- take your PR commits
- replay them on top of the latest `main`
- force-push the rewritten PR branch

Result:
- A clean linear history
- Commit SHAs change (because rebasing rewrites commits)
- Any collaborators on the branch can get disrupted unless coordinated

Equivalent local commands:
```bash
git checkout feature
git fetch origin
git rebase origin/main
git push --force-with-lease origin feature
```

## What GitHub actually does in the PR UI (important detail)
Even before you press anything, GitHub often computes a **temporary “test merge”** (a synthetic merge commit in the background) to answer:
- “Would this PR merge cleanly right now?”
- “What would the merged code look like for CI?”

That synthetic merge is used for mergeability status and checks, but it is *not* your branch history.

When you click **Update branch**, you’re asking GitHub to make that catch-up **real by pushing commits to the PR branch** (merge commit or rebase result), so the PR branch itself contains the updated base changes.

## Why the button sometimes isn’t available
“Update branch” typically appears when:
- the PR branch is behind the base branch, and/or
- there are merge conflicts or required policies like “Require branches to be up to date before merging”

It may be disabled if:
- you don’t have permission to push to the PR branch (common on forks)
- branch protection disallows the needed operation
- conflicts require manual resolution

## Side effects you’ll notice
- **New commit(s)** appear on the PR branch (merge) *or* existing commits get new SHAs (rebase).
- **Checks restart** (new HEAD commit).
- **Merge conflicts** may be resolved automatically or block the update; if blocked, you’ll need to fix locally (or via the web conflict editor if offered).

If you tell me whether you’re on **GitHub** and whether your repo uses **“Require branches to be up to date before merging”** (and whether you see a merge commit or rewritten commits after clicking), I can tell you which of the two it’s doing in your case, Mr. White.
