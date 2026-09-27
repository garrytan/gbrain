# Intact-evidence reading replication

**Status: both frozen comparisons completed.** The
[measured results and audit](READING_NOTES_RESULTS.md) report the positive
automated transfer score, verified examples, grading artifacts and cutoff
responses. This protocol tests notes without deleting retrieved conversation.
The [earlier excerpt experiment](ANSWER_PACKET_RESULTS.md) failed; its scores
remain unchanged.

The protocol below is frozen historical science, not the current CLI default.
See the [dated release follow-up](READING_NOTES_RESULTS.md#release-follow-up-2026-09-25)
for the separate nine-case 1024-token completion smoke and the LongMemEval-only
notes default; the original 512-token comparison and labels are unchanged.

The protocol and both cohorts were frozen on 2026-09-24 at
21:01:05.530 UTC, before the first follow-up paid call at 21:01:20.585 UTC.
The operator removed the original $20 ceiling before this run. Calls still
record requests, responses, reported models, usage, failures and usage-priced
costs. Removing the ceiling does not authorize automatic retries, tuning on
outcomes, production changes or merging.

## Two comparisons, frozen together

### GBrain transfer: 361 fresh evidence groups

Run this comparison first, before inspecting the full paper replication.
Both arms use the existing Sonnet 4.6 reader, identical retrieved sessions in
identical order, identical question/date text, identical untrusted-data
framing, the provider's default temperature and a 512-token output limit.
The baseline is the unmodified full-session reader request.

The only treatment replaces its final instruction:

> Answer concisely with only the information needed to answer the question.

with:

> First extract all the relevant information, then reason over the information
> to get the answer. Keep the notes brief and end with a concise final answer.

The complete generated response, including any notes, is judged. No separate
summarizer, second retrieval, JSON conversion or answer-extraction heuristic
is introduced in this transfer comparison. Input messages are byte-identical
between arms. The longest source session is 28,284 characters, below the
existing 60,000-character safety limit; no source is shortened by that limit.

Freshness excludes the prior experiment's development and holdout groups,
the repository's entire `dev40` split, and groups whose gold supporting
session IDs occurred in the prior experiment's retrieved sources. Related
question variants, matching question text, matching histories and shared
supporting-session IDs are grouped before selection. Select one question per
remaining group, with abstention variants reserved first. Selection uses only
identities and metadata, never historical accuracy labels.

| Category, including abstention variants | Questions |
|---|---:|
| Knowledge update | 52 |
| Multi-session | 96 |
| Single-session assistant | 40 |
| Single-session preference | 20 |
| Single-session user | 49 |
| Temporal reasoning | 104 |
| **Total** | **361** |

Seven questions are abstentions. All recorded supporting-session IDs occur
in the fixed retrieval for 345 questions; 16 have incomplete gold-ID coverage.
This coverage label is diagnostic, not proof that an abstention question is
answerable or that every necessary fact survived source construction.

### Published reading comparison: all 500 oracle questions

Replicate [LongMemEval section 5.5 and Figure 6](https://arxiv.org/abs/2410.10813v2)
using all 500 questions in its published supporting-sessions-only corpus.
Run all four cells, rather than attributing a combined change to notes alone:

| History format | Reading instruction |
|---|---|
| Natural language | Direct answer |
| JSON | Direct answer |
| Natural language | Extract relevant information, then reason and answer |
| JSON | Extract relevant information, then reason and answer |

The pinned upstream `prepare_prompt` function constructs the requests
directly. It preserves full supporting sessions, removes `has_answer` labels,
sorts sessions chronologically and keeps both speakers. The shell runner maps
its `con` reading method to `--cot true`; `--con true` is a different,
separate-summarization experiment and is **not** used here.

Reader and judge use `gpt-4o-2024-08-06` through Chat Completions, temperature
zero, with no model substitution. Reader output is capped at 800 tokens in
every cell: the pinned upstream default's string-truthiness behavior gives
800 for both `--cot false` and `--cot true`. This reproduces effective code,
not a claim that the historical service returned identical completions.
No selected prompt approaches the 126,200-token history limit; the largest
estimated request, including conservative chat overhead, is 23,948 tokens.

The official `get_anscheck_prompt` function constructs oracle grading prompts,
with a 10-token response limit and the official lowercase `yes`-substring
rule. GBrain transfer retains its existing data-boundary judge prompt and
16-token limit, using the same pinned judge snapshot. Malformed or failed
judgments stop the experiment rather than silently becoming wrong answers.

## Interpretation and controls

- **Primary GBrain contrast:** notes versus its intact full-session baseline.
  A validated transfer requires a positive paired 95% bootstrap interval and
  no net abstention loss. Report point estimates, every win/loss, category and
  gold-coverage strata even when this gate fails.
- **Primary replication contrast:** JSON plus notes versus natural-language
  direct answering, matching the paper's combined comparison. Also report
  every cell and notes-versus-direct within each format. These controls prevent
  confusing a format effect with a notes effect.
- **Variability controls:** repeat baseline generation on 12 predetermined
  cases per phase, two per answerable category. Rejudge both saved responses
  for every discordant primary pair. Preserve initial scores; report repeat
  grading and manual evidence audits separately.
- **No adaptive search:** alternate/rotate arm order deterministically, run
  serially, and do not choose a new treatment from intermediate results.
  The next phase depends on complete accounting and unchanged inputs, not on
  whether the preceding accuracy result is favorable.
- **Limits:** the transfer sample is fresh relative to earlier tuning, not a
  new benchmark. It overlaps the full oracle corpus; the two comparisons are
  not independent confirmation datasets. Only seven fresh abstention groups
  remain. Bootstrap intervals quantify question sampling, not reader/judge
  variability, and benchmark scores are not whole-product claims.

The two corpora have matching IDs, question text, reference answers and
question types, but **all 500 question dates differ**, sometimes by days.
The dates also differ for all 948 matched supporting-session occurrences,
while their role/content turns are identical after ignoring gold annotations.
Each phase retains its own corpus's dates. Do not splice oracle dates into
GBrain's S-based retrieval or compare raw scores across phases as if the
inputs and readers were identical.

## Reproduction and receipt pins

The upstream repository is pinned to
[`9e0b455f4ef0e2ab8f2e582289761153549043fc`](https://github.com/xiaowu0162/LongMemEval/tree/9e0b455f4ef0e2ab8f2e582289761153549043fc).
The local protocol uses GBrain commit `c8423e4`'s reader, source freezing,
sanitizer, invocation guard, canonical pricing and paired summaries. Small
private orchestration scripts execute the original prompt functions and
record the experiment; no production implementation is changed.

| Artifact | SHA-256 |
|---|---|
| Frozen run manifest | `510a3eab1e6f3889b9732755a2c53c724f38745a8fef0744e34216cee78ae398` |
| Prepared oracle requests and cohorts | `621745fe5e8ea21b80bfd1277c0fb4eaf9fcdd3a54d4f702486798b934a420c8` |
| Published oracle JSON | `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c` |
| Historical LongMemEval-S JSON | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |
| Historical retrieved-session receipt | `65ffeaa8299586e5a1dd6a9e10f269bab33462ab5470a95e329fbf189a703140` |
| Official generation source | `4f1eb3c69d7ad40f04065b9c0bc86f6582441018fc6ff751d162d66c95baf672` |
| Official evaluation source | `ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251` |

The prior ledger contains 348 settled calls, no error events and $8.0127305
in usage-priced spending. Follow-up costs are recorded separately and added
to that amount for project totals. Prices come from the canonical table;
cache tokens without a discounted entry are conservatively priced at the
full input rate, so these are accounting estimates rather than invoices.

Before the run, 27 local tests passed: eight new private accounting contracts
and 19 existing presentation/accounting tests. Frozen-data assertions checked
every transfer pair's input equality, source bounds, unique evidence group
and absence from excluded groups. The dated OpenAI snapshot was confirmed
available without a paid completion. These checks validate the experiment's
mechanics, **not** the effectiveness of notes.

Raw conversation data, request/response receipts and private run files are
not mirrored in this public document. Completed outcomes and audit findings
are recorded separately in [the results](READING_NOTES_RESULTS.md), preserving
this frozen protocol alongside both positive and negative observations.
