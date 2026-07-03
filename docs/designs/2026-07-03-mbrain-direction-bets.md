# MBrain Direction Bets - 2026-07 Wave

Status: gated product direction artifact.

This document closes the Wave 4 D-1..D-5 direction-bet scope from
`2026-07-03-mbrain-improvement-spec.md`. These are not default-on runtime
features. They become implementation candidates only after the governance loop,
compile-debt loop, and retrieval instrument exist.

Activation gate:

- EV-1 publishes a live retrieval baseline and a non-regression comparison.
- EV-2 publishes the deterministic R + C trajectory score and the gated G lane.
- KM-1/KM-3/KM-5 provide compile-debt, patch-candidate distillation, and curation
  queues.
- TR-1 persists traces by default, so usage, misses, and answer changes are
  measurable.

Guardrails:

- No autonomous compiled-truth rewrite. Distillation output remains a patch
  candidate or reviewable diff.
- No ranking default flip without an EV-1 artifact.
- No personal/export scope widening; task and entity packs use the existing
  `read_context` evidence boundary.

## D-1 - The Distiller

Product bet: turn KM-1/KM-3/KM-5 into a morning review loop where the brain
offers N recompile proposals, M merge suggestions, and K supersession candidates
as one reviewable queue.

First artifact after activation:

- A report section that groups patch candidates by page and shows source refs,
  base content hash, and the exact compiled-zone diff.
- A single approval flow that applies accepted patch candidates through the
  existing hash-gated page write path.

Non-goal:

- Direct page rewriting by a runner or nightly job.

## D-2 - Adaptive Flywheel

Product bet: connect RS-3, RS-5, and FT-1 into a deterministic feedback loop:
usage improves ranking, recurring misses become acquisition prompts, and watched
questions surface answer changes.

First artifact after activation:

- A daily report block with three counts: hot reads, recurring gaps, and watched
  question changes.
- A trace-derived candidate list for additions or fixes, never automatic writes.

Non-goal:

- RL, self-training, or opaque ranking updates.

## D-3 - Entity Layer

Product bet: grow RW-1 and RS-6 into an explicit alias registry that gives
`resolve_slugs`-grade multilingual entity resolution to precision lookups.

First artifact after activation:

- A generated alias registry view backed by note manifests and explicit
  canonical targets.
- Entity cards that show aliases, backlinks, primary page, and ambiguity
  warnings.

Non-goal:

- String-only graph pointers. Entity links must preserve referential integrity.

## D-4 - Point-In-Time Brain

Product bet: combine RS-4, KM-4, and `page_versions` into
`read_context(as_of: <date>)` for time-scoped evidence reads.

First artifact after activation:

- A read planner that filters page versions and timeline windows by `as_of`.
- A warning when a requested selector has no version at the requested time.

Non-goal:

- A separate bi-temporal graph store.

## D-5 - Task Memory Packs

Product bet: grow RW-3 into proactive task-start context packs delivered through
the SessionStart activation card.

First artifact after activation:

- A budgeted pack containing relevant compiled truth, profile constraints, prior
  attempts/decisions, and watched-question deltas.
- A pack manifest that records selectors and content hashes so stale packs are
  detectable.

Non-goal:

- Replacing `retrieve_context` or `read_context`; packs are precomputed pointers
  and selected canonical reads, not a new evidence authority.
