<!-- /autoplan restore point: "/home/user/.gstack/projects/garrytan-gbrain/feat-system-one-v1-autoplan-restore-20260930-164146.md" -->
# System One v1: Jev decision support in GBrain

Status: plan, reviewed by /autoplan on 2026-09-30 (CEO, DX, Eng; Design skipped, no UI). All recommendations applied per the owner's accept-all instruction; implementation not started. Baseline: master @ 6c8373c (v0.60.13.0).
Delivery: ONE integrated PR, one PATCH version bump, one CHANGELOG entry (owner's standing rule for waves).

## Implementation plan

### Problem

GBrain makes hundreds of small fuzzy judgments per query and per dream cycle. Each one is either a hand-tuned
rule (regex intent, score-cliff autocut, reflex name matching) or a full chat-model call (dream triage, the modality
tie-break). Rules miss what they were not written for. Chat calls are
slow, cost real money per call, and return free text that code has to parse.

TypeSafe's Jev is a "System One" decision model: one `POST /v1/systemone` call carries shared `state` plus a map of
typed questions and returns, per question, a calibrated probability (`noul`), one option with a probability
distribution (`choice`), or a bounded rubric score (`score`). Measured facts we rely on:

- Live probe from this repo's key (2026-09-30): a 3-question request (noul + choice + score) returned in <1 s,
  `model: "jev-1.13.0"` for alias `jev-latest`, `usage.input_tokens: 440`. Price $0.042 per million input tokens,
  output free. Limits: 64k tokens per request (state + all questions), 32k for state + the longest question,
  and account-wide rate limits that TypeSafe says adjust dynamically (published figures differ by source and
  date: 100K tokens/s and 40 requests/s in the compendium, 250K tokens/s and 1,200 requests/minute in a
  2026-09-20 write-up). Aliases move; the response's `model` names the version that answered.
- GBRA-4 (2026-09-18, 404 queries, 5,000 procedure traces): on the same GBrain candidate pool, adding Jev ranking
  raised Recall@1 from 20.8% to 33.2% and ranked the target first in all 134 queries where it was present. The other
  270 misses were candidate-generation misses. Jev fixes judgment, not recall.
- PR #5178 (community, open): a working native Jev reranker adapter with context packing, bounded concurrency and
  cost accounting. Open review gap: the parser ignores `response.model`, so `jev-latest` batches can mix versions.
- A public exploration (supermemory.ai/blog/jev-memory-context-engineering): Jev score-reranking beat BM25 on every
  BEIR set tried; a Jev probability used as a delete gate with a naive threshold kept nothing; sentence-level
  compaction judged out of context damaged meaning; "does this prompt need memory?" was the most promising use.
- Jev-Mem (arXiv 2609.23986): a System One control plane over routing, budget, traversal, scoring and stopping,
  with an LLM only for synthesis; self-reported +11% LoCoMo judge score and 36.7% lower query latency.
- Adversarial caveat: natural-looking text can flip decision-model outputs. Anything decided from attacker-controlled
  text is a signal, never a security boundary.

The seams have moved since the research compendium was written against v0.54: dream triage already has a
verified-segment rescue band (`src/core/cycle/triage-rescue.ts`), hot memory decides supersession with a
deterministic, zero-LLM cosine rule at write time (`decideSingleFact` in `src/core/facts/single-prepare.ts`: same
entity and visibility, cosine at least 0.95, same kind supersedes; the LLM classifier in
`src/core/facts/classify.ts` has no runtime caller), and CRAG grading exists
(`src/core/search/crag.ts`). This plan targets the current code.

### Goal and success criteria

Add one `decide` capability to GBrain and wire it into nine decision slots, so every fuzzy judgment can come from
Jev (fast, cheap, calibrated) or from the configured chat model (no new vendor), with code owning every threshold.

- (a) With every slot `off` (the default), behavior is byte-identical: existing goldens, BrainBench rows and the
  deterministic hybrid-output golden pass unchanged. No config key flips a default in this PR.
- (b) Every slot is `off` or `on`; those are the only modes the CLI, docs and `--recommended` present (owner
  decision 2026-09-30, see "Owner decision: on/off" below). An advanced `shadow` mode exists for diagnostics only.
  `shadow` `shadow` makes the call and writes a decision receipt; it changes no
  ranking, pruning, gating or write and adds diagnostics only when shadow is awaited (`shadow_wait on`, or `--explain`, which awaits shadow for that one
  query), so operators can
  see real traffic, drift, agreement and latency before trusting a slot. Shadow receipts carry predictions, not
  correctness labels; thresholds come from labelled datasets or the bundled reference calibrations.
- (c) A slot in `on` mode uses a threshold from a stored calibration for the exact resolved model id, or an explicit
  operator override. If the provider answers with a different model id than the calibration's, the slot demotes
  itself to off behavior (today's path) for that call, writes a receipt, and `gbrain doctor` warns (drift protection).
- (d) Every slot fails the documented direction: retrieval, context and triage slots fail open to today's path;
  no slot can weaken an existing deterministic floor (verbatim quotes, numbers, visibility, trust).
- (e) Each slot ships with a matched baseline-vs-feature eval run and a recorded verdict (win / no measurable
  change / regression) in `docs/eval/system-one/`. A slot whose verdict is not a win stays documented as
  experimental. A slot not measured within the paid eval budget records the verdict `not measured` and also stays
  experimental. Default flips are out of scope for this PR and need a separate owner decision.
- (f) Data egress is explicit: third-party decide calls never carry `visibility: private` pages, derived pages that
  fail closed under #5525, transcripts or user prompts unless `decide.egress.private=allow`.

### Architecture

```
            callers (search stages, think, serve turn-context, dream, facts, evals)
                                  │  decide(slot, state, questions)
                                  ▼
        src/core/ai/decide/  ── policy.ts   slot config, mode, egress gate, threshold lookup
                              ├ pack.ts     64k/32k budget packing, stable ids, split before send
                              ├ providers/typesafe.ts      native /v1/systemone wire adapter
                              ├ providers/llm-structured.ts chat() + JSON schema, same answer types
                              ├ receipts.ts decision_receipts writer (hashes only, no text)
                              └ calibrate.ts threshold search + reliability curve
                                  │
                    gateway.ts: thin `decide()` export (auth, invocation guard, BudgetTracker kind 'decide')
```

1. **One API.** `decide({ slot, callSite, state, questions, deadlineMs, signal })` where each question is a discriminated
   union: `{ id, kind: 'noul', instructions }`, `{ id, kind: 'choice', instructions, options: Record<label, description> }`
   or `{ id, kind: 'score', instructions, levels: string[] }`. Returns
   `{ answers: Record<id, NoulAnswer|ChoiceAnswer|ScoreAnswer>, provider, model_alias, model_resolved, usage, latency_ms }`.
   Answer types mirror the Jev wire (`noul`, `choice` + `probabilities` + `confidence`, `score` + `probabilities`
   + `confidence`). The module lives in `src/core/ai/decide/` so `gateway.ts` (at its module-size ceiling) only gains
   a delegating export, a recipe touchpoint kind `decide`, and transport test seams.
2. **Providers.** `typesafe:jev-1.13.0` (default pinned id; `jev-latest` and `jev-preview` accepted with a doctor
   warning) and `llm:<provider:model>` (any configured chat model via `chat()` with structured output, emitting the
   same answer shapes; `noul` is the model's stated probability, clearly marked uncalibrated until calibrated).
   Config: `decide.provider` (default `none`), per-slot `decide.slots.<slot>.provider` (inherits it), and
   `decide.egress_fallback` (`none` default, or `llm:<provider:model>`; used only for egress-refused items).
3. **Recipe.** `src/core/ai/recipes/typesafe.ts` declares `decide` and `reranker` touchpoints. Auth env
   `TYPESAFE_API_KEY`; `resolveAuth` also accepts `JEV_TYPESAFE_API_KEY`. Key presence never selects the provider.
4. **Pinned models.** Every response's `model` is recorded. Within one logical decision (all batches of one
   request), mixed resolved ids fail the decision (closes the #5178 review gap everywhere).
5. **Packing.** Generalize #5178's planner: shared state sent once per batch, one question per candidate/segment,
   conservative 2x token estimate with digit floor, split before send, never truncate evidence, up to 16 concurrent
   batches under one deadline, HTTP 429 `retry-after` honored only when it fits the deadline, no retry otherwise.
6. **Budget.** Spend flows through `BudgetTracker` (new `BudgetKind` `'decide'`) and `recordOnTracker`; pricing in
   the model price table. `decide.budget.daily_usd` (default 1.00) caps third-party decide spend per brain per day;
   over cap, slots behave as if the provider failed (fail direction per slot).
7. **Decision receipts.** New table `decision_receipts` (schema migration). Row: `id, decision_id, created_at, source_id, slot,
   mode, provider, model_alias, model_resolved, question_kind, state_hash, question_hash, answer_value (real),
   answer_choice (text), confidence, threshold, outcome (one value from the canonical outcome table in `src/core/ai/decide/`; shadow rows record the would-be outcome
   and `mode` says shadow), subject_ref (HMAC of page slug / fact id / transcript path, never plaintext), call_site, lane,
   policy_fingerprint, latency_ms, input_tokens,
   error_reason, protected, min_keep, rank, k_used` (`decision_id` groups all rows of one logical decision; `protected` marks
   identity-evidence or floor-protected items so threshold what-ifs can be recomputed exactly). No query, prompt, page or transcript text is stored; hashes are HMAC-SHA256 with a per-brain salt
   so they are joinable for calibration but not dictionary-reversible. Retention `decide.receipts.retention_days`
   (default 7), pruned by the cycle's existing `purge` phase. Writes are batched and fire-and-forget off the hot path.
8. **Calibrations.** New table `decide_calibrations`: `slot, provider, model_resolved, threshold, min_keep, metric,
   metric_value, ece, retest_sd, repack_sd, action_precision_lb, n, dataset_hash, split_hash, calibrate_ids_hash, calibrate_only, pack_shape,
   call_site, created_at, notes`. `on` mode reads the newest row for (slot, provider,
   model_resolved). `decide.slots.<slot>.threshold` overrides it explicitly.
9. **Egress gate.** `policy.ts` refuses to place private content into a third-party request: pages whose visibility
   resolves private (reusing `private-visibility.ts` predicates, including #5525 derived-page fail-closed), sources
   in `decide.egress.deny_sources`, and conversation text (transcripts, prompts) unless `decide.egress.private=allow`.
   Refused items are decided by `decide.egress_fallback` if configured, else take the slot's fail direction. The
   `llm:` provider follows today's chat egress rules (it is a provider the operator already sends this data to).
10. **Trust.** `decide` is not an MCP operation. Remote callers can trigger slots only through existing ops
    (`query`, `think`); `calibrate`, receipts review and proposal acceptance are local-CLI only.

### Owner decision: on/off (2026-09-30)

Garry, after reviewing the ELI10: "we should just have on and off as the main things and shadow doesn't have to be
recommended." This overrides every earlier statement in this document that presents shadow as the default,
recommended or first step:

- The user-facing model is two states per slot: `off` (today's behavior) and `on` (GBrain acts on the decision).
  `gbrain decide enable <slot>` turns a slot on; `disable` turns it off. `enable --recommended` turns on the slots
  with a recorded win and a passing reference calibration.
- `shadow` stays as an advanced diagnostics mode (`enable --shadow`, `mode shadow`), documented only under an
  "Advanced diagnostics" heading in the operator guide. No doc, readiness string, doctor hint or quickstart step
  recommends it, and nothing requires passing through it.
- Everywhere the plan says a slot "demotes to shadow" (model drift, policy-fingerprint change, missing calibration
  for an alias), read: the call runs with off behavior (today's path), writes a receipt with the reason, and
  `decide status` / doctor show `on (inactive: <reason>)` plus the one command that fixes it.
- Slots that cannot pass the action-precision gate (likely S4, S8) ship as available-but-not-recommended: `enable`
  refuses with the catalogued reason unless `force_on` is set; they are not "shadow-only".
- Readiness strings: `off`, `ready for on`, `on`, `on (inactive: <reason>)`, `needs calibration`.

**Update (2026-10-01): key-aware defaults.** After the eval verdicts, Garry: "turn on by default anything that is
positive and leave off by default anything that doesn't work. (If you have jev key installed obviously, otherwise all
off)." This amends "all default off" for the measured winners only:

- With a TypeSafe key present (`TYPESAFE_API_KEY` or `JEV_TYPESAFE_API_KEY`, shell or `~/.gbrain/.env`) and no
  explicit setting, S7 `triage` and S9 `conflict` default to `on` with `typesafe:jev-1.13.0` and their shipped
  reference calibrations. The set is derived from the reference-calibration rows (`recommendedSlots`: verdict win
  and a passing gate), the same function `enable --recommended` uses. Every other slot stays default `off`.
- Without a key, everything is off and all-off output is byte-identical.
- For those two slots, key presence is the egress opt-in for the data they send (conversation text for S7, facts for
  S9), as a documented default; nothing is written to config. Private-page and derived-page rules and
  `deny_sources` are unchanged, and the defaults never send pages.
- Explicit settings win: the slot's mode or provider, `decide.provider none`, an explicit
  `decide.egress.private deny`, a `deny` on the slot's consent key, `gbrain decide disable <slot>|--all`. Eval runs
  never use the defaults.
- `decide status` and doctor `decide_health` show `on (default: Jev key present)` and name the opt-out.

### Config surface (all default off; see the 2026-10-01 key-aware defaults above)

```
decide.provider              none | typesafe:jev-1.13.0 | llm:<provider:model>
decide.egress_fallback       none | llm:<provider:model>   (egress-refused items only)
decide.slots.<slot>.provider (inherits decide.provider)
decide.max_concurrency       16
decide.margin_floor          0.05
decide.slots.<slot>.force_on false  (explicit bypass of the action-precision gate; doctor always lists it)
decide.timeout_ms            1500 (query path), dream/facts paths use their own phase budgets
decide.budget.daily_usd      1.00
decide.egress.private        deny | allow
decide.egress.deny_sources   []            (source ids)
decide.receipts.retention_days 7
decide.slots.<slot>.mode     off | on   (advanced: shadow, diagnostics only, never recommended)
decide.slots.<slot>.threshold  (optional override; else calibration)
decide.slots.<slot>.min_keep   (slot-specific, where applicable)
decide.slots.conflict.proposal_floor  0.50
decide.calibrate.retest_n    50  (items re-asked 3 times to measure retest_sd and repack_sd)
decide.slots.<slot>.min_action_precision  0.90  (harmful-direction slots)
decide.slots.<slot>.shadow_sample  1.0
decide.slots.<slot>.shadow_wait    off  (on: await shadow under on deadlines)
decide.slots.intent.wait_ms  150   (2026-09-30: default raised to 250; 39% of live Jev intent answers arrived after 150 ms, 3% after 250 ms, see docs/eval/system-one/)
decide.slots.recall_needed.suppress_below  0.05   (2026-09-30: default raised to 0.10; with the 0.05 margin floor, 0.05 could never suppress)
decide.egress.typesafe.<class>  deny | allow  (class: query, candidates, facts, conversation; written by
                             `decide enable` after it shows what leaves the machine)
(receipt HMAC salt: 32 random bytes generated on first receipt write, stored in the brain config table under an
 internal key that `gbrain config get/list` never prints)
```

Slots: `rerank`, `intent`, `evidence`, `answerable`, `injection`, `recall_needed`, `triage`, `grounding`, `conflict`.
The `judge` harness (below) is eval-only and has no runtime slot.

### Slots

**S1 `rerank` (search reranker).** Land #5178's adapter on the decide core: `search.reranker.model
typesafe:jev-1.13.0` keeps working exactly as #5178 documents (four-level Score, normalized 0..1, stable ties,
fail-open to RRF order through `applyReranker`). Adds the resolved-model check, receipts in shadow/on, and
`rerank.model_resolved` in search meta. Voyage stays the default. Credit dsandrade in the PR body and CHANGELOG;
#5178 is closed as superseded only after this PR merges.
*Eval:* LongMemEval top-5 complete retrieval (compendium baseline 449/470; re-measured at the pinned commit) and R@1, PrecisionMemBench, Voyage vs Jev on the
same pools; p50/p95 rerank latency; cost per query.

**S2 `intent` (query routing).** S2 asks one `choice` question per call site, state = the query. Search: `entity | temporal | event | concept |
general` (the existing `QueryIntent`), launched at the start of `hybrid/request.ts` under a short wait bound; in `on`
mode an above-threshold label replaces the intent that `classifyQueryWithBrainPatterns` returns, which drives the
existing intent weights and detail level. Think: `temporal | knowledge_update | other`, replacing `classifyIntent()`
(which gates trajectory injection). Arms keep their own detectors; S2 never forces an arm. Below-threshold
confidence falls back to the regex classifiers, which stay the default and the tie source.
*Eval:* labelled intent set built from LongMemEval `question_type` (temporal-reasoning, knowledge-update,
multi-session) plus BrainBench relational cases; routing accuracy vs regex; downstream LongMemEval answer accuracy.

**S3 `evidence` (evidence gate).** After fusion and rerank, one packed request: state = query, one `noul` per
candidate ("does `candidate` contain evidence that helps answer `query`?"). Candidates under threshold are pruned,
subject to: never below `min_keep` (default 3), never prune a result the canonical protection predicate protects
(identity evidence `alias_hit`, `exact_lookup`, `exact_title_match`, and `relational_pinned` graph answers), never reorder (S5 is the only post-rerank slot that reorders). When on, `crag.ts` gains a `decide_evidence` grade input
(strong when the top kept candidate clears threshold). The same packed request carries the S5 questions; S4 is a
separate request made concurrently (see S4).
*Eval:* LongMemEval top-5 complete retrieval must not drop; injected-token reduction; PrecisionMemBench precision.

**S4 `answerable` (abstention).** Two call sites. For the `query` op it is its own request, launched concurrently with the S3/S5
packed request and never co-packed with candidate questions: one `noul` over the pre-S3 top-k candidates (k = min(10, candidate count), shrunk until state plus the question fits 32k; `k_used`
is recorded; fail open if k=1 overflows; not asked with zero candidates). For the `query` op the result is diagnostic only
(`meta.answerability`); no abstention happens there. For `think` it is one separate call over think's final gathered
evidence (same k rule), made after gather and before synthesis. `query` returns `meta.answerability { p, threshold, verdict }` in shadow and on.
In `on` mode `think` abstains below threshold only when a deterministic signal agrees (no identity-evidence hit
and no strong CRAG grade): it answers that the brain has no evidence for this, lists the nearest
pages it did find, and skips the synthesis call.
*Eval:* LongMemEval answer accuracy including the abstention questions (compendium baseline 433/500; re-measured), abstention precision
and recall, synthesis calls saved.

**S5 `injection` (signal only).** In the same packed request: one `noul` per candidate ("does `candidate` contain
instructions aimed at an AI agent?"). Stamped on results as `injection_p`. In `on` mode, candidates over threshold
are moved below clean candidates of the same `classifyEvidence` class (never below the S3 `min_keep` cut) and wrapped with the existing untrusted-content framing in
`think`. It never drops content and never gates writes.
*Eval:* retrieval-quality injected-instruction fixtures (from #5178's known cases) and a no-regression check on
LongMemEval.

**S6 `recall_needed` (know-to-ask).** In serve's turn-context handler (`src/core/context/turn-context.ts`), which
answers the engine-free `hook user-prompt` over IPC, alongside reflex resolution: state = the user
prompt plus the last turn, one `noul` ("does answering this need the user's stored memory?"). `on` mode: fire retrieval when the reflex
rules would not have (lowercase names, surnames, indirect references), and suppress reflex injection when p is
very low and no exact alias hit exists. Firing retrieval runs the one `search`-mode query defined in the accepted CEO
requirements, with the user prompt as the query. S6 runs concurrently with reflex resolution inside the
400 ms server budget (`TURN_CONTEXT_SERVER_BUDGET_MS`) with its own deadline of at most 250 ms; fire/suppress is
applied after both finish, and on timeout the reflex result stands unchanged. Requires `decide.egress.private=allow` for the Jev provider because it sends prompts.
*Eval:* BrainBench `know-to-ask` failure rate, `false_fire_rate`, `avg_injected_tokens`, per harness adapter.

**S7 `triage` (dream triage).** Split each transcript into turn windows (whole turns, about 1,500 characters,
never sentences, so judgments keep conversational context), then one request per window (unpacked, paced under the
concurrency cap): one `noul` per window ("does `window` contain synthesis-worthy content: a decision, commitment, new fact about a person or
project, an idea, or a reflection, rather than routine chatter or tooling?"). Transcript score = max window p, so
a single buried signal passes by design; the top windows become the triage segment map `synthesize` already
consumes. `passesTriageGate` stays the ONE gate; it reads the decide verdict when the slot is on and keeps the
rescue band for the LLM path. `TRIAGE_VERSION` is not bumped: the decide provider and resolved model join the
triage cache identity only when S7 is on, so upgrading with S7 off re-triages nothing. The synthesizer still reads
full transcripts; triage never compacts content. Requires `decide.egress.private=allow` for Jev.
*Eval:* the Cat 35 triage corpus (buried-signal misses must reach 0), synthesis precision (pages written that the
judge accepts), cost per transcript (target at least 50% lower than the current triage model), wall time.

**S8 `grounding` (claim support).** In `synthesize-verify.ts`, after the mechanical checks: for each new claim unit
that passes today only because it contains no quote, number or attribution, gather up to three candidate source turn
windows (normalized-substring, keyword and embedding neighbours) and ask one `noul` ("is `claim` supported by
`sources`?"); weak coverage records `insufficient_context` instead of quarantining.
Below threshold, the unit goes to the existing quarantine lane with reason `unsupported_paraphrase`. This slot only
adds a check; it can never admit a unit the mechanical checks rejected.
*Eval:* grounding rate on dream pages from the Cat 35 corpus, quarantine precision on a hand-labelled sample,
false-quarantine rate.

**S9 `conflict` (hot-memory contradiction).** The fact write path stays zero-LLM and unchanged. S9 is an async
sweep over facts written since its last run, executed as a tail step of the existing `extract_facts` cycle phase
only when the slot is not off (so the phase list and all-off output are unchanged), and on demand with
`gbrain decide sweep --slot conflict`. For each new fact it takes the `findCandidateDuplicates` neighbours (k=5)
with cosine at least 0.80 that pass the same guards `decideSingleFact` applies (same source, entity and
visibility, active, and a candidate `source_markdown_slug`, when set, equal to the new fact's `entity_slug`) and sends one packed request: state = the new fact, one `choice` per
candidate (`duplicate | supersede | independent`).
Sweep outcomes, the proposal rule and the `decide_proposals` table follow the accepted CEO requirements: v1
never supersedes automatically, the new fact stays as written, and `gbrain decide proposals accept <id>` applies it through the existing supersede write path (local CLI
only). Requires `decide.egress.private=allow` for Jev when facts come from conversations.
*Eval:* a labelled contradiction probe set (the hot-memory classifier fixtures plus the suspected-contradictions
probes): agreement with labels versus today's cosine rule, contradictions found that the cosine rule misses,
wrong-supersede rate (must not rise), cost per swept fact.

**Judge harness (eval-only).** `gbrain decide judge-agreement --suite <suite>` runs Jev as a judge (groundedness,
coverage) beside the existing LLM judge on a labelled set and reports Cohen's kappa. No runtime substitution in v1.

### CLI, doctor and ops

New CLI-only command `gbrain decide` (`src/commands/decide.ts`, dispatch in `src/cli/commands/decide.ts`,
`CLI_COMMANDS` record, post-connect):

- `gbrain decide status [--json]`: provider, resolved model, egress settings, each slot's mode, calibration row
  and effective threshold, 24-hour receipt counts, error rate and spend.
- `gbrain decide probe [--query <q>]`: works with only a key (pinned default provider); one tiny live request that
  prints resolved model, latency, cost and the next command to run; sends no brain content unless `--query` is given,
  which previews S1 and S3 on one query of your brain after the egress summary and confirmation, changing nothing.
- `gbrain decide enable <slot>` (turns the slot on; advanced `--shadow` for a diagnostics-only dry run),
  `gbrain decide enable --recommended`, and
  `gbrain decide disable <slot>|--all`: write every key the slot needs (pinned provider, consent keys, mode) in one
  confirmed step after a plain summary of what data leaves the machine and the estimated cost, then print the
  requested versus effective mode.
- `gbrain decide calibrate --slot <slot> --dataset <jsonl> [--target precision|recall|f1] [--min <x>]`: runs the
  slot's questions over a labelled dataset, picks the threshold, prints a reliability table and ECE, stores a
  `decide_calibrations` row. `--dry-run` estimates cost first; `--call-site <site>` selects the call site (default:
  the slot's only site).
- `gbrain decide qualify --slot <slot> [--call-site <site>] --dataset <jsonl>`: evaluates the newest calibration on
  the eval half, stores `action_precision_lb` and per-slice results as its qualification, and prints the exact
  activation command or the catalogued refusal reason.
- `gbrain decide dataset --slot <slot> --from <longmemeval|brainbench|cat35|facts-fixtures|injection-fixtures|know-to-ask|grounding-labels> <path>`: builds the
  labelled datasets the calibrations and evals use.
- `gbrain decide receipts [--slot] [--since]`: aggregate stats only (counts, outcome mix, p distribution, latency).
- `gbrain decide proposals [list|accept|reject]` for S9.
- `gbrain decide judge-agreement --suite <suite>`: the eval-only judge harness.

Doctor check `decide_health` (new topic module `src/commands/doctor/checks/decide.ts`): key present when a Jev
provider is set; alias in use; slots `on` without calibration; calibration model differs from recently resolved
model (drift); 24-hour error rate over 5%; daily budget exhausted; egress denials counted.

Eval integration: `gbrain eval longmemeval`, `eval brainbench` and `eval retrieval-quality` accept
`--decide <slot>=<mode>` (repeatable) so matched runs differ only in the slot under test.

### Migrations

- Schema migration `v179-decision-receipts` (via `bun run new:migration decision_receipts`): `decision_receipts`
  with indexes on `(slot, created_at)` and `(model_resolved, slot)`, plus fresh-install DDL in `src/schema.sql`
  (and the PGLite fragment its banner names). Regenerate registry, schema blobs and goldens.
- Schema migration `v180-decide-calibrations`: `decide_calibrations` (columns as in Architecture item 8, including
  `retest_sd` and `split_hash`) with index on `(slot, provider, model_resolved, created_at desc)`.
- Schema migration `v181-decide-proposals`: `decide_proposals` for S9 pending supersedes, with index on
  `(status, created_at)`.
- No data backfill. No config migration: all keys are new and default off.
- Agent upgrade note `skills/migrations/v0.60.<patch>.md`: nothing changes until the operator opts in; how to try
  `gbrain decide enable --recommended`; where the docs live.

### Docs

- `docs/ai-providers/typesafe.md`: key setup (`TYPESAFE_API_KEY`, `JEV_TYPESAFE_API_KEY` alias), pinned vs alias
  models, reranker setup (carried from #5178), pricing, limits, data handling, what never leaves the machine.
- `docs/guides/system-one.md`: the operator guide. What each slot does in plain words, the off → on switch backed by bundled reference
  calibrations (own-dataset calibration as the advanced path; shadow documented only under Advanced diagnostics) with exact commands, `decide enable --recommended`, fail directions, egress rules, reading `decide status` and doctor output, "say to your
  agent" prompts, and troubleshooting.
- `docs/architecture/decide.md`: the capability contract (API, providers, packing, receipts, calibration, drift,
  egress, trust) for contributors adding a slot, with a "how to add a slot" checklist.
- `docs/eval/system-one/`: per-slot eval protocol, frozen inputs, receipts and verdicts.
- KEY_FILES entries for every new module; `docs/TOOL_CATALOG.md` if CLI tables are listed there; `llms.txt` and
  `llms-full.txt` regenerated; CHANGELOG entry.

### Tests

- Unit: pack planner budgets and split, answer parsers for all three types, mixed-model rejection, egress gate
  (private page, derived page, denied source, conversation text), threshold resolution precedence and drift
  demotion, each slot's pure decision function with fixture answers, fail directions on timeout/429/5xx/budget.
- PGLite integration: each slot wired through its real call site with a fixture transport (search stages, think
  abstention, serve turn-context for hook user-prompt, dream triage, synthesize-verify, S9 sweep in the `extract_facts` tail and `decide sweep`), receipts written with no text.
- Goldens: all-slots-off output byte-identical; migrations and schema catalog goldens; doctor registry and JSON
  goldens; CLI goldens.
- E2E: migrations on Postgres and PgBouncer; `decide_health` on both engines.
- Live (opt-in, keyed): `test/live/decide-typesafe.live.test.ts` runs the probe and one packed request.

### Evals and verdicts

Paid budget for this PR's measured runs: at most $40 total (Jev spend is cents; the cost is LLM judge and
synthesis calls in LongMemEval and dream evals). Runs go to Ubicloud. Each measured slot gets a matched pair (same commit,
same data, same seed, only the slot mode differs), recorded with raw receipts in `docs/eval/system-one/`, and a
one-line verdict. Slot order for measurement follows expected value: S7 triage, S1 rerank, S3/S4 evidence and
abstention, S6 recall_needed, S9 conflict, S2 intent, S8 grounding, S5 injection.

### Delivery

One PR on branch `feat/system-one-v1`. Build order: foundation lane first (decide core, recipe, migrations,
receipts, calibrations, policy, CLI skeleton, doctor), then parallel lanes on top of it: retrieval (S1-S5), write
path (S7-S9), context (S6), then evals and docs. Lanes integrate into the one branch with reviewable commits.
Coordinate with active threads before touching shared files: GBRA-25 (fix wave 4), GBRA-31 (merge train owner),
GBRA-27 (evals). Version: next free PATCH at ship time.

### Out of scope (v1)

Default flips; fact typing (C4), entity identity merges (C5), untrusted-stub review ordering (C6), link-candidate
scoring (C7), take grading (C8), write-gate trust tiers (C9, belongs to #5575), adaptive stopping (A6), expansion
decision (A5) as a runtime slot (v1 measures expansion only as an arm of the recall experiment), chunking and pre-extraction compaction (measured poor fit), skill routing (D2), any use of Jev as a
security boundary.

### Risks

- Single closed vendor: the `llm:` provider makes every slot work without Jev, but its answers are uncalibrated
  until qualified; v1 qualifies one local `llm:` configuration on S7 for quality and latency. Private brains that
  keep egress denied effectively run S6-S9 as LLM slots.
- Calibration drift when TypeSafe ships a new version: pinned ids, receipts, drift falls back to off behavior per call.
- Over-pruning: min-keep floors, identity-evidence protection, calibrated thresholds, an action-precision gate before `on`.
- Adversarial flipping: signal-only use; deterministic floors win.
- Hot-path latency: intent waits at most 150 ms; with S1 on Jev and any of S3-S5 on, the query path
  makes two serial Jev stages (rerank, then the S3/S5 packed request with the S4 request concurrently), each
  deadline-bound and failing open.
- Egress from a private brain: explicit `decide.egress.private`, private pages never sent by default.
- Rate limits are account-wide and "adjusting dynamically": bounded concurrency, deadline-bound retry, fail open.


<!-- autoplan-accepted:ceo -->
- Rerank depth: no new key. The S1 eval reuses the existing `search.reranker.top_n_in` and treats the recall
  benefit as a hypothesis: first measure fused-pool recall (target present at fused depth 30, 50 and 100 on the
  GBRA-4 and LongMemEval queries), then R@1/R@5 with Jev at `top_n_in` 30, 50 and 100 on the same queries. The eval
  runs with `limit 50` (per-arm `innerLimit` reaches its 100 cap) and an explicit `top_n_in`, so a fused pool of 100
  is reachable; deeper production candidate generation is out of scope (the recall experiment measures a deep
  pool in evals only). Results go in `docs/eval/system-one/`. A unit test
  asserts `top_n_in` bounds the candidates sent to Jev.
- S1 mode contract (the rerank exception to success criterion (c), because a reranker has no threshold): provider
  selection stays `search.reranker.model` exactly as #5178 documents, and S1 `on` uses today's reranker egress
  contract (candidate text goes to the configured reranker, as with Voyage). `decide.slots.rerank.mode off` writes
  no receipts. `shadow` with a non-Jev reranker (Voyage or none): Jev also scores the same `top_n_in` candidates in
  parallel under the rerank deadline, through the decide egress gate, using the TypeSafe key whatever
  `decide.provider` says (no key: skipped with reason `no_key`); receipts record Jev's order plus rank agreement
  (top-1 match, Kendall tau) and results do not change. `shadow` with the Jev reranker behaves as `on`. `on`
  requires `search.reranker.model typesafe:*` and adds receipts and the resolved-model check; `on` without it
  behaves as `off` and doctor warns. There is no calibration row and no drift demotion for rerank; a resolved model
  different from the pinned id is recorded, mixed ids within one decision fail it open, and doctor warns.
- Decision stability (live probe 2026-09-30: identical requests returned 0.53 then 0.51, and 0.74 then 0.62;
  re-packing moved one answer between 0.51 and 0.81): `gbrain decide calibrate` repeats each item 3 times on a
  sample of `decide.calibrate.retest_n` items (default 50), stores `retest_sd` and prints it. Every
  harmful-direction decision (S3 prune, S4 abstain, S6 suppress, S7 fail, S8 quarantine) whose answer lies within
  `max(0.05, 2 * retest_sd)` of the threshold on the harmful side takes the no-change outcome and is recorded as
  `margin_hold`. With an operator threshold and no calibration row, `retest_sd` is 0 (margin 0.05). For S7 the
  no-change outcome is today's LLM triage for that transcript when configured, else pass. S9's near-threshold band
  is its proposal band (below), not `margin_hold`. The pack planner orders questions by candidate rank, then id.
  The packing shape (max questions per batch, question order rule, state template version) is stored in the
  `pack_shape` column of `decide_calibrations` together with the set of slots co-packed in the same request.
  Calibrations are keyed by (slot, call site, provider, model), where the call site distinguishes, for example, S4
  in the `query` op from S4 in `think`, and S2's search question from its think question. Calibration,
  evals and production use the same shape, and `on` refuses a calibration whose `pack_shape` differs and falls back
  to shadow. Each slot's eval reports a decision
  flip rate from running the Jev side twice. Unit tests cover the margin band, `retest_sd` and the shape check.
- Context sensitivity and action safety: `decide calibrate` also re-asks the sampled items with resampled
  co-packed neighbours (3 draws) and stores `repack_sd`; the margin becomes `max(0.05, 2 * max(retest_sd,
  repack_sd))`. S7 windows and S8 units are asked one question per request (background paths, paced under the
  concurrency cap), and S4 is always its own request; S3 stays packed on the hot path with the repack margin. A
  harmful-direction slot (S3, S4, S6 suppress, S7 reject, S8 quarantine) may run `on` only when its calibration's
  `action_precision_lb` (Wilson 95% lower bound of the harmful action's precision on the eval half, reported per
  workload slice) is at least `decide.slots.<slot>.min_action_precision` (default 0.90); otherwise `on` refuses
  with a named reason and the slot stays shadow. S3/S4 evals include injected-neighbour fixtures (an instruction
  candidate co-packed with real evidence) and must show no rise in real-evidence pruning or abstention.
- Thresholds on typed answers: `noul` slots threshold the probability; `choice` slots (S2, S9) threshold
  `probabilities[chosen label]`; S1's `score` is normalized 0..1 and has no threshold. `answer_value` stores exactly
  the thresholded number, `answer_choice` the label, and `retest_sd` is computed on the same number. `min_keep`
  precedence: config override, then the calibration row, then the slot default.
- Calibration lookup: before the call, `on` reads the newest row for (slot, provider, configured pinned model id);
  with an alias configured it uses the model id most recently resolved in receipts. After the response, a
  different resolved id demotes that call to shadow. An operator threshold override is never demoted; doctor lists
  it as an uncalibrated override.
- Calibration holdout: `gbrain decide dataset` writes a frozen calibrate/eval split for every dataset (default
  50/50 by a stable hash of the item id) and records its `split_hash`. `decide calibrate` reads only the calibrate
  half and stores `split_hash`, `calibrate_ids_hash` and `calibrate_only = true`. Eval runs with `--decide` refuse
  (non-zero exit, named reason) any calibration whose `split_hash` differs from the eval split or whose
  `calibrate_only` is false. Tested with a mismatched-split fixture.
- Datasets for every slot: `decide dataset --from` also accepts `injection-fixtures` (S5, from #5178's known cases
  and the retrieval-quality injected cases), `know-to-ask` (S6, BrainBench) and `grounding-labels` (S8). The S8
  label set is a hand-labelled sample of at least 200 claim units from Cat 35 dream pages, committed under
  `docs/eval/system-one/` with generic placeholders only.
- S9 sweep scope: a per-source watermark (last swept fact id) lives under an internal config key. The first run
  starts at the current maximum fact id unless `gbrain decide sweep --slot conflict --since <fact id>` is given, so
  enabling the slot never sweeps the whole history silently. Facts with no embedding or no `entity_slug` are
  skipped with a receipt reason (`no_embedding`, `no_entity`). Candidate guards quote `decideSingleFact`: same
  source, entity and visibility, active and not expired, and a candidate `source_markdown_slug` (when set) equal to
  the new fact's `entity_slug`.
- S9 sweep outcomes (proposal-only in v1): one `choice` per candidate. Any `duplicate` at or above threshold marks
  the pair a duplicate (receipt only; the write path already handles exact and near duplicates). Otherwise a
  `supersede` at or above `proposal_floor` becomes a pending proposal, in `on` mode only; v1 never supersedes
  automatically, because similarity plus a probability does not establish which claim is newer or more credible.
  The new fact stays as written. Everything else is independent. In shadow, receipts only. Proposals live in a new
  table `decide_proposals` (`id, created_at, source_id, new_fact_id, old_fact_id, p_supersede, threshold,
  proposal_floor, model_resolved, status pending|accepted|rejected|stale, decided_at`), never pruned by receipt
  retention. `gbrain decide proposals accept <id>` rechecks that both facts are still active and share source,
  entity and visibility (else marks `stale`), then supersedes old with new through `expireSuperseded` in
  `src/core/facts/write-single.ts`, exported for this use, which sets `superseded_by` and strikes the old line in
  the page's `## Facts` fence; `reject` marks it rejected; accepted proposals are reversible with the existing
  fact restore path, named in the guide. Local CLI only. Tests cover each branch, accept/reject/stale, and that
  neither the sweep nor the inline fact write path supersedes anything without an accept.
- S3 and S4 pipeline position: S3 runs inside `sizeReturnPool` (`hybrid/rank.ts`) between `stampEvidence` and
  adaptive return, and at the equivalent point of the keyword-only path (`hybrid/keyword-only.ts`); "pre-S3" is the
  S4 query-op candidate set. S3 also applies inside `think`'s gather searches (which disable autocut on purpose).
  First-pass bound: the `query` path makes at most two serial decide stages (rerank, then the S3/S5 packed request
  with the S4 request concurrently).
  A `crag_escalation` re-run adds its own rerank call and runs S2-S5 as off on its new candidates (unjudged
  candidates are kept, fail open). `search.crag_think` is outside this bound: it runs `think`, whose decide calls
  are one S2 think question, one S3 request per gather leg and one S4 call.
- S2 call sites: the search question is launched at the start of `hybridSearch` (`hybrid/request.ts`) alongside the
  regex classifier and awaited for at most `decide.slots.intent.wait_ms` (default 150 ms) before detail, weights and
  search options are derived; a late or below-threshold answer uses the regex label (outcome `fallback_regex`), an
  override re-derives detail, weights and options through the same function the regex path uses (outcome
  `override`). `think` asks its question once before gather and passes one precomputed search answer to both
  gather legs. Each question has its own calibration row (call site `search` or `think`).
- S6 details: "fire retrieval" runs one `search`-mode hybrid query (no expansion, limit 3) with the user prompt and
  adds its top results as pointers in the reflex window; it runs only if at least 150 ms of the 400 ms server
  budget remain after S6 (S6 itself at most 250 ms, concurrent with reflex). Suppression requires p below
  `decide.slots.recall_needed.suppress_below` (default 0.05) and no exact alias hit. Pack and delta modes are
  unchanged; S6 only changes the reflex window.
- S7 verdict mapping: for Jev verdicts the segment map is the top windows (at most eight), each quote the first 300
  characters of its window cut at a turn boundary; `entities` come from the existing deterministic entity-mention
  extraction run over those windows; `content_type` comes from one extra `choice` request per transcript over
  the existing content-type labels.
- S5 marking: `think` already wraps all retrieved content as untrusted; S5 `on` adds an `injection_suspected` line
  to that candidate's wrapper and demotes it as above.
- Receipt outcomes per slot: S1 `kept`; S2 `override` or `fallback_regex`; S3 `kept`, `pruned` or `margin_hold`;
  S4 `pass`, `abstain` or `margin_hold`; S5 `demoted` or `kept`; S6 `fire`, `no_fire`, `suppress` or
  `margin_hold`; S7 `pass`, `reject` or `margin_hold`; S8 `pass`, `quarantine`, `insufficient_context` or `margin_hold`; S9 `duplicate`,
  `proposal` or `independent`; any slot `error` or `skipped` (with a reason such as `egress`,
  `no_key`, `no_embedding`, `no_entity`, `late`). The migration's check constraint lists exactly these values.
- Shadow latency: on hot paths (S1 shadow, S2-S6) shadow runs asynchronously by default, sampled by
  `decide.slots.<slot>.shadow_sample` (default 1.0), writes receipts only and adds no meta or explain lines, so it
  adds no user latency. `decide.slots.<slot>.shadow_wait on` awaits shadow under the `on` deadlines and adds the
  diagnostics, for operators who want to measure the true latency cost; the guide states that cost.
- Eval runners: S1-S5 use `eval longmemeval`, `eval brainbench` and `eval retrieval-quality` with `--decide`; S9
  uses `eval suspected-contradictions --decide conflict=on`; S7 and S8 matched pairs, and PrecisionMemBench, run in
  the sibling gbrain-evals harnesses through an eval-only environment override `GBRAIN_DECIDE_SLOTS`
  (for example `triage=on`), which is logged in every receipt's run metadata and honored only as the
  `GBRAIN_DECIDE_SLOTS` item below states.
- Search cache: decide knobs (each non-off slot's mode, effective threshold, `min_keep` and calibration row id) join `knobsHash`
  as an append-only part emitted only when some slot is not off, so the all-off golden stays byte-identical. On a
  cache hit, shadow slots make no call and write no receipt; the operator guide says so.
- Budget: the per-brain daily figure is computed from `decision_receipts` (sum of `input_tokens` times the priced
  rate for the current UTC day, third-party providers only), cached per process for at most 60 s; it covers S2-S9
  and S1 shadow. Jev spend under S1 `on` is recorded as `BudgetKind` `rerank` and governed by today's reranker spend
  controls. `llm:` provider spend is recorded once, by `chat()`, as kind `chat` with purpose `decide:<slot>`, and
  stays under the existing chat spend controls. Pending receipts flush at CLI exit with a 500 ms bound. The daily
  cap is soft (batched receipts and the 60 s cache let concurrent processes overshoot slightly; docs say so), and
  decide spend is still recorded on `BudgetTracker` as kind `decide` for per-process accounting.
- Fallback triggers: only egress-refused items go to `decide.fallback`; timeout, 429, 5xx and an exhausted budget
  take the slot's fail direction directly. Fallback-answered items form their own sub-decision with their own
  `decision_id`, provider, model and threshold lookup, so the mixed-model rule applies per sub-decision. An `on`
  slot whose fallback has no calibration treats those items as shadow.
- Egress consent contract (one rule for every path): a provider receives a data class (query text, candidate page
  text, fact text, conversation text) only with consent for that provider. For decide slots, consent is the
  `decide.egress.typesafe.<class>` keys that `gbrain decide enable` writes after showing exactly what leaves the
  machine; the `llm:` provider inherits today's chat consent. For S1 `on`, configuring `search.reranker.model
  typesafe:*` is the consent for query and candidate text, as it is for Voyage today, and `decide status` shows it.
  S1 shadow and every fallback use the decide consent keys. `decide.egress.deny_sources` applies to every provider
  and path. Private content is never sent without `decide.egress.private=allow`: page candidates are checked by one
  batched query per decision on `(source_id, slug)` using `privatePagesFilterFragment` (which carries the #5525
  derived-origin rule), and facts on `facts.visibility` (default private) and their provenance page. Unit and PGLite
  tests cover private, derived-private, multi-source private, private-fact, denied-source and missing-consent
  cases.
- Eval validity: when `eval longmemeval` runs any `--decide` arm, both arms route with production text-only
  classifiers (the regex path in the baseline, S2 in the intent arm); the dataset's `question_type` labels are used
  only for scoring. `--decide answerable=on` makes the harness reader abstain below threshold, scored on the
  abstention questions. Calibrate/eval splits are made by independent family (conversation, transcript or fixture
  family), keeping related claims and turns together. Timeouts count as failures in every effectiveness number.
- Recall experiment (both CEO voices): the S1 eval compares, on the same queries and under one latency and cost
  budget, (a) today's pipeline, (b) Jev rerank at `top_n_in` 100, (c) a deep fused pool of 300 candidates reranked
  by Jev, and (d) the existing query expansion plus Jev rerank, reporting pool recall, R@1/R@5, answer accuracy,
  p95 latency and cost. The deep pool is an eval-only path (an eval flag that lifts the per-arm cap for that run);
  production candidate depth is unchanged in v1, and a win is recorded as the case for a follow-up. The run also
  reports Jev's top-1 rate on present targets to replicate or refute GBRA-4's 134/134, and a large shortfall
  reorders the remaining measurement plan.
- Reference calibrations and a recommended configuration (both CEO voices): the maintainer's eval runs produce
  reference calibration rows (per slot, call site, model and `pack_shape`, with dataset and split hashes), shipped
  in the binary as a static table and used when a brain has no local row; a local row always wins. `gbrain decide
  enable --recommended` enables exactly the slots whose recorded verdict is a win and whose reference calibration
  passes `min_action_precision`, after showing the egress summary. A reserved share of the eval budget (at most
  $10 of the $40) runs that recommended configuration end to end (answer quality, retained useful memory, full
  dream-cycle cost, p95/p99 latency, harmful outcomes); it must win for `--recommended` to ship non-empty, and
  per-slot ablations explain the result.
- Local `llm:` qualification: one local configuration (an Ollama chat model through `llm:<provider:model>`) is
  measured on S7 against Jev and against today's triage model for quality and latency, so the vendor-independence
  claim is backed by a number; results go in `docs/eval/system-one/`.
- Deadline realism: the evals and a local load test report deadline success rate and p95/p99 per hot-path slot
  (S2 within its 150 ms wait, S6 within 250 ms, the S3/S4/S5 stage within `decide.timeout_ms`) at realistic
  concurrency. S6 never delays the reflex block: the turn-context response is assembled from reflex results when
  S6 has not finished, so the 400 ms IPC budget can never null the block because of S6.
- S8 evidence coverage: S8 gathers up to three candidate source windows per claim (substring, keyword and
  embedding neighbours) and asks one question over all of them. A low answer with weak retrieval coverage (no
  window above the keyword floor) is recorded as `insufficient_context` and keeps today's mechanical result; only
  a low answer with adequate coverage quarantines as `unsupported_paraphrase`. The S8 eval reports
  source-selection recall separately from Jev's judgment and counts useful claims lost.
- Pinned-model retirement: a 404 or "model unavailable" for a pinned id is a provider failure (fail direction
  applies), surfaced by doctor as a named error with the recovery step (repin, then recalibrate or use a
  reference calibration for the new id).
- `GBRAIN_DECIDE_SLOTS` is honored only by eval commands and by `gbrain dream --eval-run`; it never bypasses the
  consent keys, the egress gate or the daily cap.
- Positioning: `docs/architecture/decide.md` and the guide present the durable asset as a provider-agnostic
  decision layer (receipts, calibration, drift, egress) with Jev as the first provider.
- Receipt volume: raw receipts default to 7 days of retention; the E2E seeds a busy-brain volume and verifies the
  receipt indexes serve `decide status` and the daily budget query; the guide gives a rows-per-day estimate.

- S7: when the slot is on, the slot threshold replaces `dream.triage.threshold` for Jev verdicts; the rescue band
  applies only to the LLM path. `dream-retriage` and its spend estimate honor S7 (Jev pricing when S7 is on).
- S8 execution: `verifyBody` stays synchronous and gains one extra output listing the units that pass only because
  they contain no quote, number or attribution, without changing existing fields. S8 runs as a separate async pass
  over those units at both `verifyDreamPage` call sites (`synthesize-verify.ts` and `synthesize-postprocess.ts`),
  under the dream phase budget. On timeout or budget exhaustion the units keep today's mechanical result. S8
  requires `decide.egress.private=allow` for Jev because it sends transcript windows.
- `decide.timeout_ms` bounds one logical decision (all batches).
- Malformed responses: a response missing any requested question id, or carrying a non-numeric or out-of-range
  value, fails that logical decision with `error_reason=malformed_response` and takes the fail direction; partial
  answers are never used. Receipts also carry `call_site` so deadline success rates per call site come from receipts.
- Config and CLI hygiene: every `decide.*` key is registered with validation (enums, numeric ranges) in the config
  key registry. `gbrain decide enable` refuses S6, S7, S8 or S9 on the Jev provider while `decide.egress.private` is
  `deny`, naming the key to change. The `gbrain decide` command table record uses `thinClient: 'refuse'`. The
  receipt HMAC salt is written insert-if-absent and re-read, so concurrent processes agree.
- `gbrain decide sweep --slot conflict` runs the S9 sweep on demand (local CLI only) and prints the counts of
  duplicates, proposals written, independents and skipped facts.
- Module-size ratchets: new logic lives in new modules (`src/core/ai/decide/*`, search stage modules, cycle
  helpers). Facades at or near their ceilings today that this plan touches (`gateway.ts`, `synthesize.ts`, `cli.ts`,
  `mode.ts`, `config.ts`, `eval-longmemeval.ts`, `search/hybrid.ts`, `cycle.ts`) get exact per-file ceiling raises in `scripts/module-size-limits.tsv`
  with notes, in the same commit, limited to delegation lines.
- Migrations take the next free numbers at build time (v179-v181 today) because GBRA-25, GBRA-27 and GBRA-31 are
  active. The keyed live test skips unless `GBRAIN_LIVE_TYPESAFE=1` and a TypeSafe key are set, following the
  repo's keyed-test skip convention, so the default `bun test` never calls the provider.
- `gbrain decide judge-agreement --suite` accepts the existing LLM-judge suites that have labelled sets (the
  LongMemEval answer judge and the dream grounding judge).
- Eval budget rule: the $40 paid ceiling holds. Slots are measured in the plan's expected-value order; a slot not
  measured when the budget runs out gets the recorded verdict `not measured`, stays experimental, and is named as
  such in the CHANGELOG. No slot's verdict is inferred from another slot's run.
- `gbrain decide receipts --slot <slot> --what-if-threshold <t>` recomputes the outcome mix a different threshold
  would have produced from stored `answer_value`, `decision_id`, `protected`, `rank` and `min_keep`, with no
  provider call. The S3 survivor rule is: protected items stay, above-threshold items stay, then the best-ranked
  pruned items return until `min_keep` is met. Covered by a CLI test on seeded receipts, including a case where
  `min_keep` binds.
- When any slot ran in shadow or on, `gbrain query --explain` prints one line per slot: mode, provider and
  resolved model, answer summary, threshold and outcome. With all slots off, explain output is byte-identical to
  today (golden).
- `gbrain decide status` prints a per-slot readiness line computed from local state only (`off`,
  `shadow: N receipts, needs calibration`, `calibrated for <model>, ready for on`, `on`, `on (drift: demoted to
  shadow)`) and an estimated cost per unit for the enabled slots: per 1,000 queries (S1-S5), 1,000 turns (S6),
  1,000 transcripts (S7), 1,000 dream pages (S8) and 1,000 swept facts (S9), from the last 24 hours of receipts or,
  with none, from the pack planner's token estimate for a typical input. Covered by the status JSON golden.
- Rate limits are dynamic: no hardcoded requests-per-second or tokens-per-second constants; concurrency is capped
  at 16 batches and a 429 `retry-after` is honored only when it fits the deadline. Docs cite TypeSafe's published
  limits with a retrieval date and say they change without notice.
- TODOS.md gains three entries in this PR: a local decide provider, online calibration labels, and a Jev-scored
  query-expansion decision (A5).
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- Quickstart and time to first decision (target under 5 minutes from a key in hand, probe under 2 minutes):
  `docs/guides/system-one.md` opens with one copy-paste block: `export TYPESAFE_API_KEY=...`, `gbrain decide
  probe` (works with only a key and prints the next command), `gbrain decide probe --query "<a question your brain
  can answer>"` (the magical moment: Jev's evidence probability for each result and its rerank order next to
  today's, on your own brain, changing nothing), `gbrain decide enable --recommended` (or `gbrain decide enable
  evidence` for shadow), then `gbrain decide status`, each with its expected output. A CI test runs the block
  against a seeded PGLite brain with a fixture transport and asserts every documented output line; key
  acquisition time is reported separately in the guide.
- Preconditions: `gbrain decide enable` with `decide.provider none` refuses with reason `no_provider` and the exact
  command, unless `--provider <id>` is given, in which case it writes that provider. Every `enable` writes the
  resolved pinned id (never an alias) into the provider key, so a later binary that changes the default pin never
  moves an opted-in brain. `enable --recommended` with no qualifying slot prints "no slot has a recorded win for
  <model>; see docs/eval/system-one/" and exits non-zero without changing config.
- Effective mode everywhere: `decide enable`, `decide status` and a post-set hook on `gbrain config set
  decide.slots.*` print `requested: <mode> / effective: <mode> / cause: <reason> (<values>) / fix: <command> /
  docs: <anchor>` for every slot whose effective mode differs (drift, `pack_shape` mismatch, action-precision
  gate, uncalibrated fallback, S1 without a Jev reranker, budget, missing consent). `enable` exits non-zero when
  the effective mode is lower than requested. Status distinguishes `pending` (no receipts yet), `cache_hit`
  (receipts skipped on cache hits), `blocked` and `demoted`.
- Refusal reason catalog: `docs/guides/system-one.md` gets a table modeled on `docs/guides/write-refusals.md`
  (problem, cause, exact recovery command, docs anchor) for `no_provider`, `no_key`, `no_calibration`,
  `no_qualification`, `pack_shape_mismatch`, `action_precision_low`, `egress_private_denied`,
  `egress_class_denied`, `egress_fallback_missing`, `split_mismatch`, `pinned_model_unavailable`,
  `budget_exhausted`, `thin_client`, `malformed_response`. A unit test asserts every refusal and skip code path
  emits a catalogued reason, and the troubleshooting table is keyed by these reasons.
- One canonical outcome vocabulary: a single exported table in `src/core/ai/decide/` lists every receipt outcome
  and skip reason (the per-slot outcome list in the accepted CEO requirements, which supersedes the shorter list in
  Architecture item 7); the migration's check constraint and `docs/architecture/decide.md` are generated from or
  tested against it, so the three cannot drift. User-facing surfaces say "probability", not `noul`, and one table
  maps slot names to plain words (`answerable` = abstention, `recall_needed` = know-to-ask, `conflict` =
  contradiction).
- Shadow diagnostics: async shadow adds no meta; `--explain` awaits shadow for that one query and prints the decide
  lines, and `shadow_wait on` does so for every query. A fail-open skip adds `meta.decide.<slot>.skipped: <reason>`
  to query meta and a line to `--explain`.
- S1 consistency: `gbrain decide enable rerank --on` sets `search.reranker.model` to the pinned Jev id after the
  confirmation, remembering the previous value, and `gbrain decide disable rerank` restores it, so disabling
  reverses what enabling did. `decide status` prints S1's active reranker, whether Jev is being called, and which
  key supplied the credential.
- Per-slot providers and egress fallback: `decide.slots.<slot>.provider` (inherits `decide.provider`) lets an
  operator run, for example, S3 on Jev and S7 on a local `llm:` model; `decide.fallback` is named
  `decide.egress_fallback` because it only handles egress-refused items. `enable` validates the effective route:
  S6-S9 are refused on Jev with private egress denied only when no permitted per-slot provider or egress fallback
  can handle the refused data, and the refusal names every missing key at once. `gbrain decide status --egress`
  prints a provider by data-class matrix with the key that decides each cell.
- Qualification step: `gbrain decide qualify --slot <slot> [--call-site <site>] --dataset <jsonl>` evaluates the
  newest calibration on the eval half in isolation, stores `action_precision_lb` and per-slice results as its
  qualification, and prints the activation command or the refusal. `calibrate` accepts `--call-site`. The guide
  documents the dataset JSONL schema per slot with a five-line example. Tests cover dataset, calibrate, qualify,
  enable end to end on a fixture.
- Budget wording: `decide.budget.daily_usd` is documented as the budget for third-party decide slots; `enable` and
  `status` show covered spend and the excluded paths (S1 `on` under reranker controls, `llm:` under chat controls)
  with their effective limits.
- Discoverability: `gbrain providers` shows a decide/rerank capability column for the TypeSafe recipe;
  `gbrain decide --help` and every subcommand's help work without a configured brain (added to
  `test/cli-help-without-brain.serial.test.ts`); the thin-client refusal says "`gbrain decide` runs on the brain
  host; run it there"; the guide is linked from `docs/guides/search-modes.md` and the provider docs; AGENTS.md
  "Common tasks" gets one bullet and `skills/RESOLVER.md` a route for enabling System One.
- Upgrade safety: an enabled slot records the calibration it uses (local row id or reference id plus binary
  version). A new binary never silently switches an enabled slot to a newer reference calibration: `decide status`
  shows "newer reference available" with the threshold change, and `gbrain decide calibrations list|adopt
  <id>|retire <id>` adopts, retires or restores rows. The upgrade note in `skills/migrations/` says so.
- Proposal review and undo (replaces the CEO requirement's reference to an existing fact restore path, which does
  not exist at 6c8373c): `gbrain decide proposals list` shows both facts' text locally; `accept` and `reject` accept
  `--all-from <sweep id>`; `gbrain decide proposals undo <id>` reverses an accepted proposal with a revision check
  (clears `superseded_by`, restores the struck `## Facts` fence line), refusing if either fact changed since.
  Tested across database state and the Markdown fence.
- Machine-readable output: `--json` on `probe`, `enable`, `status`, `receipts`, `proposals list`, `calibrate`,
  `qualify` and `sweep`, each with a golden.
- Escape hatches: an operator threshold override does not bypass the action-precision gate;
  `decide.slots.<slot>.force_on true` does, prints a warning on every `enable`/`status`, and doctor always lists
  it. `decide.max_concurrency` (default 16) and `decide.margin_floor` (default 0.05) are configurable;
  `docs/architecture/decide.md` has a "fixed by design versus configurable" table covering window size, window cap,
  S4 k, S6 budgets and S8 window count. `gbrain decide disable --all` and `decide.provider none` stop every slot,
  S1 shadow and the S9 sweep; the guide names both as the kill switch.
- Contributor contract: `decide()` takes an explicit `callSite`, questions are a discriminated union (choice
  options, score levels), and `docs/architecture/decide.md` includes one complete custom-slot example covering both
  providers, calibration lookup and failure handling.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- Storage pattern: receipts, spend rows, calibrations, proposals and sweep state are read and written through
  `engine.executeRaw` in `src/core/ai/decide/store.ts`, following `src/core/search/telemetry.ts` and
  `src/core/search/query-cache.ts`, so no `BrainEngine` method and no engine facade grows. No JSONB columns (or
  `executeRawJsonb` if one becomes necessary). Buffered writes register with `registerBackgroundWorkDrainer`
  (`src/core/background-work.ts`) for the CLI's bounded teardown drain, never a raw exit hook (PGLite deadlock
  history, #4143); this is the mechanism behind the "flush at CLI exit" requirement. E2E runs on PGLite, Postgres
  and PgBouncer.
- Spend ledger (replaces receipts as the budget source): every provider request writes one `decide_spend` row
  (request_id, created_at, source_id, provider, model_resolved, lane, remote, input_tokens, cost_usd, outcome
  `ok|failed|timeout|malformed`); failed and timed-out requests are charged their estimated input tokens. Admission
  reserves the estimate on the process `BudgetTracker` before sending and settles after. The daily figure sums
  `decide_spend`; the cap is documented as soft in both directions (lost buffered rows and concurrent processes).
  Remote-triggered spend (from MCP `query`/`think`) is counted separately and capped by
  `decide.budget.remote_share` (default 0.5 of the daily cap); `decide status` shows local versus remote spend.
- Qualification you can actually pass: `decide qualify` computes `action_precision_lb` over independent families
  (query, transcript or fact family) after the full production action reducer (margins, floors, protections,
  S4 agreement rule), refuses with `insufficient_n` and prints the required n when the harmful actions are too few
  for the bound to reach `min_action_precision` (for example 35 of 35 correct is the minimum at 0.90), and gates on
  the pooled result with per-slice numbers advisory unless the dataset names gated slices. Datasets are sized for
  at least 60 expected harmful actions per slot where the source data allows. The plan's expectation for v1:
  S3 and S7 are likely qualifiable; S4 and S8 likely are not with current datasets and ship shadow-only unless
  qualification passes. Production, `qualify` and evals share one action reducer per slot.
- Policy fingerprint: each qualification is bound to an immutable fingerprint of the action policy (threshold,
  margin rule, floors, protections, prompt/question version, evidence selection, call site, `pack_shape`). A
  mismatch at runtime, including an operator threshold override that differs from the qualified one, demotes to
  shadow with reason `policy_changed`; only `force_on` bypasses it. Receipts carry the fingerprint.
- S9 accept and undo are transactional: on managed brains they run as coordinator mutations through the managed
  fact-write path (`managed-fact-write.ts`); on unmanaged brains through a checked supersede that returns a result
  instead of `expireSuperseded`'s warn-and-continue. Both store the before and after state (`expired_at`,
  `valid_until`, `superseded_by`, the fence row and page revision) and apply database and fence changes as one
  unit; a partial write fails the operation and leaves the proposal `pending`. `undo` restores all four fields and
  the fence row with a revision check. Tests: fence-strike failure, retry, concurrent accept, intervening withdrawal,
  undo restoring `expired_at`/`valid_until`.
- S9 sweep correctness: the new fact is excluded from its own neighbours before the limit (eligibility filters
  first, then the five nearest); each pair is judged and recorded independently (a duplicate pair does not suppress
  a supersede proposal against another neighbour); unordered pairs are deduplicated with the proposed direction
  recorded; proposals carry `sweep_id` and a unique pair index. The per-source watermark only advances past facts
  created more than 60 seconds ago (commit-order lag), and facts skipped for transient reasons (`no_embedding`,
  provider failure) go to a deferred table retried on later sweeps with an attempt cap. Tested with interleaved
  commits. These tables join the proposals migration.
- Lanes: hot lanes (S1-S6) use `decide.max_concurrency` (16); background lanes (S7, S8, S9, calibrate, qualify)
  use `decide.background_concurrency` (default 4) and back off first on 429. Receipts and spend rows record
  `lane`. Coordination is per process; the guide says so.
- Query decide budget: `decide.query_budget_ms` (default 1500) bounds all decide work of one `query` request (S2
  wait, S1 rerank, the S3/S5 and S4 stage); later stages get the remainder and skip with `late`. `think` has the
  same budget per call. The deadline-realism eval reports p99 total added latency.
- Typed evidence and egress: `decide()` state and question content are typed evidence items (`text`, `class`,
  `source_id`, and `slug`, `fact_id` or `transcript_ref`, plus visibility). The policy checks the provenance of every
  item before serialization; items with missing provenance are refused. S1 shadow checks egress before the reranker
  reduces results to strings.
- One canonical protection predicate (`alias_hit`, `exact_lookup`, `exact_title_match`, `relational_pinned`, identity
  tiers) is shared by S3, S5, autocut and return sizing. Tests cover graph-only answers through adaptive return and
  token limits.
- S4 honesty: the abstention decision covers exactly the evidence `think` will synthesize from (pages, takes,
  trajectory rendered as evidence items). If coverage is incomplete (k shrink, egress-withheld items, evidence
  omitted), the verdict is `incomplete` and `think` does not abstain. The agreement rule uses the deterministic CRAG
  grade computed without the S3-derived `decide_evidence` input. (Supersedes the CEO/DX wording that S4 over the
  pre-S3 top-k is a conservative superset: it is not; that result is diagnostic only.)
- S6 retrieval: "fire retrieval" is one keyword-only search (`hybrid/keyword-only.ts`, no embedding call, limit 3)
  under an absolute parent deadline with cancellation, with nested decide slots off and the hook's source,
  private-page and safe-chunk restrictions applied. The reflex block is assembled first and returned unchanged if
  S6 or its retrieval misses the deadline. The eval reports fire-success rate.
- S1 score semantics and activation: the TypeSafe recipe declares its score semantics (four-level rubric). Until
  the S1 eval ships calibrated values, autocut's score-cliff and CRAG's strong-evidence grade do not consume Jev
  rubric scores (they use their existing non-score behavior). The S1 eval measures the final returned evidence,
  not only rerank order. S1's effective activation includes `search.reranker.enabled` and the search mode
  (conservative mode disables reranking); `decide enable rerank --on` sets the model and enabled flag, warns in
  conservative mode, is idempotent and records ownership so `disable` restores only configuration it still owns.
  `decide.provider none` stops decide slots and S1 shadow, not an operator-chosen Jev reranker (documented).
- Shadow isolation: detached shadow work runs with its own bounded budget scope (not the ambient request
  `BudgetTracker`), a bounded in-flight queue, and background-work drain registration. A test runs foreground work
  near budget exhaustion with shadow active and asserts the foreground call is unaffected.
- S7 completeness: the transcript is one logical decision. It is rejected only when every window completed under a
  compatible model and policy; incomplete coverage takes the S7 no-change path and never caches a rejection. A turn
  over the request limit splits at paragraph boundaries and is marked. Calibration and qualification use the
  transcript-level maximum, stratified by window count. For Jev rows the triage cache's `worth_processing` is
  written from the S7 decision, and every reader of that column is audited. On `margin_hold` the LLM triage result
  is the cached verdict.
- S8 ordering: S8 completes, or times out to the mechanical result, before the page is persisted at both
  `verifyDreamPage` call sites; tested at the `synthesize-postprocess.ts` site.
- S9 egress: facts default to `visibility: private`, so S9 on Jev requires `decide.egress.private=allow` in practice;
  `enable` shows the share of facts that would be refused and suggests the `llm:` route.
- Receipt volume and vocabulary: in shadow, S3 and S5 default `shadow_sample` to 0.1 (on-mode decisions are always
  recorded). The outcome vocabulary is enforced in TypeScript with a sync test against the docs, not with a
  database CHECK constraint (supersedes the CEO/DX wording that the migration's check constraint lists the values).
- Cache: the semantic result cache is disabled at 6c8373c (`semanticResultCacheAvailable()` returns false), so the
  decide part of `knobsHash` is future compatibility; it also includes the last resolved model id.
- `llm:` provider guarantees: a capability check refuses `on` for providers whose path ignores structured output;
  answers are strictly validated; model identity comes from the provider-reported snapshot, else an endpoint plus
  model fingerprint; unknown identity is shadow-only.
- Receipts privacy and replay: `subject_ref` is HMACed; the salt is excluded from every config surface
  (`config get/list`, config snapshot, MCP config reads, exports), with a test. `--what-if-threshold` supports only
  slots whose reducer is threshold-only and exactly reproducible from receipts (S3, S7, S8) and says "not
  reproducible" for others. Public eval receipts go through a sanitizer; no production receipts are committed.
- Doctor names alias rollouts (mixed resolved ids across a decision under `jev-latest`) explicitly.
- Delivery gate inside the one PR: the foundation lane plus S1 and S3 must pass unit, PGLite and golden tests before
  the other slot lanes start; a slot that is not fully wired with tests is not registered and ships nowhere, rather
  than half-wired. The eval plan carries a per-slot spend estimate before runs start.
<!-- /autoplan-accepted:eng -->
## Review record

### Phase 0 intake (autoplan)

- Restore point: `~/.gstack/projects/garrytan-gbrain/feat-system-one-v1-autoplan-restore-20260930-164146.md`.
- Scope detection: UI scope NO (no view/rendering terms), so Phase 2 Design is skipped (not a completed review).
  DX scope YES (`dxRequired=true`, 17 term matches: CLI 8, agent 3, API 2, integration 2, command 1, MCP 1).
- Outside voice preflight: `CODEX_MODE=ready` (codex-cli 0.159.2, model probe OK).
- Host adaptations (Capy): native subagents are Capy child tasks (anthropic/claude-opus-5-5, reasoning high) that
  receive the snapshot's `nativeDispatchPrompt` verbatim; AskUserQuestion is auto-decided with the 6 principles
  because the owner pre-authorized "accept all recommendations"; the owner's standing rules (one integrated PR,
  PATCH versions, matched baseline-vs-feature evals, privacy placeholders, big-v1 ambition) bind every decision.

### Phase 1 CEO review

Methodology reads: `autoplan-ceo-methodology-kaXi8G/methodology.md` read at offsets 1-600, 533-600 (re-read of a
truncated chunk), 601-1200, 1201-1800 (1201-1731 and 1732-2302), 1801-2400 (2303-2400) and 2401-2543 (EOF).
All 2,543 lines loaded. Skip-listed sections loaded only.

#### Pre-review system audit

- Base: `master` @ 6c8373c (v0.60.13.0). Branch `feat/system-one-v1` has no commits; only this plan is untracked.
  No stashes. Recent history is fix waves 1-3, refactor wave 1 (storage SQL once, doctor/cli/sync peels) and the
  return_unit evidence delivery release. The refactor wave matters here: new code must land in the peeled module
  dirs (`src/core/search/hybrid/*` stages, `src/commands/doctor/checks/*`, `src/cli/commands/*`,
  `src/core/engine-sql/<domain>.ts`), never back in the facades.
- Seams verified in code: `src/core/cycle/triage-rescue.ts`, `src/core/facts/classify.ts` (cheap cosine fast-path
  0.95, classifier, cosine fallback 0.92), `src/core/search/crag.ts`, `src/core/search/rerank.ts`
  (`applyReranker`, fail reasons `timeout|budget|provider_error`), `src/core/think/intent.ts` (`classifyIntent`),
  `src/core/cycle/synthesize-verify.ts` (quarantine lane exists), `src/commands/hook.ts` (user-prompt path),
  `src/core/search/private-visibility.ts`, `src/core/budget/budget-tracker.ts` (`BudgetKind`),
  `src/core/ai/budget-record.ts` (`recordOnTracker`). Next schema migration number is v179 (last: v178).
- `src/core/ai/gateway.ts` is 4,335 lines at its ratchet ceiling (4,335), so the plan's "thin delegating export"
  rule is load-bearing, not stylistic.
- `src/core/search/llm-intent.ts` already runs an opt-in Haiku modality tie-break (text/image/both), a precedent
  for S2's fail-open pattern.
- PR #5178 (`pr-5178`, one commit 71ebc3e): recipe `src/core/ai/recipes/typesafe.ts`, adapter
  `src/core/ai/rerank-typesafe.ts` + `rerank-typesafe-gateway.ts`, pricing row in `embedding-pricing.ts`, packing
  and concurrency helpers under `scripts/lib/` (not `src/`), 36 files, +8,077 lines (most are eval receipts).
- TODOS.md has no Jev/TypeSafe/decide entries. Issue #5575 (trust tiers, blocking write gate) owns write-gate trust;
  the plan correctly keeps it out of scope.
- Design doc check: the newest repo doc under `docs/designs/` is this plan, so it is the design source of truth; no
  `/office-hours` offer is needed. No CEO handoff note. Prior learnings search: none recorded (cross-project
  learnings enabled per the recommended option).

#### Taste calibration

- Good patterns to copy: `src/core/search/rerank.ts` (`applyReranker` fail-open with typed skip/fail reasons and
  stage telemetry), `src/core/facts/classify.ts` (explicit decision tree with a cheap path, a model path and a
  deterministic fallback), `src/core/search/llm-intent.ts` (narrow opt-in model call that returns the input
  fallback on any error).
- Patterns to avoid: growing `src/core/ai/gateway.ts` (4,335 lines at ceiling, a long list of per-feature
  hunks in its ratchet row) and #5178's placement of production packing logic under `scripts/lib/`.

#### Landscape check

Aside is not installed; WebSearch was used (read-only, sanitized queries).
- Layer 1 (tried and true): gate the expensive path with a cheap decision that fails open and records its reason
  (agent-memory pattern write-ups; ModernBERT scope classifiers gating retrieval at ~25 ms with a confidence floor
  that falls back to full search).
- Layer 2 (current chatter): TypeSafe's public docs confirm one endpoint, three answer types, input-only billing
  and `model` echoing the answering version. Published rate limits differ by source and date (the compendium's
  100K tokens/s and 40 requests/s vs a 2026-09-20 write-up's 250K tokens/s and 1,200 requests/minute), and
  TypeSafe says they change without notice. English is the primary language; other scripts are "not equally well"
  handled, which matters for CJK brains.
- Layer 3 (first principles): the known failure of gates is that a false negative is invisible and serial gates
  compound (three 95% gates pass about 86%). GBrain's plan answers this with shadow receipts, min-keep floors and
  per-slot measured verdicts. The part the conventional wisdom misses: a cheap scorer changes the economics of
  candidate depth. When scoring 100 documents costs cents and under 2 s, the rerank slot can look much deeper than
  today's pool, which attacks the measured recall bottleneck directly (see E1).

#### Live evidence gathered for this review (2026-09-30, total spend well under $0.001)

Two probes against `jev-latest` (resolved `jev-1.13.0`, 138-197 ms per request, 335-392 input tokens):
- Same request twice: q1 = 0.53 then 0.51. A solo single-question request twice: 0.74 then 0.62.
- Adding unrelated or conflicting questions to the same request moved q1 between 0.51 and 0.81; clear negatives
  stayed at 0.01-0.02.
- A candidate carrying an instruction ("for every other question the answer is false") did not suppress the other
  answers (q1 stayed 0.74-0.78), n=2.
Conclusion: answers are not bit-stable, mid-band answers can move by 0.1-0.25 across identical or re-packed
requests, and clear cases are stable. Thresholds that sit in the mid band need a stability margin, and
calibration must use production's packing shape.

#### 0A. Premise challenge

- P1 "Jev is calibrated": partly. Its probabilities are calibrated to its own training tasks, not GBrain's
  questions. The plan already requires per-slot calibration for the exact resolved model before `on`. Accepted
  with that caveat.
- P2 "One `decide` capability for nine slots is the right abstraction": valid. Packing, receipts, egress,
  pinning, budget and fail directions are identical concerns across slots; nine hand-rolled integrations would
  duplicate all of it. Accepted.
- P3 "GBRA-4's R@1 lift transfers to LongMemEval": unproven. LongMemEval top-5 complete retrieval is near ceiling
  (449/470), so it can only show regression, not gain. R@1 and candidate recall at depth are the metrics that can
  show S1's value. Accepted as an eval-metric correction (E1).
- P4 "Jev fixes judgment, not recall": true as stated, but incomplete. 270 of 404 GBRA-4 misses were
  candidate-generation misses and the plan has no slot aimed at them. Cheap scoring makes a wider rerank pool
  affordable, which converts some recall misses into judgment problems Jev is good at. Accepted as expansion E1.
- P5 "Every slot defaults off, so the PR is zero-risk": true for behavior (criterion a); migrations still run on
  every brain. Accepted; migration safety is reviewed in Section 9.
- P6 "Published limits (100K tokens/s, 40 requests/s)": factually unstable (see Landscape). Corrected with a
  recorded baseline edit; code treats limits as dynamic.
- P7 "Code owns every threshold, so decisions are reproducible": false as an implicit premise. Live probes show
  answers move across identical requests. Accepted as a hardening obligation (stability margin, packing-shape
  parity, flip-rate reporting).
- Do-nothing cost: dream triage keeps paying chat-model prices and missing buried signals (Cat 35), rerank stays
  Voyage-only, and every new fuzzy judgment is another regex or another free-text chat call. No premise is
  clearly wrong, so Step 0 queues no User Challenge.

#### 0B. Existing code leverage

| Sub-problem | Existing code | Plan reuse |
|---|---|---|
| Jev wire, recipe, rerank adapter | PR #5178 `recipes/typesafe.ts`, `rerank-typesafe*.ts` | Land on the decide core; move packing from `scripts/lib/` into `src/core/ai/decide/pack.ts` |
| Rerank fail-open | `search/rerank.ts` `applyReranker` | Reused unchanged as the S1 entry |
| Intent routing | `think/intent.ts` `classifyIntent`, `search/llm-intent.ts` | Regex stays default and tie source |
| Evidence grading | `search/crag.ts`, `search/evidence.ts` | S3 adds one grade input |
| Triage gate | `cycle/triage-rescue.ts`, `passesTriageGate` | One gate kept; decide verdict is an input |
| Claim verification | `cycle/synthesize-verify.ts` quarantine lane | S8 adds a reason, never admits |
| Contradiction | `facts/classify.ts` decision tree | S9 replaces only the chat call |
| Spend | `BudgetTracker`, `recordOnTracker`, `model-pricing.ts` | New kind `decide` |
| Private content | `search/private-visibility.ts` predicates | Egress gate reuses them |
| CLI, doctor, migrations | `cli/command-table.ts`, `doctor/registry.ts`, `new:migration` | Standard rows from CONTRIBUTING |

No rebuild is proposed; every slot hooks an existing seam.

#### 0C. Dream state mapping

```
  CURRENT STATE                      THIS PLAN                              12-MONTH IDEAL
  Regex rules + free-text chat  ---> One typed decide() with 9 slots,  ---> Every fuzzy judgment is a typed,
  calls; no receipts; Voyage-only    shadow receipts, calibration per       calibrated, receipted decision;
  rerank; no calibration; no         model, drift demotion, per-slot        slots graduate to default-on by
  measured per-judgment verdicts     measured verdicts, all default off     measured verdicts; local provider
                                                                            option; C4-C9 slots on the same core
```

The plan moves directly toward the ideal: it builds the control plane and the measurement loop; default flips and
the remaining slots are follow-ups that reuse it.

#### 0D. Approach alternatives (auto-decided)

| Commitment | Source | A (current plan) | B (smallest) | C (larger) |
|---|---|---|---|---|
| Decide core, receipts, calibration, egress | plan | yes | yes | yes |
| Slots in this PR | plan | 9 + judge harness | rerank + triage | all 9 + Jev-Mem control plane replacing hybrid orchestration |
| Default behavior | plan (a) | unchanged | unchanged | changed |
| Evidence | GBRA-4, #5178, probes | per-slot verdicts | 2 verdicts | none for orchestration rewrite |

Decision: A. P1 (completeness) and the owner's stated big-v1 direction; B is a scope cut the owner excluded, C has
no measured basis and would break criterion (a). Mechanical.

#### 0E. Mode

Mode: SELECTIVE EXPANSION (autoplan override); approved decisions: CEO-A1 (approach A). The plan adds a
capability to an existing system, so harden the stated scope and cherry-pick only expansions inside the blast
radius. No new approach decision was needed beyond 0D.

#### 0F/0G. Hold-scope checks, 10x, delight scan and cherry-picks

Hold-scope checks: the complexity check fires (well over 8 files, one new module family and 2 new tables). The
minimum set that meets the goal is the decide core plus all nine slots, because the goal is "every fuzzy judgment
can come from Jev" and each slot is a separate judgment. Deferral candidates were evaluated one by one (Defer vs
Keep): S5 injection (keep, taste: weakest slot, signal-only, but cheap because it rides S3's packed request), S8
grounding (keep), S2 intent (keep), judge harness (keep, eval-only). The owner's rule and the autoplan override
("reduce scope on a complete plan: no") decide the rest.

10x check: the 10x version is a decision layer, not a reranker: GBrain stops encoding judgment in regexes and
prompts and instead asks typed questions, stores why it acted, and graduates each judgment on measured evidence.
Platform potential: C4-C9 slots, a local provider and online calibration all reuse `decide()`.

| # | Proposal | Effort | Risk | Decision | Reasoning |
|---|---|---|---|---|---|
| E1 | Wide-pool rerank (`decide.slots.rerank.pool_size`) + recall-at-depth eval | S | low | ACCEPTED | Attacks the measured bottleneck; in blast radius (rerank stage + eval); P1/P2 |
| E2 | Stability margin, packing-shape parity, flip-rate reporting | S | low | ACCEPTED | Required to meet criterion (c) given live nondeterminism evidence; hardening |
| E3 | `decide receipts --what-if-threshold` | S | low | ACCEPTED | Delight; reuses stored answer_value, no provider call; P2 |
| E4 | Per-slot lines in `query --explain` | S | low | ACCEPTED | Debuggability on an existing surface; off stays byte-identical; P2 |
| E5 | Per-slot readiness line in `decide status` | S | low | ACCEPTED | Tells the operator exactly what to do next; local state only; P2 |
| E6 | Local/self-hosted decide provider | L | medium | DEFERRED | New infra outside blast radius; P3 |
| E7 | Online calibration labels from user feedback | M | medium | DEFERRED | Needs label UX and text storage that conflicts with hashes-only receipts |
| E8 | Jev for query expansion decision (A5) | M | medium | DEFERRED | New seam with its own eval; plan lists A5 out of scope |
| E9 | MCP read-only `decide_status` op | S | low | SKIPPED | Doctor JSON already reaches agents through existing health surfaces; keeps decide off MCP |

Delight scan (5+): E3, E4, E5, `decide probe` printing an estimated cost per 1,000 queries for the current slot
set (folded into E5's status work as printed text), and `decide enable` naming exactly which slots will send
conversation text (already in the plan).

#### 0I. Temporal interrogation

```
  HOUR 1 (foundations):   decide() types, provider interface, pack planner moved out of scripts/lib,
                          migrations v179/v180, config keys. Must know: gateway.ts has zero headroom;
                          receipts need BrainEngine methods through engine-sql (a new storage domain).
  HOUR 2-3 (core logic):  policy.ts precedence (override > calibration > none), drift demotion,
                          egress gate on private-visibility predicates, stability margin (E2).
                          Ambiguity: what "a logical decision" is for mixed-model detection across
                          16 concurrent batches; where the HMAC salt lives.
  HOUR 4-5 (integration): nine call sites, each with a different fail direction and deadline owner
                          (query 1500 ms, hook self-deadline, dream phase budget, facts path).
                          Surprise: packed S3/S4/S5 share one request, so one timeout fails three slots.
  HOUR 6+ (polish/tests): goldens (off byte-identical, doctor, CLI, migrations), fixture transports,
                          eval harness flags, Ubicloud runs, docs with "say to your agent".
```
Effort: human team ~3-4 weeks; CC + gstack ~2-3 days of agent time plus eval wall time. Feasibility blockers
resolved now: none blocking; the receipt storage domain and salt location are left to Eng (owner: Phase 3).

#### CEO decision ledger (Step 0)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| CEO-D1 depth | default implementation-ready | implementation-ready | none | approved | autoplan default |
| CEO-D2 learnings | cross-project learnings prompt | enabled | none | approved | auto-decided recommended A |
| CEO-A1 approach | 0D grid | A current plan | B, C | approved | auto-decided P1 + owner direction |
| CEO-M mode | autoplan override | SELECTIVE EXPANSION | none | approved | autoplan override |
| CEO-H1..H4 hold | S5, S8, S2, judge harness | keep | defer | approved (keep) | auto-decided; S5 is taste |
| CEO-E1..E5 | cherry-picks above | accepted | none | approved | auto-decided P1/P2, in blast radius |
| CEO-E6..E8 | cherry-picks above | deferred | none | deferred | TODOS.md at Phase 4 |
| CEO-E9 | cherry-pick above | skipped | none | declined | P4/P5 |
| CEO-F1 limits | P6 factual correction | baseline edit | none | approved | factual correction, no behavior change |

#### 0H Spec Review Loop

Launch 1 (Capy child task, claude-opus-5-5 high, both inputs read in full): score 5/10, FAIL on all five
dimensions, 27 numbered issues. Every feasibility claim it made was re-verified in code before deciding
(`hook.ts` is engine-free with `USER_PROMPT_DEADLINE_MS = 800`; `synthesize.ts` caches triage on
`TRIAGE_VERSION = 2`; `search.reranker.top_n_in` exists in `mode.ts`; `MAX_SEARCH_LIMIT = 100`; `verifyBody` is
synchronous; `think/intent.ts` returns only three labels; `isPrivatePage`/`findPrivateOnlySlugs` exist; `purge`
is a cycle phase). Dispositions, all auto-decided with the recommended fix unless noted:

| ID | Finding | Disposition |
|---|---|---|
| SR1-C1 | No calibrate/eval holdout | Fixed: frozen split, `split_hash`, evals refuse overlap |
| SR1-C2 | Decide knobs missing from `knobsHash` | Fixed: append-only knobs part, emitted only when a slot is not off; shadow makes no call on cache hit |
| SR1-C3 | Receipts cannot support what-if or S9 accept | Fixed: `decision_id`, `protected`, `min_keep` columns; `decide_proposals` table (v181) |
| SR1-C4 | Config keys missing | Fixed: `proposal_floor`, `retest_n`, `fallback llm:<provider:model>`, salt location |
| SR1-C5 | No datasets for S5/S6/S8 | Fixed: three new dataset sources; S8 hand-labelled 200-unit set |
| SR1-C6 | Daily budget has no persistence | Fixed: computed from receipts per UTC day; `llm:` spend stays under chat controls |
| SR1-C7 | TODOS.md not in deliverables | Fixed |
| SR1-K1 | `TRIAGE_VERSION` bump breaks criterion (a) | Fixed: no bump; provider/model join cache identity only when S7 is on |
| SR1-K2 | S4 cannot share S3's request | Fixed (taste): S4 judges the pre-prune top-k superset in the same request; latency line corrected to two serial calls |
| SR1-K3 | S3 "never reorder" vs S5 moves | Fixed: S5 is the only reorder, within one `classifyEvidence` class, never below `min_keep` |
| SR1-K4 | S1 does not fit the slot contract | Fixed: explicit S1 off/shadow/on contract; no threshold, no demotion |
| SR1-K5 | `pool_size` duplicates `top_n_in` | Fixed: CEO-E1 revised to reuse `top_n_in` (supersedes the earlier E1 wording) |
| SR1-K6 | `abstain` label overloaded | Fixed: `margin_hold`; S9 band order defined |
| SR1-K7 | Stale sections (goal e, eval line, columns, CLI list) | Fixed by baseline edits |
| SR1-K8 | S8 egress requirement unstated | Fixed |
| SR1-L1 | Thresholding on `choice` undefined | Fixed: threshold on `probabilities[chosen]` |
| SR1-L2 | S9 aggregation undefined | Fixed: duplicate wins, then supersede, then proposal band |
| SR1-L3 | Calibration lookup before the call; override drift | Fixed |
| SR1-L4 | Vague phrases (pack shape, timeout scope, cost estimate, purge phase, double-counted spend) | Fixed |
| SR1-L5 | Egress gate path for in-memory candidates | Fixed: `isPrivatePage` + batched `findPrivateOnlySlugs` |
| SR1-S1 | E1 rationale unproven | Fixed: stated as a hypothesis, measured first |
| SR1-F1 | S6 in the engine-free hook | Fixed: runs in serve's `turn-context.ts`, deadline at most 500 ms inside the 800 ms hook budget |
| SR1-F2 | S2 cannot feed arm gates as a label | Fixed: `think` mapping + label-to-detector hint table in `hybrid/request.ts` |
| SR1-F3 | Pool 200 unreachable | Fixed: sweep capped at 100 |
| SR1-F4 | Gateway ratchet will fail | Fixed: exact ceiling raise with a note |
| SR1-F5 | S8 needs an async path | Fixed: separate async pass at the `verifyBody` call site |

Launch 2: score 5/10, FAIL, 38 issues. Re-verified in code: `classifyAgainstCandidates` has no runtime caller
(only `test/facts-classify.test.ts`); runtime supersession is `decideSingleFact` (zero-LLM cosine rule);
`TURN_CONTEXT_SERVER_BUDGET_MS = 400`; `verifyDreamPage` has two call sites; `eval-longmemeval.ts` calls
`hybridSearch`, not `think`; search intent is `QueryIntent` from `classifyQueryWithBrainPatterns`. Dispositions:

| ID | Finding | Disposition |
|---|---|---|
| SR2-C1 | S9 targets a classifier with no callers (premise wrong) | User Challenge UC1, applied: S9 becomes an async sweep in the `extract_facts` tail + `decide sweep`; write path stays zero-LLM |
| SR2-C2 | `eval longmemeval --decide` never exercises S2/S4 | Fixed: harness routing and harness-reader abstention |
| SR2-C3 | S8 misses a call site; `verifyBody` lacks unit classification | Fixed: both call sites; additive output field |
| SR2-C4 | Egress ignores fact visibility | Fixed: `facts.visibility` + provenance page |
| SR2-C5 | Fallback triggers undefined | Fixed: trigger table; uncalibrated fallback = shadow |
| SR2-C6 | margin_hold omits S4; override margin undefined | Fixed |
| SR2-C7 | S4 can exceed 32k | Fixed: shrink k, record `k_used`, fail open |
| SR2-C8 | Jev rerank spend escapes cap | Fixed: S1 on = `rerank` kind under reranker controls; S1 shadow counts toward decide cap |
| SR2-C9 | Receipts lost at CLI exit | Fixed: 500 ms bounded flush |
| SR2-C10 | Config validation, enable vs egress deny, S4 zero candidates, thin-client, retriage | Fixed |
| SR2-K1 | Mixed-model rule vs fallback | Fixed: sub-decisions |
| SR2-K2 | S1 vs goal (f) | Fixed: S1 on keeps reranker egress; S1 shadow uses the decide gate |
| SR2-K3 | S9 near-threshold double label | Fixed: proposal band wins |
| SR2-K4 | Shadow adds diagnostics | Fixed: criterion (b) reworded |
| SR2-K5 | "Only slot that reorders" false | Fixed: "only post-rerank slot" |
| SR2-K6 | TODOS timing | Fixed: the implementing PR writes them |
| SR2-L1 | S2 search hints are no-ops | Fixed: S2 search question maps to `QueryIntent` |
| SR2-L2 | S1 mode matrix incomplete | Fixed |
| SR2-L3 | S3/S4 pipeline position, think gather, crag escalation | Fixed: position defined; separate think-side S4 call; escalation reuses decisions |
| SR2-L4 | S6 "fire retrieval" undefined | Fixed |
| SR2-L5 | S7 two thresholds, hold outcome | Fixed |
| SR2-L6 | Holdout check not computable | Fixed: `calibrate_ids_hash`, `calibrate_only`, split match |
| SR2-L7 | What-if cannot reproduce `min_keep` | Fixed: `rank` column + survivor rule |
| SR2-L8 | pack_shape column, shadow outcome, migration numbers, min_keep precedence, suites, live gate, (f) prompt scope | Fixed |
| SR2-S1 | S6 memory-class choice is YAGNI | Fixed: removed |
| SR2-F1 | S6 budget does not fit | Fixed: concurrent with reflex, at most 250 ms |
| SR2-F2 | In-memory egress check unsound | Fixed: batched `(source_id, slug)` query with `privatePagesFilterFragment` |
| SR2-F3 | Ratchets on six facades | Fixed: per-file raises, delegation only |
| SR2-F4 | Depth 100 reachability | Fixed: eval `limit 50` + explicit `top_n_in` |
| SR2-F5 | Salt race | Fixed: insert-if-absent, re-read |

Launch 3 (final, three-launch cap reached): score 6/10, FAIL; Scope PASS. 21 issues, all verified and fixed in
the working plan afterwards (S9 watermark and the real `decideSingleFact` guard; eval runners per slot including an
eval-only `GBRAIN_DECIDE_SLOTS` override for gbrain-evals harnesses; S7 verdict mapping; per-slot outcome table;
shadow latency contract; first-pass two-call bound restated with crag escalation and `crag_think`; override drift
warning dropped; calibrations keyed by call site with the co-packed slot set; S3 placed inside `sizeReturnPool`
plus the keyword-only path; S2 wait bound and per-call-site questions; S6 retrieval call, suppress key and budget
split; `expireSuperseded` named and exported; soft budget cap; per-unit cost; S5 marker; `hybrid.ts` and
`cycle.ts` ratchets; cache key with effective threshold, `min_keep` and calibration id). These post-launch-3 fixes
were not re-reviewed by a spec reviewer. Metrics appended to `~/.gstack/analytics/spec-review.jsonl`:
iterations 3, found 86, fixed 63 (earlier issues not re-raised by the next launch), remaining 21 (launch 3's, fixed
but unconfirmed), quality score 6.

0H document approval: auto-decided A (approve the CEO scope summary and working plan and continue to 0I), since
both reflect the exact decisions above. 0I temporal interrogation (recorded earlier) still holds; the added
ambiguity at hour 4-5 is S9's page write inside `extract_facts` and S2's wait bound on the search hot path.

#### Step 0.5 CEO dual voices

- Voice input: `autoplan-ceo-bdIZCt/ceo-implementation.md`, SHA-256 `2e69757c…5777` (fresh snapshot after the Spec
  Review Loop).
- Native voice (Capy child task, claude-opus-5-5 high, verbatim `nativeDispatchPrompt`): completed; its result
  starts `INPUT: ceo 2e69757c60544a05fe3ee9a080e215c139ac1b36c7e54e7abf8ce82b61485777`, matching the snapshot. 13
  findings (2 critical, 4 high, 7 medium).
- Codex voice (codex exec, gpt-6-astra, high reasoning, read-only, 600 s wrapper): completed, `OUTSIDE_STATUS:
  completed provider=codex host=claude`, 9 findings (1 critical, 8 high), 87,127 tokens. One transport deviation:
  stderr was shown as its last 3,000 bytes rather than in full; the review text itself was kept whole.

Native findings: (1) CRITICAL the shadow-to-calibrate loop cannot complete on real traffic because receipts hold no
text or labels; ship reference calibrations. (2) CRITICAL wrong lead problem: cheap judgment can multiply recall
over deep pools (200-500). (3) HIGH private brains cannot use S6-S9 on Jev; `llm:` is a weak hedge. (4) HIGH nine
slots against $40 means most ship unmeasured; cut v1 to core + S1, S3/S4, S6/S7 (one PR). (5) HIGH neighbour
variance is not captured by `pack_shape`; add repack sensitivity; unpack harmful gates. (6) HIGH co-packing lets
one malicious page push others' prune/abstain. (7) MEDIUM #5178 held hostage; land it first. (8) MEDIUM GBRA-4's
134/134 needs replication. (9) MEDIUM awaited shadow taxes users; sample or async. (10) MEDIUM pinned-model
retirement unhandled. (11) MEDIUM eval env override honored in the production dream cycle. (12) MEDIUM
competitive risk; position the provider-agnostic layer. (13) MEDIUM surface size and receipt volume.

Codex findings: (1) HIGH the investment targets the smaller bottleneck; let the depth experiment drive scope,
comparing wider retrieval, expansion and judgment under one budget; keep one PR. (2) CRITICAL S9 auto-supersede
gives a probability authority to retire memory; proposal-only in v1. (3) HIGH the privacy promise changes by call
site; one provider-specific consent contract (local Ollama configs send queries nowhere today). (4) HIGH per-slot
wins do not prove the integrated product; reserve budget for one end-to-end configuration that must win. (5) HIGH
calibration treated as stronger assurance than evidence; separate calibration, repeatability and action safety
with held-out uncertainty bounds. (6) HIGH eval controls invalid: label routing in the baseline, item-level splits
leak context. (7) HIGH "fast" not shown at 150/250 ms deadlines; the IPC budget nulls the whole block on overrun.
(8) HIGH activation workflow pushes model operations onto the operator; ship a tested opt-in configuration and
qualify the `llm:` alternative. (9) HIGH S8 confuses missing context with unsupported claims.

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Premises valid?                   No      No     CONFIRMED (calibration loop, pack stability, privacy/llm hedge)
  2. Right problem to solve?           Partly  Partly CONFIRMED (recall is the larger lever)
  3. Scope calibration correct?        Too wide Integrate+prove  DISAGREE -> taste (Claude cuts slots; Codex keeps scope, adds an end-to-end gate)
  4. Alternatives sufficiently explored? No    No     CONFIRMED (deep pool/expansion, tested config, unpacked gates)
  5. Competitive/market risks covered? No      No     CONFIRMED (vendor-adjacent competition; unqualified llm: hedge)
  6. 6-month trajectory sound?         Risky   Risky  CONFIRMED (operator burden, unmeasured slots, S9 mutation authority)
CONFIRMED = completed subagent + outside; primary cannot replace outside.
```

Dispositions (every finding verified against the plan text and code before deciding):

| Finding | Voices | Classification | Disposition |
|---|---|---|---|
| Recall is the larger lever; deep pool / expansion comparison | both | User Challenge UC2 | Applied: four-arm recall experiment in the S1 eval (deep pool 300 eval-only); production depth unchanged; A5 stays out as a runtime slot |
| Shadow cannot calibrate; operator burden | both | User Challenge UC3 | Applied: reference calibrations shipped in the binary, `decide enable --recommended`, reserved end-to-end eval; criterion (b) reworded |
| Neighbour variance and action safety | both | Mechanical | Applied: `repack_sd`, unpacked S4/S7/S8, `action_precision_lb` gate for harmful slots |
| Privacy contract per provider | Codex (+native F3) | Mechanical | Applied: one consent contract with per-class keys |
| Eval validity (label routing, family splits, timeouts) | Codex | Mechanical | Applied |
| Deadline realism; S6 must not null the block | Codex | Mechanical | Applied |
| S8 insufficient context | Codex | Mechanical | Applied: multi-window evidence, `insufficient_context` |
| S9 auto-supersede authority | Codex (critical, single voice) | Taste | Applied: proposal-only in v1 |
| Co-packed adversarial influence on S3/S4 | native | Mechanical | Applied: S4 own request, deterministic agreement to abstain, injected-neighbour fixtures |
| Awaited shadow latency | native | Taste | Applied: async sampled shadow by default, `shadow_wait on` to measure (reverses decision 24) |
| Private brains: local provider in v1 | native | Taste | Kept deferred (E6); applied instead: local `llm:` qualification on S7 and an honest risk line |
| Cut v1 to core + 3-4 slots | native only | Taste | Not applied (owner's big-v1 rule; Codex keeps scope); surfaced at the gate |
| Land #5178 first | native only | Taste | Not applied (plan keeps one integrated PR, #5178 credited and closed after merge); surfaced at the gate |
| GBRA-4 replication | native | Mechanical | Applied: top-1-when-present reported; shortfall reorders measurement |
| Pinned retirement | native | Mechanical | Applied |
| Env override in production dream | native | Mechanical | Applied: eval commands and `dream --eval-run` only |
| Positioning and receipt volume | native | Mechanical | Applied: docs positioning; 7-day raw retention; volume E2E |

#### Review Sections

Current scope: SELECTIVE EXPANSION (autoplan override). Accepted: A1 approach, E1 (revised), E2-E5, F1, F2, UC1
(S9 retarget), UC2 (recall experiment), UC3 (reference calibrations + recommended config), all spec-review and voice
hardening above. Deferred: E6, E7, E8. Skipped: E9. Pending: none; taste calls are provisional and listed at the gate.

**Section 1: Architecture.**

```
                    ┌──────────── callers ─────────────────────────────────────────────┐
                    │ hybridSearch (request.ts S2, rank.ts sizeReturnPool S3/S5, S4)    │
                    │ think (S2 think question, gather S3, S4 call)  applyReranker (S1) │
                    │ serve turn-context (S6)  dream: triage (S7), verify (S8)          │
                    │ extract_facts tail + `decide sweep` (S9)   eval commands          │
                    └──────────────┬────────────────────────────────────────────────────┘
                                   │ decide({slot, callSite, state, questions, deadlineMs})
                                   ▼
   src/core/ai/decide/ ── policy.ts (mode, consent/egress, threshold+margin, action-safety gate, drift)
                        ├ pack.ts (64k/32k plan, rank order, pack_shape, split, 16-way concurrency)
                        ├ providers/typesafe.ts ─── HTTPS ──► api.typesafe.ai/v1/systemone
                        ├ providers/llm-structured.ts ─► gateway chat() (kind chat, purpose decide:<slot>)
                        ├ receipts.ts ─► engine-sql/decide.ts ─► decision_receipts, decide_proposals
                        ├ calibrate.ts ─► decide_calibrations  (+ static reference table in the binary)
                        └ budget.ts (daily figure from receipts; BudgetTracker kind decide)
   gateway.ts: one delegating export + recipe touchpoint `decide` (ratchet raise, delegation only)
```

Findings: the dependency direction is clean (callers → decide → providers/engine), with no decide → search
back-edge. New coupling: search stages now depend on `decide/` through one function; justified because every slot
needs the same policy. Storage needs a new engine-sql domain (`decide`) with BrainEngine methods in both engines;
the plan names the tables but not the engine methods, which Eng must specify (routed to Phase 3, not a CEO scope
decision). Scaling: at 10x queries, receipts are the first thing to grow (one row per candidate); the 7-day
retention and indexes bound it; at 100x the account rate limit is the bottleneck and fail-open protects results.
Single points of failure: the TypeSafe endpoint (fail open per slot) and the receipts writer (fire-and-forget,
never blocks). Rollback posture: every slot off restores today's behavior instantly with no data change; the
migrations are additive tables, so a code rollback leaves unused tables behind (harmless). No blocking finding.

**Section 2: Error & Rescue Map.** (registry below.) Findings: every provider failure class now has a named
rescue and user outcome; malformed JSON, missing answers for some question ids, and out-of-range probabilities
were not named in the plan. Decision (Mechanical, P1): a response missing any question id or carrying an
out-of-range or non-numeric value fails that logical decision with `error_reason=malformed_response` and takes the
fail direction; partial answers are never used. Recorded in the Error & Rescue Registry and folded into the Eng
test list.

**Section 3: Security & Threat Model.** Attack surface: one new outbound HTTPS integration, eight CLI
subcommands (local only, thin-client refused), three tables, no new MCP op. Threats: (a) prompt injection flipping
gate outcomes (likelihood High, impact Med): mitigated by signal-only use, deterministic floors, S4 isolation and
agreement rule, action-safety gate, injected-neighbour fixtures. (b) data egress of private content (Med/High):
mitigated by the consent contract and private-visibility query. (c) receipt dictionary attacks (Low/Med): HMAC with
a per-brain salt that config commands never print. (d) spend abuse by remote callers through `query`/`think`
(Med/Low): soft daily cap, fail open. (e) API key handling: env/`.env` only, never logged; doctor shows presence,
not value. (f) S9 memory mutation (Med/High): removed from v1 (proposal-only). No unmitigated High.

**Section 4: Data Flow & Interaction Edge Cases.**

```
 INPUT(query/candidates/windows/facts) -> CONSENT+EGRESS -> PACK -> PROVIDER -> PARSE -> POLICY -> ACT -> RECEIPT
   nil/empty: no candidates -> slot not asked      | refused -> fallback or fail dir | >64k -> split; k shrink
   too long: never truncate; skip item w/ receipt  | timeout/429/5xx -> fail dir     | malformed -> fail dir
   dup/conflict: mixed model ids -> fail open      | stale calibration/pack_shape -> shadow
```

Async ordering: the S3/S5 packed request and the S4 request run concurrently after rerank; the invariant is "no
candidate is pruned or abstained on without its own answer". Both completion orders were traced: S4 finishing
first cannot act before S3's kept set exists because abstention reads only its own answer plus the deterministic
signal, and S3 pruning never reads S4. S6 vs reflex: either order is safe because the response is assembled from
reflex alone when S6 is late. S9 sweep vs a concurrent fact write: a proposal can go stale; `accept` rechecks both
facts. Interaction edges (CLI): `decide enable` twice is idempotent; `proposals accept` on an already-decided id is
refused with its status; `calibrate --dry-run` spends nothing. No unhandled edge after the fixes above.

**Section 5: Code Quality.** Fits existing patterns (applyReranker fail-open, classify-style decision trees,
engine-sql domains, doctor topic modules). DRY: #5178's packing moves from `scripts/lib/` into `src/core/ai/decide/`
so evals and production share one planner (flagged and decided in 0B). Over-engineering risk: nine slots each with
call-site calibration rows; accepted as the stated scope. The policy function has many branches (mode, consent,
margin, action gate, drift, fallback); Eng should split it into small pure helpers to stay under the 5-branch
guideline. No further finding.

**Section 6: Test Review.**

```
 NEW CODEPATH                      TYPE         HAPPY              FAILURE                    EDGE
 pack planner                      unit         fits in 1 batch    >64k split / k shrink      32k single question
 typesafe provider                 unit         3 answer types     429/5xx/timeout/malformed  mixed model ids
 policy (mode/consent/margin/gate) unit         on above threshold uncalibrated -> shadow     margin band, override
 calibrate                         unit+CLI     stores row+sds     overlap split refused      pack_shape mismatch
 receipts writer/flush             PGLite       batched write      exit flush timeout         salt race
 S1..S8 call sites                 PGLite       fixture transport  fail direction each        zero candidates
 S9 sweep + proposals              PGLite       proposal written   stale on accept            no embedding/entity
 migrations v179-v181              E2E PG+PgB   apply + goldens    rerun idempotent           fresh install DDL
 doctor decide_health              unit+E2E     healthy            drift, budget, retired pin alias warning
 eval flags / GBRAIN_DECIDE_SLOTS  CLI          matched arms       refused outside evals      consent still enforced
 all-off byte identity             golden       unchanged output   -                          explain + cache key
```

Gaps found and decided (Mechanical): malformed-response test (Section 2); injected-neighbour fixtures (voices);
load test for deadline success (voices). The keyed live test is opt-in. Prompt/LLM-change evals: the `llm:`
provider adds a structured-output prompt, so the S7 local qualification plus the matched pairs are the required
eval runs.

**Section 7: Performance.** Hot path: worst case adds S2's 150 ms wait plus two serial Jev stages bounded by
`decide.timeout_ms` (1,500 ms) when slots are `on`; shadow adds nothing by default (async). Background: S7/S8 are
one question per request, paced under the 16-way cap; a 200-transcript dream cycle at ~20 windows each is ~4,000
requests, well inside rate limits over a cycle but not inside one minute; Eng must pace. DB: receipts writes are
batched; queries on `(slot, created_at)` and the daily budget sum need the listed indexes. Memory: pack planner
holds one query's candidates; bounded by `top_n_in` (≤100) in production. No blocking issue.

**Section 8: Observability.** Receipts (per decision), `decide status` (readiness, spend, error rate, cost per
unit), `query --explain` lines, doctor `decide_health` (key, alias, uncalibrated `on`, drift, error rate over 5%,
budget, retired pin, egress denials), search meta. Debuggability three weeks later: receipts give slot, model,
p, threshold and outcome per decision without text. Gap decided (Mechanical): receipts also record `call_site`
and `latency_ms` per sub-decision so deadline success rates can be computed from receipts (folded into the
deadline-realism obligation).

**Section 9: Deployment & Rollout.** Migrations are additive `CREATE TABLE` plus indexes; no locks on existing
tables; old binaries ignore the new tables. Rollout order: migrate on upgrade, all slots off, nothing changes.
Feature flags: every slot is its own flag. Rollback: `gbrain decide disable <slot>` (instant), or downgrade the
binary (tables remain, unused). Post-deploy check: `gbrain doctor` shows `decide_health` ok with provider `none`;
`gbrain decide probe` only when a key is configured. Risk: concurrent GBRA threads allocating migration numbers,
handled by next-free numbering at build time.

**Section 10: Long-Term Trajectory.** Debt: nine slots of upkeep across future search and dream refactors
(mitigated by the "how to add a slot" contract and per-slot receipts); reference calibrations must be refreshed
when TypeSafe ships a new model (doctor names it). Reversibility: 4/5 (all slots off is instant; tables persist).
Platform potential: high; C4-C9 slots, a local provider (E6) and online labels (E7) reuse the core. Retrospective
on cherry-picks: E1 was revised twice and grew into UC2's recall experiment; E3-E5 remain small and load-bearing
for operators.

**Section 11: Design & UX.** SKIPPED (no UI scope).

#### Error & Rescue Registry

| Codepath | Failure | Class | Rescued | Action | User sees |
|---|---|---|---|---|---|
| typesafe provider | timeout past deadline | DecideTimeout | Y | fail direction | today's result |
| typesafe provider | HTTP 429 | DecideRateLimited | Y | retry-after only if it fits, else fail direction | today's result |
| typesafe provider | HTTP 5xx / network | DecideProviderError | Y | fail direction, doctor error rate | today's result |
| typesafe provider | 401/403 key | DecideAuthError | Y | fail direction; doctor names key | today's result + doctor warn |
| typesafe provider | 404 pinned model | DecideModelRetired | Y | fail direction; doctor recovery step | today's result + doctor error |
| parse | missing ids / bad values | DecideMalformedResponse | Y | fail the decision, receipt reason | today's result |
| parse | mixed resolved ids | DecideMixedModel | Y | fail open per sub-decision | today's result |
| policy | no consent / private item | DecideEgressRefused | Y | fallback or fail direction; receipt `skipped: egress` | today's result |
| policy | budget exhausted | DecideBudgetExhausted | Y | fail direction; doctor | today's result |
| policy | calibration drift / pack_shape mismatch / action gate | (not an error) | Y | demote to shadow | today's result |
| llm-structured | refusal / schema reject / empty | LlmDecideInvalid | Y | fail direction | today's result |
| receipts writer | DB write fails | ReceiptWriteError | Y | drop batch, counter in status | nothing |
| S9 accept | fact changed | ProposalStale | Y | mark stale | CLI message |
| calibrate | split overlap | CalibrationLeak | Y | refuse with reason | CLI error |

#### Failure Modes Registry

```
  CODEPATH            | FAILURE MODE                     | RESCUED? | TEST? | USER SEES?          | LOGGED?
  --------------------|----------------------------------|----------|-------|---------------------|--------
  S3 evidence gate    | over-prunes real evidence        | Y margin+min_keep+action gate | Y | fewer results | receipt
  S4 abstention       | wrong abstain                    | Y agreement rule+gate | Y | "no evidence" answer | receipt
  S6 recall_needed    | late answer                      | Y reflex-only response | Y | reflex block | receipt
  S7 triage           | buried signal rejected           | Y margin -> LLM triage/pass | Y | no page | receipt
  S8 grounding        | good claim quarantined           | Y insufficient_context lane | Y | quarantine entry | receipt
  S9 sweep            | wrong supersede proposal         | Y proposal-only | Y | pending proposal | receipt
  receipts            | lost on exit                     | Y bounded flush | Y | none | counter
  egress              | private page sent                | Y consent+visibility query | Y | none | receipt skipped
  budget              | overshoot across processes       | partial (soft cap, documented) | Y | none | doctor
```

No row is RESCUED=N + TEST=N + silent, so there is no CRITICAL GAP.

#### NOT in scope

- Deferred (TODOS.md, written by the implementing PR): E6 local decide provider; E7 online calibration labels; E8
  Jev-scored query-expansion decision (A5) as a runtime slot.
- Skipped: E9 MCP `decide_status` op (doctor JSON covers it; decide stays off MCP).
- Taste alternatives not applied: cut v1 to core + 3-4 slots (native voice); land #5178 separately first (native
  voice); local provider in v1 (native voice).
- Plan's own out-of-scope list stands: default flips, C4-C9, A6, chunking/compaction, D2, Jev as a security
  boundary; production candidate depth beyond 100 (measured in evals only).

#### What already exists

The 0B leverage table above maps each sub-problem to reused code. Additionally: `eval-suspected-contradictions.ts`
(S9 runner), `expireSuperseded` (proposal accept), `privatePagesFilterFragment` (egress), `sizeReturnPool` (S3
insertion point), `resolve-ipc.ts` budgets (S6), `QueryIntent` (S2 search question), `verifyDreamPage` (S8).

#### Dream state delta

After this plan GBrain has the whole control plane (typed decisions, receipts, calibration with reference rows,
drift, consent, action-safety gates) and measured verdicts for as many slots as the budget allows, plus a measured
answer to the recall question. Still short of the 12-month ideal: no default-on slots, no local provider, no online
labels, and production candidate depth unchanged until the recall experiment's follow-up.

#### Diagrams

System architecture (Section 1), data flow with shadow paths (Section 4) and the test map (Section 6) are above.

```
 Slot state machine:   off ──enable --shadow──► shadow ──enable (calibrated, gate passes)──► on
                        ▲                        │  ▲                                          │
                        └──────disable───────────┘  └── drift / pack_shape mismatch / gate fail ┘ (per call)
 Invalid: off -> on without calibration or override (refused by enable); on with egress denied for S6-S9 on Jev.

 Error flow:  provider error ─► classify ─► fail direction ─► receipt(error_reason) ─► doctor error-rate
 Deployment:  upgrade ─► migrations v179-v181 (additive) ─► all slots off ─► doctor ok ─► opt-in per slot
 Rollback:    slot misbehaves ─► `decide disable <slot>` (instant) ─► if needed downgrade binary (tables stay)
```

Stale diagram audit: the plan's Architecture diagram now names serve turn-context (updated); no other diagrams in
touched files were found to go stale at this stage (Eng re-audits code-level diagrams).

#### CEO Implementation Tasks

- [ ] **T1 (P1, human: ~3d / CC: ~3h)** — decide core — build `src/core/ai/decide/` (policy, pack, providers, receipts, calibrate, budget) with the consent contract and action-safety gate
  - Surfaced by: Step 0 E2, Spec reviews 1-3, voices (consent, repack_sd, action gate)
  - Files: src/core/ai/decide/*, src/core/ai/gateway.ts, src/core/ai/recipes/typesafe.ts
  - Verify: unit tests for pack/policy/providers/malformed responses
- [ ] **T2 (P1, human: ~1d / CC: ~1h)** — storage — migrations for receipts, calibrations, proposals + engine-sql `decide` domain
  - Surfaced by: Architecture items 7-8, SR1-C3, SR2-L6
  - Files: src/core/schema-migrations/*, src/schema.sql, src/core/engine-sql/decide.ts, both engines
  - Verify: migrations/schema goldens; E2E on Postgres and PgBouncer
- [ ] **T3 (P1, human: ~3d / CC: ~3h)** — slots S1-S9 at their call sites with fail directions
  - Surfaced by: Slots section; SR2/SR3 seam fixes
  - Files: search/hybrid/*, search/rerank.ts, think/*, context/turn-context.ts, cycle/*, facts/write-single.ts
  - Verify: PGLite integration per call site; all-off golden unchanged
- [ ] **T4 (P1, human: ~1.5d / CC: ~1.5h)** — CLI + doctor — `gbrain decide` subcommands incl. `--recommended`, `sweep`, what-if; `decide_health`
  - Surfaced by: CLI section, E3-E5, UC3
  - Files: src/commands/decide.ts, src/cli/commands/decide.ts, src/cli/command-table.ts, src/commands/doctor/checks/decide.ts
  - Verify: CLI goldens, doctor goldens
- [ ] **T5 (P1, human: ~3d / CC: ~4h + eval wall time)** — evals — matched pairs, recall experiment, end-to-end recommended config, local `llm:` qualification, reference calibrations
  - Surfaced by: UC2, UC3, voices (eval validity, deadlines)
  - Files: src/commands/eval-*.ts, docs/eval/system-one/*, reference calibration table
  - Verify: recorded verdicts and raw receipts in docs/eval/system-one/
- [ ] **T6 (P2, human: ~1d / CC: ~45min)** — docs — provider doc, operator guide with "say to your agent", architecture contract, KEY_FILES, TODOS entries, llms rebuild
  - Surfaced by: Docs section, positioning finding
  - Files: docs/ai-providers/typesafe.md, docs/guides/system-one.md, docs/architecture/decide.md, TODOS.md
  - Verify: `bun run build:llms`; `bun test test/build-llms.test.ts`

#### CEO Completion Summary

```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | seams verified; gateway at ceiling; S9     |
  |                      | classifier dead code; live Jev variance    |
  | Step 0               | approach A; 5 cherry-picks; 3 spec reviews |
  | Section 1  (Arch)    | 1 issue (engine-sql domain -> Eng)          |
  | Section 2  (Errors)  | 14 error paths mapped, 1 GAP (fixed)        |
  | Section 3  (Security)| 6 issues found, 0 High unmitigated          |
  | Section 4  (Data/UX) | 9 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 1 issue (policy branching -> Eng)           |
  | Section 6  (Tests)   | Diagram produced, 3 gaps (fixed)            |
  | Section 7  (Perf)    | 1 issue (background pacing -> Eng)          |
  | Section 8  (Observ)  | 1 gap found (fixed)                         |
  | Section 9  (Deploy)  | 1 risk flagged (migration numbering)        |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 2           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (10 items)                          |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 14 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 9 total, 0 CRITICAL GAPS                    |
  | TODOS.md updates     | 3 items proposed (written by the PR)        |
  | Scope proposals      | 12 proposed, 8 accepted (E1-E5, UC1-UC3)    |
  | CEO plan             | written (ceo-plans/2026-09-30-...md)        |
  | Outside voice        | codex completed (9 findings)                |
  | Lake Score           | N/A (no coverage-scored questions)          |
  | Diagrams produced    | 6 (arch, data flow, state, error, deploy,   |
  |                      | rollback) + test map                        |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 0 (taste calls listed for the gate)         |
  +====================================================================+
```

Approval readiness: PASS. Checked rows CEO-D1, CEO-D2, CEO-A1, CEO-M, CEO-H1..H4, CEO-E1..E9, CEO-F1, SR1-*, SR2-*,
launch-3 fixes, UC1-UC3 and the voice dispositions above; all approvals are autoplan auto-decisions under the
owner's "accept all recommendations" instruction, User Challenges included per that instruction.

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"56762e6a997285ce1c9a9e32a81cc80641896cd087000e6631899755a9cbfea4","replacements":[{"oldText":"  100K tokens/s and 40 requests/s per account. Aliases move;","newText":"  and account-wide rate limits that TypeSafe says adjust dynamically (published figures differ by source and\n  date: 100K tokens/s and 40 requests/s in the compendium, 250K tokens/s and 1,200 requests/minute in a\n  2026-09-20 write-up). Aliases move;"},{"oldText":"  experimental. Default flips are out of scope for this PR and need a separate owner decision.","newText":"  experimental. A slot not measured within the paid eval budget records the verdict `not measured` and also stays\n  experimental. Default flips are out of scope for this PR and need a separate owner decision."},{"oldText":"   Config: `decide.provider` (default `none`), `decide.fallback` (`none` default, or `llm`).","newText":"   Config: `decide.provider` (default `none`), `decide.fallback` (`none` default, or `llm:<provider:model>`)."},{"oldText":"New table `decision_receipts` (schema migration). Row: `id, created_at, source_id, slot,","newText":"New table `decision_receipts` (schema migration). Row: `id, decision_id, created_at, source_id, slot,"},{"oldText":"'proposal'|'shadow'|'error'), subject_ref","newText":"'proposal'|'margin_hold'|'error'; shadow rows record the would-be outcome and `mode` says shadow), subject_ref"},{"oldText":"   error_reason`. No query,","newText":"   error_reason, protected, min_keep, rank, k_used` (`decision_id` groups all rows of one logical decision; `protected` marks\n   identity-evidence or floor-protected items so threshold what-ifs can be recomputed exactly). No query,"},{"oldText":"   (default 30), pruned by the existing maintenance cycle.","newText":"   (default 7), pruned by the cycle's existing `purge` phase."},{"oldText":"   metric_value, ece, n, dataset_hash, created_at, notes`.","newText":"   metric_value, ece, retest_sd, repack_sd, action_precision_lb, n, dataset_hash, split_hash, calibrate_ids_hash, calibrate_only, pack_shape,\n   call_site, created_at, notes`."},{"oldText":"decide.fallback              none | llm\n","newText":"decide.fallback              none | llm:<provider:model>\n"},{"oldText":"decide.slots.<slot>.min_keep   (slot-specific, where applicable)\n","newText":"decide.slots.<slot>.min_keep   (slot-specific, where applicable)\ndecide.slots.conflict.proposal_floor  0.50\ndecide.calibrate.retest_n    50  (items re-asked 3 times to measure retest_sd and repack_sd)\ndecide.slots.<slot>.min_action_precision  0.90  (harmful-direction slots)\ndecide.slots.<slot>.shadow_sample  1.0\ndecide.slots.<slot>.shadow_wait    off  (on: await shadow under on deadlines)\ndecide.slots.intent.wait_ms  150\ndecide.slots.recall_needed.suppress_below  0.05\ndecide.egress.typesafe.<class>  deny | allow  (class: query, candidates, facts, conversation; written by\n                             `decide enable` after it shows what leaves the machine)\n(receipt HMAC salt: 32 random bytes generated on first receipt write, stored in the brain config table under an\n internal key that `gbrain config get/list` never prints)\n"},{"oldText":"One `choice` over `temporal | knowledge_update | relational | exact_lookup |\nmulti_hop | other`, state = query only. Launched concurrently with query embedding so it adds no serial latency.\nIn `on` mode it replaces `classifyIntent()` in `think` and feeds the existing arm gates (`relational-recall`,\n`alias-hop`, `exact-lookup`, `date-bounds`, trajectory injection). Below-threshold confidence falls back to the\nregex classifier, which stays the default and the tie source.","newText":"S2 asks one `choice` question per call site, state = the query. Search: `entity | temporal | event | concept |\ngeneral` (the existing `QueryIntent`), launched at the start of `hybrid/request.ts` under a short wait bound; in `on`\nmode an above-threshold label replaces the intent that `classifyQueryWithBrainPatterns` returns, which drives the\nexisting intent weights and detail level. Think: `temporal | knowledge_update | other`, replacing `classifyIntent()`\n(which gates trajectory injection). Arms keep their own detectors; S2 never forces an arm. Below-threshold\nconfidence falls back to the regex classifiers, which stay the default and the tie source."},{"oldText":"`exact_lookup`, `exact_title_match`), never reorder.","newText":"`exact_lookup`, `exact_title_match`), never reorder (S5 is the only post-rerank slot that reorders)."},{"oldText":"In the same packed request: one `noul` over the retained set (\"can `query` be\nanswered from `evidence`?\").","newText":"Two call sites. For the `query` op it is its own request, launched concurrently with the S3/S5\npacked request and never co-packed with candidate questions: one `noul` over the pre-S3 top-k candidates (k = min(10, candidate count), shrunk until state plus the question fits 32k; `k_used`\nis recorded; fail open if k=1 overflows; not asked with zero candidates). Judging a superset of the retained set\nis conservative: it can only under-abstain. For `think` it is one separate call over think's final gathered\nevidence (same k rule), made after gather and before synthesis."},{"oldText":"are moved below clean candidates of equal evidence and wrapped","newText":"are moved below clean candidates of the same `classifyEvidence` class (never below the S3 `min_keep` cut) and wrapped"},{"oldText":"In the `hook user-prompt` path, before reflex resolution:","newText":"In serve's turn-context handler (`src/core/context/turn-context.ts`), which\nanswers the engine-free `hook user-prompt` over IPC, alongside reflex resolution:"},{"oldText":"very low and no exact alias hit exists. Respects the hook's hard self-deadline; on timeout the reflex path runs\nunchanged.","newText":"very low and no exact alias hit exists. Firing retrieval runs the one `search`-mode query defined in the accepted CEO\nrequirements, with the user prompt as the query. S6 runs concurrently with reflex resolution inside the\n400 ms server budget (`TURN_CONTEXT_SERVER_BUDGET_MS`) with its own deadline of at most 250 ms; fire/suppress is\napplied after both finish, and on timeout the reflex result stands unchanged."},{"oldText":"rescue band for the LLM path. Bumps `triage_version` so cached verdicts re-triage once.","newText":"rescue band for the LLM path. `TRIAGE_VERSION` is not bumped: the decide provider and resolved model join the\ntriage cache identity only when S7 is on, so upgrading with S7 off re-triages nothing."},{"oldText":"`gbrain decide proposals [list|accept|reject]` for S9.","newText":"`gbrain decide proposals [list|accept|reject]` for S9.\n- `gbrain decide judge-agreement --suite <suite>`: the eval-only judge harness."},{"oldText":"- Schema migration `v180-decide-calibrations`: `decide_calibrations` with index on `(slot, provider, model_resolved,\n  created_at desc)`.","newText":"- Schema migration `v180-decide-calibrations`: `decide_calibrations` (columns as in Architecture item 8, including\n  `retest_sd` and `split_hash`) with index on `(slot, provider, model_resolved, created_at desc)`.\n- Schema migration `v181-decide-proposals`: `decide_proposals` for S9 pending supersedes, with index on\n  `(status, created_at)`."},{"oldText":"abstention, hook user-prompt, dream triage,","newText":"abstention, serve turn-context for hook user-prompt, dream triage,"},{"oldText":"Runs go to Ubicloud. Each slot gets a matched pair","newText":"Runs go to Ubicloud. Each measured slot gets a matched pair"},{"oldText":"- Hot-path latency: intent runs concurrently with embedding; one packed post-fusion call; fail open at deadline.","newText":"- Hot-path latency: intent waits at most 150 ms; with S1 on Jev and any of S3-S5 on, the query path\n  makes two serial Jev stages (rerank, then the S3/S5 packed request with the S4 request concurrently), each\n  deadline-bound and failing open."},{"oldText":"At or above threshold the result is applied exactly as today's classifier result. A supersede verdict in\n`[proposal_floor, threshold)` is not applied; it writes a receipt with outcome `proposal`, reviewable with\n`gbrain decide proposals` and applied with `gbrain decide proposals accept <id>` through the existing supersede\nwrite path (local CLI only).","newText":"Sweep outcomes, the proposal rule and the `decide_proposals` table follow the accepted CEO requirements: v1\nnever supersedes automatically, the new fact stays as written, and `gbrain decide proposals accept <id>` applies it through the existing supersede write path (local CLI\nonly)."},{"oldText":"`gbrain decide dataset --slot <slot> --from <longmemeval|brainbench|cat35|facts-fixtures> <path>`: builds the","newText":"`gbrain decide dataset --slot <slot> --from <longmemeval|brainbench|cat35|facts-fixtures|injection-fixtures|know-to-ask|grounding-labels> <path>`: builds the"},{"oldText":"callers (search stages, think, hook, dream, facts, evals)","newText":"callers (search stages, think, serve turn-context, dream, facts, evals)"},{"oldText":"- (b) Every slot supports `off | shadow | on`. `shadow` makes the call and writes a decision receipt but changes\n  nothing, so operators can calibrate on real traffic before trusting a slot.","newText":"- (b) Every slot supports `off | shadow | on`. `shadow` makes the call and writes a decision receipt; it changes no\n  ranking, pruning, gating or write and only adds diagnostics (search meta, `--explain` lines), so operators can\n  see real traffic, drift, agreement and latency before trusting a slot. Shadow receipts carry predictions, not\n  correctness labels; thresholds come from labelled datasets or the bundled reference calibrations."},{"oldText":"hot memory already runs an LLM\nduplicate/supersede/independent classifier (`src/core/facts/classify.ts`), and CRAG grading exists","newText":"hot memory decides supersession with a\ndeterministic, zero-LLM cosine rule at write time (`decideSingleFact` in `src/core/facts/single-prepare.ts`: same\nentity and visibility, cosine at least 0.95, same kind supersedes; the LLM classifier in\n`src/core/facts/classify.ts` has no runtime caller), and CRAG grading exists"},{"oldText":"**S9 `conflict` (hot-memory contradiction).** In `src/core/facts/classify.ts`, keep the decision tree (empty →\ninsert; cosine ≥ 0.95 → duplicate; failure → cosine fallback) and replace the chat classifier call with one\npacked request: state = the new fact, one `choice` per candidate (`duplicate | supersede | independent`).","newText":"**S9 `conflict` (hot-memory contradiction).** The fact write path stays zero-LLM and unchanged. S9 is an async\nsweep over facts written since its last run, executed as a tail step of the existing `extract_facts` cycle phase\nonly when the slot is not off (so the phase list and all-off output are unchanged), and on demand with\n`gbrain decide sweep --slot conflict`. For each new fact it takes the `findCandidateDuplicates` neighbours (k=5)\nwith cosine at least 0.80 that pass the same guards `decideSingleFact` applies (same source, entity and\nvisibility, active, and a candidate `source_markdown_slug`, when set, equal to the new fact's `entity_slug`) and sends one packed request: state = the new fact, one `choice` per\ncandidate (`duplicate | supersede | independent`)."},{"oldText":"*Eval:* the hot-memory classifier fixtures and the suspected-contradictions probe set: agreement with the current\nchat classifier, wrong-supersede rate (must not rise), latency and cost per fact.","newText":"*Eval:* a labelled contradiction probe set (the hot-memory classifier fixtures plus the suspected-contradictions\nprobes): agreement with labels versus today's cosine rule, contradictions found that the cosine rule misses,\nwrong-supersede rate (must not rise), cost per swept fact."},{"oldText":"one `noul` (\"does answering this need the user's stored memory?\") and one `choice` over\nmemory class (`person | project | preference | past_event | none`).","newText":"one `noul` (\"does answering this need the user's stored memory?\")."},{"oldText":"pages it did find, and skips the synthesis call. `crag_escalation` runs before abstention when enabled.","newText":"pages it did find, and skips the synthesis call."},{"oldText":"or a full chat-model call (dream triage, hot-memory\ncontradiction classification, the modality tie-break).","newText":"or a full chat-model call (dream triage, the modality\ntie-break)."},{"oldText":"facts classify), receipts written with no text.","newText":"S9 sweep in the `extract_facts` tail and `decide sweep`), receipts written with no text."},{"oldText":"(strong when the top kept candidate clears threshold). Same packed request carries S4 and S5 questions.","newText":"(strong when the top kept candidate clears threshold). The same packed request carries the S5 questions; S4 is a\nseparate request made concurrently (see S4)."},{"oldText":"In `on` mode `think` abstains below threshold:","newText":"In `on` mode `think` abstains below threshold only when a deterministic signal agrees (no identity-evidence hit\nand no strong CRAG grade):"},{"oldText":"decision (A5), chunking","newText":"decision (A5) as a runtime slot (v1 measures expansion only as an arm of the recall experiment), chunking"},{"oldText":"- Single closed vendor: the `llm:` provider makes every slot work without Jev.","newText":"- Single closed vendor: the `llm:` provider makes every slot work without Jev, but its answers are uncalibrated\n  until qualified; v1 qualifies one local `llm:` configuration on S7 for quality and latency. Private brains that\n  keep egress denied effectively run S6-S9 as LLM slots."},{"oldText":"decide.receipts.retention_days 30\n","newText":"decide.receipts.retention_days 7\n"},{"oldText":"never sentences, so judgments keep conversational context), then one packed request per transcript: one `noul`\nper window (","newText":"never sentences, so judgments keep conversational context), then one request per window (unpacked, paced under the\nconcurrency cap): one `noul` per window ("},{"oldText":"find the best source turn window\n(existing normalized-substring and keyword tools) and ask one `noul` (\"is `claim` supported by `source`?\").","newText":"gather up to three candidate source turn\nwindows (normalized-substring, keyword and embedding neighbours) and ask one `noul` (\"is `claim` supported by\n`sources`?\"); weak coverage records `insufficient_context` instead of quarantining."},{"oldText":"the shadow → calibrate → on\n  loop with exact commands,","newText":"the shadow → calibrate (or reference\n  calibration) → on loop with exact commands, `decide enable --recommended`,"}]} -->

<!-- autoplan-accepted:ceo -->
- Rerank depth: no new key. The S1 eval reuses the existing `search.reranker.top_n_in` and treats the recall
  benefit as a hypothesis: first measure fused-pool recall (target present at fused depth 30, 50 and 100 on the
  GBRA-4 and LongMemEval queries), then R@1/R@5 with Jev at `top_n_in` 30, 50 and 100 on the same queries. The eval
  runs with `limit 50` (per-arm `innerLimit` reaches its 100 cap) and an explicit `top_n_in`, so a fused pool of 100
  is reachable; deeper production candidate generation is out of scope (the recall experiment measures a deep
  pool in evals only). Results go in `docs/eval/system-one/`. A unit test
  asserts `top_n_in` bounds the candidates sent to Jev.
- S1 mode contract (the rerank exception to success criterion (c), because a reranker has no threshold): provider
  selection stays `search.reranker.model` exactly as #5178 documents, and S1 `on` uses today's reranker egress
  contract (candidate text goes to the configured reranker, as with Voyage). `decide.slots.rerank.mode off` writes
  no receipts. `shadow` with a non-Jev reranker (Voyage or none): Jev also scores the same `top_n_in` candidates in
  parallel under the rerank deadline, through the decide egress gate, using the TypeSafe key whatever
  `decide.provider` says (no key: skipped with reason `no_key`); receipts record Jev's order plus rank agreement
  (top-1 match, Kendall tau) and results do not change. `shadow` with the Jev reranker behaves as `on`. `on`
  requires `search.reranker.model typesafe:*` and adds receipts and the resolved-model check; `on` without it
  behaves as `off` and doctor warns. There is no calibration row and no drift demotion for rerank; a resolved model
  different from the pinned id is recorded, mixed ids within one decision fail it open, and doctor warns.
- Decision stability (live probe 2026-09-30: identical requests returned 0.53 then 0.51, and 0.74 then 0.62;
  re-packing moved one answer between 0.51 and 0.81): `gbrain decide calibrate` repeats each item 3 times on a
  sample of `decide.calibrate.retest_n` items (default 50), stores `retest_sd` and prints it. Every
  harmful-direction decision (S3 prune, S4 abstain, S6 suppress, S7 fail, S8 quarantine) whose answer lies within
  `max(0.05, 2 * retest_sd)` of the threshold on the harmful side takes the no-change outcome and is recorded as
  `margin_hold`. With an operator threshold and no calibration row, `retest_sd` is 0 (margin 0.05). For S7 the
  no-change outcome is today's LLM triage for that transcript when configured, else pass. S9's near-threshold band
  is its proposal band (below), not `margin_hold`. The pack planner orders questions by candidate rank, then id.
  The packing shape (max questions per batch, question order rule, state template version) is stored in the
  `pack_shape` column of `decide_calibrations` together with the set of slots co-packed in the same request.
  Calibrations are keyed by (slot, call site, provider, model), where the call site distinguishes, for example, S4
  in the `query` op from S4 in `think`, and S2's search question from its think question. Calibration,
  evals and production use the same shape, and `on` refuses a calibration whose `pack_shape` differs and falls back
  to shadow. Each slot's eval reports a decision
  flip rate from running the Jev side twice. Unit tests cover the margin band, `retest_sd` and the shape check.
- Context sensitivity and action safety: `decide calibrate` also re-asks the sampled items with resampled
  co-packed neighbours (3 draws) and stores `repack_sd`; the margin becomes `max(0.05, 2 * max(retest_sd,
  repack_sd))`. S7 windows and S8 units are asked one question per request (background paths, paced under the
  concurrency cap), and S4 is always its own request; S3 stays packed on the hot path with the repack margin. A
  harmful-direction slot (S3, S4, S6 suppress, S7 reject, S8 quarantine) may run `on` only when its calibration's
  `action_precision_lb` (Wilson 95% lower bound of the harmful action's precision on the eval half, reported per
  workload slice) is at least `decide.slots.<slot>.min_action_precision` (default 0.90); otherwise `on` refuses
  with a named reason and the slot stays shadow. S3/S4 evals include injected-neighbour fixtures (an instruction
  candidate co-packed with real evidence) and must show no rise in real-evidence pruning or abstention.
- Thresholds on typed answers: `noul` slots threshold the probability; `choice` slots (S2, S9) threshold
  `probabilities[chosen label]`; S1's `score` is normalized 0..1 and has no threshold. `answer_value` stores exactly
  the thresholded number, `answer_choice` the label, and `retest_sd` is computed on the same number. `min_keep`
  precedence: config override, then the calibration row, then the slot default.
- Calibration lookup: before the call, `on` reads the newest row for (slot, provider, configured pinned model id);
  with an alias configured it uses the model id most recently resolved in receipts. After the response, a
  different resolved id demotes that call to shadow. An operator threshold override is never demoted; doctor lists
  it as an uncalibrated override.
- Calibration holdout: `gbrain decide dataset` writes a frozen calibrate/eval split for every dataset (default
  50/50 by a stable hash of the item id) and records its `split_hash`. `decide calibrate` reads only the calibrate
  half and stores `split_hash`, `calibrate_ids_hash` and `calibrate_only = true`. Eval runs with `--decide` refuse
  (non-zero exit, named reason) any calibration whose `split_hash` differs from the eval split or whose
  `calibrate_only` is false. Tested with a mismatched-split fixture.
- Datasets for every slot: `decide dataset --from` also accepts `injection-fixtures` (S5, from #5178's known cases
  and the retrieval-quality injected cases), `know-to-ask` (S6, BrainBench) and `grounding-labels` (S8). The S8
  label set is a hand-labelled sample of at least 200 claim units from Cat 35 dream pages, committed under
  `docs/eval/system-one/` with generic placeholders only.
- S9 sweep scope: a per-source watermark (last swept fact id) lives under an internal config key. The first run
  starts at the current maximum fact id unless `gbrain decide sweep --slot conflict --since <fact id>` is given, so
  enabling the slot never sweeps the whole history silently. Facts with no embedding or no `entity_slug` are
  skipped with a receipt reason (`no_embedding`, `no_entity`). Candidate guards quote `decideSingleFact`: same
  source, entity and visibility, active and not expired, and a candidate `source_markdown_slug` (when set) equal to
  the new fact's `entity_slug`.
- S9 sweep outcomes (proposal-only in v1): one `choice` per candidate. Any `duplicate` at or above threshold marks
  the pair a duplicate (receipt only; the write path already handles exact and near duplicates). Otherwise a
  `supersede` at or above `proposal_floor` becomes a pending proposal, in `on` mode only; v1 never supersedes
  automatically, because similarity plus a probability does not establish which claim is newer or more credible.
  The new fact stays as written. Everything else is independent. In shadow, receipts only. Proposals live in a new
  table `decide_proposals` (`id, created_at, source_id, new_fact_id, old_fact_id, p_supersede, threshold,
  proposal_floor, model_resolved, status pending|accepted|rejected|stale, decided_at`), never pruned by receipt
  retention. `gbrain decide proposals accept <id>` rechecks that both facts are still active and share source,
  entity and visibility (else marks `stale`), then supersedes old with new through `expireSuperseded` in
  `src/core/facts/write-single.ts`, exported for this use, which sets `superseded_by` and strikes the old line in
  the page's `## Facts` fence; `reject` marks it rejected; accepted proposals are reversible with the existing
  fact restore path, named in the guide. Local CLI only. Tests cover each branch, accept/reject/stale, and that
  neither the sweep nor the inline fact write path supersedes anything without an accept.
- S3 and S4 pipeline position: S3 runs inside `sizeReturnPool` (`hybrid/rank.ts`) between `stampEvidence` and
  adaptive return, and at the equivalent point of the keyword-only path (`hybrid/keyword-only.ts`); "pre-S3" is the
  S4 query-op candidate set. S3 also applies inside `think`'s gather searches (which disable autocut on purpose).
  First-pass bound: the `query` path makes at most two serial decide stages (rerank, then the S3/S5 packed request
  with the S4 request concurrently).
  A `crag_escalation` re-run adds its own rerank call and runs S2-S5 as off on its new candidates (unjudged
  candidates are kept, fail open). `search.crag_think` is outside this bound: it runs `think`, whose decide calls
  are one S2 think question, one S3 request per gather leg and one S4 call.
- S2 call sites: the search question is launched at the start of `hybridSearch` (`hybrid/request.ts`) alongside the
  regex classifier and awaited for at most `decide.slots.intent.wait_ms` (default 150 ms) before detail, weights and
  search options are derived; a late or below-threshold answer uses the regex label (outcome `fallback_regex`), an
  override re-derives detail, weights and options through the same function the regex path uses (outcome
  `override`). `think` asks its question once before gather and passes one precomputed search answer to both
  gather legs. Each question has its own calibration row (call site `search` or `think`).
- S6 details: "fire retrieval" runs one `search`-mode hybrid query (no expansion, limit 3) with the user prompt and
  adds its top results as pointers in the reflex window; it runs only if at least 150 ms of the 400 ms server
  budget remain after S6 (S6 itself at most 250 ms, concurrent with reflex). Suppression requires p below
  `decide.slots.recall_needed.suppress_below` (default 0.05) and no exact alias hit. Pack and delta modes are
  unchanged; S6 only changes the reflex window.
- S7 verdict mapping: for Jev verdicts the segment map is the top windows (at most eight), each quote the first 300
  characters of its window cut at a turn boundary; `entities` come from the existing deterministic entity-mention
  extraction run over those windows; `content_type` comes from one extra `choice` request per transcript over
  the existing content-type labels.
- S5 marking: `think` already wraps all retrieved content as untrusted; S5 `on` adds an `injection_suspected` line
  to that candidate's wrapper and demotes it as above.
- Receipt outcomes per slot: S1 `kept`; S2 `override` or `fallback_regex`; S3 `kept`, `pruned` or `margin_hold`;
  S4 `pass`, `abstain` or `margin_hold`; S5 `demoted` or `kept`; S6 `fire`, `no_fire`, `suppress` or
  `margin_hold`; S7 `pass`, `reject` or `margin_hold`; S8 `pass`, `quarantine`, `insufficient_context` or `margin_hold`; S9 `duplicate`,
  `proposal` or `independent`; any slot `error` or `skipped` (with a reason such as `egress`,
  `no_key`, `no_embedding`, `no_entity`, `late`). The migration's check constraint lists exactly these values.
- Shadow latency: on hot paths (S1 shadow, S2-S6) shadow runs asynchronously by default, sampled by
  `decide.slots.<slot>.shadow_sample` (default 1.0), writes receipts only and adds no meta or explain lines, so it
  adds no user latency. `decide.slots.<slot>.shadow_wait on` awaits shadow under the `on` deadlines and adds the
  diagnostics, for operators who want to measure the true latency cost; the guide states that cost.
- Eval runners: S1-S5 use `eval longmemeval`, `eval brainbench` and `eval retrieval-quality` with `--decide`; S9
  uses `eval suspected-contradictions --decide conflict=on`; S7 and S8 matched pairs, and PrecisionMemBench, run in
  the sibling gbrain-evals harnesses through an eval-only environment override `GBRAIN_DECIDE_SLOTS`
  (for example `triage=on`), which is logged in every receipt's run metadata and honored only as the
  `GBRAIN_DECIDE_SLOTS` item below states.
- Search cache: decide knobs (each non-off slot's mode, effective threshold, `min_keep` and calibration row id) join `knobsHash`
  as an append-only part emitted only when some slot is not off, so the all-off golden stays byte-identical. On a
  cache hit, shadow slots make no call and write no receipt; the operator guide says so.
- Budget: the per-brain daily figure is computed from `decision_receipts` (sum of `input_tokens` times the priced
  rate for the current UTC day, third-party providers only), cached per process for at most 60 s; it covers S2-S9
  and S1 shadow. Jev spend under S1 `on` is recorded as `BudgetKind` `rerank` and governed by today's reranker spend
  controls. `llm:` provider spend is recorded once, by `chat()`, as kind `chat` with purpose `decide:<slot>`, and
  stays under the existing chat spend controls. Pending receipts flush at CLI exit with a 500 ms bound. The daily
  cap is soft (batched receipts and the 60 s cache let concurrent processes overshoot slightly; docs say so), and
  decide spend is still recorded on `BudgetTracker` as kind `decide` for per-process accounting.
- Fallback triggers: only egress-refused items go to `decide.fallback`; timeout, 429, 5xx and an exhausted budget
  take the slot's fail direction directly. Fallback-answered items form their own sub-decision with their own
  `decision_id`, provider, model and threshold lookup, so the mixed-model rule applies per sub-decision. An `on`
  slot whose fallback has no calibration treats those items as shadow.
- Egress consent contract (one rule for every path): a provider receives a data class (query text, candidate page
  text, fact text, conversation text) only with consent for that provider. For decide slots, consent is the
  `decide.egress.typesafe.<class>` keys that `gbrain decide enable` writes after showing exactly what leaves the
  machine; the `llm:` provider inherits today's chat consent. For S1 `on`, configuring `search.reranker.model
  typesafe:*` is the consent for query and candidate text, as it is for Voyage today, and `decide status` shows it.
  S1 shadow and every fallback use the decide consent keys. `decide.egress.deny_sources` applies to every provider
  and path. Private content is never sent without `decide.egress.private=allow`: page candidates are checked by one
  batched query per decision on `(source_id, slug)` using `privatePagesFilterFragment` (which carries the #5525
  derived-origin rule), and facts on `facts.visibility` (default private) and their provenance page. Unit and PGLite
  tests cover private, derived-private, multi-source private, private-fact, denied-source and missing-consent
  cases.
- Eval validity: when `eval longmemeval` runs any `--decide` arm, both arms route with production text-only
  classifiers (the regex path in the baseline, S2 in the intent arm); the dataset's `question_type` labels are used
  only for scoring. `--decide answerable=on` makes the harness reader abstain below threshold, scored on the
  abstention questions. Calibrate/eval splits are made by independent family (conversation, transcript or fixture
  family), keeping related claims and turns together. Timeouts count as failures in every effectiveness number.
- Recall experiment (both CEO voices): the S1 eval compares, on the same queries and under one latency and cost
  budget, (a) today's pipeline, (b) Jev rerank at `top_n_in` 100, (c) a deep fused pool of 300 candidates reranked
  by Jev, and (d) the existing query expansion plus Jev rerank, reporting pool recall, R@1/R@5, answer accuracy,
  p95 latency and cost. The deep pool is an eval-only path (an eval flag that lifts the per-arm cap for that run);
  production candidate depth is unchanged in v1, and a win is recorded as the case for a follow-up. The run also
  reports Jev's top-1 rate on present targets to replicate or refute GBRA-4's 134/134, and a large shortfall
  reorders the remaining measurement plan.
- Reference calibrations and a recommended configuration (both CEO voices): the maintainer's eval runs produce
  reference calibration rows (per slot, call site, model and `pack_shape`, with dataset and split hashes), shipped
  in the binary as a static table and used when a brain has no local row; a local row always wins. `gbrain decide
  enable --recommended` enables exactly the slots whose recorded verdict is a win and whose reference calibration
  passes `min_action_precision`, after showing the egress summary. A reserved share of the eval budget (at most
  $10 of the $40) runs that recommended configuration end to end (answer quality, retained useful memory, full
  dream-cycle cost, p95/p99 latency, harmful outcomes); it must win for `--recommended` to ship non-empty, and
  per-slot ablations explain the result.
- Local `llm:` qualification: one local configuration (an Ollama chat model through `llm:<provider:model>`) is
  measured on S7 against Jev and against today's triage model for quality and latency, so the vendor-independence
  claim is backed by a number; results go in `docs/eval/system-one/`.
- Deadline realism: the evals and a local load test report deadline success rate and p95/p99 per hot-path slot
  (S2 within its 150 ms wait, S6 within 250 ms, the S3/S4/S5 stage within `decide.timeout_ms`) at realistic
  concurrency. S6 never delays the reflex block: the turn-context response is assembled from reflex results when
  S6 has not finished, so the 400 ms IPC budget can never null the block because of S6.
- S8 evidence coverage: S8 gathers up to three candidate source windows per claim (substring, keyword and
  embedding neighbours) and asks one question over all of them. A low answer with weak retrieval coverage (no
  window above the keyword floor) is recorded as `insufficient_context` and keeps today's mechanical result; only
  a low answer with adequate coverage quarantines as `unsupported_paraphrase`. The S8 eval reports
  source-selection recall separately from Jev's judgment and counts useful claims lost.
- Pinned-model retirement: a 404 or "model unavailable" for a pinned id is a provider failure (fail direction
  applies), surfaced by doctor as a named error with the recovery step (repin, then recalibrate or use a
  reference calibration for the new id).
- `GBRAIN_DECIDE_SLOTS` is honored only by eval commands and by `gbrain dream --eval-run`; it never bypasses the
  consent keys, the egress gate or the daily cap.
- Positioning: `docs/architecture/decide.md` and the guide present the durable asset as a provider-agnostic
  decision layer (receipts, calibration, drift, egress) with Jev as the first provider.
- Receipt volume: raw receipts default to 7 days of retention; the E2E seeds a busy-brain volume and verifies the
  receipt indexes serve `decide status` and the daily budget query; the guide gives a rows-per-day estimate.

- S7: when the slot is on, the slot threshold replaces `dream.triage.threshold` for Jev verdicts; the rescue band
  applies only to the LLM path. `dream-retriage` and its spend estimate honor S7 (Jev pricing when S7 is on).
- S8 execution: `verifyBody` stays synchronous and gains one extra output listing the units that pass only because
  they contain no quote, number or attribution, without changing existing fields. S8 runs as a separate async pass
  over those units at both `verifyDreamPage` call sites (`synthesize-verify.ts` and `synthesize-postprocess.ts`),
  under the dream phase budget. On timeout or budget exhaustion the units keep today's mechanical result. S8
  requires `decide.egress.private=allow` for Jev because it sends transcript windows.
- `decide.timeout_ms` bounds one logical decision (all batches).
- Malformed responses: a response missing any requested question id, or carrying a non-numeric or out-of-range
  value, fails that logical decision with `error_reason=malformed_response` and takes the fail direction; partial
  answers are never used. Receipts also carry `call_site` so deadline success rates per call site come from receipts.
- Config and CLI hygiene: every `decide.*` key is registered with validation (enums, numeric ranges) in the config
  key registry. `gbrain decide enable` refuses S6, S7, S8 or S9 on the Jev provider while `decide.egress.private` is
  `deny`, naming the key to change. The `gbrain decide` command table record uses `thinClient: 'refuse'`. The
  receipt HMAC salt is written insert-if-absent and re-read, so concurrent processes agree.
- `gbrain decide sweep --slot conflict` runs the S9 sweep on demand (local CLI only) and prints the counts of
  duplicates, proposals written, independents and skipped facts.
- Module-size ratchets: new logic lives in new modules (`src/core/ai/decide/*`, search stage modules, cycle
  helpers). Facades at or near their ceilings today that this plan touches (`gateway.ts`, `synthesize.ts`, `cli.ts`,
  `mode.ts`, `config.ts`, `eval-longmemeval.ts`, `search/hybrid.ts`, `cycle.ts`) get exact per-file ceiling raises in `scripts/module-size-limits.tsv`
  with notes, in the same commit, limited to delegation lines.
- Migrations take the next free numbers at build time (v179-v181 today) because GBRA-25, GBRA-27 and GBRA-31 are
  active. The keyed live test skips unless `GBRAIN_LIVE_TYPESAFE=1` and a TypeSafe key are set, following the
  repo's keyed-test skip convention, so the default `bun test` never calls the provider.
- `gbrain decide judge-agreement --suite` accepts the existing LLM-judge suites that have labelled sets (the
  LongMemEval answer judge and the dream grounding judge).
- Eval budget rule: the $40 paid ceiling holds. Slots are measured in the plan's expected-value order; a slot not
  measured when the budget runs out gets the recorded verdict `not measured`, stays experimental, and is named as
  such in the CHANGELOG. No slot's verdict is inferred from another slot's run.
- `gbrain decide receipts --slot <slot> --what-if-threshold <t>` recomputes the outcome mix a different threshold
  would have produced from stored `answer_value`, `decision_id`, `protected`, `rank` and `min_keep`, with no
  provider call. The S3 survivor rule is: protected items stay, above-threshold items stay, then the best-ranked
  pruned items return until `min_keep` is met. Covered by a CLI test on seeded receipts, including a case where
  `min_keep` binds.
- When any slot ran in shadow or on, `gbrain query --explain` prints one line per slot: mode, provider and
  resolved model, answer summary, threshold and outcome. With all slots off, explain output is byte-identical to
  today (golden).
- `gbrain decide status` prints a per-slot readiness line computed from local state only (`off`,
  `shadow: N receipts, needs calibration`, `calibrated for <model>, ready for on`, `on`, `on (drift: demoted to
  shadow)`) and an estimated cost per unit for the enabled slots: per 1,000 queries (S1-S5), 1,000 turns (S6),
  1,000 transcripts (S7), 1,000 dream pages (S8) and 1,000 swept facts (S9), from the last 24 hours of receipts or,
  with none, from the pack planner's token estimate for a typical input. Covered by the status JSON golden.
- Rate limits are dynamic: no hardcoded requests-per-second or tokens-per-second constants; concurrency is capped
  at 16 batches and a 429 `retry-after` is honored only when it fits the deadline. Docs cite TypeSafe's published
  limits with a retrieval date and say they change without notice.
- TODOS.md gains three entries in this PR: a local decide provider, online calibration labels, and a Jev-scored
  query-expansion decision (A5).
<!-- /autoplan-accepted:ceo -->

#### Phase 1 close

Close packet `autoplan-ceo-wPu9Yh/close-packet.md` (618 lines) read in full after fixing drift found by the first
packet's verification (S6/S7/S8/S9 base text, two-stage bound, env override wording, sweep counts). Published to the
parent: Phase 1 complete; Codex 9 concerns; native 13 issues; consensus 5/6 confirmed, 1 disagreement to the gate.

### Phase 2 Design review

SKIPPED: no UI scope detected in Phase 0 (not a completed review).

### Phase 2.5 DX review

Methodology reads: `autoplan-dx-methodology-4ZrRQz/methodology.md` read at offsets 1-507, 508-987, 988-1407,
1408-1807 and 1808-2172 (EOF); all 2,172 lines loaded (skip-listed sections loaded only). Hall of Fame sections for
Passes 1-8 read one at a time. Voice input and amendment checkpoint: `autoplan-dx-9gwxKV/dx-implementation.md`
(SHA-256 `6c7f8f14…8e01`), the CEO-amended plan.

#### Step 0 (auto-decided under the owner's accept-all instruction)

- Product type: CLI tool (primary) plus library surface for contributors (`decide()` API) and an agent-operated
  CLI (agents run `gbrain` commands for the user). Not a Claude Code skill, so the skill checklist appendix is
  skipped. Confirmation auto-decided: CLI Tool.
- Mode: DX POLISH (autoplan override): the scope is set; make every touchpoint of that scope bulletproof.

```
TARGET DEVELOPER PERSONA
========================
Who:       A GBrain operator running a personal or company brain for their agents (Bun install, CLI, doctor,
           config keys), often acting through an AI agent that runs the commands for them.
Context:   Heard Jev is fast and cheap; wants better retrieval or cheaper dream triage without risking memory.
Tolerance: About 10 minutes for an optional feature before giving up; zero tolerance for silent behavior changes.
Expects:   `gbrain config set`-style keys, `gbrain doctor` telling them what is wrong, "say to your agent" prompts,
           and nothing happening until they opt in.
```

Empathy narrative (predicted from the plan, not observed): "I have a TypeSafe key. I set it and run `gbrain
decide status`: provider `none`, every slot off. The guide says shadow, then calibrate, then on. I run `gbrain
decide enable evidence` and it refuses: no calibration. I try `--shadow`, it works, and I run a query with
`--explain`: nothing changes and no decide lines appear, because shadow is async. `status` says `shadow: 0
receipts, needs calibration`. I look for how to calibrate and find I need a labelled dataset from LongMemEval or
BrainBench, not my own traffic. Twenty minutes in, I have spent a cent and learned nothing about my own brain. I
flip it off and move on."

Competitive benchmark (evidence types labelled; clocks start with a key in hand):

| Tool | Start → result | Time + evidence type | DX choice | Source |
|---|---|---|---|---|
| TypeSafe Jev (raw API) | key → first answer | ~1 min, reported | one curl, typed answers | jevplayground.com/jev-api |
| Cohere Rerank via LlamaIndex | key → reranked results in an app | ~5 min, estimated from docs | one post-processor object | developers.llamaindex.ai Cohere rerank |
| GBrain Voyage reranker (today) | key → reranked search | ~2 min, estimated from docs | one `config set` + env key | docs/guides/search-modes.md |
| This plan (before DX fixes) | key → first visible decision on own brain | 10+ min for shadow evidence (async shadow shows nothing); hours to `on` without reference calibrations; estimated | many keys, loop requires external datasets | plan text |
| This plan (after DX fixes) | key → `probe --query` preview on own brain | under 3 min, estimated | one command preview, recommended preset | accepted DX requirements |

Target (auto-decided): Competitive, under 5 minutes from key in hand to a visible decision on your own brain;
probe under 2 minutes. Magical moment vehicle (taste, lowest-effort vehicle using existing plan capabilities):
`gbrain decide probe --query "<q>"`, which shows per-result evidence probabilities and Jev's rerank order next to
today's for one real query, changing nothing. Alternative considered: making `query --explain` force shadow only
(kept as well, but it requires enabling a slot first).

Developer journey (traced against the plan and repo docs):

```
STAGE           | DEVELOPER DOES                               | FRICTION POINTS                         | STATUS
----------------|----------------------------------------------|-----------------------------------------|-------
1. Discover     | reads search-modes / providers / AGENTS.md   | decide not linked; providers table lacks column | fixed
2. Install      | already has gbrain; sets TYPESAFE_API_KEY    | provider `none` preconditions undefined | fixed
3. Hello World  | `decide probe`, `probe --query`              | probe needed provider; no own-brain preview | fixed
4. Real Usage   | `enable --recommended` / `enable <slot>`     | enable defaulted to on and refused; S1 split truth | fixed
5. Debug        | `status`, doctor, `--explain`                | silent demotion; no reason catalog; async shadow invisible | fixed
6. Upgrade      | new binary with new reference calibrations   | thresholds could shift silently; default pin moves | fixed
7. Calibrate    | dataset → calibrate → qualify → enable       | no qualification step; call site unspecified | fixed
8. Review S9    | proposals list/accept/undo                   | no fact text; undo path does not exist  | fixed
9. Remove       | `disable --all` / provider none              | kill switch undocumented; S1 not reversed | fixed
```

First-time developer report (predicted): T+0:00 sets key, runs `decide probe`, today: unclear if provider must be
set. T+0:30 `enable evidence` refused (no calibration). T+2:00 enables shadow, `query --explain` shows nothing.
T+5:00 `status` says needs calibration; guide points to datasets. T+10:00 gives up. Every item is addressed by the
accepted DX requirements (probe with key only, `--query` preview, shadow default for `enable`, explain awaits
shadow, readiness line names the real next step, reference calibrations and `--recommended`).

Initial DX completeness rating: 5/10. TTHW today (estimated): 10+ minutes to any visible decision; target under 5.

#### Step 0.5 DX dual voices

- Native voice (Capy child task, claude-opus-5-5 high, verbatim dispatch): completed; result starts `INPUT: dx
  6c7f8f1428c071bee8ac52894b2e0ab5ff6b491ddc62a50c534e6d558dcc8e01`, matching the snapshot. 3 critical, 8 high,
  about 15 medium findings.
- Codex voice (gpt-6-astra, high, read-only): completed, `OUTSIDE_STATUS: completed provider=codex host=claude`,
  10 findings (8 high, 2 medium), 111,460 tokens. Same transport deviation as CEO (stderr shown as its tail only).

Claude SUBAGENT (DX — independent review), summarized: provider-`none` preconditions undefined (critical); silent
effective-mode degradation (critical); `enable` defaults to `on` and is refused on first use (high); the
shadow→calibrate loop cannot run on own traffic and the readiness line misleads (high); outcome vocabulary
contradiction would ship a broken check constraint (high); no per-slot provider (high); no refusal catalog (high);
criterion (b) vs async shadow contradiction (high); override vs action gate undefined (high); plus S1 second source
of truth, default-pin upgrade, `--json` coverage, vocabulary leaks, skipped-reason meta, thin-client message,
quickstart, agent routing, cache-hit counts, blind proposal accept, fixed-vs-configurable table, kill switch,
egress matrix (medium).

Codex SAYS (DX — developer experience challenge), summarized: no complete under-5-minute hello world (high); rerank
breaks off/shadow/on semantics and disable does not reverse Jev activity (high); no qualification step between
calibrate and enable (high); private-data fallback promised but `enable` refuses it; `fallback` misnamed (high);
diagnostics cannot answer "is it working" (high); budget scope misleading (medium); discovery and engine-free help
gaps (medium); upgrades can change thresholds or strand slots (high); promised fact restore path does not exist
(high, verified: no restore path in `src/`); contributor API lacks `callSite` and typed question shapes (medium).

```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?          No      No     CONFIRMED gap (fixed: probe with key, --query preview, quickstart CI)
  2. API/CLI naming guessable?         No      No     CONFIRMED gap (enable default, S1 semantics, egress_fallback)
  3. Error messages actionable?        No      No     CONFIRMED gap (effective mode + refusal catalog)
  4. Docs findable & complete?         No      No     CONFIRMED gap (quickstart, discovery, agent routing)
  5. Upgrade path safe?                No      No     CONFIRMED gap (pinned writes, calibration adoption, undo)
  6. Dev environment friction-free?    Partly  Partly CONFIRMED gap (--json, engine-free help, thin-client message)
CONFIRMED = native + outside agree.
```

No DISAGREE rows and no scope change both voices agree on, so the DX phase adds no User Challenge. Single-voice
criticals (native: provider `none` preconditions, silent degradation) were verified against the plan text and
fixed. One CEO-phase statement was factually wrong and is replaced in the DX accepted requirements: the "existing
fact restore path" does not exist, so the plan now builds `decide proposals undo`.

#### DX passes (DX POLISH)

- **Pass 1 Getting Started: 4 → 8.** No path showed a decision on the operator's own brain inside 5 minutes;
  preconditions undefined. Fixed with probe-with-key, `probe --query`, `enable --recommended` empty state, pinned
  provider writes and a CI-tested quickstart. Residual: key signup time is outside our control.
- **Pass 2 API/CLI Design: 5 → 8.** `enable` defaulted to the refusable mode; S1 semantics diverged from other
  slots; one global provider; `fallback` misnamed; `--json` only on status. Fixed (shadow default, `--on`, S1
  enable/disable reversal, per-slot provider, `egress_fallback`, `--json` goldens, `callSite` in the API).
  Residual: nine slots and many keys remain a large surface; `--recommended` is the golden path.
- **Pass 3 Errors & Debugging: 4 → 8.** Seven silent demotion states; "named reason" never named. Fixed with the
  effective-mode line (problem, cause with values, fix command, docs anchor), the refusal catalog modeled on
  write-refusals, skipped-reason meta and non-zero exits. Traced paths: (1) `enable evidence --on` with no
  calibration → `requested: on / effective: shadow / cause: no_calibration / fix: gbrain decide enable
  --recommended or gbrain decide dataset ...`; (2) S6 enable on Jev with private egress denied → `refused:
  egress_private_denied (missing: decide.egress.private, decide.egress.typesafe.conversation) / fix: ... or set
  decide.slots.recall_needed.provider llm:<model>`; (3) pinned model retired → doctor `pinned_model_unavailable`
  with repin + adopt commands.
- **Pass 4 Documentation: 5 → 8.** No quickstart, no dataset schema, no discovery links, no agent route, shadow
  contradiction. Fixed. Residual: doc volume is large; the guide leads with the golden path.
- **Pass 5 Upgrade & Migration: 5 → 7.** Default pin and reference calibrations could shift behavior on upgrade;
  undo missing. Fixed with pinned writes, explicit calibration adoption, `proposals undo`, upgrade note.
  Residual: TypeSafe retiring a pin is outside our control (doctor recovery path exists).
- **Pass 6 Dev Environment: 5 → 8.** Agents need `--json`; help must work without a brain; thin-client message.
  Fixed. Works on both engines (E2E already in plan).
- **Pass 7 Community & Ecosystem: 6 → 7.** Contributor "how to add a slot" checklist existed; now with a full
  custom-slot example and fixed-vs-configurable table. #5178 credit retained. No further finding.
- **Pass 8 DX Measurement: 5 → 7.** The quickstart CI test measures the documented clock end to end on a fixture;
  `decide status` readiness and effective mode make drop-off visible locally; no telemetry is added (GBrain is
  local-first; telemetry would be a new policy, not in scope). Boomerang: `/devex-review` after implementation
  should time the quickstart on a fresh machine.

#### DX outputs

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      |  8/10  |  4/10  |  ↑     |
| API/CLI/SDK          |  8/10  |  5/10  |  ↑     |
| Error Messages       |  8/10  |  4/10  |  ↑     |
| Documentation        |  8/10  |  5/10  |  ↑     |
| Upgrade Path         |  7/10  |  5/10  |  ↑     |
| Dev Environment      |  8/10  |  5/10  |  ↑     |
| Community            |  7/10  |  6/10  |  ↑     |
| DX Measurement       |  7/10  |  5/10  |  ↑     |
+--------------------------------------------------------------------+
| TTHW                 | <3 min (est.) | 10+ min (est.) | ↑ |
| Competitive Rank     | Competitive                                  |
| Magical Moment       | designed via `gbrain decide probe --query`   |
| Product Type         | CLI tool (+ contributor library API)         |
| Mode                 | POLISH                                       |
| Overall DX           |  7.6/10 |  4.9/10 | ↑     |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered (probe with key, recommended preset)   |
| Learn by Doing     | covered (probe --query on own brain)           |
| Fight Uncertainty  | covered (effective mode + refusal catalog)     |
| Opinionated + Escape Hatches | covered (recommended, force_on, knobs) |
| Code in Context    | covered (quickstart CI, custom-slot example)   |
| Magical Moments    | covered (probe --query)                        |
+====================================================================+
```

```
DX IMPLEMENTATION CHECKLIST
============================
[ ] Time to first visible decision < 5 min from key in hand (quickstart CI on fixture)
[ ] Installation is one command (existing gbrain install; key via env)
[ ] First run produces meaningful output (`decide probe` prints model, latency, cost, next command)
[ ] Magical moment delivered via `gbrain decide probe --query`
[ ] Every refusal/skip has: problem + cause + fix + docs anchor (catalog test)
[ ] CLI naming consistent (enable = shadow, --on explicit, disable reverses)
[ ] Every key has a documented default; `--recommended` is the golden path
[ ] Guide quickstart is copy-paste complete and CI-tested
[ ] Examples use real use cases (probe --query on own brain, custom-slot example)
[ ] Upgrade path documented (skills/migrations note, calibration adoption)
[ ] No breaking changes (all slots default off; S1 default unchanged)
[ ] Types for contributors (discriminated question union, callSite)
[ ] Works in CI without special configuration (fixture transport; live test gated)
[ ] No credit card needed to evaluate locally (fixture path; Jev needs a TypeSafe key)
[ ] CHANGELOG entry
[ ] Docs findable (providers table, search-modes link, AGENTS.md, RESOLVER route)
[ ] Community: #5178 credit, contributor slot guide
```

NOT in scope (DX): telemetry-based TTHW tracking (new policy; local-first product); a hosted playground; SDKs
outside the CLI; an MCP surface for decide (kept off MCP by the CEO phase). Deferred TODO (auto-decided add):
measure the quickstart on a fresh machine with `/devex-review` after implementation.

What already exists (DX): `docs/guides/write-refusals.md` (refusal format to copy), `test/cli-help-without-brain.serial.test.ts`
(engine-free help guard), `gbrain providers` table (`src/commands/providers.ts`), `formatResultsExplain`
(`--explain`), doctor topic modules, `gbrain config set` key registry, the reranker provider doc pattern
(`docs/ai-providers/llama-server-reranker.md`).

#### DX Implementation Tasks

- [ ] **T1 (P1, human: ~1d / CC: ~1h)** — CLI — effective-mode line, refusal catalog, `enable` shadow default + `--on`, pinned writes, `--recommended` empty state, `disable --all`
  - Surfaced by: Pass 2, Pass 3, both voices
  - Files: src/commands/decide.ts, src/core/ai/decide/policy.ts, docs/guides/system-one.md
  - Verify: CLI goldens; catalog coverage unit test
- [ ] **T2 (P1, human: ~4h / CC: ~30min)** — probe — key-only probe and `probe --query` preview
  - Surfaced by: Step 0 magical moment, Pass 1
  - Files: src/commands/decide.ts
  - Verify: CLI test with fixture transport; egress confirmation test
- [ ] **T3 (P1, human: ~1d / CC: ~1h)** — calibration workflow — `qualify`, `--call-site`, dataset schema docs, `calibrations list|adopt|retire`
  - Surfaced by: Codex F3, F8
  - Files: src/core/ai/decide/calibrate.ts, src/commands/decide.ts
  - Verify: end-to-end fixture test dataset → calibrate → qualify → enable
- [ ] **T4 (P1, human: ~6h / CC: ~45min)** — S9 proposals — list with fact text, bulk accept/reject, `undo` with revision check
  - Surfaced by: Codex F9 (restore path does not exist)
  - Files: src/commands/decide.ts, src/core/facts/write-single.ts
  - Verify: PGLite test accept → undo across DB and fence
- [ ] **T5 (P1, human: ~4h / CC: ~30min)** — vocabulary — one canonical outcome table driving the check constraint and docs
  - Surfaced by: native voice (contradiction)
  - Files: src/core/ai/decide/outcomes.ts, migration, docs/architecture/decide.md
  - Verify: sync unit test
- [ ] **T6 (P2, human: ~6h / CC: ~45min)** — docs + discovery — quickstart CI test, providers column, engine-free help, AGENTS.md, RESOLVER route, fixed-vs-configurable table, custom-slot example
  - Surfaced by: Pass 4, Pass 6, Codex F7
  - Files: docs/guides/system-one.md, docs/architecture/decide.md, src/commands/providers.ts, AGENTS.md, skills/RESOLVER.md, test/cli-help-without-brain.serial.test.ts
  - Verify: quickstart CI test; help-without-brain test; `bun run build:llms`
- [ ] **T7 (P2, human: ~4h / CC: ~30min)** — config — per-slot provider, `egress_fallback`, route validation, `status --egress`, `force_on`, `max_concurrency`, `margin_floor`, `--json` everywhere
  - Surfaced by: Pass 2, Codex F4
  - Files: src/core/ai/decide/policy.ts, config key registry, src/commands/decide.ts
  - Verify: unit tests + JSON goldens

Unresolved decisions: none (every DX question auto-decided; taste call: magical-moment vehicle).

<!-- autoplan-baseline-edits:dx {"sourceSha256":"5c9c4b6999c2ec76eefd2fef3d9f0119d8b146c6e6746e146eb514663f033837","replacements":[{"oldText":"\n#### Phase 1 close\n\nClose packet `autoplan-ceo-wPu9Yh/close-packet.md` (618 lines) read in full after fixing drift found by the first\npacket's verification (S6/S7/S8/S9 base text, two-stage bound, env override wording, sweep counts). Published to the\nparent: Phase 1 complete; Codex 9 concerns; native 13 issues; consensus 5/6 confirmed, 1 disagreement to the gate.\n\n### Phase 2 Design review\n\nSKIPPED: no UI scope detected in Phase 0 (not a completed review).\n\n","newText":""},{"oldText":"`decide({ slot, state, questions, deadlineMs, signal })` where each question is\n   `{ id, kind: 'noul'|'choice'|'score', instructions, criteria? }`.","newText":"`decide({ slot, callSite, state, questions, deadlineMs, signal })` where each question is a discriminated\n   union: `{ id, kind: 'noul', instructions }`, `{ id, kind: 'choice', instructions, options: Record<label, description> }`\n   or `{ id, kind: 'score', instructions, levels: string[] }`."},{"oldText":"   Config: `decide.provider` (default `none`), `decide.fallback` (`none` default, or `llm:<provider:model>`).","newText":"   Config: `decide.provider` (default `none`), per-slot `decide.slots.<slot>.provider` (inherits it), and\n   `decide.egress_fallback` (`none` default, or `llm:<provider:model>`; used only for egress-refused items)."},{"oldText":"decide.fallback              none | llm:<provider:model>\n","newText":"decide.egress_fallback       none | llm:<provider:model>   (egress-refused items only)\ndecide.slots.<slot>.provider (inherits decide.provider)\ndecide.max_concurrency       16\ndecide.margin_floor          0.05\ndecide.slots.<slot>.force_on false  (explicit bypass of the action-precision gate; doctor always lists it)\n"},{"oldText":"Refused items are decided by the fallback provider if configured,","newText":"Refused items are decided by `decide.egress_fallback` if configured,"},{"oldText":"- `gbrain decide enable <slot> [--shadow]` / `disable <slot>`: writes the slot config keys with a plain summary of\n  what data leaves the machine.","newText":"- `gbrain decide enable <slot> [--on]` (shadow unless `--on`), `gbrain decide enable --recommended`, and\n  `gbrain decide disable <slot>|--all`: write every key the slot needs (pinned provider, consent keys, mode) in one\n  confirmed step after a plain summary of what data leaves the machine and the estimated cost, then print the\n  requested versus effective mode."},{"oldText":"- `gbrain decide probe`: one tiny live request; prints resolved model, latency and cost; never sends brain content.","newText":"- `gbrain decide probe [--query <q>]`: works with only a key (pinned default provider); one tiny live request that\n  prints resolved model, latency, cost and the next command to run; sends no brain content unless `--query` is given,\n  which previews S1 and S3 on one query of your brain after the egress summary and confirmation, changing nothing."},{"oldText":"only adds diagnostics (search meta, `--explain` lines), so operators can","newText":"adds diagnostics only when shadow is awaited (`shadow_wait on`, or `--explain`, which awaits shadow for that one\n  query), so operators can"},{"oldText":"  `decide_calibrations` row. `--dry-run` estimates cost first.","newText":"  `decide_calibrations` row. `--dry-run` estimates cost first; `--call-site <site>` selects the call site (default:\n  the slot's only site).\n- `gbrain decide qualify --slot <slot> [--call-site <site>] --dataset <jsonl>`: evaluates the newest calibration on\n  the eval half, stores `action_precision_lb` and per-slice results as its qualification, and prints the exact\n  activation command or the catalogued refusal reason."}]} -->

<!-- autoplan-accepted:dx -->
- Quickstart and time to first decision (target under 5 minutes from a key in hand, probe under 2 minutes):
  `docs/guides/system-one.md` opens with one copy-paste block: `export TYPESAFE_API_KEY=...`, `gbrain decide
  probe` (works with only a key and prints the next command), `gbrain decide probe --query "<a question your brain
  can answer>"` (the magical moment: Jev's evidence probability for each result and its rerank order next to
  today's, on your own brain, changing nothing), `gbrain decide enable --recommended` (or `gbrain decide enable
  evidence` for shadow), then `gbrain decide status`, each with its expected output. A CI test runs the block
  against a seeded PGLite brain with a fixture transport and asserts every documented output line; key
  acquisition time is reported separately in the guide.
- Preconditions: `gbrain decide enable` with `decide.provider none` refuses with reason `no_provider` and the exact
  command, unless `--provider <id>` is given, in which case it writes that provider. Every `enable` writes the
  resolved pinned id (never an alias) into the provider key, so a later binary that changes the default pin never
  moves an opted-in brain. `enable --recommended` with no qualifying slot prints "no slot has a recorded win for
  <model>; see docs/eval/system-one/" and exits non-zero without changing config.
- Effective mode everywhere: `decide enable`, `decide status` and a post-set hook on `gbrain config set
  decide.slots.*` print `requested: <mode> / effective: <mode> / cause: <reason> (<values>) / fix: <command> /
  docs: <anchor>` for every slot whose effective mode differs (drift, `pack_shape` mismatch, action-precision
  gate, uncalibrated fallback, S1 without a Jev reranker, budget, missing consent). `enable` exits non-zero when
  the effective mode is lower than requested. Status distinguishes `pending` (no receipts yet), `cache_hit`
  (receipts skipped on cache hits), `blocked` and `demoted`.
- Refusal reason catalog: `docs/guides/system-one.md` gets a table modeled on `docs/guides/write-refusals.md`
  (problem, cause, exact recovery command, docs anchor) for `no_provider`, `no_key`, `no_calibration`,
  `no_qualification`, `pack_shape_mismatch`, `action_precision_low`, `egress_private_denied`,
  `egress_class_denied`, `egress_fallback_missing`, `split_mismatch`, `pinned_model_unavailable`,
  `budget_exhausted`, `thin_client`, `malformed_response`. A unit test asserts every refusal and skip code path
  emits a catalogued reason, and the troubleshooting table is keyed by these reasons.
- One canonical outcome vocabulary: a single exported table in `src/core/ai/decide/` lists every receipt outcome
  and skip reason (the per-slot outcome list in the accepted CEO requirements, which supersedes the shorter list in
  Architecture item 7); the migration's check constraint and `docs/architecture/decide.md` are generated from or
  tested against it, so the three cannot drift. User-facing surfaces say "probability", not `noul`, and one table
  maps slot names to plain words (`answerable` = abstention, `recall_needed` = know-to-ask, `conflict` =
  contradiction).
- Shadow diagnostics: async shadow adds no meta; `--explain` awaits shadow for that one query and prints the decide
  lines, and `shadow_wait on` does so for every query. A fail-open skip adds `meta.decide.<slot>.skipped: <reason>`
  to query meta and a line to `--explain`.
- S1 consistency: `gbrain decide enable rerank --on` sets `search.reranker.model` to the pinned Jev id after the
  confirmation, remembering the previous value, and `gbrain decide disable rerank` restores it, so disabling
  reverses what enabling did. `decide status` prints S1's active reranker, whether Jev is being called, and which
  key supplied the credential.
- Per-slot providers and egress fallback: `decide.slots.<slot>.provider` (inherits `decide.provider`) lets an
  operator run, for example, S3 on Jev and S7 on a local `llm:` model; `decide.fallback` is named
  `decide.egress_fallback` because it only handles egress-refused items. `enable` validates the effective route:
  S6-S9 are refused on Jev with private egress denied only when no permitted per-slot provider or egress fallback
  can handle the refused data, and the refusal names every missing key at once. `gbrain decide status --egress`
  prints a provider by data-class matrix with the key that decides each cell.
- Qualification step: `gbrain decide qualify --slot <slot> [--call-site <site>] --dataset <jsonl>` evaluates the
  newest calibration on the eval half in isolation, stores `action_precision_lb` and per-slice results as its
  qualification, and prints the activation command or the refusal. `calibrate` accepts `--call-site`. The guide
  documents the dataset JSONL schema per slot with a five-line example. Tests cover dataset, calibrate, qualify,
  enable end to end on a fixture.
- Budget wording: `decide.budget.daily_usd` is documented as the budget for third-party decide slots; `enable` and
  `status` show covered spend and the excluded paths (S1 `on` under reranker controls, `llm:` under chat controls)
  with their effective limits.
- Discoverability: `gbrain providers` shows a decide/rerank capability column for the TypeSafe recipe;
  `gbrain decide --help` and every subcommand's help work without a configured brain (added to
  `test/cli-help-without-brain.serial.test.ts`); the thin-client refusal says "`gbrain decide` runs on the brain
  host; run it there"; the guide is linked from `docs/guides/search-modes.md` and the provider docs; AGENTS.md
  "Common tasks" gets one bullet and `skills/RESOLVER.md` a route for enabling System One.
- Upgrade safety: an enabled slot records the calibration it uses (local row id or reference id plus binary
  version). A new binary never silently switches an enabled slot to a newer reference calibration: `decide status`
  shows "newer reference available" with the threshold change, and `gbrain decide calibrations list|adopt
  <id>|retire <id>` adopts, retires or restores rows. The upgrade note in `skills/migrations/` says so.
- Proposal review and undo (replaces the CEO requirement's reference to an existing fact restore path, which does
  not exist at 6c8373c): `gbrain decide proposals list` shows both facts' text locally; `accept` and `reject` accept
  `--all-from <sweep id>`; `gbrain decide proposals undo <id>` reverses an accepted proposal with a revision check
  (clears `superseded_by`, restores the struck `## Facts` fence line), refusing if either fact changed since.
  Tested across database state and the Markdown fence.
- Machine-readable output: `--json` on `probe`, `enable`, `status`, `receipts`, `proposals list`, `calibrate`,
  `qualify` and `sweep`, each with a golden.
- Escape hatches: an operator threshold override does not bypass the action-precision gate;
  `decide.slots.<slot>.force_on true` does, prints a warning on every `enable`/`status`, and doctor always lists
  it. `decide.max_concurrency` (default 16) and `decide.margin_floor` (default 0.05) are configurable;
  `docs/architecture/decide.md` has a "fixed by design versus configurable" table covering window size, window cap,
  S4 k, S6 budgets and S8 window count. `gbrain decide disable --all` and `decide.provider none` stop every slot,
  S1 shadow and the S9 sweep; the guide names both as the kill switch.
- Contributor contract: `decide()` takes an explicit `callSite`, questions are a discriminated union (choice
  options, score levels), and `docs/architecture/decide.md` includes one complete custom-slot example covering both
  providers, calibration lookup and failure handling.
<!-- /autoplan-accepted:dx -->

#### Phase 2.5 close

- Incident, disclosed: the Phase 1 close note and Phase 2 skip record (10 lines of Review record text) were first
  inserted after the wrong `/autoplan-accepted:ceo` marker, inside the Implementation plan. The DX snapshot was
  created before this was noticed, so both DX voices saw those 10 lines at the end of their input (harmless status
  text; no requirement content). The text was moved into the Review record and removed from the plan with the first
  replacement of the recorded DX baseline edit.
- Close packet `autoplan-dx-5xzeHG/close-packet.md` (712 lines) read in full. Verified: every DX decision is in the
  implementation; the DX block states its replacements of CEO wording (restore path, `egress_fallback`, route
  validation). Carry to Eng: the CEO readiness strings (`shadow: N receipts, needs calibration`) should name the
  real next step (reference calibration available, or the dataset command), as the native DX voice asked; the
  effective-mode line already carries the fix command.
- Published to the parent: Phase 2.5 complete; DX 7.6/10; TTHW 10+ min estimated to under 5 min target; Codex 10
  concerns; native 3 critical + 8 high + ~15 medium; consensus 6/6 confirmed.

### Phase 3 Eng review

Methodology reads: `autoplan-eng-methodology-V5eMgE/methodology.md` read at offsets 1-484, 485-944, 945-1364,
1365-1784 and 1785-2257 (EOF); all 2,257 lines loaded. Voice input and checkpoint:
`autoplan-eng-3qpAAl/eng-implementation.md` (SHA-256 `344aabc6…295b`, the CEO+DX-amended plan; no stray review text).

#### Step 0 Scope Challenge (scope accepted as-is; autoplan override: never reduce)

- What already solves each sub-problem: see the CEO leverage table. Additional code facts: search-side auxiliary
  tables already use `engine.executeRaw` from their own modules (`src/core/search/telemetry.ts`,
  `src/core/search/query-cache.ts`), with telemetry buffering registered on `registerBackgroundWorkDrainer`
  (`src/core/background-work.ts`, #4143 PGLite teardown deadlock). `engine.ts` (2,670/2,670),
  `pglite-engine.ts` (3,374/3,374) and `postgres-engine.ts` (3,393/3,393) are at their ceilings.
- Complexity: well over 8 files and 2+ new services, so the complexity gate trips. Feature cuts: none proposed
  (override). Structure question auto-decided: Original arrangement, with one structural choice: decide storage via
  `executeRaw` in `src/core/ai/decide/store.ts` (telemetry pattern) instead of new `BrainEngine` methods plus an
  engine-sql domain (taste; both viable; the chosen one avoids raising three engine ceilings and matches the
  closest precedent). Scope record: feature answers none (no cuts); structure A (auto); accepted scope: as
  amended by CEO and DX; pending remedies: none.
- Search check: gating plus calibration plus fail-open is Layer 1 practice; per-lane concurrency is standard; the
  one [Layer 3] call is using Jev's cheapness to widen candidate pools (measured, not shipped).
- TODOS cross-reference: nothing in TODOS.md blocks this plan; seven follow-ups written (below).
- Distribution: no new binary artifact; the recipe ships inside the existing `gbrain` binary.

#### Step 0.5 Eng dual voices

- Native voice (Capy child task, claude-opus-5-5 high, verbatim dispatch): completed; result starts `INPUT: eng
  344aabc6195a68917ec935b13077faa76b230253e6a78409f55c976bad1e295b`, matching the snapshot. 6 high, 7 medium, plus
  a missing-test list, security notes and hidden-complexity notes.
- Codex voice (gpt-6-astra, high, read-only): completed, `OUTSIDE_STATUS: completed provider=codex host=claude`,
  17 findings (1 critical, 13 high, 2 medium, 1 low), 177,794 tokens.

Claude SUBAGENT (eng — independent review), summarized: Wilson-LB 0.90 gate unreachable with planned datasets
(15/15 gives 0.796); S9 accept/undo rest on best-effort `expireSuperseded` and undo misses `expired_at`/`valid_until`;
id watermark skips facts under concurrent commits; account-wide rate limits shared by background and hot lanes; no
total query decide deadline; budget computed from fire-and-forget receipts. Medium: S6 fire-retrieval latency,
S7 max-over-windows length bias and `worth_processing` column, S8 persistence ordering, S9 egress premise, receipt
volume and CHECK constraint, cache vs drift, spec contradictions. Security: remote spend amplification, plaintext
slugs, salt exposure, co-packing injection.

Codex SAYS (eng — architecture challenge), summarized: S9 acceptance bypasses the managed-write coordinator and
undo is incomplete (critical); sweep neighbours include the new fact itself; id watermark unreliable; `decide()`
cannot enforce egress without typed provenance; qualification survives policy changes; qualification and runtime
execute different reducers; S3 drops the `relational_pinned` protection; S4 "superset" claim is false; S6 retrieval
has no enforceable budget and IPC overrun nulls the block; S1 rubric scores feed autocut/CRAG thresholds; receipts
cannot be the spend ledger; shadow shares the ambient budget tracker; S7 lacks transcript completeness; `llm:`
structured-output guarantees; receipts cannot replay non-threshold reducers and leak slugs; S1 activation vs
conservative mode and kill switch; semantic cache is disabled at this commit.

Every Codex and native claim that named code was verified: `expireSuperseded` (`write-single.ts:271`) warns and
continues; managed brains route through `managed-fact-write.ts` (`write-single.ts:128`);
`findCandidateDuplicates` does not exclude a fact id; `relational_pinned` stamps exist
(`relational-rerank-pin.ts:190`); conservative mode sets `reranker_enabled: false` (`mode.ts:424`);
`semanticResultCacheAvailable()` returns false (`query-cache.ts:35`); Wilson 95% lower bound at 15/15 is 0.796.

```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Architecture sound?               Shape yes, contracts gaps  Same  CONFIRMED (fixes applied)
  2. Test coverage sufficient?         No      No     CONFIRMED gap (test plan artifact)
  3. Performance risks addressed?      No      No     CONFIRMED gap (lanes, query budget, shadow isolation)
  4. Security threats covered?         Partly  Partly CONFIRMED gap (provenance, HMAC slugs, salt, remote cap)
  5. Error paths handled?              No      No     CONFIRMED gap (S9 transactional, S7 completeness, malformed)
  6. Deployment risk manageable?       Yes w/ gate  Yes w/ fixes  CONFIRMED (internal delivery gate)
```

No DISAGREE rows; no scope change both voices agree on (both keep one PR and nine slots), so no Eng User
Challenge. Single-voice criticals (Codex: S9 persistence path) verified and fixed.

#### Section 1 Architecture

```
            query/think (CLI, MCP)      serve turn-context (hook IPC)     dream cycle / decide sweep
                    │                              │                                │
        hybrid/request.ts (S2 wait ≤150ms)    turn-context.ts (S6 ≤250ms,     cycle/synthesize (S7 lanes bg)
        applyReranker (S1) → rank.ts            keyword-only fire, parent     synthesize-verify + postprocess (S8)
        sizeReturnPool: stampEvidence →         deadline, reflex first)       extract_facts tail (S9 sweep)
          S3/S5 packed ∥ S4 (diag) → autocut           │                                │
        think: S2 think q, gather S3, S4 final        │                                │
                    └───────────────┬──────────────────┴────────────────┬───────────────┘
                                    ▼                                   ▼
             src/core/ai/decide/  policy (mode, consent, provenance, fingerprint, margin, lanes, budget)
                                  pack (64k/32k, rank order, pack_shape) → providers/{typesafe, llm-structured}
                                  store.ts (executeRaw: receipts, spend, calibrations, proposals, sweep state)
                                  buffer → registerBackgroundWorkDrainer      reference calibration table (static)
                                    │                                   │
                         gateway.ts decide() export (1 delegating block)   BudgetTracker kind 'decide' (+ own shadow scope)
```

Findings and dispositions (auto-decided, P5/P3): storage pattern (taste, above); spend ledger separate from
receipts; typed evidence with provenance before serialization; lanes; per-request query budget; shadow budget
isolation; S1 score semantics and activation. Realistic production failure per integration: TypeSafe 429 storm
during a dream run (lanes + backoff), IPC overrun (reflex-first), provider model retirement (doctor recovery),
managed-brain supersede partial write (transactional accept). All applied in the Eng accepted requirements.

#### Section 2 Code quality

- DRY: one canonical protection predicate shared by S3, S5, autocut and return sizing (Codex H7); one action
  reducer per slot shared by production, qualify and evals (Codex H6); #5178's planner moves into `decide/pack.ts`.
- Error handling gaps: `expireSuperseded` warn-and-continue unsuitable for an operator-visible accept (fixed);
  malformed responses (CEO fix retained).
- Complexity: `policy.ts` must stay a set of small pure reducers; per-slot reducers live beside their call sites.
- Diagram accuracy: the plan's Architecture diagram lacks store/lanes; the Eng diagram above supersedes it for
  implementers (stale-diagram note).
- Spec contradictions carried by immutable earlier blocks (item 7 outcome list, `decide.fallback` in the CEO block,
  CHECK constraint, S4 superset) are superseded explicitly in the Eng accepted requirements and a baseline edit.

#### Section 3 Test review

Framework: Bun test (`bun test`, `scripts/run-unit-parallel.sh`), PGLite in-memory integration, Postgres and
PgBouncer E2E (`bun run test:e2e`), goldens with `GBRAIN_TEST_UPDATE_GOLDENS=1`.

```
CODE PATHS                                             USER FLOWS
[+] decide/pack.ts                                     [+] Quickstart (probe → probe --query → enable → status)
  ├── [GAP→unit] budget split, k shrink, rank order      └── [GAP→E2E] CI quickstart on seeded PGLite
  └── [GAP→unit] pack_shape hash                       [+] Activation
[+] decide/providers/typesafe.ts                         ├── [GAP→unit] no_provider / effective-mode line
  ├── [GAP→unit] noul/choice/score parse                 ├── [GAP→unit] insufficient_n / policy_changed
  ├── [GAP→unit] malformed, mixed model, 404 retired     └── [GAP→CLI] enable/disable rerank ownership
  └── [GAP→unit] 429 retry-after within deadline       [+] S9 review
[+] decide/providers/llm-structured.ts                   ├── [GAP→PGLite] accept fence-fail stays pending
  └── [GAP→unit] capability check, unknown identity      └── [GAP→PGLite] undo restores expired_at/valid_until
[+] decide/policy.ts                                   [+] Error states
  ├── [GAP→unit] consent/provenance/private classes      ├── [GAP→unit] refusal catalog coverage
  ├── [GAP→unit] margin, action gate, fingerprint        └── [GAP→unit] skipped meta reasons
  └── [GAP→unit] lanes, query budget `late`
[+] decide/store.ts + buffer                            LLM/eval: [→EVAL] per-slot matched pairs, recall
  ├── [GAP→PGLite] receipts/spend/sweep writes            experiment, recommended end-to-end, local llm: S7,
  └── [GAP→unit] drain registration, salt insert-once     judge agreement
[+] call sites S1-S9 (fixture transport)
  ├── [GAP→PGLite] each fail direction, all-off golden
  ├── [GAP→PGLite] S7 incomplete coverage, length strata
  ├── [GAP→PGLite] S8 before persistence (2 sites)
  └── [GAP→PGLite] S9 self-exclusion, interleaved commits
[+] migrations                                          
  └── [GAP→E2E] PGLite/PG/PgBouncer + DDL parity + volume seed

COVERAGE: 0/33 planned paths tested today (all new code) | every path has a planned test in the artifact
QUALITY target: ★★★ on policy, S9, egress, budget; ★★ acceptable on formatting-only CLI output
```

Regression rule: existing behavior at risk is everything on the all-off path; the approved regression contract is
criterion (a) (byte-identical goldens) plus the canonical protection predicate test for relational pins. Test plan
artifact written to `~/.gstack/projects/garrytan-gbrain/user-feat-system-one-v1-eng-review-test-plan-20260930-180032.md`.
Eval suites required (prompt/LLM change): the per-slot matched pairs, the recall experiment, the recommended-config
end-to-end run and the local `llm:` S7 qualification, all inside the $40 ceiling with per-slot spend estimates.

#### Section 4 Performance

Hot path: bounded by `decide.query_budget_ms`; shadow adds nothing by default; S3/S5 receipts sampled at 0.1 in
shadow. N+1: the egress check is one batched query per decision; calibration lookup cached per process. Memory:
bounded by `top_n_in` (≤100) and the shadow queue cap. Background: S7 unpacked windows paced at 4 concurrent; a
200-transcript cycle at ~20 windows is ~4,000 requests (about 17 minutes at 4 concurrent and ~250 ms each; Eng
accepts this for a background phase and records it in the eval). DB: receipts at 10k queries/day with sampling is
~100k rows/day, 7-day retention ~700k rows, indexed on `(slot, created_at)`.

#### Failure modes registry (Eng)

```
  CODEPATH              | FAILURE MODE                        | RESCUED?            | TEST? | USER SEES           | LOGGED?
  ----------------------|-------------------------------------|---------------------|-------|---------------------|--------
  S9 accept             | fence strike fails mid-supersede    | Y transactional     | Y     | CLI error, pending  | receipt
  S9 sweep              | uncommitted lower id skipped        | Y lag + deferred    | Y     | none                | sweep state
  hot lanes             | dream saturates account limit       | Y lanes + backoff   | Y     | fail open           | lane in receipts
  query path            | stacked stage timeouts              | Y query budget      | Y     | fail open, `late`   | receipt
  spend                 | lost buffered rows undercount       | partial (soft cap)  | Y     | none                | doctor
  shadow                | ambient budget starves foreground   | Y own scope         | Y     | none                | receipt
  S7                    | missing window timeout → reject     | Y incomplete path   | Y     | none                | receipt
  S8                    | page persisted before S8            | Y ordering          | Y     | none                | receipt
  S1                    | rubric scores trip autocut cliff    | Y semantics gate    | Y     | none                | meta
  S6                    | IPC overrun nulls block             | Y reflex-first      | Y     | reflex block        | receipt
  egress                | evidence without provenance sent    | Y refuse            | Y     | none                | receipt skipped
```

No CRITICAL GAP (every row rescued and tested; the soft-cap undercount is documented, not silent).

#### NOT in scope (Eng)

Cross-process lane coordination (TODO); production depth beyond 100 (TODO, gated on the recall experiment);
semantic-cache integration beyond knobs (cache disabled at this commit, TODO); per-caller remote quotas beyond the
remote-share sub-cap.

#### What already exists (Eng)

`search/telemetry.ts` (buffered executeRaw writer + drainer), `search/query-cache.ts` (executeRaw pattern),
`background-work.ts`, `budget-tracker.ts` reservations, `managed-fact-write.ts` (coordinator), `forget.ts`
(`forgetFactInFence`), `relational-rerank-pin.ts`, `hybrid/keyword-only.ts`, `resolve-ipc.ts` budgets,
`private-visibility.ts` (`privatePagesFilterFragment`), `eval-suspected-contradictions.ts`.

#### Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| Foundation | src/core/ai/decide/, src/core/ai/recipes/, src/core/schema-migrations/, src/schema.sql, src/commands/decide*, src/commands/doctor/checks/ | — |
| Retrieval slots S1-S5 | src/core/search/hybrid/, src/core/search/, src/core/think/ | Foundation (+ S1/S3 gate) |
| Context slot S6 | src/core/context/ | Foundation + S1/S3 gate |
| Write-path slots S7-S9 | src/core/cycle/, src/core/facts/ | Foundation + S1/S3 gate |
| Evals + docs | src/commands/eval-*, src/eval/, docs/ | slots it measures |

Lane A: Foundation → S1+S3 (gate). Then launch B (S2, S4, S5), C (S6), D (S7-S9) in parallel. Merge all into the
one branch. Then E (evals, docs). Conflict flags: `src/core/search/mode.ts` and `src/core/config.ts` (keys, knobs)
are shared by A, B and D; serialize edits there through Lane A's registry.

#### Eng Implementation Tasks

- [ ] **T1 (P1, human: ~1d / CC: ~1h)** — storage — `decide/store.ts` via executeRaw + drainer; spend ledger; remote-share cap
  - Surfaced by: Step 0 storage; native H6; Codex H11
  - Files: src/core/ai/decide/store.ts, src/core/background-work.ts (registration only)
  - Verify: PGLite + PG E2E; teardown drain test
- [ ] **T2 (P1, human: ~1d / CC: ~1h)** — qualification — shared reducers, family-level Wilson, `insufficient_n`, policy fingerprint
  - Surfaced by: native H1; Codex H5, H6
  - Files: src/core/ai/decide/calibrate.ts, src/core/ai/decide/policy.ts
  - Verify: n=15/35 boundary tests; fingerprint mismatch demotes
- [ ] **T3 (P1, human: ~1d / CC: ~1h)** — S9 — transactional accept/undo via coordinator; sweep self-exclusion, lag watermark, deferred retries
  - Surfaced by: native H2, H3; Codex C1, H2, H3
  - Files: src/core/facts/managed-fact-write.ts, src/core/facts/write-single.ts, src/core/ai/decide/sweep.ts
  - Verify: fence-failure, interleaved-commit, undo tests
- [ ] **T4 (P1, human: ~6h / CC: ~45min)** — runtime safety — lanes, query budget, shadow budget isolation, typed provenance
  - Surfaced by: native H4, H5; Codex H4, H12
  - Files: src/core/ai/decide/policy.ts, src/core/ai/decide/pack.ts
  - Verify: contention test; `late` test; foreground-near-budget test
- [ ] **T5 (P1, human: ~6h / CC: ~45min)** — slot seams — protection predicate, S4 coverage/diagnostic, S6 keyword-only fire, S7 completeness, S8 ordering, S1 score semantics/activation
  - Surfaced by: Codex H7-H10, H13, M16; native M7-M9
  - Files: src/core/search/hybrid/rank.ts, src/core/think/, src/core/context/turn-context.ts, src/core/cycle/, src/core/search/autocut.ts, src/core/search/crag.ts
  - Verify: PGLite call-site tests listed in the test plan
- [ ] **T6 (P2, human: ~4h / CC: ~30min)** — privacy + hygiene — HMAC subject_ref, salt exclusion test, sanitized public receipts, TS-enforced outcomes, llm: capability check, alias-rollout doctor line
  - Surfaced by: native security notes; Codex M14, M15
  - Files: src/core/ai/decide/*, src/commands/doctor/checks/decide.ts
  - Verify: salt-exclusion test; sync test
- [ ] **T7 (P2, human: ~2h / CC: ~15min)** — delivery — S1+S3 gate before other lanes; per-slot eval spend estimates
  - Surfaced by: native hidden-complexity note
  - Files: docs/eval/system-one/
  - Verify: gate checklist in PR body

#### Eng Completion summary

- Step 0: Scope Challenge — scope accepted as-is (structure A; storage via executeRaw, taste)
- Architecture Review: 7 issues found (storage, spend ledger, provenance, lanes, query budget, shadow isolation, S1 semantics)
- Code Quality Review: 4 issues found (protection predicate, shared reducer, expireSuperseded, spec contradictions)
- Test Review: diagram produced, 33 planned paths, all gaps assigned tests in the artifact
- Performance Review: 3 issues found (receipt volume, background pacing, hot-lane contention)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 7 items written to TODOS.md (uncommitted)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex completed (17 findings)
- Parallelization: 5 lanes, 3 parallel / 2 sequential
- Lake Score: N/A (no coverage-scored questions)

Approval readiness: PASS (all Eng remedies auto-decided under the owner's accept-all instruction; taste call:
storage pattern).

<!-- autoplan-baseline-edits:eng {"sourceSha256":"9701e1e03a2a51b1a38adc8a2d848053debab83a466554936651526f9728cfc7","replacements":[{"oldText":"outcome ('kept'|'pruned'|'abstain'|'fire'|'no_fire'|'pass'|'reject'|\n   'proposal'|'margin_hold'|'error'; shadow rows record the would-be outcome and `mode` says shadow), subject_ref (page slug / fact id / transcript path hash), latency_ms, input_tokens,","newText":"outcome (one value from the canonical outcome table in `src/core/ai/decide/`; shadow rows record the would-be outcome\n   and `mode` says shadow), subject_ref (HMAC of page slug / fact id / transcript path, never plaintext), call_site, lane,\n   policy_fingerprint, latency_ms, input_tokens,"},{"oldText":"Judging a superset of the retained set\nis conservative: it can only under-abstain.","newText":"For the `query` op the result is diagnostic only\n(`meta.answerability`); no abstention happens there."},{"oldText":"never prune results carrying identity evidence (`alias_hit`,\n`exact_lookup`, `exact_title_match`),","newText":"never prune a result the canonical protection predicate protects\n(identity evidence `alias_hit`, `exact_lookup`, `exact_title_match`, and `relational_pinned` graph answers),"}]} -->

<!-- autoplan-accepted:eng -->
- Storage pattern: receipts, spend rows, calibrations, proposals and sweep state are read and written through
  `engine.executeRaw` in `src/core/ai/decide/store.ts`, following `src/core/search/telemetry.ts` and
  `src/core/search/query-cache.ts`, so no `BrainEngine` method and no engine facade grows. No JSONB columns (or
  `executeRawJsonb` if one becomes necessary). Buffered writes register with `registerBackgroundWorkDrainer`
  (`src/core/background-work.ts`) for the CLI's bounded teardown drain, never a raw exit hook (PGLite deadlock
  history, #4143); this is the mechanism behind the "flush at CLI exit" requirement. E2E runs on PGLite, Postgres
  and PgBouncer.
- Spend ledger (replaces receipts as the budget source): every provider request writes one `decide_spend` row
  (request_id, created_at, source_id, provider, model_resolved, lane, remote, input_tokens, cost_usd, outcome
  `ok|failed|timeout|malformed`); failed and timed-out requests are charged their estimated input tokens. Admission
  reserves the estimate on the process `BudgetTracker` before sending and settles after. The daily figure sums
  `decide_spend`; the cap is documented as soft in both directions (lost buffered rows and concurrent processes).
  Remote-triggered spend (from MCP `query`/`think`) is counted separately and capped by
  `decide.budget.remote_share` (default 0.5 of the daily cap); `decide status` shows local versus remote spend.
- Qualification you can actually pass: `decide qualify` computes `action_precision_lb` over independent families
  (query, transcript or fact family) after the full production action reducer (margins, floors, protections,
  S4 agreement rule), refuses with `insufficient_n` and prints the required n when the harmful actions are too few
  for the bound to reach `min_action_precision` (for example 35 of 35 correct is the minimum at 0.90), and gates on
  the pooled result with per-slice numbers advisory unless the dataset names gated slices. Datasets are sized for
  at least 60 expected harmful actions per slot where the source data allows. The plan's expectation for v1:
  S3 and S7 are likely qualifiable; S4 and S8 likely are not with current datasets and ship shadow-only unless
  qualification passes. Production, `qualify` and evals share one action reducer per slot.
- Policy fingerprint: each qualification is bound to an immutable fingerprint of the action policy (threshold,
  margin rule, floors, protections, prompt/question version, evidence selection, call site, `pack_shape`). A
  mismatch at runtime, including an operator threshold override that differs from the qualified one, demotes to
  shadow with reason `policy_changed`; only `force_on` bypasses it. Receipts carry the fingerprint.
- S9 accept and undo are transactional: on managed brains they run as coordinator mutations through the managed
  fact-write path (`managed-fact-write.ts`); on unmanaged brains through a checked supersede that returns a result
  instead of `expireSuperseded`'s warn-and-continue. Both store the before and after state (`expired_at`,
  `valid_until`, `superseded_by`, the fence row and page revision) and apply database and fence changes as one
  unit; a partial write fails the operation and leaves the proposal `pending`. `undo` restores all four fields and
  the fence row with a revision check. Tests: fence-strike failure, retry, concurrent accept, intervening withdrawal,
  undo restoring `expired_at`/`valid_until`.
- S9 sweep correctness: the new fact is excluded from its own neighbours before the limit (eligibility filters
  first, then the five nearest); each pair is judged and recorded independently (a duplicate pair does not suppress
  a supersede proposal against another neighbour); unordered pairs are deduplicated with the proposed direction
  recorded; proposals carry `sweep_id` and a unique pair index. The per-source watermark only advances past facts
  created more than 60 seconds ago (commit-order lag), and facts skipped for transient reasons (`no_embedding`,
  provider failure) go to a deferred table retried on later sweeps with an attempt cap. Tested with interleaved
  commits. These tables join the proposals migration.
- Lanes: hot lanes (S1-S6) use `decide.max_concurrency` (16); background lanes (S7, S8, S9, calibrate, qualify)
  use `decide.background_concurrency` (default 4) and back off first on 429. Receipts and spend rows record
  `lane`. Coordination is per process; the guide says so.
- Query decide budget: `decide.query_budget_ms` (default 1500) bounds all decide work of one `query` request (S2
  wait, S1 rerank, the S3/S5 and S4 stage); later stages get the remainder and skip with `late`. `think` has the
  same budget per call. The deadline-realism eval reports p99 total added latency.
- Typed evidence and egress: `decide()` state and question content are typed evidence items (`text`, `class`,
  `source_id`, and `slug`, `fact_id` or `transcript_ref`, plus visibility). The policy checks the provenance of every
  item before serialization; items with missing provenance are refused. S1 shadow checks egress before the reranker
  reduces results to strings.
- One canonical protection predicate (`alias_hit`, `exact_lookup`, `exact_title_match`, `relational_pinned`, identity
  tiers) is shared by S3, S5, autocut and return sizing. Tests cover graph-only answers through adaptive return and
  token limits.
- S4 honesty: the abstention decision covers exactly the evidence `think` will synthesize from (pages, takes,
  trajectory rendered as evidence items). If coverage is incomplete (k shrink, egress-withheld items, evidence
  omitted), the verdict is `incomplete` and `think` does not abstain. The agreement rule uses the deterministic CRAG
  grade computed without the S3-derived `decide_evidence` input. (Supersedes the CEO/DX wording that S4 over the
  pre-S3 top-k is a conservative superset: it is not; that result is diagnostic only.)
- S6 retrieval: "fire retrieval" is one keyword-only search (`hybrid/keyword-only.ts`, no embedding call, limit 3)
  under an absolute parent deadline with cancellation, with nested decide slots off and the hook's source,
  private-page and safe-chunk restrictions applied. The reflex block is assembled first and returned unchanged if
  S6 or its retrieval misses the deadline. The eval reports fire-success rate.
- S1 score semantics and activation: the TypeSafe recipe declares its score semantics (four-level rubric). Until
  the S1 eval ships calibrated values, autocut's score-cliff and CRAG's strong-evidence grade do not consume Jev
  rubric scores (they use their existing non-score behavior). The S1 eval measures the final returned evidence,
  not only rerank order. S1's effective activation includes `search.reranker.enabled` and the search mode
  (conservative mode disables reranking); `decide enable rerank --on` sets the model and enabled flag, warns in
  conservative mode, is idempotent and records ownership so `disable` restores only configuration it still owns.
  `decide.provider none` stops decide slots and S1 shadow, not an operator-chosen Jev reranker (documented).
- Shadow isolation: detached shadow work runs with its own bounded budget scope (not the ambient request
  `BudgetTracker`), a bounded in-flight queue, and background-work drain registration. A test runs foreground work
  near budget exhaustion with shadow active and asserts the foreground call is unaffected.
- S7 completeness: the transcript is one logical decision. It is rejected only when every window completed under a
  compatible model and policy; incomplete coverage takes the S7 no-change path and never caches a rejection. A turn
  over the request limit splits at paragraph boundaries and is marked. Calibration and qualification use the
  transcript-level maximum, stratified by window count. For Jev rows the triage cache's `worth_processing` is
  written from the S7 decision, and every reader of that column is audited. On `margin_hold` the LLM triage result
  is the cached verdict.
- S8 ordering: S8 completes, or times out to the mechanical result, before the page is persisted at both
  `verifyDreamPage` call sites; tested at the `synthesize-postprocess.ts` site.
- S9 egress: facts default to `visibility: private`, so S9 on Jev requires `decide.egress.private=allow` in practice;
  `enable` shows the share of facts that would be refused and suggests the `llm:` route.
- Receipt volume and vocabulary: in shadow, S3 and S5 default `shadow_sample` to 0.1 (on-mode decisions are always
  recorded). The outcome vocabulary is enforced in TypeScript with a sync test against the docs, not with a
  database CHECK constraint (supersedes the CEO/DX wording that the migration's check constraint lists the values).
- Cache: the semantic result cache is disabled at 6c8373c (`semanticResultCacheAvailable()` returns false), so the
  decide part of `knobsHash` is future compatibility; it also includes the last resolved model id.
- `llm:` provider guarantees: a capability check refuses `on` for providers whose path ignores structured output;
  answers are strictly validated; model identity comes from the provider-reported snapshot, else an endpoint plus
  model fingerprint; unknown identity is shadow-only.
- Receipts privacy and replay: `subject_ref` is HMACed; the salt is excluded from every config surface
  (`config get/list`, config snapshot, MCP config reads, exports), with a test. `--what-if-threshold` supports only
  slots whose reducer is threshold-only and exactly reproducible from receipts (S3, S7, S8) and says "not
  reproducible" for others. Public eval receipts go through a sanitizer; no production receipts are committed.
- Doctor names alias rollouts (mixed resolved ids across a decision under `jev-latest`) explicitly.
- Delivery gate inside the one PR: the foundation lane plus S1 and S3 must pass unit, PGLite and golden tests before
  the other slot lanes start; a slot that is not fully wired with tests is not registered and ships nowhere, rather
  than half-wired. The eval plan carries a per-slot spend estimate before runs start.
<!-- /autoplan-accepted:eng -->

#### Phase 3 close

Close packet `autoplan-eng-1xdLti/close-packet.md` (811 lines) read in full; verified the Eng block and its explicit
supersessions of earlier wording. Published: Phase 3 complete; Codex 17 concerns; native 13 issues; consensus 6/6.

### Phase 4 Final Approval Gate (autoplan)

Pre-gate verification: CEO (premise challenges, 10 sections, Error & Rescue and Failure Modes registries, NOT in
scope, What already exists, dream state delta, completion summary, consensus table) present; Design skipped (no UI
scope, recorded); DX (8 scores, journey map, empathy narrative, TTHW, checklist, consensus table) present; Eng
(scope challenge, architecture diagram, test diagram, test plan on disk, NOT in scope, What already exists,
failure modes, completion summary, consensus table) present. Every phase ran both voices to completion.

Approval: the owner pre-authorized "accept all recommendations", so the gate is recorded as APPROVED with every
recommendation applied, including the three User Challenges below. The owner can reverse any of them.

**Plan summary.** One integrated PR adds a provider-agnostic `decide` capability (Jev first, `llm:` second) with
receipts, calibration, qualification, drift and consent, wired into nine default-off slots, a recall experiment, a
recommended configuration and matched baseline-vs-feature evals under $40.

**Decisions: 61 total (49 mechanical, 9 taste, 3 user challenges).**

User Challenges (applied under the accept-all instruction; original direction listed so it can be restored):
- UC1 (CEO spec review 2, verified in code): you said S9 replaces the chat classifier inside `facts/classify.ts`.
  That classifier has no runtime caller; supersession is a zero-LLM cosine rule in `decideSingleFact`. Change: S9
  is an async, proposal-only sweep in the `extract_facts` tail plus `gbrain decide sweep`; the write path is
  untouched. Might be missing: you may want inline conflict decisions at write time. If wrong: contradictions are
  found minutes later instead of at write time.
- UC2 (both CEO voices): you put deeper candidate generation and the expansion decision (A5) out of scope. Change:
  the S1 eval adds a four-arm recall experiment (today, Jev at 100, a 300-deep pool eval-only, expansion + Jev).
  Production depth is unchanged. Might be missing: eval spend. If wrong: a few dollars of the $40 buy a negative.
- UC3 (both CEO voices): you framed shadow as the way to calibrate on real traffic. Receipts carry no labels, so
  that loop cannot close. Change: bundled reference calibrations, `gbrain decide enable --recommended`, and a
  reserved end-to-end eval (at most $10) that must win for the preset to ship non-empty. If wrong: extra eval spend
  and a preset that may ship empty.

Taste choices (recommended option taken): keep S5 injection (#6); S4 in `query` is diagnostic only, abstention only
in `think` over complete evidence (#18, revised by Eng); async sampled shadow by default (#29, reverses #24); S9
proposal-only (#28); keep all nine slots rather than the native CEO voice's 3-4 slot cut (#33); keep #5178 closed
after this PR rather than landing it first (#34); local classifier provider deferred, local `llm:` qualified on S7
instead (#35); magical moment via `gbrain decide probe --query` (#39); storage via `executeRaw` like
`search/telemetry.ts` rather than new BrainEngine methods (#52).

Review scores: CEO SELECTIVE EXPANSION, native 13 + Codex 9, consensus 5/6 (scope disagreement to taste). Design
skipped (no UI). DX 4.9 → 7.6/10, TTHW 10+ min (estimated) → under 5 min target, native + Codex, consensus 6/6. Eng
native 13 + Codex 17, consensus 6/6, 0 critical gaps after fixes.

Cross-phase themes: calibration and qualification must actually be passable (CEO, DX, Eng); one egress and consent
contract with provenance (CEO, DX, Eng); S9 mutation safety (CEO spec, CEO Codex, DX Codex, Eng both); latency and
deadline budgets on hot paths (CEO Codex, DX, Eng); operator burden and effective-mode visibility (CEO, DX); spend
accounting that survives lost writes (CEO spec, DX Codex, Eng).

Deferred to TODOS.md (written, uncommitted): local decide provider; production depth beyond 100 if the recall
experiment wins; online calibration labels; Jev expansion decision (A5); cross-process lane coordination; decide
knobs when the semantic cache returns; fresh-machine quickstart timing.

Implementation tasks (aggregated across phases; two CEO rows are superseded by later phases: CEO T2's engine-sql
domain → Eng T1's `executeRaw` store, and DX T5's CHECK constraint → Eng's TS-enforced vocabulary):

- [ ] **T4 (P1, human: ~1.5d / CC: ~1.5h) — CLI + doctor** — gbrain decide subcommands incl. --recommended, sweep, what-if; decide_health doctor check
  - Surfaced by: ceo-review — CLI section; E3-E5; UC3
  - Files: src/commands/decide.ts, src/cli/commands/decide.ts, src/cli/command-table.ts, src/commands/doctor/checks/decide.ts
- [ ] **T1 (P1, human: ~3d / CC: ~3h) — decide core** — Build src/core/ai/decide/ (policy, pack, providers, receipts, calibrate, budget) with the consent contract and action-safety gate
  - Surfaced by: ceo-review — Step 0 E2; spec reviews 1-3; CEO voices (consent, repack_sd, action gate)
  - Files: src/core/ai/decide/, src/core/ai/gateway.ts, src/core/ai/recipes/typesafe.ts
- [ ] **T5 (P1, human: ~3d / CC: ~4h) — evals** — Matched pairs, recall experiment, end-to-end recommended config, local llm qualification, reference calibrations
  - Surfaced by: ceo-review — UC2; UC3; voices (eval validity, deadlines)
  - Files: src/commands/, docs/eval/system-one/
- [ ] **T3 (P1, human: ~3d / CC: ~3h) — slots** — Wire S1-S9 at their call sites with documented fail directions
  - Surfaced by: ceo-review — Slots section; SR2/SR3 seam fixes
  - Files: src/core/search/hybrid/, src/core/search/rerank.ts, src/core/think/, src/core/context/turn-context.ts, src/core/cycle/, src/core/facts/write-single.ts
- [ ] **T2 (P1, human: ~1d / CC: ~1h) — storage** — Migrations for decision_receipts, decide_calibrations, decide_proposals plus engine-sql decide domain
  - Surfaced by: ceo-review — Architecture items 7-8; SR1-C3; SR2-L6
  - Files: src/core/schema-migrations/, src/schema.sql, src/core/engine-sql/decide.ts, src/core/pglite-engine.ts, src/core/postgres-engine.ts
- [ ] **T3 (P1, human: ~1d / CC: ~1h) — S9** — Transactional accept/undo via coordinator; sweep self-exclusion, lag watermark, deferred retries
  - Surfaced by: eng-review — native H2, H3; Codex C1, H2, H3
  - Files: src/core/facts/managed-fact-write.ts, src/core/facts/write-single.ts, src/core/ai/decide/sweep.ts
- [ ] **T2 (P1, human: ~1d / CC: ~1h) — qualification** — Shared reducers, family-level Wilson, insufficient_n, policy fingerprint
  - Surfaced by: eng-review — native H1; Codex H5, H6
  - Files: src/core/ai/decide/calibrate.ts, src/core/ai/decide/policy.ts
- [ ] **T4 (P1, human: ~6h / CC: ~45min) — runtime safety** — Lanes, query budget, shadow budget isolation, typed provenance
  - Surfaced by: eng-review — native H4, H5; Codex H4, H12
  - Files: src/core/ai/decide/policy.ts, src/core/ai/decide/pack.ts
- [ ] **T5 (P1, human: ~6h / CC: ~45min) — slot seams** — Protection predicate, S4 coverage, S6 keyword-only fire, S7 completeness, S8 ordering, S1 score semantics/activation
  - Surfaced by: eng-review — Codex H7-H10, H13, M16; native M7-M9
  - Files: src/core/search/hybrid/rank.ts, src/core/think/, src/core/context/turn-context.ts, src/core/cycle/, src/core/search/autocut.ts, src/core/search/crag.ts
- [ ] **T1 (P1, human: ~1d / CC: ~1h) — storage** — decide/store.ts via executeRaw + background-work drainer; spend ledger; remote-share cap
  - Surfaced by: eng-review — Step 0 storage; native H6; Codex H11
  - Files: src/core/ai/decide/store.ts, src/core/background-work.ts
- [ ] **T1 (P1, human: ~1d / CC: ~1h) — CLI** — Effective-mode line, refusal catalog, enable shadow default + --on, pinned writes, --recommended empty state, disable --all
  - Surfaced by: devex-review — Pass 2, Pass 3, both DX voices
  - Files: src/commands/decide.ts, src/core/ai/decide/policy.ts, docs/guides/system-one.md
- [ ] **T4 (P1, human: ~6h / CC: ~45min) — S9 proposals** — Proposals list with fact text, bulk accept/reject, undo with revision check
  - Surfaced by: devex-review — Codex DX F9: no fact restore path exists
  - Files: src/commands/decide.ts, src/core/facts/write-single.ts
- [ ] **T3 (P1, human: ~1d / CC: ~1h) — calibration** — decide qualify, --call-site, dataset schema docs, calibrations list/adopt/retire
  - Surfaced by: devex-review — Codex DX F3, F8
  - Files: src/core/ai/decide/calibrate.ts, src/commands/decide.ts
- [ ] **T2 (P1, human: ~4h / CC: ~30min) — probe** — Key-only probe and probe --query preview (magical moment)
  - Surfaced by: devex-review — Step 0 magical moment; Pass 1
  - Files: src/commands/decide.ts
- [ ] **T5 (P1, human: ~4h / CC: ~30min) — vocabulary** — One canonical outcome table driving the check constraint and docs
  - Surfaced by: devex-review — Native DX: outcome list contradiction
  - Files: src/core/ai/decide/outcomes.ts, src/core/schema-migrations/, docs/architecture/decide.md
- [ ] **T6 (P2, human: ~1d / CC: ~45min) — docs** — Provider doc, operator guide with say-to-your-agent, architecture contract, KEY_FILES, TODOS entries, llms rebuild
  - Surfaced by: ceo-review — Docs section; positioning finding
  - Files: docs/ai-providers/typesafe.md, docs/guides/system-one.md, docs/architecture/decide.md, TODOS.md
- [ ] **T7 (P2, human: ~2h / CC: ~15min) — delivery** — S1+S3 gate before other lanes; per-slot eval spend estimates
  - Surfaced by: eng-review — native hidden complexity
  - Files: docs/eval/system-one/
- [ ] **T6 (P2, human: ~4h / CC: ~30min) — privacy + hygiene** — HMAC subject_ref, salt exclusion test, sanitized public receipts, TS-enforced outcomes, llm capability check, alias-rollout doctor line
  - Surfaced by: eng-review — native security; Codex M14, M15
  - Files: src/core/ai/decide/, src/commands/doctor/checks/decide.ts
- [ ] **T7 (P2, human: ~4h / CC: ~30min) — config** — Per-slot provider, egress_fallback, route validation, status --egress, force_on, max_concurrency, margin_floor, --json everywhere
  - Surfaced by: devex-review — Pass 2, Codex DX F4
  - Files: src/core/ai/decide/policy.ts, src/core/config.ts, src/commands/decide.ts
- [ ] **T6 (P2, human: ~6h / CC: ~45min) — docs + discovery** — Quickstart CI test, providers column, engine-free help, AGENTS.md bullet, RESOLVER route, fixed-vs-configurable table, custom-slot example
  - Surfaced by: devex-review — Pass 4, Pass 6, Codex DX F7
  - Files: docs/guides/system-one.md, docs/architecture/decide.md, src/commands/providers.ts, AGENTS.md, skills/RESOLVER.md, test/cli-help-without-brain.serial.test.ts

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|-----------|-----------|----------|----------|
| 1 | CEO | Review depth implementation-ready | Mechanical | P1 | Default depth; owner asked for a full review | strategy-only |
| 2 | CEO | Enable cross-project learnings | Mechanical | P6 | Recommended option; local only | project-scoped |
| 3 | CEO | Plan doc is the design doc; no /office-hours | Mechanical | P6 | Newest repo doc under docs/designs is this plan | run /office-hours |
| 4 | CEO | Approach A: decide core + 9 slots | Mechanical | P1 | Owner's big-v1 direction; B cuts scope, C lacks evidence | B smallest, C orchestration rewrite |
| 5 | CEO | Mode SELECTIVE EXPANSION | Mechanical | override | Autoplan CEO override | other modes |
| 6 | CEO | Keep S5 injection | Taste | P1 | Rides S3's packed request; signal-only; borderline value | defer S5 |
| 7 | CEO | Keep S8 grounding, S2 intent, judge harness | Mechanical | P1 | No scope cuts on a complete plan | defer each |
| 8 | CEO | E1 wide-pool rerank + recall-at-depth eval | Mechanical | P1/P2 | Targets 270/404 recall misses; in blast radius | defer |
| 9 | CEO | E2 stability margin + packing parity + flip rate | Mechanical | P1 | Live probe shows 0.1-0.25 mid-band movement | ignore nondeterminism |
| 10 | CEO | E3 receipts what-if threshold | Mechanical | P2 | Small, reuses stored answers | skip |
| 11 | CEO | E4 per-slot explain lines | Mechanical | P2 | Existing surface; off byte-identical | skip |
| 12 | CEO | E5 status readiness + cost estimate | Mechanical | P2 | Operator next step from local state | skip |
| 13 | CEO | E6 local provider, E7 online labels, E8 A5 expansion | Mechanical | P3 | Outside blast radius or new infra | include |
| 14 | CEO | E9 MCP decide_status | Mechanical | P4/P5 | Doctor JSON already covers; decide stays off MCP | include |
| 15 | CEO | Correct published rate-limit claim (baseline edit) | Mechanical | P5 | Sources disagree; treat as dynamic | keep stale figure |
| 16 | CEO | Eval budget rule: unmeasured slots = `not measured` | Mechanical | P1 | $40 ceiling may not cover 9 judged pairs | infer verdicts |
| 17 | CEO | Spec review 1: 27 fixes applied (holdout, cache key, receipts ids, proposals table, S6 in serve, S2 mapping, no TRIAGE_VERSION bump, S1 contract, margin_hold, datasets, budget source) | Mechanical | P1/P5 | Each verified in code; required for criteria (a)-(f) | leave gaps |
| 18 | CEO | S4 judges pre-prune top-k in the shared request | Taste | P3/P5 | No extra serial call; conservative direction | separate post-prune S4 call (+1 serial Jev call) |
| 19 | CEO | E1 revised: reuse `search.reranker.top_n_in`, sweep 30/50/100 | Mechanical | P4 | DRY with existing key; MAX_SEARCH_LIMIT caps 100 | new `pool_size` key, pool 200 |
| 20 | CEO | Spec review 2: 37 fixes applied (S2 to QueryIntent, S6 budget, egress query, fallback table, S4 think call, eval harness routing, ratchets) | Mechanical | P1/P5 | Each verified in code | leave gaps |
| 21 | CEO | UC1: retarget S9 from the dead inline classifier to an async sweep | User Challenge | P1/P5 | Premise wrong: no runtime LLM classifier; keeps write path zero-LLM | inline Jev call in the fact write path; cut S9 |
| 22 | CEO | Remove S6 memory-class question | Mechanical | P4 | No consumer | keep |
| 23 | CEO | Spec review 3: 21 fixes applied after the cap | Mechanical | P1/P5 | Verified in code; unconfirmed by a fourth launch (cap) | leave as reviewer concerns |
| 24 | CEO | Shadow slots awaited under on-mode deadlines | Taste | P5 | Honest latency preview | detached shadow with no meta |
| 25 | CEO | 0H document approval A | Mechanical | P6 | Both documents match decisions | revise/pause |
| 26 | CEO | UC2: four-arm recall experiment (deep pool 300 eval-only, expansion arm) | User Challenge | P1 | Both voices: recall is the larger lever | leave recall out of scope |
| 27 | CEO | UC3: reference calibrations + `decide enable --recommended` + end-to-end eval gate | User Challenge | P1 | Both voices: shadow cannot calibrate; operator burden | per-brain calibration only |
| 28 | CEO | S9 proposal-only in v1 | Taste | P1 | Codex critical: probability should not retire memory | auto-supersede above threshold+margin |
| 29 | CEO | Async sampled shadow by default (reverses #24) | Taste | P5 | Native: awaited shadow taxes users | awaited shadow |
| 30 | CEO | Repack sensitivity, unpacked S4/S7/S8, action-precision gate | Mechanical | P1 | Both voices | packed gates, calibration only |
| 31 | CEO | Per-provider consent contract | Mechanical | P5 | Codex: privacy rule varied by call site | call-site exemptions |
| 32 | CEO | Eval validity, deadline realism, S8 coverage, pin retirement, env override limits, 7-day receipts | Mechanical | P1 | Voice findings verified | leave as is |
| 33 | CEO | Keep all nine slots (no cut to 3-4) | Taste | P1 + owner rule | Only native voice recommends a cut | cut S2/S5/S8/S9/judge |
| 34 | CEO | Keep #5178 closed after this PR (not landed first) | Taste | owner rule | Single voice; one integrated PR | land #5178 first |
| 35 | CEO | Local classifier provider stays deferred; qualify local `llm:` on S7 | Taste | P3 | New infra outside radius | local provider in v1 |
| 36 | CEO | Malformed-response handling fails the whole decision | Mechanical | P5 | Partial answers are never trusted | use partial answers |
| 37 | DX | Product type CLI tool; mode DX POLISH; persona GBrain operator (often via agent) | Mechanical | override/P6 | Inferred from README and plan | other personas |
| 38 | DX | TTHW target Competitive (<5 min from key) | Mechanical | P5 | Peer raw API ~1 min, reranker config ~2 min | Champion (<2 min) needs key-less path |
| 39 | DX | Magical moment via `decide probe --query` | Taste | P5 | Lowest-effort vehicle on existing plan surface | `query --explain` forcing shadow only |
| 40 | DX | Provider preconditions, pinned writes, recommended empty state | Mechanical | P1 | Native critical | leave undefined |
| 41 | DX | `enable` defaults to shadow, `--on` explicit, `disable --all` | Mechanical | P5 | Pit of success | enable = on |
| 42 | DX | Effective-mode line + refusal catalog | Mechanical | P1 | Both voices | named reasons unspecified |
| 43 | DX | One canonical outcome table | Mechanical | P4 | Contradiction would break the check constraint | two lists |
| 44 | DX | `--explain` awaits shadow; skipped-reason meta | Mechanical | P5 | Criterion (b) contradiction | invisible async shadow |
| 45 | DX | S1 enable/disable reverses reranker selection | Mechanical | P5 | Codex: disable did not stop Jev | leave split |
| 46 | DX | Per-slot provider; rename to `egress_fallback`; route validation | Mechanical | P1/P5 | Both voices | single provider |
| 47 | DX | `decide qualify` step and `--call-site` | Mechanical | P1 | Codex: gate had no producer | implicit qualification |
| 48 | DX | Calibration adoption on upgrade; proposals undo (restore path absent) | Mechanical | P1 | Codex, verified in code | silent upgrade shifts; claimed undo |
| 49 | DX | `--json`, discovery, engine-free help, AGENTS/RESOLVER routes | Mechanical | P1 | Agents are first-class users | status-only JSON |
| 50 | DX | `force_on`, configurable concurrency/margin, fixed-vs-configurable table | Mechanical | P5 | Escape hatches | hardcode silently |
| 51 | DX | Budget wording shows covered vs excluded spend | Mechanical | P5 | Codex | rename key |
| 52 | Eng | Scope accepted as-is; structure A; storage via executeRaw like search/telemetry.ts | Taste | P4/P5 | Avoids three engine ceilings; closest precedent | new BrainEngine methods + engine-sql domain |
| 53 | Eng | Spend ledger separate from receipts; remote-share sub-cap | Mechanical | P1 | Both voices | budget from receipts |
| 54 | Eng | Family-level qualification, `insufficient_n`, shared reducers, policy fingerprint | Mechanical | P1 | Gate unreachable as written (0.796 at 15/15) | per-slice gate on small sets |
| 55 | Eng | Transactional S9 accept/undo via coordinator; sweep self-exclusion, lag watermark, deferred retries | Mechanical | P1 | Codex critical, verified | expireSuperseded warn-and-continue |
| 56 | Eng | Lanes, per-request query budget, shadow budget isolation, typed provenance | Mechanical | P1/P5 | Both voices | shared ambient budget |
| 57 | Eng | Canonical protection predicate incl. relational_pinned; S4 abstains only on complete coverage | Mechanical | P1 | Codex, verified | superset claim |
| 58 | Eng | S6 keyword-only fire, reflex-first; S7 completeness; S8 before persistence; S1 score semantics/activation | Mechanical | P1 | Both voices | leave undefined |
| 59 | Eng | TS-enforced outcomes (no CHECK); S3/S5 shadow sample 0.1; HMAC subject_ref; salt exclusion; sanitized receipts | Mechanical | P5 | Native, verified | CHECK constraint, plaintext slugs |
| 60 | Eng | Internal delivery gate: foundation + S1 + S3 before other lanes | Mechanical | P6 | Native hidden complexity; keeps one PR | parallel from start |
| 61 | Eng | TODOS.md auto-written (7 items) | Mechanical | P3 | Eng phase rule | leave to PR |

- 2026-09-30 owner approval: plan approved with one change, on/off as the only main modes and shadow never
  recommended (see "Owner decision: on/off" in the Implementation plan). All three User Challenges stand as applied.
