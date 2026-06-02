---
title: "Grant commit permissions"
type: note
created: 2025-09-01
updated: 2025-09-01
source: chatgpt-export
conversation_id: 68b6097e-091c-8325-9069-cedd2063a5a9
message_count: 2
tags: [chatgpt, import, code]
---
# Grant commit permissions

> Conversation ID: 68b6097e-091c-8325-9069-cedd2063a5a9
> Created: 2025-09-01T21:00:56Z
> Updated: 2025-09-01T21:01:12Z
> Messages: 2

---

## User

How do i give claude permission to make commits when it edits prs?

---

## Assistant

To let Claude (or any GitHub App/bot) push commits into your pull requests, you need to grant it write access through GitHub’s permission model. There are two common setups:  

---

### 1. If Claude is running as a GitHub App (preferred)
- Go to your repo’s **Settings → Integrations → GitHub Apps**.  
- Install the Claude app (or your custom app).  
- Under **Repository access**, give it access to the repo.  
- Under **Repository permissions**, make sure it has:  
  - **Contents: Read & write** → lets it push commits.  
  - **Pull requests: Read & write** → lets it edit PRs.  

---

### 2. If Claude is committing through GitHub Actions
- Use a **fine-grained PAT (personal access token)** or a **GitHub App token** with `contents: write`.  
- Store that token as a secret in your repo (e.g. `CLAUDE_GITHUB_TOKEN`).  
- In your workflow, set `permissions` at the top:  
  ```yaml
  permissions:
    contents: write
    pull-requests: write
  ```
- Use that token in the step where Claude pushes commits:  
  ```yaml
  - name: Push changes
    run: |
      git config user.name "claude[bot]"
      git config user.email "claude[bot]@users.noreply.github.com"
      git add .
      git commit -m "Claude edits"
      git push
    env:
      GITHUB_TOKEN: ${{ secrets.CLAUDE_GITHUB_TOKEN }}
  ```

---

### 3. If Claude edits via comments/PR review
It won’t push directly, but you can use a workflow triggered on those comments (`issue_comment` or `pull_request_review`) that makes the changes and commits using the same `contents: write` token.

---

👉 The key is: Claude (or the workflow on its behalf) must have **`contents: write`** and **`pull-requests: write`** permission in the repo. By default, the built-in `GITHUB_TOKEN` only has read access unless you expand it in the workflow `permissions`.

---

Mr. White, do you want Claude itself (via API) to push commits directly, or do you want a GitHub Action workflow that takes its edits and commits them automatically?
