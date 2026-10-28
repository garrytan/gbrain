# Key files: Recall ranking

[Subsystem index](../KEY_FILES.md). Read only the entries relevant to your change.
Current behavior and load-bearing invariants; history belongs in Git and CHANGELOG.

recall's `question` ranking itself (pool, score, admission) is the
`src/core/facts/question-recall.ts` entry in [Graph And Facts](graph-and-facts.md).
This page covers the two switches layered on it (#2941, #2953) and the
typed-claim conflict lane whose proposals recall labels `contested`.

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

## Typed claims and the claim-conflict lane

`remember` takes `claim_metric`, `claim_value`, `claim_unit` and
`claim_period` (a single call and each batch item, never shared across items;
`src/core/verbs.ts`, `src/core/remember-batch.ts`). `parseClaimParams`
validates them with the facts-fence codec as the oracle and refuses
`invalid_params` with the corrected call as `fix.mcp`. The claim rides the
write request into `src/core/persistence/memory-prepare.ts`: the new row, the
fence row `fenceRowOf` renders, the hold payload and its release
(`src/core/trust/owner-actions.ts`, `src/core/trust/release-publish.ts`), and
the receipt. A typed write never supersedes a typed fact in another claim slot
(`sameClaimSlot` in `src/core/facts/single-prepare.ts`); the same text with a
claim supersedes an untyped copy and never rewrites a typed one
(`claim_ignored: existing_claim`).

The detector proposes one `decide_proposals` row per conflicting pair: same
source, entity, metric, unit and period (null-safe), same as-of bucket, both
facts active, non-audit and the same visibility. The unique expression index
`decide_proposals_claim_pair_uidx` (migration v279) over the unordered pair for
`claim_conflicts:` sweeps and `insertProposal`'s `ON CONFLICT DO NOTHING` keep
concurrent runs to one row; the anti-joins skip pairs any sweep already
proposed and pairs with a pending trust `supersede_fact` proposal. It runs as
the global dream phase `claim_conflicts` (after `edge_contradictions`, sources
with no local path included, `no_coordinated_write`) and as
`gbrain decide sweep --claims`. `src/core/trust/review.ts` lists pending
proposals with both facts active as kind `contradiction` (`dp<id>`) with
`supersede`, `forget`, `confirm` and `drop` argv plus `command_meta`; the
`--accept-all` path in `src/commands/trust.ts` skips them.

Tests: `test/claim-conflicts.test.ts` and `test/remember-typed-claims.test.ts`
(both engines; Postgres through their `test/e2e/*-postgres.test.ts` twins).

## Files

- `src/core/facts/recall-config.ts` — recall's config keys: `recall.confidence_weighting` and `recall.group_by_entity` (`on` | `off`, default off; unset, unreadable or unknown stored values read as off) and `recall.question_admission` (`reserve` | `facts_arm`). `recallConfigValueRefusal` is what `gbrain config set` (commands/config.ts) calls for every `recall.*` key, so a typo is refused instead of stored.
- `src/core/facts/decay.ts` — `effectiveConfidence` (confidence × exp(-age/half-life) from `valid_from`; the hot-memory injector and recall's CLI JSON `effective_confidence`) and `recallConfidence(fact, dated, now)`, the weighting's belief weight: trust is a floor (`TRUST_RECALL_FLOOR`: `user_confirmed` and `operator_curated` weigh 1 at any age), every other tier decays by `effectiveConfidence` times `TRUST_RECALL_WEIGHT` (tool 0.9, agent and unknown 0.8, external 0.6). A writer-dated `fact` row does not decay; expired or lapsed rows weigh 0. `confidenceFactor(w) = 0.5 + 0.5w`, so weighting at most halves a score.
- `src/core/facts/typed-claim.ts` — the typed-claim columns: `parseClaimParams` (fence round-trip validation, `claim_metric` required with any other key), `claimColumns`/`storedClaim` (set columns only), `claimBucket` and its SQL twin `claimBucketSql` (UTC day; ISO week, month, quarter or year for `weekly`/`monthly`/`quarterly`/`annual`/`annually`/`yearly`; any other period is a day bucket), `sameClaimSlot`.
- `src/core/facts/claim-conflicts.ts` — the keyless detector: `dream.claim_conflicts.mode` (`propose` | `off`, default off; anything else reads off and `gbrain config set` refuses it), `dream.claim_conflicts.max_pairs` (default 500; the rest is `deferred` and the run is `partial`), `runClaimConflicts(engine, {sourceIds, dryRun})` and `claimConflictsCyclePhase` (`skipped` with `mode_off` when off). Proposals carry `p_supersede` 1, `model_resolved` null and a `claim_conflicts:<uuid>` sweep id.
- `src/core/facts/contested-claims.ts` — `withDecideContested`: recall's `contested` {proposal_ref `dp<id>`, role, fact_id} for a delivered fact in a pending decide proposal whose other fact the caller can read (world-only when remote, private provenance, the trust floor, active); one batched read, and a failed read sets `facts_degraded: {reason: 'contested_unavailable'}` instead of failing the recall. The CLI prints `(contested by #<id>)`.
- `src/commands/decide/claims-sweep.ts` — `gbrain decide sweep --claims [--source <id>] [--dry-run] [--json]`: no slot, `--since` or key; an unknown or archived source refuses `unknown_source` with nothing written; exits 1 only on a `failed` run.
