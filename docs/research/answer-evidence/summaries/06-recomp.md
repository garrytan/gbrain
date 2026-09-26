# 06 — RECOMP: Improving Retrieval-Augmented LMs with Compression and Selective Augmentation

**Source:** [RECOMP: Improving Retrieval-Augmented LMs with Compression and Selective Augmentation](https://arxiv.org/abs/2310.04408v1).
**Type/version:** ICLR work; archived arXiv revision; ICLR 2024 conference paper; arXiv v1.

RECOMP asks whether retrieved documents should be supplied verbatim. It trains an
extractive sentence selector and an abstractive summarizer against downstream language-
model or QA performance, and can emit an empty string when retrieval adds no useful
information. In open-domain QA, Flan-UL2 (20B) is evaluated on Natural Questions,
TriviaQA, and HotpotQA with separate compressors per dataset. For Natural Questions,
five passages provide 660 evidence tokens and achieve 39.39 EM / 48.28 F1; RECOMP’s
trained abstractive compressor provides 36 tokens and achieves 37.04 EM / 45.47 F1
(Table 2). This is a large reduction in evidence with modest loss, not proof arbitrary
deletion is safe. Across the QA sets, five documents improve over no evidence, and
learned extractive/abstractive methods beat corresponding lexical baselines. In language
modeling, the authors specifically report that phrase/token heuristics (bag-of-words and
named entities) are worse than full documents, plausibly because the resulting text is
disfluent (Table 1; §4.2).

These are learned, end-task-trained compressors and selective-augmentation policies—not
a lexical round selector. QA compressors are dataset-specific; experiments use older
LMs, and summaries can omit or alter details. For GBrain, evidence favors measuring
concise, coherent selections and allowing “no useful evidence” as an outcome, while
preserving the full source trail for audit. It does not establish that a simple lexical
strategy will improve conversational answers.

[Citation and verified support](../sources/06-recomp.md) ·
[Compendium](../compendium.md) · [Index](../index.md)
