# 02 — Chain-of-Note

**Source:** [EMNLP 2024 proceedings](https://aclanthology.org/2024.emnlp-main.813/).
**Type:** Peer-reviewed retrieval-augmented QA experiments.

The method generates reading notes about retrieved documents before producing
an answer. Table 2 reports a 1.97-percentage-point mean exact-match gain across
Natural Questions, TriviaQA and WebQuestions for the trained Llama-2 7B model.
The larger 7.9-point finding is for a constructed all-noise subset, not ordinary
full-test-set performance. Prompted GPT-4 experiments are separate from this
trained model. Table 5 reports decoding times of 0.6104 seconds for retrieve/read,
12.0192 for explicit notes and 0.6074 for a hybrid-trained variant on eight A100s;
these are not forecasts of GBrain latency.

Evidence-note prompting is therefore plausible but not free. The trained hybrid
cannot be reproduced merely by removing visible notes from a prompt. Noise
subsets condition on initially finding relevant documents, so their results
should not be generalized to all retrieval failures. There is also a numerical
inconsistency: Table 4's rejection rate rises from 6.1% to 13.0%, or 6.9 points,
while the prose says more than 10.5. Preserve that discrepancy instead of using
the larger claim. GBrain needs its own intact-evidence, cost-matched comparison.

[Citation and verified support](../sources/02-chain-of-note.md) ·
[Compendium](../compendium.md) · [Index](../index.md)
