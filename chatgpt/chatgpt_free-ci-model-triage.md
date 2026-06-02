---
title: "Free CI Model Triage"
type: guide
created: 2026-05-08
updated: 2026-05-08
source: chatgpt-export
conversation_id: 69fd2f42-7f68-83e8-b9eb-2a73c75d4a23
message_count: 5
tags: [chatgpt, import, code]
---
# Free CI Model Triage

> Conversation ID: 69fd2f42-7f68-83e8-b9eb-2a73c75d4a23
> Created: 2026-05-08T00:33:12Z
> Updated: 2026-05-08T00:34:35Z
> Messages: 5

---

## User

Is there a free model from Open Router that we could run in CI on the public repo, which we've had to wait three months to basically have free auto-fixing? That can take the reviews from G-Reptile and Code Rabbit and Sentry, and then just implement their suggestions, and then defer only to a more like a deep-seeker or a better model when they really really really need to? Or would it be cheaper for us to do that as a CRON locally using our Claude Code or code-out subscriptions? You 

---

## Assistant

I’ll ground this in current OpenRouter pricing/model availability and compare it against local subscription-driven cron economics for your repo workflow.

---

## Assistant

Yes, Mr. White.

**Best architecture: hybrid triage.**

1. **CI uses OpenRouter free model for cheap first-pass fixes**
   - Use `openrouter/free` or specific `:free` coding-capable models.
   - OpenRouter’s free router is $0 input/output and routes to available free models. citeturn330571search0
   - Free model limits are real: `20 req/min`, and usually `50/day` unless you’ve bought $10+ credits, then `1000/day`. citeturn330571search2

2. **Only escalate hard patches locally**
   - If tests fail twice, diff is large, security-sensitive, DB/auth/payment-related, or model confidence is low → route to **Claude Code/Codex locally**.
   - Claude Code paid plans just got doubled five-hour limits and removed peak reductions for Pro/Max. citeturn330571search3
   - Codex CLI can run locally and is included in paid ChatGPT plans. citeturn546178search5

**Recommendation for Jovie:**

Run this in public repo CI:

```text
PR review comments / CodeRabbit / Greptile / Sentry issue
→ normalize into patch task
→ OpenRouter free model attempts small deterministic fix
→ run typecheck/test/lint
→ if green: commit to autofix branch
→ if red twice or risky: label "needs-premium-agent"
→ local cron picks those up with Claude Code/Codex
```

**Do not rely on free OpenRouter alone.** It is good for:
- obvious lint fixes
- typo fixes
- import fixes
- simple TypeScript errors
- snapshot/test expectation updates
- small CodeRabbit suggestions

Use Claude/Codex for:
- architecture changes
- Drizzle/schema changes
- auth/payment/SMS/email
- flaky tests
- perf regressions
- anything touching core Jovie flows

**Cheapest move:** CI free model as the janitor; local subscription cron as the surgeon. This preserves your paid model limits for fixes that matter.

---

## User

so it would be entirely free yes?

---

## Assistant

No.

The **CI layer can be nearly free**, but not fully free in practice.

Breakdown:

- OpenRouter free models: effectively $0 token cost.  
  You still hit:
  - rate limits
  - daily caps
  - model availability instability
  - occasional degraded outputs

- GitHub Actions:
  - free for public repos
  - but you are exposing repo visibility risk

- Sentry/CodeRabbit/Greptile:
  - not free at scale
  - especially Greptile, which already burned you

The real issue is not token cost. It is:
- reliability
- queue throughput
- hallucinated patches
- CI runtime waste
- broken auto-commits

For your setup specifically, the optimal system is probably:

```text
Tier 0 (free CI bot)
- OpenRouter free models
- tiny scoped fixes only
- max 1-3 files changed
- no architecture decisions
- no DB/auth/env edits
- auto-close if uncertain

Tier 1 (local cron on your machine)
- Claude Code / Codex
- triggered only for failures/escalations
- uses your flat-rate subscriptions
- runs overnight continuously

Tier 2 (human approval)
- merges
- risky infra
- product decisions
```

That gets you:
- effectively “free” janitorial autofixing
- while reserving premium intelligence for leverage-heavy work

This is probably cheaper than:
- burning OpenRouter paid models in CI
- or running Claude/Codex blindly on every PR/test failure

Important detail:

If you use Claude Code/Codex locally via cron:
- terminal can be closed if orchestrated correctly
- use `launchd`, `pm2`, `systemd`, Docker daemon, or background runners
- much better economics because your subscriptions are sunk cost

So the highest ROI architecture is:

```text
Public repo CI:
free model triage only

Local ops machine:
premium autonomous agents
```

That aligns with your “don’t build twice” ethos too:
- same orchestration
- same issue queue
- same patch pipeline
- different execution tiers based on complexity/cost.


## See Also
- [[chatgpt/chatgpt_aesthetic-muscle-focus-64-model]]
- [[chatgpt/chatgpt_ai-3d-model-creation]]
- [[chatgpt/chatgpt_ai-model-comparison-for-nextjs]]
- [[chatgpt/chatgpt_arlo-camera-charging-model]]
- [[chatgpt/chatgpt_best-model-for-design-systems]]
