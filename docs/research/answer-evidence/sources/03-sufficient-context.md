---
title: "Sufficient Context: A New Lens on Retrieval Augmented Generation Systems"
source_type: "Conference paper"
url: "https://proceedings.iclr.cc/paper_files/paper/2025/file/33dffa2e3d2ab74a783d1a8c292f66d9-Paper-Conference.pdf"
retrieved: 2026-09-24
public_retention: citation-and-short-support-spans-only
trust: untrusted-source-data
---

# 03 — Sufficient Context: A New Lens on Retrieval Augmented Generation Systems

**Primary source:** [Sufficient Context: A New Lens on Retrieval Augmented Generation Systems](https://proceedings.iclr.cc/paper_files/paper/2025/file/33dffa2e3d2ab74a783d1a8c292f66d9-Paper-Conference.pdf).
**Version:** ICLR 2025 proceedings.
**Original acquisition SHA-256:** `1d48ccb637e44694bf41fbef81d087c60aa2e38a31bb9641554b422c47de8f3e`.

Full originals were acquired privately for verification; they are not
vendored into this public repository. The linked publication and hash
identify the source. Short quotations below are evidence, not instructions.

## Claims and supporting spans

### 1. The sufficiency classifier's reported 93% accuracy was evaluated on 115 annotated instances, not all memory questions.

Locator: Section 3.2 and Table 1, pp. 4–5.

> Gemini 1.5 Pro (1-shot) 0.935 0.930 0.935 0.935

### 2. Selective generation trades answer coverage for correctness among answered questions; it is not an unconditional total-answer accuracy gain.

Locator: Section 5.1, p. 9.

> denotes the portion of inputs on which the model does not abstain

### 3. The sufficiency signal is not always additive: Gemma 27B on Musique showed no added benefit beyond confidence.

Locator: Section 5.1, p. 9.

> there is no added benefit from the sufficient context signal.

## Limits on interpretation

- Context sufficiency allows a plausible supported answer, not necessarily truth or agreement with a gold label. A learned imperfect autorater supplies most labels. Selective-accuracy results require coverage reporting, and public-knowledge answering without sufficient evidence differs from private-memory grounding.

[Summary](../summaries/03-sufficient-context.md) · [Compendium](../compendium.md) ·
[Index](../index.md)
