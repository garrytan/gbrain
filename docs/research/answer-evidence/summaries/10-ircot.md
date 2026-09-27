# 10 — Interleaving Retrieval with Chain-of-Thought Reasoning for Knowledge-Intensive Multi-Step Questions

**Source:** [Interleaving Retrieval with Chain-of-Thought Reasoning for Knowledge-Intensive Multi-Step Questions](https://arxiv.org/abs/2212.10509v2).
**Type/version:** ACL work; archived arXiv revision; arXiv v2 (also published at ACL 2023, paper 557).

IRCoT alternates between generating one reasoning sentence from the question and
evidence already retrieved, then using that sentence as the next BM25 query. It targets
multi-hop open-domain QA, where question-only search may miss later-hop evidence until
an intermediate entity has been inferred. Its 2023 ACL paper evaluates HotpotQA,
2WikiMultiHopQA, MuSiQue, and IIRC with a Wikipedia-derived corpus, comparing one-step
BM25 with IRCoT using GPT-3 (code-davinci-002) and Flan-T5 sizes. Retrieval allows at
most 15 paragraphs; the retriever selects K from {2,4,6,8} per step, with up to eight
reasoning steps. In the paper’s fixed-budget optimal-recall setup, GPT-3 IRCoT improves
their gold-supporting-paragraph recall over one-step retrieval by 11.3, 22.6, 12.5, and
21.2 points, respectively. With a separate QA reader, F1 gains are smaller and vary:
GPT-3 does not improve IIRC despite the retrieval gain. A manual 40-question-per-dataset
CoT audit reports fewer factual errors, including 50% fewer than OneR on HotpotQA and
40% fewer on 2WikiMultiHopQA. Code, data, prompts, and reproduction scripts are public.
This is good evidence for query decomposition when the task truly needs successive hops;
it is not evidence that iterative retrieval helps fixed-evidence selection or ordinary
personal-memory recall.

[Citation and verified support](../sources/10-ircot.md) ·
[Compendium](../compendium.md) · [Index](../index.md)
