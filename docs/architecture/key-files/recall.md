# Key files: Recall ranking

[Subsystem index](../KEY_FILES.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.

recall's `question` ranking itself (pool, score, admission) is the
`src/core/facts/question-recall.ts` entry in [Graph And Facts](graph-and-facts.md).
This page covers the two switches layered on it (#2941, #2953).

## Confidence weighting and entity grouping

With `recall.confidence_weighting` on, `rankFactsByQuestion` multiplies each
admitted fact's relevance by `confidenceFactor(recallConfidence(...))` after
admission (admission still reads raw relevance, so the admitted set never
changes), orders by that rank score, newest `valid_from`, id, and only then
collapses copies (#7043) and cuts to `limit`; `weightedRepresentative`
delivers a collapsed group's best-ranked copy, not its newest. The response
keeps `relevance` raw and adds `rank_score` and `confidence_factor` per fact
(`src/core/ops/facts.ts`).

With `recall.group_by_entity` on and no `entity`, `groupFactsByEntity` runs
in the recall op after the limit and budget cuts, so it only reorders the
delivered facts: groups keyed by (source_id, entity_slug), ordered by their
best fact, a null-entity group for unscoped facts, `facts_groups`
[{source_id, entity_slug, fact_ids, top_relevance}], and, when two or more
entities answer, `entity_unspecified` {candidates, suggestion} plus the
`entity_unspecified` info notice whose decision offers one recall per entity
(at most 5). Grouping reads delivered rows only, so a remote caller never
learns of a hidden entity. Both switches work the same on repo-less brains:
they read database rows only.

Tests: `test/recall-confidence-grouping.test.ts` (both engines; Postgres
through `test/e2e/recall-confidence-grouping-postgres.test.ts`).

## Files

- `src/core/facts/recall-config.ts` — recall's config keys: `recall.confidence_weighting` and `recall.group_by_entity` (`on` | `off`, default off; unset, unreadable or unknown stored values read as off) and `recall.question_admission` (`reserve` | `facts_arm`). `recallConfigValueRefusal` is what `gbrain config set` (commands/config.ts) calls for every `recall.*` key, so a typo is refused instead of stored.
- `src/core/facts/decay.ts` — `effectiveConfidence` (confidence × exp(-age/half-life) from `valid_from`; the hot-memory injector and recall's CLI JSON `effective_confidence`) and `recallConfidence(fact, dated, now)`, the weighting's belief weight: trust is a floor (`TRUST_RECALL_FLOOR`: `user_confirmed` and `operator_curated` weigh 1 at any age), every other tier decays by `effectiveConfidence` times `TRUST_RECALL_WEIGHT` (tool 0.9, agent and unknown 0.8, external 0.6). A writer-dated `fact` row does not decay; expired or lapsed rows weigh 0. `confidenceFactor(w) = 0.5 + 0.5w`, so weighting at most halves a score.
