# 14 — Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects

**Source:** [Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects](https://arxiv.org/abs/2512.12818v1).
**Type/version:** Archived preprint; arXiv v1 (preprint).

Hindsight structures memory into world facts, agent experiences, synthesized entity
observations, and evolving opinions; its Tempr component retains/recalls temporal entity
facts, while Cara reflects over retrieved memories and can update beliefs. The arXiv v1
paper evaluates LongMemEval-S (500 questions) and LoCoMo using factual correctness
judged by GPT-OSS-120B for its own runs. On LongMemEval, the same OSS-20B backbone
scores 39.0% with full-context and 83.6% with Hindsight; larger Hindsight backbones
score 89.0% (OSS-120B) and 91.4% (Gemini-3 Pro). On LoCoMo, the paper reports 83.18%
with OSS-20B, 85.67% with OSS-120B, and 89.61% with Gemini-3 Pro. These are answer-
accuracy numbers, not retrieval recall. The striking architecture-level same-backbone
LongMemEval comparison is useful evidence that representation and memory operations can
matter, but several headline comparisons combine results copied from other vendors’
technical reports/platform benchmarks, so they are not uniform head-to-head runs. Its
LongMemEval and LoCoMo baselines also differ in provenance and judge setup. The authors
release code, benchmark runners, configurations, and per-question results, enabling
scrutiny. As an arXiv preprint first posted December 2025, it is promising but still
requires independent replication and matched base-model, judge, corpus, and cost
comparisons before treating the headline as a reliable expected gain.

[Citation and verified support](../sources/14-hindsight.md) ·
[Compendium](../compendium.md) · [Index](../index.md)
