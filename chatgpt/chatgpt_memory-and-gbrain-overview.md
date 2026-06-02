---
title: "Memory and GBrain Overview"
type: guide
created: 2026-05-07
updated: 2026-05-07
source: chatgpt-export
conversation_id: 69fd0889-c6c8-83e8-8a09-3835d895e4bc
message_count: 2
tags: [chatgpt, import, code]
---
# Memory and GBrain Overview

> Conversation ID: 69fd0889-c6c8-83e8-8a09-3835d895e4bc
> Created: 2026-05-07T21:47:54Z
> Updated: 2026-05-07T21:49:07Z
> Messages: 2

---

## User

 Memory and GBrain are up:
    - GBrain 0.28.1 running, health 5/10 (embed coverage 84.7%, 208 missing embeddings, 256 orphan pages)
    - Memory system active at ~/.hermes/memories/
    - Skills loaded explain this

---

## Assistant

You have two different persistence/context layers running for your AI ops stack:

1. Memory system (`~/.hermes/memories/`)
2. GBrain (`gbrain` semantic knowledge graph/index)

They solve different problems.

## Hermes Memory System

Path:
```bash
~/.hermes/memories/
```

This is likely your lightweight persistent working memory layer for Hermes agents.

Typical role:
- Stores:
  - summaries
  - agent notes
  - task state
  - decisions
  - preferences
  - scratchpad context
  - recent discoveries
- Gives agents continuity between runs
- Cheap and fast
- Usually file-based markdown/json memories

Think:
```text
Short-term + operational memory
```

Example:
```text
- YC app positioning updated
- Jovie now focused on alerts wedge
- Cloudflare AI Gateway PR merged
- Need to finish onboarding stability
```

Without this:
- every agent starts “fresh”
- orchestration quality collapses
- duplicated reasoning explodes token burn

---

## GBrain

Version:
```text
GBrain 0.28.1
```

This is a semantic indexing + retrieval layer.

Think:
```text
Searchable company brain
```

It:
- ingests docs/code/issues/chats
- embeds them into vectors
- builds relationships between concepts
- allows semantic recall

Example queries:
```text
"show all YC positioning changes"
"what PRs affected onboarding"
"where do we mention release alerts"
"find all references to transactional fan notifications"
```

This is closer to:
- Devin memory
- Cursor codebase indexing
- Anthropic Claude memory retrieval
- enterprise RAG systems

---

## Your Health Report

### “health 5/10”

System is functioning but degraded.

---

### “embed coverage 84.7%”

Meaning:
- ~85% of indexed content has embeddings
- ~15% does NOT

That missing 15% is invisible to semantic search.

This matters because:
- agents miss context
- duplicate work increases
- planning quality drops
- retrieval becomes inconsistent

---

### “208 missing embeddings”

These are documents/pages/chunks that exist but were never vectorized.

Causes:
- failed embedding jobs
- rate limits
- crashes
- stale queue
- unsupported file types
- tokenizer failures
- oversized chunks

Effect:
```text
Document exists
BUT
agents cannot semantically discover it
```

---

### “256 orphan pages”

This is more important.

Orphan pages usually mean:
- indexed pages with no graph linkage
- docs disconnected from projects/repos/issues
- stale entities
- dead references
- duplicated nodes
- broken ingestion

Effect:
- retrieval quality degrades
- semantic relationships weaken
- graph traversal becomes noisy

This is usually a sign:
```text
ingestion pipeline needs maintenance
```

---

## “Skills loaded”

Skills are reusable instruction packs/prompts/workflows.

Usually:
```text
skills/
  performance.md
  qa.md
  shipping.md
  docs.md
  release.md
```

They function like:
- Claude skills
- Devin playbooks
- Codex task templates
- reusable agent capabilities

A skill can include:
- instructions
- workflows
- heuristics
- tool preferences
- coding standards
- repo-specific conventions

Example:
```text
performance-hardening skill:
- run lighthouse
- inspect bundle size
- check hydration mismatches
- verify TanStack query caching
- optimize drizzle queries
```

Agents dynamically load these when relevant.

---

## What Your Current State Implies

You already have the foundation of:
- persistent AI workforce memory
- semantic retrieval
- reusable operational playbooks

That means your bottleneck is no longer:
```text
“Can agents do work?”
```

Your bottleneck is now:
```text
memory quality
retrieval quality
orchestration quality
task routing
visibility
continuous loops
```

That is the transition from:
```text
“AI coding assistant”
```
to:
```text
“AI operating system”
```

---

## Immediate Problems To Fix

Priority order:

### 1. Fix embedding coverage to >98%

Critical.

Because semantic recall quality compounds across every agent.

Need:
- nightly re-embedding cron
- failed-job retry queue
- chunk-size validation
- stale embedding detection
- changed-file incremental embedding

---

### 2. Resolve orphan pages

Need graph hygiene:
- dead-node cleanup
- relationship rebuilding
- duplicate collapsing
- repo entity reconciliation
- issue/doc/code linking

This dramatically improves retrieval quality.

---

### 3. Add memory compaction

Right now memories probably grow endlessly.

Need:
- summarize old memories
- merge duplicates
- archive stale operational state
- preserve decisions/history
- reduce token load

Think:
```text
git gc for agent memory
```

---

### 4. Build observability

You need a HUD for:
- agent status
- memory health
- embedding coverage
- stale docs
- failing crons
- issue queues
- blocked workflows
- token burn
- model routing
- PR throughput

Without this:
you become the bottleneck.

---

## World-Class Direction

The strongest architecture for Jovie is likely:

```text
Hermes
= orchestration layer

GBrain
= semantic company brain

Memory files
= operational persistence

Skills
= reusable capabilities

Cron swarm
= autonomous maintenance/work

HUD
= human visibility/control plane
```

That is directionally similar to:
- Devin internal loops
- Cognition workflows
- Anthropic tool ecosystems
- OpenAI Codex orchestration patterns
- elite autonomous coding setups

The key shift:
```text
Everything becomes event-driven.
```

Examples:
- PR merged → docs doctor runs
- failing test → QA agent spawns
- stale embeddings → memory repair runs
- deploy regression → perf agent opens issue
- new SDK docs → ingestion pipeline updates skills
- YC deadline approaching → application agent refreshes answers

That’s where the compounding velocity comes from.


## See Also
- [[chatgpt/chatgpt_1001tracklists-overview-2]]
- [[chatgpt/chatgpt_1001tracklists-overview-3]]
- [[chatgpt/chatgpt_1001tracklists-overview]]
- [[chatgpt/chatgpt_11-labs-grant-overview]]
- [[chatgpt/chatgpt_1600-vine-st-overview]]
