# P4 streaming dev pilot (development data, sets no default)

The streaming compaction harness (gbrain-evals `capy/p4-streaming-harness` at
`4c98318`, `eval/runner/p4-stream/`) runs LongMemEval-S as a live conversation
with a 32k-token window through gbrain's real Claude Code hooks. These numbers
come from development questions only; they size the sealed run and guide the
work. They never set a default.

## Builds

| Arm | gbrain commit | Config |
|---|---|---|
| A′ | `5c82936a2` (gbrain#6025 head: MCP instructions reordered under the 2,048-char cap) | defaults |
| B | `73bd681cb` (this PR merged with gbrain#6025) | `memory.core.enabled=false`, `memory.pressure.enabled=true`, `memory.pressure.context_window=32000` |
| C | `73bd681cb` | `memory.core.enabled=true`, `memory.pressure.enabled=false`; profile page marked core |
| B (growth trigger) | `cd613d775` (same, plus the growth-aware notice trigger) | as B |

## Results: claude-sonnet-5-5, 20 questions (seed 42, first 20), judge 10x

| Arm | Accuracy | $ per question | Compactions | Notice fired | Segments with no notice before compaction | Facts saved | Evidence-saved |
|---|---|---|---|---|---|---|---|
| A′ | 25.0% | 1.67 | 9.2 | 0% | 100% | 0.1 | 0% |
| B | 21.0% | 2.10 | 10.7 | 95% | 69% | 9.2 | 11% |
| C | 20.0% | 1.72 | 9.6 | 0% | 100% | 0.2 | 6% |
| B (growth trigger) | 75.0% | 2.87 | 13.3 | 100% | 28% | 27.4 | 56% |

Paired differences against A′ (question-level bootstrap):

- B − A′: −4.0 points, 95% CI [−20.0, +12.0], per-question SD 0.398, 20% of questions discordant.
- C − A′: −5.0 points, 95% CI [−25.0, +15.0], per-question SD 0.510, 25% discordant.

- B (growth trigger) − A′: +50.0 points, 95% CI [+20.0, +75.0], per-question SD 0.688, 70% of questions discordant; cost per question +72%.

The first two differences are not distinguishable from zero at n = 20. The pressure notice
fires in 95% of conversations but reaches only 31% of compaction segments: a
whole LongMemEval session (often several thousand tokens) arrives in one turn,
so fill often jumps from under 80% straight past the compaction point. The
growth-aware trigger (warn when two more turns of the size just seen would
reach the automatic compaction point) reaches 72% of segments; the agent saves
three times as many facts, a fact from a gold evidence session in 56% of
questions, and answers 15 of 20 correctly against A′'s 5.

## Two faults that invalidated earlier B results

Every B result above, and the first BEAM B results below, ran with two faults:

- `remember` with `items` still required top-level provenance, so a batch
  whose items carried their own provenance was refused (277 of 336 `remember`
  calls in one BEAM stream). Fixed in this PR: provenance may be given per
  item.
- The harness capped every live reply at 700 output tokens. A batched
  `remember` call longer than that is cut off, and the API delivers the tool
  call with empty arguments (`fact must be a non-empty string`; 182 of 245
  calls after the provenance fix). The harness now reissues a cut-off tool
  call with an 8,192-token cap and counts it (gbrain-evals `8cfae29`);
  gbrain's error for an argument-less `remember` names that cause.

The LongMemEval-S B numbers above (including the +50.0-point growth-trigger
result) were measured with both faults and are not evidence for or against
the feature.

## BEAM development results (claude-sonnet-5-5, judge `gpt-4.1-mini` 10x)

One stream per conversation; all 20 questions are asked from the same end
state. Only the last two rows of the first table share the corrected harness
and build.

BEAM-500K `500k-10`:

| Arm (build) | Accuracy | $ per question | Compactions | Facts saved | `remember` errors | Cut-off tool calls |
|---|---|---|---|---|---|---|
| A′ (`5c82936a2`) | 60.7% | 0.49 | 33 | 11 | 0 | not counted |
| C (`73bd681cb`) | 57.3% | 0.52 | 37 | 13 | 0 | not counted |
| B, growth trigger (`cd613d775`) | 80.7% | 0.93 | 66 | 162 | not counted | not counted |
| B, compact receipts (`1dab44d69`) | 61.0% | 0.88 | 63 | 148 | 277 | not counted |
| B, provenance fix (`349642275`) | 64.9% | 0.86 | 67 | 170 | 182 | not counted |
| A′, corrected harness (`5c82936a2`) | 46.8% | 0.45 | 33 | 10 | 0 | 1 |
| B, corrected harness (`349642275`) | 58.0% | 0.73 | 62 | 252 | 0 | 57 |

With the corrected harness, B − A′ is +11.2 points (question bootstrap 95% CI
[−2.8, +27.0], per-question SD 0.35, 45% of questions discordant). B costs
62% more per question and $1.26 against $0.97 per correct answer. A′ scored
60.7% and 46.8% on the same conversation in two runs, so one conversation
moves about ±14 points between runs: this sizes the sealed run and shows
plausible signal, nothing more. Core cannot move on this conversation:
A′ already answers every preference question.

BEAM-100k `100k-1` (core check):

| Arm (build) | Accuracy | $ per question | Preference following | Instruction following |
|---|---|---|---|---|
| A′ (`5c82936a2`) | 35.7% | 0.11 | 0.75 | 0.50 |
| C (`349642275`) | 54.4% | 0.10 | 1.00 | 1.00 |

Two questions per category, so this only shows the arm runs as intended and
the signal is plausible.

## Core on LongMemEval-S

The profile page comes from the first session only. In 11 of 500 LongMemEval-S
questions the earliest session is among the gold evidence sessions, and in 1
it is the only one, so C − A′ cannot move on this benchmark. Always-loaded
core needs a workload where a standing fact or preference stated once must be
honored much later: BEAM's `preference_following` and `instruction_following`
questions (40 each per size) test exactly that.

## Cost per cell (one question, one arm, arm A′)

| Model | $ per cell |
|---|---|
| claude-sonnet-5-5 | 1.67 to 2.10 (20-question mean) |
| claude-opus-5-5 | 3.15 (one cell) |
| claude-fable-5-1 | 8.61 (one cell) |
| gpt-6.1-sol | 0.85 (one cell) |

## Power (LongMemEval-S; superseded by the BEAM design in the preregistration)

With the measured per-question SD, a +3.0-point effect at 80% power with the
95% CI excluding zero needs about 1,380 questions per model for B − A′ and
about 2,270 for C − A′ (n = ((1.96 + 0.84) × SD / 0.03)²). LongMemEval-S has
500 questions in total. At about $14.50 per question per arm across the four
newest models, the pressure gate alone (A′ and B) at n = 1,380 costs about
$40,000; on claude-sonnet-5-5 alone about $5,200. The $1,400 cap buys about
28 questions across three arms and four models, where the 95% CI half-width is
about ±15 points.

Development spend through the BEAM runs: about $294 on the streaming harness, plus $14.95 for the LME-S retrieval guardrail in `p4-dev-2026-10-04` (about $310 in total, from the budget ledger). The sealed design and its power are in the [preregistration](../../CORE_MEMORY_PREREGISTRATION.md).
