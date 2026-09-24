# Answer-evidence packet pilot: did not help

The frozen 60-question holdout had **zero improved answers and five worsened
answers**. Full sessions scored **53/60 (88.3%)**; the excerpt packet scored
**48/60 (80.0%)**. Keep full-session presentation as the default. This experiment
does not support promoting the packet.

## What we tried

Both approaches kept retrieved sessions fixed and changed only their presentation
to the answering model. Neither generated summaries or changed retrieval.

| Approach | Hypothesis | Observed outcome | Decision |
|---|---|---|---|
| v1: query-relevant original rounds, adjacent context and qualifications | Removing irrelevant conversation would help the reader use the evidence. | Development fell from 15/18 to 14/18. Holdout fell from 53/60 to 48/60, with zero wins and five judged losses. | Do not promote. The selector can remove a fact needed for the answer. |
| v2: more selected rounds and wider adjacent context | Keeping more context might avoid the narrower packet's losses. | Development tied at 15/18, but 15 of 18 prompts were unchanged full sessions. Both answer flips used identical prompts. V2 was not run on holdout. | No demonstrated presentation benefit. A mostly unchanged prompt is not evidence that wider excerpts help. |

## Matched results

| Group | Questions | Full sessions correct | Packet correct | Improved | Worsened |
|---|---:|---:|---:|---:|---:|
| All holdout | 60 | 53 | 48 | 0 | 5 |
| Answerable | 48 | 41 | 38 | 0 | 3 |
| Abstention | 12 | 12 | 10 | 0 | 2 |
| All recorded gold-session IDs present | 56 | 50 | 45 | 0 | 5 |
| Some recorded gold-session IDs absent | 4 | 3 | 3 | 0 | 0 |

Both arms were correct on 48 questions and wrong on seven. All 60 pairs completed;
there were no reader or judge errors and no unknown-cost reservations. The gold-ID
coverage grouping is a property of the historical receipt, not proof that an
abstention question has an answer in its supplied context.

| Category, including its abstention cases | Questions | Full sessions | Packet | Net |
|---|---:|---:|---:|---:|
| Knowledge update | 10 | 10 | 8 | -2 |
| Multi-session | 12 | 11 | 9 | -2 |
| Single-session assistant | 8 | 8 | 8 | 0 |
| Single-session preference | 8 | 5 | 4 | -1 |
| Single-session user | 10 | 8 | 8 | 0 |
| Temporal reasoning | 12 | 11 | 11 | 0 |

The paired accuracy difference was -8.3 percentage points. Its seeded 95%
question-bootstrap interval was **[-16.7, -1.7] percentage points**. This describes
question-sampling uncertainty only, not reader or judge variability. Six holdout
pairs had byte-identical prompts; one of those still flipped from correct to
incorrect. Four judged losses occurred with changed presentation. Do not claim
all five losses were caused by excerpt selection.

## Every regression

Gold labels and official-style judge outcomes were retained without overrides.
Manual observations below are separate from those scores.

| Question ID | Observation |
|---|---|
| `2b8f3739` | A clear omission: the packet dropped an original round describing 20 plants sold at $7.50 each. Full sessions produced the gold total of $495; the packet omitted that $150 sale and answered $345. |
| `2e6d26dc` | The packet answered six rather than the gold count of five. The baseline received credit despite giving both five and six in its explanation. This is a grading/rationale caveat, not a clean demonstration of lost evidence. |
| `0edc2aef` | Both answers largely declined to recommend a hotel. The judge credited the baseline's clarification request but rejected the packet answer. Manual review flags the baseline credit as questionable under the personalization rubric. |
| `031748ae_abs` | The prompts were identical. Both answers noted a job-title mismatch while giving a team size, but the judge credited only the baseline. This flip cannot be attributed to changed presentation. |
| `2133c1b5_abs` | The baseline rejected the location premise; the packet answered a duration while noting conflicting locations. The unchanged abstention reference requires rejecting that premise. |

The useful engineering finding is narrower than the headline: lexical selection
can omit a necessary numeric detail even when the original retrieved session is
present. More compression or a cheaper prompt is not evidence of better answers.

## Lessons to carry forward

- **A retrieved session is not the same as a preserved answer.** The necessary
  sale was in the fixed source set but disappeared during excerpt selection.
  Recoverable pointers verify where retained text came from; they do not prove
  omitted text was irrelevant.
- **Separate changed-input effects from reader and judge variability.** Identical
  prompts still produced score changes, and manual inspection found questionable
  grading. Keep those caveats and the original scores together rather than
  attributing every flip to the formatter or rewriting unfavorable labels.
- **Do not trade answer quality for a smaller prompt.** The modest cost saving
  did not meet the predeclared quality gates. Leave full sessions unchanged; any
  different approach needs a fresh untouched comparison, not tuning on these
  already-inspected holdout questions.

## Development and cost

Development used 18 preselected questions. Variant v1 scored 14/18 versus the
baseline's 15/18: zero wins, one loss. The wider v2 scored 15/18: one win and one
loss, both on identical baseline/candidate prompts. Fifteen of v2's 18 prompts
were identical to full sessions. We selected v1 before holdout to test an actual
presentation intervention, not because development demonstrated a benefit. Both
variants' results remain in the private receipt archive.

| Spending | Usage-priced USD |
|---|---:|
| Development baseline | 0.864549 |
| Development v1 | 0.810868 |
| Development v2 | 0.863439 |
| Holdout full sessions, reader + judge | 2.860295 |
| Holdout packet, reader + judge | 2.613580 |
| **Total experiment** | **8.012731** |

The packet saved approximately $0.247 (8.6%) on holdout reader-plus-judge cost but
lost five judged answers. Holdout reader input fell from 910,540 to 831,175 tokens;
output fell from 5,584 to 5,081. Preprocessing made no generation calls. All 348
paid calls settled with reported usage, within the approved $20 total ceiling.
Costs use pinned canonical prices and reported usage, not provider invoices;
unpriced automatic cache-read discounts are conservatively charged at input rate.

## Scope and audit trail

This is fresh Sonnet 4.6 reading over **historical frozen retrieved candidates**,
not a new retrieval benchmark or a diagnosis of historical failed answers.
Provider snapshots were `claude-sonnet-4-6` and `gpt-4o-2024-08-06`. Both arms used
the unchanged reader system prompt, question/date, 512-token output limit and
common per-question ceiling, with deterministic alternating arm order. The
existing judge used temperature zero and a 16-token limit. No trajectory
enrichment, generated summary, retrieval call, or default change was involved.

- Dataset SHA-256: `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
- Historical D1 receipt SHA-256: `65ffeaa8299586e5a1dd6a9e10f269bab33462ab5470a95e329fbf189a703140`.
- Historical receipt repository commit: `9238ec8456bc94c3c082db105d7d8169a10a0b0f`.
- Reader/experiment starting repository commit: `6040075c6cb95be5881cc2e1b76ef7d71f4e5d29`.
- All 78 selected baseline requests matched the existing reader byte-for-byte;
  7,970 original passage pointers were mechanically recovered across both variants.
- Review fixes subsequently tightened interrupted-run reporting, response
  acceptance and overlong-input rejection. All 156 selected case/variant
  presentation strings remained byte-identical to the frozen evaluated formatter.
  The original evaluated source files are retained alongside the receipts.

Raw evidence, complete requests/responses, full judge outputs, code/configuration
hashes, and every paired outcome are retained in an owner-only archive rather than
committed publicly. See [the experiment guide](ANSWER_PACKET.md) for the runner,
cohort rules, conservative fallback behavior, and safe-resume contract.

The predeclared pilot rule failed on net wins, abstention regressions and category
regressions. Production presentation stays unchanged; this small experiment does
not justify a default rollout.
