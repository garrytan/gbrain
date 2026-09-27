# 07 — LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression

**Source:** [LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression](https://arxiv.org/abs/2310.06839v2).
**Type/version:** ACL work; archived arXiv revision; ACL 2024 long paper; arXiv v2.

LongLLMLingua is question-aware, learned compression: a small language model scores
question-relevant content, followed by coarse-to-fine document- and token-level
compression, document reordering, and subsequence recovery for entity fidelity. On
NaturalQuestions multi-document QA, the paper reports a "21.4%" performance boost
for GPT-3.5-Turbo when the answer-bearing passage is tenth, with about four times
fewer input tokens (Abstract; §5). This preserves the paper's percentage notation;
it is not a predicted percentage-point gain for GBrain. LongChat-13B is also evaluated.
The setup deliberately places the ground-truth passage late among distractors. The
method’s key mechanism is not simple lexical overlap: the question conditions learned
relevance scoring, while reordering and compression increase the density and position of
answer-relevant information. Broader performance/latency results cover NaturalQuestions,
LongBench, ZeroScrolls, MuSiQue, and LooGLE; interpret them within those datasets,
prompts, models, and token budgets, not as universal rankings.

A central tradeoff is explicit in the authors’ limitations: because compression is
question-aware, the same context must be recompressed for each question, and compression
itself costs more compute than LLMLingua. The method uses LLaMA-2-7B-Chat as compressor
and older answer models; it is not evaluated on GBrain’s conversational evidence. GBrain
should treat it as motivation for a query-conditioned selection experiment, not
validation of the failed lexical round selector. Any such experiment should compare
answer quality, evidence retention, latency, and provenance against uncompressed
presentation.

[Citation and verified support](../sources/07-longllmlingua.md) ·
[Compendium](../compendium.md) · [Index](../index.md)
