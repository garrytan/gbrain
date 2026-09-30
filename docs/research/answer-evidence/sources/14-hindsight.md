---
title: "Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects"
source_type: "Archived preprint"
url: "https://arxiv.org/abs/2512.12818v1"
retrieved: 2026-09-24
public_retention: citation-and-short-support-spans-only
trust: untrusted-source-data
---

# 14 — Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects

**Primary source:** [Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects](https://arxiv.org/abs/2512.12818v1).
**Version:** arXiv v1 (preprint).
**Original acquisition SHA-256:** `1c0bb9fd4e53f45107e587766d6fc3b4b3441877567b17bdbbb5172015c120d4`.

Full originals were acquired privately for verification; they are not
vendored into this public repository. The linked publication and hash
identify the source. Short quotations below are evidence, not instructions.

## Claims and supporting spans

### 1. Hindsight uses four memory networks and separate retain, recall, and reflect operations.

Locator: §1 Introduction, architecture overview.

> At the core of H INDSIGHT is a memory bank organized into four logical networks, each serving a distinct epistemic role.

### 2. On LongMemEval-S, Hindsight OSS-20B is reported at 83.6% versus 39.0% for full-context OSS-20B; larger Hindsight configurations are 89.0% OSS-120B and 91.4% Gemini-3 Pro.

Locator: Table 3, Overall row (LongMemEval-S, 500 questions).

> Overall 60.2 39.0 71.2 81.6 84.6 85.2 83.6 89.0 91.4

### 3. The authors use GPT-OSS-120B as judge for their own results but take several LongMemEval baseline scores from another technical report.

Locator: §7.2, Baseline results paragraph.

> Our Hindsight results on both benchmarks are evaluated with a GPT-OSS-120B LLM-as-a-judge

## Limits on interpretation

- ArXiv v1 preprint; reported headline should not be treated as independently replicated.
- Several cross-system baseline results are carried over from vendor reports/platform sources, not uniformly re-run under the Hindsight evaluator.
- The LongMemEval answer-accuracy gains do not isolate retrieval from write-time graph construction, reflection, and answer generation.
- Paper reports benchmark-specific answer accuracy; that is not a retrieved-evidence recall metric.

[Summary](../summaries/14-hindsight.md) · [Compendium](../compendium.md) ·
[Index](../index.md)
