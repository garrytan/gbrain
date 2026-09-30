# 03 — Sufficient Context

**Source:** [ICLR 2025 proceedings](https://proceedings.iclr.cc/paper_files/paper/2025/file/33dffa2e3d2ab74a783d1a8c292f66d9-Paper-Conference.pdf).
**Type:** Peer-reviewed RAG diagnosis and selective-generation experiments.

The paper asks whether supplied context supports a plausible answer before
asking whether the model produced the correct one. Its one-example Gemini 1.5
Pro classifier achieves 93% accuracy on 115 human-labeled instances. This is an
imperfect diagnostic, not proof that any matching document contains the answer.
The definition can count context as sufficient even when it supports an answer
that disagrees with a benchmark reference.

Section 5.1 combines sufficiency and model confidence to decide when to answer.
The reported benefit concerns selective accuracy: correct answers divided by
answers attempted, at a stated coverage. It must not be restated as an equal
gain across all questions. The sufficiency signal adds no benefit for Gemma 27B
on Musique in the reported comparison. Fine-tuning for abstention can also
reduce correct answers.

For GBrain, this motivates separate labels for missing evidence, reading
failure and unsupported guessing. It does not authorize silently withholding
more answers to make accuracy look better. Private conversational facts also
need evidence; successful guesses from general world knowledge are a different
kind of result. Report coverage and answerable/unanswerable outcomes together.

[Citation and verified support](../sources/03-sufficient-context.md) ·
[Compendium](../compendium.md) · [Index](../index.md)
