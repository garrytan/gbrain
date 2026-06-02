---
title: "Free Models for PRs"
type: note
created: 2026-05-31
updated: 2026-05-31
source: chatgpt-export
conversation_id: 6a1bb910-d768-83e8-85cb-bcc65b65d4ad
message_count: 2
tags: [chatgpt, import, code]
---
# Free Models for PRs

> Conversation ID: 6a1bb910-d768-83e8-85cb-bcc65b65d4ad
> Created: 2026-05-31T04:29:22Z
> Updated: 2026-05-31T04:29:37Z
> Messages: 2

---

## User

is there a free modell good enough to handle merging prs including addressing bot comments and test failures?

---

## Assistant

Yes. For narrowly scoped PR workflows, there are free models that are good enough to:

- Read PR comments
- Address review feedback
- Run tests
- Fix failing tests
- Push follow-up commits
- Re-run CI
- Repeat until green

The key constraint is task complexity, not model size.

### Current free-tier leaders

| Model | PR review fixes | Test failure fixes | Large repo understanding | Cost |
|----------|----------|----------|----------|----------|
| entity["software","Kimi K2","Moonshot AI model"] | Very good | Very good | Excellent (1M context) | Free on many OpenRouter routes |
| entity["software","DeepSeek V3","DeepSeek coding model"] | Good | Good | Good | Free/cheap |
| entity["software","OWL Alpha","OpenRouter model"] | Surprisingly good | Moderate | Very large context | Free currently |
| entity["software","Qwen3-Coder","Alibaba coding model"] | Good | Good | Good | Often free |
| entity["software","GLM-4.5","Zhipu model"] | Decent | Decent | Good | Often free |

For Hermes, I'd probably start with Kimi K2.

Why:

- Huge context window
- Strong code-editing performance
- Cheap enough to run continuously
- Good at "read comment → modify file → rerun test" loops
- Better economics than Claude for autonomous agents right now

### Where free models fail

The failures are usually:

1. Architectural refactors
2. Cross-repo changes
3. Hidden business logic
4. Ambiguous reviewer comments
5. Large failing test cascades

Research on thousands of real agent-generated PRs found test failures are one of the biggest reasons PRs remain unmerged. citeturn0academia11turn0academia10

### The architecture I'd use for Hermes

Cheap worker:

- Kimi K2
- DeepSeek V3
- OWL Alpha

Expensive escalation path:

- entity["software","Claude Code","Anthropic coding agent"]
- entity["software","Codex","OpenAI coding agent"]

Flow:

```text
PR opened

↓
Kimi reviews comments

↓
edits code

↓
runs tests

↓
fixes failures

↓
runs tests again

↓
pushes commit

↓
CI green?

YES → request review

NO → retry 2-3 times

Still failing?

↓
escalate to Claude Code
```

This is basically how most cost-conscious agent systems are evolving: cheap models do 80–90% of the mechanical PR work, expensive reasoning models only get pulled in when the loop stalls. citeturn0search2turn0search3turn0search8

For Jovie specifically, I'd expect Kimi K2 to successfully merge a large percentage of:
- lint fixes
- typing fixes
- failing unit tests
- UI regressions with clear screenshots
- dependency upgrades
- CRUD feature work

I would not trust it alone for:
- billing
- auth
- database migrations
- analytics architecture
- agent orchestration systems
- anything touching artist payouts

Those are the places where Claude still earns its keep. citeturn0search3turn0search7


## See Also
- [[chatgpt/chatgpt_leveraging-free-models]]
- [[chatgpt/chatgpt_nvidia-free-api-models]]
- [[chatgpt/chatgpt_attractiveness-data-and-models]]
- [[chatgpt/chatgpt_casting-brief-for-models]]
- [[chatgpt/chatgpt_cheap-models-for-cos]]
