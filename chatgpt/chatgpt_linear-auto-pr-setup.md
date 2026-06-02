---
title: "Linear Auto-PR Setup"
type: note
created: 2025-12-23
updated: 2025-12-23
source: chatgpt-export
conversation_id: 694a4588-b964-832a-bcdb-10bab829105a
message_count: 2
tags: [chatgpt, import]
---
# Linear Auto-PR Setup

> Conversation ID: 694a4588-b964-832a-bcdb-10bab829105a
> Created: 2025-12-23T07:32:25Z
> Updated: 2025-12-23T07:33:06Z
> Messages: 2

---

## User

have linear agents auto pr after done

---

## Assistant

Mr. White — **yes, but not natively by default.**

**entity["company","Linear","issue tracking software"] agents do *not* automatically open pull requests on their own.** They can mark issues complete, but **auto-PR requires an integration or automation layer.**

### How teams enable auto-PR
1. **GitHub / GitLab automation**
   - Use **entity["company","GitHub","code hosting platform"] Actions** or **entity["company","GitLab","devops platform"] CI** triggered by:
     - Linear issue state → “In Review” / “Done”
     - Issue label (e.g., `auto-pr`)
   - Script creates branch, commits, opens PR.

2. **Agent frameworks (common setup)**
   - Linear → webhook
   - Webhook → agent (e.g., custom LLM worker)
   - Agent:
     - Pulls task context
     - Writes code
     - Pushes branch
     - Opens PR via GitHub API

3. **Off-the-shelf automation**
   - Tools like Zapier / custom Lambda can bridge:
     - *Linear issue completed* → *GitHub PR created*
   - Usually limited unless paired with a coding agent.

### Bottom line
- ❌ Linear alone: **no auto-PR**
- ✅ Linear + agent + repo automation: **yes, fully automatic**
- This is how most “AI engineer” pipelines actually work in production.

If you want, I can outline a **minimal Linear → GitHub auto-PR architecture** or a **GitHub Action template**.
