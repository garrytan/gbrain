---
title: "Codex cost comparison"
type: note
created: 2025-11-21
updated: 2025-11-21
source: chatgpt-export
conversation_id: 6920d78a-f684-832d-b6d1-b76c3d380fcb
message_count: 2
tags: [chatgpt, import]
---
# Codex cost comparison

> Conversation ID: 6920d78a-f684-832d-b6d1-b76c3d380fcb
> Created: 2025-11-21T21:20:22Z
> Updated: 2025-11-21T21:20:51Z
> Messages: 2

---

## User

Codex costs API vs plus/pro

---

## Assistant

Mr. White, here’s the current cost picture:

**ChatGPT Plus / Pro (Codex included)**
- **Plus:** **$20/month** and includes Codex agent access with usage limits. citeturn0search1turn0search2turn0search7  
- **Pro:** **$200/month** and includes Codex with much higher limits. citeturn0search1turn0search2turn0search7  
- Limits are measured in *local messages* and *cloud tasks* per 5-hour window; Pro gets a lot more. citeturn1view0  
- You don’t pay per token inside Plus/Pro unless you buy extra credits on higher tiers (Business/Enterprise). citeturn0search7turn0search15  

**Codex via API (pay-as-you-go)**
You pay per token for whatever model Codex is using through your API key:

- **gpt-5.1-codex-mini:**  
  - Input: **$0.25 / 1M tokens**  
  - Cached input: **$0.03 / 1M tokens**  
  - Output: **$2.00 / 1M tokens** citeturn1view0  
- **gpt-5.1 (full):**  
  - Input: **$1.25 / 1M tokens**  
  - Cached input: **$0.13 / 1M tokens**  
  - Output: **$10.00 / 1M tokens** citeturn1view0  
- GPT-5-Codex variants are priced the same as their GPT-5 counterparts when used via API. citeturn0search10  

**Rule of thumb / quick breakeven**
- If you code a **bit every day** and like the integrated agent/IDE/CLI experience, **Plus is usually cheaper and simpler**.
- If your usage is **spiky or very large-scale**, API can be cheaper *per unit*—but you’re paying for every token.

Example with **gpt-5.1-codex-mini**:  
- 200k input tokens + 50k output tokens in a month  
  - Input cost: 0.2M × $0.25 = **$0.05**  
  - Output cost: 0.05M × $2.00 = **$0.10**  
  - Total ≈ **$0.15/month**.  
So light usage favors API; steady heavy interactive usage favors Plus/Pro for the flat fee + higher task limits.

If you want, tell me roughly how many Codex “tasks/messages” you do per week or your API token volume, and I’ll estimate which side wins for you.


## See Also
- [[chatgpt/chatgpt_claude-code-cost-comparison-part1]]
- [[chatgpt/chatgpt_claude-code-cost-comparison-part2]]
- [[chatgpt/chatgpt_claude-code-cost-comparison-part3]]
- [[chatgpt/chatgpt_claude-code-cost-comparison-part4]]
- [[chatgpt/chatgpt_claude-code-cost-comparison-part5]]
