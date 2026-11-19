# P1 temporal typed edges: development verdict and held-out preregistration

**Held-out verdict (set B): fail** on the traps gate (101 of 115) and recall
non-inferiority. Round 2, with the fixes and a new preregistration, is in
[p1-dev-2026-10-04-r2](../p1-dev-2026-10-04-r2/README.md).

This folder holds the development comparison for temporal typed edges and the
plan for the held-out run. `decision.json` is the decision-kit spec and
`verdict.json` is the kit's dev verdict. Dev verdicts never set a default; the
held-out verdict from the custodian does.

## Builds

- Baseline: `5bd9e8497` (master merge base).
- Candidate: `bc6723c85`. Later branch commits change only CLI help, exit
  codes, tests and goldens (`git diff bc6723c85..HEAD -- src/` touches
  `src/cli.ts` and `src/commands/edge-proposals.ts`), none of which the
  sources below call.

## Development results (kit verdict `blocked`: two guardrail sources have kit-template errors, below)

Primary source `temporal-edges` (gbrain-evals branch `p1-temporal-edges-dev` at `7323f2f`, `eval/runner/temporal-edges.ts`,
development phrasing set A, seeds 3 and 5, zero LLM):

| Metric | Baseline | Candidate | Gate | Result |
|---|---|---|---|---|
| "Who works at C now" precision | 0.343 | 1.000 | superiority +0.10 | pass, Δ 0.657 [0.604, 0.707] |
| Employer set on a date (as-of exact) | 0.212 | 0.900 | superiority +0.15 | pass, Δ 0.688 [0.621, 0.752] |
| Employers during a year (set-F1) | 0.594 | 0.896 | superiority +0.15 | pass, Δ 0.302 [0.259, 0.345] |
| Stale summary flagged in `context_pack` | 0.000 | 0.867 | superiority +0.20 | pass, Δ 0.867 [0.733, 0.967] |
| Current-employer recall (`now`, live reads) | 0.842 | 0.842 | non-inferiority 0.02 | pass |
| Traps (advisor stays live; investments, alumni meetings do not reopen) | 0.446 | 1.000 | candidate ≥ 0.99 | pass |
| Write-order invariance | 1.000 | 1.000 | every item 1 | pass |
| `context_pack` names the current employer (exploratory) | 0.100 | 0.333 | report only | |

Recall is 0.842 in both builds because link typing misses some employers
before temporal state applies: a timeline line "Joined [X] as engineer" on a
page whose prose never names X types X as `mentions`, and "works at [A] …
also advises [B]" can type A as `advises`. That is link typing, shared by both
builds; it also caps as-of at 0.90 and current-employer naming at 0.33.

Guardrails:

- LoCoMo dev recall-all@5: 0.7543 → 0.7543, pass.
- BEAM-100k dev recall-all@5: 0.4537 → 0.4537, inconclusive (6 clusters, below the family minimum of 10).
- N1 knowledge-update contracts: pass in both builds.
- N3 temporal as-of: the kit blocked the comparison (rows without a `scenario`
  cluster). Read from the receipts: 513 of 513 probes pass in both builds.
- N4 entity resolution: the kit blocked the comparison (no eligible rows).
  Read from the receipts: identical headline (B³-F1 0.771, accuracy 0.706, 0
  wrong merges) and identical rows apart from one result ordering.
- Link type accuracy was not compared: its runner reads the installed foresights
  package rather than the build under test.

## Held-out preregistration (for the custodian)

Run by the custodian only; the implementer never sees held-out text or seeds.

1. **E1 temporal edges (decides `graph.edge_validity` stays on).** Phrasing set B
   (cue verbs and templates absent from set A, frozen by the custodian), seeds
   11, 13 and 17. Pass: now-precision +0.10, as-of +0.15, during-F1 +0.15,
   stale-summary correction +0.20 (each a superiority gate with a
   cluster-bootstrap interval above zero); recall non-inferior within 0.02;
   traps ≥ 0.99; order invariance 1 on every item; no guardrail failing.
2. **E2 contradiction phase (decides `dream.edge_contradictions.mode` per model).**
   Same ledger with only dated "joined" lines, undated and out-of-order
   sub-ledgers; `apply` arms for `claude-haiku-4-5` (utility default) and the
   newest frontier models `claude-opus-5-5`, `claude-sonnet-5-5`,
   `gpt-6.1-sol` and `claude-fable-5-1`; 3 runs each. A model is certified for
   `apply` when wrong closures stay at or below 1% in all 3 runs and as-of
   improves at least 10 points over the E1 arm; undated pairs must yield only
   `undated_unresolved`. Budget cap $20 LLM; the custodian asks before the
   frontier arms run past it. Needs the E2 runner mode (not in the kit yet).
3. **E3 ingestion to answer.** A correction written through stdio `put_page`
   (HTTP after remote bulk writes land), then `entity`, `context_pack`,
   ambient turn context, compiled context and `query` checked by string. Needs
   the receipt mode (not in the kit yet).

Defaults follow the verdicts: `graph.edge_validity` stays on only if E1 passes
with no guardrail failing; `apply` is enabled per model only for E2-certified
models (the certified list in `src/core/cycle/edge-contradictions.ts` is empty
until then).
