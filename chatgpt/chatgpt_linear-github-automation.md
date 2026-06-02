---
title: "Linear GitHub Automation"
type: note
created: 2026-02-20
updated: 2026-02-20
source: chatgpt-export
conversation_id: 6998f4ec-d980-8331-8921-9e4246a7709b
message_count: 2
tags: [chatgpt, import, code]
---
# Linear GitHub Automation

> Conversation ID: 6998f4ec-d980-8331-8921-9e4246a7709b
> Created: 2026-02-20T23:58:09Z
> Updated: 2026-02-20T23:58:59Z
> Messages: 2

---

## User

when codex marks a task finished i can see it in linear with a complete statuus instead of working. is there a way to have it automatically moved to in review or better yet have a pr opened?

---

## Assistant

Yes. You can automate both status changes in entity["software","Linear","issue tracking software"] and PR creation in entity["software","GitHub","code hosting platform"] when Codex finishes a task.

You have three clean options:

---

## Option 1 — Use Linear’s GitHub Integration (Recommended)

Linear natively syncs issue state with PR activity.

### Setup

1. In Linear → **Settings → Integrations → GitHub**
2. Connect your repo.
3. Enable:
   - Auto-link PRs to issues
   - Update issue status when PR opens
   - Update issue status when PR merges

### Then:

If your branch or PR title contains the Linear issue ID (e.g. `ABC-123`):

- Opening a PR automatically moves the issue to **In Review**
- Merging the PR moves it to **Done**

This is the cleanest approach.

---

## Option 2 — Use GitHub Actions to Move Linear Issue to “In Review”

If Codex pushes commits but doesn’t open a PR, you can use a GitHub Action to:

1. Detect commit with Linear issue ID
2. Call Linear API
3. Move issue to a specific state

Basic flow:

- Trigger: `push`
- Parse commit message for `ABC-123`
- Call Linear GraphQL mutation `issueUpdate`

You’ll need:
- Linear API key
- State ID for “In Review”

If you want, I can generate the exact Action YAML.

---

## Option 3 — Automatically Open a PR When Codex Pushes

If Codex pushes to a feature branch, add this GitHub Action:

```yaml
name: Auto PR

on:
  push:
    branches:
      - "feature/**"

jobs:
  pr:
    runs-on: ubuntu-latest
    steps:
      - uses: repo-sync/pull-request@v2
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          source_branch: ${{ github.ref_name }}
          destination_branch: main
```

Now:

- Codex pushes → PR auto-creates
- PR references `ABC-123`
- Linear auto-moves to **In Review**

---

## Best Architecture (Cleanest Workflow)

Ideal automation stack:

1. Codex works on `feature/ABC-123-description`
2. Codex commits with message containing `ABC-123`
3. GitHub Action auto-creates PR
4. Linear GitHub integration moves issue → **In Review**
5. Merge PR → issue auto → **Done**

Zero manual steps.

---

## What You Cannot Do Directly

Codex itself cannot natively:
- Change Linear states
- Open PRs (unless wrapped in CI automation)

It must go through:
- GitHub integration
- GitHub Actions
- Or Linear API automation

---

If you tell me:
- GitHub or GitLab?
- How Codex pushes (branch naming pattern?)
- What your Linear states are named?

I’ll design the exact production-ready automation setup.
