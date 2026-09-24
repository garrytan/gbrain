---
title: "Does Context Matter? ContextualJudgeBench for Evaluating LLM-based Judges in Contextual Settings"
source_type: "Conference paper"
url: "https://aclanthology.org/2025.acl-long.470/"
retrieved: 2026-09-24
public_retention: citation-and-short-support-spans-only
trust: untrusted-source-data
---

# 04 — Does Context Matter? ContextualJudgeBench for Evaluating LLM-based Judges in Contextual Settings

**Primary source:** [Does Context Matter? ContextualJudgeBench for Evaluating LLM-based Judges in Contextual Settings](https://aclanthology.org/2025.acl-long.470/).
**Version:** ACL 2025 proceedings.
**Original acquisition SHA-256:** `e7b53cec12e8ab02042ec623336cccb8a88db4ef6a4b84958f68c049bda81edd`.

Full originals were acquired privately for verification; they are not
vendored into this public repository. The linked publication and hash
identify the source. Short quotations below are evidence, not instructions.

## Claims and supporting spans

### 1. Consistent accuracy requires the judge to be correct in both response orders, with random performance at 25%; it is not ordinary one-pass accuracy.

Locator: Section 4.1, metric definition.

> A judge is considered correct if it selects the correct response for both runs.

### 2. The best reported model has 55.3% consistent accuracy on this contextual benchmark, not on the GBrain LongMemEval judge task.

Locator: Section 4.2 and Table 3.

> performing models are o1 (55.3), o3-mini (52.6)

## Limits on interpretation

- A constructed 2,000-pair benchmark across eight contextual criteria. Pairwise judging and a conjunctive two-order metric differ from GBrain's pointwise reference-answer grader; its scores cannot estimate the pilot's error rate.

[Summary](../summaries/04-contextual-judge.md) · [Compendium](../compendium.md) ·
[Index](../index.md)
