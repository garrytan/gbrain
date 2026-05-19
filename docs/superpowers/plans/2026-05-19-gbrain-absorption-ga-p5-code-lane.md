# GBrain Absorption GA-P5 Code Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GA-P5's code intelligence foundation as a derived Context Map code lane with live-workspace verification gates, without turning code graph data into answer authority.

**Architecture:** Build a small code-lane model from existing `codemap` frontmatter and persist it as a `context_map` entry with `kind: "code_lane"`. Keep graph walk controls default-off and bounded. Extend code-claim verification so optional expected content hashes mark stale code claims before a symbol graph can be treated as current.

**Tech Stack:** TypeScript, Bun tests, SQLite test engine, existing Context Map and `reverify_code_claims` operation.

---

## Scope

This plan intentionally does not add DB tables, migrations, new retrieval selector kinds, tree-sitter extraction, code-callers/code-callees CLI commands, or default-on graph expansion. GA-P5 creates the contract, model, stale gate, and replay coverage needed before any future extractor can influence retrieval.

## File Structure

- Create `src/core/services/context-map-code-lane-service.ts`
  - Owns code-lane metadata types, codemap-frontmatter extraction, deterministic symbol ids, edge normalization, source-set hashing, freshness annotation, and graph-walk caps.
- Modify `src/core/services/context-map-service.ts`
  - Exports code-lane build/read/list helpers and delegates stale checks by map kind.
- Modify `src/core/types.ts`
  - Extends `CodeClaim` / `CodeClaimVerificationResult` with optional hash verification fields. Code-lane-only types stay local to `context-map-code-lane-service.ts`.
- Modify `src/core/services/code-claim-verification-service.ts`
  - Parses optional JSON claim metadata and verifies `expected_content_hash` against the live file.
- Modify `src/core/operations.ts`
  - Accepts optional hash/verifier fields in `reverify_code_claims` direct params.
- Test `test/context-map-code-lane-service.test.ts`
  - Covers model, default-off graph walk controls, deterministic ids, bounded fanout, hash invalidation.
- Test `test/code-claim-verification-service.test.ts`
  - Covers content-hash stale behavior and JSON parsing.
- Test `test/code-claim-verification-operations.test.ts`
  - Covers operation params with `expected_content_hash`.
- Create `test/fixtures/gbrain-absorption/ga-p5-code-lane.fixture.json`
  - Defines definition/reference/caller/callee/nearby/stale cases.
- Create `test/scenarios/s30-gbrain-code-lane.test.ts`
  - Replays the GA-P5 fixture against the new service and existing operation boundary.
- Modify `test/scenarios/README.md`
  - Registers S30.
- Modify `test/gbrain-absorption-docs-contract.test.ts`
  - Anchors GA-P5 docs and runbook text.
- Modify `docs/architecture/redesign/05-workstream-context-map.md`
  - Documents the runtime code-lane contract.
- Modify `docs/architecture/redesign/08-evaluation-and-acceptance.md`
  - Documents GA-P5 replay/evaluation gates.
- Modify `docs/MBRAIN_VERIFY.md`
  - Adds GA-P5 verification commands.

## Task 1: Code-Lane Model and Context Map Integration

**Files:**
- Create: `src/core/services/context-map-code-lane-service.ts`
- Modify: `src/core/services/context-map-service.ts`
- Test: `test/context-map-code-lane-service.test.ts`
- Test: `test/context-map-service.test.ts`

- [ ] **Step 1: Write the failing code-lane service tests**

Add `test/context-map-code-lane-service.test.ts` with cases that import two system/concept pages containing `codemap` frontmatter. Assertions:

```ts
expect(snapshot.authority).toBe('derived_orientation');
expect(snapshot.graph_walk.enabled_by_default).toBe(false);
expect(snapshot.graph_walk.depth_limit).toBe(1);
expect(snapshot.graph_walk.fanout_cap).toBe(50);
expect(snapshot.nodes[0]?.symbol_id).toContain('systems/mbrain');
expect(snapshot.nodes[0]?.verification_hint).toContain('reverify_code_claims');
expect(snapshot.edges.some((edge) => edge.edge_kind === 'declares')).toBe(true);
```

Also assert high-fan-out truncation:

```ts
const expanded = expandCodeLaneGraph(snapshot, snapshot.nodes[0]!.symbol_id, { requested: true, depth_limit: 1, fanout_cap: 2 });
expect(expanded.truncated).toBe(true);
expect(expanded.truncation_reason).toBe('fanout_cap');
expect(expanded.edges.length).toBeLessThanOrEqual(2);
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
source ~/.zshrc 2>/dev/null || true
bun test test/context-map-code-lane-service.test.ts
```

Expected: fails because `context-map-code-lane-service.ts` does not exist.

- [ ] **Step 3: Add the minimal service implementation**

Implement:

```ts
export const CODE_LANE_CONTEXT_MAP_KIND = 'code_lane';
export const CODE_LANE_BUILD_MODE = 'code_lane_contract';
export const CODE_LANE_EXTRACTOR_VERSION = 'ga-p5-code-lane-v1';
export const CODE_LANE_STALE_REASON_SOURCE_SET_CHANGED = 'code_lane_source_set_changed';
export const DEFAULT_CODE_LANE_GRAPH_WALK_CONTROLS = {
  enabled_by_default: false,
  depth_limit: 1,
  fanout_cap: 50,
  max_nodes: 100,
  bounded_output: true,
} as const;
```

Derive nodes from manifest `frontmatter.codemap[].pointers[]`. Each node must include `source_ref`, `repo_path`, `content_hash`, `extractor_version`, `symbol_id`, `path`, `symbol_name`, optional `qualified_name`, `parent_symbol_path`, `language`, `chunk_id`, `start_line`, `end_line`, `verification_hint`, and `authority: "derived_orientation"`.

Create at least a `declares` edge per pointer. Accept optional pointer edges such as:

```yaml
edges:
  - kind: calls
    to_symbol: helper
```

Normalize edge kinds to `declares`, `calls`, `references`, `imports`, or `contains`; unknown kinds become `references`.

- [ ] **Step 4: Integrate build/read/list helpers into Context Map service**

Add exports:

```ts
export function codeLaneContextMapId(scopeId: string): string;
export async function buildCodeLaneContextMapEntry(engine: BrainEngine, scopeId?: string): Promise<ContextMapEntry>;
export async function getCodeLaneContextMapEntry(engine: BrainEngine, id: string): Promise<ContextMapEntry | null>;
export async function listCodeLaneContextMapEntries(engine: BrainEngine, filters?: ContextMapFilters): Promise<ContextMapEntry[]>;
```

Keep structural map behavior unchanged. Only code-lane entries should use code-lane source-set hash/freshness.

- [ ] **Step 5: Run focused service tests**

Run:

```bash
source ~/.zshrc 2>/dev/null || true
bun test test/context-map-code-lane-service.test.ts test/context-map-service.test.ts
```

Expected: all tests pass.

## Task 2: Live Code-Claim Content Hash Verification

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/services/code-claim-verification-service.ts`
- Modify: `src/core/operations.ts`
- Test: `test/code-claim-verification-service.test.ts`
- Test: `test/code-claim-verification-operations.test.ts`

- [ ] **Step 1: Write failing verification tests**

Add service tests:

```ts
const stale = verifyCodeClaims({
  repo_path: dir,
  claims: [{ path: 'src/example.ts', symbol: 'presentSymbol', expected_content_hash: 'sha256:not-current' }],
  now: new Date('2026-05-19T00:00:00.000Z'),
})[0];
expect(stale?.status).toBe('stale');
expect(stale?.reason).toBe('content_hash_mismatch');
expect(stale?.actual_content_hash).toMatch(/^sha256:/);
```

Add parsing tests for JSON trace entries:

```ts
const claim = parseCodeClaimVerificationEntry('code_claim:{"path":"src/example.ts","symbol":"presentSymbol","expected_content_hash":"sha256:abc","verification_hint":"run rg"}');
expect(claim?.expected_content_hash).toBe('sha256:abc');
expect(claim?.verification_hint).toBe('run rg');
```

- [ ] **Step 2: Run the focused failing tests**

Run:

```bash
source ~/.zshrc 2>/dev/null || true
bun test test/code-claim-verification-service.test.ts test/code-claim-verification-operations.test.ts
```

Expected: fails because hash fields are not parsed or verified.

- [ ] **Step 3: Extend the type and service**

Update `CodeClaim` with optional:

```ts
expected_content_hash?: string;
verification_hint?: string;
source_ref?: string;
symbol_id?: string;
```

Update `CodeClaimVerificationResult.reason` with `content_hash_mismatch` and add optional `actual_content_hash?: string`.

Compute live file hash as `sha256:${hex}`. If `expected_content_hash` is present and differs from the live hash, return `status: "stale"` and `reason: "content_hash_mismatch"` before symbol matching.

- [ ] **Step 4: Extend operation param parsing**

`parseCodeClaimParamItem` should preserve `expected_content_hash`, `verification_hint`, `source_ref`, and `symbol_id` when they are non-empty strings.

- [ ] **Step 5: Run focused verification tests**

Run:

```bash
source ~/.zshrc 2>/dev/null || true
bun test test/code-claim-verification-service.test.ts test/code-claim-verification-operations.test.ts
```

Expected: all tests pass.

## Task 3: GA-P5 Scenario Fixture and Documentation

**Files:**
- Create: `test/fixtures/gbrain-absorption/ga-p5-code-lane.fixture.json`
- Create: `test/scenarios/s30-gbrain-code-lane.test.ts`
- Modify: `test/scenarios/README.md`
- Modify: `test/gbrain-absorption-docs-contract.test.ts`
- Modify: `docs/architecture/redesign/05-workstream-context-map.md`
- Modify: `docs/architecture/redesign/08-evaluation-and-acceptance.md`
- Modify: `docs/MBRAIN_VERIFY.md`

- [ ] **Step 1: Add the fixture**

Create fixture fields:

```json
{
  "stage_id": "GA-P5",
  "fixture_format": "gbrain_absorption_replay_v1",
  "description": "GA-P5 code-lane cases prove code graph data is derived orientation and current claims require live workspace verification.",
  "verification_commands": [
    "bun test test/context-map-code-lane-service.test.ts test/code-claim-verification-service.test.ts test/code-claim-verification-operations.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s30-gbrain-code-lane.test.ts",
    "bun run test:scenarios",
    "bunx tsc --noEmit --pretty false"
  ],
  "code_lane_cases": []
}
```

Populate cases for `definition_lookup`, `references_lookup`, `callers_lookup`, `callees_lookup`, `nearby_context`, and `stale_code_claim`.

- [ ] **Step 2: Add scenario test**

`s30-gbrain-code-lane.test.ts` should:

1. Assert fixture cases exist.
2. Import codemap pages.
3. Build the code-lane context map.
4. Assert `lane_grants_authority === false`, `authority === "derived_orientation"`, and graph walk is default-off.
5. Run `reverify_code_claims` with a stale `expected_content_hash` and assert `content_hash_mismatch`.
6. Assert README registers S30.

- [ ] **Step 3: Update docs and contract tests**

Add doc anchors that say:

- Code-lane runtime entries are derived orientation, not current code truth.
- Chunk-grain metadata is required before graph-walk retrieval can become default.
- Symbol graph expansion is opt-in, depth-limited, fanout-capped, and bounded.
- Extractor/chunker version changes must invalidate or rebuild derived code-lane artifacts.
- Current code claims require live file, symbol, branch, and content-hash verification.

- [ ] **Step 4: Run focused docs/scenario tests**

Run:

```bash
source ~/.zshrc 2>/dev/null || true
bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s30-gbrain-code-lane.test.ts
```

Expected: all tests pass.

## Final Verification

Run all focused GA-P5 checks:

```bash
source ~/.zshrc 2>/dev/null || true
bun test test/context-map-code-lane-service.test.ts test/context-map-service.test.ts test/code-claim-verification-service.test.ts test/code-claim-verification-operations.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s30-gbrain-code-lane.test.ts
bun run test:scenarios
bunx tsc --noEmit --pretty false
```

Before shipping the branch, run the repository-required checks:

```bash
source ~/.zshrc 2>/dev/null || true
bun test
```

Then run E2E with the required container lifecycle:

```bash
docker run -d --name mbrain-test-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mbrain_test -p 5435:5432 pgvector/pgvector:pg16
docker exec mbrain-test-pg pg_isready -U postgres
source ~/.zshrc 2>/dev/null || true
DATABASE_URL=postgresql://postgres:postgres@localhost:5435/mbrain_test bun run test:e2e
docker stop mbrain-test-pg
docker rm mbrain-test-pg
```

Also run:

```bash
git diff --check
```

## Review Requirements

After implementation and focused verification, dispatch a critical reviewer subagent before opening or merging the PR. Fix only valid findings, re-run the focused checks, then run full pre-ship verification. Keep PR-facing text scoped to MBrain's derived code-lane contract; do not describe local reference repository details.
