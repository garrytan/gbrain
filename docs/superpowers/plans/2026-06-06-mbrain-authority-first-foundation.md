# MBrain Authority-First Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first safe foundation slice of the authority-first memory improvement spec: activation labels, scoped assertion retrieval guards, Dream permission separation, and auto-promote safety gates.

**Architecture:** Build the authority substrate before adding decision packets, negative-memory projections, broad episode capture, or graph frontier retrieval. Keep canonical evidence boundaries intact: candidate, graph, and Dream outputs may guide retrieval or review, but they must not become answer authority or canonical writes without explicit policy gates.

**Tech Stack:** Bun, TypeScript, existing MBrain CLI/service patterns, `src/schema.sql` plus generated `src/core/schema-embedded.ts`, SQLite-backed unit tests where existing tests use SQLite, existing Postgres path where already present, Bun test runner, `bun run build:schema`, `bun run typecheck`.

---

## Source Specs

- `docs/superpowers/specs/2026-06-06-mbrain-authority-first-memory-improvement-design.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-full-spec-roadmap.md`
- `docs/designs/HYPER_COMPANY_BRAIN_LESSONS_FOR_MBRAIN.ko.md`
- `docs/MCP_INSTRUCTIONS.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-03-assertion-pipeline.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-04-governed-canonical-write.md`
- `docs/superpowers/specs/2026-05-20-mbrain-phase-07-dream-cycle.md`
- `docs/superpowers/specs/2026-06-01-mbrain-auto-promotion-design.md`

## Scope Check

The full spec spans several independent subsystems. This plan implements only
the foundation slice that must exist before larger features land:

- activation labels over memory artifacts,
- scope/policy labels in assertion retrieval surfaces,
- Dream permission split,
- auto-promote safety hardening,
- verification gates documenting those boundaries.

Later plans should cover:

- decision packet projection,
- applicability-scoped negative memory projection,
- proof mode and `memory-why` UX,
- allowlisted episode capture,
- bounded frontier retrieval.

Do not implement later-plan features in this branch unless this plan explicitly
asks for them.

For full-spec sequencing, use
`docs/superpowers/plans/2026-06-06-mbrain-authority-first-full-spec-roadmap.md`.
This foundation plan is Phase 1 of that series.

## Execution Rules

- Work on the current feature branch unless the user asks for a new worktree.
- Keep the existing untracked `reference/` directory untouched.
- Write failing tests before implementation for each task.
- Commit after each task's verification gate passes.
- If a task changes `src/schema.sql`, run `bun run build:schema` and commit
  `src/core/schema-embedded.ts` with the schema change.
- Preserve existing public behavior unless a task explicitly changes it.
- Do not allow raw episode, graph, or candidate artifacts to become answer
  authority as part of this plan.

## File Structure

- `src/core/types/retrieval-routing.ts`
  - Adds explicit `MemoryActivationLabel` vocabulary and optional candidate
    metadata on activation artifacts.

- `src/core/services/memory-activation-policy-service.ts`
  - Computes activation labels without breaking the existing
    `MemoryActivationDecision` field.

- `test/memory-activation-policy-service.test.ts`
  - Locks candidate, graph, stale, and personal-scope activation behavior.

- `src/schema.sql`
  - Adds scope/policy/authority labels needed by assertion retrieval in the
    Postgres fresh schema.

- `src/core/schema-embedded.ts`
  - Regenerated schema bundle.

- `src/core/pglite-schema.ts`
  - Mirrors the assertion schema additions for PGLite.

- `src/core/sqlite-engine.ts`
  - Mirrors the assertion schema additions for fresh SQLite databases and
    existing SQLite migrations.

- `src/core/migrate.ts`
  - Adds Postgres/PGLite migrations for assertion scope labels and
    policy-aware auto-promote verdict cache rows.

- `src/core/assertions/assertion-types.ts`
  - Adds scope/policy fields to assertion and assertion-link records.

- `src/core/assertions/assertion-resolution.ts`
  - Carries scope/policy labels while resolving extracted claims into
    assertions, evidence, and links.

- `src/core/assertions/assertion-evidence.ts`
  - Carries scope/policy labels while building evidence records.

- `src/core/assertions/assertion-retrieval-store.ts`
  - Enforces scope filtering before assertions can participate in retrieval.

- `test/assertion-retrieval-scope-service.test.ts`
  - Verifies scope-safe assertion lookup.

- `src/core/services/dream-cycle-runner-service.ts`
  - Splits Dream permissions and passes explicit permission flags to
    auto-promote.

- `src/commands/dream.ts`
  - Parses new Dream permission flags.

- `test/dream-cli-autopilot.test.ts`
  - Verifies CLI and autopilot pass the same expanded Dream input contract.

- `test/dream-cycle-runner-service.test.ts`
  - Verifies permission split, dry-run defaults, and auto-promote phase behavior.

- `src/core/auto-promote/service.ts`
  - Adds budget options, policy-aware verdict cache key material, and
    canonical-write permission flow.

- `src/core/auto-promote/candidate-selector.ts`
  - Blocks inferred, ambiguous, rationale, open-question, and dream-generated
    candidates from canonical auto-write eligibility.

- `src/core/auto-promote/promote-gate.ts`
  - Enforces `allow_canonical_page_writes` before `put_page`.

- `src/core/types/auto-promote.ts`
  - Adds policy-aware cache key fields.

- `src/core/postgres-engine.ts`
  - Reads and writes policy-aware auto-promote verdict cache keys.

- `src/core/pglite-engine.ts`
  - Reads and writes policy-aware auto-promote verdict cache keys.

- `test/auto-promote/candidate-selector.test.ts`
  - Locks new candidate exclusion behavior.

- `test/auto-promote/service.test.ts`
  - Locks budget and cache-key behavior.

- `test/auto-promote/promote-gate.test.ts`
  - Locks canonical write permission behavior.

- `test/auto-promote/verdict-cache.test.ts`
  - Locks policy-aware verdict cache miss/hit behavior across SQLite and
    PGLite.

- `docs/MBRAIN_VERIFY.md`
  - Adds the focused verification command for this foundation slice.

---

## Task 1: Activation Labels Contract

**Files:**

- Modify: `src/core/types/retrieval-routing.ts`
- Modify: `src/core/services/memory-activation-policy-service.ts`
- Modify: `test/memory-activation-policy-service.test.ts`

- [ ] **Step 1: Write failing tests for activation labels**

Append these tests to `test/memory-activation-policy-service.test.ts`:

```ts
  test('labels memory candidates as promote-first without answer grounding', () => {
    const result = selectActivationPolicy({
      scenario: 'project_qa',
      artifacts: [{
        id: 'candidate:direction',
        artifact_kind: 'memory_candidate',
        source_ref: 'memory-candidate:direction',
        candidate_status: 'candidate',
        target_object_type: 'curated_note',
        source_refs_count: 2,
      }],
    });

    expect(result.decisions[0]).toMatchObject({
      artifact_id: 'candidate:direction',
      decision: 'candidate_only',
      activation_label: 'promote_first',
      authority: 'unreviewed_candidate',
    });
    expect(result.next_tool).toBe('rank_memory_candidate_entries');
  });

  test('labels untargeted memory candidates as hint-only', () => {
    const result = selectActivationPolicy({
      scenario: 'knowledge_qa',
      artifacts: [{
        id: 'candidate:untargeted',
        artifact_kind: 'memory_candidate',
        source_ref: 'memory-candidate:untargeted',
        candidate_status: 'candidate',
        source_refs_count: 1,
      }],
    });

    expect(result.decisions[0]).toMatchObject({
      decision: 'candidate_only',
      activation_label: 'hint_only',
      authority: 'unreviewed_candidate',
    });
  });

  test('labels rejected and superseded candidates as audit-only', () => {
    const result = selectActivationPolicy({
      scenario: 'knowledge_qa',
      artifacts: [
        {
          id: 'candidate:rejected',
          artifact_kind: 'memory_candidate',
          candidate_status: 'rejected',
          source_ref: 'memory-candidate:rejected',
        },
        {
          id: 'candidate:superseded',
          artifact_kind: 'memory_candidate',
          candidate_status: 'superseded',
          source_ref: 'memory-candidate:superseded',
        },
      ],
    });

    expect(result.decisions.map((decision) => decision.activation_label)).toEqual([
      'audit_only',
      'audit_only',
    ]);
    expect(result.decisions.every((decision) => decision.decision === 'candidate_only')).toBe(true);
  });
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
bun test test/memory-activation-policy-service.test.ts
```

Expected: FAIL with TypeScript errors or assertion failures because
`candidate_status`, `target_object_type`, `source_refs_count`, and
`activation_label` do not exist yet.

- [ ] **Step 3: Extend activation types**

Modify `src/core/types/retrieval-routing.ts` near `MemoryActivationDecision`:

```ts
export type MemoryActivationDecision =
  | 'answer_ground'
  | 'citation_only'
  | 'orientation_only'
  | 'verify_first'
  | 'suppress_if_valid'
  | 'candidate_only'
  | 'ignore';

export type MemoryActivationLabel =
  | 'answer_ground'
  | 'citation_only'
  | 'orientation_only'
  | 'hint_only'
  | 'promote_first'
  | 'audit_only'
  | 'verify_first'
  | 'suppress_if_valid'
  | 'candidate_only'
  | 'ignore';
```

Extend `MemoryActivationArtifact`:

```ts
export interface MemoryActivationArtifact {
  id: string;
  artifact_kind: MemoryArtifactKind;
  source_ref?: string;
  stale?: boolean;
  anchors_valid?: boolean;
  scope_policy?: ScopeGatePolicy;
  candidate_status?: MemoryCandidateStatus;
  target_object_type?: MemoryCandidateTargetObjectType;
  source_refs_count?: number;
}
```

Extend `MemoryActivationPolicyDecision`:

```ts
export interface MemoryActivationPolicyDecision {
  artifact_id: string;
  decision: MemoryActivationDecision;
  activation_label: MemoryActivationLabel;
  authority: MemoryArtifactAuthority;
  reason_codes: string[];
  source_ref: string | null;
}
```

- [ ] **Step 4: Implement label calculation**

Modify `src/core/services/memory-activation-policy-service.ts` so
`buildDecision` accepts an optional label:

```ts
function buildDecision(
  artifact: MemoryActivationArtifact,
  decision: MemoryActivationPolicyDecision['decision'],
  authority: MemoryArtifactAuthority,
  reason_codes: string[],
  activationLabel: MemoryActivationPolicyDecision['activation_label'] = decision,
): MemoryActivationPolicyDecision {
  return {
    artifact_id: artifact.id,
    decision,
    activation_label: activationLabel,
    authority,
    reason_codes,
    source_ref: artifact.source_ref ?? null,
  };
}
```

Add helper functions:

```ts
function candidateActivationLabel(
  artifact: MemoryActivationArtifact,
): MemoryActivationPolicyDecision['activation_label'] {
  if (artifact.candidate_status === 'rejected' || artifact.candidate_status === 'superseded') {
    return 'audit_only';
  }
  if (
    artifact.target_object_type === 'curated_note'
    && (artifact.source_refs_count ?? 0) > 0
  ) {
    return 'promote_first';
  }
  return 'hint_only';
}
```

Change the `memory_candidate` case:

```ts
  case 'memory_candidate':
    return buildDecision(
      artifact,
      'candidate_only',
      'unreviewed_candidate',
      ['memory_candidate'],
      candidateActivationLabel(artifact),
    );
```

- [ ] **Step 5: Run the focused gate**

Run:

```bash
bun test test/memory-activation-policy-service.test.ts
bun run typecheck
```

Expected: PASS. Existing activation decisions remain unchanged, and the new
`activation_label` gives callers a safer vocabulary.

- [ ] **Step 6: Commit**

```bash
git add src/core/types/retrieval-routing.ts src/core/services/memory-activation-policy-service.ts test/memory-activation-policy-service.test.ts
git commit -m "feat: add memory activation labels"
```

---

## Task 2: Scope-Safe Assertion Retrieval Substrate

**Files:**

- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Modify: `src/core/pglite-schema.ts`
- Modify: `src/core/sqlite-engine.ts`
- Modify: `src/core/migrate.ts`
- Modify: `src/core/assertions/assertion-types.ts`
- Modify: `src/core/assertions/assertion-resolution.ts`
- Modify: `src/core/assertions/assertion-evidence.ts`
- Modify: `src/core/assertions/assertion-retrieval-store.ts`
- Create: `test/assertion-retrieval-scope-service.test.ts`

- [ ] **Step 1: Write failing scope tests**

Create `test/assertion-retrieval-scope-service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { listRetrievableAssertionsForEngine } from '../src/core/assertions/assertion-retrieval-store.ts';

describe('assertion retrieval scope safety', () => {
  test('filters SQL assertions by scope before planning retrieval', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const engine = {
      db: {
        query: async (sql: string, params: unknown[] = []) => {
          seen.push({ sql, params });
          return {
            rows: [{
              id: 'assertion-work',
              scope_id: 'workspace:default',
              policy_version: 'policy:v1',
              authority_scope: 'work',
              claim_type: 'architecture_claim',
              target_type: 'curated_note',
              target_id: 'systems/mbrain',
              target_slug: 'systems/mbrain',
              property: 'runtime',
              value_json: { text: 'Markdown remains canonical.' },
              normalized_claim: 'Markdown remains canonical.',
              authority_summary: {},
              confidence: 0.9,
              evidence_count: 1,
              authority_state: 'canonical',
              lifecycle_state: 'active',
              valid_from: null,
              valid_until: null,
              supersedes_assertion_id: null,
              superseded_by_assertion_id: null,
              conflict_set_id: null,
              created_at: '2026-06-06T00:00:00.000Z',
              updated_at: '2026-06-06T00:00:00.000Z',
            }],
          };
        },
      },
    } as any;

    const result = await listRetrievableAssertionsForEngine(engine, {
      scope_id: 'workspace:default',
      target_slug: 'systems/mbrain',
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.assertion.scope_id).toBe('workspace:default');
    expect(seen[0]!.sql).toContain('scope_id = $');
    expect(seen[0]!.params).toContain('workspace:default');
    expect(seen[0]!.params).toContain('systems/mbrain');
  });

  test('rejects frontier-style lookup without explicit scope id', async () => {
    const engine = { db: { query: async () => ({ rows: [] }) } } as any;

    await expect(listRetrievableAssertionsForEngine(engine, {
      frontier: true,
    })).rejects.toThrow('scope_id is required for assertion frontier retrieval');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test test/assertion-retrieval-scope-service.test.ts
```

Expected: FAIL because assertion records do not expose `scope_id`, SQL does not
filter by scope, and `frontier: true` is not handled.

- [ ] **Step 3: Add schema labels to fresh schemas**

Modify the `assertions`, `assertion_evidence`, and `assertion_links` table
definitions in `src/schema.sql` with these fields.

In `assertions`, add the fields immediately after `id`:

```sql
  scope_id                   TEXT NOT NULL DEFAULT 'workspace:default',
  policy_version             TEXT NOT NULL DEFAULT 'policy:v1',
  authority_scope            TEXT NOT NULL DEFAULT 'work',
```

In `assertion_evidence`, add the fields immediately after `assertion_id`:

```sql
  scope_id             TEXT NOT NULL DEFAULT 'workspace:default',
  policy_version       TEXT NOT NULL DEFAULT 'policy:v1',
  authority_scope      TEXT NOT NULL DEFAULT 'work',
```

In `assertion_links`, add the fields immediately after `id`:

```sql
  scope_id           TEXT NOT NULL DEFAULT 'workspace:default',
  policy_version     TEXT NOT NULL DEFAULT 'policy:v1',
```

Add these indexes near the existing assertion indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_assertions_scope_target_property
  ON assertions(scope_id, target_slug, target_type, target_id, property);
CREATE INDEX IF NOT EXISTS idx_assertion_evidence_scope_assertion
  ON assertion_evidence(scope_id, assertion_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assertion_links_scope_from
  ON assertion_links(scope_id, from_assertion_id, link_type);
```

Run:

```bash
bun run build:schema
```

Then mirror the same table-definition and index changes in
`src/core/pglite-schema.ts` and the SQLite `SCHEMA_SQL` string in
`src/core/sqlite-engine.ts`. Expected: `src/core/schema-embedded.ts` is
regenerated, and fresh Postgres, PGLite, and SQLite databases all create the
new columns.

- [ ] **Step 4: Add migrations for existing databases**

Modify `src/core/migrate.ts` by appending a new migration after version 50:

```ts
  {
    version: 51,
    name: 'assertion_scope_policy_labels',
    sql: `
      ALTER TABLE assertions ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT 'workspace:default';
      ALTER TABLE assertions ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'policy:v1';
      ALTER TABLE assertions ADD COLUMN IF NOT EXISTS authority_scope TEXT NOT NULL DEFAULT 'work';
      ALTER TABLE assertion_evidence ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT 'workspace:default';
      ALTER TABLE assertion_evidence ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'policy:v1';
      ALTER TABLE assertion_evidence ADD COLUMN IF NOT EXISTS authority_scope TEXT NOT NULL DEFAULT 'work';
      ALTER TABLE assertion_links ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT 'workspace:default';
      ALTER TABLE assertion_links ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'policy:v1';
      CREATE INDEX IF NOT EXISTS idx_assertions_scope_target_property
        ON assertions(scope_id, target_slug, target_type, target_id, property);
      CREATE INDEX IF NOT EXISTS idx_assertion_evidence_scope_assertion
        ON assertion_evidence(scope_id, assertion_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assertion_links_scope_from
        ON assertion_links(scope_id, from_assertion_id, link_type);
    `,
  },
```

Modify `src/core/sqlite-engine.ts` in `runSqliteMigrations` by adding
`case 51`. Use SQLite column introspection before each `ALTER TABLE`:

```ts
        case 51:
          this.ensureAssertionScopePolicyColumns();
          break;
```

Add this helper near `ensureAssertionPipelineSchema` helpers:

```ts
  private ensureAssertionScopePolicyColumns(): void {
    const addColumn = (table: string, column: string, definition: string) => {
      const columns = this.database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((entry) => entry.name === column)) {
        this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };

    addColumn('assertions', 'scope_id', "TEXT NOT NULL DEFAULT 'workspace:default'");
    addColumn('assertions', 'policy_version', "TEXT NOT NULL DEFAULT 'policy:v1'");
    addColumn('assertions', 'authority_scope', "TEXT NOT NULL DEFAULT 'work'");
    addColumn('assertion_evidence', 'scope_id', "TEXT NOT NULL DEFAULT 'workspace:default'");
    addColumn('assertion_evidence', 'policy_version', "TEXT NOT NULL DEFAULT 'policy:v1'");
    addColumn('assertion_evidence', 'authority_scope', "TEXT NOT NULL DEFAULT 'work'");
    addColumn('assertion_links', 'scope_id', "TEXT NOT NULL DEFAULT 'workspace:default'");
    addColumn('assertion_links', 'policy_version', "TEXT NOT NULL DEFAULT 'policy:v1'");
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_assertions_scope_target_property
        ON assertions(scope_id, target_slug, target_type, target_id, property);
      CREATE INDEX IF NOT EXISTS idx_assertion_evidence_scope_assertion
        ON assertion_evidence(scope_id, assertion_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assertion_links_scope_from
        ON assertion_links(scope_id, from_assertion_id, link_type);
    `);
  }
```

- [ ] **Step 5: Extend assertion types**

Modify `src/core/assertions/assertion-types.ts`.

Add to `AssertionRecord`:

```ts
  scope_id: string;
  policy_version: string;
  authority_scope: string;
```

Add to `AssertionEvidenceInput`:

```ts
  scope_id?: string;
  policy_version?: string;
  authority_scope?: string;
```

Add to `AssertionEvidenceRecord`:

```ts
  scope_id: string;
  policy_version: string;
  authority_scope: string;
```

Add to `AssertionLinkRecord`:

```ts
  scope_id: string;
  policy_version: string;
```

Modify `ResolveExtractedClaimInput` in
`src/core/assertions/assertion-resolution.ts`:

```ts
  scope_id?: string;
  policy_version?: string;
  authority_scope?: string;
```

Modify the local `AssertionEvidenceInput` interface in
`src/core/assertions/assertion-evidence.ts`:

```ts
  scope_id?: string;
  policy_version?: string;
  authority_scope?: string;
```

Update assertion construction so default labels are created with new records:

```ts
scope_id: input.scope_id ?? 'workspace:default',
policy_version: input.policy_version ?? 'policy:v1',
authority_scope: input.authority_scope ?? 'work',
```

Apply that default in `newAssertion`, `buildAssertionEvidence`, and
`lineage`/link creation sites that construct `AssertionLinkRecord`.

- [ ] **Step 6: Enforce scope filtering**

Modify `src/core/assertions/assertion-retrieval-store.ts`.

Add helper:

```ts
function requireScopeForFrontier(filters: AssertionRetrievalFilters): void {
  if (filters.frontier === true && !filters.scope_id) {
    throw new Error('scope_id is required for assertion frontier retrieval');
  }
}
```

Extend `AssertionRetrievalFilters`:

```ts
  frontier?: boolean;
```

Call it at the start of `listAssertionRows`.

Replace the Postgres `where` construction with:

```ts
const clauses: string[] = [];
const params: unknown[] = [];
if (filters.scope_id) {
  params.push(filters.scope_id);
  clauses.push(`scope_id = $${params.length}`);
}
if (filters.target_slug) {
  params.push(filters.target_slug);
  clauses.push(`target_slug = $${params.length}`);
}
const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
```

Use the same predicate pattern for SQLite `database` and async `db` branches.
For SQLite positional parameters use `?` placeholders in the same order.

Update `rowToAssertion` in the same file to populate:

```ts
scope_id: String(row.scope_id ?? 'workspace:default'),
policy_version: String(row.policy_version ?? 'policy:v1'),
authority_scope: String(row.authority_scope ?? 'work'),
```

- [ ] **Step 7: Run the focused gate**

Run:

```bash
bun test test/assertion-retrieval-scope-service.test.ts test/assertion-operations.test.ts
bun test test/sqlite-engine.test.ts test/pglite-engine.test.ts
bun run typecheck
```

Expected: PASS. Existing assertion operation tests still pass.

- [ ] **Step 8: Commit**

```bash
git add src/schema.sql src/core/schema-embedded.ts src/core/pglite-schema.ts src/core/sqlite-engine.ts src/core/migrate.ts src/core/assertions/assertion-types.ts src/core/assertions/assertion-resolution.ts src/core/assertions/assertion-evidence.ts src/core/assertions/assertion-retrieval-store.ts test/assertion-retrieval-scope-service.test.ts
git commit -m "feat: add scope-safe assertion retrieval"
```

---

## Task 3: Dream Permission Split

**Files:**

- Modify: `src/core/services/dream-cycle-runner-service.ts`
- Modify: `src/commands/dream.ts`
- Modify: `test/dream-cli-autopilot.test.ts`
- Modify: `test/dream-cycle-runner-service.test.ts`

- [ ] **Step 1: Write failing CLI contract tests**

Append to `test/dream-cli-autopilot.test.ts`:

```ts
  test('dream permission flags are split beyond apply', async () => {
    const { parseDreamArgs } = await importFreshDreamCommand();

    expect(parseDreamArgs(['--apply'], 'cli')).toMatchObject({
      dry_run: false,
      write_candidates: true,
      apply_auto_promote: false,
      allow_canonical_page_writes: false,
    });

    expect(parseDreamArgs([
      '--apply',
      '--apply-auto-promote',
      '--allow-canonical-page-writes',
      '--max-runner-calls', '3',
      '--time-budget-ms', '5000',
      '--max-candidates-per-cycle', '8',
    ], 'cli')).toMatchObject({
      dry_run: false,
      write_candidates: true,
      apply_auto_promote: true,
      allow_canonical_page_writes: true,
      max_runner_calls: 3,
      time_budget_ms: 5000,
      max_candidates_per_cycle: 8,
    });
  });
```

- [ ] **Step 2: Write failing runner behavior tests**

Append to `test/dream-cycle-runner-service.test.ts`:

```ts
  test('auto-promote is dry-run unless apply_auto_promote is explicitly enabled', async () => {
    const calls: any[] = [];
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-06-06T00:00:00.000Z',
      dry_run: false,
      write_candidates: true,
      apply_auto_promote: false,
      allow_local_runner: true,
    } as any, {
      autoPromote: {
        run: async (input: any) => {
          calls.push(input);
          return { counts: { selected_low_risk: 1, canonical_writes: 0 } };
        },
      },
    });

    expect(calls[0]).toMatchObject({
      dry_run: true,
      allow_canonical_page_writes: false,
    });
    expect(result.phases.find((phase) => phase.family === 'auto_promote')).toMatchObject({
      status: 'warn',
    });
  });

  test('auto-promote receives canonical write permission only when explicitly allowed', async () => {
    const calls: any[] = [];
    await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-06-06T00:00:00.000Z',
      dry_run: false,
      write_candidates: true,
      apply_auto_promote: true,
      allow_canonical_page_writes: true,
      allow_local_runner: true,
      max_runner_calls: 2,
      time_budget_ms: 1000,
      max_candidates_per_cycle: 4,
    } as any, {
      autoPromote: {
        run: async (input: any) => {
          calls.push(input);
          return { counts: {} };
        },
      },
    });

    expect(calls[0]).toMatchObject({
      dry_run: false,
      allow_canonical_page_writes: true,
      max_runner_calls: 2,
      time_budget_ms: 1000,
      limit: 4,
    });
  });
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
bun test test/dream-cli-autopilot.test.ts test/dream-cycle-runner-service.test.ts
```

Expected: FAIL because the new Dream input fields and CLI flags do not exist.

- [ ] **Step 4: Extend Dream input types**

Modify `src/core/services/dream-cycle-runner-service.ts`.

Extend `DreamCycleRunInput`:

```ts
  apply_auto_promote?: boolean;
  allow_canonical_page_writes?: boolean;
  max_runner_calls?: number;
  time_budget_ms?: number;
  max_candidates_per_cycle?: number;
```

Extend `DreamCyclePhaseContext['input']`:

```ts
    apply_auto_promote: boolean;
    allow_canonical_page_writes: boolean;
    max_runner_calls?: number;
    time_budget_ms?: number;
    max_candidates_per_cycle?: number;
```

Extend the auto-promote dependency type:

```ts
  autoPromote?: {
    run(input: {
      scope_id: string;
      now?: string;
      dry_run?: boolean;
      limit?: number;
      allow_canonical_page_writes?: boolean;
      max_runner_calls?: number;
      time_budget_ms?: number;
    }): Promise<{ counts: Record<string, number> }>;
  };
```

Update `normalizeRunInput`:

```ts
    apply_auto_promote: input.apply_auto_promote === true,
    allow_canonical_page_writes: input.allow_canonical_page_writes === true,
    max_runner_calls: input.max_runner_calls,
    time_budget_ms: input.time_budget_ms,
    max_candidates_per_cycle: input.max_candidates_per_cycle,
```

- [ ] **Step 5: Parse new Dream flags**

Modify `src/commands/dream.ts`.

Update `parseDreamArgs` return object:

```ts
    apply_auto_promote: !dryRun && hasFlag(args, '--apply-auto-promote'),
    allow_canonical_page_writes: !dryRun && hasFlag(args, '--allow-canonical-page-writes'),
    ...(readNumberFlag(args, '--max-runner-calls') !== undefined ? { max_runner_calls: readNumberFlag(args, '--max-runner-calls') } : {}),
    ...(readNumberFlag(args, '--time-budget-ms') !== undefined ? { time_budget_ms: readNumberFlag(args, '--time-budget-ms') } : {}),
    ...(readNumberFlag(args, '--max-candidates-per-cycle') !== undefined ? { max_candidates_per_cycle: readNumberFlag(args, '--max-candidates-per-cycle') } : {}),
```

Update help text:

```text
  mbrain dream [--dry-run|--apply] [--write-candidates]
               [--apply-auto-promote] [--allow-canonical-page-writes]
               [--max-candidates-per-cycle N] [--max-runner-calls N]
               [--time-budget-ms N]
```

- [ ] **Step 6: Pass split permissions to auto-promote**

Modify `runAutoPromotePhase` in
`src/core/services/dream-cycle-runner-service.ts`:

```ts
  const autoPromoteApply = context.input.dry_run
    ? false
    : context.input.write_candidates && context.input.apply_auto_promote;
  const result = await deps.autoPromote.run({
    scope_id: context.input.scope_id,
    now: context.input.now,
    dry_run: !autoPromoteApply,
    limit: context.input.max_candidates_per_cycle ?? context.input.limit,
    allow_canonical_page_writes: autoPromoteApply && context.input.allow_canonical_page_writes,
    max_runner_calls: context.input.max_runner_calls,
    time_budget_ms: context.input.time_budget_ms,
  });
```

- [ ] **Step 7: Run the focused gate**

Run:

```bash
bun test test/dream-cli-autopilot.test.ts test/dream-cycle-runner-service.test.ts test/auto-promote/dream-phase.test.ts
bun run typecheck
```

Expected: PASS. `--apply` alone writes candidates only. Auto-promote apply and
canonical page writes require explicit flags.

- [ ] **Step 8: Commit**

```bash
git add src/core/services/dream-cycle-runner-service.ts src/commands/dream.ts test/dream-cli-autopilot.test.ts test/dream-cycle-runner-service.test.ts
git commit -m "feat: split dream apply permissions"
```

---

## Task 4: Auto-Promote Safety Gates

**Files:**

- Modify: `src/core/auto-promote/service.ts`
- Modify: `src/core/auto-promote/candidate-selector.ts`
- Modify: `src/core/auto-promote/promote-gate.ts`
- Modify: `src/core/types/auto-promote.ts`
- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Modify: `src/core/pglite-schema.ts`
- Modify: `src/core/sqlite-engine.ts`
- Modify: `src/core/migrate.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `test/auto-promote/candidate-selector.test.ts`
- Modify: `test/auto-promote/service.test.ts`
- Modify: `test/auto-promote/promote-gate.test.ts`
- Modify: `test/auto-promote/verdict-cache.test.ts`
- Modify: `src/commands/auto-promote.ts`

- [ ] **Step 1: Write failing candidate selector tests**

Append to `test/auto-promote/candidate-selector.test.ts`:

```ts
  it('excludes dream-generated candidates from auto-promote eligibility', () => {
    const r = selectAutoPromoteCandidates([{ ...base, generated_by: 'dream_cycle' }], policy);
    expect(r.low_risk).toHaveLength(0);
    expect(r.risky).toHaveLength(0);
    expect(r.excluded[0].reason).toBe('generated_by_excluded:dream_cycle');
  });

  it('excludes inferred and ambiguous candidates from canonical auto-write eligibility', () => {
    const inferred = selectAutoPromoteCandidates([{ ...base, extraction_kind: 'inferred' }], policy);
    const ambiguous = selectAutoPromoteCandidates([{ ...base, extraction_kind: 'ambiguous' }], policy);

    expect(inferred.risky).toHaveLength(0);
    expect(inferred.excluded[0].reason).toBe('evidence_excluded:risky_inferred');
    expect(ambiguous.risky).toHaveLength(0);
    expect(ambiguous.excluded[0].reason).toBe('evidence_excluded:risky_ambiguous');
  });
```

- [ ] **Step 2: Write failing promote gate test**

Append to `test/auto-promote/promote-gate.test.ts`:

```ts
  it('records canonical handoff but skips page write without canonical write permission', async () => {
    await withEngine(async (engine) => {
      const target = await seedTargetPage(engine);
      const candidate = await seedEligibleCandidate(engine);
      const result = await runPromoteGate({
        engine,
        verdicts: [{
          candidate_id: candidate.id,
          decision: 'promote' as const,
          confidence: 0.95,
          reasoning: 'clear source-backed candidate',
          source_refs: ['source:item:1'],
        }],
        candidates: [candidate],
        config: { ...defaultAutoPromoteConfig(), dry_run: false },
        now: '2026-06-06T00:00:00.000Z',
        actor: 'mbrain:auto_promote',
        target_snapshot_hashes: new Map([[candidate.id, target.content_hash ?? null]]),
        allow_canonical_page_writes: false,
      });

      expect(result.promoted).toEqual([candidate.id]);
      expect(result.canonical_handoffs).toEqual([candidate.id]);
      expect(result.canonical_writes).toEqual([]);
      expect(result.skipped).toContainEqual({
        id: candidate.id,
        reason: 'canonical_page_writes_not_allowed',
      });
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).not.toContain('Acme raised a seed round.');
    });
  });
```

- [ ] **Step 3: Write failing service budget/cache test**

Append to `test/auto-promote/service.test.ts`:

```ts
  it('uses policy-aware verdict cache keys and respects runner call budget', async () => {
    await withEngine(async (engine) => {
      await seedTargetPage(engine);
      await seedEligibleCandidate(engine, 'cand-1');
      await seedEligibleCandidate(engine, 'cand-2', { target_object_id: 'concepts/acme' });
      const calls: any[] = [];

      await runAutoPromote({
        engine,
        config: { ...defaultAutoPromoteConfig(), enabled: true, dry_run: false },
        now: '2026-06-06T00:00:00.000Z',
        runner: { kind: 'claude_code' } as any,
        runnerExecutor: async (request) => {
          calls.push(request);
          return {
            status: 'succeeded' as const,
            output: JSON.stringify({ decision: 'defer', confidence: 0.5, reasoning: 'budget test' }),
            token_usage_json: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            cost_estimate_usd: null,
          };
        },
        contextLoader: (targetRef) => pageContext(engine, targetRef),
        scope_id: 'workspace:default',
        max_runner_calls: 1,
        policy_cache_context: {
          source_policy_hash: 'source-policy:v1',
          trust_policy_version: 'trust:v1',
          redaction_version: 'redaction:v1',
          config_hash: 'config:v1',
        },
      });

      expect(calls).toHaveLength(1);
      const rows = (engine as any).db.query('SELECT * FROM auto_promote_verdicts').all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        scope_id: 'workspace:default',
        source_policy_hash: 'source-policy:v1',
        trust_policy_version: 'trust:v1',
        redaction_version: 'redaction:v1',
        config_hash: 'config:v1',
      });
      expect(rows[0]!.target_content_hash).toBeTruthy();
    });
  });
```

- [ ] **Step 4: Write failing verdict cache storage tests**

Modify the `key` constant in `test/auto-promote/verdict-cache.test.ts`:

```ts
  const key = {
    candidate_id: 'c1',
    content_hash: 'h1',
    runner_kind: 'claude_code',
    prompt_version: 'auto-promote-v1',
    scope_id: 'workspace:default',
    source_policy_hash: 'source-policy:v1',
    trust_policy_version: 'trust:v1',
    redaction_version: 'redaction:v1',
    config_hash: 'config:v1',
    target_content_hash: 'target-hash:v1',
  };
```

Add this test after the SQLite test:

```ts
  it('SQLite: misses when policy context changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-apv-policy-'));
    const engine = new SQLiteEngine();
    try {
      await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
      await engine.initSchema();
      await engine.putAutoPromoteVerdict({
        ...key,
        decision: 'promote',
        confidence: 0.9,
        reasoning: 'ok',
        judged_at: '2026-06-01T00:00:00Z',
      });
      expect(await engine.getAutoPromoteVerdict(key)).not.toBeNull();
      expect(await engine.getAutoPromoteVerdict({
        ...key,
        trust_policy_version: 'trust:v2',
      })).toBeNull();
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 5: Run failing tests**

Run:

```bash
bun test test/auto-promote/candidate-selector.test.ts test/auto-promote/service.test.ts test/auto-promote/promote-gate.test.ts test/auto-promote/verdict-cache.test.ts
```

Expected: FAIL because candidate exclusions, canonical write permission, budget
controls, and policy-aware cache keys are not implemented.

- [ ] **Step 6: Exclude unsafe candidate kinds**

Modify `src/core/auto-promote/candidate-selector.ts`.

Before evidence classification, add:

```ts
    if (c.generated_by === 'dream_cycle') {
      result.excluded.push({ candidate: c, reason: 'generated_by_excluded:dream_cycle' });
      continue;
    }
```

Change risky evidence handling:

```ts
    if (evidence === 'risky') {
      result.excluded.push({
        candidate: c,
        reason: `evidence_excluded:risky_${c.extraction_kind}`,
      });
      continue;
    }
```

This plan intentionally removes automatic risky escalation from canonical
auto-write eligibility. Future review-only escalation can be added as a separate
reporting feature.

- [ ] **Step 7: Add canonical write permission to promote gate**

Modify `src/core/auto-promote/promote-gate.ts`.

Extend `PromoteGateInput`:

```ts
  allow_canonical_page_writes?: boolean;
```

At the start of `canonicalizePromotedCandidate`, after the page-backed check,
record handoff first, then gate `put_page`:

```ts
  const handoff = await recordCanonicalHandoff(input.engine, {
    candidate_id: candidate.id,
    reviewed_at: input.now,
    review_reason: `auto_promote canonical handoff (${input.actor})`,
  });
  if (input.allow_canonical_page_writes !== true) {
    return { handoff: true, skipped_reason: 'canonical_page_writes_not_allowed' };
  }
```

Delete the later `recordCanonicalHandoff` call in the same function so each
promoted candidate creates exactly one handoff row.

- [ ] **Step 8: Extend policy-aware verdict key storage**

Modify the fresh `auto_promote_verdicts` table definitions in `src/schema.sql`,
`src/core/pglite-schema.ts`, and the SQLite `SCHEMA_SQL` string in
`src/core/sqlite-engine.ts`:

```sql
      CREATE TABLE IF NOT EXISTS auto_promote_verdicts (
        candidate_id         TEXT NOT NULL,
        content_hash         TEXT NOT NULL,
        runner_kind          TEXT NOT NULL,
        prompt_version       TEXT NOT NULL,
        scope_id             TEXT NOT NULL DEFAULT 'workspace:default',
        source_policy_hash   TEXT NOT NULL DEFAULT 'source-policy:unknown',
        trust_policy_version TEXT NOT NULL DEFAULT 'trust-policy:unknown',
        redaction_version    TEXT NOT NULL DEFAULT 'redaction:unknown',
        config_hash          TEXT NOT NULL DEFAULT 'config:unknown',
        target_content_hash  TEXT NOT NULL DEFAULT '',
        decision             TEXT NOT NULL,
        confidence           REAL NOT NULL,
        reasoning            TEXT NOT NULL DEFAULT '',
        judged_at            TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (
          candidate_id,
          content_hash,
          runner_kind,
          prompt_version,
          scope_id,
          source_policy_hash,
          trust_policy_version,
          redaction_version,
          config_hash,
          target_content_hash
        )
      );
```

Use `TEXT NOT NULL` for `judged_at` in the SQLite string.

Run:

```bash
bun run build:schema
```

Expected: `src/core/schema-embedded.ts` is regenerated with the policy-aware
verdict cache table definition.

Append migration version 52 to `src/core/migrate.ts`:

```ts
  {
    version: 52,
    name: 'auto_promote_policy_cache_key',
    sql: `
      ALTER TABLE auto_promote_verdicts ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT 'workspace:default';
      ALTER TABLE auto_promote_verdicts ADD COLUMN IF NOT EXISTS source_policy_hash TEXT NOT NULL DEFAULT 'source-policy:unknown';
      ALTER TABLE auto_promote_verdicts ADD COLUMN IF NOT EXISTS trust_policy_version TEXT NOT NULL DEFAULT 'trust-policy:unknown';
      ALTER TABLE auto_promote_verdicts ADD COLUMN IF NOT EXISTS redaction_version TEXT NOT NULL DEFAULT 'redaction:unknown';
      ALTER TABLE auto_promote_verdicts ADD COLUMN IF NOT EXISTS config_hash TEXT NOT NULL DEFAULT 'config:unknown';
      ALTER TABLE auto_promote_verdicts ADD COLUMN IF NOT EXISTS target_content_hash TEXT NOT NULL DEFAULT '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_promote_verdicts_policy_key
        ON auto_promote_verdicts(
          candidate_id,
          content_hash,
          runner_kind,
          prompt_version,
          scope_id,
          source_policy_hash,
          trust_policy_version,
          redaction_version,
          config_hash,
          target_content_hash
        );
    `,
  },
```

Add SQLite migration case 52 in `src/core/sqlite-engine.ts`:

```ts
        case 52:
          this.ensureAutoPromotePolicyCacheKeySchema();
          break;
```

Add the helper:

```ts
  private ensureAutoPromotePolicyCacheKeySchema(): void {
    const columns = this.database.query('PRAGMA table_info(auto_promote_verdicts)').all() as Array<{ name: string }>;
    const hasColumn = (name: string) => columns.some((entry) => entry.name === name);
    const add = (name: string, definition: string) => {
      if (!hasColumn(name)) {
        this.database.exec(`ALTER TABLE auto_promote_verdicts ADD COLUMN ${name} ${definition}`);
      }
    };

    add('scope_id', "TEXT NOT NULL DEFAULT 'workspace:default'");
    add('source_policy_hash', "TEXT NOT NULL DEFAULT 'source-policy:unknown'");
    add('trust_policy_version', "TEXT NOT NULL DEFAULT 'trust-policy:unknown'");
    add('redaction_version', "TEXT NOT NULL DEFAULT 'redaction:unknown'");
    add('config_hash', "TEXT NOT NULL DEFAULT 'config:unknown'");
    add('target_content_hash', "TEXT NOT NULL DEFAULT ''");
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_promote_verdicts_policy_key
        ON auto_promote_verdicts(
          candidate_id,
          content_hash,
          runner_kind,
          prompt_version,
          scope_id,
          source_policy_hash,
          trust_policy_version,
          redaction_version,
          config_hash,
          target_content_hash
        );
    `);
  }
```

Modify `src/core/types/auto-promote.ts`:

```ts
export interface AutoPromoteVerdictKey {
  candidate_id: string;
  content_hash: string;
  runner_kind: string;
  prompt_version: string;
  scope_id?: string;
  source_policy_hash?: string;
  trust_policy_version?: string;
  redaction_version?: string;
  config_hash?: string;
  target_content_hash?: string | null;
}
```

- [ ] **Step 9: Update verdict cache engine methods**

Modify `getAutoPromoteVerdict`, `putAutoPromoteVerdict`, and
`rowToAutoPromoteVerdict` support in `src/core/sqlite-engine.ts`,
`src/core/postgres-engine.ts`, and `src/core/pglite-engine.ts`.

Use this WHERE predicate in all three engines:

```sql
candidate_id = ?
AND content_hash = ?
AND runner_kind = ?
AND prompt_version = ?
AND scope_id = ?
AND source_policy_hash = ?
AND trust_policy_version = ?
AND redaction_version = ?
AND config_hash = ?
AND target_content_hash = ?
```

Use `$1..$10` placeholders in `src/core/postgres-engine.ts`, template-literal
parameters in `src/core/pglite-engine.ts`, and `?` placeholders in
`src/core/sqlite-engine.ts`. Bind `key.target_content_hash ?? ''` for the
target-content parameter and store `row.target_content_hash ?? ''` on insert.

In every INSERT/UPSERT, include the six new key columns and use the unique index
conflict target when the engine supports explicit conflict columns:

```sql
ON CONFLICT (
  candidate_id,
  content_hash,
  runner_kind,
  prompt_version,
  scope_id,
  source_policy_hash,
  trust_policy_version,
  redaction_version,
  config_hash,
  target_content_hash
) DO UPDATE SET
  decision = EXCLUDED.decision,
  confidence = EXCLUDED.confidence,
  reasoning = EXCLUDED.reasoning,
  judged_at = EXCLUDED.judged_at
```

- [ ] **Step 10: Add budget and policy context to auto-promote service**

Modify `RunAutoPromoteInput` in `src/core/auto-promote/service.ts`:

```ts
  max_runner_calls?: number;
  time_budget_ms?: number;
  allow_canonical_page_writes?: boolean;
  policy_cache_context?: {
    source_policy_hash: string;
    trust_policy_version: string;
    redaction_version: string;
    config_hash: string;
  };
```

Track budget in `runAutoPromote`:

```ts
  let runnerCalls = 0;
  const maxRunnerCalls = input.max_runner_calls ?? Number.POSITIVE_INFINITY;
```

Before each `judge` call:

```ts
    if (runnerCalls >= maxRunnerCalls) break;
    runnerCalls += 1;
```

Pass `allow_canonical_page_writes` to `runPromoteGate`:

```ts
    allow_canonical_page_writes: input.allow_canonical_page_writes === true,
```

Build verdict key with policy context:

```ts
  const key = {
    candidate_id: c.id,
    content_hash: contentHash,
    runner_kind: input.runner.kind,
    prompt_version: PROMPT_VERSION,
    scope_id: input.scope_id ?? 'workspace:default',
    source_policy_hash: input.policy_cache_context?.source_policy_hash ?? 'source-policy:unknown',
    trust_policy_version: input.policy_cache_context?.trust_policy_version ?? 'trust-policy:unknown',
    redaction_version: input.policy_cache_context?.redaction_version ?? 'redaction:unknown',
    config_hash: input.policy_cache_context?.config_hash ?? 'config:unknown',
    target_content_hash: targetContext.content_hash,
  };
```

- [ ] **Step 11: Wire Dream dependency into auto-promote input**

Modify `src/commands/auto-promote.ts`.

Extend `createAutoPromoteDreamDependency` input type:

```ts
allow_canonical_page_writes?: boolean;
max_runner_calls?: number;
time_budget_ms?: number;
```

Pass these into `runAutoPromote`:

```ts
allow_canonical_page_writes: input.allow_canonical_page_writes === true,
max_runner_calls: input.max_runner_calls,
time_budget_ms: input.time_budget_ms,
policy_cache_context: {
  source_policy_hash: 'source-policy:config-v1',
  trust_policy_version: 'trust-policy:v1',
  redaction_version: 'redaction:v1',
  config_hash: 'auto-promote-config:v1',
},
```

Use literal version strings for this foundation slice. A later plan can compute
real config hashes once the trust contract service is centralized.

- [ ] **Step 12: Run the focused gate**

Run:

```bash
bun test test/auto-promote/candidate-selector.test.ts test/auto-promote/service.test.ts test/auto-promote/promote-gate.test.ts test/auto-promote/verdict-cache.test.ts test/dream-cycle-runner-service.test.ts
bun run typecheck
```

Expected: PASS. Auto-promote can still promote eligible candidates, but page
writes require explicit permission and unsafe candidates are excluded.

- [ ] **Step 13: Commit**

```bash
git add src/core/auto-promote/service.ts src/core/auto-promote/candidate-selector.ts src/core/auto-promote/promote-gate.ts src/core/types/auto-promote.ts src/schema.sql src/core/schema-embedded.ts src/core/pglite-schema.ts src/core/sqlite-engine.ts src/core/migrate.ts src/core/postgres-engine.ts src/core/pglite-engine.ts src/commands/auto-promote.ts test/auto-promote/candidate-selector.test.ts test/auto-promote/service.test.ts test/auto-promote/promote-gate.test.ts test/auto-promote/verdict-cache.test.ts
git commit -m "feat: harden auto-promote safety gates"
```

---

## Task 5: Verification Contract And Docs

**Files:**

- Modify: `docs/MBRAIN_VERIFY.md`
- Modify: `package.json`

- [ ] **Step 1: Add a focused verification section**

Add this section to `docs/MBRAIN_VERIFY.md` near the existing dream-cycle or
auto-promote verification sections:

```md
## Authority-first memory foundation

Run this gate after changes to activation labels, assertion retrieval scope,
Dream permissions, or auto-promote safety:

```bash
bun test \
  test/memory-activation-policy-service.test.ts \
  test/assertion-retrieval-scope-service.test.ts \
  test/dream-cli-autopilot.test.ts \
  test/dream-cycle-runner-service.test.ts \
  test/auto-promote/candidate-selector.test.ts \
  test/auto-promote/service.test.ts \
  test/auto-promote/promote-gate.test.ts \
  test/auto-promote/verdict-cache.test.ts
bun run typecheck
```

Acceptance:

- candidate and graph artifacts do not become answer authority,
- assertion retrieval is scope-filtered before frontier use,
- `dream --apply` does not imply auto-promote apply,
- canonical page writes require `--allow-canonical-page-writes`,
- dream-generated and inferred candidates are not canonical auto-write eligible,
- auto-promote verdict cache keys include scope and policy context.
```
```

Modify `package.json` and add this script next to the existing `test:phase*`
scripts:

```json
"test:authority-foundation": "bun test test/memory-activation-policy-service.test.ts test/assertion-retrieval-scope-service.test.ts test/dream-cli-autopilot.test.ts test/dream-cycle-runner-service.test.ts test/auto-promote/candidate-selector.test.ts test/auto-promote/service.test.ts test/auto-promote/promote-gate.test.ts test/auto-promote/verdict-cache.test.ts"
```

- [ ] **Step 2: Run the full foundation gate**

Run:

```bash
bun run test:authority-foundation
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Check schema and docs**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. Only files touched by this plan are modified.
The pre-existing untracked `reference/` directory may still appear and should
not be staged.

- [ ] **Step 4: Commit**

```bash
git add docs/MBRAIN_VERIFY.md package.json
git commit -m "docs: add authority foundation verification gate"
```

---

## Final Verification

After all tasks are complete, run:

```bash
bun run test:authority-foundation
bun run typecheck
git log --oneline -5
git status --short --branch
```

Expected:

- all listed tests pass,
- typecheck passes,
- task commits are visible in `git log`,
- only unrelated pre-existing untracked files, such as `reference/`, remain.

## Out Of Scope For This Plan

- Decision packet projection implementation.
- Negative memory projection implementation.
- `memory-why` CLI output.
- `proof --agent` or `setup-agent --proof`.
- Episode capture changes.
- Graph frontier retrieval enablement.
- Runner sandbox redesign beyond explicit budget and permission gates.
