---
title: "LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression"
source_type: "ACL Findings work; archived arXiv revision"
url: "https://arxiv.org/abs/2403.12968v2"
retrieved: 2026-09-24
public_retention: citation-and-short-support-spans-only
trust: untrusted-source-data
---

# 08 — LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression

**Primary source:** [LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression](https://arxiv.org/abs/2403.12968v2).
**Version:** Findings of ACL 2024; arXiv v2.
**Original acquisition SHA-256:** `8c0fcd9baa621ef7951c45838eefe841356a8d6e1eb025cecd92373930f536d9`.

Full originals were acquired privately for verification; they are not
vendored into this public repository. The linked publication and hash
identify the source. Short quotations below are evidence, not instructions.

## Claims and supporting spans

### 1. On MeetingBank, learned token classification compressed prompts to about one third of original length with QA EM close to the original.

Locator: Table 1, In-domain evaluation on MeetingBank; QA EM and token count columns..

> LLMLingua-2 86.92 17.37 48.64 22.96 34.24 88.27 970 3.1x Original 87.75 22.34 47.28 26.66 35.15 88.96 3,003 1.0x

### 2. At 3,000-token constraint, LLMLingua-2’s LongBench average was below original-prompt average and the task-aware LongLLMLingua baseline.

Locator: Table 2, Out-of-domain evaluation, 3,000-token constraint, LongBench AVG column; LLMLingua-2 42.4 and Original Prompt 44.0 in same table..

> LongLLMLingua† 40.7 46.2 27.2 70.6 53.0 55.2 48.8

## Limits on interpretation

- Training compression examples were from MeetingBank meeting summaries; transfer to other domains and conversational memory is not assured.
- Performance varies by task; at LongBench 3,000-token constraint the learned task-agnostic method is below the full prompt and task-aware comparator.

[Summary](../summaries/08-llmlingua-2.md) · [Compendium](../compendium.md) ·
[Index](../index.md)
