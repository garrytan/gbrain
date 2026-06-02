---
title: "Lowering Hermes Burn"
type: guide
created: 2026-05-07
updated: 2026-05-07
source: chatgpt-export
conversation_id: 69fcfddb-7278-83e8-9733-06c0c3968f6f
message_count: 2
tags: [chatgpt, import, code]
---
# Lowering Hermes Burn

> Conversation ID: 69fcfddb-7278-83e8-9733-06c0c3968f6f
> Created: 2026-05-07T21:02:23Z
> Updated: 2026-05-07T21:05:22Z
> Messages: 2

---

## User

how to lower hermes burn

---

## Assistant

For your setup, Hermes burn is mostly coming from:
- orchestration chatter
- unnecessary context injection
- expensive models doing cheap work
- agents re-reading the repo/docs repeatedly
- long-lived conversations accumulating tokens
- parallel agents duplicating reasoning

You reduce burn by restructuring the system architecture, not by “prompt optimization.”

## Target Architecture

### 1. Cheap brain → expensive specialists
Your Hermes chief-of-staff/orchestrator should almost never use frontier models.

Use:
- urlDeepSeek V3.1 / V4 via OpenRouterhttps://openrouter.ai
- urlQwen 3 familyhttps://qwenlm.github.io
- Gemini Flash for routing/planning

Only escalate to:
- GPT-5.5
- Claude Opus/Sonnet
- Codex

…for:
- final implementation
- architecture decisions
- debugging hard failures
- UI polish
- PR review
- safety-sensitive changes

The orchestrator should mostly:
- classify
- delegate
- summarize
- diff state
- decide if escalation needed

That cuts burn massively.

---

## 2. Kill continuous conversations

Long-lived agent threads become token death spirals.

Instead:
- every task = fresh context window
- persistent memory = structured state store
- agents receive:
  - task
  - relevant diffs
  - small summaries
  - exact files

NOT:
- giant conversational history

Your “memory” should be:
- vector DB
- markdown summaries
- structured JSON state
- issue/task graph

NOT giant chat logs.

---

## 3. Stop sending whole repo context

Most AI systems waste insane money on this.

Agents should receive:
- changed files only
- dependency graph around touched code
- architectural summaries
- relevant skills/docs

Build:
- code indexing
- semantic retrieval
- ownership maps
- dependency maps

Then inject:
- top 5–20 relevant chunks
instead of:
- “here’s the repo”

This alone can reduce burn 70–90%.

---

## 4. Separate “thinking” from “doing”

You currently likely have models reasoning repeatedly.

Instead:

### Planning pass
Cheap model:
- creates execution graph
- breaks work into subtasks
- estimates confidence

### Execution pass
Expensive model:
- only executes narrow task

### Validation pass
Cheap model:
- runs lint/tests/review
- retries automatically

Only escalate failures upward.

---

## 5. Use deterministic systems aggressively

Never use LLMs for:
- cron scheduling
- routing
- state tracking
- retries
- dependency management
- CI orchestration
- file watching
- metrics
- dashboards
- event handling

Use:
- Temporal
- Trigger.dev
- BullMQ
- Postgres queues
- GitHub Actions
- cron
- state machines

LLMs should only:
- interpret ambiguity
- generate/refactor code
- summarize
- reason

Every non-LLM operation moved out saves huge burn.

---

## 6. Introduce escalation thresholds

Example:

| Task | Model |
|---|---|
| classify issue | Gemini Flash |
| write ticket | Qwen |
| code simple CRUD | DeepSeek |
| debug flaky test | Sonnet |
| architecture redesign | GPT-5.5 |
| final UX polish | Opus |

Most companies massively overuse frontier models.

---

## 7. Cap parallelism intelligently

20 agents sounds productive.
Usually it creates:
- merge conflicts
- duplicated reasoning
- token explosions
- orchestration overhead

Better:
- 1 orchestrator
- 3–5 active workers
- dynamic queue

Only scale wider when:
- task graph truly parallelizes

---

## 8. Cache everything

Cache:
- repo summaries
- architecture summaries
- SDK docs
- lint outputs
- embeddings
- dependency graphs
- prior fixes
- PR reviews

If Hermes re-explains your stack every task, you’re burning money.

---

## 9. Compress docs nightly

Your docs doctor idea is correct.

You want:
- canonical summaries
- layered detail
- token-efficient architecture docs
- stale-doc pruning
- deduplication

Agents should consume compressed operational knowledge.

Not raw sprawling markdown.

---

## 10. Use event-driven execution

The best setup is mostly sleeping.

Agents wake only on:
- PR opened
- CI failed
- issue created
- release shipped
- metrics anomaly
- cron tick
- support ticket
- dependency update

Not constant “thinking.”

---

## 11. Move cheap loops local

For:
- embeddings
- reranking
- lightweight orchestration
- retrieval
- classification

Use:
- local Qwen
- MLX
- Ollama
- vLLM
- NIM

Reserve API spend for high leverage reasoning.

---

## 12. Introduce budgets per agent

Every agent should have:
- hourly token cap
- escalation cap
- retry cap
- model whitelist

Example:
```yaml
chief_of_staff:
  default_model: deepseek
  escalation_model: sonnet
  max_hourly_cost: 3
  max_retries: 2
```

Without this, agents spiral.

---

## 13. Measure burn correctly

Track:
- cost per merged PR
- cost per resolved issue
- cost per deploy
- cost per bug prevented
- cost per test added
- cost per user outcome

Not just raw token spend.

Sometimes $40/hour is cheap if velocity 10x’s.

---

## Immediate highest ROI changes for Jovie

Order these exactly:

1. Replace Hermes orchestrator model with DeepSeek/Qwen
2. Kill long-lived conversational context
3. Build retrieval-based context injection
4. Add model escalation tiers
5. Cap active parallel agents to ~5
6. Add event-driven wakeups
7. Add caching layer for repo summaries/docs
8. Add nightly doc compaction/indexing
9. Route CI/test/review through cheap models first
10. Only escalate hard problems to GPT-5.5/Opus

That likely cuts burn 60–85% while increasing velocity.
