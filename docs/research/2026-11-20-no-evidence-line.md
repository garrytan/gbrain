# A "no evidence found" line from memory: no build (2026-11-20)

- **We learned that even a perfect "no evidence found" line barely changes made-up answers.** Added exactly on BEAM-500K's unanswerable questions, it cut made-up answers from 22.7% to 20.7% across three readers, against a bar of 13 points set in advance.
- **We learned that frontier readers answer from what memory returns, whatever memory says about it.** To stop made-up answers, you should look at the reader's prompt or at not returning loose matches, not at a memory-side signal.
- One reader, particle-1, made up more answers with the line (21.2% to 25.8%).

## Question

Agents that use gbrain sometimes invent an answer when the history holds none, because gbrain still returns its closest matches. Should gbrain tell the reader "no evidence found" when nothing relevant turns up?

## What was tried

- A preregistered counted run in gbrain-evals on gbrain v0.60.743.0, the newest release at launch, from 2026-11-19 to 2026-11-20, with five dated amendments.
- An oracle stub, not a real signal: the test, which knows the answer key, added one line, "gbrain found no evidence for this question", to gbrain's recorded retrieval. Arm B got the retrieval as delivered; arm O got B's exact context plus the line on the 22 unanswerable questions; arm F got it plus the line on the 198 answerable ones, to price a false alarm.
- Readers: claude-opus-5-5, gpt-6.2-sol and particle-1, on BEAM-500K's 11 public dev conversations. BEAM's rubric judge graded answers, and a judge from another model family labelled each answer declined, hedged or committed.
- Bars set in advance: a material cut is at least 13 points. The build condition needs a relative cut of at least 8/18 with an interval excluding 0, and anything under 25% relative means no build.

## Results

| Measure (pooled over three readers) | Result |
|---|---|
| Made up on unanswerable questions, B → O | 22.7% → 20.7% |
| Cut (Δ_O), 95% interval | 2.0 points (−0.5 to 5.1) |
| Relative cut | 8.9% (−2.3% to 22.6%) |
| Correct answers lost when the line is shown wrongly on every answerable question (L) | 1.2 points (−0.8 to 3.2) |

Per reader, made up B → O: claude-opus-5-5 16.7% → 13.6%, gpt-6.2-sol 30.3% → 22.7%, particle-1 21.2% → 25.8%. The run could detect a cut of about 13 points, not smaller ones.

Source: the results page [2026-11-20-beam500k-no-evidence-line-results.md](https://github.com/garrytan/gbrain-evals/blob/main/docs/benchmarks/2026-11-20-beam500k-no-evidence-line-results.md), merged in gbrain-evals [#530](https://github.com/garrytan/gbrain-evals/pull/530) (merge commit `838102af`), with its preregistration and analysis files beside it.

## Decision and why

No build. The preregistered verdict is "not material", and the build condition gives "no build" (8.9% relative, under its 25% floor). The planned "no evidence" part of the [multi-page read](2026-11-19-multi-page-read.md) work was never built either.

## Cost

The results page doesn't state the paid cost; it is in the run's ledger in gbrain-evals.

## What would reopen it

- A different signal shape: another wording, or a tool field rather than a sentence, could move readers differently.
- A reader that, unlike today's frontier models, follows such a signal reliably.
- The sealed split (56 unanswerable questions) was not used; a design that can detect cuts smaller than 13 points would need it or a larger set.
