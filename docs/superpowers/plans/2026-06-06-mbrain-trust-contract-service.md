# MBrain Trust Contract Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize memory authority decisions in a small trust contract service
so retrieval, Memory Inbox leads, assertion surfaces, Dream, and future proof
mode can use one consistent policy view without creating a new truth store.

**Architecture:** The trust contract is a derived policy view over existing
governance state. It must not store canonical facts, mutate pages, or replace
`read_context` as the evidence boundary. Activation policy can delegate to the
trust contract, but legacy activation decisions must remain behaviorally
compatible.

**Tech Stack:** Bun, TypeScript, existing `src/core/services` patterns,
`src/core/types`, Bun test runner, `bun run typecheck`.

---

## Source Specs

- `docs/superpowers/specs/2026-06-06-mbrain-authority-first-memory-improvement-design.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-full-spec-roadmap.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-foundation.md`
- `docs/MBRAIN_AGENT_RULES.md`
- `docs/MCP_INSTRUCTIONS.md`

## Scope Check

This phase implements only the central policy contract needed by later phases.
Do not implement decision packet projections, negative memory projections,
memory-why, proof mode, episode capture, graph frontier retrieval, or expanded
Dream maintenance here.

The contract should cover the artifact kinds that already participate in
activation decisions:

- canonical compiled truth and current artifacts,
- source and timeline evidence,
- derived orientation artifacts such as context maps and codemap pointers,
- task decisions and failed attempts,
- Memory Inbox candidates,
- profile memory and personal episodes,
- assertion-derived retrieval surfaces.

## File Structure

- `src/core/types/trust-contract.ts`
  - Defines trust contract inputs, decisions, reason codes, freshness labels,
    revalidation instructions, policy version metadata, and authority labels.

- `src/core/services/trust-contract-service.ts`
  - Implements deterministic policy evaluation from artifact/source/scope/
    freshness/sensitivity/assertion/candidate inputs.

- `src/core/services/memory-activation-policy-service.ts`
  - Delegates artifact decisions to `evaluateTrustContract` while preserving the
    existing `MemoryActivationPolicyResult` shape and legacy decision values.

- `test/trust-contract-service.test.ts`
  - Locks the new contract directly.

- `test/memory-activation-policy-service.test.ts`
  - Adds integration assertions that activation decisions carry trust contract
    reason codes and remain backward compatible.

- `docs/MBRAIN_VERIFY.md`
  - Adds the focused trust contract verification command.

- `package.json`
  - Adds `test:trust-contract`.

---

## Policy Contract

Each trust decision returns:

- `activation`: one of the existing activation decisions
  (`answer_ground`, `citation_only`, `orientation_only`, `verify_first`,
  `suppress_if_valid`, `candidate_only`, `ignore`).
- `activation_label`: the more precise label used by activation routing
  (`hint_only`, `promote_first`, `audit_only`, etc.).
- `authority`: the existing `MemoryArtifactAuthority`.
- `freshness`: `current`, `stale`, `unknown`, or `not_applicable`.
- `revalidation`: `none`, `read_canonical`, `reverify_code`,
  `evaluate_scope_gate`, `promote_candidate`, or `review_candidate`.
- `reason_codes`: stable machine-readable strings.
- `policy_version`: a stable version id.
- `policy_version_hash`: deterministic hash over the policy version and major
  decision inputs.

The first implementation should use a literal policy version such as
`trust-contract:v1` and a deterministic SHA-256 hash. Later phases can include
source policy hashes or user-configured trust policies.

## Task 1: Trust Contract Types And Service

**Files:**

- Add: `src/core/types/trust-contract.ts`
- Add: `src/core/services/trust-contract-service.ts`
- Add: `test/trust-contract-service.test.ts`

- [x] **Step 1: Write failing service tests**

Create `test/trust-contract-service.test.ts` covering:

- stale compiled truth returns `verify_first`, freshness `stale`, and
  revalidation `read_canonical`;
- stale code/codemap claims return `verify_first` and revalidation
  `reverify_code`;
- scope-denied profile memory returns `ignore`, authority `scope_denied`, and
  revalidation `evaluate_scope_gate`;
- unreviewed targeted candidates return `candidate_only` with label
  `promote_first`;
- rejected or superseded candidates return `candidate_only` with label
  `audit_only`;
- source/timeline evidence returns `citation_only`;
- derived context map and graph-like artifacts return `orientation_only`;
- personal episodes can answer only with explicit scope allow;
- assertion surfaces return `answer_ground` only when scope matches,
  lifecycle is active, authority is canonical, and freshness is current;
- every decision includes non-empty `reason_codes`, `policy_version`, and a
  SHA-256-like `policy_version_hash`.

- [x] **Step 2: Implement types**

Define input types so callers can pass the existing activation artifact shape
without importing activation policy internals. Keep the type minimal and avoid
schema or database changes.

Suggested names:

```ts
export type TrustContractActivation = MemoryActivationDecision;
export type TrustFreshnessLabel = 'current' | 'stale' | 'unknown' | 'not_applicable';
export type TrustRevalidationInstruction =
  | 'none'
  | 'read_canonical'
  | 'reverify_code'
  | 'evaluate_scope_gate'
  | 'promote_candidate'
  | 'review_candidate';
```

- [x] **Step 3: Implement service**

Implement a pure function:

```ts
export function evaluateTrustContract(input: TrustContractInput): TrustContractDecision
```

Keep the initial policy deterministic and local. Do not call the database or
external services from this service.

- [x] **Step 4: Run focused tests**

Run:

```bash
bun test test/trust-contract-service.test.ts
bun run typecheck
```

Expected: PASS.

## Task 2: Activation Policy Delegation

**Files:**

- Modify: `src/core/services/memory-activation-policy-service.ts`
- Modify: `test/memory-activation-policy-service.test.ts`

- [x] **Step 1: Add integration tests**

Extend `test/memory-activation-policy-service.test.ts` to assert:

- existing decision outputs are unchanged for compiled truth, timeline,
  context maps, codemap pointers, failed attempts, candidates, profile memory,
  and personal episodes;
- decisions now include trust contract reason codes where applicable;
- stale code/codemap artifacts include a revalidation reason code;
- unreviewed candidates remain `candidate_only` and never answer-ground;
- personal episodes still require explicit scope allow.

- [x] **Step 2: Delegate decisions**

Update `memory-activation-policy-service.ts` so `decideArtifactActivation`
delegates to `evaluateTrustContract`. Convert the trust decision back into the
existing `MemoryActivationPolicyDecision` result shape.

Preserve:

- `next_tool` behavior,
- `writeback_hint` behavior,
- `stale_warnings`,
- `verification_required`,
- `source_refs`,
- `trace_required`.

- [x] **Step 3: Run focused tests**

Run:

```bash
bun test test/trust-contract-service.test.ts test/memory-activation-policy-service.test.ts
bun run typecheck
```

Expected: PASS.

## Task 3: Verification Docs

**Files:**

- Modify: `docs/MBRAIN_VERIFY.md`
- Modify: `package.json`

- [x] **Step 1: Add script**

Add:

```json
"test:trust-contract": "bun test test/trust-contract-service.test.ts test/memory-activation-policy-service.test.ts"
```

- [x] **Step 2: Add docs section**

Add a short `Trust contract service` section to `docs/MBRAIN_VERIFY.md`:

```bash
bun run test:trust-contract
bun run typecheck
```

Acceptance:

- stale and scope-denied artifacts downgrade consistently,
- unreviewed candidates remain candidate-only,
- source/timeline evidence remains citation-only,
- profile memory and personal episodes require scope policy,
- every trust decision includes reason codes and a policy version hash.

- [x] **Step 3: Run docs gate**

Run:

```bash
bun run test:trust-contract
bun run typecheck
git diff --check
```

Expected: PASS.

## Task 4: Commit And Phase Gate

Run:

```bash
bun run test:trust-contract
bun run test:authority-foundation
bun run typecheck
git status --short --branch
```

Expected:

- trust contract tests pass,
- existing authority foundation gate remains green,
- only the pre-existing untracked `reference/` directory remains untracked.

Commit:

```bash
git add \
  src/core/types/trust-contract.ts \
  src/core/types.ts \
  src/core/services/trust-contract-service.ts \
  src/core/services/memory-activation-policy-service.ts \
  test/trust-contract-service.test.ts \
  test/memory-activation-policy-service.test.ts \
  docs/MBRAIN_VERIFY.md \
  docs/superpowers/plans/2026-06-06-mbrain-trust-contract-service.md \
  package.json
git commit -m "feat: add trust contract service"
```

---

## Final Verification

After all tasks are complete, run:

```bash
bun run test:trust-contract
bun run test:authority-foundation
bun run typecheck
git log --oneline -5
git status --short --branch
```

## Out Of Scope

- Decision packet projection implementation.
- Negative memory projection implementation.
- Memory-why or proof command output.
- Episode capture changes.
- Graph frontier retrieval.
- Trust policy persistence, remote policy fetches, or configurable policy DSL.
