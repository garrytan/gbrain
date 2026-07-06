# MBrain Deep Analysis & Next-Wave Spec — 2026-07-06

| | |
|---|---|
| **Date** | 2026-07-06 |
| **Status** | Decision-ready analysis + direction spec (owner review pending) |
| **Baseline** | `master@7f3d2a56` — the *same commit* the 2026-07-04 wave-hardening audit examined; no code has landed since. |
| **Method** | Five fresh parallel deep-dives (product/idea-space map, architecture quantification, governance write-lifecycle walk, retrieval pipeline walk, external agent-memory landscape survey) + a live-instance health check, layered on top of the six-audit findings of `2026-07-04-mbrain-wave-hardening-spec.md`. All new `file:line` evidence was read in-tree on 2026-07-06; line numbers drift, symbol names are authoritative. |
| **Relationship to prior specs** | This spec **does not replace** `2026-07-04-mbrain-wave-hardening-spec.md` — that spec's P0–P4 roadmap remains the authoritative gap-closure plan and is incorporated by reference (§4). This spec adds: (a) new correctness findings the audit missed (§5), (b) new retrieval cost findings (§6), (c) a structural assessment with sequencing (§7), (d) a strictly *additive* brainstorm of new directions grounded in the mid-2026 external landscape (§8), and (e) an integrated roadmap (§9). Direction bets D-1..D-5 keep their ownership in `2026-07-03-mbrain-direction-bets.md`. |

## Addendum — 2026-07-06 (post-analysis, same day)

Written a few hours after the analysis below was frozen; the body's §3/§4 "nothing has landed" statements describe the `7f3d2a56` baseline and are superseded as follows:

- **PRs #299/#300 landed on master (`30c36b9f`, v0.15.0)** implementing the 2026-07-04 spec's P0 wave and more: migrate-on-connect for local engines (OP-1), schema-version handshake in `get_health` and honest `schema_out_of_date` errors (OP-2), the 0.15.0 release with `skills/migrations/v0.15.0.md` (OP-3), PGLite parity timeout budget (OP-4), review-UI session token + same-origin checks (SEC-1) and related hardening. §4's status table should be read accordingly.
- **This spec's new P1 items GH-1, GH-2, GH-3 (as contract documentation), GH-4, and UX-A were implemented** on top of `30c36b9f` in the same session (branch `fix/governance-handoff-hygiene`): patch-apply now records and completes its canonical handoff; `complete_canonical_handoff` is a first-class operation (admin tier); auto-promote closes its per-candidate memory sessions; `route_memory_writeback` documents defer+apply semantics (the `apply_mode` metadata itself shipped in #299/#300); `read_context` with only a query defaults to auto reads.
- **Still open from this spec:** RC-1..RC-4 (P3, deliberately deferred — the retrieval layer was heavily refactored by #300 and needs re-analysis against the new `production-retrieval-dependencies-service.ts` seams before touching), RC-5 guard (standing), the §3 orphan-pages investigation, §7 structural items, and all §8 N-directions.
- **Second follow-up wave (same day, later still):** the RC findings were re-verified against the post-#300 tree (all valid; the refactor was a mechanical extraction with no memoization) and **RC-1, RC-2, RC-4 shipped**: one shared broad-synthesis route per `retrieve_context` invocation, the `read_context` auto-probe skips discarded candidate-signal scans, and the exact-selector fast path skips Memory Inbox scans (contract note: its `candidate_signals` are now empty with reason code `exact_selector_fast_path`). The **§3 orphan-pages mystery was root-caused and fixed**: the `links` table is populated only by explicit `add_link`, while the brain convention uses `[title](path.md)` markdown links that nothing extracted — manifests/sections now capture markdown page references (extractor v2) and `get_health.orphan_pages` counts manifest references, so markdown-linked brains stop reporting 100% orphans. **RC-3 remains open by decision**: adopting `sqlite-vec` adds a native-extension dependency that deserves its own PR with cross-platform testing; the brute-force scan documented in §6 stands until then.
- **Fourth follow-up wave (same day): O2 started as a ratchet.** `PARITY_COVERAGE_BACKLOG` + a conformance test now enumerate all 168 shared SQLite/PgEngineBase methods: 14 are parity-covered, 154 are explicitly backlogged, and any new shared method must either gain a parity seed or be consciously backlogged (shrink-only, stale entries fail). The behavioral parity seeds for the governance/personal/note-structure stores — O2's remaining substance and O1/O7's prerequisite — are still open.
- **Third follow-up wave (same day): N-2 shipped.** The `remember` operation (core tier, canonical-write capability, 190 ops total) implements the one-call governed write as the D-B-recommended façade over existing ops: route → reconcile (identical open candidates stop as `duplicate_content`; likely cross-target duplicates stop as `likely_duplicate`) → create candidate → `finalize_memory_candidate` (verify/advance/preflight/promote) → synthesized patch create/review/apply → canonical handoff recorded **and completed** — with a truthful `stored | needs_review | rejected | no_write` receipt, `next_actions` at every stop, and the per-write memory session closed in a `finally`. The patch-body builder moved to the shared `canonical-page-patch-service.ts`, now used by both auto-promote and `remember`. Deviation from the N-2 sketch: the mem0-style reconcile currently stops at exact-content NOOP and likely-duplicate; UPDATE/SUPERSEDE proposal lanes remain future work under D-1's review queue.

## 0. How this spec was produced, and the approach chosen

Three document shapes were considered:

- **A. One integrated spec (chosen).** Analysis, fresh findings, additive brainstorm, and one merged roadmap, with the 2-day-old hardening spec incorporated by reference. Rationale: same baseline commit — duplicating its item text would create a second source of truth that drifts.
- **B. Two documents** (hardening addendum + separate vision doc). Rejected: the new hardening items are few and interlock with the vision items (e.g., the handoff-debt fix changes what the "compounding" report means), so splitting fragments review.
- **C. Edit the 2026-07-04 spec in place.** Rejected: that document is a completed audit artifact; its provenance should stay frozen.

Reading order for a reviewer with limited time: **§2 (theses) → §5 (new correctness bugs) → §8 (new directions) → §9 (roadmap) → §10 (decisions).**

---

## 1. Purpose and goals

MBrain is a **local-first personal memory runtime for one person (the owner) and their AI agents**. Markdown is the human-editable source of truth; Postgres+pgvector (or SQLite offline) is the index; CLI and MCP are both generated from a single operation contract (`src/core/operations.ts`). The product goal, stated identically across every 2026-07 design document: **compounding context — learn once, never rediscover.** The moment of truth: *when an agent needs a fact to do work, does mbrain return the right evidence?*

Six design principles are consistently load-bearing across the codebase and docs, and every proposal in this spec is checked against them:

1. **Two-zone pages.** Compiled truth (rewritten best understanding) above the line; append-only timeline evidence below. Automated processes must never blur the zones.
2. **Governed writes.** Agent-authored claims are suspect by default; durable writes route through `route_memory_writeback` → Memory Inbox → verify → promote → hash-gated `put_page`. No autonomous compiled-truth rewriting.
3. **Evidence boundary on reads.** `search`/`query`/probe candidates are pointers; only `read_context` output is answer evidence.
4. **Local-first & offline-honest.** SQLite profile keeps the same contract; features that can't work offline fail with honest guidance, not silently.
5. **Deterministic core, runner-gated LLM.** The write/read state machines are zero-LLM; LLM judgment (auto-promote judge, future distillation) is subprocess-gated, cached, default-off, and only *proposes* — deterministic gates decide.
6. **Provenance everywhere.** Source refs, content hashes, verification records, mutation ledger.

The external landscape survey (§8.0) confirms this is the right hill: the strongest 2025–2026 negative results in agent memory — context rot, self-degrading LLM-rewritten memory stores, benchmark wins from trivial filesystem baselines — all point to **selectivity + verification beating volume + sophistication**. MBrain's architecture is aligned with where the field is converging; its problems are execution problems, not thesis problems.

## 2. Verdict and three theses

The system is architecturally sound and unusually principled, but three things are simultaneously true:

**T1 — Generation still outpaces verification.** The 2026-07-04 audit's P0–P3 items remain 100% unshipped (same commit). The live install has been *operationally* recovered since the audit (verified 2026-07-06: `get_health` and `retrieve_context` succeed against the live DB), but the structural causes are all still in the code: stdio serve still never migrates, `get_health` still reports no `schema_version`, VERSION is still 0.14.3 with an empty `[Unreleased]` changelog, and the two HIGH security bugs in `mbrain review` are still present. One `git pull` recreates the outage.

**T2 — The write ladder is safe but does not close, so knowledge does not compound.** New finding (§5): even a *perfectly executed* governed write through the system's own recommended path leaves permanent, uncloseable "incomplete handoff" debt in the daily report, because the only code that can complete a canonical handoff is auto-promote's internal gate. Combined with the 7–9 round-trips the governed happy path costs an agent, the rational agent behavior is to under-write — and memory that isn't written never compounds. **Write-path ergonomics is not a UX nicety; it is the compounding thesis's binding constraint.**

**T3 — The interface has outgrown the agent.** 188 operations, all exposed as MCP tools, ~125 visible by default; ~45–50 ops each on the read and write sides; a deprecated 8-op atlas family still shipping; admin tiering decided by substring matching on tool names; and a ~130-line dense rules file agents must hold to use any of it correctly. The 2026 evidence (§8.0) is blunt: heavier context/instructions measurably *hurt* agent task success. MBrain's most differentiated asset — the governance model — is being taxed by its own surface area.

The 2026-07-04 spec fully covers T1. This spec's new work targets T2 and T3, plus the fresh correctness/cost findings below.

## 3. Current state, quantified (2026-07-06)

Architecture inventory (content-line counts, ~5–10% below raw line numbers):

- **Operations contract:** 188 operations across 14 modules; **all 188 are MCP tools** (`test/fixtures/operation-golden-manifest.json`); 81 mutating / 107 read-only; tier split 63 admin / 125 default-visible; only 20/188 have curated compact descriptions. `CORE_TOOLS` = 15 (`src/mcp/tool-tiers.ts:8-24`). Admin classification is substring-based (`ADMIN_NAME_FRAGMENTS`, `tool-tiers.ts:55-84`).
- **Largest files:** `sqlite-engine.ts` 10,078 · `operations.ts` 7,537 (89 inline ops + 74 of the 88 `as any` in core) · `pg-engine-base.ts` 5,121 · `migrate.ts` 3,677 (63 migrations, v2→v64) · `operations-source-registry.ts` 3,537 · `operations-memory-inbox.ts` 3,107 · `retrieve-context-service.ts` 2,552.
- **Services:** 109 files, ~35,411 lines, from 14 to 2,552 lines each; no directory taxonomy.
- **Engines:** `BrainEngine` ≈ **159 methods** across 11 capability sub-interfaces (`engine.ts:384-395`). Postgres+PGLite share `PgEngineBase` (two ~200-line transports — exemplary). SQLite is a **full 10k-line standalone reimplementation** with its own DDL (379 statements) and its own parallel 63-step migration ladder. Required parity matrix: **4 scenarios** (`src/core/testing/parity-matrix.ts:12-52`); the 55-method governance store has none.
- **Schema sources of truth:** three (`schema.sql`→generated `schema-embedded.ts`; `pglite-schema.ts`; hand-kept SQLite `SCHEMA_SQL`).
- **Live instance (2026-07-06):** functional — 38 pages, embed coverage 51% (55 chunks missing embeddings), 0 stale pages, **38/38 pages reported orphaned**, 0 dead links. The orphan figure warrants a look during P1 (either the backlink graph is genuinely empty or orphan detection misfires on this corpus).
- **Release state:** VERSION 0.14.3; `CHANGELOG.md [Unreleased]` empty; `skills/migrations/` stops at v0.14.1; ~13k lines and migrations v61–v64 unreleased. Unit suite red-by-default on macOS (PGLite parity timeouts — OP-4).

## 4. Status of the 2026-07-04 roadmap (incorporated by reference)

Nothing from the prior spec has landed (same commit). Its ordering stands. Two status updates:

| Item | Update 2026-07-06 |
|---|---|
| OP-1/OP-2 (migrate-or-fail-honestly, version handshake) | **Still required.** The live DB was manually migrated since the audit (live check passes), but the class of failure is untouched in code — the next `git pull` that adds a migration re-breaks the install. Priority unchanged: P0. |
| OP-3 (release the wave) | Still required; VERSION/CHANGELOG/skills-migrations all still stale. |
| Everything else (OP-4, SEC-1/2, P1 GV/KM/WQ/KR items, P2 EV items, P3 RQ/RS items, P4 AR items) | Unchanged; evidence re-verified by the fresh deep-dives where touched. |

This spec **adds** items in §5–§7 and slots them into the same P-lanes in §9. Where a new item supersedes or extends a prior item, that is stated explicitly.

---

## 5. New correctness & hygiene findings — the governance loop's false debt

These four findings are *new* (not in the 2026-07-04 audit). Together they change the interpretation of the daily report's headline debt metrics.

### GH-1 · The recommended write path generates permanent, uncloseable debt · **P1, S–M**
- **Problem.** `apply_memory_patch_candidate` — the system's own recommended way to materialize a promoted fact into a page (recommended by `finalize_memory_candidate`'s hint text, `operations-memory-inbox.ts:2296`) — materializes the page and self-promotes the patch candidate (`operations-memory-inbox.ts:2163-2177`) but **never records a canonical handoff**. Result: every successfully-written fact is classified `promoted_without_handoff` by `candidate-resolution-state-service.ts:59-96` and inflates `stale_promoted_without_handoff_count` in the daily report **forever**, indistinguishable from candidates that genuinely never got written. The "primary review surface" cries wolf by construction.
- **Fix.** Record + complete the canonical handoff inside `apply_memory_patch_candidate` when the applying candidate (or a linked promoted candidate) is page-backed — mirroring exactly what `promote-gate.ts:180-272` already does for auto-promote. Backfill: a one-shot repair sweep that completes (or annotates) historical handoff-less promoted candidates whose target page content demonstrably contains the routed content.
- **Files.** `src/core/operations-memory-inbox.ts`, `src/core/services/canonical-handoff-service.ts`, dream maintenance sweep.
- **Acceptance.** A full governed write via finalize→patch-apply yields a `completed_at`-set handoff; daily-report `stale_promoted_without_handoff_count` counts only genuinely unwritten candidates; repair sweep clears historical false debt.

### GH-2 · `complete_canonical_handoff` is not callable by anyone · **P1, S**
- **Problem.** `completeCanonicalHandoff` (`canonical-handoff-service.ts:80-106`) is invoked from exactly one place in the codebase: auto-promote's gate (`promote-gate.ts:258-263`). `record_canonical_handoff` **is** exposed as an operation, but no exposed operation can complete one — a human or agent who materializes a page through any manual route can open debt they can never close.
- **Fix.** Expose `complete_canonical_handoff` as a first-class governed operation (same shape as `record_canonical_handoff`; requires the handoff exist, the candidate be promoted, and a `completion_kind` of `patch_applied | page_written | manual`).
- **Acceptance.** Manual `put_page` followed by `complete_canonical_handoff` clears the row from the report's incomplete-handoff section.

### GH-3 · `route_memory_writeback` `defer` + `apply:true` silently does something else · **P1, S**
- **Problem.** On a `defer` decision with `apply:true`, `deferredRouteCandidateInput` (`operations-memory-writeback-router.ts:404-436`) creates a *captured candidate* — a reasonable data-loss safety valve, but the response's `applied: true` does not mean "the deferred action was applied" (there is none). An agent reading the field name infers the wrong thing.
- **Fix.** Rename/augment the response for this branch (e.g. `applied_action: 'captured_fallback_candidate'`), and say so in the op description. No behavior change.

### GH-4 · Auto-promote leaks memory sessions · **P1, S**
- **Problem.** `ensureAutoPromotePatchContext` (`promote-gate.ts:438-470`) creates a fresh `memory_session` + realm attachment per canonicalized candidate and never closes it. Nightly runs accumulate open sessions unboundedly; no TTL sweep covers them.
- **Fix.** Close the session in a `finally` after the patch-apply chain; add a consolidation-phase sweep for stragglers.

### GH-5 · The governed happy path costs 7–9 round-trips (context for N-2) · **analysis**
Measured against code, "I learned a durable fact with a source, store it" costs, in the realistic no-known-target case: `route_memory_writeback` → `finalize_memory_candidate` → `get_page` (hash) → up to 3 control-plane calls (realm/session/attach) → `create_memory_patch_candidate` → `review_memory_patch_candidate` → `apply_memory_patch_candidate` — **7–9 calls, two disjoint "session" concepts (`write_session_id` vs `memory_session_id`+`realm_id`), and two candidate identities for one fact** (the fact candidate stops at `promoted`+`canonical_write_pending`; a separate patch candidate does the write). Each seam is a place agents stall or silently stop (stopping at `promoted` produces zero retrievable output). The fast lane (`allow_canonical_write` + known hash → `put_page`, 2 calls) bypasses Inbox review entirely and cannot be reached from a candidate that started in the governed lane. This is the quantified basis for thesis T2 and the N-2 direction below; GH-1/GH-2 are its sharpest edges.

## 6. New retrieval cost & robustness findings

The 2026-07-04 audit established the per-variant fan-out (RQ-3b). These findings sit **above** that layer and are additive:

### RC-1 · One `retrieve_context` can run the full hybrid probe up to 4× · **P3, S–M**
- **Evidence.** `buildOrientation()` (`retrieve-context-service.ts:2137-2155`, invoked at `:386`) and `maybeSelectAutoRoute()`'s broad-synthesis branch (`:492-531` → `retrieval-route-selector-service.ts:138`) each independently call `getBroadSynthesisRoute(engine, {query, limit})` with near-identical inputs and no memoization — two more full hybrid-probe executions on top of the per-variant candidate pool.
- **Fix.** Memoize the broad-synthesis route result per invocation (single in-call cache keyed on `{query, limit}`); fold into RQ-3b's batching work.

### RC-2 · `read_context(reads:'auto')` re-runs the entire probe · **P3, S**
- **Evidence.** `resolveReadSelectors` (`read-context-service.ts:1347-1389`) internally calls `retrieveContext()` from scratch when `reads:'auto'` and no selectors. An agent that calls `retrieve_context` then `read_context(query, reads:'auto')` — a natural pattern — pays the full probe twice.
- **Fix.** Accept (and prefer) the probe's `read_plan.selected_selector_snapshots` when the caller supplies them; document that `reads:'auto'` without snapshots is the expensive path; optionally pass a short-lived probe-result token.

### RC-3 · SQLite vector search is an unindexed O(n) JS loop · **P3/P4, M**
- **Evidence.** `search/vector-local.ts:9-30` + `vector-prefilter.ts` brute-force cosine over every embedded row per query, once per variant. The Postgres HNSW fix (RS-8b) does not touch this; the local/offline profile is a first-class target per CLAUDE.md.
- **Fix.** Adopt `sqlite-vec` (or equivalent ANN extension) behind the existing engine seam, with the brute-force loop as fallback when the extension is unavailable — offline-parity rule: honest capability reporting either way. Gate any ranking change on EV-1b.

### RC-4 · Memory-Inbox candidate-signal queries run unconditionally on every probe · **P3, S**
- **Evidence.** `buildCandidateSignals` (`candidate-signal-service.ts:97-113`) queries up to 100 rows per status on **every** `retrieve_context`, including the exact-selector fast path (`retrieve-context-service.ts:322-330`) where the caller already knows what to read.
- **Fix.** Skip candidate-signal lookup on the selector fast path and when `token_budget` is below the orientation floor; cache per-process for a short TTL.

### RC-5 · Usage-aware ranking (default-off) is a popularity loop with no outcome signal · **design guard, S to fix at flip time**
- **Evidence.** `loadRetrievalUsageStatsForRanking` (`retrieve-context-service.ts:1397-1461`) counts slug appearances across traces, pooling probe selections with actual reads, ignoring `answer_ready`/outcome entirely; `usageRankBonus` has no negative term. As designed, a page that was read and found wrong gets the same boost as one that answered the question.
- **Guard.** Do not flip `retrieval_usage_aware_ranking` on until the signal distinguishes probe-selection from confirmed-read and incorporates `answer_ready`/outcome (see N-5, which redesigns this properly). This is precisely the RQ-7 pattern (unmeasured default flip) one wave later — name it now, avoid repeating it.

### UX-A · `read_context(query)` without `reads:'auto'` silently returns empty · **P1, S**
- **Evidence.** `resolveReadSelectors` early-returns unless `input.reads === 'auto'` (`read-context-service.ts:1358-1363`); the param description doesn't say `'auto'` is required; no error, empty result. An agent following "read_context is the evidence boundary" gets nothing and may conclude the brain is empty.
- **Fix.** Either default `reads` to `'auto'` when a `query` is present and no selectors are given, or return a structured `OperationError('selectors_or_auto_required')`. Never silent-empty.

## 7. Structural assessment and sequencing

The architecture deep-dive's conclusion, endorsed here: **the dominant structural liability is not the operations registry — it is the SQLite engine being a 10k-line hand-maintained mirror of the 5.1k-line PG base, with two parallel 63-step migration ladders, guarded by a 4-scenario parity net.** The registry's problems (god-file, `as any`, shallow validation, tool bloat) are real but mechanical.

Opportunities, with sequencing (details in the architecture deep-dive; IDs stable for the roadmap):

| ID | Opportunity | Effort | Order rationale |
|----|-------------|:--:|---|
| O2 | Expand `REQUIRED_PARITY_MATRIX` to governance/personal/note-structure stores; enumerate against the live interface so uncovered methods fail conformance | M | **First** — prerequisite for any engine consolidation; also the net that would have caught KR-5 |
| O6 | Explicit `tier` field per op, asserted by the golden manifest; delete `ADMIN_NAME_FRAGMENTS` | S | Early; supersedes/absorbs AR-3b |
| O5 | Extract the 89 inline ops from `operations.ts` into `operations-*.ts` modules | S–M | Early, mechanical; unblocks reviewable ownership |
| O3 | zod per-op param schemas; `z.infer` handler types; derive MCP JSON Schema + CLI hints | M–L | Kills the 74 `as any` and gives nested validation on the governed-write surface; incremental migration |
| O4 | Consolidate the ~30-op retrieval/navigation read family behind `retrieve_context`/`read_context` with a `lens`/route param; retire the deprecated 8-op atlas family; keep old names as deprecated shims | M | With N-1 (§8); cuts ~20 default tools with no capability loss |
| O8 | Service directory taxonomy (`services/retrieval|governance|maintenance|agent-session/`); fold near-duplicate `*-card/bundle/route` builders | M | Anytime; pairs with AR-7b split |
| O1 | Dialect seam so SQLite shares `PgEngineBase` query-building (placeholders/RETURNING/JSON/upsert/timestamps behind a `SqlDialect` adapter); SQLite-specific paths stay overrides | L | **Only after O2** — highest blast radius, highest durable payoff |
| O7 | Render both migration ladders from one dialect-aware `MIGRATIONS[]` | L | After O1; kills the dual-ladder drift class |

## 8. New directions (additive brainstorm)

### 8.0 Grounding: what the mid-2026 landscape says

Key inputs from the external survey (primary sources cited inline; survey run 2026-07-06 via web search):

- **Negative results dominate the lesson board.** Context rot (all 18 frontier models degrade with input growth); "Evaluating AGENTS.md" (ETH, arXiv 2602.11988): context files broadly *fail to improve* task success while adding >20% cost — only **short, human-written, non-inferable** rules helped; LLM-continuously-rewritten memory stores get *worse on the problems they were built from* (arXiv 2605.12978); LoCoMo is matched at 74% by trivial filesystem ops. → Selectivity + verification win; MBrain's governance thesis is validated, its surface bloat is indicted.
- **Converging positive patterns:** bounded always-in-context memory blocks under an explicit budget (Letta memory blocks; Claude Code's ≤200-line MEMORY.md index); write-time reconcile of each new memory against nearest existing memories into ADD/UPDATE/DELETE/NOOP (mem0); sleep-time/batch consolidation beating per-turn extraction (ChatGPT "Dreaming", Letta sleep-time — MBrain's dream cycle is the right shape); eval mined from real traces (AMA-Bench/SWE-ContextBench direction — MBrain's NEW-2); procedural memory as reviewed, learned rules (LangMem); downstream-use provenance named as the field's open gap (arXiv 2606.04990) — MBrain is uniquely positioned to close it.
- **Already-explored ideas deliberately NOT re-proposed here** (they keep their existing ownership/gates): local reranker (RS-7/RF-1, gated on EV-1b residual gap per DG-8), eval-from-traces flywheel (NEW-2), Memora abstraction/cue lanes (AL-1/AL-2, same gate), bi-temporal graph store (explicitly rejected; D-4 `as_of` reads cover the need), morning distillation queue (D-1), usage flywheel (D-2), entity/alias layer (D-3), task packs (D-5), senses/reflexes connector vision (HOMEBREW doc), decision packets / negative memory / trust-policy engine (HYPER doc P0–P10), GraphRAG-style community summaries (LazyGraphRAG's lesson — lazy, at query time — matches MBrain's existing choice to keep orientation derived and cheap).

Each direction below states: what, why now, prior-art anchor, fit to §1 principles, effort, and gate.

### N-1 · The Five-Surface Brain (agent interface consolidation) · **M overall, staged**
- **What.** Collapse the agent-facing default surface to **~12–15 tools organized around five verb families** — retrieve (`retrieve_context`), read (`read_context`), remember (N-2's `remember`), task (working-set/attempt/decision behind a mode param), and page I/O (`get_page`/`put_page`) — plus a handful of governance review ops — with everything else demoted to explicit-opt-in tiers behind `tool_search`. Concretely: O4 (retrieval family behind a `lens` param), O6 (explicit tiers), retire the atlas family, collapse `get_X/list_X/create_X/update_X_status` quartets behind object+action ops where governance gating permits, and cut `MBRAIN_AGENT_RULES.md` to a ~40-line core (per the AGENTS.md study: short, non-inferable rules only), moving the rest into `get_skillpack` progressive disclosure.
- **Why now.** T3. 125 default tools + dense rules measurably tax every session (token cost, mis-selection, rule-following errors); the repo already fights this with `HEAVY_READ_TOOL_NAMES` and truncation guards — treating symptoms.
- **Fit.** Pure interface work; no authority/governance semantics change. The golden manifest keeps every existing op callable (shims) for one deprecation cycle.
- **Gate.** None needed for the tier/shim work; description-text changes that alter agent behavior should be sanity-checked against EV-2's session scorecard once real (P2).

### N-2 · `remember` — the one-call governed write · **M–L** · *the highest-leverage product item in this spec*
- **What.** A single composite operation: `remember({content, source_refs, evidence_kind, target_hint?, verification?})` that internally runs the full governed ladder: route → reconcile-against-nearest-existing (below) → create/advance candidate → verify-or-defer → preflight → promote → materialize via the synthetic patch chain auto-promote already uses (`promote-gate.ts:216-257`) → record **and complete** the canonical handoff (GH-1/GH-2) → return one structured receipt: `{stored | needs_review | rejected, candidate_id, page_slug?, debt?}`. Where any gate defers (unverified, ambiguous, contradiction, missing target), it stops exactly where the ladder stops today and says why — **it compresses round-trips, not review**. Internals stay the existing ops; `remember` is a façade, so the ladder's auditability (status events, ledger) is unchanged.
- **Write-time reconcile (mem0 anchor).** Before creating a candidate, diff the incoming signal against nearest existing memories (the `reviewDuplicateMemory` machinery, upgraded from "warn" to a structured proposal): `ADD` (new candidate), `UPDATE`/`SUPERSEDE` (link to the existing candidate/page and pre-fill a supersession or patch proposal), `NOOP` (duplicate — return the existing id). This kills duplicate/contradiction debt at the source instead of in nightly review.
- **Why now.** T2/GH-5: 7–9 calls with two session concepts is why agents under-write; auto-promote already proves the whole chain can be driven programmatically end-to-end.
- **Fit.** Principle 2 intact: no gate is skipped, defaults stay candidate-first; `allow_canonical_write` fast lane unchanged but now reachable *from* the governed lane (resume-candidate linkage, closing the two-lane disconnect).
- **Effort/Gate.** M–L. Ships alongside GH-1/GH-2 (they fix the debt semantics `remember` reports). Acceptance: the §5 GH-5 scenario completes in **one call** with a truthful receipt; every intermediate status event still recorded.

### N-3 · Core Memory Blocks (bounded always-on context) · **M**
- **What.** A small set of named, **hard token-budgeted** blocks — `owner-profile`, `active-projects`, `agent-procedures` (see N-4), per-repo `repo-brief` — compiled *from* canonical pages by the dream cycle, injected at SessionStart (extending the existing activation card), with a total budget (~1.5–2k tokens) enforced by construction: the dream cycle must shrink/evict to fit, and every block line carries a source-page pointer. Blocks are derived artifacts (pointers + distilled lines), never a new write authority.
- **Why now.** The single most consistent positive pattern across Letta/Claude Code/ChatGPT; MBrain has no always-on compiled working set — every session starts cold and must probe. Budget-by-construction is the anti-context-rot discipline the landscape demands.
- **Prior art.** Letta memory blocks; Claude Code MEMORY.md ≤200-line index; D-5 task packs (per-task, pull) — N-3 is the session-independent, push counterpart and can share its manifest/stale-detection design.
- **Fit.** Principles 1/3/6: blocks are compiled-truth-derived, carry provenance, and are labeled `not_answer_evidence` (agents still `read_context` to cite).
- **Gate.** Content selection heuristics start deterministic (profile + most-retrieved + active tasks); any LLM-distilled block body is runner-gated patch-candidate output (D-1 machinery).

### N-4 · Procedural memory loop (episodes → reviewed rules) · **M**
- **What.** Detect recurring patterns across task attempts/decisions/episodes ("in repo X, tests are run via Y", "user prefers Z") and propose **short, non-inferable candidate rules** into the Memory Inbox as a new `procedure` lane; on human approval they land in the `agent-procedures` core block (N-3) and/or per-repo brief. Hard caps: rule count and per-rule length enforced by lint; every rule cites its source episodes; rules that stop matching reality get flagged by the existing re-verification machinery (`reverify_code_claims` pattern).
- **Why now.** Procedural memory is the type with the best evidence of moving *coding-agent* performance (AGENTS.md study's one positive: short human-curated non-inferable facts; Windsurf/Cursor "memories" convergence). MBrain has profile + episodes but no episodes→rules promotion path — the underweighted third leg of the CoALA taxonomy it already half-implements.
- **Fit.** Principle 2: rules are candidates, human-reviewed, never auto-injected. Detection is deterministic (recurrence counting) first; LLM phrasing runner-gated.
- **Gate.** Every approved rule is an eval fixture: EV-2's session scorecard (once real, P2) must not regress when a rule is added — rules earn their context budget.

### N-5 · Outcome-aware memory strength (D-2 upgrade) · **M**
- **What.** Replace the popularity-only usage signal (RC-5) with a per-page/per-selector **strength score** with explicit, inspectable terms: confirmed `read_context` reads weighted above probe selections; positive term from `answer_ready:true` traces; **negative** term from reads followed by conflict/stale/refutation; slow decay without access. Consumers: ranking tiebreak (flag-gated, EV-1b-gated), dream-cycle archive/refresh queue prioritization, and a "fading / never-used memories" daily-report section.
- **Why now.** RC-5 shows the current signal would reinforce garbage; the trace substrate (TR-1 default-on) already records everything needed. This is the deterministic, non-parametric distillation of what the RL-from-memory-usage literature actually validates, at single-user scale.
- **Fit.** D-2's own non-goal ("no RL, no opaque ranking updates") respected: scores are deterministic, explainable, and surfaced in reports before they ever touch ranking.
- **Gate.** Ranking consumption strictly behind EV-1b non-regression (P3 discipline); report/queue consumption ungated.

### N-6 · Contamination tracing (downstream-use provenance) · **M**
- **What.** Complete the provenance loop GV-10 opens: when evidence is served (`read_context`) and consumed (session/task id already on traces), record a **use edge**; when a memory is later refuted (`verify → refuted`, GV-10 post-promotion refutation), answer: *"what did this contaminate?"* — a `trace_contamination <candidate|page>` op + report section listing sessions/tasks/pages (via patch lineage) that consumed the refuted claim, with re-verification prompts for downstream pages.
- **Why now.** The 2026 provenance survey (arXiv 2606.04990) names downstream-use tracking as the field-wide gap; MBrain already has every ingredient (traces, source refs, mutation ledger, verification records) — this is a join + a surface, and it is the feature that makes "trust-maintenance runtime" a demonstrable differentiator no cloud memory API offers.
- **Fit.** Read-only analysis over existing ledgers; no new write authority.

### N-7 · Clue-first retrieval for fuzzy queries · **S–M, default-off**
- **What.** For `broad_synthesis`-classified queries that miss (low candidate scores), a runner-gated step drafts a 2–3 sentence hypothesis from *compiled truth already retrieved*, embeds the draft, and re-probes — surfacing as an additional variant lane, clearly labeled, never answer evidence. Deterministic fallback: skip.
- **Prior art.** MemoRAG's clue-generation; targets exactly the vague cross-page questions where similarity fails.
- **Gate.** Flag default-off; EV-1b must show a residual gap on broad_synthesis cases first (same DG-8 discipline as the reranker — and if the reranker is built instead, re-evaluate whether this is still needed).

### N-8 · Trust-tiered retrieval + instruction-injection lint · **S–M**
- **What.** (a) Surface the existing evidence-kind/source hierarchy as an explicit **trust tier** on every retrieval result and read (`user_direct > verified_doc > extracted > imported > web`), letting rank prefer and footers disclose it; (b) extend the session-capture prompt-injection suppression (`agent-session-writeback-service.ts:69-89`) into a general **candidate lint**: instruction-shaped content ("ignore previous…", imperative tool-use text) in any imported/candidate body is flagged and blocked from promotion without explicit override.
- **Why now.** MINJA-class memory-poisoning results show query-only attackers corrupt agent memory; MBrain's import surface (connectors, meeting notes, web) is exactly the vector, and SEC-1 showed the review surface can be reached cross-site. Cheap insurance on existing plumbing.
- **Fit.** Principles 2/6; pairs with the SEC-1 fix.

### N-9 · Sleep-time anticipation (predictive orientation) · **M, default-off**
- **What.** A dream phase that ranks *likely next-session questions* deterministically (active tasks' working sets, watched-question deltas, recent recurring gaps, calendar-free heuristics) and pre-computes/warms their `read_plan`s + orientation bundles, stored as dated derived artifacts the SessionStart card can point to. LLM-free v1; measured by "first-probe latency and hit-rate on next-day real queries" from traces.
- **Prior art.** Letta sleep-time compute; extends watched-questions + D-5 machinery rather than duplicating it.
- **Gate.** Ships behind the dream-cycle flag system; success metric defined *before* build via the trace substrate (avoid another unmeasured surface).

**Recommended bets among N-1..N-9** (impact × fit × effort): **N-2 (`remember`) first** — it converts the governance investment into actually-compounding memory; **N-1** second (interface debt compounds daily); **N-5 + N-6** third (they make trust *visible*, MBrain's differentiator). N-3/N-4 follow once EV-2 can measure their context-budget cost. N-7/N-8/N-9 are cheap, gated satellites.

## 9. Integrated roadmap

Lanes from the 2026-07-04 spec, with this spec's additions **bolded**. Order within a lane is dependency order.

| Lane | Items |
|---|---|
| **P0 — stop the bleeding** *(unchanged, ship first)* | OP-1, OP-2, OP-3, OP-4, SEC-1, SEC-2 |
| **P1 — close the loop** | GV-3b, GV-1b, GV-2b, GV-4b, GV-7b, KM-1b, KM-3b, GV-5b, GV-6b, WQ-1, KR-5 + **GH-1, GH-2, GH-3, GH-4, UX-A** + **investigate the 38/38 orphan-pages report (§3)** |
| **P2 — real instrument [GATE for P3]** | EV-1b, EV-1c, EV-2b *(NEW-2 flywheel feeds this; unchanged)* |
| **P3 — harden default-on retrieval [GATE: EV-1b]** | RQ-3b, RQ-6b, RQ-3c, RS-8b, RQ-9b, RS-4b + **RC-1, RC-2, RC-3, RC-4** + **RC-5 guard honored (no flip without outcome-aware signal)** |
| **P4 — structural** | **O2 → O6/O5 → O3 → O4 → O1 → O7** (absorbs AR-3b/AR-5b/AR-6b/AR-7b; DOC-1, KM-4b unchanged) |
| **P5 — new directions (post-P1, gates as stated per item)** | **N-2 (with GH-1/2) → N-1 (with O4/O6) → N-5, N-6 → N-3, N-4 → N-8 → N-9, N-7** |

Two sequencing principles: (1) **nothing in P5 lands before P0+GH-1/GH-2** — building `remember` on top of false-debt semantics would bake the lie in; (2) **anything touching ranking or default flips waits for P2**, per the standing gate discipline this codebase already learned the hard way.

## 10. Decisions needed from the owner

Decision IDs use letters (D-A..) to avoid collision with the D-1..D-5 direction bets, matching the 2026-07-04 spec's convention.

| # | Question | Recommendation |
|---|----------|----------------|
| D-A | Adopt the P5 lane at all this wave, or hold everything new until P0–P2 fully land? | **Adopt P5 with the stated gates.** GH-1/GH-2 are P1 correctness fixes regardless; N-2 is the compounding thesis's unblocking move and builds on machinery auto-promote already proved. |
| D-B | `remember` (N-2): façade over existing ops (recommended) or a new internal pipeline? | **Façade.** Auditability and gates unchanged; only round-trips collapse. |
| D-C | N-1 scope: tier/shim consolidation only, or also the rules-file cut to ~40 lines? | **Both, staged** — tiers/shims first (mechanical), rules cut second with an A/B check via EV-2 once P2 lands. |
| D-D | RC-3 SQLite ANN: adopt `sqlite-vec` (native extension dependency) or keep brute-force? | **Adopt behind the engine seam with brute-force fallback** — offline profile is first-class; an O(n) JS loop per variant does not scale past a few thousand chunks. |
| D-E | O1/O7 engine consolidation: this wave or next? | **Next wave, after O2 lands and P0–P1 are shipped** — highest blast radius; do not run it concurrently with governance fixes. |
| D-F | N-3 block budget: what total token budget for always-on blocks? | **≤2,000 tokens hard cap** (tunable down), enforced by the dream cycle; blocks compete for space by strength score (N-5). |

## 11. Non-goals

- No autonomous compiled-truth rewriting (unchanged; N-2/N-3/N-4 all stop at candidates/derived artifacts).
- No reranker/Memora lanes/bi-temporal store before their existing EV-1b gates (unchanged).
- No multi-user/team features; N-8 is single-user hardening.
- No cloud embedding provider; the local-only embedding stance stands.
- No new benchmark chasing: LoCoMo/LongMemEval-style synthetic scores are explicitly not targets; the eval investment goes to trace-derived gold sets (EV-1b/NEW-2).
- No re-speccing of D-1..D-5 or the Homebrew senses/reflexes vision — ownership unchanged; N-3/N-9 explicitly reuse their machinery where noted.

## 12. Verification plan

- **P1 additions:** GH-1/GH-2 — end-to-end governed write test asserting a completed handoff and a clean debt report; repair-sweep test on a seeded handoff-less promoted candidate. GH-4 — session-leak regression test counting open sessions after N auto-promote runs. UX-A — `read_context(query)` never silent-empty.
- **P3 additions:** RC-1/RC-2 — instrumented probe-call-count tests (a single `retrieve_context` executes ≤1 broad-synthesis route build; a snapshot-fed `read_context` executes 0 probes). RC-3 — parity test brute-force vs ANN top-k on a seeded corpus; honest capability line in `get_health` when the extension is missing. RC-4 — fast-path probe issues no Inbox queries.
- **N-2:** the GH-5 scenario as an E2E: one `remember` call → page written, handoff completed, all status events present, receipt truthful across the `stored | needs_review | rejected` branches (each branch has a fixture).
- **N-1:** golden-manifest diff proves no capability loss (shims callable); default-catalog tool count asserted ≤ target; rules-file token count asserted in CI.
- **N-5/N-6:** deterministic score/trace-join unit tests; report sections snapshot-tested; ranking consumption blocked by a test that fails if the flag flips without an EV-1b artifact reference.
- **Everything:** the standing rules — three-engine migration parity for any schema change, `bun test` + full E2E lifecycle green before ship, `/document-release` after.

## 13. Provenance and blind spots

- Findings trace to five parallel deep-dives run 2026-07-06 against `master@7f3d2a56` (product/idea-space, architecture, governance lifecycle, retrieval pipeline, external landscape) plus a live-instance check; load-bearing new claims (GH-1/GH-2 call-graph, RC-1/RC-2 double-probe paths, UX-A guard, tool/tier counts, engine line counts) were verified with `file:line` evidence by the respective deep-dive and spot-checked for internal consistency during synthesis.
- **Blind spots:** (a) external-landscape claims rest on web sources current as of 2026-07; arXiv IDs were not independently re-verified beyond the survey; (b) the 38/38 orphan-pages live reading was observed once and not root-caused (flagged into P1); (c) round-trip counts (GH-5) assume a cold control-plane session — warm sessions reduce the governed path to 5–6 calls; (d) no performance profiling was run this session — all cost findings are structural (call-count), not measured latency.
