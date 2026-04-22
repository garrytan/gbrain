# MBrain Phase 2 Structural Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the smallest deterministic structural graph slice after note sections by exposing bounded `neighbors` and `path` behavior over existing manifest and section artifacts.

**Architecture:** Reuse `note_manifest_entries` and `note_section_entries` as the only inputs. Build an in-memory structural graph service with stable page/section node ids and explicit deterministic edge kinds, then expose narrow inspection-oriented operations and a local benchmark without introducing persisted Context Map storage.

**Tech Stack:** Bun, TypeScript, existing `BrainEngine` boundary, shared `operations.ts`, Bun test, repo-local benchmark scripts, SQLite local execution envelope.

---

## Scope and sequencing decisions

- This plan does not add `Context Map` or `Context Atlas` tables.
- This plan does not add semantic or inferred edges.
- The graph is built in memory from manifest and section rows on demand.
- Only page and section nodes are supported in this slice.
- The public surface is limited to `section-neighbors` and `section-path`.
- Benchmarks stay local and use sqlite like earlier phase runners.

## File Map

### Core files to create

- `src/core/services/note-structural-graph-service.ts` — deterministic page/section graph builder, neighbors lookup, and bounded shortest-path logic
- `test/note-structural-graph-service.test.ts` — graph-shape, neighbor, and path correctness coverage
- `test/note-structural-graph-operations.test.ts` — operation registration coverage
- `scripts/bench/phase2-structural-paths.ts` — reproducible benchmark runner for graph build, neighbors, and path workloads
- `test/phase2-structural-paths.test.ts` — benchmark JSON shape and acceptance summary coverage

### Existing files expected to change

- `src/core/operations.ts`
- `test/cli.test.ts`
- `package.json`
- `docs/MBRAIN_VERIFY.md`

## Contracts to lock before implementation

- page node id: `page:<slug>`
- section node id: `section:<section_id>`
- allowed edge kinds: `page_contains_section`, `section_parent`, `section_links_page`
- `neighbors` returns adjacent node ids plus the deterministic edge explanation
- `path` returns the bounded shortest path with nodes, traversed edges, and hop count
- invalid node ids fail clearly; missing paths return an explicit not-found result

### Task 1: Add the deterministic structural graph service

**Files:**
- Create: `test/note-structural-graph-service.test.ts`
- Create: `src/core/services/note-structural-graph-service.ts`

- [ ] **Step 1: Write the failing graph-service test**

Create `test/note-structural-graph-service.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import {
  buildStructuralGraphSnapshot,
  findStructuralPath,
  getStructuralNeighbors,
} from '../src/core/services/note-structural-graph-service.ts';

test('structural graph service derives deterministic neighbors and paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-structural-graph-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'See [[concepts/note-manifest]].',
      '',
      '## Runtime',
      'Details',
    ].join('\\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
    ].join('\\n'), { path: 'concepts/note-manifest.md' });

    const graph = await buildStructuralGraphSnapshot(engine);
    const neighbors = await getStructuralNeighbors(engine, 'page:systems/mbrain');
    const path = await findStructuralPath(engine, 'page:systems/mbrain', 'page:concepts/note-manifest');

    expect(graph.nodes.map((node) => node.node_id)).toContain('page:systems/mbrain');
    expect(neighbors.some((edge) => edge.edge_kind === 'page_contains_section')).toBe(true);
    expect(path?.node_ids).toEqual([
      'page:systems/mbrain',
      'section:systems/mbrain#overview',
      'page:concepts/note-manifest',
    ]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test test/note-structural-graph-service.test.ts
```

Expected: fail because `note-structural-graph-service.ts` does not exist.

- [ ] **Step 3: Implement the minimal graph service**

Create `src/core/services/note-structural-graph-service.ts` with:

```ts
import type { BrainEngine } from '../engine.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';

export type StructuralNodeId = `page:${string}` | `section:${string}`;
export type StructuralEdgeKind = 'page_contains_section' | 'section_parent' | 'section_links_page';

export interface StructuralGraphNode {
  node_id: StructuralNodeId;
  node_kind: 'page' | 'section';
  label: string;
  page_slug: string;
  section_id?: string;
}

export interface StructuralGraphEdge {
  edge_kind: StructuralEdgeKind;
  from_node_id: StructuralNodeId;
  to_node_id: StructuralNodeId;
  scope_id: string;
  source_page_slug: string;
  source_section_id?: string;
  source_path?: string;
  source_refs: string[];
}

export async function buildStructuralGraphSnapshot(engine: BrainEngine, scopeId = DEFAULT_NOTE_MANIFEST_SCOPE_ID) {
  // list manifest rows, list section rows, emit page/section nodes and deterministic edges only
}

export async function getStructuralNeighbors(
  engine: BrainEngine,
  nodeId: StructuralNodeId,
  input: { scope_id?: string; limit?: number } = {},
) {
  // build snapshot, validate node id, return bounded adjacent edges sorted deterministically
}

export async function findStructuralPath(
  engine: BrainEngine,
  fromNodeId: StructuralNodeId,
  toNodeId: StructuralNodeId,
  input: { scope_id?: string; max_depth?: number } = {},
) {
  // breadth-first search over deterministic edges only
}
```

Implementation requirements:

- page nodes come from note manifest slugs
- section nodes come from note section rows
- `page_contains_section` is emitted for every section row
- `section_parent` is emitted when `parent_section_id` exists
- `section_links_page` is emitted only when a section wikilink target resolves to an existing manifest slug
- sort emitted edges by `from_node_id`, `edge_kind`, `to_node_id`

- [ ] **Step 4: Run the service test to verify it passes**

Run:

```bash
bun test test/note-structural-graph-service.test.ts
```

Expected: pass with deterministic neighbors and shortest-path behavior.

- [ ] **Step 5: Commit**

```bash
git add test/note-structural-graph-service.test.ts src/core/services/note-structural-graph-service.ts
git commit -m "feat: add deterministic structural graph service"
```

### Task 2: Expose structural neighbors and path operations

**Files:**
- Create: `test/note-structural-graph-operations.test.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write the failing operation-registration test**

Create `test/note-structural-graph-operations.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';

test('structural graph operations are registered with CLI hints', () => {
  const neighbors = operations.find((operation) => operation.name === 'get_note_structural_neighbors');
  const path = operations.find((operation) => operation.name === 'find_note_structural_path');

  expect(neighbors?.cliHints?.name).toBe('section-neighbors');
  expect(path?.cliHints?.name).toBe('section-path');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test test/note-structural-graph-operations.test.ts
```

Expected: fail because the operations are not registered yet.

- [ ] **Step 3: Implement the minimal operations**

Add to `src/core/operations.ts`:

```ts
const get_note_structural_neighbors: Operation = {
  name: 'get_note_structural_neighbors',
  description: 'List deterministic structural neighbors for a page or section node.',
  params: {
    node_id: { type: 'string', required: true, description: 'page:<slug> or section:<section_id>' },
    scope_id: { type: 'string', description: 'Structural scope id (default: workspace:default)' },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  cliHints: { name: 'section-neighbors', positional: ['node_id'], aliases: { n: 'limit' } },
  handler: async (_ctx, _p) => { /* call getStructuralNeighbors */ },
};

const find_note_structural_path: Operation = {
  name: 'find_note_structural_path',
  description: 'Find a bounded deterministic structural path between two nodes.',
  params: {
    from_node_id: { type: 'string', required: true, description: 'Start node id' },
    to_node_id: { type: 'string', required: true, description: 'Target node id' },
    scope_id: { type: 'string', description: 'Structural scope id (default: workspace:default)' },
    max_depth: { type: 'number', description: 'Maximum hop count (default 6)' },
  },
  cliHints: { name: 'section-path', positional: ['from_node_id', 'to_node_id'] },
  handler: async (_ctx, _p) => { /* call findStructuralPath */ },
};
```

Add CLI assertions to `test/cli.test.ts`:

```ts
test('section-neighbors --help prints usage without DB connection', async () => {
  const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'section-neighbors', '--help'], {
    cwd: repoRoot,
    env: { ...process.env, HOME: tempHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  expect(stdout).toContain('Usage: mbrain section-neighbors <node_id>');
  expect(exitCode).toBe(0);
});
```

- [ ] **Step 4: Run the operation and CLI tests to verify they pass**

Run:

```bash
bun test test/note-structural-graph-operations.test.ts
bun test test/cli.test.ts -t "section-neighbors --help"
```

Expected: the two new operations are registered and visible through CLI help.

- [ ] **Step 5: Commit**

```bash
git add test/note-structural-graph-operations.test.ts test/cli.test.ts src/core/operations.ts
git commit -m "feat: add structural path inspection operations"
```

### Task 3: Add the Phase 2 structural-paths benchmark

**Files:**
- Create: `scripts/bench/phase2-structural-paths.ts`
- Create: `test/phase2-structural-paths.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

- [ ] **Step 1: Write the failing benchmark test**

Create `test/phase2-structural-paths.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 structural paths benchmark', () => {
  test('--json prints a structural-path benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-structural-paths.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'structural_graph_build',
      'structural_neighbors',
      'structural_path',
      'structural_path_correctness',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase2_status).toBe('pass');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test test/phase2-structural-paths.test.ts
```

Expected: fail because the benchmark script does not exist yet.

- [ ] **Step 3: Implement the local benchmark runner**

Create `scripts/bench/phase2-structural-paths.ts`:

```ts
#!/usr/bin/env bun

// seed two or three notes through importFromContent
// measure:
// - structural_graph_build
// - structural_neighbors
// - structural_path
// - structural_path_correctness
//
// guardrails:
// - build p95 <= 150ms
// - neighbors p95 <= 100ms
// - path p95 <= 100ms
// - correctness success_rate === 100
```

Update `package.json`:

```json
{
  "scripts": {
    "bench:phase2-structural-paths": "bun run ./scripts/bench/phase2-structural-paths.ts"
  }
}
```

Update `docs/MBRAIN_VERIFY.md` with:

~~~md
## Phase 2 structural-paths verification

Run:

```bash
bun test test/note-structural-graph-service.test.ts test/note-structural-graph-operations.test.ts test/phase2-structural-paths.test.ts
```

Expected:

- deterministic structural neighbors and path coverage pass
- the operation surface exposes `section-neighbors` and `section-path`
- the benchmark reports local guardrail status for graph build, neighbors, and path lookup
~~~

- [ ] **Step 4: Run the benchmark verification**

Run:

```bash
bun test test/phase2-structural-paths.test.ts
bun run bench:phase2-structural-paths --json
```

Expected:

- benchmark JSON includes all four workloads
- latency workloads report positive `p50_ms` and `p95_ms`
- correctness success rate is `100`
- `acceptance.readiness_status` and `acceptance.phase2_status` are both `pass`

- [ ] **Step 5: Commit**

```bash
git add scripts/bench/phase2-structural-paths.ts test/phase2-structural-paths.test.ts package.json docs/MBRAIN_VERIFY.md
git commit -m "feat: add structural path benchmark verification"
```

## Notes

- Keep the graph service purely derived and in-memory in this slice.
- Do not add new schema or persisted map tables.
- Do not introduce semantic bridges or ranking heuristics.
- If path correctness fails, fix deterministic edge emission before widening scope.
