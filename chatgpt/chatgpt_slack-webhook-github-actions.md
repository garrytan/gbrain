---
conversation_id: 6941c0ea-32a4-832b-831a-28c496de7a0e
created: 2025-12-16
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Slack webhook GitHub Actions
type: guide
updated: 2025-12-16
---

# Slack webhook GitHub Actions

**Related:** [[coding_devops]]

> Conversation ID: 6941c0ea-32a4-832b-831a-28c496de7a0e
> Created: 2025-12-16T20:28:27Z
> Updated: 2025-12-16T20:35:11Z
> Messages: 6

---

## User

SLACK WEBHOOK GITHUB ACTIONS

---

## Assistant

Here’s a **concise, practical guide** for sending Slack notifications from **GitHub Actions using a Slack webhook**.

---

## 1) **Create a Slack Incoming Webhook**

1. Go to **https://api.slack.com/apps** and create a new app (or use an existing one).  
2. In **OAuth & Permissions**, add the **Incoming Webhooks** feature and enable it.  
3. Add a new webhook to the workspace, select the channel you want notifications in.  
4. Copy the webhook URL (looks like `https://hooks.slack.com/services/...`).  
   Store this — treat it like a secret. citeturn0search1turn0search17

---

## 2) **Add the Webhook as a GitHub Secret**

In your GitHub repo:

Settings → **Secrets and variables** → **Actions** → **New repository secret**

- **Name:** `SLACK_WEBHOOK_URL`  
- **Value:** your Slack webhook URL

---

## 3) **Use It in a GitHub Actions Workflow**

Create a workflow file under `.github/workflows/notify-slack.yml` like this:

```yaml
name: Notify Slack

on:
  push:
    branches: [main]  # or whatever event you want

jobs:

  slack_notification:
    runs-on: ubuntu-latest
    steps:
      - name: Send Slack message
        uses: slackapi/slack-github-action@v2.1.1
        with:
          webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
          webhook-type: incoming-webhook
          payload: |
            {
              "text": "GitHub Actions run on branch: ${{ github.ref }}. Status: ${{ job.status }}"
            }
```

**What this does:**
- Uses Slack’s official GitHub Action to post to your webhook.  
- Sends a simple JSON text message.  
- You can customize the `payload` with Slack’s Block Kit formatting if needed. citeturn0search1

---

## 4) **Conditional Notifications (Optional)**

If you want to notify only on success/failure:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      # your steps

  notify:
    runs-on: ubuntu-latest
    needs: build
    if: always()  # runs even if build fails
    steps:
      - name: Slack notification
        uses: slackapi/slack-github-action@v2.1.1
        with:
          webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
          webhook-type: incoming-webhook
          payload: |
            {
              "text": "Workflow *${{ github.workflow }}* finished with status: *${{ needs.build.result }}*"
            }
```

**Key points:**
- `needs: build` lets you reference the build’s result.  
- `if: always()` ensures the Slack step runs no matter what (useful for failure alerts). citeturn0search15

---

## Summary

1. **Slack webhook**: created via Slack app incoming-webhook.  
2. **GitHub secret**: store webhook URL as `SLACK_WEBHOOK_URL`.  
3. **Workflow step**: call a Slack action with the webhook and a payload.

This setup keeps secrets secure and lets you push custom Slack messages from your GitHub Actions. citeturn0search1

---

If you want a version that sends formatted **Block Kit** messages or includes job outputs like tests/results, tell me your format and I’ll tailor the YAML.

---

## User

or do we use a github slack app?

---

## Assistant

Mr. White — **use a Slack webhook unless you need deeper integration.**

### Short answer
- **Webhook → default choice (90% of cases)**
- **GitHub ↔ Slack App → only if you need richer features**

---

## Option 1: Slack Incoming Webhook (recommended)
**Use this when:**
- You only need notifications (builds, deploys, failures)
- One channel (or a few) is enough
- You want minimal setup and zero permissions risk

**Pros**
- Fast setup
- Least permissions
- Works perfectly with GitHub Actions
- No Slack OAuth, no bot tokens

**Cons**
- Cannot DM users
- Limited interactivity (no buttons that trigger actions)

👉 Best for CI/CD alerts, deploy notifications, failure pings.

---

## Option 2: GitHub Slack App (or Slack Bot App)
**Use this when you need:**
- Notifications to multiple channels dynamically
- DMs to users
- Rich Block Kit interactions (buttons, menus)
- Two-way interaction (e.g. “Approve deploy” button)
- Org-wide GitHub ↔ Slack integration

**Pros**
- More powerful
- Supports advanced workflows
- Centralized across repos/orgs

**Cons**
- More setup (OAuth, bot token, scopes)
- Broader permissions (higher risk)
- Overkill for simple notifications

---

## Decision Rule (simple)
- **CI/CD alerts only?** → **Webhook**
- **Human interaction or approvals in Slack?** → **Slack App**
- **Multiple repos + org-wide routing rules?** → **Slack App**

---

## Practical Recommendation
Start with **Incoming Webhooks**.  
You can always migrate to a Slack App later if requirements grow.

If you want, I can:
- Give you a **decision tree**
- Show a **secure Slack App setup** (minimal scopes)
- Compare **GitHub’s official Slack app vs custom Slack bot**

Just say which.

---

## User

is there an off the shelf slack app? because approving things from slack would be dope

---

## Assistant

Mr. White — **yes, and it’s already the standard.**

## ✅ Off-the-shelf option (use this)

### **GitHub ↔ Slack Official App**
**Name:** *GitHub for Slack*  
**Publisher:** GitHub (first-party)

This is the **only off-the-shelf app worth using** unless you need something very custom.

---

## What it does well (facts, not hype)

### ✅ Approvals from Slack
- Approve / comment on **pull requests**
- Review requests delivered to Slack
- Buttons + deep links back to GitHub
- Works with **CODEOWNERS + required reviewers**

### ✅ Notifications
- PRs, issues, deployments, workflows
- Per-channel repo subscriptions
- Per-user notifications

### ✅ Security
- OAuth handled by GitHub
- No webhook secrets in repos
- Fine-grained repo access
- Enterprise-ready

---

## What it **cannot** do (important)
- ❌ Cannot approve **GitHub Actions workflow steps**
- ❌ Cannot act as a general “Approve deploy” button
- ❌ Cannot trigger arbitrary CI logic

So:
- **PR approval?** Yes.
- **“Click approve → continue pipeline”?** No.

---

## When this is enough
Use the **official GitHub Slack app** if:
- Your approvals are **PR-based**
- You rely on **branch protection rules**
- You want zero maintenance

This is the cleanest, lowest-risk solution.

---

## When you need a custom Slack App instead
You need a **custom Slack bot + GitHub Actions** if you want:
- Manual deploy approvals
- Environment gates (prod approval)
- Buttons like **“Deploy to Prod”**
- Slack → GitHub Actions → Infra

That setup is common in serious teams, but it’s **not off-the-shelf**.

---

## Reality-based recommendation
1. **Use GitHub for Slack now**
2. Enforce approvals via **PRs + protected branches**
3. If you later want **Slack-native deploy approvals**, add:
   - Slack App (interactive components)
   - GitHub Environments with required reviewers
   - Or a custom approval step

If you want, I can:
- Diagram **Slack approval → prod deploy**
- Show a **minimal custom Slack approval flow**
- Compare **PR approvals vs environment approvals**

Say which.
