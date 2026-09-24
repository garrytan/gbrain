# 04 — ContextualJudgeBench

**Source:** [ACL 2025 proceedings](https://aclanthology.org/2025.acl-long.470/).
**Type:** Peer-reviewed benchmark of evidence-conditioned answer judges.

ContextualJudgeBench contains 2,000 response pairs across eight splits covering
refusal, faithfulness, completeness and conciseness. The main metric is
consistent accuracy: a judge must pick the correct response in both orders of
the pair. Random selection scores 25% under this rule. The best reported model,
o1, reaches 55.3%; that number is not ordinary one-pass accuracy and does not
mean the GBrain grader mislabels 44.7% of answers.

The study is relevant because an answer can sound polished while missing a
necessary qualification or declining a question that the context can answer.
Judging those distinctions is itself a reasoning task. But the benchmark's
constructed pairs, ordered criteria and pairwise setup differ from our
reference-based LongMemEval grading.

For the next GBrain experiment, retain raw judgments and inspect changed
outcomes against the source. Blind manual checks to the treatment label, and
report any adjudication separately. An identical-prompt repeatability sample
helps distinguish reading/judging noise from a formatting effect. This paper
justifies that measurement precaution; it does not establish which pilot
verdicts should be overturned or supply a correction factor for them.

[Citation and verified support](../sources/04-contextual-judge.md) ·
[Compendium](../compendium.md) · [Index](../index.md)
