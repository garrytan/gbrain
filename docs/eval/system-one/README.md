# System One v1 evals: verdicts

**ELI10.** Jev helps in two places. It reads a whole chat and decides whether
anything worth remembering is buried in it. It also tells when a new fact
replaces an old one. Everywhere else we tried, the current system did as well
or better:

- **Dream triage (S7) finds what the current triage throws away.** On our test
  set it caught every one of 18 buried decisions, commitments and reflections;
  the current triage missed 10. The catch: it also sends about a third of
  boring chats to the writer. End to end that meant 10/10 buried signals
  remembered instead of 3/10, and about 75% more dream spend.
- **The contradiction sweep (S9) notices updated facts.** Today's cosine rule
  found none of 97 labelled updates. Jev found 94, with one wrong proposal.
- **Search reranking (S1) was worse than Voyage,** the reranker we use today.
- **The other slots** either didn't change results (S2) or could not pass the
  safety gate on our data (S3, S4, S6, S8). S5 was too small a test to call.

`gbrain decide enable --recommended` therefore turns on S7 and S9 only. Both
read private data (conversation windows and facts), so they need
`decide.egress.private=allow`.

Every number below comes from the eval half of a frozen split. Every label was
produced by a corpus generator, an LLM or a benchmark's own annotations;
**none is a human hand label** (see [PROTOCOL.md](PROTOCOL.md)). Total paid
spend: **$24.95 of the $40 cap**, itemised in [ledger.jsonl](ledger.jsonl) and
[ledger-datasets.jsonl](ledger-datasets.jsonl). Provider for every Jev number:
`typesafe:jev-1.13.0`, which always resolved to `jev-1.13.0`.

## Verdict table

Verdicts: **win** (the slot's headline metric improved and nothing it
guards got worse, or the trade is stated in the row); **mixed** (the headline
metric improved and another headline metric got worse); **no measurable
change**; **regression**; **inconclusive** (measured, but too little data or
LLM-only labels to call); **not measured**.

| Slot | Verdict | Headline numbers (eval half) | Qualification (0.90 gate) | Shipped |
|---|---|---|---|---|
| S7 triage | **win, costs more** | Buried-signal misses 10/18 → **0/18**; routine rejected 78/79 → 52/79; triage cost per transcript $0.0046 → $0.0009; triage latency p50/p95 2.2/6.2 s → 1.4/4.2 s. Preset E2E: 10/10 buried signals synthesized vs 3/10, junk pages 2 → 5, dream spend $1.50 → $2.60 | qualified: 39/39 correct rejections, lb 0.910 | reference calibration + `--recommended` |
| S9 conflict | **win** | Supersedes found 0/97 (cosine rule) → **94/97**; wrong supersedes 10 → 1; $0.00002 per swept fact | not a harmful slot (proposals only) | reference calibration + `--recommended` |
| S1 rerank | **regression** | LongMemEval-S (233 answerable): recall_all@5 94.8% (Voyage) vs 94.0 / 91.4 / 92.7% (Jev at top_n_in 30/50/100); R@1 94.4% vs 91.4–91.8%. Answer accuracy (100 q) 91% vs 89%. LongMemEval-M pilot: R@1 87.5% vs 75.0% (100) / 70.8% (300) | n/a (no threshold) | no |
| S2 intent | **no measurable change** | Routing accuracy search 46.5% → 66.9%, think 58.7% → 77.0%, but LongMemEval retrieval 0 wins / 0 losses | n/a (not harmful) | no; `wait_ms` default raised to 250 |
| S3 evidence | **regression** | Calibrated threshold (0.02) never prunes. At the lowest acting threshold (0.08, forced): recall_all@5 94.8% → 91.4% (1 win / 9 losses, p=0.02), sessions in top 5 4.89 → 3.52 | fails: best acting lb 0.869 | no |
| S4 answerable | **regression** | Abstention precision ≤ 34% at any acting threshold (0.20: 13 of 38 abstentions correct) | insufficient_n (15 abstention families in the eval half) | no |
| S6 recall_needed | **mixed** | Reflex-miss corpus: know-to-ask failures 71.3% → **11.3%**; sealed BrainBench: failures 0% → 0%, false fires 0% → 8.5%; turn latency p50 10 ms → 161 ms | insufficient_n: 14/14 correct suppressions, needs 35 | no |
| S8 grounding | **inconclusive** | Real dream-page units: quarantines 25, 22 of them unsupported by LLM label (88%); catches 13% of LLM-flagged unsupported units; 3/206 supported units wrongly quarantined | insufficient_n: 11 page families, 3 with a wrong quarantine | no |
| S5 injection | **inconclusive** | 12 fixtures: at 0.65 flags 3/4 attacks, 0/32 clean; a quoted payload scores 0.56–0.60. On LongMemEval (no attacks) it demoted 0.8% of candidates | not harmful | no |
| S7 on a local `llm:` model | **not measured** | Time budget went to the matched pairs above | — | — |

## Per-slot detail

### S7 triage (win, costs more)

Matched pair on 109 eval-half transcripts (13 Cat 35 + 96 synthetic), through
`runTriagePass`, the function `gbrain dream` calls. Off is today's Haiku 4.5
judge plus the rescue band. On is Jev per-window probabilities at the
calibrated 0.77 threshold; answers in the margin band go to the Haiku judge.

| | off (Haiku) | on (Jev) |
|---|---|---|
| Synthesis-worthy transcripts passed | 20/30 | **30/30** |
| Buried-signal (synthetic) passed | 8/18 | **18/18** |
| Cat 35 real positives passed | 12/12 | 12/12 |
| Routine transcripts rejected | 78/79 | 52/79 |
| Sent to synthesis | 21 | 57 |
| Accuracy | 0.90 | 0.75 |
| Triage cost per transcript | $0.0046 | $0.0009 |
| Latency p50 / p95 / p99 | 2.24 / 6.22 / 7.66 s | 1.44 / 4.16 / 5.15 s |
| Decision flip rate (two runs) | 0.9% | 4.6% |

Paths in the on arm: 57 Jev pass, 37 Jev reject, 15 margin hold (Haiku
decided). McNemar on the discordant pairs favours off on accuracy (11 vs 27,
p=0.014), because the errors differ in kind: off drops real signal, on
synthesizes routine chats. Calibration: recall 1.0 on the calibrate half,
retest_sd 0.014, repack_sd 0.013, ECE 0.46. Jev probabilities are not
calibrated in absolute terms (routine windows score 0.6–0.8); the threshold,
not the raw number, carries the meaning.

**Preset end to end** (`enable --recommended` on a fresh brain, then
`gbrain dream --phase synthesize`, 29 eval-half transcripts, the same corpus
for both arms):

| | all off | preset (S7 + S9) |
|---|---|---|
| Transcripts synthesized | 10 | 19 |
| Synthesis-worthy transcripts synthesized | 9/16 | **16/16** |
| Buried-signal transcripts synthesized | 3/10 | **10/10** |
| Routine transcripts synthesized (junk) | 1 (2 pages) | 3 (5 pages) |
| Pages written | 20 | 38 |
| Dream spend (triage + synthesis estimate) | $1.50 | $2.60 |
| Synthesize phase wall time | 733 s | 1,427 s |

The preset contains no query-path slot, so query latency and answer quality
are unchanged by construction. S9 ran in the cycle but found 0 facts to sweep:
the synthesized pages carry no `## Facts` fence. Its evidence is the labelled
pair eval below, not this run.

### S9 conflict (win)

395 eval-half fact pairs; 97 supersede, 75 duplicate, 223 independent labels.
780 pairs come from a template generator and 6 from repository tests.

| | cosine rule (today) | S9 (dup 0.52, floor 0.65) | S9 (floor 0.50) |
|---|---|---|---|
| Supersedes found | 0/97 | 94/97 | 95/97 |
| Wrong supersedes / proposals | 10/10 | 1/95 | 1/96 |
| Label agreement | 0.565 | 0.939 | 0.942 |

On the 88 pairs the sweep can actually see (cosine ≥ 0.80), S9 finds 29/30
supersedes with 0 wrong proposals. The calibrated proposal floor (0.65, F1 on
supersede labels) performs the same as the 0.50 default. Decision flips 0/395;
latency p50/p95 146/221 ms per fact.

### S1 rerank (regression)

LongMemEval-S cleaned, 248 eval-half questions (233 answerable). Every arm
shares one embedding cache (openai:text-embedding-3-large at 1536 dimensions)
and differs only in the reranker.

| Arm | recall_all@5 | R@1 | Jev top-1 when present | Rerank p50/p95 | Cost/q |
|---|---|---|---|---|---|
| no reranker | 93.6% | 91.8% | — | — | $0 |
| **Voyage rerank-2.5, top_n_in 30 (today)** | **94.8%** | **94.4%** | 220/233 | — | ~$0.001 |
| Voyage, top_n_in 100 | 94.8% | 93.1% | 217/233 | — | ~$0.0015 |
| Jev, top_n_in 30 | 94.0% | 91.8% | 214/233 | 381/521 ms | $0.0008 |
| Jev, top_n_in 50 | 91.4% (p=0.02) | 91.4% | 213/233 | 512/750 ms | $0.0013 |
| Jev, top_n_in 100 | 92.7% | 91.4% | 213/233 | 515/716 ms | $0.0013 |
| Jev, top_n_in 100 (retest) | 92.3% | 91.8% | 214/233 | 494/649 ms | $0.0013 |
| expansion + Jev 100 | 93.6% | 91.8% | — | 248/248 timed out | — |

- **Recall experiment.** On LongMemEval-S the fused pool is the whole haystack
  (about 47 sessions), so pool recall is 100% at depth 30. The frozen
  28-question LongMemEval-M pilot (500 sessions per question,
  text-embedding-3-small) also had every answer session in the fused top 30.
  There, Voyage R@1 was 87.5%, Jev@100 75.0% and Jev over a deep 300-candidate
  pool 70.8% (n=24; not significant, but no arm beat today's).
- **GBRA-4's 134/134 did not replicate.** Jev put the target first in 213/233
  questions where it was present; Voyage did in 220/233.
- **Answers.** 100 questions, Haiku 4.5 reader, gpt-4o judge: 91% with Voyage,
  89% with Jev@30 (1 win, 3 losses).
- **Bug found, then fixed.** In this run, with query expansion on, S1 never
  reranked: the 1,500 ms per-query decide budget (`decide.query_budget_ms`)
  started at request start, and the expansion call used it up. Every row fell
  back to fused order, so the "expansion + Jev 100" row above measures fused
  order, not Jev. The budget now starts at the first post-retrieval decide
  stage (regression test in `test/decide/search-slots.serial.test.ts`); that arm
  was not re-measured.

### S2 intent (no measurable change)

Routing accuracy on 424 eval-half queries (the labels map LongMemEval
`question_type` and BrainBench relational cases): search 46.5% → 66.9%
(51 overrides: 41 helped, 6 hurt), think 58.7% → 77.0%. Retrieval did not move:
the S2 arm on LongMemEval-S matched today's on every question.

- **Late rate.** How many answers arrive after the wait bound:
  - From a Capy machine: 39–41% after 150 ms, 7–8% after 200 ms, 1–3% after
    250 ms, under 1% after 300 ms.
  - From the eu-central Ubicloud VM: 27% after 250 ms.
- **Decision.** `decide.slots.intent.wait_ms` now defaults to 250 ms. It keeps
  the full routing accuracy on the Capy machine at a p50 cost of about 145 ms.

### S3 evidence (regression)

The recall ≥ 0.98 calibration picks 0.02, which the 0.05 margin turns into
"never prune". About 10% of real answer sessions score at or below 0.06,
because the 6,000-character candidate cap cuts the answer out of long
sessions. Production's `capRerankDoc` applies the same cap. So any acting
threshold prunes real evidence:

- At 0.08 the family-level lower bound is 0.869 on the eval half (fails 0.90).
- Forced on at 0.08, top-5 evidence-complete recall dropped 94.8% → 91.4%, for
  28% fewer sessions in the reader's context.

With S5 co-packed, calibration now records the pack shape it sent
(`slots=evidence+injection`) and co-packs S5 questions in calibrate/qualify;
see `test/decide/evidence-copack-calibration.serial.test.ts`.

### S4 answerable (regression)

500 LongMemEval questions, 30 of them abstention. Over the top-5 sessions, Jev
gives many answerable questions a low probability (median 0.64, 10th
percentile 0.13). At 0.20 it would abstain on 38 eval-half questions, 13
correctly. The calibrated threshold (0.05) never abstains. Not run through the
judged reader, because the dataset-level precision already rules it out.

### S6 recall_needed (mixed)

| Eval half | reflex only | S6 on (0.74, suppress below 0.10) |
|---|---|---|
| Reflex-miss corpus (264 turns): know-to-ask failures | 71.3% | **11.3%** |
| Reflex-miss corpus: false fires | 55.7% | 49.7% |
| Sealed BrainBench (79 turns): failures | 0% | 0% |
| Sealed BrainBench: false fires | 0% | **8.5%** |
| Turn latency p50 / p95 (sealed) | 10 / 19 ms | 161 / 258 ms |

- **Reflex-miss corpus.** Lowercase names, surnames and indirect references;
  synthetic, labels by construction.
- **Suppression.** 14 suppressions, all correct, but 35 families are needed to
  qualify. At the old 0.05 default no turn was ever suppressed (0 of 343), so
  the default is now 0.10.
- **Deadline.** 3% of S6 answers missed the 250 ms deadline; the reflex result
  stood.

### S8 grounding (inconclusive)

750 claim units from 16 Cat 35 dream pages, labelled by Claude Sonnet 5 (567
real units, 183 perturbation negatives). At the recall ≥ 0.95 calibration
(threshold 0.29):

- **Real units.** 25 quarantined, 22 of them LLM-unsupported; 13% of
  LLM-unsupported real units caught; 3 of 206 supported units lost.
- **Perturbations.** 63 of 126 caught, 0 false.
- **Qualification.** Impossible with 16 page families, 11 in the eval half.
- **Owed.** The plan's human-labelled sample.

### S5 injection (inconclusive)

Across 3 repeats, attacks scored 0.50–0.94 and clean candidates 0.02–0.08. The
exception is a legitimate candidate quoting an attack payload (0.56–0.60). At
0.65, S5 flags 3 of 4 attacks and no clean candidate. On LongMemEval, which
has no attacks, it demoted 93 of 11,402 candidates.

### Judge harness (eval-only)

`gbrain decide judge-agreement`:

- **LongMemEval answers:** Cohen's kappa 0.73 (95% CI 0.51–0.96) against the
  gpt-4o judge, 95% agreement, n=100.
- **Grounding:** kappa 0.58 (0.52–0.64) against the Sonnet 5 labels, 78.7%
  agreement, n=750.

Both compare one judge with another, not with human labels.

## Files

- [PROTOCOL.md](PROTOCOL.md): how pairs were run, thresholds chosen, labels
  marked.
- [datasets/](datasets/): frozen datasets, generators, [HASHES.md](datasets/HASHES.md).
- [receipts/](receipts/): calibrate/qualify JSON, recorded Jev answers,
  per-question retrieval rows, summaries and the preset run.
- [runners/](runners/): `s7-triage-pair.ts`, `ask-dataset.ts`,
  `s2/s6/s8/s9-analyze.ts`, `lme-arms.sh` (LongMemEval arms on Ubicloud),
  `lme-summarize.py`, `s6-brainbench-summary.py`, `summarize-pair.ts`.
- Reference calibrations: `src/core/ai/decide/reference-calibrations.ts`.
