# Core memory and pre-compaction save: preregistered evaluation

This file fixes the arms, metrics and pass bars for the always-loaded core
memory tier and the save-before-compaction path
([guide](../guides/core-memory.md)) before any sealed result exists. The
defaults these features ship with follow the sealed verdicts below; nothing in
this file changes after the first sealed run. Changes made before that run are
listed in the change log at the end, each with its date and reason.

## Question

Does an agent that loses its context to compaction answer later questions
better when (a) it is told to save what matters before compaction and can save
several facts in one call, and (b) a small owner-designated page of standing
preferences and instructions is loaded in every session?

## Benchmark and sealed sources

The sealed sources come from the shared held-out splits (gbrain-evals
`p0-heldout-harness`, `eval/decisions/splits/`, inspected at `9c7a3da`):

- **Pressure gate (E1): BEAM-500K sealed, all 24 conversations** (480
  questions, two of each of BEAM's ten question types per conversation),
  reserved for this decision on 2026-10-04. Each conversation is about 500k
  tokens, so a 32k-token window compacts it 30 to 70 times.
- **Core gate (E1-core): BEAM-100k sealed, all 14 conversations**,
  `preference_following` and `instruction_following` questions (56
  questions). The reservation was added on 2026-10-05 in
  `capy/p4-streaming-harness` `cd85997`; the custodian carries it into the
  split file before the run.
- LongMemEval-S is development data only (all 500 questions); its results
  never move a bar. BEAM-1M sealed stays in the custodian's reserve.

## Harness

gbrain-evals `eval/runner/p4-stream/` (branch `capy/p4-streaming-harness`,
`8cfae29` at this revision; the sealed run pins its own commit here first):

- One stream per conversation and arm. Each stream gets a fresh PGLite brain
  built by the arm's gbrain build, served as `gbrain serve --surface starter`
  over stdio. The agent sees the starter tools and the first 2,048 characters
  of the server instructions (Claude Code's per-server cap).
- Sessions stream in order. A session's turns up to its last user message
  are replayed as history; the last user message is a live turn with a
  700-token reply cap. A tool call cut off at that cap arrives with empty
  arguments, so that step is reissued with an 8,192-token cap (both calls are
  billed to the stream; the count is reported). Before each live turn the
  build's real `gbrain hook user-prompt` runs against a Claude Code-shaped
  transcript and its `additionalContext` is injected as a system reminder.
- When the next session would pass 95% of the window, `gbrain hook compact`
  runs, the model summarizes the conversation (2,500-token cap), a
  `compact_boundary` line is written, the history is replaced by the summary,
  and `gbrain hook session-start` (source `compact`) is injected.
- Every question of the conversation is asked from the same end state as a
  final live turn. Answers are judged 10 times with the BEAM rubric and
  `gpt-4.1-mini`.
- Every arm gets the same question-blind standing-preferences page, written
  by `gpt-4.1-mini` from the whole conversation without seeing any question.
  Only arm C marks it core, so C − A′ measures always-loaded delivery against
  retrieval of the same page.

## Arms

| Arm | gbrain build | What the agent gets |
|---|---|---|
| A′ | master at the sealed run (contains gbrain#6025, the MCP instructions reordered under the 2,048-char cap; development used that PR's head `5c82936a2`) | Baseline. |
| B | final head of this PR; `memory.core.enabled=false`, `memory.pressure.enabled=true`, `memory.pressure.context_window` = the window | Growth-aware save notice before compaction; `remember` with `items`. |
| C | same build; `memory.core.enabled=true`, `memory.pressure.enabled=false` | The standing-preferences page is core and loaded every session. |

Arm A (master before #6025) and arm D (both features, remote core edits
allowed) ran in early development only and are not part of the sealed run.

## Models

The newest frontier model of each family, per the gbrain eval model rules
(checked 2026-10-05): claude-sonnet-5-5 (the gate model, the model most users
run, reported first), claude-opus-5-5, gpt-6.1-sol and claude-fable-5-1. A
model at 100% on every arm is reported as a ceiling and counts neither way.

## Metrics

- Judged accuracy, 10 judge passes per answer, overall and per BEAM question
  type.
- Evidence-saved rate: share of questions where the agent saved at least one
  fact (`remember`) while a gold evidence session was live.
- Cost per question and cost per correct answer (agent, gbrain's own provider
  calls, standing-preferences page; stream cost shared evenly across the
  conversation's questions), from the budget ledger.
- Pressure notice fire rate and miss rate (compaction segments with no notice
  before the compaction); `remember` tool errors; cut-off tool calls.

## Pass bars (sealed sources)

Differences are paired by question; confidence intervals are 95% cluster
bootstrap intervals that resample whole conversations.

- **Pressure notice stays on by default** if, on claude-sonnet-5-5, B − A′ ≥
  +3.0 accuracy points with the CI lower bound above 0, and no question type's
  CI lies entirely below −2.0 points. Otherwise `memory.pressure.enabled`
  ships `false`.
- **Core delivery stays on by default** if C − A′ ≥ 0 on every model that is
  not at ceiling, and neither category's CI lies entirely below −2.0 points.
  Otherwise `memory.core.enabled` ships `false`.
- The report-only models decide nothing for the pressure gate; a negative
  B − A′ on one of them is reported next to the verdict.
- Cost gates neither default. Cost per question and cost per correct answer
  are reported for every arm and model, next to the verdict, in the release
  notes and in the post-upgrade notice that announces the defaults.

## Development results (set no default)

Recorded in `docs/eval/decisions/p4-stream-dev-pilot/`. On BEAM-500K
development conversation `500k-10` with claude-sonnet-5-5 and the corrected
harness, B scored 58.0% against A′'s 46.8% (+11.2 points, question bootstrap
95% CI [−2.8, +27.0], per-question SD 0.35), at $0.73 against $0.45 per
question ($1.26 against $0.97 per correct answer). The same conversation
scored A′ 60.7% in an earlier run, so a single conversation moves about ±14
points from run to run. On BEAM-100k development conversation `100k-1`, C
scored 54.4% against A′'s 35.7%; on the four preference and instruction
questions C answered all four, A′ two and a half.

## Power and cost (computed before any sealed cell)

- With the development SD of 0.35 and no clustering, 480 questions detect
  +4.5 points at 80% power with the CI excluding zero; between-conversation
  correlation widens that by √(1 + 19ρ) for an intraclass correlation ρ (one
  development conversation cannot estimate ρ). Detecting +3.0 points at 80%
  power needs about 1,070 questions, about 54 conversations, more than
  BEAM-500K sealed holds. The gate keeps the +3.0 bar; an effect between
  +3.0 and about +5 points will often fail it.
- The smallest design that reaches the +3.0 bar at 80% power adds BEAM-1M
  sealed (24 conversations; 48 in total, 960 questions, +3.2 points at ρ = 0)
  on claude-sonnet-5-5 only, at about $1,800 for A′ and B, with no
  report-only slice. It needs the custodian to release BEAM-1M from reserve;
  it is not the design below.
- Measured stream cost on development (claude-sonnet-5-5, judge included):
  about $25 per BEAM-500K conversation for A′ and B together, about $3.30 per
  BEAM-100k conversation for A′ and C together. Other models scale by their
  token prices: claude-opus-5-5 ×2, gpt-6.1-sol ×1, claude-fable-5-1 ×5.

## Sealed design (rewritten 2026-10-05, before any sealed cell)

Budget: the eval cap is $2,500 (raised from $1,400 on 2026-10-05 with Garry's
approval, relayed by the custodian), development spend included; about $310
is spent on development runs.

| Cell | Source | Models | Arms | Estimated cost |
|---|---|---|---|---|
| Pressure gate | BEAM-500K sealed, 24 conversations, 480 questions | claude-sonnet-5-5 | A′, B | about $610 |
| Core gate | BEAM-100k sealed, 14 conversations, 56 preference and instruction questions | all four | A′, C | about $410 |
| Pressure report-only slice | the first 4 BEAM-500K sealed conversations by the harness seed | claude-opus-5-5, gpt-6.1-sol, claude-fable-5-1 | A′, B | about $800 |

Total about $1,820, leaving about $370 of the cap for overruns (compaction
counts, and so stream cost, varied by 2× between development runs). Window
32k, judge 10×, reply cap 700 with the cut-off tool call reissue.

E2 (live delivery, $4 cap) and E3 (latency) run as specified below.

## Procedure

1. Iterate only on development data (this thread). Development results never
   move a bar.
2. The custodian runs each sealed cell once per arm and model at the final PR
   head, and records the verdicts with the run receipts in gbrain-evals.
3. The verdicts above set the shipped defaults; a failed bar flips the
   default off in the same PR before merge.

## Budget

Hard cap $2,500 for all E1 runs, development and sealed. The live delivery
check (E2) is capped at $4. Latency check (E3): session-start p95 under
1,500 ms with a full 4,000-char core, and non-core `put_page` overhead under
5 ms.

## Change log (all before any sealed cell)

- 2026-10-04: models moved from gpt-6-luna (full split) and
  claude-sonnet-5-5 (150-question slice) to the newest model of each family,
  per the gbrain eval model rules.
- 2026-10-05: the sealed source moved from LongMemEval-S to BEAM, because
  LongMemEval-S has no held-out portion and almost no question whose only
  evidence is the first session (core cannot move there). The custodian named
  BEAM-500K sealed for the pressure gate; BEAM-100k sealed was unreserved and
  now carries the core gate. Arm D left the sealed run.
- 2026-10-05: the per-category guard changed from "no category drops by more
  than 2.0 points" to "no category's CI lies entirely below −2.0 points". With
  48 questions per BEAM question type (28 per core category) the point
  estimate's standard error is about 5 points, so the old guard would fail by
  chance on most runs.
- 2026-10-05: development found two harness and product faults that made
  every earlier B measurement invalid: `remember` with `items` still required
  top-level provenance (fixed in this PR), and the 700-token reply cap cut off
  long batched `remember` calls, which then arrived with empty arguments
  (harness fixed by reissuing the step; gbrain now names that cause in its
  error). Only results from the corrected harness and build count as
  development evidence.
- 2026-10-05: Garry decided that the gates are accuracy only. The cost
  criterion (first "cost per question rises by at most 25%", then the
  proposed "cost per correct answer no higher than A′'s") is removed as a
  gate; cost per question and cost per correct answer stay reported metrics,
  stated plainly in the release notes and the post-upgrade notice.
