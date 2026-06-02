---
title: "New chat"
type: note
created: 2025-08-30
updated: 2025-08-30
source: chatgpt-export
conversation_id: 68b33649-c93c-832b-b529-c671785ce4ac
message_count: 2
tags: [chatgpt, import, code]
---
# New chat

> Conversation ID: 68b33649-c93c-832b-b529-c671785ce4ac
> Created: 2025-08-30T17:35:06Z
> Updated: 2025-08-30T17:35:35Z
> Messages: 2

---

## User

neon github intergration

---

## Assistant

​To integrate Neon with GitHub, follow these steps:

---

### 1. Install the Neon GitHub Integration

1. In the Neon Console, navigate to your project's **Integrations** page.
2. Locate the **GitHub** card and click **Add**.
3. Click **Install GitHub App**.
4. Select the GitHub account and repository to connect.
5. Click **Connect**.

This process sets up the `NEON_API_KEY` secret and `NEON_PROJECT_ID` variable in your GitHub repository citeturn0search1.

---

### 2. Add the GitHub Actions Workflow

Create a workflow file at `.github/workflows/neon_workflow.yaml` with the following content:


```yaml
name: Create/Delete Branch for Pull Request

on:
  pull_request:
    types: [opened, reopened, synchronize, closed]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}

jobs:
  setup:
    name: Setup
    outputs:
      branch: ${{ steps.branch_name.outputs.current_branch }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Get branch name
        id: branch_name
        uses: tj-actions/branch-names@v8
```


This workflow automates the creation and deletion of Neon database branches in response to pull request events citeturn0search0.

---

### 3. Utilize Neon GitHub Actions

Neon provides GitHub Actions to manage database branches:

- **Create Branch Action**: Creates a new database branch.
- **Delete Branch Action**: Deletes a specified database branch.
- **Reset Branch Action**: Resets a branch to the latest state of its parent.
- **Schema Diff Action**: Compares schemas between branches and posts the diff as a pull request comment.

These actions can be integrated into your workflows by referencing them in your `.github/workflows` YAML files citeturn0search2.

---

For detailed instructions and additional customization options, refer to the [Neon GitHub Integration Guide](https://neon.tech/docs/guides/neon-github-integration). 


## See Also
- [[chatgpt/chatgpt_ai-chat-instrumentation-tools]]
- [[chatgpt/chatgpt_ai-chat-security-test]]
- [[chatgpt/chatgpt_ai-chat-test]]
- [[chatgpt/chatgpt_ai-sdk-chat-development]]
- [[chatgpt/chatgpt_chat-input-specs]]
