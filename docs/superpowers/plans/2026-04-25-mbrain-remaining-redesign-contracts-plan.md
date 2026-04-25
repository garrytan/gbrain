# MBrain Remaining Redesign Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the remaining S5, S9, and S11 scenario placeholders with real behavior, then close final redesign acceptance.

**Architecture:** New behavior must preserve the redesign split between canonical truth, derived orientation, governance, and retrieval orchestration. Request decomposition chooses ordered retrieval steps; broad synthesis prefers curated canonical notes over map-derived suggestions; code-claim verification distinguishes historical memory from current workspace truth.

**Tech Stack:** Bun, TypeScript, SQLite, PGLite, Postgres, `BrainEngine`, operation registry, scenario tests under `test/scenarios`.

---

## Completion Update

As of 2026-04-25 after PR #51:

- PR 3 / S5 is complete in PR #49.
- PR 4 / S9 is complete in PR #50.
- PR 5 / S11 is complete in PR #51.
- `test/scenarios` has zero placeholders.
- `bunx tsc --noEmit --pretty false` is green and enforced in CI.
- Only PR 6, final acceptance closure, remains from this plan.

## Preconditions

This precondition is now satisfied. Sprint 0 typecheck cleanup landed in PR #44
through PR #48:

```bash
bunx tsc --noEmit --pretty false
```

Expected: command exits 0 with no output.

## PR 3: L1 Request-Level Intent Decomposition

Branch: `sprint-2-request-decomposition`

### Task 3.1: Add Planner Types

**Files:**

- Modify: `src/core/types.ts`

- [ ] **Step 1: Add planner input/output types**

Add these interfaces after `RetrievalRouteSelectorInput` and before `RetrievalRouteSelectorResult`:

```ts
export interface RetrievalRequestPlannerInput extends Omit<RetrievalRouteSelectorInput, 'intent'> {
  intent?: RetrievalRouteIntent;
  allow_decomposition?: boolean;
}

export interface RetrievalRequestPlanStep {
  step_id: string;
  intent: RetrievalRouteIntent;
  input: RetrievalRouteSelectorInput;
}

export interface RetrievalRequestPlan {
  selection_reason: 'decomposed_mixed_intent' | 'single_intent' | 'no_match';
  steps: RetrievalRequestPlanStep[];
}
```

- [ ] **Step 2: Run typecheck slice**

```bash
bunx tsc --noEmit --pretty false
```

Expected: pass.

### Task 3.2: Write Planner Tests

**Files:**

- Create: `test/retrieval-request-planner-service.test.ts`

- [ ] **Step 1: Add failing tests**

Create `test/retrieval-request-planner-service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { planRetrievalRequest } from '../src/core/services/retrieval-request-planner-service.ts';

describe('retrieval request planner', () => {
  test('decomposes task resume plus synthesis into ordered steps', () => {
    const plan = planRetrievalRequest({
      allow_decomposition: true,
      intent: 'task_resume',
      task_id: 'task-123',
      requested_scope: 'work',
      query: 'Summarize what remains for this task',
    });

    expect(plan.selection_reason).toBe('decomposed_mixed_intent');
    expect(plan.steps.map((step) => step.intent)).toEqual(['task_resume', 'broad_synthesis']);
    expect(plan.steps[0]?.input.task_id).toBe('task-123');
    expect(plan.steps[1]?.input.query).toBe('Summarize what remains for this task');
  });

  test('plans explicit mixed-scope bridge when requested scope is mixed', () => {
    const plan = planRetrievalRequest({
      allow_decomposition: true,
      requested_scope: 'mixed',
      query: 'Connect Alex personal context to work context',
      subject: 'alex',
      personal_route_kind: 'profile',
    });

    expect(plan.selection_reason).toBe('single_intent');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.intent).toBe('mixed_scope_bridge');
    expect(plan.steps[0]?.input.requested_scope).toBe('mixed');
  });

  test('returns no_match when there is not enough input to infer a route', () => {
    const plan = planRetrievalRequest({
      allow_decomposition: true,
    });

    expect(plan.selection_reason).toBe('no_match');
    expect(plan.steps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

```bash
bun test test/retrieval-request-planner-service.test.ts
```

Expected: fail because `retrieval-request-planner-service.ts` does not exist.

### Task 3.3: Implement Planner Service

**Files:**

- Create: `src/core/services/retrieval-request-planner-service.ts`

- [ ] **Step 1: Add minimal deterministic planner**

Create `src/core/services/retrieval-request-planner-service.ts`:

```ts
import type {
  RetrievalRequestPlan,
  RetrievalRequestPlannerInput,
  RetrievalRouteIntent,
  RetrievalRouteSelectorInput,
} from '../types.ts';

export function planRetrievalRequest(input: RetrievalRequestPlannerInput): RetrievalRequestPlan {
  if (input.allow_decomposition === true && input.task_id && input.query) {
    return {
      selection_reason: 'decomposed_mixed_intent',
      steps: [
        buildStep('step-1-task-resume', 'task_resume', input),
        buildStep('step-2-broad-synthesis', 'broad_synthesis', input),
      ],
    };
  }

  const inferredIntent = input.intent ?? inferSingleIntent(input);
  if (!inferredIntent) {
    return {
      selection_reason: 'no_match',
      steps: [],
    };
  }

  return {
    selection_reason: 'single_intent',
    steps: [buildStep('step-1-single-intent', inferredIntent, input)],
  };
}

function inferSingleIntent(input: RetrievalRequestPlannerInput): RetrievalRouteIntent | null {
  if (input.requested_scope === 'mixed' && input.query && (input.subject || input.episode_title)) {
    return 'mixed_scope_bridge';
  }
  if (input.task_id) return 'task_resume';
  if (input.slug || input.path || input.source_ref) return 'precision_lookup';
  if (input.subject) return 'personal_profile_lookup';
  if (input.episode_title) return 'personal_episode_lookup';
  if (input.query) return 'broad_synthesis';
  return null;
}

function buildStep(
  step_id: string,
  intent: RetrievalRouteIntent,
  input: RetrievalRequestPlannerInput,
): RetrievalRequestPlan['steps'][number] {
  const selectorInput: RetrievalRouteSelectorInput = {
    ...input,
    intent,
  };
  delete (selectorInput as { allow_decomposition?: boolean }).allow_decomposition;
  return {
    step_id,
    intent,
    input: selectorInput,
  };
}
```

The planner is intentionally deterministic. It does not call an LLM and does not execute the routes.

- [ ] **Step 2: Verify planner tests**

```bash
bun test test/retrieval-request-planner-service.test.ts
```

Expected: pass.

### Task 3.4: Expose Operation

**Files:**

- Modify: `src/core/operations.ts`
- Test: `test/retrieval-request-planner-operations.test.ts`

- [ ] **Step 1: Add operation test**

Create `test/retrieval-request-planner-operations.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';

describe('plan_retrieval_request operation', () => {
  test('is registered with CLI hints', () => {
    const op = operationsByName.get('plan_retrieval_request');
    expect(op).toBeDefined();
    expect(op?.cliHints?.name).toBe('plan-retrieval-request');
    expect(op?.mutating).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test test/retrieval-request-planner-operations.test.ts
```

Expected: fail because operation is not registered.

- [ ] **Step 3: Register operation**

In `src/core/operations.ts`, import `planRetrievalRequest` and add a read-only operation named `plan_retrieval_request` with `cliHints.name = 'plan-retrieval-request'`.

The handler must parse params into `RetrievalRequestPlannerInput` and return the plan without reading or mutating the engine.

- [ ] **Step 4: Verify operation**

```bash
bun test test/retrieval-request-planner-operations.test.ts test/cli.test.ts
```

Expected: pass.

### Task 3.5: Replace S5 Placeholder

**Files:**

- Modify: `test/scenarios/s05-mixed-intent-decomposition.test.ts`
- Modify: `test/scenarios/README.md`

- [ ] **Step 1: Replace the S5 todo with a real test**

Replace:

```ts
test.todo('S5 gap — general request-level intent classifier (resume + synthesis, etc.)');
```

with:

```ts
test('general request planner decomposes task resume plus synthesis', () => {
  const plan = planRetrievalRequest({
    allow_decomposition: true,
    intent: 'task_resume',
    task_id: 'task-s5',
    requested_scope: 'work',
    query: 'Summarize what to do next after resuming this task',
  });

  expect(plan.selection_reason).toBe('decomposed_mixed_intent');
  expect(plan.steps.map((step) => step.intent)).toEqual(['task_resume', 'broad_synthesis']);
});
```

Also add this import:

```ts
import { planRetrievalRequest } from '../../src/core/services/retrieval-request-planner-service.ts';
```

- [ ] **Step 2: Update scenario README**

In `test/scenarios/README.md`, change S5 status from `green + 1 todo` to `green`.

- [ ] **Step 3: Run PR 3 gate**

```bash
bun test test/retrieval-request-planner-service.test.ts test/retrieval-request-planner-operations.test.ts test/scenarios/s05-mixed-intent-decomposition.test.ts --timeout 60000
bun run test:scenarios
bunx tsc --noEmit --pretty false
bun run build
git diff --check
```

Expected: all pass. Scenario placeholder count drops from 5 to 4.

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts src/core/services/retrieval-request-planner-service.ts src/core/operations.ts test/retrieval-request-planner-service.test.ts test/retrieval-request-planner-operations.test.ts test/scenarios/s05-mixed-intent-decomposition.test.ts test/scenarios/README.md
git commit -m "feat: add request-level retrieval decomposition"
```

## PR 4: L2 Canonical-First Broad Synthesis Ranking

Branch: `sprint-3-canonical-first-ranking`

### Task 4.1: Extend Broad Synthesis Types

**Files:**

- Modify: `src/core/types.ts`

- [ ] **Step 1: Add canonical/derived route types**

Add after `BroadSynthesisRouteRead`:

```ts
export interface BroadSynthesisEntrypoint {
  source_kind: 'curated_note' | 'context_map';
  page_slug?: string;
  map_id?: string;
  label: string;
}

export interface BroadSynthesisDerivedSuggestion {
  map_id: string;
  node_id: string;
  label: string;
  page_slug: string;
}

export interface BroadSynthesisConflict {
  entity_key: string;
  canonical_page_slug: string;
  derived_map_id: string;
  resolution: 'prefer_canonical';
  summary: string;
}
```

Extend `BroadSynthesisRoute`:

```ts
entrypoints: BroadSynthesisEntrypoint[];
canonical_reads: BroadSynthesisRouteRead[];
derived_suggestions: BroadSynthesisDerivedSuggestion[];
conflicts: BroadSynthesisConflict[];
```

### Task 4.2: Write S9 Tests

**Files:**

- Modify: `test/scenarios/s09-curated-over-map.test.ts`

- [ ] **Step 1: Replace S9 todos with real tests**

Create a SQLite harness, seed a curated concept page with `compiled_truth`, seed a context map that recommends a map-derived read for the same concept, call `getBroadSynthesisRoute`, and assert:

```ts
expect(result.route?.entrypoints[0]?.source_kind).toBe('curated_note');
expect(result.route?.canonical_reads[0]?.page_slug).toBe('concepts/a');
expect(result.route?.derived_suggestions[0]?.map_id).toBe(mapId);
expect(result.route?.conflicts[0]?.resolution).toBe('prefer_canonical');
```

Second test asserts the map-derived disagreement is not treated as co-equal canonical truth:

```ts
expect(result.route?.canonical_reads.map((read) => read.page_slug)).toContain('concepts/a');
expect(result.route?.derived_suggestions).toHaveLength(1);
expect(result.route?.entrypoints[0]?.source_kind).toBe('curated_note');
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test test/scenarios/s09-curated-over-map.test.ts
```

Expected: fail because the new route fields are not populated.

### Task 4.3: Implement Canonical-First Ranking

**Files:**

- Modify: `src/core/services/broad-synthesis-route-service.ts`
- Test: `test/broad-synthesis-route-service.test.ts`

- [ ] **Step 1: Load curated candidates before returning route**

Inside `getBroadSynthesisRoute`, after map query returns, fetch canonical candidates:

```ts
const canonicalCandidates = await engine.searchKeyword(input.query, {
  type: 'concept',
  limit: input.limit ?? 5,
});
const canonicalPages = (await Promise.all(
  canonicalCandidates.map((candidate) => engine.getPage(candidate.slug)),
)).filter(isNonEmptyCanonicalPage);
```

Add the type guard in the same service file:

```ts
import type { Page } from '../types.ts';

function isNonEmptyCanonicalPage(page: Page | null): page is Page {
  return page !== null && page.compiled_truth.trim().length > 0;
}
```

- [ ] **Step 2: Pass canonical pages into route builder**

Extend `buildBroadSynthesisRoute` input with `canonicalPages` and build:

```ts
const canonicalReads = canonicalPages.map((page) => ({
  node_id: `page:${page.slug}`,
  node_kind: 'page' as const,
  label: page.title,
  page_slug: page.slug,
  path: page.slug,
}));
const derivedSuggestions = input.matchedNodes
  .filter((node) => node.page_slug)
  .map((node) => ({
    map_id: input.report.map_id,
    node_id: node.node_id,
    label: node.label,
    page_slug: node.page_slug,
  }));
```

Populate route fields:

```ts
entrypoints: [
  ...canonicalReads.map((read) => ({
    source_kind: 'curated_note' as const,
    page_slug: read.page_slug,
    label: read.label,
  })),
  {
    source_kind: 'context_map' as const,
    map_id: input.report.map_id,
    label: input.report.map_id,
  },
],
canonical_reads: canonicalReads,
derived_suggestions: derivedSuggestions,
conflicts: buildCanonicalConflicts(canonicalReads, derivedSuggestions, input.report.map_id),
recommended_reads: dedupeReads([...canonicalReads, ...recommendedReads]),
```

- [ ] **Step 3: Add conflict builder**

```ts
function normalizeEntityKey(value: string): string {
  return value.trim().toLowerCase();
}

function buildCanonicalConflicts(
  canonicalReads: BroadSynthesisRouteRead[],
  derivedSuggestions: BroadSynthesisDerivedSuggestion[],
  mapId: string,
): BroadSynthesisConflict[] {
  const canonicalByKey = new Map(canonicalReads.map((read) => [normalizeEntityKey(read.label), read]));
  const conflicts: BroadSynthesisConflict[] = [];
  for (const suggestion of derivedSuggestions) {
    const canonical = canonicalByKey.get(normalizeEntityKey(suggestion.label));
    if (!canonical) continue;
    conflicts.push({
      entity_key: normalizeEntityKey(suggestion.label),
      canonical_page_slug: canonical.page_slug,
      derived_map_id: mapId,
      resolution: 'prefer_canonical',
      summary: `Prefer curated note ${canonical.page_slug} over map-derived suggestion ${suggestion.node_id}.`,
    });
  }
  return conflicts;
}
```

- [ ] **Step 4: Verify PR 4**

```bash
bun test test/broad-synthesis-route-service.test.ts test/scenarios/s09-curated-over-map.test.ts test/retrieval-route-selector-service.test.ts --timeout 60000
bun run test:scenarios
bunx tsc --noEmit --pretty false
bun run build
git diff --check
```

Expected: all pass. Scenario placeholder count drops from 4 to 2.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/services/broad-synthesis-route-service.ts test/broad-synthesis-route-service.test.ts test/scenarios/s09-curated-over-map.test.ts test/scenarios/README.md
git commit -m "feat: prefer canonical notes in broad synthesis"
```

## PR 5: L4 Code Claim Verification

Branch: `sprint-4-code-claim-verification`

### Task 5.1: Add Code Claim Types and Service

**Files:**

- Modify: `src/core/types.ts`
- Create: `src/core/services/code-claim-verification-service.ts`
- Create: `test/code-claim-verification-service.test.ts`

- [ ] **Step 1: Add types**

Add to `src/core/types.ts`:

```ts
export interface CodeClaim {
  path: string;
  symbol?: string;
  branch_name?: string;
  source_trace_id?: string;
}

export type CodeClaimVerificationStatus = 'current' | 'stale' | 'unverifiable';

export interface CodeClaimVerificationResult {
  claim: CodeClaim;
  status: CodeClaimVerificationStatus;
  reason: 'ok' | 'file_missing' | 'symbol_missing' | 'branch_mismatch' | 'repo_missing';
  checked_at: string;
}
```

- [ ] **Step 2: Add failing service tests**

Create tests covering:

```ts
expect(result.status).toBe('current');
expect(result.reason).toBe('ok');
```

for an existing file and symbol,

```ts
expect(result.status).toBe('stale');
expect(result.reason).toBe('file_missing');
```

for a missing file,

```ts
expect(result.status).toBe('stale');
expect(result.reason).toBe('symbol_missing');
```

for an existing file with missing symbol, and

```ts
expect(result.status).toBe('unverifiable');
expect(result.reason).toBe('repo_missing');
```

for a missing repo path.

- [ ] **Step 3: Implement verifier**

Create `src/core/services/code-claim-verification-service.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeClaim, CodeClaimVerificationResult } from '../types.ts';

export function verifyCodeClaims(input: {
  repo_path: string;
  branch_name?: string;
  claims: CodeClaim[];
  now?: Date;
}): CodeClaimVerificationResult[] {
  const checkedAt = (input.now ?? new Date()).toISOString();
  if (!existsSync(input.repo_path)) {
    return input.claims.map((claim) => ({
      claim,
      status: 'unverifiable',
      reason: 'repo_missing',
      checked_at: checkedAt,
    }));
  }

  return input.claims.map((claim) => verifyOneClaim(input.repo_path, input.branch_name, claim, checkedAt));
}

function verifyOneClaim(
  repoPath: string,
  branchName: string | undefined,
  claim: CodeClaim,
  checkedAt: string,
): CodeClaimVerificationResult {
  if (claim.branch_name && branchName && claim.branch_name !== branchName) {
    return { claim, status: 'stale', reason: 'branch_mismatch', checked_at: checkedAt };
  }

  const filePath = join(repoPath, claim.path);
  if (!existsSync(filePath)) {
    return { claim, status: 'stale', reason: 'file_missing', checked_at: checkedAt };
  }

  if (claim.symbol) {
    const content = readFileSync(filePath, 'utf8');
    if (!content.includes(claim.symbol)) {
      return { claim, status: 'stale', reason: 'symbol_missing', checked_at: checkedAt };
    }
  }

  return { claim, status: 'current', reason: 'ok', checked_at: checkedAt };
}
```

- [ ] **Step 4: Verify service**

```bash
bun test test/code-claim-verification-service.test.ts
bunx tsc --noEmit --pretty false
```

Expected: pass.

### Task 5.2: Add Trace Lookup and Operation

**Files:**

- Modify: `src/core/engine.ts`
- Modify: `src/core/sqlite-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/operations.ts`
- Test: `test/code-claim-verification-operations.test.ts`

- [ ] **Step 1: Add engine method**

Add to `BrainEngine`:

```ts
getRetrievalTrace(id: string): Promise<RetrievalTrace | null>;
```

Implement in all three engines as a primary-key lookup on `retrieval_traces`.

- [ ] **Step 2: Add `reverify_code_claims` operation**

Operation params:

```ts
repo_path: string;
branch_name?: string;
claims?: CodeClaim[];
trace_id?: string;
```

Behavior:

- If `claims` are supplied, verify them directly.
- If `trace_id` is supplied, read the trace and extract `code_claim:` verification entries.
- If any result is stale and `trace_id` was supplied, write a new retrieval trace with `route: ['code_claim_reverification']`, `source_refs: [\`retrieval_trace:${trace.id}\`]`, and `write_outcome: 'operational_write'`.

- [ ] **Step 3: Verify operation**

```bash
bun test test/code-claim-verification-operations.test.ts test/retrieval-route-trace-service.test.ts --timeout 60000
```

Expected: pass.

### Task 5.3: Wire Task Resume and Replace S11

**Files:**

- Modify: `src/core/services/task-memory-service.ts`
- Modify: `test/task-memory-service.test.ts`
- Modify: `test/scenarios/s11-code-claim-verification.test.ts`
- Modify: `test/scenarios/README.md`

- [ ] **Step 1: Extend resume card type**

In `TaskResumeCard`, add:

```ts
code_claim_verification: CodeClaimVerificationResult[];
```

Default to `[]` when no verification was run.

- [ ] **Step 2: Replace S11 todos**

First test:

- Seed a trace containing `verification: ['code_claim:src/missing.ts:MissingSymbol']`.
- Run `reverify_code_claims` with a real repo path where the file is absent.
- Assert stale result and that the original trace still exists.

Second test:

- Seed a trace with `branch_name` in the code claim.
- Run verification on a different branch name.
- Assert `reason === 'branch_mismatch'`.
- Assert resume output reports verification status instead of treating the old claim as current.

- [ ] **Step 3: Run PR 5 gate**

```bash
bun test test/code-claim-verification-service.test.ts test/code-claim-verification-operations.test.ts test/task-memory-service.test.ts test/scenarios/s11-code-claim-verification.test.ts --timeout 60000
bun run test:scenarios
bunx tsc --noEmit --pretty false
bun run build
git diff --check
```

Expected: all pass. Scenario placeholder count drops from 2 to 0.

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts src/core/engine.ts src/core/sqlite-engine.ts src/core/pglite-engine.ts src/core/postgres-engine.ts src/core/services/code-claim-verification-service.ts src/core/operations.ts src/core/services/task-memory-service.ts test/code-claim-verification-service.test.ts test/code-claim-verification-operations.test.ts test/task-memory-service.test.ts test/scenarios/s11-code-claim-verification.test.ts test/scenarios/README.md
git commit -m "feat: verify stale code claims before reuse"
```

## PR 6: Final Acceptance Closure

Branch: `sprint-final-acceptance-closure`

### Task 6.1: Verify Zero Placeholders

**Files:**

- Modify: `test/scenarios/README.md`
- Modify: `docs/MBRAIN_VERIFY.md`
- Modify: `docs/architecture/redesign/08-evaluation-and-acceptance.md`
- Create: `docs/superpowers/specs/2026-04-25-mbrain-redesign-completion-retrospective.md`

- [ ] **Step 1: Confirm no scenario placeholders**

```bash
if rg -n "test\\.todo|todo\\(" test/scenarios; then
  echo "Scenario placeholders remain"
  exit 1
fi
```

Expected: no matches and exit 0.

- [ ] **Step 2: Run final local gates**

```bash
bunx tsc --noEmit --pretty false
bun run test:scenarios
FINAL_ACCEPTANCE_TEST_HOME=$(mktemp -d /tmp/mbrain-final-acceptance-test-home.XXXXXX)
env HOME="$FINAL_ACCEPTANCE_TEST_HOME" bun test --timeout 60000
bun run build
git diff --check
git status --short
```

Expected: all pass. Before commit, `git status --short` must show only the
intended final-acceptance docs and no accidental untracked files.

- [ ] **Step 3: Verify CLI audit**

Against an initialized local SQLite brain, run:

```bash
FINAL_ACCEPTANCE_CLI_HOME=$(mktemp -d /tmp/mbrain-final-acceptance-cli-home.XXXXXX)

env HOME="$FINAL_ACCEPTANCE_CLI_HOME" \
  bun run src/cli.ts init --local \
  --path "$FINAL_ACCEPTANCE_CLI_HOME/mbrain.db" \
  --json

env HOME="$FINAL_ACCEPTANCE_CLI_HOME" \
  bun run src/cli.ts audit-brain-loop --since 24h --json
```

Expected: valid JSON matching `AuditBrainLoopReport`.

### Task 6.2: Write Completion Docs

- [ ] **Step 1: Create retrospective**

Create `docs/superpowers/specs/2026-04-25-mbrain-redesign-completion-retrospective.md` with these sections:

- Completed PR list and merge commits.
- Invariants implemented.
- Bugs caught by review and test hardening.
- Final verification evidence.
- Explicit future work outside completion: trace pruning, dashboard, scheduled audit, candidate status-event log, active-only task compliance metric.

- [ ] **Step 2: Update verification docs**

In `docs/MBRAIN_VERIFY.md`, add the final gate:

```bash
bunx tsc --noEmit --pretty false
bun run test:scenarios
FINAL_ACCEPTANCE_TEST_HOME=$(mktemp -d /tmp/mbrain-final-acceptance-test-home.XXXXXX)
env HOME="$FINAL_ACCEPTANCE_TEST_HOME" bun test --timeout 60000
bun run build
```

- [ ] **Step 3: Update acceptance doc**

In `docs/architecture/redesign/08-evaluation-and-acceptance.md`, add a short completion appendix stating:

- `audit_brain_loop` is the loop-observability verification surface.
- `test/scenarios` has zero placeholders.
- CI enforces `tsc` before tests.
- Future extensions are outside the completion boundary unless promoted into a new spec.

- [ ] **Step 4: Commit and open PR**

```bash
git add docs/superpowers/specs/2026-04-25-mbrain-redesign-completion-retrospective.md docs/MBRAIN_VERIFY.md docs/architecture/redesign/08-evaluation-and-acceptance.md docs/superpowers/plans/2026-04-24-mbrain-redesign-completion-roadmap.md docs/superpowers/plans/2026-04-25-mbrain-remaining-redesign-contracts-plan.md test/scenarios/README.md
git diff --cached --check
git commit -m "docs: close mbrain redesign acceptance plan"
git push -u origin sprint-final-acceptance-closure
gh pr create --base master --head sprint-final-acceptance-closure --title "Close mbrain redesign acceptance" --body-file /tmp/mbrain-final-acceptance-pr-body.md
```

## Review Discipline

- Each PR must start from latest `origin/master`.
- Each PR must get a critical subagent review after the main implementation commit.
- Every review finding must be checked against design docs, code, and tests before implementation.
- Every PR must pass focused tests, `bun run test:scenarios`, `bunx tsc --noEmit --pretty false`, `bun run build`, and `git diff --check`.
- Do not merge two semantic contracts into one PR.

## Self-Review

- Spec coverage: S5 closes L1, S9 closes L2, S11 closes L4, and PR 6 closes `08-evaluation-and-acceptance.md`.
- Dependency check: This plan starts only after Sprint 0 typecheck enforcement is merged.
- Scope control: No dashboard, trace pruning, cron automation, or candidate status-event log is included.
- Type consistency: Uses existing `RetrievalRouteSelectorInput`, `BroadSynthesisRoute`, `TaskResumeCard`, `RetrievalTrace`, and `BrainEngine` extension patterns.
