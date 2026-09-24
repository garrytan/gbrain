---
title: "T-Mem: failed validation for GBrain"
date: 2026-09-24
status: mothballed
tags: [research, retrieval, t-mem, negative-result, postmortem]
---

# T-Mem: failed validation for GBrain

[Research index](../README.md)

**Decision: mothball the custom integration in [gbrain#5374](https://github.com/garrytan/gbrain/pull/5374), and preserve the research without shipping that feature.** This does not establish that the paper's idea is false. Our implementation failed to complete its comparison, and the later released-code pilot did not demonstrate an answer-quality gain.

## In plain English

The idea was to give old memories extra search labels so they would surface when a new question did not use the same words. The labels occasionally helped find the right memory. But they sometimes displaced a useful memory, and the answer writer could still ignore the right fact after receiving it. Better labels did not reliably become better answers.

## Two separate failures

### 1. Our custom implementation never proved its value

The feature-off control found one of two required memories in the retained test case. Feature-on construction repeatedly stopped before query scoring because generated cues failed output-shape or validation requirements. The last retained attempt stopped after 141 processed windows when a literal privacy keyword rule rejected general AI/psychology discussion, rather than a new personal diagnosis.

No complete real feature-on retrieval score was obtained. Passing code tests and isolated cue-generation checks did not establish a retrieval improvement. These were failures of our implementation and evaluation execution, not evidence against the underlying paper.

We spent too much effort iterating on construction and validation before establishing an end-to-end benefit. The sequence should have been a small, faithful matched experiment first, then integration justified by its result.

### 2. The authors' released code ran, but did not reproduce the claimed benefit

Twenty Cognitive cases were selected before inference, balanced across the four relation types. Each case used one shared memory library across three variants. All twenty cases completed in every variant; no failed or unfavorable cases were dropped.

| Variant | Target source scene in top ten | Answers judged correct |
|---|---:|---:|
| Full Scene + Horizon | 14/20 | 9/20 |
| Scene only, no Horizon | 14/20 | 10/20 |
| Raw-dialogue baseline, neither trigger | 13/20 | 10/20 |

Full retrieval recovered two memories missed by the baseline (`sample_116`, `sample_301`), lost one the baseline found (`sample_166`), and tied on seventeen. The recovered summaries contained the relevant facts, but neither recovery produced a successful full-arm answer. Both recoveries also happened with Scene alone: Horizon added no target-memory hits in this sample.

The original one-pass answer labels are preserved. Full versus baseline had zero scored wins, one loss and nineteen ties. However, the judge made visible speaker-attribution mistakes, including the sole scored loss. Do not turn the 45% versus 50% score into a clean claim of harm, or silently correct the scores to favor either variant.

## Why the result was not a faithful headline replication

The paper reports 74.81% versus 52.62% on all 401 Cognitive cases. Its released Plus route differs materially:

- It skips the described hierarchical items/persona/reranker cascade and uses ten scene summaries.
- Its RRF rank-fusion constant defaults to 30 rather than the paper's 60.
- It builds memory with the test query already present. The query-containing scene ranked first in 18/20 full-arm cases and all twenty baseline cases. This is query-conditioned construction, not proof of answer-label leakage, and not a test of a memory store frozen before the query.
- The small pilot shares nine base-conversation histories, and the exact original serving revisions are unknown.

These differences were recorded before inference, not invented to explain the outcome. We did not change the prompts, models, case selection or retrieval settings after observing a disappointing result.

## What we learned

1. Validate a research claim before investing in a production adaptation. A completed matched comparison is more useful than another green implementation milestone.
2. Separate construction reliability, target-memory retrieval and final-answer quality. Improving one does not prove improvement in the next.
3. Inspect actual contexts and judge reasoning. A stored query can dominate retrieval, and an automated judge can reject an answer that recalls the right fact.
4. Match the claimed experiment, not merely the paper's model names. Released scripts, historical artifacts and paper settings must agree, or the experiment needs a narrower label.
5. Preserve weak positive signals as well as failures. Two descriptive-trigger recoveries are real, but they are not evidence of Horizon's added recall or a large overall gain.

## Disposition of #5374 and the companion work

[gbrain#5374](https://github.com/garrytan/gbrain/pull/5374) is **mothballed, closed without merging**. Its branch is retained as historical source, not maintained as a merge-ready feature. The published prototype head is [4f5382a](https://github.com/garrytan/gbrain/commit/4f5382a65f8aef96ab6c04ea7e6c32062da849ad). Its passing implementation tests never supplied the missing end-to-end retrieval result, so neither those tests nor the small released-code signal justify landing it.

The disposition separates three changes:

- [gbrain#5453](https://github.com/garrytan/gbrain/pull/5453) preserves this postmortem, the protocol, measured results and reproducible evidence. It does not introduce the feature's runtime code.
- [gbrain-evals#34](https://github.com/garrytan/gbrain-evals/pull/34) preserves the evaluation harness independently. Its pinned [939232f prototype](https://github.com/garrytan/gbrain/commit/939232f1746381b4e932d620d6c709e29198f14c) belongs to the unmerged experimental lineage, not the current production release. Landing that harness does not establish a capability gain or authorize another paid experiment.
- #5374 remains unmerged. Its conflicts are not being repaired to prepare it for shipping, and the later unpublished prototype work is not being folded into either archival PR.

## Conditions for reopening

Reopening needs new evidence or a materially clearer experimental protocol, not another schema/repair iteration: obtain the exact paper runner or explicitly label a reconstruction; test memory constructed before the query if that is the intended GBrain behavior; complete a preselected matched comparison that measures both retrieval and answers; and audit judge reliability without replacing unfavorable primary results after the fact.

Reopening #5374 also requires an explicit new decision to resume the feature. Preserving its branch, documentation and evaluator is not that decision.

## Evidence and sources

- [Measured results and limitations](results.md).
- [Per-case labels and source-provenance results](paired-results.csv).
- [Pre-inference protocol](protocol.md) and [paper/code methods audit](method-audit.md).
- [Frozen reproduction bundle](tmem-reproduction-results.tar.gz): runner, tests, gateway, data pins, dependency inventory, aggregate receipts and hashes. It excludes credentials and raw benchmark conversations or predictions.
- [Pinned input manifest](inputs.json): public dataset URLs and SHA-256 hashes, without dataset contents.
- [Original paper, arXiv 2606.15405v2](https://arxiv.org/abs/2606.15405v2), audited 2026-09-24.
- [Released source at dd9e152](https://github.com/Sherlockwz/T-Mem/tree/dd9e1527bc75908485809580c9520af5a9a42879).

The original-code work cost $9.224531784 in reported charges, with $0.1653932 retained for three unresolved requests. Historical custom-implementation costs are separate. No paid rerun was started to create this archive. [SHA256SUMS](SHA256SUMS) covers the files in this directory; verify from this directory with `sha256sum -c SHA256SUMS`. The compressed bundle is frozen evidence, not an installed GBrain component or maintained provider gateway. Its own manifest covers its extracted contents.
