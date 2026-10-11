# Pinned questions benefit gate (B5)

Measures whether pinned questions pay for themselves: total lifecycle dollars
per correct, fresh answer for three arms over one seeded workload, at frozen
reads-per-write ratios (1 and 10).

| Arm | Lifecycle cost counted |
|---|---|
| `pinned` | the initial pin, every refresh attempt (the `standing_questions` phase after each write batch), and the reader call over the delivered fresh sentences |
| `query_reader` | `query` retrieval at the pinned answer's delivered-token budget, then one reader call per read |
| `think` | one on-demand `think` per read |

The report gives reads, correct answers, `stale_wrong` (an answer that states a
superseded value), dollars and dollars per correct answer per arm, the pinned
cost split (pin + refresh vs reads), and the break-even read count: the reads
after which pinned is cheaper than `query_reader`.

The workload (`generateWorkload(seed)`) gives each entity a factory city and
corrects some of them in later write batches; the gold answer is the current
city. It is byte-identical for a seed (`workload_hash`).

## Modes

```bash
bun evals/pinned-questions/benefit-gate.ts --plan --json      # size and cost estimate, spends nothing
bun evals/pinned-questions/benefit-gate.ts --offline --json   # stub models: a plumbing check, not evidence
bun evals/pinned-questions/benefit-gate.ts --run --yes --max-usd <cap> \
  --answer-model <provider:model> --reader-model <provider:model>   # paid
```

`--run` refuses (exit 3) without `--yes` and a `--max-usd` at or above the
plan's estimate. `--entities N` and `--batches N` size the workload; `--seed`
fixes it. Paid runs follow the model-selection rules for gbrain evals (newest
frontier models of each family) and are scheduled by the wave's owner;
`test/pinned-questions-benefit-gate.test.ts` covers the offline plumbing.

Pinned questions ship on by default only if this gate shows a win and the B5
safety gate (`test/helpers/pinned-questions-scenarios.ts`) passes with zero
leakage; with safety alone they ship opt-in.
