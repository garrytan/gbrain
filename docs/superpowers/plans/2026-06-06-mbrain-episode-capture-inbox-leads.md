# MBrain Episode Capture And Inbox Lead Refinement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first safe Phase 5 slice for allowlisted episode capture and
Inbox lead refinement so MBrain can learn useful agent-session signals without
turning broad raw episodes or Memory Inbox candidates into answer authority.

**Architecture:** Reuse the existing agent-session memory runtime, source
registry/raw ingest redaction, Memory Inbox, candidate signal, and trust
contract surfaces. This phase adds narrow policy wrappers and gated read
surfaces; it must not create a new raw episode truth store, change retrieval
ranking, or make candidate content visible by default in `retrieve_context`.

**Tech Stack:** Bun, TypeScript, existing `src/core/services`, existing
contract-first operations, Bun test runner, `bun run typecheck`.

---

## Source Specs

- `docs/superpowers/specs/2026-06-06-mbrain-authority-first-memory-improvement-design.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-full-spec-roadmap.md`
- `docs/superpowers/plans/2026-06-03-mbrain-agent-session-memory-runtime.md`
- `docs/superpowers/plans/2026-06-06-mbrain-memory-why-proof-mode.md`
- `docs/MBRAIN_AGENT_RULES.md`
- `docs/MCP_INSTRUCTIONS.md`

## Scope Check

This phase implements only:

- allowlisted capture classification and preview over existing agent-session
  capture plans,
- redaction/safety enforcement before apply,
- content-light Inbox lead read models,
- an explicit gated `read_candidate_context` surface,
- candidate debt and review-latency metrics.

Do not add broad always-on raw capture, graph frontier retrieval, Dream
guardrails, setup-agent UX, doctor explain UX, new persisted candidate-content
tables, or automatic canonical writes.

## File Structure

- `src/core/types/episode-capture.ts`
  - Defines allowlisted capture categories, preview decisions, gated candidate
    context results, Inbox lead summaries, and candidate debt metrics.

- `src/core/services/episode-capture-service.ts`
  - Builds an allowlisted, redacted, preview-first capture plan from existing
    `AgentSessionCapturePlan` output.

- `src/core/services/inbox-lead-service.ts`
  - Converts Memory Inbox candidates and candidate signals into content-light
    leads, gated candidate-context reads, and candidate debt metrics.

- `src/core/operations-memory-inbox.ts`
  - Adds `read_candidate_context` as an explicit non-mutating operation.

- `src/core/types.ts`
  - Exports the new Phase 5 type module.

- `test/episode-capture-service.test.ts`
  - Locks capture allowlist, redaction, preview, and raw-content boundaries.

- `test/inbox-lead-service.test.ts`
  - Locks content-light lead output and candidate debt metrics.

- `test/read-candidate-context.test.ts`
  - Locks gated candidate content read behavior through service and operation.

- `docs/MBRAIN_VERIFY.md`
  - Adds the focused Phase 5 verification command.

- `package.json`
  - Adds `test:episode-capture`.

## Capture Contract

Allowlisted capture categories:

- `decision`
- `failed_attempt`
- `task_resume_state`
- `code_claim_revalidation`
- `explicit_user_preference`
- `source_backed_project_fact`

Everything else is `excluded` by default.

Capture preview must show:

- category,
- decision: `capture_candidate`, `capture_episode`, `capture_trace_only`, or
  `exclude`,
- redacted text only,
- source refs,
- safety flags,
- target hint,
- reason codes.

Capture apply may only route to existing governed surfaces:

- Memory Inbox candidate,
- personal episode/profile write path when already allowed by existing
  preflight,
- trace/provenance-only output.

This phase may implement only preview and deterministic service output first;
apply integration can remain delegated to existing `capture_agent_session_memory`
operation unless a test requires a thin wrapper.

## Inbox Lead Contract

Default `retrieve_context` candidate signals remain content-light. Phase 5
should make that contract explicit with an Inbox lead read model:

- candidate id,
- status,
- activation,
- target object,
- relation,
- promotion/disposition hints,
- pressure/review priority,
- source ref count,
- content redaction state.

It must not include `proposed_content` by default.

`read_candidate_context` is the explicit gated read surface. It requires:

- candidate id,
- purpose,
- requested scope or scope id,
- audit reason for secret/unknown/personal reads,
- default denial for secret candidates.

Returned content must include authority labels and must say it is not answer
evidence.

Existing low-level `get_memory_candidate_entry` can still return the full
candidate by id for administrative use. `read_candidate_context` is the normal
agent retrieval path and guidance surface, not a new hard secrecy boundary.

## Task 1: Episode Capture Types And Preview Service

**Files:**

- Add: `src/core/types/episode-capture.ts`
- Add: `src/core/services/episode-capture-service.ts`
- Add: `test/episode-capture-service.test.ts`
- Modify: `src/core/types.ts`

- [x] **Step 1: Write failing service tests**

Create tests covering:

- decision, failed-attempt, task-resume, code-claim, explicit preference, and
  source-backed project fact events are allowlisted;
- broad raw chat or assistant narration is excluded by default;
- secret-bearing input is redacted or rejected before any preview text is
  exposed;
- preview output carries category, source refs, safety flags, target hints, and
  reason codes;
- raw episode text is marked `provenance_only` or `hint_only`, never
  `answer_ground`.

- [x] **Step 2: Implement types**

Keep the type module structural and narrow. Reuse existing
`AgentSessionEventInput`, `AgentSessionCapturePlan`, and
`MemoryActivationLabel` types where they clarify authority.

- [x] **Step 3: Implement pure preview service**

Implement:

```ts
export function buildEpisodeCapturePreview(
  input: EpisodeCapturePreviewInput,
): EpisodeCapturePreview
```

The service should call `buildAgentSessionCapturePlan`, inspect normalized
redacted events, classify allowlisted categories deterministically, and return
preview decisions. It should not persist raw ingest plans or create candidates.

- [x] **Step 4: Run focused tests**

Run:

```bash
bun test test/episode-capture-service.test.ts
bun run typecheck
```

Expected: PASS.

## Task 2: Inbox Lead Service

**Files:**

- Add: `src/core/services/inbox-lead-service.ts`
- Add: `test/inbox-lead-service.test.ts`

- [x] **Step 1: Write failing lead tests**

Create tests covering:

- content-light leads do not expose `proposed_content`;
- rejected and superseded candidates are audit-only by default;
- promoted candidates with no handoff become review-pressure leads;
- secret candidates are hidden from default leads;
- candidate debt metrics include visible candidate count, missing provenance
  count, stale promoted-without-handoff count, unresolved exposed count, and
  review latency.

- [x] **Step 2: Implement service**

Implement:

```ts
export function buildInboxLeads(input: InboxLeadInput): InboxLeadResult
export function computeCandidateDebtMetrics(input: CandidateDebtInput): CandidateDebtMetrics
```

Use existing candidate fields and candidate signal vocabulary. Do not call the
database from this service.

- [x] **Step 3: Run focused lead tests**

Run:

```bash
bun test test/inbox-lead-service.test.ts
bun run typecheck
```

Expected: PASS.

## Task 3: Gated Candidate Context Read

**Files:**

- Modify: `src/core/services/inbox-lead-service.ts`
- Modify: `src/core/operations-memory-inbox.ts`
- Add: `test/read-candidate-context.test.ts`

- [x] **Step 1: Write failing gated-read tests**

Create tests covering:

- `readCandidateContext` returns candidate content only for explicit purpose and
  allowed sensitivity/scope;
- secret candidates are denied by default;
- personal candidates require personal or mixed scope;
- returned content includes authority/activation labels and a warning that it
  is non-canonical candidate context;
- `read_candidate_context` operation is registered, non-mutating, and uses a
  CLI hint such as `read-candidate-context`.

- [x] **Step 2: Implement service and operation**

Implement:

```ts
export function readCandidateContext(input: ReadCandidateContextInput): ReadCandidateContextResult
```

The operation may call `ctx.engine.getMemoryCandidateEntry(id)` and then pass
the candidate to the pure service. It must not mutate candidate state.

- [x] **Step 3: Run gated-read tests**

Run:

```bash
bun test test/read-candidate-context.test.ts
bun run typecheck
```

Expected: PASS.

## Task 4: Verification Docs

**Files:**

- Modify: `docs/MBRAIN_VERIFY.md`
- Modify: `package.json`

- [x] **Step 1: Add script**

Add:

```json
"test:episode-capture": "bun test test/episode-capture-service.test.ts test/inbox-lead-service.test.ts test/read-candidate-context.test.ts test/retrieval-context-operations.test.ts"
```

- [x] **Step 2: Add docs section**

Add a short `Episode capture and Inbox leads` section to `docs/MBRAIN_VERIFY.md`:

```bash
bun run test:episode-capture
bun run typecheck
```

Acceptance:

- broad raw capture is disabled by default,
- capture preview exposes redacted and allowlisted signals only,
- Inbox leads stay content-light by default,
- candidate content requires explicit gated read,
- secret and scope-sensitive candidates remain protected.

- [x] **Step 3: Run docs gate**

Run:

```bash
bun run test:episode-capture
bun run test:memory-why
bun run typecheck
git diff --check
```

Expected: PASS.

## Phase Acceptance

- [x] Allowlisted episode capture preview exists and is redacted.
- [x] Broad raw capture is disabled by default.
- [x] Episode/raw capture artifacts cannot become answer authority.
- [x] Inbox leads are content-light by default.
- [x] Candidate content requires `read_candidate_context`.
- [x] Candidate debt and review-latency metrics are deterministic.
- [x] Focused tests, memory-why regression, typecheck, and diff check pass.
