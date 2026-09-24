# 05 — Lost in the Middle: How Language Models Use Long Contexts

**Source:** [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172v2).
**Type/version:** Archived arXiv v2 (2023-07-31); work later published in TACL 2024.

The study isolates context position and size in multi-document QA: the question is
paired with 10, 20, or 30 retrieved Wikipedia passages, exactly one answer-bearing, and
the answer passage is moved while distractors remain. Across MPT-30B-Instruct,
LongChat-13B, GPT-3.5-Turbo, and Claude-1.3, answer quality follows a U-shaped position
curve: evidence is used more reliably at the start or end than in the middle.
GPT-3.5-Turbo falls by more than 20% in its worst 20-/30-document setting, below its
56.1% closed-book accuracy; its one-document oracle is 88.3% (Table 1; §2.3). This shows
that retrieved evidence can materially improve the answer when isolated, but simply
appending more evidence may overwhelm or bury it. The authors also report that
increasing retrieval from 20 to 50 documents gives only about 1.5% additional
performance for GPT-3.5-Turbo and 1% for Claude-1.3 (§1).

The benchmark uses English Wikipedia/NaturalQuestions, fixed-answer QA, and older
model/API versions; it does not test personalized conversational evidence, source trust,
or current models. The operational implication for GBrain is to test placement and
distractor load independently from retrieval recall, preserve provenance, and avoid
assuming that a larger retrieved set is better. This paper studies model behavior under
raw input arrangement; it does not validate GBrain’s lexical round selector or any
learned compression method.

[Citation and verified support](../sources/05-lost-in-the-middle.md) ·
[Compendium](../compendium.md) · [Index](../index.md)
