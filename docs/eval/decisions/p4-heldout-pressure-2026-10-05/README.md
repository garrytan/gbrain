# P4 pre-compaction save (pressure notice): held-out verdict

The custodian (P0) ran the pressure gate once on BEAM-500K sealed with
claude-sonnet-5-5, under the preregistration in
[`docs/eval/CORE_MEMORY_PREREGISTRATION.md`](../../CORE_MEMORY_PREREGISTRATION.md).
Arms A′ (master with the MCP instructions reorder) and B (this PR's build with
the growth-aware save notice and `remember` with `items`) streamed every
conversation through a 32k-token window. The sealed receipts stay with the
custodian; the eval records are in garrytan/gbrain-evals#82. Verdict:
**pass**, so `memory.pressure.enabled` stays on by default.

## Gate

| Bar | Result |
|---|---|
| B − A′ ≥ +3.0 points, cluster bootstrap CI lower bound above 0 | **+11.3 points**, 95% CI [+8.3, +14.4] (51.7% → 63.0%) |
| No question type's CI entirely below −2.0 points | none |

460 paired questions across 23 conversations: one of the 24 sealed
conversations was dropped at its shard cap, so its 20 questions are not in
either arm.

## Caveat: session dates

The gbrain-evals BEAM loader dated only the first turn group of each batch,
so about 96% of BEAM-500K sessions reached the agent headed "[Conversation on
an unknown date]". Both arms saw identical headers, so the paired B − A′
(+11.3 points) and the verdict stand. The per-type numbers below were measured
with most session dates hidden, which matters most for temporal reasoning and
event ordering: read those two rows as measured under missing dates, not as
the size of the effect with dated sessions. The core gate (preference and
instruction questions, which do not depend on dates) is unaffected. The loader
fix goes into gbrain-evals separately.

## By question type (B − A′, points)

| Type | Δ |
|---|---|
| Temporal reasoning (most session dates hidden) | +24.3 |
| Knowledge update | +20.7 |
| Multi-session reasoning | +20.1 |
| Information extraction | +19.2 |
| Contradiction resolution | +15.5 |
| Event ordering (most session dates hidden) | +10.3 |
| Preference following | +4.6 |
| Summarization, instruction following, abstention | flat |

## Reported (not gated)

| Metric | A′ | B |
|---|---|---|
| Cost per question | $0.679 | $0.870 (+28%) |
| Cost per correct answer | $1.315 | $1.381 (+5%) |
| Evidence saved (a fact saved while a gold session was live) | 39.6% | 60.7% |

The extra cost is the extra saving: B makes more `remember` calls during each
stream. Per correct answer the difference is 5%. The release notes and the
post-upgrade notice state these costs.

309 compaction segments had no notice before the compaction. A session that
arrives in one large turn can jump past the warning point before the next
prompt; those misses are where the notice can improve next.

## Related verdicts

The core gate (BEAM-100k sealed, all four models) failed, so core memory is
off by default and available as an opt-in:
[core verdict](../p4-heldout-core-2026-10-06/README.md). The report-only
slice (claude-opus-5-5, gpt-6.1-sol and claude-fable-5-1 on four BEAM-500K
sealed conversations) decides nothing and is recorded when it lands.
