---
title: What actually helps an AI use its memory?
date: 2026-09-24
depth: base
status: research synthesis; separate frozen replication running
---

# What actually helps an AI use its memory?

**The field has found useful methods, but our excerpt experiment did not help.**
The best next investigation is to replicate evidence-notes-before-answering,
keeping the original evidence intact. That is a hypothesis worth testing, not a
GBrain improvement we have demonstrated.

Think of an AI answering an open-book question. It has three jobs: keep useful
records, find the right pages, and read those pages correctly. Giving it fewer
pages can remove distractions, but can also remove the number that makes the
answer right. Giving it more pages cannot help if it ignores the important
paragraph. A fourth job belongs to us: check whether the answer really improved,
rather than whether an automated grader liked it.

This is a focused primary-source compendium, not an exhaustive survey or a
leaderboard. The [source index](index.md) records versions, limitations and
verification. The compendium itself did not run a paid evaluation. A separate
[frozen reading replication](../../eval/READING_NOTES_REPLICATION.md) is now
running; no production default has changed.

## 1. What failed here, and what that does not mean

We kept the retrieved conversations fixed and selected supposedly useful
original turns before the answering model saw them. The narrower selector
scored **48/60**, versus **53/60** for full conversations: **zero improved
answers and five judged regressions**. The wider selector only tied in
development; almost all its prompts were unchanged. Total experiment cost was
**$8.01**, based on reported usage and pinned prices.

One failure explains the risk concretely. A conversation contained a sale of
20 plants at $7.50 each. The selector omitted that turn, so the answer lost $150
and became $345 instead of $495. The right conversation had been found, but the
right fact was removed before reading.

Do not attribute all five score losses to that mechanism: one occurred with
identical prompts, and manual inspection found questionable grading in other
cases. The [negative result](../../eval/ANSWER_PACKET_RESULTS.md) preserves
every case and the original scores. Its confidence interval covers question
sampling, not model or grader variability.

**This was not a test of learned compression, evidence-note prompting, new
retrieval, or a new memory architecture.** None of those has earned a GBrain win
from this experiment. The inspected holdout is no longer available for tuning
followed by an allegedly fresh confirmation.

## 2. What the field has discovered

### Reading is a separate problem from finding

LongMemEval tests questions about past conversations. Its reading experiment
supplied **only the known supporting conversations**, removing retrieval
mistakes. With GPT-4o, ordinary presentation and direct answering scored 86.2%;
structured JSON plus evidence notes scored 92.4%. But JSON with direct answering
scored only 82.2%. The often-quoted roughly ten-point gain is the best-to-worst
gap, not the improvement over every reasonable baseline.

The idea is **Chain-of-Note**: first extract relevant information from the
supplied records, then answer from those notes. It differs from discarding
source turns using keyword overlap. LongMemEval's result is unusually relevant
to our question, but its oracle evidence and older reader models do not establish
an improvement with our noisy retrieved sessions and Sonnet 4.6.
[1](sources/01-longmemeval.md)

The original Chain-of-Note study also found gains with retrieved documents.
Its trained Llama-2 system gained 1.97 percentage points in mean exact-match
answer accuracy on the full three-dataset evaluation; a larger 7.9-point result
concerned a constructed all-noise subset. Explicit note generation cost more
decoding time. The cheap hybrid result required training and is not a free
prompt change. Read the matched condition, not just the biggest number.
[2](sources/02-chain-of-note.md)

### Shorter context is an optimization target, not a correctness guarantee

LongMemEval found that replacing conversations with extracted summaries or
facts generally hurt answers, with an exception for multi-session reasoning.
Compact text may retain the topic while losing a count, date, correction or
qualification. It also found that adding facts to the **search index**, while
retaining the original record for reading, can help. A summary used as an extra
signpost is different from a summary replacing the source.
[1](sources/01-longmemeval.md)

Lost in the Middle moved the answer-bearing passage within otherwise comparable
contexts: older models often used it better at the beginning or end than in the
middle. RULER then showed why a simple hidden-fact test is insufficient: locating
one fact is easier than tracing relationships or aggregating information among
distractors. A model's advertised context window is not a guarantee it can use
every fact in it. Neither paper establishes the behavior of today's reader on
our conversations. [5](sources/05-lost-in-the-middle.md)
[9](sources/09-ruler.md)

RECOMP trains compressors against downstream performance. On Natural Questions,
one learned summary reduced evidence from 660 to 36 tokens, but exact-match
accuracy fell from 39.39% to 37.04%. That is a substantial efficiency tradeoff,
not an accuracy improvement. Its learned compression also differs from selecting
turns by lexical overlap. [6](sources/06-recomp.md)

LongLLMLingua is a positive counterexample: it conditions compression on the
question, reorders documents and retains useful tokens. It reports improved
answers with fewer input tokens in its Natural Questions setup, including an
answer passage deliberately placed tenth. But it must recompress for each
question, adding compute. The bundle does not prove that deleting text alone
caused the gain. [7](sources/07-longllmlingua.md)

LLMLingua-2 instead learns a reusable token-preservation model from compression
examples. On MeetingBank it reduced average input from 3,003 to 970 tokens while
question-answering exact match changed from 87.75% to 86.92%. Its LongBench average was also below
the original prompt in the reported 3,000-token-budget comparison. Learned
compression can be useful without improving answer quality, and performance
depends on the task. [8](sources/08-llmlingua-2.md)

### Relevant evidence may still be insufficient

A page can mention the right person and still omit the fact needed to answer.
The Sufficient Context paper distinguishes that from a model failing to use an
answer that is present. Its best sufficiency classifier scored 93% on 115
human-labeled examples, which is useful but not an oracle.

The paper improves correctness **among questions answered** by combining a
sufficiency signal with model confidence. That trades off how often the system
answers; it is not simply more correct answers across all questions. The added
sufficiency signal also had no benefit for one reported model/dataset pairing.
For private memory, a plausible guess from general knowledge is not a substitute
for a record supporting the answer. [3](sources/03-sufficient-context.md)

### Retrieval and long-term memory are separate experimental branches

If a required fact never reaches the reader, better formatting cannot recover
it. LongMemEval's fact-expanded search keys and time-aware retrieval change
**which records are found**, not merely their presentation. They deserve
separate comparisons against the current retriever. A wrong inferred time
window can exclude the event being sought. [1](sources/01-longmemeval.md)

IRCoT searches in stages: an intermediate finding supplies the next query.
That helps when a question requires a chain of facts. Its experiments improved
supporting-paragraph retrieval, but GPT-3 answer F1 (answer/reference word
overlap) did not improve on the IIRC benchmark.
Its custom budgeted recall measure is not ordinary recall at a fixed number of
results. Even more relevant evidence does not automatically produce a better
answer. [10](sources/10-ircot.md)

CRAG checks and repairs weak retrieval, including through external web search.
Its public-knowledge experiments do not make that an appropriate repair for
missing private conversational facts, or authorize sending private queries to
another service. [11](sources/11-crag.md)

Contextual Retrieval restores a chunk's document context before indexing.
The vendor's contextual embeddings plus keyword indexing reduced top-20
retrieval failure from 5.7% to 2.9%. That is not an answer-accuracy gain or an
independent replication. Its appendix dataset differs from the headline
aggregate.
[12](sources/12-contextual-retrieval.md)

### Newer memory systems supply hypotheses, not a universal winner

Mem0's graph variant scored 24.32 multi-hop F1 on LoCoMo versus 28.64 without
the graph, although other categories improved. The study excluded
unanswerable/adversarial questions. More structure does not guarantee better
reasoning or safer abstention. [13](sources/13-mem0.md)

Hindsight separates retaining, recalling and reflecting over several kinds of
memory. It reports 83.6% answer accuracy on 500-question LongMemEval-S with its
20B configuration. That is an entire-system result; several cross-system
baselines were imported from other reports with different judging provenance.
It supports investigating memory operations, not assuming its gain comes from
retrieval or comparing that score with our selected 60-question pilot.
[14](sources/14-hindsight.md)

SimpleMem's LoCoMo average answer F1 falls from 43.24 to 37.78 when intent-aware
retrieval is removed. Its ingestion compression and synthesis also matter in
that configuration. This differs from our intervention: transforming and
indexing memories before a query is not cutting already-retrieved turns.
[15](sources/15-simplemem.md)

These three are preprints in the archived revisions, not independently verified
GBrain results. Borrow a mechanism with a matched component test, not an entire
architecture on the strength of its headline score. Different datasets,
question subsets, answer models, judges and cost accounting prevent a fair
cross-paper leaderboard.

### The grader is another fallible model

ContextualJudgeBench tests whether a model can judge answers using supplied
evidence. Its leading reported model achieved 55.3% **consistent accuracy**:
it had to select the correct answer in both orders of a response pair. Random
selection scores 25% under that definition, not 50%. These figures are not an
estimate of our pointwise LongMemEval grader's error rate.

The lesson is narrower: small wins need inspection. Keep raw scores, inspect
disagreements blind to the arm, and report adjudication separately rather than
silently rewriting labels. Our identical-prompt score flips make a repeatability
control necessary before claiming a small prompt effect.
[4](sources/04-contextual-judge.md)

## 3. What to investigate next, in order

### First: replicate the closest published reading experiment

**Question:** Does extracting evidence before answering help without deleting
anything from the supplied records?

Start with LongMemEval section 5.5, Figure 6 and the reading prompts in Figure 13.
Reproduce its two-by-two comparison: natural-language versus JSON presentation,
each with direct answering versus evidence notes. Keep source text, order and
output budget fixed across cells. Test the paper's oracle condition separately
from a GBrain transfer test with frozen retrieved sessions. Pin dataset, prompts,
reader and judge; disclose an unavailable historical model snapshot instead of
calling a modern-model substitution an exact numerical replication.

For the GBrain transfer test, retain the untrusted-data boundary and abstention
policy. The current reader asks for a concise answer, without evidence notes;
see [`reader.ts`](../../../src/eval/longmemeval/reader.ts). Start with its existing
512-token output ceiling applied equally to compared arms. Record truncations
and note-generation cost. If a larger ceiling is needed, include a matched
direct-answer control; that is a separate budget comparison, not a hidden
advantage for the new method.

Use inspected examples only for development. Reserve a fresh decision cohort,
excluding questions used to design or select this method. Freeze prompts before
opening it. Add a preselected identical-prompt repeatability sample. Budget
reader calls, notes, judging and repeats together before asking for authorization.
No new spending is authorized by this document.

Report paired wins and losses, answerable and unanswerable results, question-type
breakdowns, input/output tokens, latency and total cost. Audit supporting facts
and final answers separately. Preserve official-style grades; any blinded manual
adjudication is a separately labeled analysis. A handful of wins is exploratory,
not a rollout: confirmation must show a positive paired effect with uncertainty
and no material abstention or evidence-preservation regression. Otherwise, keep
full-session direct answering and record another negative result.

### Second: improve retrieval only for demonstrated missing evidence

First classify residual failures: absent supporting facts, present-but-misread
facts, stale or contradictory facts, unsupported answers, or grading ambiguity.
Gold-session IDs alone are not a sufficient answerability label. If missing
facts dominate, prioritize one retrieval mechanism rather than more reader
formatting. Fact-expanded indexing and query decomposition are candidates;
test each independently, measuring answer quality as well as retrieval recall.
Better recall matters if it produces better supported answers at an acceptable
cost.

### Third: revisit compression only when there is a real budget need

If intact evidence exceeds a context, latency or cost budget, compare a published
compressor against full text and simple truncation on the same cases. Track
preservation of decisive values, dates, entities, corrections and negative
statements. Include the compressor's latency and cost. A smaller prompt with
worse answers is a tradeoff, not a win to rename. Keep source pointers and a
full-text fallback, but do not confuse recoverable provenance with proof that
omitted text was unnecessary.

## 4. The decision

Do not invest further in the failed lexical excerpt selector or replace
GBrain's memory architecture on this evidence. The strongest nearby research
lead is an intact-evidence reading replication. Change that priority if a
failure audit shows the needed facts were never retrieved: work on retrieval
first in that case. Either way, require a fresh matched improvement before
changing the default.

For the evidence behind each mechanism, use the [source index](index.md).
For what we measured in GBrain, use the
[negative experiment report](../../eval/ANSWER_PACKET_RESULTS.md).
