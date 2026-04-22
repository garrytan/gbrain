# MBrain Phase 2 Context Map Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one deterministic structural context-map artifact over the existing manifest and section layers, then expose `map-build`, `map-get`, and `map-list`.

**Architecture:** Reuse the existing structural graph service as the only builder. Add a small `context_map_entries` store behind the `BrainEngine`, persist one workspace-scoped structural graph payload with metadata and counts, and keep refresh explicit through `map-build` instead of adding background map maintenance.

**Tech Stack:** Bun, TypeScript, existing `BrainEngine` boundary, SQLite/Postgres/PGLite engines, shared `operations.ts`, Bun test, repo-local benchmark scripts.

---

## Scope and sequencing decisions

- This plan adds persisted context-map storage but not `Context Atlas`.
- This plan persists one deterministic `workspace` map kind only.
- This plan keeps graph building structural-only and reuses the existing `note-structural-graph-service`.
- This plan does not add automatic refresh on canonical writes.
- This plan does not add semantic edges, clustering, or reports.

## File Map

### Core files to create

- `src/core/services/context-map-service.ts` — persisted structural context-map builder and source-set hashing
- `test/context-map-schema.test.ts` — schema coverage for context-map storage
- `test/context-map-service.test.ts` — builder correctness, deterministic ids, and rebuild behavior
- `test/context-map-operations.test.ts` — operation registration coverage
- `scripts/bench/phase2-context-map.ts` — benchmark runner for map build/get/list correctness and latency
- `test/phase2-context-map.test.ts` — benchmark JSON shape and acceptance summary coverage

### Existing files expected to change

- `src/core/types.ts`
- `src/core/engine.ts`
- `src/schema.sql`
- `src/core/schema-embedded.ts`
- `src/core/pglite-schema.ts`
- `src/core/migrate.ts`
- `src/core/sqlite-engine.ts`
- `src/core/pglite-engine.ts`
- `src/core/postgres-engine.ts`
- `src/core/operations.ts`
- `test/cli.test.ts`
- `package.json`
- `docs/MBRAIN_VERIFY.md`

## Contracts to lock before implementation

- map id: `context-map:workspace:<scope_id>`
- map kind: `workspace`
- build mode: `structural`
- status: `ready`
- graph payload source: `buildStructuralGraphSnapshot`
- source set hash: stable hash over sorted manifest + section content hashes in scope

### Task 1: Add context-map schema and engine support

**Files:**
- Create: `test/context-map-schema.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/engine.ts`
- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Modify: `src/core/pglite-schema.ts`
- Modify: `src/core/migrate.ts`
- Modify: `src/core/sqlite-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `src/core/postgres-engine.ts`

- [ ] **Step 1: Write the failing schema test**

Create `test/context-map-schema.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('context-map schema', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite initSchema creates context_map_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-sqlite-'));
    tempDirs.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const tables = (engine as any).database
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_map_entries'`)
      .all();

    expect(tables).toHaveLength(1);
    await engine.disconnect();
  });

  test('pglite initSchema creates context_map_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-pglite-'));
    tempDirs.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const result = await (engine as any).db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'context_map_entries'`,
    );

    expect(result.rows).toHaveLength(1);
    await engine.disconnect();
  });
});
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run:

```bash
bun test test/context-map-schema.test.ts
```

Expected: fail because `context_map_entries` does not exist yet.

- [ ] **Step 3: Add the shared context-map types**

Update `src/core/types.ts` with:

```ts
export interface ContextMapEntry {
  id: string;
  scope_id: string;
  kind: 'workspace';
  title: string;
  build_mode: 'structural';
  status: 'ready' | 'stale' | 'failed';
  source_set_hash: string;
  extractor_version: string;
  node_count: number;
  edge_count: number;
  community_count: number;
  graph_json: Record<string, unknown>;
  generated_at: Date;
  stale_reason: string | null;
}

export interface ContextMapEntryInput {
  id: string;
  scope_id: string;
  kind: 'workspace';
  title: string;
  build_mode: 'structural';
  status: 'ready' | 'stale' | 'failed';
  source_set_hash: string;
  extractor_version: string;
  node_count: number;
  edge_count: number;
  community_count: number;
  graph_json: Record<string, unknown>;
  stale_reason?: string | null;
}

export interface ContextMapFilters {
  scope_id?: string;
  kind?: 'workspace';
  limit?: number;
}
```

Update `src/core/engine.ts` with:

```ts
  upsertContextMapEntry(input: ContextMapEntryInput): Promise<ContextMapEntry>;
  getContextMapEntry(id: string): Promise<ContextMapEntry | null>;
  listContextMapEntries(filters?: ContextMapFilters): Promise<ContextMapEntry[]>;
  deleteContextMapEntry(id: string): Promise<void>;
```

- [ ] **Step 4: Add additive schema and migration**

Add `context_map_entries` to `src/schema.sql`, `src/core/schema-embedded.ts`, and `src/core/pglite-schema.ts`:

```sql
CREATE TABLE IF NOT EXISTS context_map_entries (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  build_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  source_set_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  community_count INTEGER NOT NULL DEFAULT 0,
  graph_json JSONB NOT NULL DEFAULT '{}',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stale_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_context_maps_scope_generated
  ON context_map_entries(scope_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_maps_scope_kind
  ON context_map_entries(scope_id, kind);
```

Add a new migration to `src/core/migrate.ts` for the same table.

- [ ] **Step 5: Add engine CRUD support**

Implement `upsertContextMapEntry`, `getContextMapEntry`, `listContextMapEntries`, and `deleteContextMapEntry` in sqlite, pglite, and postgres using the same JSON parsing pattern already used for manifest rows.

- [ ] **Step 6: Run the schema test to verify it passes**

Run:

```bash
bun test test/context-map-schema.test.ts
```

Expected: sqlite and pglite both create `context_map_entries`.

- [ ] **Step 7: Commit**

```bash
git add test/context-map-schema.test.ts src/core/types.ts src/core/engine.ts src/schema.sql src/core/schema-embedded.ts src/core/pglite-schema.ts src/core/migrate.ts src/core/sqlite-engine.ts src/core/pglite-engine.ts src/core/postgres-engine.ts
git commit -m "feat: add context map persistence foundations"
```

### Task 2: Build and inspect persisted structural context maps

**Files:**
- Create: `test/context-map-service.test.ts`
- Create: `src/core/services/context-map-service.ts`
- Create: `test/context-map-operations.test.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write the failing service test**

Create `test/context-map-service.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import {
  buildStructuralContextMapEntry,
  WORKSPACE_CONTEXT_MAP_KIND,
  workspaceContextMapId,
} from '../src/core/services/context-map-service.ts';

test('context-map service builds a persisted structural workspace map', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-service-'));
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
    ].join('\\n'), { path: 'systems/mbrain.md' });

    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
    ].join('\\n'), { path: 'concepts/note-manifest.md' });

    const entry = await buildStructuralContextMapEntry(engine);

    expect(entry.id).toBe(workspaceContextMapId('workspace:default'));
    expect(entry.kind).toBe(WORKSPACE_CONTEXT_MAP_KIND);
    expect(entry.build_mode).toBe('structural');
    expect(entry.node_count).toBeGreaterThan(0);
    expect(entry.edge_count).toBeGreaterThan(0);
    expect((entry.graph_json as any).nodes.length).toBeGreaterThan(0);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the service test to verify it fails**

Run:

```bash
bun test test/context-map-service.test.ts
```

Expected: fail because `context-map-service.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal context-map builder**

Create `src/core/services/context-map-service.ts`:

```ts
import { createHash } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type { ContextMapEntry } from '../types.ts';
import { buildStructuralGraphSnapshot } from './note-structural-graph-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';

export const WORKSPACE_CONTEXT_MAP_KIND = 'workspace';
export const CONTEXT_MAP_EXTRACTOR_VERSION = 'phase2-context-map-v1';

export function workspaceContextMapId(scopeId: string): string {
  return `context-map:workspace:${scopeId}`;
}

export async function buildStructuralContextMapEntry(
  engine: BrainEngine,
  scopeId = DEFAULT_NOTE_MANIFEST_SCOPE_ID,
): Promise<ContextMapEntry> {
  // list manifest + section rows, build structural graph snapshot, hash source set, upsert persisted map
}
```

Implementation requirements:

- `title` should be `Workspace Structural Map`
- `graph_json` should contain the exact `nodes` and `edges` arrays from the structural graph snapshot
- `source_set_hash` should hash sorted manifest and section `(id or slug, content_hash)` tuples
- `community_count` stays `0`
- `status` is `ready`

- [ ] **Step 4: Write the failing operation-registration test**

Create `test/context-map-operations.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';

test('context-map operations are registered with CLI hints', () => {
  const build = operations.find((operation) => operation.name === 'build_context_map');
  const get = operations.find((operation) => operation.name === 'get_context_map_entry');
  const list = operations.find((operation) => operation.name === 'list_context_map_entries');

  expect(build?.cliHints?.name).toBe('map-build');
  expect(get?.cliHints?.name).toBe('map-get');
  expect(list?.cliHints?.name).toBe('map-list');
});
```

- [ ] **Step 5: Run the operation test to verify it fails**

Run:

```bash
bun test test/context-map-operations.test.ts
```

Expected: fail because the operations are not registered yet.

- [ ] **Step 6: Implement the minimal operations**

Add to `src/core/operations.ts`:

```ts
const build_context_map: Operation = {
  name: 'build_context_map',
  description: 'Build or rebuild the persisted structural workspace context map.',
  params: {
    scope_id: { type: 'string', description: 'Context-map scope id (default: workspace:default)' },
  },
  mutating: true,
  cliHints: { name: 'map-build' },
  handler: async (ctx, p) => { /* call buildStructuralContextMapEntry */ },
};

const get_context_map_entry: Operation = {
  name: 'get_context_map_entry',
  description: 'Get one persisted structural context map by id.',
  params: {
    id: { type: 'string', required: true, description: 'Context map id' },
  },
  cliHints: { name: 'map-get', positional: ['id'] },
  handler: async (ctx, p) => { /* call engine.getContextMapEntry */ },
};

const list_context_map_entries: Operation = {
  name: 'list_context_map_entries',
  description: 'List persisted structural context maps.',
  params: {
    scope_id: { type: 'string', description: 'Context-map scope id (default: workspace:default)' },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  cliHints: { name: 'map-list', aliases: { n: 'limit' } },
  handler: async (ctx, p) => { /* call engine.listContextMapEntries */ },
};
```

Add CLI assertions to `test/cli.test.ts` for `map-build --help` and `map-get --help`.

- [ ] **Step 7: Run the service, operation, and CLI tests**

Run:

```bash
bun test test/context-map-service.test.ts test/context-map-operations.test.ts
bun test test/cli.test.ts -t "map-build --help"
```

Expected:

- the service builds a persisted workspace map
- the operation surface exposes `map-build`, `map-get`, and `map-list`
- CLI help is available without a DB connection

- [ ] **Step 8: Commit**

```bash
git add test/context-map-service.test.ts src/core/services/context-map-service.ts test/context-map-operations.test.ts test/cli.test.ts src/core/operations.ts
git commit -m "feat: add persisted structural context map operations"
```

### Task 3: Add the Phase 2 context-map benchmark

**Files:**
- Create: `scripts/bench/phase2-context-map.ts`
- Create: `test/phase2-context-map.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

- [ ] **Step 1: Write the failing benchmark test**

Create `test/phase2-context-map.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 context-map benchmark', () => {
  test('--json prints a context-map benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-context-map.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'context_map_build',
      'context_map_correctness',
      'context_map_get',
      'context_map_list',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase2_status).toBe('pass');
  });
});
```

- [ ] **Step 2: Run the benchmark test to verify it fails**

Run:

```bash
bun test test/phase2-context-map.test.ts
```

Expected: fail because the benchmark script does not exist yet.

- [ ] **Step 3: Implement the local benchmark runner**

Create `scripts/bench/phase2-context-map.ts`:

```ts
#!/usr/bin/env bun

// seed notes through importFromContent
// build one workspace context map
// measure:
// - context_map_build
// - context_map_get
// - context_map_list
// - context_map_correctness
//
// guardrails:
// - build p95 <= 150ms
// - get p95 <= 100ms
// - list p95 <= 100ms
// - correctness success_rate === 100
```

Update `package.json` with `bench:phase2-context-map`.

Update `docs/MBRAIN_VERIFY.md` with the verification and benchmark commands.

- [ ] **Step 4: Run benchmark verification**

Run:

```bash
bun test test/phase2-context-map.test.ts
bun run bench:phase2-context-map --json
```

Expected:

- benchmark JSON includes all four workloads
- latency workloads report positive `p50_ms` and `p95_ms`
- correctness success rate is `100`
- `acceptance.readiness_status` and `acceptance.phase2_status` are both `pass`

- [ ] **Step 5: Commit**

```bash
git add scripts/bench/phase2-context-map.ts test/phase2-context-map.test.ts package.json docs/MBRAIN_VERIFY.md
git commit -m "feat: add context map benchmark verification"
```

## Notes

- Keep this slice persisted but still fully derived.
- Do not add atlas routing, project cards, or map reports here.
- Do not add semantic edges or community detection.
- If correctness fails, fix the structural graph or source-set hashing instead of widening map behavior.
