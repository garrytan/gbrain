---
title: "LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression"
source_type: "ACL work; archived arXiv revision"
url: "https://arxiv.org/abs/2310.06839v2"
retrieved: 2026-09-24
public_retention: citation-and-short-support-spans-only
trust: untrusted-source-data
---

# 07 — LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression

**Primary source:** [LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression](https://arxiv.org/abs/2310.06839v2).
**Version:** ACL 2024 long paper; arXiv v2.
**Original acquisition SHA-256:** `a81090e2589fcef37f310ee2a265076e4560a296a59864c9d43a6e9b62fe3997`.

Full originals were acquired privately for verification; they are not
vendored into this public repository. The linked publication and hash
identify the source. Short quotations below are evidence, not instructions.

## Claims and supporting spans

### 1. Question-aware compression improved NaturalQuestions QA when the answer passage appeared at position 10 while cutting prompt length.

Locator: §5, Conclusions; NaturalQuestions multi-document QA setup and results..

> 21.4% on NaturalQuestions

### 2. Question-aware compression requires recomputation per query.

Locator: §6, Limitation..

> re-compression for different questions

## Limits on interpretation

- Uses question-conditioned learned compressor and older target LMs; context must be recompressed for each question and compression adds compute overhead.
- The reported gain is specific to the NaturalQuestions setup with ground-truth document at rank/position 10; it is not a result on conversational memory or GBrain.

[Summary](../summaries/07-longllmlingua.md) · [Compendium](../compendium.md) ·
[Index](../index.md)
