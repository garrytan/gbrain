# GBrain Absorption GA-P0/GA-P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `GA-P0` / `GA-P1` foundation from the personal GBrain absorption roadmap: classify `reference/gbrain` adoption areas and anchor the first contracts in the existing `mbrain` redesign documents.

**Architecture:** Keep the roadmap subordinate to the existing redesign constitution. `GA-P*` is a separate absorption namespace and must not be confused with the repository's existing redesign `Phase 0` through `Phase 9`. Add a traceable upstream classification checkpoint in `docs/UPSTREAM_SYNC.md`, extend the owning redesign workstreams directly, update `docs/MBRAIN_VERIFY.md`, and add executable fixture/scenario coverage so later work cannot satisfy the contract with prose alone.

**Tech Stack:** Markdown design docs, Bun test, TypeScript test files, existing `docs/architecture/redesign/*` contract set, `test:scenarios` and adjacent phase test surfaces.

---

## Scope Check

The approved roadmap covers `GA-P0` through `GA-P7`. This implementation plan covers only the P0 priority slice:

- `GA-P0`: Reference Classification
- `GA-P1`: Core Contracts

Do not implement `GA-P2` through `GA-P7` behavior in this plan. Later plans should cover evaluation foundation, memory authority implementation, corpus lane implementation, code intelligence, maintenance cycle, and upstream discipline in separate slices.

## Existing Contract Alignment

This plan extends, and does not supersede,
`docs/superpowers/specs/2026-05-17-memory-consolidation-evaluation-design.md`.
When the plan mentions candidate authority, update cadence, consolidation audit,
or exposure-to-disposition behavior, use the existing consolidation terminology
unless a narrower GA-P requirement is explicitly named.

## File Structure

- Create: `test/gbrain-absorption-docs-contract.test.ts`
  - Verifies that the adopted documentation contracts stay anchored in the correct existing docs.
  - Checks for required boundary phrases and the `GA-P*` namespace rather than broad snapshots.

- Create: `test/scenarios/s26-gbrain-absorption-contracts.test.ts`
  - Uses a small fixture to assert that `GA-P1` contracts map to executable surfaces, not prose only.
  - Requires explicit references to `retrieve_context`, `read_context`, `route_memory_writeback`, `reverify_code_claims`, Source Records, import origins, and phase/scenario verification commands.

- Create: `test/fixtures/gbrain-absorption/ga-p0-p1.fixture.json`
  - Pins the `reference/gbrain` baseline SHA and records one replay-style contract case per new contract family.

- Modify: `docs/UPSTREAM_SYNC.md`
  - Adds the `GA-P0` classification checkpoint.
  - Records `adopt`, `adapt`, `reject`, and `later` decisions for major `gbrain` reference areas.
  - Pins the exact `reference/gbrain` SHA/tag and a direct-port denylist.

- Modify: `docs/architecture/redesign/02-memory-loop-and-protocols.md`
  - Adds authority-stage routing and maintenance phase contracts to the read/write protocol owner.

- Modify: `docs/architecture/redesign/05-workstream-context-map.md`
  - Adds corpus lane metadata and code-lane derived artifact contracts to the derived structure owner.

- Modify: `docs/architecture/redesign/06-workstream-governance-and-inbox.md`
  - Adds personal maintenance apply boundary requirements to the governance owner.

- Modify: `docs/architecture/redesign/07-workstream-profile-memory-and-scope.md`
  - Adds corpus lane scope boundary and profile routing constraints to the scope owner.

- Modify: `docs/architecture/redesign/08-evaluation-and-acceptance.md`
  - Adds the replay fixture contract and acceptance gates for later GBrain-absorption phases.

- Modify: `docs/MBRAIN_VERIFY.md`
  - Adds a verification runbook section for `GA-P0` / `GA-P1` and links the new tests to adjacent phase and scenario surfaces.

## Task 1: Add Failing Contract Tests

**Files:**

- Create: `test/gbrain-absorption-docs-contract.test.ts`
- Create: `test/scenarios/s26-gbrain-absorption-contracts.test.ts`
- Create: `test/fixtures/gbrain-absorption/ga-p0-p1.fixture.json`

- [ ] **Step 1: Create the docs contract test**

Create `test/gbrain-absorption-docs-contract.test.ts` with:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('personal gbrain absorption docs contracts', () => {
  test('records a GA-P0 upstream classification checkpoint', () => {
    const doc = readRepoFile('docs/UPSTREAM_SYNC.md');

    expect(doc).toContain('## Roadmap 2026-05-19 - GA-P0 personal gbrain absorption classification checkpoint');
    expect(doc).toContain('03947665e4dbfeaf8a5542d160a0f4b89e4ae747');
    expect(doc).toContain('| Reference area | Decision | MBrain-shaped action | Boundary rationale |');
    expect(doc).toContain('| System-of-record and reconciler discipline | adapt |');
    expect(doc).toContain('| HTTP MCP, OAuth, admin UI, teammate-scoped writes | reject |');
    expect(doc).toContain('| Minions, durable job runtime, hosted agent runtime | reject |');
    expect(doc).toContain('| Eval capture and replay | adapt |');
    expect(doc).toContain('| Code intelligence and tree-sitter symbol graph | later |');
    expect(doc).toContain('### Direct-port denylist');
    expect(doc).toContain('### Useful upstream evidence ledger');
  });

  test('anchors authority routing in the memory-loop protocol owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/02-memory-loop-and-protocols.md');

    expect(doc).toContain('## GBrain Absorption Authority Routing Contract');
    expect(doc).toContain('| Session signal | First routing question | Allowed destination | Forbidden shortcut |');
    expect(doc).toContain('Domain-specific write homes are selected before candidate or canonical write selection.');
    expect(doc).toContain('## Personal Maintenance Phase Contract');
    expect(doc).toContain('Maintenance phases produce reports, candidates, or governed apply requests.');
  });

  test('anchors corpus lanes and code lane in the context-map owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/05-workstream-context-map.md');

    expect(doc).toContain('## Personal Corpus Lane Metadata Contract');
    expect(doc).toContain('A corpus lane is not a scope.');
    expect(doc).toContain('Corpus lanes are source and artifact metadata inside an already resolved scopeId.');
    expect(doc).toContain('Corpus lanes never replace Source Records, imported-artifact boundaries, retrieval traces, or Scope Gate decisions.');
    expect(doc).toContain('## Code Lane Derived Artifact Contract');
    expect(doc).toContain('Graph expansion is opt-in until evaluation proves it improves code retrieval.');
    expect(doc).toContain('reindex and invalidation plan');
  });

  test('anchors maintenance apply controls in the governance owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/06-workstream-governance-and-inbox.md');

    expect(doc).toContain('## Personal Maintenance Apply Boundary');
    expect(doc).toContain('active realm and session');
    expect(doc).toContain('mutation ledger');
    expect(doc).toContain('target snapshot');
    expect(doc).toContain('dry-run and apply paths must perform the same validation');
  });

  test('anchors corpus lane scope boundaries in the profile/scope owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/07-workstream-profile-memory-and-scope.md');

    expect(doc).toContain('## Corpus Lane Scope Boundary');
    expect(doc).toContain('The lane resolver runs after the Scope Gate.');
    expect(doc).toContain('A lane cannot turn work retrieval into personal retrieval.');
    expect(doc).toContain('Profile Memory routing still follows the Scope Gate and write isolation rules.');
  });

  test('anchors replay fixtures and gates in the evaluation owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/08-evaluation-and-acceptance.md');

    expect(doc).toContain('## GBrain Absorption Replay Fixture Contract');
    expect(doc).toContain('GA-P fixture namespace');
    expect(doc).toContain('candidate_authority');
    expect(doc).toContain('lane_scope_decision');
    expect(doc).toContain('code_verification');
    expect(doc).toContain('maintenance_apply_result');
  });

  test('updates the install verification runbook for GA-P0 and GA-P1', () => {
    const doc = readRepoFile('docs/MBRAIN_VERIFY.md');

    expect(doc).toContain('## GBrain Absorption GA-P0/GA-P1 Verification');
    expect(doc).toContain('bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s26-gbrain-absorption-contracts.test.ts');
    expect(doc).toContain('bun run test:scenarios');
  });
});
```

- [ ] **Step 2: Create the executable fixture contract**

Create `test/fixtures/gbrain-absorption/ga-p0-p1.fixture.json` with the
baseline and contract cases below. Each contract case must also use the replay
fixture fields introduced in `08-evaluation-and-acceptance.md`: `fixture_id`,
`query`, `requested_scope`, `expected_intent`, `expected_canonical_refs`,
`candidate_authority`, `lane_scope_decision`, `code_verification`,
`maintenance_apply_result`, and `verification_commands`.

```json
{
  "stage_id": "GA-P0/GA-P1",
  "upstream_baseline": {
    "path": "reference/gbrain",
    "sha": "03947665e4dbfeaf8a5542d160a0f4b89e4ae747",
    "tag": "v0.36.0.0"
  },
  "contract_cases": [
    {
      "case_id": "authority-routing",
      "existing_surfaces": ["retrieve_context", "read_context", "route_memory_writeback"],
      "must_preserve": ["candidate_authority", "source_refs", "target_snapshot"]
    },
    {
      "case_id": "corpus-lane-boundary",
      "existing_surfaces": ["read_context", "retrieval_traces"],
      "must_preserve": ["scope_gate", "source_record", "import_origin"],
      "lane_grants_authority": false
    },
    {
      "case_id": "code-lane-derived-artifact",
      "existing_surfaces": ["reverify_code_claims"],
      "must_preserve": ["live_workspace_check", "default_off_graph_expansion", "reindex_and_invalidation"]
    },
    {
      "case_id": "maintenance-apply-boundary",
      "existing_surfaces": ["route_memory_writeback", "memory_mutation_ledger"],
      "must_preserve": ["realm_session", "dry_run_apply_parity", "redaction_fail_closed"]
    }
  ]
}
```

Create `test/scenarios/s26-gbrain-absorption-contracts.test.ts` with the
structure below, plus operation registry assertions for the named executable
surfaces and README registration for `S26`.

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

type ContractCase = {
  case_id: string;
  existing_surfaces: string[];
  must_preserve: string[];
  lane_grants_authority?: boolean;
};

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/gbrain-absorption/ga-p0-p1.fixture.json', import.meta.url),
  'utf8',
)) as {
  stage_id: string;
  upstream_baseline: { path: string; sha: string; tag: string };
  contract_cases: ContractCase[];
};

describe('S26 - gbrain absorption contracts stay executable', () => {
  test('pins the reviewed upstream baseline', () => {
    expect(fixture.stage_id).toBe('GA-P0/GA-P1');
    expect(fixture.upstream_baseline.path).toBe('reference/gbrain');
    expect(fixture.upstream_baseline.sha).toBe('03947665e4dbfeaf8a5542d160a0f4b89e4ae747');
    expect(fixture.upstream_baseline.tag).toBe('v0.36.0.0');
  });

  test('maps every contract family to an executable surface', () => {
    const required = new Map([
      ['authority-routing', ['retrieve_context', 'read_context', 'route_memory_writeback']],
      ['corpus-lane-boundary', ['read_context', 'retrieval_traces']],
      ['code-lane-derived-artifact', ['reverify_code_claims']],
      ['maintenance-apply-boundary', ['route_memory_writeback', 'memory_mutation_ledger']],
    ]);

    for (const [caseId, surfaces] of required) {
      const contractCase = fixture.contract_cases.find((entry) => entry.case_id === caseId);
      expect(contractCase, `missing ${caseId}`).toBeDefined();
      for (const surface of surfaces) {
        expect(contractCase?.existing_surfaces).toContain(surface);
      }
    }
  });

  test('keeps corpus lanes non-authoritative', () => {
    const laneCase = fixture.contract_cases.find((entry) => entry.case_id === 'corpus-lane-boundary');

    expect(laneCase?.lane_grants_authority).toBe(false);
    expect(laneCase?.must_preserve).toEqual(expect.arrayContaining([
      'scope_gate',
      'source_record',
      'import_origin',
    ]));
  });
});
```

- [ ] **Step 3: Run the failing contract tests**

Run:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s26-gbrain-absorption-contracts.test.ts
```

Expected before implementation: FAIL. The first docs-test failure should report that `docs/UPSTREAM_SYNC.md` does not contain `## Roadmap 2026-05-19 - GA-P0 personal gbrain absorption classification checkpoint`.

- [ ] **Step 4: Commit the failing tests**

```bash
git add test/gbrain-absorption-docs-contract.test.ts test/scenarios/s26-gbrain-absorption-contracts.test.ts test/fixtures/gbrain-absorption/ga-p0-p1.fixture.json
git commit -m "test: add gbrain absorption contract fixtures"
```

## Task 2: Add The GA-P0 Upstream Classification Checkpoint

**Files:**

- Modify: `docs/UPSTREAM_SYNC.md`
- Test: `test/gbrain-absorption-docs-contract.test.ts`

- [ ] **Step 1: Insert the classification checkpoint**

In `docs/UPSTREAM_SYNC.md`, insert this section immediately before `## Sync 2026-05-01 - source-aware search ranking only`:

```markdown
## Roadmap 2026-05-19 - GA-P0 personal gbrain absorption classification checkpoint

- **Project baseline before roadmap**: `48ec6f6` (merge of memory consolidation evaluation)
- **Roadmap branch**: `codex/gbrain-personal-roadmap-20260519`
- **Reference repo path**: `reference/gbrain`
- **Reference upstream HEAD**: `03947665e4dbfeaf8a5542d160a0f4b89e4ae747` (`v0.36.0.0`)
- **Roadmap spec**: `docs/superpowers/specs/2026-05-19-personal-gbrain-absorption-roadmap-design.md`

This checkpoint classifies `reference/gbrain` as a source of proven operating
patterns, not as a merge target. Future implementation should absorb the
principles below through the owning `mbrain` redesign workstreams and tests.

| Reference area | Decision | MBrain-shaped action | Boundary rationale |
|---|---|---|---|
| Dream cycle phase runner | adapt | Define a personal maintenance phase contract that emits reports, candidates, or governed apply requests. | Useful operating regimen, but canonical writes must still pass Memory Inbox, handoff, mutation ledger, realm/session, and snapshot checks. |
| Facts/takes distinction | adapt | Translate hot/cold memory into domain-specific write routing and authority stages. | Do not clone upstream tables or a one-way facts-to-takes bridge; `mbrain` has multiple canonical homes. |
| System-of-record and reconciler discipline | adapt | Preserve Markdown/canonical evidence as the durable source while treating DB/index projections as rebuildable, reconciled artifacts. | This is a deeper safety lesson than hot/cold storage alone; any adapted projection must preserve round-trip evidence and Source Record ownership. |
| Eval capture and replay | adapt | Define replay fixtures for retrieval, candidate lifecycle, task resume, scope isolation, code verification, and maintenance apply outcomes. | Evaluation should precede automation and must measure governance boundaries, not only retrieval quality. |
| Multi-source brains | adapt | Reduce source ideas to personal corpus lane metadata inside an existing `scopeId`. | Lanes must not become a second scope system or grant write authority. |
| Code intelligence and tree-sitter symbol graph | later | Treat symbol metadata and graph walking as a future Context Map code lane with backfill, invalidation, fanout caps, and default-off expansion. | Valuable but high-risk; it must not become current code truth without live verification. |
| Source-aware ranking | adopt | Keep the existing `mbrain` reimplementation and evaluate future tuning against local fixtures. | Already adopted in `mbrain` as engine-neutral ranking. |
| Frontmatter guards and resolver warnings | later | Fold useful checks into existing lint/import validation only after a focused design. | Useful quality guard, but not part of the `GA-P0` / `GA-P1` foundation. |
| HTTP MCP, OAuth, admin UI, teammate-scoped writes | reject | Keep out of the personal roadmap. | Company/team runtime scope conflicts with the personal `mbrain` target. |
| Minions, durable job runtime, hosted agent runtime | reject | Do not port as a prerequisite for personal maintenance. | `mbrain` should remain the durable memory layer under agents, not a competing job runtime. |
| Supabase/TUS hosted storage flows | reject | Revisit only if local-first large-file semantics are designed first. | Hosted storage assumptions conflict with local/offline default behavior. |

### Direct-port denylist

Do not port these surfaces directly:

- `reference/gbrain/src/server/**` HTTP MCP, OAuth, admin, and thin-client surfaces.
- `reference/gbrain/src/minions/**`, Minions handlers, durable job queue, and hosted agent runtime.
- Supabase/TUS storage flows and remote artifact assumptions.
- Postgres-only migrations or SQL that would change the SQLite/local-first core contract.
- `facts` and `takes` tables as direct clones.
- Code Cathedral/tree-sitter indexing code before `GA-P5` defines local/offline invalidation, fanout, and live-verification gates.
- Source-scoped client write authority or teammate ACL behavior.

### Useful upstream evidence ledger

| Upstream evidence | Use in `mbrain` | GA-P owner |
|---|---|---|
| `reference/gbrain/src/core/cycle.ts` | Dream-cycle phase ordering, reports, and guarded apply inspiration. | `GA-P1`, `GA-P6` |
| `reference/gbrain/docs/takes-vs-facts.md` | Hot/cold memory distinction and one-way consolidation risks. | `GA-P4` |
| `reference/gbrain/docs/architecture/system-of-record.md` | Markdown-grounded system-of-record and rebuildable projection discipline. | `GA-P0`, `GA-P4` |
| `reference/gbrain/docs/architecture/brains-and-sources.md` and `reference/gbrain/docs/guides/multi-source-brains.md` | Source separation to reinterpret as personal corpus lane metadata. | `GA-P1`, `GA-P3` |
| `reference/gbrain/docs/eval-bench.md`, `reference/gbrain/docs/eval-capture.md`, `reference/gbrain/docs/eval-takes-quality.md` | Replay fixture and quality-gate inspiration. | `GA-P1`, `GA-P2` |
| `reference/gbrain/docs/designs/CODE_CATHEDRAL_II.md` | Code-lane design reference only after derived/current truth gates exist. | `GA-P5` |

Rules for later implementation:

1. Direct ports require an owning redesign workstream and a focused test.
2. Corpus lanes are metadata inside scope, not scope or write authority.
3. Maintenance apply paths must use realm/session authorization, mutation ledger,
   target snapshot checks, dry-run/apply parity, and redaction fail-closed rules.
4. Code graph retrieval stays default-off until local/offline and retrieval
   regression gates prove it is safe.
5. `docs/UPSTREAM_SYNC.md` must be updated whenever a later GA-P phase adopts,
   adapts, rejects, or defers a new `gbrain` reference area.

---
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts -t "GA-P0 upstream classification"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/UPSTREAM_SYNC.md
git commit -m "docs: classify personal gbrain absorption references"
```

## Task 3: Extend The Memory-Loop Protocol Owner

**Files:**

- Modify: `docs/architecture/redesign/02-memory-loop-and-protocols.md`
- Test: `test/gbrain-absorption-docs-contract.test.ts`

- [ ] **Step 1: Add the authority routing and maintenance contracts**

In `docs/architecture/redesign/02-memory-loop-and-protocols.md`, insert this section after `## Write Route and Candidate Lifecycle` and before `## Retrieval Trace Requirements`:

```markdown
## GBrain Absorption Authority Routing Contract

`gbrain`'s facts/takes distinction is useful because it separates fast capture
from slower consolidation. `mbrain` absorbs that idea through domain-specific
write routing, not through cloned facts and takes tables.

Domain-specific write homes are selected before candidate or canonical write
selection.

| Session signal | First routing question | Allowed destination | Forbidden shortcut |
|---|---|---|---|
| Active task state changed | Does this affect ongoing work continuity? | Task Thread, Working Set, Event, Attempt, or Decision. | Forcing operational continuity through Memory Inbox. |
| User states a durable personal preference or fact | Has the Scope Gate resolved personal scope and sensitivity? | Profile Memory, Personal Episode, or Memory Candidate for profile review. | Writing personal memory into work-visible canonical notes. |
| User states curated topic knowledge | Is there authoritative provenance and a target Markdown note or procedure? | Curated Markdown, Procedure, Source Record, or Memory Candidate. | Treating a conversational summary as compiled truth without source refs. |
| Imported or observed artifact | What source evidence must be preserved before synthesis? | Source Record plus derived indexes or candidates. | Promoting extracted claims without preserving the source boundary. |
| Inferred relationship or surprising link | Is the claim derived, ambiguous, or contradictory? | Memory Candidate with extraction kind and target object when known. | Treating a map edge or recurrence score as answer-grounding truth. |
| Code-sensitive claim | Can the current workspace verify path, symbol, branch, and test assumptions? | Verified response, operational stale marker, or Memory Candidate after verification. | Reusing historical code memory as current truth. |

Authority-routing rules:

1. The route starts with scope and domain, not with hot versus cold storage.
2. Direct canonical writes are allowed only when `02` and the owning workstream
   already classify the signal as authoritative for that domain.
3. Candidate-only state remains governance history until promotion, rejection,
   supersession, or canonical handoff finishes.
4. Promotion and handoff preserve Source Records, target identity, scope,
   sensitivity, and expected target snapshot evidence.
5. If no safe write home is clear, the signal stays ephemeral or becomes an
   explicitly ambiguous Memory Candidate.

## Personal Maintenance Phase Contract

Personal maintenance borrows the phase-runner discipline of `gbrain dream`, but
not its authority model. Maintenance phases produce reports, candidates, or
governed apply requests.

Allowed phase outputs:

| Output | Authority | Example |
|---|---|---|
| Report | Non-mutating orientation | stale candidate report, derived freshness report, duplicate group summary |
| Candidate | Governance state, not truth | stale-claim challenge, duplicate-merge suggestion, profile update proposal |
| Governed apply request | Pending mutation request | reviewed canonical handoff or patch candidate that still needs control-plane validation |

Maintenance routing rules:

1. A phase may refresh derived artifacts when the owning derived layer permits it.
2. A phase may create Memory Candidates for inferred, ambiguous, stale, or
   contradictory signals.
3. A phase may not patch canonical Markdown, Profile Memory, or operational state
   directly unless the existing governed write path is invoked.
4. Apply-capable phases must expose dry-run behavior before mutation.
5. Phase results must be inspectable in retrieval traces, audit reports, or
   mutation ledger records when they influence later reads or writes.
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts -t "memory-loop protocol owner"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/redesign/02-memory-loop-and-protocols.md
git commit -m "docs: define gbrain authority routing contract"
```

## Task 4: Extend The Context-Map Owner

**Files:**

- Modify: `docs/architecture/redesign/05-workstream-context-map.md`
- Test: `test/gbrain-absorption-docs-contract.test.ts`

- [ ] **Step 1: Add corpus lane metadata and code lane contracts**

In `docs/architecture/redesign/05-workstream-context-map.md`, insert this section before `## Tests and Evaluation`:

```markdown
## Personal Corpus Lane Metadata Contract

`gbrain` sources are an important reference for separating corpora. `mbrain`
uses the idea as personal corpus lane metadata, not as a second scope system.

A corpus lane is not a scope. Corpus lanes are source and artifact metadata
inside an already resolved scopeId.

Corpus lanes never replace Source Records, imported-artifact boundaries,
retrieval traces, or Scope Gate decisions.

Lane metadata may identify:

- imported note corpus
- active worktree corpus
- transcript corpus
- raw import or source-evidence corpus
- derived context-map or atlas corpus

Lane rules:

1. The Scope Gate resolves work, personal, mixed, or unknown before any lane
   resolver runs.
2. A lane may narrow source-set hashes, derived refresh sets, citations, and
   import provenance.
3. A lane may not grant read or write authority.
4. A lane may not copy work-only data into personal memory or personal data into
   work memory.
5. Context maps may record lane metadata on nodes and source-set hashes only as
   derived orientation.
6. Lane-aware retrieval must still map evidence back to Source Records and
   import origins before making factual claims.

## Code Lane Derived Artifact Contract

`reference/gbrain` proves that code-aware retrieval needs more than symbol
names. `mbrain` may add a Context Map code lane only when the derived layer can
track indexing prerequisites, backfill, invalidation, and bounded expansion.

Required code-lane metadata:

| Field | Purpose |
|---|---|
| `source_ref` | Canonical evidence or workspace source for the indexed code. |
| `repo_path` | Workspace root used for live verification. |
| `content_hash` | Detects stale extracted symbols. |
| `extractor_version` | Forces reindex when chunking or symbol extraction changes. |
| `symbol_id` | Stable derived identifier for a symbol node. |
| `edge_kind` | Distinguishes call, reference, import, declaration, or containment edges. |
| `verification_hint` | Records what live check is needed before a current code claim is repeated. |

Code-lane rules:

1. Symbol nodes and edges are derived orientation, not current code truth.
2. Current code claims still require live path, symbol, branch, and test
   verification.
3. Graph expansion is opt-in until evaluation proves it improves code retrieval.
4. High-fan-out symbols need explicit caps and bounded output.
5. Every extractor or chunker version change needs a reindex and invalidation
   plan before the new graph can influence retrieval.
6. Code-lane retrieval must keep `rg`, exact file reads, and direct workspace
   verification available as higher-authority current evidence.
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts -t "context-map owner"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/redesign/05-workstream-context-map.md
git commit -m "docs: define corpus and code lane contracts"
```

## Task 5: Extend The Governance Owner

**Files:**

- Modify: `docs/architecture/redesign/06-workstream-governance-and-inbox.md`
- Test: `test/gbrain-absorption-docs-contract.test.ts`

- [ ] **Step 1: Add maintenance apply boundary**

In `docs/architecture/redesign/06-workstream-governance-and-inbox.md`, insert this section after `## Memory Operations Control Plane` and before `## Candidate Sources`:

```markdown
## Personal Maintenance Apply Boundary

Personal maintenance may discover useful work, but it does not gain special
write authority. Any maintenance output that wants to mutate canonical or
governance state must pass the same control plane as an interactive write.

Apply-capable maintenance requires:

| Requirement | Why it exists |
|---|---|
| active realm and session | Proves the maintenance actor has write authority for the target scope. |
| mutation ledger | Records applied, denied, dry-run, conflict, failed, staged, or redacted outcomes. |
| target snapshot | Prevents stale maintenance from overwriting a newer canonical target. |
| dry-run/apply parity | Ensures dry-run validates the same target and policy checks as apply. |
| redaction fail-closed behavior | Prevents maintenance from exposing or partially rewriting sensitive data. |

Rules:

1. Report-only phases need no mutation authority.
2. Candidate-creating phases write governance state, not truth, and must preserve
   source refs and extraction kind.
3. Apply requests must name the target object, expected target snapshot, source
   refs, scope, sensitivity, and interaction or maintenance run id.
4. Dry-run and apply paths must perform the same validation, except apply may
   mutate after authorization and conflict checks pass.
5. Failed apply requests remain auditable in the mutation ledger.
6. Maintenance must never suppress contradiction, supersession, or redaction
   history to make a report look cleaner.
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts -t "governance owner"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/redesign/06-workstream-governance-and-inbox.md
git commit -m "docs: define maintenance apply boundary"
```

## Task 6: Extend The Profile And Scope Owner

**Files:**

- Modify: `docs/architecture/redesign/07-workstream-profile-memory-and-scope.md`
- Test: `test/gbrain-absorption-docs-contract.test.ts`

- [ ] **Step 1: Add corpus lane scope boundary**

In `docs/architecture/redesign/07-workstream-profile-memory-and-scope.md`, insert this section after `## Write Isolation Rules` and before `## Export and Visibility Boundaries`:

```markdown
## Corpus Lane Scope Boundary

Personal corpus lanes may help retrieval explain which corpus contributed a
result, but they do not decide whether a request is work, personal, or mixed.

The lane resolver runs after the Scope Gate.

Rules:

1. A lane cannot turn work retrieval into personal retrieval.
2. A lane cannot turn personal retrieval into work retrieval.
3. A lane cannot authorize a write into Profile Memory, Personal Episodes,
   Task Threads, Working Sets, curated Markdown, or governance state.
4. Profile Memory routing still follows the Scope Gate and write isolation rules.
5. Mixed-scope retrieval must still name the cross-scope bridge even when both
   sides have lane metadata.
6. Lane-aware citations should include the lane only as provenance metadata, not
   as a replacement for source refs or scope decisions.

Useful lane examples inside personal `mbrain`:

| Lane | Scope relationship | Allowed use |
|---|---|---|
| `notes` | Work or personal, depending on resolved scope | Citation and import provenance. |
| `worktree` | Usually work | Code/source orientation after work scope is allowed. |
| `transcripts` | Work, personal, or mixed by source | Source evidence after scope classification. |
| `imports` | Determined by source artifact | Provenance and derived refresh selection. |
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts -t "profile/scope owner"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/redesign/07-workstream-profile-memory-and-scope.md
git commit -m "docs: constrain corpus lane scope behavior"
```

## Task 7: Extend The Evaluation Owner

**Files:**

- Modify: `docs/architecture/redesign/08-evaluation-and-acceptance.md`
- Test: `test/gbrain-absorption-docs-contract.test.ts`

- [ ] **Step 1: Add replay fixture contract**

In `docs/architecture/redesign/08-evaluation-and-acceptance.md`, insert this section after `## Baseline Metrics` and before `## Repeated-Work Prevention Evaluation`:

````markdown
## GBrain Absorption Replay Fixture Contract

GBrain-style replay is useful only if it measures `mbrain` boundaries, not just
retrieval overlap. Replay fixtures for this roadmap must preserve enough fields
to evaluate retrieval, governance, scope, code verification, and maintenance
apply behavior.

GA-P fixture namespace: absorption fixtures use `GA-P*` stage identifiers so
they do not collide with the existing redesign phase acceptance packs.

Minimum fixture shape:

```json
{
  "fixture_id": "ga-p1-example",
  "stage_id": "GA-P1",
  "query": "resume the retrieval routing task",
  "requested_scope": "work",
  "expected_intent": "task_resume",
  "expected_canonical_refs": ["task_thread:example"],
  "candidate_authority": "candidate_only",
  "lane_scope_decision": {
    "scope_id": "work",
    "lane_id": "worktree",
    "lane_grants_authority": false
  },
  "code_verification": {
    "required": true,
    "repo_path": "/path/to/repo",
    "expected_mode": "live_workspace_check"
  },
  "maintenance_apply_result": {
    "allowed_without_control_plane": false,
    "requires_realm_session": true,
    "requires_mutation_ledger": true,
    "requires_target_snapshot": true
  }
}
```

Replay rules:

1. Fixtures must identify expected canonical refs separately from candidate
   signals and derived refs.
2. Candidate authority must be explicit: `answer_ground`, `candidate_only`,
   `historical`, or `not_expected`.
3. Lane decisions must record that lanes do not grant authority.
4. Code verification must state whether live workspace checks are required.
5. Maintenance apply expectations must state whether realm/session, mutation
   ledger, and target snapshot checks are required.
6. A replay pass fails if retrieval gets the right text by violating scope,
   candidate authority, or control-plane boundaries.
````

- [ ] **Step 2: Run the focused test**

Run:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts -t "evaluation owner"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/redesign/08-evaluation-and-acceptance.md
git commit -m "docs: define gbrain replay fixture contract"
```

## Task 8: Update The Verification Runbook

**Files:**

- Modify: `docs/MBRAIN_VERIFY.md`
- Test: `test/gbrain-absorption-docs-contract.test.ts`

- [ ] **Step 1: Add the GA-P0/GA-P1 verification section**

In `docs/MBRAIN_VERIFY.md`, insert this section after `## Phase 0 parity verification`:

````markdown
## GBrain Absorption GA-P0/GA-P1 Verification

Run:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s26-gbrain-absorption-contracts.test.ts
```

Expected:

- the reviewed `reference/gbrain` baseline is pinned to `03947665e4dbfeaf8a5542d160a0f4b89e4ae747`
- `docs/UPSTREAM_SYNC.md` records the `GA-P0` classification, direct-port denylist, and useful upstream evidence ledger
- corpus lanes remain metadata inside `scopeId` and do not replace Source Records, import origins, retrieval traces, or Scope Gate decisions
- replay fixtures use the `GA-P*` namespace and preserve candidate authority, lane scope decisions, code verification, and maintenance apply controls
- each new contract family maps to at least one executable surface: `retrieve_context`, `read_context`, `route_memory_writeback`, `reverify_code_claims`, scenario tests, or phase acceptance packs

Then run:

```bash
bun run test:scenarios
```

Expected:

- existing scenario coverage still passes after adding the GA-P fixture scenario
- no GA-P fixture can pass by changing prose only while omitting executable surfaces
````

- [ ] **Step 2: Run the focused test**

Run:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts -t "install verification runbook"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/MBRAIN_VERIFY.md
git commit -m "docs: add gbrain absorption verification runbook"
```

## Task 9: Run Full Verification

**Files:**

- Verify all files changed in Tasks 1-8.

- [ ] **Step 1: Run the docs contract test**

Run:

```bash
bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s26-gbrain-absorption-contracts.test.ts
```

Expected: PASS. Expected output should include the docs contract cases, S26 fixture cases, and `0 fail`.

- [ ] **Step 2: Run adjacent contract tests**

Run:

```bash
bun test test/brain-loop-audit-service.test.ts test/code-claim-verification-operations.test.ts
```

Expected: PASS. These tests do not exercise the new docs directly, but they cover nearby governance and code-claim behavior referenced by the new contracts.

- [ ] **Step 3: Run existing scenario coverage**

Run:

```bash
bun run test:scenarios
```

Expected: PASS. This confirms the new `S26` fixture scenario coexists with the existing scenario suite.

- [ ] **Step 4: Check staged and unstaged whitespace**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 5: Review final diff**

Run:

```bash
git diff --stat HEAD
```

Expected: only the docs, fixture, and test files listed in this plan should appear.

- [ ] **Step 6: Final commit if Tasks 1-8 were squashed locally**

If the executing agent used one commit per task, skip this step. If the executing agent batched the changes, commit with:

```bash
git add test/gbrain-absorption-docs-contract.test.ts test/scenarios/s26-gbrain-absorption-contracts.test.ts test/fixtures/gbrain-absorption/ga-p0-p1.fixture.json docs/UPSTREAM_SYNC.md docs/architecture/redesign/02-memory-loop-and-protocols.md docs/architecture/redesign/05-workstream-context-map.md docs/architecture/redesign/06-workstream-governance-and-inbox.md docs/architecture/redesign/07-workstream-profile-memory-and-scope.md docs/architecture/redesign/08-evaluation-and-acceptance.md docs/MBRAIN_VERIFY.md
git commit -m "docs: anchor gbrain absorption foundation"
```

## Self-Review Checklist

- `GA-P0` is covered by Task 2.
- `GA-P1` is covered by Tasks 3-7.
- Contract precedence is preserved by modifying existing workstream owners, not adding a new architecture owner.
- Corpus lanes are source/artifact metadata inside resolved scope, not a new scope system.
- Corpus lanes map back to Source Records and import origins instead of replacing provenance.
- Facts/takes absorption routes through domain-specific write homes, not cloned tables.
- System-of-record and reconciler discipline is classified separately from the facts/takes table design.
- Code intelligence remains a derived Context Map lane with reindex, invalidation, default-off graph expansion, and live verification boundaries.
- Maintenance apply paths require realm/session authorization, mutation ledger, target snapshot checks, dry-run/apply parity, and redaction fail-closed behavior.
- Evaluation fixtures measure candidate authority, lane authority, code verification, and maintenance apply controls.
- `docs/MBRAIN_VERIFY.md` names the GA-P verification commands and adjacent scenario/phase surfaces.
