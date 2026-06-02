---
conversation_id: 6941c52b-cfe8-8332-b669-94973d3ae87f
created: 2025-12-16
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Claude PR review options
type: note
updated: 2025-12-17
---

# Claude PR review options

**Related:** [[coding_ai]]

> Conversation ID: 6941c52b-cfe8-8332-b669-94973d3ae87f
> Created: 2025-12-16T20:46:36Z
> Updated: 2025-12-17T02:25:24Z
> Messages: 2

---

## User

can i set claude as a reviewer for a pr or just tag in the comments to request a codereview?

---

## Assistant

Mr. White,

**Short answer:**  
You **cannot** set Claude as an official PR reviewer, but you **can** tag it indirectly depending on your setup.

### Why you can’t add Claude as a reviewer
- GitHub/GitLab only allow **human users or service accounts** with proper permissions as reviewers.
- Claude (Anthropic) is **not a native PR reviewer entity** in either platform.

### What *is* possible (practical options)

#### 1. Tag Claude via a bot or integration (best option)
If you use a tool that integrates Claude (examples: custom GitHub App, CI bot, or platforms like Sourcegraph, Continue, or bespoke scripts):
- You comment something like:
  ```
  /review
  ```
  or
  ```
  @claude review this PR
  ```
- The **bot** listens for the comment and sends the diff to Claude.
- Claude responds as a **comment**, not a reviewer.

This is how most “AI PR reviews” work in practice.

#### 2. Manual copy/paste (lowest friction, least scalable)
- Paste the PR diff or files into Claude.
- Ask for a review.
- Paste feedback back into the PR.

Works, but zero automation.

#### 3. CI-triggered reviews
- PR opened → CI job runs → sends diff to Claude → posts review comments.
- Claude still shows up as a **bot comment**, not a reviewer.

### Key distinction
- **Reviewer:** ❌ Not possible
- **Automated review comments:** ✅ Fully possible and common

### Bottom line
You **cannot assign Claude as a PR reviewer**, but you **can request Claude reviews via comments** if you have:
- A bot
- A GitHub App
- A CI integration wired to Claude

If you want, I can outline:
- A **minimal GitHub App** setup for Claude
- Or a **CI-based approach** (GitHub Actions) using Claude’s API


**Topic:** [[chatgpt-clusters/coding_ai]]


## See Also
- [[chatgpt/chatgpt_claude-analysis-review]]
- [[chatgpt/chatgpt_100-mbps-upload-options]]
- [[chatgpt/chatgpt_actionable-items-review]]
- [[chatgpt/chatgpt_ai-code-review-tools]]
- [[chatgpt/chatgpt_ai-design-review-tools]]
