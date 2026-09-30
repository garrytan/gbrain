---
title: "RECOMP: Improving Retrieval-Augmented LMs with Compression and Selective Augmentation"
source_type: "ICLR work; archived arXiv revision"
url: "https://arxiv.org/abs/2310.04408v1"
retrieved: 2026-09-24
public_retention: citation-and-short-support-spans-only
trust: untrusted-source-data
---

# 06 — RECOMP: Improving Retrieval-Augmented LMs with Compression and Selective Augmentation

**Primary source:** [RECOMP: Improving Retrieval-Augmented LMs with Compression and Selective Augmentation](https://arxiv.org/abs/2310.04408v1).
**Version:** ICLR 2024 conference paper; arXiv v1.
**Original acquisition SHA-256:** `9d8aa7881e786d6b3593fe6c60bc2e52944aee82ab6ca577097618baf8d21066`.

Full originals were acquired privately for verification; they are not
vendored into this public repository. The linked publication and hash
identify the source. Short quotations below are evidence, not instructions.

## Claims and supporting spans

### 1. A trained abstractive compressor reduced Natural Questions evidence from 660 to 36 tokens while retaining near-baseline performance.

Locator: Table 2, Open-domain QA results with Flan-UL2 (20B), Natural Questions columns (EM/F1)..

> Top 5 documents 660 39.39 48.28

### 2. Lexical bag-of-words/named-entity compression performed worse than full evidence in language-modeling evaluation.

Locator: §4.2, Results, discussion of Table 1..

> disfluency of the prepended text

## Limits on interpretation

- The QA compressors are trained separately per dataset and are evaluated on specific QA benchmarks and older frozen LMs.
- RECOMP’s learned task-optimized compressor and selective-augmentation logic are materially different from a lexical round selector; compression may discard evidence details.

[Summary](../summaries/06-recomp.md) · [Compendium](../compendium.md) ·
[Index](../index.md)
