---
title: "Open Source Plan"
type: guide
created: 2026-05-06
updated: 2026-05-06
source: chatgpt-export
topic: music-production
message_count: 6
tags: [chatgpt, knowledge, music-production]
---
# Open Source Plan

> **Source:** ChatGPT conversation
> **Date:** 2026-05-06T18:40:02Z
> **Messages:** 6
> **Topic:** music-production

## Question

greptile hit us witha. 2400 bill because they charge 1 dollar per pr after the 30/mo per seat and they charge for bot accounts so we have 4 seats for one human. even github bot got charged. so fuck them. so i want to build an oper soruce version that i can just run on our repo and then get other people to contribute to so it alwayss improves. make the plan for this. if its takes off, we'll pivot into it as our company.

## Question

what about as an mvp just somethign that will scan our prs, use grbain we already have an review with a free model like nvidia or even a cheap model like deepskeek flash v4. then post a review that our agents can tackle. could be a local cron, could live in ci. dont really care. just need code review our agents can respond to that keeps our shipping velocity up without tanking quality or letting bugs slip into production. we can even export our data from greptile and ingest it into this new thing we build. could be part of agent os. reviews can even happen locally if needed.

## Question

So the main thing I want to understand is cost. Last month, GReptile hit us with a $2,400 bill. That was four seats, even though we only have one human using it. So I guess they included, like, three different bot accounts that were all just me, um, you know, just automation and stuff. And then they included a dollar, I think it was 50 reviews included per seat, and then the overage per each seat was a dollar a review. So, you know, effectively like $2,200 just because it was $2,200 for a dollar a piece. My question is, we also have CodeRabbit. Can you, like, give me a price breakdown on, like, you know, we're on a public repo so they don't have to pay for the CI minutes. We just kind of thought, like, for, we're doing this, like, would we be able to get it down cheap enough that it would be affordable? Like, I can't spend $2,000 a month on this, but we could spend, you know, $50 a month on it. And I'm just trying to figure out, I don't know what the, you know, rate limits are on CodeR

## Answer

Mr. White, you are almost certainly massively overpaying relative to the actual inference cost.

Your $2,400 bill was basically:
- SaaS margin
- Per-review billing
- Bot seat inflation
- Re-reviewing every push
- Enterprise-grade infra/support costs
- Their own model orchestration overhead

The raw AI cost to do PR review in 2026 is nowhere near that anymore.

# What your likely real usage actually costs

You said:
- Public repo
- Heavy agentic development
- Tons of PR churn
- Greptile + CodeRabbit both active
- Probably ~2,200 reviews/month

That sounds huge emotionally, but token-wise it’s not actually that crazy.

## Approximate real inference cost

Assume:
- average PR review request = 15k input tokens
- average response = 1k output tokens
- 2,200 reviews/month

That equals roughly:
- 33 million input tokens
- 2.2 million output tokens

Using official published pricing for DeepSeek V4 Flash:
- ~$0.14 / million input
- ~$0.28 / million output

That gives:

| Category | Cost |
|---|---:|
| Input | ~$4.62 |
| Output | ~$0.62 |
| Total inference | ~$5.24/month |

Even if your prompts are 10x larger:
- still only ~$50/month inference.

That is the important realization.

The model itself is basically free now.

The expensive part is:
- orchestration
- SaaS overhead
- UX
- infra
- support
- margins
- bad billing models

Not the intelligence.

---

# Your likely cheapest realistic stack

## Option A — Cheapest + fastest MVP
Recommended.

### Architecture
- GitHub Actions
- DeepSeek V4 Flash via OpenRouter or direct API
- GBrain retrieval
- reviewdog for comment posting
- SQLite artifacts
- shadow mode first

### Monthly cost

| Item | Estimated |
|---|---:|
| GitHub Actions | ~$0 (public repo) |
| DeepSeek V4 Flash | ~$5–50 |
| Storage/logging | ~$0–10 |
| Total | ~$5–60/mo |

That is probably your actual target.

---

# Why CodeRabbit probably feels “worth it”

urlCodeRabbithttps://coderabbit.ai

CodeRabbit is likely doing:
- aggressive filtering
- confidence gating
- review deduplication
- smart diff slicing
- selective commenting
- rerun suppression

That matters more than model quality.

Most bad PR reviewers fail because:
- too many comments
- low signal
- re-comment spam
- commenting on generated code
- reviewing vendor/build files
- hallucinating issues

The moat is orchestration quality.

Not “having an LLM.”

---

# The actual winning architecture

You do NOT want:
- “review every PR fully with frontier reasoning”

You want:

```txt
1. deterministic checks first
2. narrow suspicious hunks
3. retrieve nearby code with GBrain
4. ask cheap model ONLY about risky areas
5. publish only high-confidence findings
6. agents consume JSON artifact
7. agents attempt fixes
8. tests verify fixes
```

That is how you keep costs microscopic.

---

# Biggest hidden cost multiplier

The thing that killed you with Greptile was probably:

```txt
trigger on every push
```

Agentic workflows generate absurd PR churn.

Example:
- agent pushes 12 commits
- Gre

*(Answer truncated — 4763 chars total)*

## Question

I might go to market for it if we ended up doing it or even before that would be once it’s open sourced to go to G stack and Hermes, an open fall and all the different like open agency stuff out there and to push native support updates to them. It merged them and then also to message all of the contributors on GitHub and ask them their opinion. Then just go after reptile customers and beat em on price. What do we think?

## Answer

I think this is actually one of the more credible pivots you’ve discussed because:

1. You are a real power-user pain case.
2. Agentic coding workflows are exploding.
3. Existing pricing models break under agentic PR churn.
4. Open-source distribution is unusually strong in devtools right now.
5. Your network/equipment/workflow gives you unfair advantage here.

But the sequencing matters a lot.

# The right sequence

## Stage 1 — Internal survival tool
Goal:
- stop bleeding money immediately
- improve your own shipping velocity
- prove quality

This alone is worth doing.

If you reduce:
- Greptile: $2400/mo
- maybe other tooling: another few hundred

You effectively extend runway immediately.

That alone is ROI-positive.

---

# Stage 2 — OSS release

This is where it gets interesting.

The strongest angle is NOT:
“AI PR reviewer.”

That market is crowded.

The angle is:

> “Built for agentic coding teams.”

That is the wedge.

Because normal SaaS PR-review economics completely break once:
- Claude Code
- Hermes
- GStack
- Codex
- OpenHands
- OpenDevin
- AutoClaude
- SWE-agent
- OpenManus
- multi-agent CI workflows

start generating massive PR churn.

Your pain is not edge-case pain anymore.
It is future pain.

---

# The real positioning

Not:
- “better AI reviews”

Instead:

> “PR review infrastructure for autonomous software teams.”

That is much stronger.

---

# The killer features

## 1. Review deduplication
Huge.

If agent pushes 8 commits:
- do NOT re-review unchanged findings
- diff against prior review artifacts

This alone kills massive waste.

---

## 2. Agent-readable JSON artifacts
This is enormous.

Most review tools optimize for humans.

You should optimize for:
- Claude Code
- Hermes
- Codex
- OpenHands
- Cursor agents

Meaning:
- structured issue schema
- confidence
- severity
- suggested fix
- reasoning trace
- affected files

---

## 3. Local-first inference
Massive wedge.

Developers increasingly want:
- local
- cheap
- private
- no seat billing
- no token anxiety

---

## 4. Model-agnostic
Critical.

Do NOT become tied to:
- OpenAI
- Anthropic
- DeepSeek
- NVIDIA

Be:
- OpenAI compatible endpoint
- local endpoint
- Ollama
- vLLM
- OpenRouter
- anything

That becomes your moat:
orchestration + workflows.

---

# Your GTM is actually strong

You already identified the right playbook.

## Step 1
Support:
- Hermes
- GStack
- OpenHands
- OpenDevin
- AutoClaude
- Claude Code
- Codex
- Cursor agents

Natively.

---

## Step 2
Contribute upstream.

This is smart because:
- open-source devtool communities reward contributors
- integration PRs become distribution
- every merged integration becomes SEO + awareness

---

## Step 3
Talk to contributors directly

Very smart.

Because:
- these are exactly the users hitting the same scaling problems
- they are extremely online
- they spread tools virally

Especially:
- people running autonomous coding loops
- people burning through PR review quotas
- people self-hosting inference

---

# Yo

*(Answer truncated — 4592 chars total)*
