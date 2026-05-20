# Origin story

GBrain came out of building OpenClaw — Garry's personal AI agent fork. The first version had skills and a brain, but the brain was a flat directory of markdown files. Search was ripgrep. Memory was vibes.

Two problems surfaced almost immediately.

First, the agent forgot things between conversations. Every new session re-asked basic questions. Names of people Garry had introduced last week were gone. Decisions made on Tuesday didn't survive to Thursday. The brain existed but the agent couldn't actually use it.

Second, the agent kept duplicating work. Two different signals about the same company became two different people pages. Three meetings with the same person became three uncorrelated timeline entries. The signal-to-noise ratio decayed in real time.

GBrain is what you build when you decide both of those are unacceptable.

The fix wasn't one big idea. It was many small ones layered together:

- Brain-first lookup before any external API call.
- Auto-linking on every page write so the graph grows for free.
- Typed edges so "who works at Acme AI?" actually returns something.
- Hybrid search because vector alone underdelivers.
- Reranker on top because hybrid alone is locally optimal but globally suboptimal.
- Nightly cron to dedup, enrich, fix citations, surface contradictions.
- An agent that reads `skills/RESOLVER.md` once and knows what to do.

None of those are novel ideas. The contribution is shipping all of them together, on Postgres + pgvector that runs in WASM (no server), with skills that are markdown (not code), routed by a small text file (not a router LLM).

The production brain has been running for months now. 17,888 pages. 4,383 people. 723 companies. 21 cron jobs running autonomously. It wakes Garry up smarter than the day before.

GBrain is what happens when you write the brain you actually wanted to have.
