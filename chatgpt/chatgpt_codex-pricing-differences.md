---
conversation_id: 69ab77b3-91ac-832f-a9d8-0ddecd72c435
created: 2026-03-07
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Codex Pricing Differences
type: note
updated: 2026-03-07
---

# Codex Pricing Differences

**Related:** [[business_startup]]

> Conversation ID: 69ab77b3-91ac-832f-a9d8-0ddecd72c435
> Created: 2026-03-07T00:56:30Z
> Updated: 2026-03-07T03:42:19Z
> Messages: 2

---

## User

does codex cost the same for local work in the codex app or worktree work as it does for cloud

---

## Assistant

No. **Local Codex work and cloud Codex tasks do not cost the same in how they consume your quota**, although they are covered by the same subscription.

### 1. Codex app / CLI (local work, worktrees)
Local workflows include:

- Codex CLI
- Codex app running tasks against your local repo
- IDE integrations
- Git worktree agents

These consume **“local messages”** from your plan quota. citeturn0search6turn0search7  

Example limits (approximate):

| Plan | Local messages (per ~5 hr window) |
|---|---|
| Plus ($20/mo) | ~30–150 |
| Pro ($200/mo) | ~300–1500 |

Local interactions are typically cheaper in quota terms because they’re **interactive prompts against your local environment**, not long-running compute jobs. citeturn0search6

---

### 2. Cloud Codex tasks
Cloud tasks include:

- Autonomous agents running in cloud sandboxes
- Long-running tasks
- PR generation or multi-step builds in remote environments

These consume **“cloud task” quota**, which is much smaller because each task uses more compute. citeturn0search6  

Example limits:

| Plan | Cloud tasks (per ~5 hr window) |
|---|---|
| Plus | ~5–40 |
| Pro | ~50–400 |

Each cloud task can run builds, tests, and scripts inside an isolated container environment. citeturn0search16

---

### 3. If you switch the CLI to API mode
There is a third mode:

- CLI using **API key billing**

In that case you **pay per token**, exactly like normal OpenAI API usage, independent of your ChatGPT plan. citeturn0search7

---

✅ **Summary**

| Workflow | Billing model |
|---|---|
| Codex app / CLI local work | Uses “local message” quota |
| Cloud Codex agents | Uses “cloud task” quota (more expensive per task) |
| CLI with API key | Pay per token via API |

Local work generally lets you do **many more interactions per window** than cloud agents.

---

If useful, I can also explain **when Codex actually spins up cloud compute vs staying local**, because that distinction is what determines whether your usage burns through quota quickly.


**Topic:** [[chatgpt-clusters/business_startup]]


## See Also
- [[chatgpt/chatgpt_codex-api-and-agent-pricing]]
- [[chatgpt/chatgpt_12inchskinz-vs-djskins-pricing]]
- [[chatgpt/chatgpt_apartment-pricing-estimates]]
- [[chatgpt/chatgpt_bucket-truck-pricing-guide]]
- [[chatgpt/chatgpt_clearbit-pricing-details]]
