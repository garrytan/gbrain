---
title: "Codex Auto PR Options"
type: note
created: 2026-02-20
updated: 2026-02-20
source: chatgpt-export
conversation_id: 6997bcdd-50c0-8332-b8ba-887672a726b0
message_count: 2
tags: [chatgpt, import]
---
# Codex Auto PR Options

> Conversation ID: 6997bcdd-50c0-8332-b8ba-887672a726b0
> Created: 2026-02-20T01:46:22Z
> Updated: 2026-02-20T01:47:03Z
> Messages: 2

---

## User

can i get codex to auto open a pr when it finishes. im assigning it as an agent in linear agents

---

## Assistant

Short answer: **not yet, at least not natively** — the Codex agent in **Linear** doesn’t automatically create a PR on its own when it finishes work. It stops at posting a summary with a link so *you* can turn it into a PR manually. citeturn0search3

Here’s what we know and what your options are:

### 🔹 How Codex works in Linear now
- When Codex completes a task assigned via Linear, it posts a **summary and a link to the finished code change** so you can create a pull request. citeturn0search3  
- Codex doesn’t currently have a built-in toggle to auto-open the PR without you approving it first.

### 🔹 Why there’s no built-in auto-PR
- That behavior is by design: Codex stops short of pushing/merging on your behalf. You review and then open the PR. citeturn0search3  
- Community discussion has even flagged limitations around updating PRs and automation around PR branches. citeturn0search12

### ✅ Workarounds

**1. GitHub Actions automation**  
You can set up a GitHub Actions workflow that runs *after Codex commits changes* and does the PR creation for you:  
- Use a CI job that runs on certain triggers (like when Codex pushes to a branch or finishes a commit).  
- Include an action such as `peter-evans/create-pull-request` to open the PR automatically. citeturn0search9

**2. Webhook + bot that watches Linear tasks**  
- If you need *end-to-end automation* (Linear → code → PR), you can build or use an agent that listens to Linear events and then:  
  1) triggers Codex work,  
  2) watches for the result,  
  3) uses the GitHub API to create the PR once the code is ready — similar to community examples of AI agent pipelines. citeturn0search7

**3. Custom toolchain with GitHub API**  
- If you want full control, you can integrate directly with the GitHub API using CLI or scripts triggered by Linear webhooks or Codex completion notifications.

---

**Summary:**  
Right now, *Codex in Linear doesn’t auto-open PRs by itself*. You’ll need an external automation layer (e.g., GitHub Actions or custom webhook handler) to generate PRs automatically after Codex finishes tasks. citeturn0search3

If you want, I can draft a sample GitHub Actions workflow that takes Codex commits and auto-opens a PR for you.


## See Also
- [[chatgpt/chatgpt_cheapest-codex-usage-options]]
- [[chatgpt/chatgpt_codex-auto-pr-linear]]
- [[chatgpt/chatgpt_chatgpt-vs-gpt-51-codex]]
- [[chatgpt/chatgpt_codex-51-vs-claude-45]]
- [[chatgpt/chatgpt_codex-52-for-refactoring]]
