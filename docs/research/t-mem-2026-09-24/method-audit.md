# T-Mem Table 4 methods audit

**Audit date: 2026-09-24.** The released code supports a matched Scene/Horizon
scene-only ablation, but its documented LoCoMo-Plus command does not implement the
paper's claimed shared hierarchical cascade. Running that command, even after
changing RRF to 60, is a released-code reproduction, not a faithful Table 4
replication. The audit preceded benchmark inference; the subsequent result is in
the [postmortem](postmortem.md).

This is a repository-portable account of the audit. The original line-by-line
working record is preserved inside the [frozen bundle](tmem-reproduction-results.tar.gz).
Paper claims refer to [arXiv 2606.15405v2](https://arxiv.org/abs/2606.15405v2),
especially Table 4, Experimental Setup and the reproducibility appendix. Code
references are pinned to [dd9e1527bc75908485809580c9520af5a9a42879](https://github.com/Sherlockwz/T-Mem/tree/dd9e1527bc75908485809580c9520af5a9a42879),
not mutable upstream `main`.

## Target and data identity

Table 4 reports Cognitive memory-awareness accuracy of **74.81%** for full T-Mem,
**62.34%** without Horizon, and **52.62%** without Scene and Horizon. These are
author reports, not our measurements. The paper reports only the Cognitive
subset as its LoCoMo-Plus score; this is not ordinary exact-answer accuracy.

The pinned public files contain 401 Cognitive samples: 101 causal and 100 each
state, goal and value. Each sample has its own memory library and uses base
conversation `original_index % 10`. It is not ten shared libraries containing all
401 cues. [Stage 0](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/T_mem/main/stage0_locomo_plus_stitch.py#L159-L203)
binds those identities; [Plus stage 5](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/T_mem/main/stage5_retrieval_locomo_plus.py#L88-L151)
selects each sample's library.

The [input manifest](inputs.json) records immutable download URLs and hashes:

| Input | Repository revision | SHA-256 |
|---|---|---|
| `locomo10.json` | `snap-research/LoCoMo` at `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` |
| `locomo_plus.json` | `xjtuleeyf/Locomo-Plus` at `059f4e3d38f7f1f96765e8e2cb7de3097551bffb` | `af2fc6e5e0e88735e28d8dd1ef474b718861a73beb21779809e3b9e1a4fe3d23` |

These are not proof of the exact historical files used for Table 4. The released
downloader follows mutable branches and keeps existing files. Generation metadata
such as `scores`, `ranks` and `final_similarity_score` is not a scoring target and
was not used to select the pilot.

## Paper settings versus the executable route

| Setting | Paper v2 | Released Plus route |
|---|---|---|
| Construction / reader / judge | GPT-4.1-mini / GPT-4o / Gemini-2.5-Flash | Matching aliases; exact serving revisions remain unknown |
| Dense model / reranker | BGE-M3 / BGE-reranker-v2-m3 | Both configured, but Plus never calls the reranker |
| Final topic / scene / item budgets | 15 / 5 / 15 | Reader defaults to ten scene summaries, without topic/item inputs |
| Item-trigger union / cosine gate | 10 / 0.85 | Implemented in stage 6, which Plus skips |
| RRF smoothing | 60 throughout | Stage 5 defaults to 30 |
| Retrieval cascade | Shared across benchmarks | Plus runs stage 5 directly into stage 8 |

The [Plus shell runner](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/scripts/eval_locomo_plus.sh#L152-L203)
shows the direct route. The [configuration](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/T_mem/config.py#L18-L112)
contains the named models and hierarchical budgets, but building those artifacts
does not make the [Plus reader](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/T_mem/main/stage8_qa_locomo_plus.py#L65-L80)
consume them. Setting top-K to five would not supply the missing fifteen items.

Simply inserting stage 6 also does not work: stage 0 writes empty `qa` arrays,
stage 6 iterates those arrays, and its association loader expects a `per_qa` shape
rather than Plus stage 5's `samples` mapping. A paper-settings attempt needs an
explicit adapter and reader-context integration, or the authors' actual runner.
All four historical revisions that changed the Plus shell runner also used the
direct stage-5-to-stage-8 route. No alternative was recovered from those revisions.

## Reader and judge protocol

The released reader uses GPT-4o at temperature zero. Its
[literal template](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/T_mem/main/stage8_qa_locomo_plus.py#L35-L80)
continues the conversation using a `Recalled Experience` block made from selected
scene summaries. It receives no direct gold cue. It strips a leading `A:` or `B:`
from the question, whereas query embedding retains that prefix. Both forms were
preserved in every arm.

The judge uses Gemini-2.5-Flash at temperature zero, once per prediction. Its
[prompt](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/benchmark_eval/locomo_plus/judge/judge_prompts.py#L7-L25)
asks whether the response recalls the cue; the
[evidence loader](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/benchmark_eval/locomo_plus/judge/evidence_loader.py#L37-L64)
uses the original sample's `cue_dialogue` with speaker names remapped. There is no
Cognitive reference-answer field. The shared grader prepends an expert-grader
instruction. Accuracy is correct labels divided by all details; empty predictions
and unparseable judgments count as wrong. Multiple runs use strict-majority voting,
not independently regenerated answers. The paper's explicit three-run setting is
for LoCoMo, not the Plus main score.

The released judge is not verbatim identical to the pinned benchmark's
[official Cognitive prompt](https://github.com/xjtuleeyf/Locomo-Plus/blob/059f4e3d38f7f1f96765e8e2cb7de3097551bffb/evaluation_framework/task_eval/prompt.py#L118-L134),
which allows explicit or implicit use of evidence and omits the Question block.
The benchmark reader defaults to temperature 0.3, while T-Mem uses zero. We did
not silently substitute either benchmark setting for the released T-Mem protocol.

The shared T-Mem client transmits no max-token setting despite a stored config
value. Our transport mapping and explicit native output maxima are disclosed in
the [frozen protocol](protocol.md). Temperature zero is not a guarantee of
bitwise-deterministic provider output.

## Query access, not proven answer-label leakage

[Stage 0 appends the test query](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/T_mem/main/stage0_locomo_plus_stitch.py#L97-L125)
as a session before memory construction.
[Stage 1](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/T_mem/main/stage1_memory_extraction.py#L48-L198)
loads and processes every session without excluding that query.
[Stage 4](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/T_mem/main/stage4_associative_extract.py)
generates triggers from those scenes, and stage 5 embeds their raw dialogue.
The query can therefore affect boundaries, summaries, triggers and retrieval.

The cue itself belongs in the history: it is the intended recall target, not illicit
gold injection. No direct answer-label-to-generator path was found. But this
query-conditioned construction cannot establish performance of a memory store
frozen before a future query. Removing the query would be a separate prospective
experiment, not a hidden correction to this reproduction.

Other released behaviors were kept: lexicographic session sorting, zero-day fallback
for unrecognized time-gap phrases, UUID scene IDs, and scene-ID tie breaking. One
construction is shared across arms to avoid introducing fresh generation/tie noise.

## Correct ablation and pilot hazards

[Stage 5 scoring and fusion](https://github.com/Sherlockwz/T-Mem/blob/dd9e1527bc75908485809580c9520af5a9a42879/T_mem/main/stage5_retrieval_locomo.py#L172-L217)
has three rank lists: raw dialogue (`b`), Scene, and Horizon. The matched arms sum
`b + Scene + Horizon`, `b + Scene`, and `b` respectively, using one candidate
universe, top-K, RRF constant and tie rule. Disabled rank lists contribute nothing.
Setting similarities to zero would still give scene-ID-ordered positive RRF votes
and would test the wrong intervention. Enabled channels preserve that released
zero-score behavior when a scene has no usable trigger vectors.

The sparse-ID wrapper also addresses orchestration hazards without changing prompts
or retrieval scoring:

- Stage 5 processes a prefix, so selected original IDs cannot be compacted and
  reassigned to new `index % 10` histories.
- Stage 8 otherwise emits missing-row errors for every absent library in the full
  dataset; a limited build alone is not a limited scoring experiment.
- The judge's default evidence loader ignores the shell's dataset override, so
  the wrapper explicitly supplies the full pinned 401-row evidence list.
- QA/judge resume caches do not adequately bind changed inputs. The wrapper uses
  hashed inputs and separate arm outputs rather than sharing those weak caches.

The frozen pilot uses five cases per relation, ordered by SHA-256 of
`tmem-table4-pilot-v1:{original_index}` within each relation. Its exact twenty IDs
are in the protocol and [paired results](paired-results.csv). The first twenty
dataset rows are all causal and would not have been a balanced pilot.

## Limits of the available artifacts

No full frozen 401-sample memory/prediction/judgment package was found in the
inspected source tree, README, project documentation or releases at audit time.
The published demo contains six illustrative scenes/QA examples, not benchmark
outputs. This does not prove unpublished artifacts do not exist.

Some main-table baseline scores were borrowed from prior publications. The target
was the authors' within-system Table 4 ablation, not a claim that borrowed baseline
numbers came from new matched runs. Even a positive pilot would establish only a
result on these twenty selected samples under this released route. It would not
replicate the headline effect size, prove the shared cascade ran, or establish
pre-query memory efficacy.
