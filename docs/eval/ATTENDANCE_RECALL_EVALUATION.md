# Attendance and recall packing evaluation

## Decision

Explicit attendance makes the graph reflect supported meeting evidence instead
of ordinary mentions. Query-first packing helps question-focused recall when
unrelated facts would otherwise use its entire context budget. It remains an
explicit opt-in because fact-focused questions can lose necessary facts.
Conditional query expansion is excluded: it lost substantially more complete
evidence than it gained against the original-query baseline.

These are separate claims. Attendance tests establish extraction, ownership and
consumer behavior. The packing comparison measures retained evidence, not answer
accuracy. Neither establishes a broad semantic-retrieval improvement.

## Matched packing comparison

The synthetic cohort contains 16 cases: eleven page-evidence questions, three
fact-focused controls, one deliberately misrouted fact-focused question, and one
source/privacy control. Each case runs the same actual `recall` handler with
omitted policy, explicit `facts_first`, and the case's selected policy. The
fixture manifest SHA-256 is
`16f14c6738518c4eff6276ed29f173e313b1303b7a046e0da1931509e839621f`.
Complete evidence means that every required page slug and exact required fact
is present, not that a generated answer was judged correct.

The recorded first-wave replay on tree
`50a7ee3081d443b92db79bd785421c3742fc8e03` produced 48 actual receipts using
in-memory PGLite and keyless keyword fallback, with no provider calls:

| Cohort | Cases | Baseline complete | Selected policy complete | Wins / losses |
|---|---:|---:|---:|---:|
| Page-evidence questions | 11 | 1 | 9 | 8 / 0 |
| Fact-focused controls | 3 | 3 | 3 | 0 / 0 |
| Forced query-first fact-risk probe | 1 | 1 | 0 | 0 / 1 |
| Source/privacy control | 1 | 1 | 1 | 0 / 0 |

The eleven question cases used an estimated 944 tokens in the baseline and 874
with query-first packing. These are estimates from the existing packer, not
model-billed tokens. All sixteen omitted-policy receipts matched the baseline
apart from fixture timestamps. Explicit `facts_first` matched omission apart
from its documented additive accounting. No forbidden source/private page was
returned in the source/privacy control.

A fresh paired replay after the correctness pass compared upstream
`db56c778e8b287482e21df654e6df6dbcc9745fd` with candidate
`2f33f01486f51a4d42fba5f41c9df82148f6b7de` (tree
`702c804ec8440143e92dda0754af582e4f681167`). It produced 48 receipts per
revision with zero provider calls and reproduced every table count and the
944-to-874 token estimate above. All sixteen omitted-policy results matched
the new upstream baseline after normalizing only fixture `created_at` values;
explicit fact-first results additionally differed only by `budget_packing`.

The questions are synthetic development fixtures, not a held-out semantic
retrieval benchmark. Repeated budgets and related fixtures are not independent
user questions. The forced fact-risk loss is retained rather than averaged into
the positive cohort. Keep fact-first routing for fact-focused consumers; do not
turn the question-cohort result into a default-policy change.

## Conditional expansion result

The separate held-out evaluation recorded 672 cells over 56 unique questions.
At result limit five, the 48 answerable questions retained complete evidence in
46 original-query cases, 29 always-expand cases and 31 conditional-expand cases.
Conditional expansion gained one case and lost sixteen against the original
query. Its four wins and two losses against always-expand do not justify
shipping it: always-expand was already the weaker comparator.

This result excludes conditional expansion from the attendance/packing change.
It does not establish that every query-expansion method is ineffective, or that
an unrelated research paper has been faithfully replicated.

## Correctness evidence and limits

The executable attendance cases live in `test/attendance-retrieval.test.ts`,
`test/attendance-extraction-bounds.test.ts`,
`test/derived-link-reconciliation.test.ts` and
`test/extract-timeline-attendance.test.ts`. They cover real publication and
query paths, DB/stale/sweep/filesystem ingestion, pack-owned directions,
source/type/privacy constraints, ambiguous references, deletion ownership,
comment/code masking and timeline consumption without a gazetteer fallback.
The database-backed cases run on PGLite and disposable PostgreSQL.

Historical repair has separate preview/apply and crash-replay cases in
`test/attendance-repair.test.ts`, connection identity cases in
`test/attendance-repair-identity.test.ts`, and real local-CLI cases in
`test/attendance-repair-cli.serial.test.ts`. Passing those tests does not
authorize a repair on a real brain. Repair requires an exact reviewed preview,
separate operator approval, and a verified full database backup, as described
in [the operator guide](../guides/attendance-evidence.md).

The ordinary filesystem extractor reads source-wide endpoint metadata for
canonical resolution. That cost is not represented as a measured latency
regression here. There is no production-brain repair, native-harness activation,
or broad answer-quality claim in these results.
