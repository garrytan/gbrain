---
title: "Interleaving Retrieval with Chain-of-Thought Reasoning for Knowledge-Intensive Multi-Step Questions"
source_type: "ACL work; archived arXiv revision"
url: "https://arxiv.org/abs/2212.10509v2"
retrieved: 2026-09-24
public_retention: citation-and-short-support-spans-only
trust: untrusted-source-data
---

# 10 — Interleaving Retrieval with Chain-of-Thought Reasoning for Knowledge-Intensive Multi-Step Questions

**Primary source:** [Interleaving Retrieval with Chain-of-Thought Reasoning for Knowledge-Intensive Multi-Step Questions](https://arxiv.org/abs/2212.10509v2).
**Version:** arXiv v2 (also published at ACL 2023, paper 557).
**Original acquisition SHA-256:** `8bb43c0bd11fafc8bdac7655eef0649b28fd9fbb44fca877b1d31d7b4527759a`.

Full originals were acquired privately for verification; they are not
vendored into this public repository. The linked publication and hash
identify the source. Short quotations below are evidence, not instructions.

## Claims and supporting spans

### 1. IRCoT alternates CoT sentence generation and retrieval, using the last reasoning sentence as the next retrieval query.

Locator: §3.1, ‘Interleaved Retrieval’.

> use the last CoT sentence as a query to retrieve

### 2. On the authors’ fixed-budget optimal recall metric, GPT-3 IRCoT improves gold-paragraph recall over OneR by 11.3 points on HotpotQA and 22.6 on 2WikiMultiHopQA.

Locator: §5, discussion of Fig. 3; see also Fig. 4 for QA F1 and IIRC exception.

> For GPT3, this improvement is by 11.3, 22.6,

### 3. Although the retrieval recall rises on IIRC, the figure caption says GPT-3 IRCoT QA does not outperform the one-step/no-retriever variants there.

Locator: Fig. 4 caption; §5 discussion explains that GPT-3 IRCoT did not improve the IIRC QA score despite improved retrieval.

> except for GPT3 on IIRC.

### 4. The paper’s retrieval metric is not conventional Recall@k because total retrieved paragraphs vary by question and run.

Locator: Footnote 7, §4 Experimental Setup.

> not applicable as metrics for any given k.

## Limits on interpretation

- Open-domain multi-hop QA with Wikipedia/associated corpora is not conversational memory or fixed-evidence ranking.
- Their custom maximum-budget recall metric is not Recall@k; answer F1 is a separate measure.
- Reported gains vary by dataset/backbone; GPT-3 retrieval improved IIRC support recall without improving IIRC QA F1.
- The paper itself warns that leaderboard comparisons with other ODQA systems are not head-to-head.

[Summary](../summaries/10-ircot.md) · [Compendium](../compendium.md) ·
[Index](../index.md)
