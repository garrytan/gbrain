# Facts arm in query: gates and verdict

The facts arm is on by default. It sits behind `search.query_facts_arm`, and `false` turns it off. Gate 1b and
the revised gate 2 passed at garrytan/gbrain@947536f4c, the build where fact rows take only spare capacity. Gate
1 failed at 16288b95c, and that failure is recorded below. With the key set to `false`, `query` returns exactly
what it returned before the arm existed.

## Result: gate 1b and revised gate 2

**Gate 1b passed.** In the B2 corrections suite each correction was dated when it was made. Forget-then-remember
went from 92% correct and 8% stale with the key off to 100% correct and 0% stale with it on, after 1 write and
after 5. The fact row was in the reader's context for all 200 answers after the correction.

Corrected-value accuracy and stale-answer rate per 100 items, reader `claude-sonnet-5-5`, build 947536f4c:

| Arm | Key | Before correction | After 1 write | After 5 writes |
|---|---|---|---|---|
| forget-then-remember | off | 100% / 0% | 92% / 8% | 92% / 8% |
| forget-then-remember | on | 100% / 0% | 100% / 0% | 100% / 0% |
| edit-sync | off and on | 100% / 0% | 100% / 0% | 100% / 0% |
| append | off and on | 100% / 0% | 100% / 0% | 100% / 0% |

Edit-sync and append lose nothing, but the check can't show more than that. Those arms save no facts, so the arm
never added a row there (0 of 600 answers each), and both sit at 100%.

**Revised gate 2 passed.** Fact rows now take only spare capacity, so they never push out a page. No question's
recall@10 is lower with the key on, in any of the five sets:

| Set | Questions | Arm added a row | Recall@10 lower |
|---|---|---|---|
| NamedThingBench | 12 | 0 | 0 |
| Relational retrieval-quality | 38 | 0 | 0 |
| LongMemEval nightly | 10 | 0 | 0 |
| NamedThingBench + one saved fact per question | 12 | 11 | 0 |
| Relational + one saved fact per question | 38 | 38 | 0 (was 2 at 16288b95c) |

The runs are hermetic and keyword-only. The harness reports this rule as `pass_with_facts_diagnostics`.

Spend was $18.05 against a $30 cap. A first attempt that ran out of disk is not in that total. Its records were
lost, but it ran for about two minutes, which by the observed rate cost under $0.50.

**Decision.** `search.query_facts_arm` is on by default. Each `query` now runs up to three extra lookups
on the facts table: terms, embedding and named entity. It makes no model call.

## Result: gate 1 (16288b95c)

**Gate 1 failed.** In the B2 corrections suite's forget-then-remember arm, the key moved the stale-answer rate
from 92% to 4-6%. Corrected-value accuracy went from 0% to 1% after one unrelated write and stayed at 0% after
five. The rule needed it higher at both checkpoints.

The reader named the correction in 158 of the 200 answers after it (0 of 200 with the key off), and still kept the old value. A
remembered fact is dated when it is saved. In this suite that date is the day of the run, after every
question's simulated date. So the reader judged the correction not yet in effect and answered with the old
value. The fixed judge scored those answers wrong rather than stale. A typical answer was "Saltgrass Tacos. The
correction to The Green Fork is only valid from 2026-10-05, which is after the 2025-05-11 question date."

Corrected-value accuracy and stale-answer rate per 100 items, reader `claude-sonnet-5-5`:

| Arm | Key | Before correction | After 1 write | After 5 writes |
|---|---|---|---|---|
| forget-then-remember | off | 100% / 0% | 0% / 92% | 0% / 92% |
| forget-then-remember | on | 100% / 0% | 1% / 4% | 0% / 6% |
| edit-sync | off and on | 100% / 0% | 100% / 0% | 100% / 0% |
| append | off and on | 100% / 0% | 100% / 0% | 100% / 0% |

Edit-sync and append lose nothing with the key on. Both are at 100% with the key off too, so these checks
can only rule out a loss; they cannot show a gain.

**A diagnostic, not a gate.** It was chosen after gate 1's cells ran, so it cannot change the decision. In
these runs `remember` received the correction's own timestamp as `valid_from`, which `remember` accepts on
this branch. That changes the written fact, not the query path. With the fact dated when it took effect, the
key-off arm already answered 92% correctly (8% stale), and the key-on arm answered 100% correctly (0% stale)
at both checkpoints. A future preregistered gate on correction-dated writes would test this directly.

**Gate 2 passed, though the formal gate is close to vacuous.** On NamedThingBench (12 questions), the
relational fixture (38) and the LongMemEval nightly fixture (10), no question's recall@10 is lower with the key
on. These corpora hold no saved facts, so the arm never fired. The runs are hermetic and keyword-only, so the arm
matched by terms and named entity, not by embedding. Two diagnostic copies seed one saved fact per question:

- NamedThingBench: fired 11 of 12 times and lost nothing (recall@10 0.917 both ways).
- Relational: fired 38 of 38 times and lost recall@10 on 2 questions (mean 1.000 off, 0.974 on). Fact rows
  take a page slot when the row count is already full.

With the key off, gate-2 output matches garrytan/gbrain@a87c3e2af exactly, apart from wall-clock recency scores
and random revision ids.

Metered spend was $26.05 against a $40 cap:

- Gate 1 runs: $25.56.
- Two 6-probe smokes: $0.14.
- A duplicate run stopped after 30 probes and not used: $0.35.

Records are in `decision.json` (what was tested and how) and `verdict.json` (what happened). The gbrain-evals
mirror carries the two bench flags the gate-1 runs used (`--gbrain-search-config`, `--remember-valid-from`) as a
patch.

**Decision at gate 1.** `search.query_facts_arm` stayed off by default.

## Gate 1b and revised gate 2: preregistered

Written on 2026-10-06, after gate 1's result and before any gate 1b cell or revised gate 2 run. Gate 1 found a
flaw in how the bench was built. B2 simulates past question dates, but `remember` stamped each correction with the
wall-clock save date, so every correction looked like it came after the question. A real agent doesn't see that,
because a real question comes after the correction. Gate 1b keeps everything else the same and dates each
correction when it was made. The diagnostic above used the same writes on the earlier build and was not a gate; gate 1b reruns them as a gate on the new build.

**The change under test.** Fact rows take only spare capacity:

- They fill free slots up to the caller's row count (an explicit `limit`, otherwise the mode's default) and never
  displace a page row.
- When the caller sets a token budget, the page rows are budgeted first, and a fact row is added only if it fits
  in what remains.
- When there are no free slots or no budget left, `query` returns the page rows unchanged.

Everything else is as in "The change" above: matching, read policy, `superseded_claim` stamps and no model call.
The measured build is the gbrain commit that contains this change. Both gates name it.

**Gate 1b, B2 corrections with correction-dated writes** (gbrain-evals `eval/workload-suites/bench.ts
corrections`, flags from gbrain-evals `d01d3bc`):

- Setup: every arm runs with `--remember-valid-from`, so `remember` receives each item's `correction_timestamp`
  as `valid_from`. Arms: forget-then-remember with `search.query_facts_arm` off and on
  (`--gbrain-search-config search.query_facts_arm=true`); edit-sync and append, off and on. Same suite
  (`corrections-v1`, seed 20261006, 100 items), same reader (`claude-sonnet-5-5`), same fixed judge and same
  retrieval budget as gate 1. Answer phase, then score phase.
- Metrics: corrected-value accuracy and stale-answer rate after 1 and after 5 unrelated writes.
- **Rule:** the key-on forget-then-remember arm wins if its corrected-value accuracy is higher than key off at
  both checkpoints and its stale-answer rate is not higher at either. Edit-sync and append must not lose more
  than 2 points of corrected-value accuracy at either checkpoint with the key on.

**Revised gate 2** (`bun evals/entity-anchoring/regression.ts --json --key search.query_facts_arm`, hermetic):

- The three corpora as written (NamedThingBench, relational retrieval-quality, LongMemEval nightly) and the two
  diagnostic copies that seed one saved fact per question (`namedthing+facts`, `relational+facts`).
- Recall@10 over page rows, the key on and off.
- **Rule:** no question's recall@10 is lower with the key on, in any of the five. Each reports how often the arm
  added a row, so a pass where the arm never fires is visible as such.

**Decision.** `search.query_facts_arm` becomes default-on only if gate 1b and revised gate 2 both pass.
Otherwise it stays off. Gate 1's failure stands as recorded. Spend cap: $30.

## Preregistration

The sections below were written and pushed in garrytan/gbrain@a87c3e2af, before any code or gated run, and are
unchanged.

## Why

A correction made through `remember` does not win in `query`. In the B2 corrections suite's forget-then-remember
arm (gbrain-evals `eval/workload-suites`, `bun run eval:corrections`), 0 of 100 answers were correct and about
90 repeated the stale value. Two things cause this:

- The remembered fact does not surface when the question is worded differently from the fact.
- The page text that still states the old value ranks first.

`query` reads pages and chunks only. Facts are reachable through `recall`, but `query` never ranks them.

## The change

With the key on, `query` adds a facts arm:

- **Candidates.** Active facts only: not expired, not superseded, and valid now. They are filtered by the
  caller's read policy, the same way `recall` filters them: source scope, private facts withheld from remote
  callers, and the takes holder allow-list.
- **Matching.** Facts are matched to the query by embedding similarity and keyword, then ordered newest
  `valid_from` first among matches.
- **Delivery.** Matched facts are added as fact rows inside the caller's token budget and row count. Facts never
  enlarge either.
- **Superseded page claims.** A page row is stamped `superseded_claim` when a newer active fact covers the same
  entity and slot. Slot here means the typed claim columns: `claim_metric`, plus `claim_period` when both rows
  carry it. Pages without typed claims are never stamped.
- **No model call** is added on the read path.

The touch points will be additive in the `query` op, as with entity anchoring. `hybridSearch` ranking is left
alone.

## Gates

1. **B2 corrections** (gbrain-evals `eval/workload-suites`, `bun run eval:corrections`).
   - Setup: the forget-then-remember arm, run at the measured build with `search.query_facts_arm` on and off.
     Same seed (`corrections-v1`, seed 20261006, 100 items), same reader and same retrieval budget as the B2
     preregistration.
   - Metrics: corrected-value accuracy and stale-answer rate after 1 and after 5 unrelated writes.
   - **Rule:** the key-on arm wins gate 1 if its corrected-value accuracy is higher at both checkpoints and its
     stale-answer rate is not higher at either.
   - In the same run, the edit-sync and append arms must not lose more than 2 points of corrected-value accuracy
     with the key on.
2. **No regression on the evals that cover `query`.** These are the corpora used for entity anchoring
   (`evals/entity-anchoring/regression.ts`): NamedThingBench, the relational retrieval-quality fixture and the
   LongMemEval nightly fixture, run through the `query` op with the key on and off.
   - Recall@10 is computed over page rows only.
   - **Rule:** no question's recall@10 is lower with the key on.
   - Each corpus reports how often the facts arm added a row.
3. **Harness lane (optional, recommended).** LongMemEval knowledge-update and PersonaMem dev slices, retrieving
   through the `query` op with the key on and off.

**Decision.** The key becomes default-on only if gates 1 and 2 pass, and gate 3 too if it runs. Until then it
stays off. The spend cap is set before the gate 1 run.

## Changelog

- 2026-10-05: gates preregistered before any code or gated run.
- 2026-10-06: built at 16288b95c and gated. Gate 1 failed, gate 2 passed, and the key stays off.
- 2026-10-06: gate 1b (correction-dated writes) and revised gate 2 (fact rows take spare capacity only) preregistered before any of their runs.
- 2026-10-06: gate 1b and revised gate 2 passed at 947536f4c; the key is on by default.
