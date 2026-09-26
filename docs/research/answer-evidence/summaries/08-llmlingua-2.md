# 08 — LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression

**Source:** [LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression](https://arxiv.org/abs/2403.12968v2).
**Type/version:** ACL Findings work; archived arXiv revision; Findings of ACL 2024; arXiv v2.

LLMLingua-2 distills GPT-4 compression decisions into a bidirectional encoder token
classifier trained on meeting-transcript examples. It predicts which tokens to retain:
learned, extractive, task-agnostic compression, not lexical scoring or paraphrase. On
MeetingBank, compressed inputs average 970 tokens versus 3,003 original tokens; QA EM is
86.92 versus 87.75 and summarization BERTScore is 88.27 versus 88.96 (Table 1). On
LongBench at a 3,000-token budget, LLMLingua-2 averages 42.4 while the original prompt
averages 44.0; the task-aware LongLLMLingua baseline averages 48.8 in the same table
(Table 2). Thus shortening can preserve much of the evaluated performance, but it does
not invariably beat the full prompt, and task-aware methods can outperform it when the
query matters. Authors report 1.6x–2.9x end-to-end speedups at 2x–5x compression
(Abstract; Table 5).

The compression model was trained on MeetingBank, so transfer to conversational memory
or other domains is not guaranteed; the paper evaluates specific benchmarks and target
LMs. Its comparison also relies on previously reported results for some baselines. For
GBrain, this is evidence for evaluating a trained salience model as a distinct option,
while keeping raw excerpts and source links available. It is not evidence that deleting
rounds by lexical match is equivalent: the compressor learns token-preservation patterns
from labeled/distilled data and uses bidirectional context.

[Citation and verified support](../sources/08-llmlingua-2.md) ·
[Compendium](../compendium.md) · [Index](../index.md)
