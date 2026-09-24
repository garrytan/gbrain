---
title: "RULER: What\u2019s the Real Context Size of Your Long-Context Language Models?"
source_type: "COLM work; archived arXiv revision"
url: "https://arxiv.org/abs/2404.06654v3"
retrieved: 2026-09-24
public_retention: citation-and-short-support-spans-only
trust: untrusted-source-data
---

# 09 — RULER: What’s the Real Context Size of Your Long-Context Language Models?

**Primary source:** [RULER: What’s the Real Context Size of Your Long-Context Language Models?](https://arxiv.org/abs/2404.06654v3).
**Version:** arXiv v3 (header date 2024-08-06); COLM 2024 conference version.
**Original acquisition SHA-256:** `8a4bc6ca28d84570eec7f42652400c2121f4c8bc361701634e596772e396fc22`.

Full originals were acquired privately for verification; they are not
vendored into this public repository. The linked publication and hash
identify the source. Short quotations below are evidence, not instructions.

## Claims and supporting spans

### 1. About half of the benchmarked models met the paper’s chosen satisfactory-performance threshold at 32K, despite claimed context windows of at least 32K.

Locator: Abstract; §4.3 defines satisfactory via exceeding the 4K Llama2-7B mean of 85.6%..

> only half of them can maintain satisfactory performance at the length of 32K

### 2. More complex distractor needles caused a large degradation for Yi-34B at 256K.

Locator: §5, Task Error Analysis, “Failure to ignore distractors”; Figure 2..

> Yi dropping by ∼40 points at 256K in the extreme version, where the context is full of irrelevant needles (#K=FULL).

## Limits on interpretation

- Synthetic generated benchmark, not conversational evidence or end-user answer quality; its effective-length threshold is a chosen proxy.
- Numbers are benchmark-specific and should not be compared as a universal model ranking or mixed with results from other benchmarks.

[Summary](../summaries/09-ruler.md) · [Compendium](../compendium.md) ·
[Index](../index.md)
