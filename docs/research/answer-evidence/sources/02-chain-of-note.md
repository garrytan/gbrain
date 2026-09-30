---
title: "Chain-of-Note: Enhancing Robustness in Retrieval-Augmented Language Models"
source_type: "Conference paper"
url: "https://aclanthology.org/2024.emnlp-main.813/"
retrieved: 2026-09-24
public_retention: citation-and-short-support-spans-only
trust: untrusted-source-data
---

# 02 — Chain-of-Note: Enhancing Robustness in Retrieval-Augmented Language Models

**Primary source:** [Chain-of-Note: Enhancing Robustness in Retrieval-Augmented Language Models](https://aclanthology.org/2024.emnlp-main.813/).
**Version:** EMNLP 2024 proceedings, pp. 14672–14685.
**Original acquisition SHA-256:** `851af70dadc3fb225086cfb15b7c4eaa869ee87312a844ad0dbb4082f3f25904`.

Full originals were acquired privately for verification; they are not
vendored into this public repository. The linked publication and hash
identify the source. Short quotations below are evidence, not instructions.

## Claims and supporting spans

### 1. The Llama-2 full-test-set mean exact-match improvement is 1.97 percentage points, not the larger all-noise subset result.

Locator: Section 3.2 and Table 2, p. 14677.

> an average improvement of +1.97 in EM scores across all three datasets when using LLaMa-2 as backbone language model.

### 2. Explicit notes increase inference cost; the hybrid-training result is a separate trained system.

Locator: Section 6 and Table 5, p. 14679.

> One major limitation of the C HAIN - OF -N OTE (C O N) approach is its increased inference cost due to the sequential generation of notes.

### 3. The RealTimeQA rejection-rate table is 6.1 to 13.0, a 6.9 percentage-point change; the prose's +10.5 claim does not match that table.

Locator: Table 4 versus Section 3.4, p. 14678.

> Retrieve-Read (Shi et al., 2023c) 15.6 19.9 6.1

## Limits on interpretation

- Mixes fine-tuned Llama-2 7B and prompted GPT-4-1106; EM and the paper's substring-based GPT-4 accuracy are not interchangeable. Noise evaluation subsets require successful retrieval before noise construction. Table 4 and rejection-rate prose disagree; use explicit table cells with that warning.

[Summary](../summaries/02-chain-of-note.md) · [Compendium](../compendium.md) ·
[Index](../index.md)
