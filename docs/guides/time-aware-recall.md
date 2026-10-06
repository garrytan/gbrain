# Time-aware recall

`gbrain think` answers in a date frame. It knows today's date in your brain's
timezone, it sees the content date of each page it reads, and it resolves
relative time words against the right one: "last month" in your question
against today, "yesterday" inside a meeting note against that note's date.

## Say to your agent

- *"What did I decide about pricing last month?"* — your agent runs
  `gbrain think "What did I decide about pricing last month?"`; the answer is
  grounded in today's date and each page's date.
- *"Answer as if today were March 1, 2024."* — `gbrain think "…" --reference-date 2024-03-01`.

## What the reader sees

- **Current date.** The user message carries `Current date: YYYY-MM-DD (<zone>)`
  just before the question. The zone is `brain.timezone`
  (`gbrain config set brain.timezone America/Los_Angeles`); unset means UTC.
  `--reference-date` / MCP `reference_date` replaces today with a past or
  current YYYY-MM-DD; a malformed or future date is refused with
  `invalid_params` before any model call.
- **Page dates.** Each `<page>` block carries `date="YYYY-MM-DD"` when the page
  has a content date: frontmatter `event_date`, `date` or `published`, or a
  dated filename. A page whose date fell back to when the file or row was
  created carries no date, because that time says nothing about the content.
  A day-only frontmatter date renders as written; a timestamp renders in the
  brain's timezone.
- **Search results** already carry each page's `effective_date` and
  `effective_date_source`, so an agent reading `search` or `query` output
  directly can apply the same rule.

## Measured effect

On held-out LoCoMo conversations, `think` answered 88.2% of questions
correctly with the date frame against 74.2% without it (+14.0 points, 95% CI
[+11.8, +16.2]); questions about time went from 27 to 199 of 221 correct.
p95 latency is unchanged. On the LongMemEval-S development sample, `think` answered 90.0% of questions
correctly with the date frame against 80.7% without it (+9.3 points, 95% CI
[+4.0, +15.3]); on the LoCoMo development conversations, 89.1% against 76.7%.
Retrieval is unchanged. Results:
[`docs/eval/TIME_AWARE_RETRIEVAL_RESULTS.md`](../eval/TIME_AWARE_RETRIEVAL_RESULTS.md).

## Measuring it

The LongMemEval harness carries eval-only arms for two retrieval mechanisms
that were measured and not shipped: fact keys merged into chunk embeddings
(`--fact-keys`) and a soft time scope driven by the question's explicit time
words (`--time-scope`). `--mode tokenmax` builds production per-chunk
synopses, and `scripts/locomo-to-longmemeval.ts` converts LoCoMo
conversations to the same format. See
[`docs/eval-bench.md`](../eval-bench.md) and the
[evaluation key files](../architecture/key-files/evaluation.md).
