# 01 — LongMemEval

**Source:** [ICLR 2025 paper, arXiv v2](https://arxiv.org/abs/2410.10813v2).
**Type:** Peer-reviewed conversational-memory benchmark and controlled experiments.

LongMemEval separates memory indexing, retrieval and reading. In Figure 6's
oracle condition, the reader receives only supporting sessions. GPT-4o scores
86.2% with natural-language/direct answering, 82.2% with JSON/direct answering,
91.0% with natural-language/evidence notes and 92.4% with JSON/evidence notes.
The ten-point headline is a best-versus-worst comparison, not an unconditional
JSON benefit. Section 5.2 separately finds that replacing original records with
facts or summaries generally hurts QA, except for multi-session reasoning.
Section 5.3 retains the original record while enriching its search key.

This supplies the closest replication target for GBrain: distinguish finding
evidence from using evidence, and test notes without deleting source material.
Its oracle setup does not establish performance on noisy retrieval. Its reader
models differ from our Sonnet 4.6 pilot, and retrieval improvements belong in a
different experiment. A summary used as an index aid is not the same as a
summary replacing the reader's source. Treat the four reading conditions as a
factorial comparison, not permission to combine every promising mechanism.

[Citation and verified support](../sources/01-longmemeval.md) ·
[Compendium](../compendium.md) · [Index](../index.md)
