<!-- /autoplan restore point: "/home/user/.gstack/projects/garrytan-gbrain/plan-memory-proof-wave-autoplan-restore-20261005-005821.md" -->
# Memory proof wave: matched receipts against extract-first memory servers

Status: approved October 5, 2026 (as written; spend cap later raised to $2,800, margin set to 3.0 points). Revised after the CEO, DX and engineering reviews. Covers garrytan/gbrain and garrytan/gbrain-evals.

## Implementation plan

### Goal

Find, with matched and reproducible receipts, the lowest total cost at which an agent memory
reliably answers, corrects and withdraws what it was told, and show where gbrain is ahead of
the strongest extract-first memory server on that measure. "Extract-first" means a system
that calls an LLM on writes to pull facts out of the text, keeps those facts in a database,
and generates readable pages from it. gbrain's writes call no LLM, keep everything, and its
markdown pages are the record. The comparator also keeps raw chunks and has correction
operations; the wave tests workloads, not impossibility claims.

**Primary claim (preregistered).** On untouched sealed conversations, under one audited
protocol with the same answer model, judge and delivered-context targets for both systems,
gbrain's graded accuracy on BEAM 500k + 1M is non-inferior to the comparator's (one-sided 95%
bound of the paired difference above −2.0 points, small-cluster-robust bootstrap stratified by
split, coverage validated by simulation), at a lower total cost per correct answer under a
preregistered cost formula. Before any sealed cell runs, the preregistration states what is
published for ahead, non-inferior, inconclusive and behind. "Tied" is never claimed from a
non-significant difference. If the free power simulation (A0) says the margin can't be
resolved with the available conversations inside the cap, the margin or datasets change before
any paid cell, never after.

**Secondary results (per dataset, exploratory unless Holm-corrected in the preregistration).**
PersonaMem 32k (multiple choice, its own row) and LifeBench (10 users, its own row); matched
public benchmarks LongMemEval-S and LoCoMo10; the accuracy-versus-budget frontier; agent
modes; Workstream B suites.

### Reference points

The public agent-memory benchmark harness hosts LongMemEval-S, LoCoMo10, PersonaMem, LifeBench,
BEAM and PrecisionMemBench with modes `rag`, `agentic-rag`, `agent` and `retrieval`. The
comparator's committed rows are historical reference points only: LongMemEval-S 473/500
(avg 43.6k context tokens), LoCoMo10 1417/1540 (36.2k), PersonaMem 32k 510/589, LifeBench
1433/2003, BEAM rag 86.2 / 80.1 / 79.1 at 100k / 500k / 1M (no per-question files) and
single-query rows from a mode absent at the current harness commit, PrecisionMemBench
single-turn 66/77 total and 33/43 active passes. Facts established while planning:
- The answer model is chosen only through `OMB_ANSWER_LLM` / `OMB_ANSWER_MODEL`; the default at
  the pin is groq `openai/gpt-oss-120b`, the `--llm` flag is ignored, and `.env` overrides the
  shell. The committed rows used `gemini-3.1-pro-preview`, which is marked deprecated.
- BEAM's judge is forced in code to `gemini-3.5-flash` (the committed rows say
  `gemini-2.5-flash-lite`), and BEAM judges once per rubric item.
- The LongMemEval loader puts `{question_id}_{session_id}` into document ids and context, so
  `answer_` session ids reach prompts for any provider that echoes them; 61 of the committed
  500 contexts contain them (a floor).
- The LongMemEval, LoCoMo and LifeBench prompt builders substitute the provider's raw JSON
  response for the rendered context when one is returned, and frame context as "facts and
  entities" (a disclosed threat to validity; both systems get the same prompt).
- The harness aggregate drops empty-context failures from graded denominators, and the judge
  casts `correct` with `bool()`, so the string "false" scores as a pass.
- `agentic-rag` mode fails to construct at the pin (`RAGMode.__init__` rejects `k`).
- PersonaMem timestamps are the first calendar date found in the session text, which can be an
  event date, not when the conversation happened. PersonaMem has no per-user isolation unit.
- The harness lock pins the comparator's server at an older release; its current release runs
  as a separate pinned server.

### What already exists (consumed, not rebuilt)

| Need | Where it lives today |
|---|---|
| Batch writes with per-page receipts and `wait_ms` | `put_pages`, gbrain#6025 (merge train) |
| Unchanged-chunk embedding reuse on edit | `planEmbeddingReuse` in `src/core/embed-reuse.ts`, used by `src/core/import-file.ts` |
| Observation / validity / recorded dates | `src/core/ai/date-grounding.ts`, gbrain#6020 (draft) |
| Relationship edges with validity windows; multi-hop planner | gbrain#6018, gbrain#6019 (drafts) |
| Token-budgeted evidence delivery (`return_unit` page/chunk) | `src/core/search/evidence-delivery.ts`; remote budgets clamp at 32k today |
| Takes with holder, weight, prediction grading | `src/core/cycle/extract-takes.ts`, `grade-takes.ts` |
| Scheduled saved-question answering | `src/core/cycle/auto-think.ts` (7 config keys incl. `enabled`, `auto_commit`, budget, cooldown, model; default off; not in the cycle dispatcher) |
| Revision-guarded publication and same-transaction invalidation | `src/core/persistence/memory-prepare.ts`, `src/core/facts/withdrawal.ts` |
| Consent machinery for paid work | `src/core/consent.ts`, `consent-preapproval.ts` |
| Hermetic gbrain runs in evals | gbrain-evals `eval/runner/hermetic-env.ts`, `gbrain-under-test.ts` (`GBRAIN_UNDER_TEST`) |
| Opaque LongMemEval session ids with scorer-only reverse map | gbrain-evals `eval/runner/longmemeval-session-ids.ts` |
| Sealed-data commitment hashes, access log, `--decision-id` | gbrain-evals sealed-confirmation machinery |
| Spend ledger (single Bun process, five paid hosts) | gbrain-evals `eval/runner/budget-ledger.ts` |
| PrecisionMemBench gbrain adapters | gbrain-evals `eval/precisionmembench/` |

### Workstream A (gbrain-evals): one audited protocol, both systems

A0. **Protocol and safety gate. Free contract work first; no broad paid run until it passes.**
1. *Power simulation (free).* From the committed per-question files and gbrain's paired
   LongMemEval discordance, simulate the primary test on BEAM 500k + 1M (70 conversations,
   split by conversation 14 dev / 14 validation / 42 sealed). Validate the bootstrap's coverage.
   The result sets the margin and the go/no-go before money is spent.
2. *Launcher.* `bun run harness:cell <cell-id>` in gbrain-evals installs the pinned harness
   with `uv` (CPU wheels), registers the gbrain and comparator providers into the harness
   registry at runtime, sets resolved model ids through `OMB_*` variables with `.env` loading
   disabled, wraps the answer model, and runs the harness CLI. Output directories and
   `memory_provider` fields use `gbrain` and `comparator`; a CI grep guard blocks the
   comparator's product name in gbrain-evals.
3. *Cell identity and resume.* A content-addressed cell id over dataset/split manifest hashes,
   code pins, resolved config, models, prompt and scorer revisions, lane, budget and mode.
   Stores, caches and outputs are namespaced by cell id. Actions: `plan` (estimate, no spend),
   `run`, `resume`. Resume continues only matching stage receipts (ingest, retrieve, answer,
   judge) and refuses mismatches; sealed cells never use `--only-failed` or merged reruns.
   Each answer receipt keeps the exact serialized model request.
4. *Paid-request boundary.* Every model, embedding and rerank request from the harness
   (Python), the gbrain MCP child and the comparator server goes through one local metering
   proxy (base-URL overrides per provider) that prices Gemini, Groq, OpenAI, Anthropic and
   Voyage requests, reserves before dispatch against one shared ledger, decodes actual usage,
   and refuses at the cap. Tests prove a zero balance blocks network dispatch from each
   process. Spend the proxy can't see is reported as unmetered and excluded from exact cost
   claims.
5. *Scorer conformance.* A fixed scheduled-question denominator; typed outcomes (answer
   failure, retrieval failure, abstention, judge failure, incomplete ingest); strict judge field
   validation; abstentions judged even with empty context; every BEAM rubric row scored or the
   cell marked incomplete. Golden and mutation tests cover each case. Both systems are scored
   with the audited scorer, and its differences from the historical scorer are published.
6. *Leakage by provenance.* Model inputs come from an allowlisted projection of raw records and
   task-required public fields; gold answers, rubrics, evidence labels and reverse-id maps stay
   inside the scorer. Both providers get opaque ids (the comparator's provider is wrapped to
   hash ids and chunk ids). An `answer_` regression check runs on every final prompt.
7. *Timestamp provenance.* Per dataset, a manifest records whether each document date is an
   observed session time, a stated event date, or unknown. Event dates found inside text are
   never promoted to observation dates; both systems receive the same dates.
8. *Delivered-context targets.* The wrapper counts the exact context text inserted into the
   final prompt (raw JSON included when a builder substitutes it) with `cl100k_base`. Prompts
   are never truncated. Each system's knobs (gbrain `token_budget` with `return_unit`; the
   comparator's fact and chunk budgets) are tuned on dev to hit each target, and cells are
   gated on mean and p95 delivered tokens within ±10% of the target. gbrain's remote budget
   clamp is raised for this path and the run asserts no clamp occurred.
9. *Mode smoke.* A free protocol smoke for every dataset × mode × provider (the `agentic-rag`
   constructor is fixed in the wrapper), then one tiny paid acceptance cell per provider path.
   Its measured usage rebuilds the cell ledger; if the ledger exceeds the cap, the plan comes
   back for approval before broad runs.

A1. **gbrain provider.** About 300 lines of Python in gbrain-evals `eval/harness-provider/`.
- Hermetic process contract (reusing `hermetic-env.ts` rules): absolute per-unit `GBRAIN_HOME`
  and working directory, a pinned gbrain launcher from `GBRAIN_UNDER_TEST`, only the cell's
  declared credentials, no service installation or background enrichment, children reaped on
  success, interruption and failure. A sentinel test proves the operator's real `~/.gbrain` is
  untouched, an unrelated key is never called and units can't read each other's pages.
- `prepare`: copies one migrated template brain per isolation unit (500 units for
  LongMemEval); PersonaMem gets per-persona units for both systems.
- `ingest`: one dated conversation page per document with an opaque slug, via `put_pages` (50
  per call, `wait_ms`), then a completion barrier: every batch terminal, the embedding queue
  drained and no stale pages before the first question.
- `retrieve`: `query` with `token_budget` and `return_unit: page`, each block with a one-line
  date header from the timestamp manifest.
- `direct_answer` (agent mode): `gbrain think` with the same answer model; delivered tokens and
  tool calls recorded; agent mode is labeled exploratory.
- One preregistered per-dataset config.
- A quickstart linked from the gbrain-evals README: install, a keyless fixture that exercises the
  real adapter end to end and writes a receipt (labeled a plumbing check), then `plan` and `run`
  for a paid cell. Every report row links its cell id and reproduce command. The cold-clone time
  to the first fixture receipt is measured and published.

A2. **Splits.** A grouping manifest, committed before any tuning, splits by conversation or
person (all histories of a persona together) and is sealed with the existing commitment-hash,
access-log and `--decision-id` machinery. Primary: BEAM 500k + 1M, 14/14/42. PersonaMem and
LifeBench use the same rule with their cluster counts reported. Tuning uses dev, every fix and
config choice is confirmed on validation, and sealed runs once. A failed sealed result ends
that decision. LongMemEval-S and LoCoMo10 are matched public benchmarks, not confirmation.

A3. **Same-day comparator runs.** The comparator's current release runs as a pinned server
beside gbrain on every primary and secondary cell: same day, same answer model, same targets,
blinded and shuffled joint re-judging that calls each dataset's own judge and asserts its model
id. Its best supported mode (facts plus raw chunks) is used. The statistical comparator never
switches after results are seen; committed rows appear as attributed historical reference with
reproduction deltas.

A4. **Lanes.** Raw-only, facts-only and combined for both systems where supported, on
LongMemEval-S, LoCoMo10 and the dev slices. gbrain's facts lanes run its opt-in extraction and
count that spend.

A5. **Equal-context frontier.** Targets 4k, 8k, 16k and 32k plus each system's own default,
swept on dev; the preregistered target and at most two more points run on sealed for both
systems. Outputs: accuracy versus delivered tokens and dollars per correct answer, plus p50/p95
retrieve latency.

A6. **Cost formula.** Preregistered: ingest LLM dollars + embedding dollars + CPU-hours at a
stated rate + read-time context and answer dollars, amortized at a stated reads-per-write
ratio, with sensitivity at 1× and 10× reads. Wall-clock ingest is reported, not headlined.

A7. **Agent modes and the coding-agent benchmark.** `agentic-rag` and `agent` on the dev slices of
LongMemEval-S, LoCoMo10 and LifeBench (exploratory). A spike runs the harness's coding-agent
memory benchmark (61 tasks) with gbrain as the memory; the full run (budget line 6) follows a
positive spike.

A8. **Baselines.** The harness's hybrid-search baseline and a full-context reader where the
history fits, on every primary cell.

A9. **PrecisionMemBench and scale.** PrecisionMemBench in `retrieval` mode, reporting active
passes, precision and recall with denominators. gbrain uses its zero-LLM write path and does not
claim `supports_filters`; a structural gap is reported, not chased. BEAM 10M runs for both systems (budget line 7); LongMemEval-M runs from line 8.

### Workstream B (gbrain-evals): workload suites

Each suite has a seeded generator, a `bun run eval:<suite>` entry point, a solvability check,
a presence assertion, and runs both systems from the same raw records. Structure gbrain uses
(facts, typed edges, takes) is built inside the measured pipeline with its LLM spend counted;
structured-oracle runs are separate ceilings. Readers: one fixed reader for all cells (the
newest frontier Sonnet), plus a preregistered subset swept across the newest Opus, GPT, Sonnet
and Fable models, one fixed judge, ceilings called out.

B1. **Passing details.** 40 histories, 400 questions on details mentioned once. Each miss is
classified as absent from storage, stored but not retrieved, or delivered but misread. Raw,
facts-only and combined lanes for both systems.

B2. **Corrections.** 100 seeded corrections. Each system uses its documented correction path at
the frozen build (gbrain: edit the page and sync; `forget` then `remember`; `remember.replaces`
as a named arm only if it has merged. Comparator: its edit/invalidate operation and document
re-retain), plus an identical append-a-correction arm. Corrected-value accuracy and stale-answer
rate after 1 and 5 unrelated writes; inspectability reported separately.

B3. **Time and relationships.** The as-of and composed-question suites rendered as
conversations; gbrain builds edges in-pipeline. An external-system comparison, not a
confirmation of the relationship features.

B4. **Beliefs.** 150 questions on who holds a view, how its weight changed and which predictions
resolved; gbrain extracts and grades takes in-pipeline.

### Workstream C (gbrain): product changes, gated on evidence

C1. **Dated evidence blocks.** Evidence delivery renders each block's observation date and, for
facts, its validity window in a fixed one-line header, with unknown dates shown as unknown.
Config key `search.evidence_date_header` (default from the verdict). Depends on #6020. Confirmed
on validation slices before it becomes the default.

C2. **Interleaved candidates for find-the-twin jobs.** Fact supersession candidate search today
is a single cosine list (recency without embeddings). C2 adds a keyword arm and merges the two
with `interleaveFusion` (each arm's #1, then each arm's #2, de-duplicated by fact id), behind
`facts.candidate_fusion`. It is gated on false-supersession rate and preserved distinct claims
(same entity, changed numbers or dates, private rows, concurrent corrections), not candidate
recall alone. RRF stays everywhere else.

C3. **Fix lane.** Where dev shows gbrain behind on a primary cell, up to three fix rounds, each
confirmed on validation, never on sealed. A fix that doesn't confirm is removed.

C4. **Pinned questions.** Replaces the config-list form of `auto_think`. Version 1 is
owner-private.
- *Surface.* CLI `gbrain questions pin|list|status|refresh|unpin`; MCP `questions_list` and
  `questions_status` (read scope, owner-capable grants only), `questions_pin`,
  `questions_refresh` and `questions_unpin` (write scope). Scope is a structured selector
  `{source, slug_prefix?, entity?}` defaulting to the current source; ids are source-qualified;
  pinning the same question twice is idempotent; unpin stops refresh and archives the page.
- *Privacy.* Question pages live in the owner's private scope. Restricted remote grants never
  see them in search, `get_page`, `context_pack` or export, so no per-sentence projection is
  needed in version 1; unknown or unverifiable dependencies fail closed.
- *Consent.* A pin created over MCP is inactive until the owner activates paid refresh locally
  or through the existing consent preapproval; a CLI pin is active. A pin never installs a
  scheduler.
- *First answer.* `questions_pin` returns the first answer when a model key and consent exist
  (bounded wait); otherwise it returns the pin with state `awaiting_refresh` and the exact next
  step.
- *Evidence and staleness.* `question_evidence` records, per answer sentence, the cited page
  revision, fact id, timeline entry or take id. Staleness is computed at read time from
  `pages.generation`, fact validity and expiry columns, so hard deletes, `forget`, expiry and
  visibility changes are caught without relying on write hooks. Synthesis and question pages
  are never evidence.
- *Refresh.* Re-retrieves over current authorized evidence and edits the previous answer
  (full recompute after deletions, conflicting corrections or non-monotonic questions). A
  durable job lease, the question revision and the dependency revisions are captured at start
  and revalidated at commit through the revision-guarded publication path; a concurrent change
  keeps the answer stale. A failed refresh keeps the previous answer with its stale flags.
- *Receipts and errors.* Every pin, list, status and read returns freshness state, evidence
  watermark, last successful refresh, blocked reason (`no_model_key`, `budget_exhausted`,
  `no_worker`, `refresh_failed`, `awaiting_consent`) and next action in the agent operator
  envelope with a read-only verify step. `context_pack` withholds stale sentences and reports
  the withheld count in an optional field.
- *Owner edits.* Kept as owner-attributed claims, subject to the same staleness rules.
- *Migration.* All seven `dream.auto_think` keys map over: `enabled=false` or a zero budget
  imports inactive pins; `auto_commit=false` keeps draft-only behavior; cooldown, model and
  maximum work carry over. No provider call during migration; idempotent re-run; the old keys
  print their replacement.

B5. **Pinned-question eval.** A safety gate and a benefit gate. Safety: zero stale-sentence or
cross-grant leakage across search, `get_page`, `context_pack`, export and history, under
deletions, `forget`, expiry, visibility changes, concurrent owner edits, duplicate workers and
crashes between publication stages; any leak blocks shipping in any form. Benefit: total
lifecycle dollars per correct, fresh answer (initial pin, every refresh attempt, embeddings,
delivered read tokens) at frozen read/write ratios against `query` + reader at equal tokens and
on-demand `think`, with the break-even read count reported. Operator journeys: MCP-only pin and
refresh, read-only list, keyless state, absent worker, failed refresh recovered without a shell.
C4 is default-on only if it passes both gates; otherwise opt-in (safety passed) or removed.

### Publication

- gbrain-evals: preregistration first, then one report per workstream in `docs/benchmarks/`,
  a README section with the primary claim, the matched public benchmarks (committed rows as
  attributed historical reference with reproduction deltas), costs, delivered tokens and tests.
  Receipts in `docs/receipts-manifest.json`, spend in `docs/budget-ledger.md`. The comparator is
  described by kind; no product names are added.
- gbrain: verdicts in `docs/eval/decisions/<id>/` (README, decision.json, verdict.json, as
  existing decision folders on the program branches use), user docs for pinned questions,
  CHANGELOG. No competitor product names in any artifact this wave writes.

### Order and delivery

1. A0 steps 1–9 (power simulation first) and A1; C2 in parallel.
2. Dev: A3–A8 on dev slices; C1 and C3 decisions on validation.
3. gbrain wave PR opened with C1–C3; the measured build is that PR's head SHA installed from
   GitHub. The preregistration names the SHA.
4. Sealed primary cells for both systems, then secondary cells the ledger can afford.
5. B1–B4 in parallel with 2–4; C4 + B5 after dev results, in the same PR.
6. Merge only after sealed results and B5; the merged `src/` tree is checked byte-identical to
   the measured SHA's for every measured path, and the release notes cite it. gbrain-evals
   ships as one PR.

### Budget

Paid spend through the metering proxy, cap $2,500 (approved), bought in this order:
1. A0 paid smoke and the primary comparison on BEAM 500k + 1M, both systems, sealed and
   validation: about $500.
2. Secondary datasets and matched public benchmarks at the preregistered target: about $350.
3. Dev sweeps, lanes, agent modes and fallback-model overlap: about $300.
4. B suites (one fixed reader plus the frontier subset) and B5: about $200.
5. Fix-lane validation reruns: about $100.
6. The full coding-agent memory benchmark run (if the A7 spike is positive): about $400.
7. BEAM 10M for both systems: about $350.
8. Extra frontier points on sealed and LongMemEval-M: about $200.
9. Reserve: $100.
The paid smoke rebuilds these lines from measured usage; if they exceed $2,500 the plan comes
back for approval.

### Not in scope

- An opinion network with a conviction score.
- LLM extraction on every write by default.
- Reducing the MCP tool count (gbrain#6027 owns the advertised surface; `questions_*` ops join
  the full surface only).
- Partial-index and query-plan tuning.
- Batch writes, date grounding, edge validity and the multi-hop planner (measured here, built
  in other PRs).
- Sentence-level privacy projection for pinned questions shared with restricted grants (version 1
  is owner-private).
- Submitting gbrain to the harness's upstream leaderboard (decided after sealed results).

## Review record

<!-- autoplan review artifacts are appended below -->

### Phase 1: CEO review (SELECTIVE EXPANSION, auto-decided)

Voices: native reviewer completed; outside voice (GPT-6 Astra, high reasoning) completed.
The Codex CLI is not installed on this machine, so the outside voice ran as a separate
model reviewer with the same outside-voice prompt.

CEO DUAL VOICES — CONSENSUS TABLE:

| Dimension | Native | Outside | Consensus |
|---|---|---|---|
| 1. Premises valid? | No: "ahead" unreachable near ceiling; correction premise false | No: sealed slice not independent; impossibility claims contradicted | CONFIRMED: revise |
| 2. Right problem? | Reframe to equal-budget accuracy plus cost | Reframe to lowest total cost for reliable remember/correct/withdraw | CONFIRMED: reframe |
| 3. Scope calibration? | Gate C1 on its own eval; budget too thin | C1 needs lifecycle contract; budget lacks allocation | CONFIRMED |
| 4. Alternatives explored? | Agent modes and coding-agent benchmark skipped | No full-context / current-agent baseline | CONFIRMED: add both |
| 5. Competitive risks? | Vendor owns harness; moving to agentic boards | Historical rows not a reproducible protocol | CONFIRMED |
| 6. 6-month trajectory? | A "tied/behind" table on the vendor's board is quotable | Persuasive comparison without independent win | CONFIRMED |

Premise challenges (0A): the v1 goal "show we are better" on near-ceiling boards could not
produce a publishable "ahead" (LongMemEval-S needs about 97% on the sealed slice). The v2 goal
is non-inferiority at lower total cost on untouched data, which the evidence can decide.

Dream state delta: current state is one strong retrieval metric on one tuned dataset and no
matched answer comparison. This plan produces a matched, cost-normalized, independently
confirmed comparison plus agent-mode and workload evidence. The 12-month ideal is a
continuously re-run public lane on every release; that is deferred (see TODO below).

Error & Rescue Registry:

| Failure | Detection | Rescue |
|---|---|---|
| Answer model retired mid-wave | harness call errors | preregistered fallback already run on overlap; both systems switch together |
| `answer_` or gold string in a prompt | A0 leak guard | run fails; cell rerun with opaque ids |
| Provider context replaced by raw JSON in prompt | A0 final-prompt hashing | budget enforced on final prompt |
| Comparator reproduction differs from committed row | reproduction delta | report delta; comparator choice never switches post hoc |
| Spend overrun | dispatch guard | cell refused; next purchase tier waits |
| Judge drift | single joint judge pass | both systems re-judged together |
| put_pages partial failure during ingest | per-page receipt | retry failed pages; cell marked incomplete otherwise |

Failure Modes Registry (critical gaps closed in v2): non-independent sealed data; unmatched
historical protocol; impossibility claims; token counting on the wrong payload; "tied" from
non-significance; pinned-answer staleness after deletion/withdrawal/visibility change.

Accepted expansions (in blast radius): agent-mode lanes and coding-agent spike (A6);
hybrid and full-context baselines (A7); one-command reproduction (A1); pinned-question
lifecycle contract (C4).

<!-- autoplan-accepted:ceo -->
- Primary claim is sealed non-inferiority (margin 2.0 points, history-clustered bootstrap) plus lower cost per correct answer, on untouched datasets, against same-day comparator runs; outcome-specific publication plan written before sealed cells.
- A0 protocol audit gate: pinned harness/datasets/prompts, final-prompt token counting and hashing, opaque ids with leak guard, fallback answer model on an overlap, one joint judge pass, executable cell ledger with dispatch guard.
- Splits by history: 20/20/60 dev/validation/sealed; fixes confirmed on validation only; LongMemEval-S and LoCoMo10 reported as matched public benchmarks, not confirmation.
- Comparator runs in its best supported mode with its native correction operations; no impossibility claims.
- gbrain structures used in B suites are built in-pipeline from the same raw records with their cost counted.
- Agent-mode lanes, coding-agent spike, hybrid and full-context baselines added.
- C4 pinned questions carry the evidence-dependency and lifecycle contract and ship on only if B5 shows a win with zero stale leakage.
- Freeze on a released tag; open PRs measured only as named arms.
<!-- /autoplan-accepted:ceo -->

Decision Audit Trail:

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | Mode SELECTIVE EXPANSION | Mechanical | autoplan override | added capability on existing system | HOLD, EXPANSION |
| 2 | CEO | Primary claim → non-inferiority + cost | Mechanical (both voices) | P1 | "ahead" unreachable; "tied" invalid | ahead-or-tied rule |
| 3 | CEO | Confirmation on untouched datasets, 20/20/60 | Mechanical (both voices) | P1 | LongMemEval-S already tuned on | re-split of LongMemEval-S |
| 4 | CEO | Same-day comparator runs as the paired comparator | Mechanical (both voices) | P1 | committed rows differ in judge, mode, leak status | committed rows as comparator |
| 5 | CEO | B2 uses comparator's native correction ops | Mechanical (both voices) | P1 | premise was false | message-only path |
| 6 | CEO | Add agent modes + coding-agent spike | Taste | P2 | where the field is moving; cheap on dev | chat-QA only |
| 7 | CEO | Add hybrid + full-context baselines | Mechanical | P1 | "no memory product" control | none |
| 8 | CEO | Budget cap $1,000 → $1,500 with purchase order | Taste (needs approval) | P1 | one full pass costs about $400 | $1,000 |
| 9 | CEO | Pinned questions kept, sequenced after dev results, lifecycle contract | Taste | P1 | both voices: gate it | build first / drop |
| 10 | CEO | PrecisionMemBench structural gap out of fix lane | Mechanical | P3 | harness asks for write-time LLM labels | chasing it |
| 11 | CEO | Continuous public lane per release | Deferred | P3 | outside blast radius | — |

### Phase 2: Design review

Skipped: no UI scope (zero view/rendering terms).

### Phase 2.5: DX review (agent-primary)

Voices: native reviewer completed; outside voice (GPT-6 Astra) completed. Both reviewed the
v2 plan in parallel with the engineering phase.

Native scores (v2): getting started 3/10, ergonomics 5, error handling 3, docs 5, escape
hatches 5. Time to first working result was undemonstrated (no entry point, no keyless smoke);
v3 target: one README-linked quickstart reaching a keyless fixture receipt, with the cold-clone
time measured and published.

DX DUAL VOICES — CONSENSUS TABLE:

| Dimension | Native | Outside | Consensus |
|---|---|---|---|
| Getting started | No entry point, provider can't register, 298-package lock | No runnable first success | CONFIRMED: launcher + keyless fixture |
| Isolation | Provider tests the global install | Init writes the operator's `~/.gbrain` | CONFIRMED: hermetic process contract |
| Resume / retries | Sealed machinery not reused | No cell identity, merges collide | CONFIRMED: content-addressed cells |
| Pinned-question API | MCP pin starts paid spend; names; no first answer | No MCP refresh, read-scoped status, scope grammar | CONFIRMED |
| Migration | 1 of 7 keys mapped | Disabled/zero/draft settings lost | CONFIRMED |
| Errors | Guard failures lack fix contract | Freshness states not actionable | CONFIRMED |

Developer journey (v3): clone → `bun install` → quickstart keyless fixture (plumbing receipt) →
`harness:cell plan <id>` (estimate, no spend) → `run` → report row links back to the cell id.
Agent journey for pinned questions: pin (CLI active / MCP inactive until consent) → first answer
or `awaiting_refresh` with next step → status shows freshness and blocked reason → refresh via
MCP or CLI → unpin archives.

<!-- autoplan-accepted:dx -->
- Launcher registers both providers at runtime, sets resolved models via OMB_* with .env disabled, uses `gbrain`/`comparator` ids, and a CI grep guard blocks the comparator's name.
- Hermetic per-unit GBRAIN_HOME, pinned GBRAIN_UNDER_TEST launcher, declared credentials only, children reaped; sentinel test proves the real home is untouched.
- Content-addressed cell ids with plan/run/resume; resume only on matching stage receipts; budget refusals name the cell, spend and the non-spending next step.
- README-linked quickstart with a keyless end-to-end fixture; cold-clone time measured.
- Pinned questions: questions_* naming, structured scope with default, source-qualified idempotent ids, read-scoped list/status, MCP refresh, MCP pins inactive until consent, defined first answer, operator-envelope blocked reasons, context_pack withheld count.
- auto_think migration maps all seven keys and never creates consent from a disabled or zero-budget list.
- C1 and C2 have config keys; decision folders use README + decision.json + verdict.json.
<!-- /autoplan-accepted:dx -->

### Phase 3: Engineering review

Voices: native reviewer completed (diagram, codepath-to-test map, failure registry and test
plan in its review file); outside voice (GPT-6 Astra) completed with offline probes that
reproduced the BEAM denominator inflation, the `bool("false")` judge pass and the broken
`agentic-rag` constructor.

Architecture (v3):

```
 gbrain-evals launcher (cell id, prereg hashes, OMB_* models)
   └─ harness (Python, pinned) ──► A0 wrapper: final-prompt capture, cl100k count,
        │                          provenance leak check, target gate, typed scorer
        ├─ gbrain provider ── hermetic GBRAIN_HOME per unit ── stdio MCP: put_pages
        │     + completion barrier (batches terminal, embeddings drained) ── query
        │     (token_budget, return_unit=page, date header) / think (agent mode)
        └─ comparator provider (opaque-id wrapper) ── pinned current server
   all model/embedding/rerank traffic ──► metering proxy ──► shared ledger (reserve/settle/refuse)
   joint blinded re-judge (dataset's own judge) ──► stats (stratified small-cluster bootstrap,
   NI decision, cost formula) ──► receipts manifest, budget ledger, reports
```

ENG DUAL VOICES — CONSENSUS TABLE:

| Dimension | Native | Outside | Consensus |
|---|---|---|---|
| Statistical design | Too few clusters; MCQ can't pool | Grouping and estimand underspecified | CONFIRMED: BEAM 500k+1M primary, free power sim |
| Spend enforcement | Ledger single-process, no Gemini/Groq | Same, plus BEAM per-rubric calls | CONFIRMED: metering proxy |
| Scorer correctness | Errors become wrong answers | Denominator inflation, bool("false") | CONFIRMED: conformance gate |
| Model selection | groq default, --llm ignored | Same, plus agentic-rag broken | CONFIRMED |
| Ingest completeness | No barrier before questions | — | Native-only critical, accepted |
| Budget enforcement point | Comparator prompt is JSON; two knobs | Replay can't reproduce raw prompts | CONFIRMED: count inserted text, tune knobs, no truncation, keep requests |
| Pinned-question safety | Leaks via search/get_page/export; hooks miss deletes | All projections; atomic refresh; non-monotonic answers | CONFIRMED: owner-private v1, read-time staleness, guarded refresh |
| Release order | Tag can't contain measured fixes | — | Native-only critical, accepted (measure PR head SHA) |
| C2 seams / correction API | `replaces` unmerged; dup check exact-hash | Same; recall-only gate unsafe | CONFIRMED |

Failure modes registry (v3 status):

| ID | Failure | Status in v3 |
|---|---|---|
| F1 | Questions answered before embeddings land | Closed: completion barrier |
| F2 | Margin unresolvable, found after spend | Closed: free power simulation gates spend |
| F3 | Released build differs from measured build | Closed: measure PR head SHA; byte-identical check at merge |
| F4 | Comparator prompt over target | Closed: knob tuning, mean/p95 gate, no truncation |
| F5 | Spend outside the guard | Closed for metered paths; unmetered spend excluded from exact claims |
| F6 | Failures scored as passes or dropped | Closed: typed outcomes, strict judge validation |
| F7 | `answer_` ids via either provider | Closed: opaque ids for both, regression check |
| F8 | Wrong answer model | Closed: resolved ids via OMB_*, .env disabled |
| F9 | Cell collisions on resume | Closed: content-addressed cells |
| F10 | Pinned answer leaks or goes stale silently | Closed for v1 by owner-private scope + read-time staleness; B5 safety gate |
| F11 | Refresh races an edit or withdrawal | Closed: lease + revision revalidation at commit |
| F12 | Event dates presented as observation dates | Closed: timestamp provenance manifest |
| F13 | MCP agent starts paid refresh without the owner | Closed: MCP pins inactive until consent |

Test plan: lives in the native engineering review (section 6) and is carried into
`docs/benchmarks/` preregistration and the PR test list: A0 golden and mutation scorer tests,
proxy zero-balance tests per process, sentinel isolation test, resume/interrupt tests at each
stage, replay byte-identity tests, opaque-id leak tests, timestamp provenance tests, C1 header
golden, C2 false-supersession suite, C4 lifecycle, privacy and migration tests on PGLite and
Postgres.

<!-- autoplan-accepted:eng -->
- Free power simulation on committed per-question files sets the margin and go/no-go; primary is BEAM 500k+1M split by conversation 14/14/42 with a coverage-validated small-cluster bootstrap; PersonaMem and LifeBench reported per dataset.
- Metering proxy for every model/embedding/rerank request from all processes, with reserve, usage decoding and refusal; zero-balance tests per process.
- Scorer conformance gate with typed outcomes, strict judge validation, judged abstentions, BEAM rubric completeness; golden and mutation tests.
- Ingest completion barrier before the first question.
- Delivered-context targets counted on inserted text, knobs tuned on dev, mean/p95 gate, no truncation, remote clamp raised and asserted.
- Comparator runs as a pinned current server behind an opaque-id wrapper; joint blinded re-judge with each dataset's own judge.
- Timestamp provenance manifest per dataset.
- C2 adds a keyword arm with interleaving for fact supersession candidates, gated on false-supersession and preserved distinct claims.
- C4 v1 owner-private, read-time staleness, leased and revision-revalidated refresh, B5 safety gate blocks any shipping on leakage.
- Measured build is the wave PR's head SHA; merge after sealed results with a byte-identical src check.
<!-- /autoplan-accepted:eng -->

Decision Audit Trail (continued):

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 12 | DX | Launcher + runtime provider registration | Mechanical (both) | P5 | harness registry is a hard-coded dict | provider file alone |
| 13 | DX | Hermetic per-unit home | Mechanical (both) | P1 | init rewrites ~/.gbrain | --path only |
| 14 | DX | Content-addressed cells, plan/run/resume | Mechanical (both) | P1 | collisions and repeat spend | dataset+system selector |
| 15 | DX | MCP pins inactive until owner consent | Mechanical | P1 | write-scope agent could start paid work | pin = consent everywhere |
| 16 | DX | Migration maps all 7 keys | Mechanical (both) | P1 | disabled lists must not become paid refresh | question-list-only import |
| 17 | Eng | Primary moves to BEAM 500k+1M | Mechanical (both) | P1 | LifeBench 10 users can't resolve 2 points | pooled 3-dataset primary |
| 18 | Eng | Metering proxy | Mechanical (both) | P5 | in-process fetch guard can't see Python/daemon spend | estimates |
| 19 | Eng | Scorer conformance gate | Mechanical (both) | P1 | reproduced fail-open scoring | trust harness scorer |
| 20 | Eng | Completion barrier | Mechanical | P1 | pending writes/queued embeddings | none |
| 21 | Eng | No truncation; tune knobs to targets | Mechanical (both) | P5 | truncating JSON breaks the comparator | hard truncation |
| 22 | Eng | C4 v1 owner-private | Taste | P5 | avoids per-sentence projection across every read path | shared question pages |
| 23 | Eng | Read-time staleness | Mechanical | P1 | hard deletes and expiry have no write event | write hooks only |
| 24 | Eng | Measure PR head SHA, merge after, byte-identical check | Taste | P3 | keeps one PR (fix-wave convention) | release tag before freeze (two PRs) |
| 25 | Eng | C2 gated on false-supersession | Mechanical (both) | P1 | better recall can raise wrong replacements | recall@5 gate |
| 26 | Eng | B readers: one fixed + frontier subset | Mechanical | P3 | four readers on every cell overruns budget | four readers everywhere |

### Deferred to TODOS

- A continuously re-run public lane on every gbrain release (pinned subset, cheap).
- Sentence-level privacy projection so pinned questions can be shared with restricted grants.


### Implementation tasks

1. (P1, A0) Power simulation from committed per-question files; margin and go/no-go.
2. (P1, A0) Launcher with runtime provider registration, OMB_* model pinning, name guard.
3. (P1, A0) Content-addressed cells, plan/run/resume, request receipts.
4. (P1, A0) Metering proxy and shared ledger, zero-balance tests per process.
5. (P1, A0) Scorer conformance, provenance leak model, timestamp manifests, context targets, mode smoke.
6. (P1, A1) gbrain provider with hermetic contract, template brains, completion barrier, quickstart.
7. (P1, A2–A3) Grouping manifest sealed with existing machinery; comparator pinned server and opaque-id wrapper; joint re-judge.
8. (P2, A4–A9) Lanes, frontier, cost formula, agent modes, coding spike, baselines, PrecisionMemBench.
9. (P2, B1–B4) Workload suite generators and runs.
10. (P2, C1–C3) Date headers, interleaved candidates, fix lane.
11. (P2, C4 + B5) Pinned questions with lifecycle, privacy, consent and migration; safety and benefit gates.
12. (P3) Reports, README, receipts, ledger, decision folders, CHANGELOG.

### Approval (Phase 4)

Garry, October 5, 2026:
- Plan: approved as written, pinned questions included behind the B5 safety gate.
- Spend cap: $2,500 (adds the full coding-agent run, BEAM 10M and more frontier points).
- Publication: in gbrain-evals, naming the public benchmark and datasets, not the competitor.
- The existing dated citation row in gbrain-evals `docs/comparison-systems.md` stays as is.

### Decisions after the power simulation and the measured ledger (October 5, 2026)

Garry approved:
- **Margin 3.0 points**, with the BEAM 100k reserve added to the primary endpoint: BEAM 100k + 500k + 1M, split by conversation (100k 4/4/12, 500k 7/7/21, 1M 7/7/21), so 54 sealed conversations. Simulated power at a true difference of 0 is 87% (central assumptions). The restricted wild cluster bootstrap-t with Webb weights is the primary method; CR1 t and cluster bootstrap-t are reported beside it. LifeBench and PersonaMem are descriptive rows only.
- **Spend cap $2,800** (rebuilt ledger $2,720 at a 25% frontier sweep in the B suites).
- **Answer model for every A cell: `gemini-3.8-flash`**, identical for both systems; judge `gemini-3.5-flash` (BEAM's harness judge) and the dataset's own judge elsewhere, in one joint blinded re-judge.
- Agent mode runs on an OpenAI model until gbrain's native Google chat path accepts a base-URL override (added in this wave so it can be metered).
