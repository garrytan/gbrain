---
title: "Lost in the Middle: How Language Models Use Long Contexts"
source_type: "TACL work; archived arXiv revision"
url: "https://arxiv.org/abs/2307.03172v2"
retrieved: 2026-09-24
public_retention: citation-and-short-support-spans-only
trust: untrusted-source-data
---

# 05 — Lost in the Middle: How Language Models Use Long Contexts

**Primary source:** [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172v2).
**Version:** arXiv v2 (2023-07-31); work later published in TACL 2024.
**Original acquisition SHA-256:** `34d741ddffad9a1256b0429f578a54aa4278dba486ba9cb88646c76b367fa069`.

Full originals were acquired privately for verification; they are not
vendored into this public repository. The linked publication and hash
identify the source. Short quotations below are evidence, not instructions.

## Claims and supporting spans

### 1. Relevant evidence in the middle of a 10–30-document context can perform worse than no retrieved context.

Locator: §2.3, Results and Discussion; Table 1 reports GPT-3.5-Turbo 56.1% closed-book and 88.3% oracle..

> performance can drop by more than 20%—at its nadir, performance in 20- and 30-document settings is lower than performance without any input documents (i.e., closed-book performance; 56.1%).

### 2. Increasing retrieved-document count can give only marginal gains.

Locator: §1, Introduction..

> using more than 20 retrieved documents only marginally improves performance (∼1.5% for GPT-3.5-Turbo and ∼1% for claude-1.3)

## Limits on interpretation

- Controlled NaturalQuestions/Wikipedia multi-document QA with older model versions; does not test personal conversation memory, source trust, or current models.
- Position and document count are manipulated in a fixed task; these findings do not validate any particular selector or compression method.

[Summary](../summaries/05-lost-in-the-middle.md) · [Compendium](../compendium.md) ·
[Index](../index.md)
