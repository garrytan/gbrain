---
title: Answer-evidence research source index
retrieved: 2026-09-24
depth: base
source_count: 15
summary_count: 15
verified_support_spans: 42
claim_span_gate_passed: true
cold_read_passed: true
cross_model_review: passed
---

# Answer-evidence research source index

Start with [What actually helps an AI use its memory?](compendium.md).
It explains the field, our negative result and the next hypotheses without
requiring the reader to open these papers first. The closest primary read is
**LongMemEval section 5.5, Figure 6 and Figure 13**.

## Scope and retention

This is a focused, primary-source-grounded **base compendium**, researched on
2026-09-24. It covers evidence presentation, context compression, retrieval
planning, selected memory systems and answer evaluation. It is not a systematic
review, a complete survey of work through that date, or a claim that every
archived revision is the newest available. A-Mem and other systems mentioned as
baselines in selected papers were not separately audited as primary sources.

Public source pages are explicitly **citation-only, with short supporting
spans where retained**, paired one-to-one with summaries. Four preprint/vendor
notes are deliberately brief; their public records retain supporting locators
and span hashes rather than extended source-derived text. Full papers, web acquisitions and
extracted text were obtained in the private research workspace for verification;
they are not mirrored in Git. This keeps third-party full texts, author contact
details and prompt-shaped source material out of the public repository. The
durable repository record is the citations, pinned versions, original-file
hashes, support spans and our synthesis—not a promise that workspace originals
will remain available indefinitely. A source's PDF hash identifies the acquired
bytes, not a guarantee that its host will serve identical bytes forever.

The papers' model prompts are untrusted research data, never operating
instructions. No private conversation dump is included. No GBrain database
ingestion, `gbrain lsd` run, paid replication, or advanced-depth certification
was performed. Repository links replace brain-page graph links for this
docs-only artifact.

## Reading order and one-to-one source manifest

| # | Source | What it contributes | Evidence status | Notes |
|---|---|---|---|---|
| 01 | [LongMemEval](sources/01-longmemeval.md) | The closest controlled reading comparison. | ICLR 2025; pinned v2. | [Summary](summaries/01-longmemeval.md) |
| 02 | [Chain-of-Note](sources/02-chain-of-note.md) | Notes before answers, with noise and latency tradeoffs. | EMNLP 2024 proceedings. | [Summary](summaries/02-chain-of-note.md) |
| 03 | [Sufficient Context](sources/03-sufficient-context.md) | Evidence sufficiency and the cost of withholding answers. | ICLR 2025 proceedings. | [Summary](summaries/03-sufficient-context.md) |
| 04 | [ContextualJudgeBench](sources/04-contextual-judge.md) | Why evidence-conditioned grading needs controls. | ACL 2025 proceedings. | [Summary](summaries/04-contextual-judge.md) |
| 05 | [Lost in the Middle](sources/05-lost-in-the-middle.md) | Where the answer appears affects whether a model uses it. | TACL work; archived arXiv v2. | [Summary](summaries/05-lost-in-the-middle.md) |
| 06 | [RECOMP](sources/06-recomp.md) | Trained compression can save tokens while losing accuracy. | ICLR work; archived arXiv v1. | [Summary](summaries/06-recomp.md) |
| 07 | [LongLLMLingua](sources/07-longllmlingua.md) | Query-aware compression plus reordering can help. | ACL work; archived arXiv v2. | [Summary](summaries/07-longllmlingua.md) |
| 08 | [LLMLingua-2](sources/08-llmlingua-2.md) | Learned token preservation has task-dependent tradeoffs. | ACL Findings work; archived arXiv v2. | [Summary](summaries/08-llmlingua-2.md) |
| 09 | [RULER](sources/09-ruler.md) | A context-window size is not a reasoning guarantee. | COLM work; archived arXiv v3. | [Summary](summaries/09-ruler.md) |
| 10 | [IRCoT](sources/10-ircot.md) | Later search queries can follow intermediate findings. | ACL work; archived arXiv v2. | [Summary](summaries/10-ircot.md) |
| 11 | [CRAG](sources/11-crag.md) | Selective retrieval repair adds assumptions and cost. | Archived arXiv v3 preprint. | [Summary](summaries/11-crag.md) |
| 12 | [Contextual Retrieval](sources/12-contextual-retrieval.md) | Add context to search keys instead of deleting reader evidence. | Vendor engineering report. | [Summary](summaries/12-contextual-retrieval.md) |
| 13 | [Mem0](sources/13-mem0.md) | Graph memory is not uniformly better; abstention omitted. | Archived arXiv v1 preprint. | [Summary](summaries/13-mem0.md) |
| 14 | [Hindsight](sources/14-hindsight.md) | Whole-system memory results need matched judging. | Archived arXiv v1 preprint. | [Summary](summaries/14-hindsight.md) |
| 15 | [SimpleMem](sources/15-simplemem.md) | Component removal suggests narrow follow-up hypotheses. | Archived arXiv v3 preprint. | [Summary](summaries/15-simplemem.md) |

The machine-readable [sources.json](sources.json) holds the same pairings, URLs,
versions, original-file hashes and claim support (quotations or private-span
hashes with locators). Published venues and
the actually archived arXiv revisions are distinguished: this collection does
not claim every archived PDF is the final proceedings version.

## How to read the numbers

- **Answer accuracy** counts answers judged correct; the judge and rubric matter.
- **Exact match (EM)** requires an answer to match an accepted reference after
  the study's normalization. It is not identical to a human correctness judgment.
- **Answer F1** measures answer/reference word overlap in these QA evaluations,
  not the fraction of questions answered correctly.
- **Retrieval recall** measures supporting material found. Recall at 20 results
  is not answer accuracy; IRCoT additionally uses a different budgeted metric.
- **Selective accuracy** counts correct answers among attempted answers. Always
  report **coverage**, the fraction of questions attempted, alongside it.
- **Percentage points** subtract two percentages; a relative percentage change
  divides by the baseline. Do not interchange them or compare unlike metrics.

## Verification and unresolved limits

All 15 original acquisition hashes were independently recomputed. All 42 ledger
support quotations matched their archived extracted text after whitespace
normalization. Numeric tables and experimental conditions used in the synthesis
were also inspected; LongMemEval Figure 6 was checked in the rendered PDF, not
inferred from a search snippet. PDF reading-order extraction was used where
two-column layouts interleaved unrelated text.

The claim-span check establishes that quoted support exists. It does not
independently reproduce a paper's experiment or make every headline causal.
An independent cold-read and factual-characterization review passed after the
public-retention edits; its seven quality dimensions scored 8–9 out of 10.
Known caveats remain on the source pages: Chain-of-Note's Table 4/prose numeric
disagreement, compression losses, retrieval gains without answer gains,
unanswerable-question exclusions, imported baselines, and unlike judge metrics.
The compendium's recommendation is our synthesis, not a claim made by all papers.

For GBrain's own measured outcome, the authoritative record remains
[Answer-evidence packets: did not help](../../eval/ANSWER_PACKET_RESULTS.md).
The broader [evaluation guide](../../eval-bench.md) links this collection.
