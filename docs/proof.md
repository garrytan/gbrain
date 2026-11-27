# How gbrain compares: six measured results

We learned that gbrain's read tools turn questions about a person's own notes from mostly "I don't know" into mostly
right answers, and that gbrain beats the plain Postgres search a developer would build first, both on right answers and
on resisting planted false claims. You should give your agent gbrain's `query`, `search` and `get_page` tools when its answers
depend on notes and old conversations.

We also learned that a simpler setup is sometimes as good or better: pasting a whole chat history into the prompt
showed no measurable difference from gbrain on LongMemEval and beat it on LoCoMo, and an agent that greps the raw files
beat gbrain on very long chat histories.
You should test those baselines on your own workload before choosing.

Every number below comes from [gbrain-evals](https://github.com/garrytan/gbrain-evals), gbrain's public eval
repository, pinned at commit [`898e0ebf`](https://github.com/garrytan/gbrain-evals/tree/898e0ebfa02f81dd16fb39e486813d252a064199)
(2026-11-24). Each row names the gbrain build it measured, the date, how many questions or runs it covers, its 95%
interval where one was published, and who graded the answers. Rows come from different builds and dates; none is
re-measured here. The intervals show how much uncertainty there is in the measured differences.

| # | What we measured | Without gbrain | With gbrain | Result |
|---|---|---|---|---|
| 1 | Questions about one person's own notes, Opus 5.5 | 13.3% with no retrieval | **86.7%** with gbrain's tools | gbrain ahead by 73.5 points (63.9 to 82.5) |
| 2 | LongMemEval answers, Sonnet 5.5 reader (500 questions) | whole history pasted in: 471; plain Postgres hybrid search: 445 | **468** | level with the whole history at about a seventh of its reader cost; ahead of plain hybrid by 4.6 points (1.6 to 7.6) |
| 3 | Permission runs leaking finance-only text (100 runs, 5 models) | plain Postgres: 97 into the agent's context, 4 into answers; plain files: 100 into context, 0 into answers | **0** into context, **0** into answers | no leaks |
| 4 | A planted false claim adopted in a later session (3 models) | plain Postgres memory: 59 of 578 (10.2%) | **17 of 600 (2.8%)** with trust labels | gbrain lower by 7.3 points (4.3 to 10.4) |
| 5 | Very long chat histories (BEAM-10M), Opus 5.5 | an agent with `grep` over the same files: 67.4% | 55.2% | **gbrain behind by 12.2 points (6.4 to 18.4)** |
| 6 | Long conversations (LoCoMo), mean of three readers | the whole conversation pasted in: 84.2% | 80.0% | **gbrain behind by 4.2 points (1.0 to 7.0)** |

## 1. Questions about one person's own notes

An agent answered 99 questions about one person's real brain, each asked in other words than the notes use, once with
no retrieval and once with gbrain's `query`, `search` and `get_page` tools.

- **Result:** Opus 5.5 answered 13.3% right with no retrieval and 86.7% with gbrain's tools, on the 98 tasks both setups
  completed. The gain is 73.5 points, 95% interval 63.9 to 82.5.
- **Graded by:** `gpt-6-astra`, a model from another family, checked before the run against two labellers.
- **Build and date:** gbrain v0.60.613.0 (`98dda48fb9fd`), measured 2026-11-09.
- **Limits:** one run on one brain; the tasks were written by one agent, and their gold answers by the agent that keeps
  that brain. Without retrieval most answers were "I don't know", so the 13.3% is a floor, not a rival system.
- **Source:** [live recall, phase 2](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-11-09-live-recall-phase2.md)
  ([scorecard](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-11-09-live-recall-phase2/scorecard.json)).

## 2. LongMemEval: answers about old chats

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) is a public benchmark of 500 questions about long chat
histories (each about 50 conversations and about 171,000 tokens). Every arm used the same Sonnet 5.5 reader and prompt.

- **Result:** with gbrain's retrieval the reader answered 468 of 500 (93.6%). With each whole history pasted into the
  prompt it answered 471, no measurable difference (gbrain minus whole history −0.6 points, 95% interval −2.8 to +1.6,
  p = 0.72), at about 7.4 times the reader cost per question ($0.172 against $0.023). With the top five conversations
  from plain Postgres hybrid search (full-text plus pgvector, fused by rank) it answered 445: gbrain ahead by 4.6
  points (1.6 to 7.6, p = 0.004).
- **Graded by:** LongMemEval's official judge prompt on `gpt-4o-2024-08-06`, the benchmark's own judge.
- **Build and date:** gbrain `c5fb0201` (v0.60.95.0), measured 2026-10-06; the whole-history and plain hybrid arms ran on
  2026-11-17 and are paired with those 500 answers.
- **Limits:** gbrain was developed on LongMemEval-S, so this is not held-out evidence. The cost figure assumes each
  history answers one question with no prompt-cache reuse; a history asked many questions costs less to paste. Two of
  the whole-history answers were provider refusals and count as wrong.
- **Source:** [README baselines, LongMemEval](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-11-17-readme-baselines/longmemeval/results.md)
  ([summary](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-11-17-readme-baselines/longmemeval/summary-readers.json)),
  [gbrain's run](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md).

## 3. Keeping finance-only text away from the wrong person

In a fictional company of about 4,000 documents, the agent works for an account manager outside finance who may not
see finance-only documents. 10 such tasks, 2 runs each, on 5 models (Sonnet 5.5, Opus 5.5, Fable 5.1, GPT-6 Astra and
GPT-6.1 Sol): 100 runs per setup.

- **Result:** with gbrain, finance-only text reached neither the agent's context nor its answer in any of the 100
  runs. A plain Postgres memory put it in the agent's context in 97 runs and in the answer in 4. Plain files with
  `grep` put it in the context in all 100 and in no answer.
- **Graded by:** an exact string check for the finance-only text; no model judge. No interval was published for this
  count.
- **Build and date:** gbrain `51f865d78`, measured 2026-10-02 to 2026-10-05.
- **Limits:** an easier synthetic world, where gbrain and plain files both finished about 96% of tasks; this row shows
  the permission difference, not a success difference.
- **Source:** [model ladder](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-10-02-model-ladder.md),
  [run tables](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-10-02-model-ladder/entity-recall/holdout/headline-wave.md).

## 4. A planted false claim

An attacker's false claim arrives in an email, web page, issue, tool output or meeting transcript, and a later session
is asked a question it bears on. 100 attack scenarios, 2 runs each, on Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol.

- **Result:** with gbrain's trust labels shown, a later session adopted the attacker's claim in 17 of 600 sessions
  (2.8%, 95% interval 1.7% to 4.5%). With a plain Postgres memory and no labels, 59 of 578 (10.2%, 7.9% to 13.0%).
  Paired by scenario, plain Postgres alone was fooled 45 times and gbrain alone 3 times (p = 1.3e-10); the
  difference is 7.3 points (4.3 to 10.4).
- **Graded by:** Claude Sonnet 5.5 as the claim judge, the same judge as gbrain's own run. A Claude judge grades Claude
  answers here and was not agreement-checked for this comparison.
- **Build and date:** gbrain `c2f10ee8` (v0.60.110.0), measured 2026-10-08; the plain Postgres arm ran on 2026-11-17.
- **Limits:** the two arms ran on different days. The judge returned no verdict on 22 plain Postgres rows, which are
  left out; counting them all as adopted or all as not adopted still leaves gbrain lower on every model.
- **Source:** [README baselines, memory trust](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-11-17-readme-baselines/memory-trust/results.md)
  ([analysis](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-11-17-readme-baselines/memory-trust/analysis.json)),
  [gbrain's run](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-10-08-memory-trust-results-paid.md).

## 5. Where a simpler setup wins: very long chat histories

BEAM-10M asks questions about chat histories of about 10 to 11 million tokens each; gbrain was never tuned on it.
Opus 5.5 read both setups' evidence: gbrain's whole system, and an agent with list, `grep` and read tools over the same
Markdown files.

- **Result:** the file agent scored 67.4% and gbrain 55.2%: **gbrain is 12.2 points behind** (95% interval 6.4 to
  18.4), on all 199 questions over 10 conversations.
- **Graded by:** `gpt-6.1-sol`. Under BEAM's own `gpt-4.1-mini` judge the gap is 13.9 points (9.2 to 18.5).
- **Build and date:** gbrain v0.60.748.0 (`7f162344`), measured 2026-11-20. The file agent's answers are from October 2026; it
  reads only the raw files, so no gbrain change can move its score.
- **Limits:** 10 conversations describe these two systems on this set but cannot rank them against others. gbrain's
  import was marked degraded on 3 of the 10 conversations; without them the file agent still leads by 8.3 points
  (3.4 to 13.0).
- **Source:** [BEAM-10M on v0.60.748.0](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-11-19-beam10m-newest/results/README.md)
  ([report](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-11-19-beam10m-newest/results/report.json)).

## 6. Where a simpler setup wins: pasting the whole conversation

LoCoMo asks 200 questions over 10 long conversations that fit a reader's window. Opus 5.5, GPT-6.1 Sol and Sonnet 5.5
each answered, and the scores are their mean.

- **Result:** with each whole conversation pasted into the prompt the readers scored 84.2%; with gbrain's whole system
  80.0%: **gbrain is 4.2 points behind** (95% interval 1.0 to 7.0).
- **Graded by:** `gpt-4o-2024-08-06`, the judge that comparison used for LoCoMo throughout. New runs no longer use gpt-4o, so
  this number stands as measured but isn't directly comparable with one graded by a current judge.
- **Build and date:** gbrain v0.60.138.0 (`f05943e6`), measured 2026-10-09 to 2026-10-27.
- **Limits:** LoCoMo was used to choose gbrain settings, and 10 conversations can't rank systems.
- **Source:** [head-to-head scoreboard](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#descriptive-comparisons).

## Not comparable: other memory systems' LongMemEval numbers

Memory products publish LongMemEval answer accuracy too. These figures are not comparable with gbrain's 468 of 500
above, or with each other: each uses a different reader model, judge, retrieval budget or metric, each was run by the
team that built the system, and some don't say which model answered. gbrain was developed on this set too.

| System | Published figure | How it was measured |
|---|---|---|
| Mem0 | 94.4% (472 of 500) | its own run; gpt-4o answers from up to 200 retrieved memories, gpt-4o judge |
| Supermemory | 95% | its own research page; answer accuracy with top-15 retrieval, gpt-4o judge (recorded 2026-09-02; that page now redirects) |
| Hindsight | 94.6% | its vendor page, answer model not disclosed; its own repository reports 91.4% with Gemini 3 and 89.0% with GPT-OSS-120B |
| Zep | 90.2% (451 of 500) | its research page; gpt-5.4 reader and gpt-5.4 judge |

The sources, access dates and caveats for each are in gbrain-evals'
[comparison notes](https://github.com/garrytan/gbrain-evals/blob/898e0ebfa02f81dd16fb39e486813d252a064199/docs/comparison-systems.md#longmemeval-the-evidence-we-have).

## Keeping this page current

This page is refreshed monthly with gbrain-evals' own refresh, as a pull request that moves the pinned commit and
every number with it. Nothing reads gbrain-evals live. A number here that doesn't match the raw files at the pinned
commit is a bug: report it and it is fixed or removed before anything else merges.

What each part of gbrain does, and what a simpler setup covers instead:
[what you'd build without gbrain](guides/what-youd-build.md).

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator.
Garry Tan runs Y Combinator.
