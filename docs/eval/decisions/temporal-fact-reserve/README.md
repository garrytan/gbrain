# Temporal fact reserve in query: preregistered gates

Built behind `search.temporal_fact_reserve`, which is off by default. Gate 2 passed, but the reserve never fires on
those sets as written; gate 1 waits on the harness lane. With the key off, and for every query without a temporal
cue, `query` returns exactly what it returned before.

## Gate 2 result

Gate 2 ran on the bounded build (row share 30%), hermetic and keyword-only, with the key on and off. No question's
recall@10 is lower with the key on, in any of the five sets, with or without `token_budget: 8000`. That makes gate 2
a pass.

The pass is close to vacuous. None of the five sets has a temporal cue in its questions, so the reserve fired 0
times in each. A diagnostic outside the gate appends ", and when?" to the questions of the two fact copies:

- NamedThingBench: the reserve fired on 11 of 12 questions with no recall loss (0.833 both ways).
- Relational fixture: the reserve fired on 38 of 38, but the appended words already drop page recall to 0 with the
  key off, so this copy shows nothing.

With the key off, `query` output on these sets matches garrytan/gbrain@eb696b3df, apart from wall-clock recency
scores. The facts arm's own gate-2 numbers are unchanged.

Gate 1 (BEAM dev, harness lane) has not run.

## Preregistration


## Why

On BEAM's temporal-reasoning and event-ordering questions, the harness lane's combined arm (pages through `query`
plus `recall`'s facts) scores 0.49, against 0.72 for the comparator. Date grounding (#6020) did not move it, because
dated facts rarely reach the prompt:

- `recall` returns the newest 100 facts, and only 3-6% of those carry a real date.
- The `query` facts arm only uses spare rows, and a `limit: 50` page query leaves none.

## The change

With the key on, a `query` whose text carries a temporal cue gives saved facts a bounded share of the token budget.

- **Temporal cue.** Deterministic, no model call. The query matches, case-insensitively, one of: the words `when`,
  `before`, `after`, `since`, `until`, `till`, `during`, `ago`, `earlier`, `later`, `earliest`, `latest`,
  `first`, `last`, `previous`, `next`, `date`, `dates`, `day`, `week`, `month`, `year`, `order`, `sequence`; the
  phrases `how long`, `how many days`, `how many weeks`, `how many months`, `how many years`, `what time`; an ISO date
  (`YYYY-MM-DD`); or a month name.
- **Budget.** The reserve applies only when the call has a token budget: the caller's `token_budget`, or the budget
  evidence delivery resolves for `return_unit`. Without one, `query` behaves as today (the facts arm's spare-capacity
  rows).
- **Share.** Facts take at most 15% of that budget, counted with the search token estimator, and at most 30% of the
  caller's row count (at least 1, at most 20 rows). Pages fill the rest. The row count never grows: a fact row takes
  a free row, else the lowest page row.
- **Candidates.** Active facts only, under the same read policy as the facts arm (source scope, world facts only for
  remote callers, audit rows excluded): the 50 nearest by the query embedding `query` already computed, plus the 50
  best keyword matches, plus the named entity's facts.
- **Ranking by the question.** Each candidate scores its cosine similarity to the query (0 without an embedding) plus
  the share of query terms its text contains, plus 0.1 when it carries a real date. A real date means `valid_from`
  differs from `created_at` by more than a day, which is true when the writer supplied the date. A candidate is kept
  when its cosine is at least 0.5 or its term share at least 0.34. The best-scoring facts fill the reserve.
- **Rendering.** Reserved facts are fact rows (`result_type: "fact"`), each with its date header (`[observed
  unknown; valid FROM ...]`), placed after the page rows in date order, oldest first.
- **No model call** is added on the read path.

## Gates

1. **Harness lane, BEAM dev, combined lane, 8k token budget** (gbrain-evals harness provider). The same build, the
   same cells and seeds, `search.temporal_fact_reserve` on vs off.
   - **Rule:** paired over the same questions, the key-on arm scores higher on temporal reasoning and higher on event
     ordering, and its pooled score over all BEAM dev categories is not lower.
2. **No recall loss on the evals that cover `query`** (`evals/entity-anchoring/regression.ts`): NamedThingBench, the
   relational retrieval-quality fixture, the LongMemEval nightly fixture, and the one-saved-fact-per-question copies
   of the first two. Each runs with the key on and off, once without a token budget and once with `token_budget:
   8000`.
   - Recall@10 is computed over page rows only.
   - **Rule:** no question's recall@10 is lower with the key on, in any set or budget setting. Each set reports how
     often the reserve fired.

**Decision.** The key becomes default-on only if both gates pass. Until then it stays off. The lane that runs gate 1
owns its spend. The spend cap for this lane's own runs is $10.

## Changelog

- 2026-10-06: gates preregistered before any code or gated run.
- 2026-10-06: before gate 1 ran, the row bound changed from "at most 20 rows" to "at most 30% of the row count (1-20)".
  The first build let reserved facts fill every row of a `limit: 10` call under the default `auto` budget. The gate 2
  runs made on that build are void and were rerun on the bounded build. The token share and both gates are
  unchanged.
- 2026-10-06: built; gate 2 passed on the bounded build (the reserve never fired on the sets as written).
