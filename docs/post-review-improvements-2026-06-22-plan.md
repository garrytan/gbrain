# Post-Review Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `superpowers:subagent-driven-development` or follow this plan task-by-task with
> TDD. Each task is an independent PR-sized slice; phases are ordered by leverage
> and risk. Do not skip RED/GREEN verification. Do not violate the invariants or
> the by-design guardrails in the design doc.

**Goal:** Close the highest-leverage gaps from the 2026-06-22 gap analysis without
violating any non-negotiable invariant. Theme: proportionality — make governance
enforced where claimed, fix the core retrieval path, make the loop self-heal, and
close two privacy leaks.

**Design:** `docs/post-review-improvements-2026-06-22-design.md`

**Non-negotiable safety rules:**

- Keyword-only retrieval fallback for offline / no-embeddings installs is
  preserved byte-for-byte (Invariant 8).
- No auto-promotion of inferred facts; no auto-emit of a canonical page on every
  promotion (Invariants 3, 5).
- Personal/work scope isolation is never relaxed for convenience (Invariant 6).
- New canonical pages always require observing the target or routing (D1).
- The assertion/governed-write apply path is never left in the dormant middle
  state — wire it or retire it, decided by ADR (F1).
- Every governed mutation still emits the existing status/mutation events.

**Pre-flight (run once in this worktree):**

```bash
bun install
bun run typecheck && bun run lint
bun test   # capture baseline; note pre-existing failures before changing code
```

---

## Phase 1 — Retrieval correctness

### Task 1: Recall harness on the production path (A2)

> Land the test FIRST so it is RED on current `main`, then Task 2 turns it GREEN.

**Files:**
- Create: `test/retrieval-recall-harness.test.ts`
- (reference) `src/core/services/retrieve-context-service.ts`,
  `src/core/sqlite-engine.ts`

**Steps:**
- [ ] RED: SQLite engine (no DB, no API keys). Import ~20-30 short pages on
  distinct topics + near-duplicate distractors. Run 8-12 labeled queries through
  the **real** `retrieveContext` path (no `candidateSearch` override). Assert
  `top1_match` and `recall_at_10` against gold slugs. Include ≥2 paraphrase
  queries whose gold page shares no surface keyword.
- [ ] Confirm the paraphrase cases FAIL on current code (keyword-only) — this is
  the proof the harness has teeth.
- [ ] Rename the qrels gate `describe` block to clarify it tests selection math,
  not recall.
- [ ] Commit: `test(retrieval): add production-path recall harness (RED for keyword-only probe)`

### Task 2: Inject hybrid candidateSearch into the governed probe (A1)

**Files:**
- Modify: `src/core/operations.ts` (`retrieve_context` handler, ~5602)
- Modify: `src/core/services/read-context-service.ts` (~1368 auto-reads caller)
- Modify: `src/core/services/broad-synthesis-route-service.ts` (~113)
- Modify: config schema (add `retrieval.governed_probe_hybrid`, default off)
- Test: extend `test/retrieval-recall-harness.test.ts`,
  `test/retrieve-context-service.test.ts`

**Steps:**
- [ ] Add config flag `retrieval.governed_probe_hybrid` (default `false`).
- [ ] When the flag is on, pass `dependencies.candidateSearch = (q, opts) =>
  hybridSearch(engine, q, { limit: opts.limit, expansion: true, expandFn })` in
  the `retrieve_context` handler; same for the broad-synthesis route and the
  read-context auto-reads caller.
- [ ] RED→GREEN: flip the flag on in the recall harness; paraphrase cases pass.
- [ ] Parity guard test: with the embedding provider unavailable, `retrieve_context`
  results are identical to pre-change (keyword fallback path in `hybrid.ts:68`).
- [ ] Run the existing qrels / graph-frontier fixtures — no regression.
- [ ] Commit: `feat(retrieval): hybrid candidate search in governed probe behind flag`
- [ ] Follow-up (separate commit after eval gate green): default the flag to `true`
  and update `MBRAIN_AGENT_RULES` / `MCP_INSTRUCTIONS` if they describe probe
  behavior. Commit: `feat(retrieval): enable hybrid governed probe by default`

---

## Phase 2 — Privacy & honesty (single tight PR)

### Task 3: Stop the raw-source text leak (B1)

**Files:**
- Modify: `src/core/source-registry/raw-ingest-store.ts` (~165)
- Modify: `src/core/operations-source-registry.ts` (add `request_raw_source_chunks`)
- Modify: `supabase/functions/mbrain-mcp/index.ts` (confirm exclusion posture)
- Test: `test/source-registry-operations.test.ts`,
  `test/raw-access-ledger-service.test.ts`

**Steps:**
- [ ] RED: test that `list_source_items(include_chunks=true)` returns neither
  `chunk_text` nor `redacted_text`; and a secret-risk fixture never leaks raw text
  via inspection.
- [ ] Change `redactSourceChunkForInspection` to drop `redacted_text`; return only
  `chunk_hash`, `token_count`, `sensitivity_flags`, `secret_risk`,
  `prompt_injection_risk`.
- [ ] Add authorized op `request_raw_source_chunks` that runs
  `evaluateRawAccessOperation` policy + ledger write, returning `redacted_text`
  only on a non-deny decision (never raw `chunk_text`).
- [ ] Update the two tests that asserted verbatim text on the unauthorized path.
- [ ] GREEN + run connector/smoke tests; document the new authorized flow.
- [ ] Commit: `fix(security): stop unaudited raw-source text via list_source_items`

### Task 4: Fix doctor offline-profile severity inversion (B2)

**Files:**
- Modify: `src/core/services/doctor-service.ts` (~562)
- Test: `test/doctor.test.ts`

**Steps:**
- [ ] RED: assert a standard Postgres `doctor` reports `offline_profile: ok` and
  emits no offline remediation action.
- [ ] Return `ok` for both intentional modes; reserve `warn` for a real
  config-vs-engine mismatch.
- [ ] GREEN. Commit: `fix(doctor): standard Postgres profile is healthy, not a warning`

### Task 5: Govern personal-memory write/delete ops (B3)

**Files:**
- Modify: `src/core/operations.ts` (~3802 upsert, ~3840/3947 deletes)
- Test: `test/personal-write-operations.test.ts`,
  `test/profile-memory-operations.test.ts`,
  `test/personal-episode-operations.test.ts`

**Steps:**
- [ ] RED: a `work:*` `scope_id` on the personal write path is rejected; a
  cross-scope delete is rejected.
- [ ] Route `upsert_profile_memory_entry` / `record_personal_episode` through
  `selectPersonalWriteTarget` (throw on null route), **or** remove them in favor of
  the `write_*` peers.
- [ ] For both deletes: fetch first, require `scope_id.startsWith('personal:')`,
  record the delete in the mutation ledger.
- [ ] GREEN. Commit: `fix(memory): route personal write/delete through scope gate`

---

## Phase 3 — Agent surface & self-healing

### Task 6: Compact-mode safety annotations + orientation discoverability (C1 part 1)

**Files:**
- Modify: `src/mcp/tool-schema.ts`
- Modify: `src/core/operations.ts` (`get_skillpack` `compactDescription`; `enum`
  on `evaluate_scope_gate` / `select_retrieval_route` intent params)
- Modify: `docs/MCP_INSTRUCTIONS.md` + the `MCP_INSTRUCTIONS` constant
- Test: `test/mcp-tool-schema.test.ts`, `test/mcp-instructions.test.ts`

**Steps:**
- [ ] RED: compact-mode schema for a sample op still includes `title` +
  `readOnlyHint`/`destructiveHint`; `get_skillpack` has a compact description;
  the intent params expose `enum: [...RETRIEVAL_ROUTE_INTENTS]`.
- [ ] Always emit `title` + annotation hints in compact mode; add the
  `compactDescription` and the one-sentence `MCP_INSTRUCTIONS` pointer to
  `get_skillpack`; add the `enum` arrays.
- [ ] GREEN. Commit: `fix(mcp): keep safety annotations and orientation in compact mode`

### Task 7: Self-healing maintenance loop (C2)

**Files:**
- Modify: `src/core/services/dream-cycle-runner-service.ts` (`submitCycle`,
  `daily_report`)
- Modify: `src/core/services/embed-backfill-job-service.ts` (retry policy)
- Modify: maintenance config (default-off auto-enqueue flag)
- Test: `test/maintenance-runtime-service.test.ts`,
  `test/dream-cycle-runner-service.test.ts`,
  `test/embedding-queue.test.ts`

**Steps:**
- [ ] RED: a job past `timeout_at` is dead-lettered on the next `submitCycle` and
  no longer blocks its slot; a transient embed-backfill failure retries; the daily
  report counts `status='active' AND lock_expires_at <= now()`.
- [ ] Call `sweepTimedOutJobs` at the start of `submitCycle`.
- [ ] embed-backfill: `retryable:true` for partial failure (keep
  `runner_unavailable` non-retryable), `max_attempts ~3` + backoff.
- [ ] Extend `daily_report` to surface stuck-active jobs as actionable.
- [ ] Embeddings: add a **default-off** auto-enqueue-on-missing flag, or drop the
  count-only `implemented:true` and surface `mbrain embed --stale` in `next_action`.
  Do **not** touch `context_refresh` (derived worker already drains it).
- [ ] GREEN. Commit: `fix(maintenance): self-heal timed-out jobs and embed backfill retries`

### Task 8: Generalize cross-engine parity test (C3)

**Files:**
- Modify: `test/migrate.test.ts` (~67)

**Steps:**
- [ ] Replace the hardcoded 9-table `sharedTables` with the programmatic
  intersection of SQLite `sqlite_master` ∩ PGLite `information_schema.tables`,
  minus a documented allowlist of intentional divergences.
- [ ] Run the existing column-set equality assertion over every shared table.
- [ ] RED proof: temporarily add a column to one SQLite ensure-helper → test fails;
  revert.
- [ ] Commit: `test(parity): enforce column parity across all shared tables`

### Task 9: Tool tier system (C1 part 2)

> Gated by DG3 (default tier) and coordinate with F1 (which ops exist).

**Files:**
- Modify: `src/core/operations.ts` (`Operation` interface + per-op `tier`)
- Modify: `src/mcp/server.ts`, `src/mcp/http-server.ts` (catalog filter)
- Test: `test/parity.test.ts`, `test/mcp-tool-schema.test.ts`

**Steps:**
- [ ] Add `tier?: 'core' | 'extended' | 'admin'` to `Operation`; tag ~10-15 daily
  ops `core`, control-plane/redaction/realm/session/maintenance `admin`.
- [ ] Filter the catalog by `MBRAIN_MCP_TOOL_TIER` (default `core+extended`;
  `=all` opt-in). Keep the capability filter and `tool_search` lazy load; keep
  dispatch-by-name unfiltered.
- [ ] Pin the tier contract in `test/parity.test.ts`.
- [ ] Decide edge-surface default (`=all`?) per DG3.
- [ ] Commit: `feat(mcp): tiered tool catalog with opt-in full surface`

---

## Phase 4 — Write-governance proportionality (contract changes)

### Task 10: Require expected_content_hash present on put_page (D1)

> DG2: public contract change. Update smoke + agent rules in the same PR.

**Files:**
- Modify: `src/core/operations.ts` (`put_page`, add `admin_put_page`)
- Modify: `scripts/smoke-test-installed-mcp.ts`
- Modify: `docs/MBRAIN_AGENT_RULES.md`
- Test: `test/page-write-precondition.test.ts`,
  `test/put-page-provenance-operations.test.ts`

**Steps:**
- [ ] RED: agent/MCP `put_page` without the `expected_content_hash` field rejects
  with `route_first`; with `null` on a truly-absent slug it succeeds; stale hash
  conflicts and writes nothing; `admin_put_page` (CLI-local) repairs without a
  hash; ledger records whether the precondition was supplied.
- [ ] Require the field present (value may be `null`) on the agent surface; add
  `admin_put_page` tagged `admin` (Task 9).
- [ ] Reject sessionless fresh-slug creation with a `route_first` error naming
  `route_memory_writeback`.
- [ ] Update the installed smoke to the router-dry-run + expected-hash path.
- [ ] Update `MBRAIN_AGENT_RULES` and add a migration note.
- [ ] Commit: `feat(governance): put_page requires observing the target (CAS)`

### Task 11: Close the promotion loop (D2)

**Files:**
- Modify: `src/core/operations-memory-inbox.ts` (`promote` hint; `bind_and_promote`)
- Modify: `src/commands/memory-report.ts` (surface `promotedWithoutHandoff`)
- Modify: `docs/MBRAIN_AGENT_RULES.md`
- Test: `test/memory-inbox-operations.test.ts`,
  `test/memory-review-report-service.test.ts`

**Steps:**
- [ ] RED: a page-backed candidate reaches retrievable markdown via one
  `bind_and_promote` op without hand-supplied session/realm/actor; a bare
  `promote` with no follow-up returns `canonical_write_pending`; the daily report
  lists promoted-without-page anomalies.
- [ ] Add the optional `bind_and_promote` op composing the existing
  `create_memory_patch_candidate` → review → `apply_memory_patch_candidate` path,
  auto-filling session/realm/actor from the active session (still scope-gated).
- [ ] Add the `canonical_write_pending` hint to `promote`.
- [ ] Surface `promotedWithoutHandoff` in the daily report; update agent rules.
- [ ] Commit: `feat(governance): optional bind_and_promote + promoted-without-page surfacing`

---

## Phase 5 — Proactive recall & review lens

### Task 12: SessionStart activation hook + knowledge digest (E1)

> Depends on Task 2 (A1). Honor the non-blocking / silent-on-empty hook preference.

**Files:**
- Modify: `src/commands/setup-agent.ts` (`CLAUDE_MANAGED_HOOK_ENTRIES` +
  `SessionStart` hook script)
- Modify: `src/commands/memory-report.ts` (knowledge-digest section)
- Test: `test/setup-agent.test.ts`, `test/memory-review-report-service.test.ts`,
  `test/agent-session-activation-operations.test.ts`

**Steps:**
- [ ] RED: a `SessionStart` hook entry is registered; the hook script calls
  `plan_agent_session_activation` for the active scope/cwd and emits a
  token-bounded, scope-gated `additionalContext` card; emits nothing on empty.
- [ ] RED: the daily report renders a human-readable "learned this period" section
  from `canonical_memories` deltas (not the raw operation/target string) and a
  first-class coverage-gap list.
- [ ] Implement the hook + digest; keep the card bounded and scope-gated; keep the
  hook silent/non-blocking.
- [ ] GREEN. Commit: `feat(agent): proactive SessionStart recall + knowledge digest`

---

## Decision gate (resolve before its dependents)

### Task 0 (gate): ADR for the assertion/governed-write apply path (F1)

> Resolve **before** Task 9 (which ops exist) and Task 10 (canonical-write path).

**Files:**
- Create: `docs/architecture/adr/2026-06-22-assertion-apply-path.md`
- Then either a retire PR or a wire PR per the decision.

**Steps:**
- [ ] Write the ADR presenting Option A (retire, recommended) vs Option B (wire).
- [ ] **Owner decision required.**
- [ ] If A: delete `applyCanonicalWrite`, `resolveExtractedClaimForEngine`,
  `GovernedCanonicalWriteService`, `canonical-write-audit-store`, and their SQLite
  mirrors; migration drops the unused tables on both engines; keep
  read/preview/explain ops only if surfaced in a feature.
- [ ] If B: route `put_page`/`governed_put_page` through `applyCanonicalWrite`.
- [ ] Either way: add a test asserting the assertion tables are written by a live
  op **or** absent (forbid the dormant middle state).
- [ ] Commit (A): `refactor(governance): retire dormant assertion apply path (ADR-2026-06-22)`

---

## Verification per phase

- After each task: `bun run typecheck && bun run lint` and the task's targeted
  tests.
- Before each PR to `master`: full `bun test` + the E2E DB lifecycle
  (`bun run test:e2e`) per `CLAUDE.md`; do not ship with failing E2E.
- Phase 1 and Phase 4 PRs additionally run the retrieval recall harness and the
  page-write-precondition suite respectively as the load-bearing gate.
