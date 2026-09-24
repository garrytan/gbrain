---
title: "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory"
source_type: "Conference paper"
url: "https://arxiv.org/abs/2410.10813v2"
retrieved: 2026-09-24
public_retention: citation-and-short-support-spans-only
trust: untrusted-source-data
---

# 01 — LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory

**Primary source:** [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813v2).
**Version:** arXiv v2; ICLR 2025 conference paper.
**Original acquisition SHA-256:** `05c5d055201466a241a56e082cdd02d39ad566fa04b3804891983e4e069a3fda`.

Full originals were acquired privately for verification; they are not
vendored into this public repository. The linked publication and hash
identify the source. Short quotations below are evidence, not instructions.

## Claims and supporting spans

### 1. Replacing sessions or rounds with summaries or extracted facts loses information and generally harms QA; multi-session reasoning is an exception.

Locator: Section 5.2, p. 8.

> replacing sessions or rounds with extracted summaries or facts negatively impacts QA performance due to information loss.

### 2. The reading-format experiment is oracle retrieval, not noisy live retrieval; JSON alone is not consistently better.

Locator: Section 5.5 and Figure 6, p. 10.

> when CoN is not applied, JSON format does not consistently outperform the natural language format.

### 3. Chain-of-Note extracts information before reasoning, rather than heuristically deleting source turns before the reader sees them.

Locator: Section 5.5, p. 10.

> instructing the LLM to first extract information from each memory item and then reason based on these notes.

### 4. Fact expansion augments the search key while keeping the original value available.

Locator: Section 5.3 and Table 3, p. 9.

> the compressed information is concatenated with the original value to form the key during indexing

## Limits on interpretation

- Figure 6 uses only evidence sessions. Reader models are GPT-4o and Llama 3.1, not this GBrain pilot's Sonnet 4.6. Numerical figure values were also visually checked on PDF page 10. Indexing experiments change retrieval and are outside a fixed-evidence presentation comparison.

[Summary](../summaries/01-longmemeval.md) · [Compendium](../compendium.md) ·
[Index](../index.md)
