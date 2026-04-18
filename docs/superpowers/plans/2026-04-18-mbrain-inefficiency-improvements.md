# MBrain Inefficiency Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the highest-cost architectural and local-runtime inefficiencies in `mbrain` without changing the product surface or replacing the current TypeScript/Bun stack.

**Architecture:** Add measurement first, then reduce backend fanout by introducing explicit engine capabilities and shared workflow services. Rework SQLite semantic search around page-level candidate narrowing so local search stops scanning every chunk, and restructure import around staged concurrency so local engines can parallelize safe work without unsafe multi-writer behavior.

**Tech Stack:** Bun, TypeScript, `postgres`, `bun:sqlite`, existing `BrainEngine` contract, MCP stdio, Bun test, repo-local benchmark scripts.

---

## Scope and sequencing decisions

- This plan keeps the public CLI name, MCP behavior, and config shape stable unless a task explicitly documents a surface change.
- No implementation-language replacement work is included.
- The plan prioritizes local/offline gains first because that is the clearest user-facing inefficiency path.
- The plan does **not** attempt a one-shot rewrite of all engines. It first creates the shared seams that let later cleanup reduce duplication safely.
- The first local search improvement uses page-level candidate narrowing instead of immediately adding a native ANN dependency. This keeps the change auditable and portable.

---

## File Map

### Core files to create

- `src/core/engine-capabilities.ts` — explicit per-engine feature flags used by CLI, services, and tests
- `src/core/services/import-service.ts` — staged import orchestration independent of CLI parsing
- `src/core/services/doctor-service.ts` — backend-neutral doctor/health orchestration
- `src/core/services/page-embedding.ts` — shared page-centroid embedding helpers used after chunk writes
- `src/core/search/vector-prefilter.ts` — page-level candidate narrowing for local vector search
- `scripts/bench/import.ts` — repeatable import throughput benchmark
- `scripts/bench/search.ts` — repeatable keyword/semantic search benchmark
- `test/engine-capabilities.test.ts` — capability matrix tests
- `test/import-service.test.ts` — import orchestration tests independent of CLI
- `test/page-embedding.test.ts` — centroid computation and candidate narrowing tests
- `test/bench-smoke.test.ts` — benchmark script smoke tests

### Existing files expected to change

- `package.json`
- `src/cli.ts`
- `src/commands/import.ts`
- `src/commands/doctor.ts`
- `src/commands/sync.ts`
- `src/core/engine.ts`
- `src/core/engine-factory.ts`
- `src/core/postgres-engine.ts`
- `src/core/sqlite-engine.ts`
- `src/core/pglite-engine.ts`
- `src/core/db.ts`
- `src/core/import-file.ts`
- `src/core/operations.ts`
- `src/core/search/hybrid.ts`
- `docs/architecture/infra-layer.md`
- `docs/local-offline.md`
- `test/sqlite-engine.test.ts`
- `test/postgres-engine.test.ts`
- `test/pglite-engine.test.ts`
- `test/engine-factory.test.ts`
- `test/cli.test.ts`
- `test/doctor.test.ts`
- `test/import-resume.test.ts`
- `test/local-offline.test.ts`

---

### Task 1: Add benchmark scaffolding and align docs with the real architecture

**Files:**
- Create: `scripts/bench/import.ts`
- Create: `scripts/bench/search.ts`
- Create: `test/bench-smoke.test.ts`
- Modify: `package.json`
- Modify: `docs/architecture/infra-layer.md`
- Modify: `docs/local-offline.md`

- [ ] **Step 1: Write smoke tests for benchmark entrypoints**

Add `test/bench-smoke.test.ts` with explicit CLI-level checks so benchmark scripts stay runnable:

```ts
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('benchmark scripts', () => {
  test('search benchmark prints usage with --help', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/search.ts', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toContain('Usage: bun run scripts/bench/search.ts');
  });

  test('import benchmark prints usage with --help', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/import.ts', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toContain('Usage: bun run scripts/bench/import.ts');
  });
});
```

- [ ] **Step 2: Add benchmark scripts and package commands**

Create the search benchmark with explicit metric output:

```ts
#!/usr/bin/env bun
import { performance } from 'perf_hooks';
import { loadConfig } from '../src/core/config.ts';
import { createConnectedEngine } from '../src/core/engine-factory.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';

const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/search.ts --query "term" [--iterations 20]');
  process.exit(0);
}

const query = process.argv.includes('--query')
  ? process.argv[process.argv.indexOf('--query') + 1]
  : 'paperpilot';
const iterations = process.argv.includes('--iterations')
  ? Number(process.argv[process.argv.indexOf('--iterations') + 1])
  : 20;

const config = loadConfig();
if (!config) throw new Error('No mbrain config found.');

const engine = await createConnectedEngine(config);
const samples: number[] = [];
for (let i = 0; i < iterations; i++) {
  const start = performance.now();
  await hybridSearch(engine, query, { limit: 10, expansion: false });
  samples.push(performance.now() - start);
}
await engine.disconnect();

samples.sort((a, b) => a - b);
const p50 = samples[Math.floor(samples.length * 0.5)]!;
const p95 = samples[Math.floor(samples.length * 0.95)]!;
console.log(JSON.stringify({ query, iterations, p50_ms: Math.round(p50), p95_ms: Math.round(p95) }, null, 2));
```

Update `package.json`:

```json
{
  "scripts": {
    "bench:search": "bun run scripts/bench/search.ts",
    "bench:import": "bun run scripts/bench/import.ts"
  }
}
```

- [ ] **Step 3: Rewrite the architecture docs to match the shipped local-first path**

Update `docs/architecture/infra-layer.md` so the embedding and search sections reflect current behavior:

```md
## Search Architecture

MBrain currently supports two retrieval profiles:

- Postgres: server-side full-text plus pgvector
- SQLite local/offline: FTS5 keyword retrieval plus local vector scoring

Local/offline defaults:

- engine: `sqlite`
- embedding model: `nomic-embed-text`
- embedding dimension: `768`
- query rewrite: `heuristic`
```

Update `docs/local-offline.md` with a measurement note so future performance work has a stable operator entrypoint:

```md
## 6. Measure local performance

Use the built-in benchmark entrypoints before and after local search changes:

```bash
bun run bench:search --query "competitive dynamics"
bun run bench:import --repo ~/git/brain
```
```

- [ ] **Step 4: Verify benchmark smoke tests and docs references**

Run:

```bash
bun test test/bench-smoke.test.ts
rg -n 'text-embedding-3-large|1536|nomic-embed-text|768' docs/architecture/infra-layer.md docs/local-offline.md
```

Expected:

- benchmark smoke tests pass
- architecture docs no longer describe `text-embedding-3-large` as the current local default

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/bench/import.ts scripts/bench/search.ts test/bench-smoke.test.ts docs/architecture/infra-layer.md docs/local-offline.md
git commit -m "docs: align architecture and add benchmark scaffolding"
```

---

### Task 2: Introduce explicit engine capabilities and shared engine metadata helpers

**Files:**
- Create: `src/core/engine-capabilities.ts`
- Create: `src/core/services/page-embedding.ts`
- Create: `test/engine-capabilities.test.ts`
- Create: `test/page-embedding.test.ts`
- Modify: `src/core/engine.ts`
- Modify: `src/core/engine-factory.ts`
- Modify: `src/core/sqlite-engine.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `test/engine-factory.test.ts`

- [ ] **Step 1: Write failing capability-matrix and page-embedding tests**

Add a new capability test that fixes the intended engine contract:

```ts
import { describe, expect, test } from 'bun:test';
import { getEngineCapabilities } from '../src/core/engine-capabilities.ts';

describe('engine capabilities', () => {
  test('sqlite is local-first but lacks raw postgres access', () => {
    expect(getEngineCapabilities({ engine: 'sqlite' } as any)).toEqual({
      rawPostgresAccess: false,
      parallelWorkers: false,
      localVectorPrefilter: 'page-centroid',
    });
  });

  test('postgres keeps raw access and worker fanout', () => {
    expect(getEngineCapabilities({ engine: 'postgres' } as any)).toEqual({
      rawPostgresAccess: true,
      parallelWorkers: true,
      localVectorPrefilter: 'none',
    });
  });
});
```

Add a page-embedding helper test:

```ts
import { describe, expect, test } from 'bun:test';
import { buildPageCentroid } from '../src/core/services/page-embedding.ts';

describe('buildPageCentroid', () => {
  test('averages chunk embeddings and ignores nulls', () => {
    const centroid = buildPageCentroid([
      new Float32Array([1, 0]),
      null,
      new Float32Array([0, 1]),
    ]);
    expect(Array.from(centroid!)).toEqual([0.5, 0.5]);
  });
});
```

- [ ] **Step 2: Add engine capabilities as a single policy source**

Create `src/core/engine-capabilities.ts`:

```ts
import type { MBrainConfig } from './config.ts';

export interface EngineCapabilities {
  rawPostgresAccess: boolean;
  parallelWorkers: boolean;
  localVectorPrefilter: 'none' | 'page-centroid';
}

export function getEngineCapabilities(config: Pick<MBrainConfig, 'engine'>): EngineCapabilities {
  switch (config.engine) {
    case 'postgres':
      return { rawPostgresAccess: true, parallelWorkers: true, localVectorPrefilter: 'none' };
    case 'sqlite':
      return { rawPostgresAccess: false, parallelWorkers: false, localVectorPrefilter: 'page-centroid' };
    case 'pglite':
      return { rawPostgresAccess: false, parallelWorkers: false, localVectorPrefilter: 'page-centroid' };
  }
}
```

Refactor `src/core/engine-factory.ts` to delegate:

```ts
import { getEngineCapabilities } from './engine-capabilities.ts';

export function supportsParallelWorkers(config: MBrainConfig): boolean {
  return getEngineCapabilities(config).parallelWorkers;
}

export function supportsRawPostgresAccess(config: MBrainConfig): boolean {
  return getEngineCapabilities(config).rawPostgresAccess;
}
```

- [ ] **Step 3: Add shared page-centroid helpers without changing retrieval yet**

Create `src/core/services/page-embedding.ts`:

```ts
export function buildPageCentroid(vectors: Array<Float32Array | null>): Float32Array | null {
  const usable = vectors.filter((vector): vector is Float32Array => vector !== null);
  if (usable.length === 0) return null;

  const out = new Float32Array(usable[0]!.length);
  for (const vector of usable) {
    for (let i = 0; i < vector.length; i++) out[i]! += vector[i]!;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= usable.length;
  return out;
}
```

Extend the engine interface with explicit page-embedding hooks:

```ts
export interface BrainEngine {
  getPageEmbeddings(type?: string): Promise<Array<{ page_id: number; slug: string; embedding: Float32Array | null }>>;
  updatePageEmbedding(slug: string, embedding: Float32Array | null): Promise<void>;
}
```

- [ ] **Step 4: Wire page-embedding persistence into all three engines**

Implement the new methods in each engine and keep the storage shape simple:

- Postgres and PGLite: add nullable `page_embedding` columns or companion storage using the existing backend type
- SQLite: add nullable blob storage on the page row using the same blob codec used for chunk embeddings

For SQLite, the shape should be explicit:

```ts
async updatePageEmbedding(slug: string, embedding: Float32Array | null): Promise<void> {
  const pageId = this.getPageIdOrThrow(slug);
  this.database.run(
    `UPDATE pages SET page_embedding = ? WHERE id = ?`,
    [embedding ? float32ToBlob(embedding) : null, pageId],
  );
}
```

- [ ] **Step 5: Verify tests**

Run:

```bash
bun test test/engine-capabilities.test.ts test/page-embedding.test.ts test/engine-factory.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/core/engine.ts src/core/engine-capabilities.ts src/core/engine-factory.ts src/core/services/page-embedding.ts src/core/sqlite-engine.ts src/core/postgres-engine.ts src/core/pglite-engine.ts test/engine-capabilities.test.ts test/page-embedding.test.ts test/engine-factory.test.ts
git commit -m "refactor: add engine capabilities and shared page embeddings"
```

---

### Task 3: Extract import and doctor workflows into service modules and thin the CLI path

**Files:**
- Create: `src/core/services/import-service.ts`
- Create: `src/core/services/doctor-service.ts`
- Create: `test/import-service.test.ts`
- Modify: `src/commands/import.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `src/cli.ts`
- Modify: `test/import-resume.test.ts`
- Modify: `test/doctor.test.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write failing service-level tests before moving command logic**

Add an import service test:

```ts
import { describe, expect, test } from 'bun:test';
import { collectImportSummary } from '../src/core/services/import-service.ts';

describe('collectImportSummary', () => {
  test('tracks imported, skipped, errors, and checkpoint progress', async () => {
    const summary = await collectImportSummary({
      totalFiles: 3,
      events: [
        { type: 'imported', slug: 'notes/a', chunks: 2 },
        { type: 'skipped', reason: 'unchanged' },
        { type: 'error', message: 'bad frontmatter' },
      ],
    });

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(summary.errors).toBe(1);
  });
});
```

Add a doctor service test:

```ts
import { describe, expect, test } from 'bun:test';
import { buildDoctorReport } from '../src/core/services/doctor-service.ts';

describe('buildDoctorReport', () => {
  test('marks sqlite local profile honestly', async () => {
    const report = await buildDoctorReport({
      engine: 'sqlite',
      offline: true,
      stats: { page_count: 10, chunk_count: 20, embedded_count: 5 } as any,
    });
    expect(report.status).toBe('healthy');
    expect(report.checks.some((check) => check.name === 'offline_profile')).toBe(true);
  });
});
```

- [ ] **Step 2: Create service modules with command-neutral APIs**

Create `src/core/services/import-service.ts`:

```ts
export interface ImportRunOptions {
  rootDir: string;
  noEmbed: boolean;
  workers: number;
  fresh: boolean;
  json: boolean;
}

export interface ImportRunSummary {
  imported: number;
  skipped: number;
  errors: number;
  chunksCreated: number;
  importedSlugs: string[];
}

export async function runImportService(engine: BrainEngine, options: ImportRunOptions): Promise<ImportRunSummary> {
  // Move directory walking, checkpointing, progress accounting, and ingest logging here.
}
```

Create `src/core/services/doctor-service.ts`:

```ts
export interface DoctorReport {
  status: 'healthy' | 'warn' | 'error';
  checks: Array<{ name: string; status: 'ok' | 'warn' | 'error'; message: string }>;
}

export async function buildDoctorReport(input: {
  engine: string;
  offline: boolean;
  stats: BrainStats;
  capabilities?: EngineCapabilities;
}): Promise<DoctorReport> {
  // Build check rows without printing.
}
```

- [ ] **Step 3: Refactor CLI command files into thin adapters**

Reduce `src/commands/import.ts` to option parsing and service delegation:

```ts
export async function runImport(engine: BrainEngine, args: string[]) {
  const options = parseImportArgs(args);
  const summary = await runImportService(engine, options);
  printImportSummary(summary, options.json);
}
```

Reduce `src/commands/doctor.ts` to:

```ts
export async function runDoctor(engine: BrainEngine, args: string[]) {
  const report = await buildDoctorReport(await collectDoctorInputs(engine));
  if (args.includes('--json')) {
    console.log(JSON.stringify(report));
    return;
  }
  printDoctorReport(report);
}
```

Keep `src/cli.ts` thin by removing command-file business flow branches, not just moving branches around.

- [ ] **Step 4: Verify CLI behavior stays stable**

Run:

```bash
bun test test/import-service.test.ts test/import-resume.test.ts test/doctor.test.ts test/cli.test.ts
```

Expected:

- import resume semantics remain intact
- doctor JSON/text output remains compatible
- CLI tests still pass with the thinner command files

- [ ] **Step 5: Commit**

```bash
git add src/core/services/import-service.ts src/core/services/doctor-service.ts src/commands/import.ts src/commands/doctor.ts src/cli.ts test/import-service.test.ts test/import-resume.test.ts test/doctor.test.ts test/cli.test.ts
git commit -m "refactor: extract import and doctor services"
```

---

### Task 4: Remove mixed Postgres connection ownership and make engine lifecycle explicit

**Files:**
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/db.ts`
- Modify: `src/core/engine-factory.ts`
- Modify: `src/cli.ts`
- Modify: `test/postgres-engine.test.ts`
- Modify: `test/engine-factory.test.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write failing tests for explicit connection ownership**

Add a regression test that fails if `PostgresEngine` can silently fall back to the module-global singleton:

```ts
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

describe('PostgresEngine connection ownership', () => {
  test('throws when sql is accessed before connect', () => {
    const engine = new PostgresEngine();
    expect(() => engine.sql).toThrow('connect() has not been called');
  });
});
```

- [ ] **Step 2: Remove implicit fallback from `PostgresEngine`**

Refactor toward one answer for connection ownership:

```ts
export class PostgresEngine implements BrainEngine {
  private _sql: ReturnType<typeof postgres> | null = null;

  get sql(): ReturnType<typeof postgres> {
    if (!this._sql) {
      throw new MBrainError('No database connection', 'connect() has not been called', 'Create a connected engine first.');
    }
    return this._sql;
  }

  async connect(config: EngineConfig & { poolSize?: number }): Promise<void> {
    if (this._sql) return;
    this._sql = postgres(config.database_url!, { max: config.poolSize ?? 10, idle_timeout: 20, connect_timeout: 10, types: { bigint: postgres.BigInt } });
    await this._sql`SELECT 1`;
  }
}
```

- [ ] **Step 3: Collapse `src/core/db.ts` into a narrow compatibility shim**

Stop exporting a process-global connection holder as the normal path. Either:

- remove `db.ts` entirely and update imports, or
- keep only transitional helpers that delegate to explicit engine instances

The transitional shape must be honest:

```ts
export function unsupportedGlobalConnectionAccess(): never {
  throw new MBrainError(
    'Global Postgres access removed',
    'Use a connected PostgresEngine instance instead.',
    'Create the engine through createConnectedEngine().',
  );
}
```

- [ ] **Step 4: Verify bootstrap still works through the factory**

Run:

```bash
bun test test/postgres-engine.test.ts test/engine-factory.test.ts test/cli.test.ts
```

Expected:

- tests no longer depend on hidden global Postgres state
- CLI still connects through `createConnectedEngine()`

- [ ] **Step 5: Commit**

```bash
git add src/core/postgres-engine.ts src/core/db.ts src/core/engine-factory.ts src/cli.ts test/postgres-engine.test.ts test/engine-factory.test.ts test/cli.test.ts
git commit -m "refactor: make postgres connection ownership explicit"
```

---

### Task 5: Replace SQLite full-scan vector search with page-centroid candidate narrowing

**Files:**
- Create: `src/core/search/vector-prefilter.ts`
- Modify: `src/core/import-file.ts`
- Modify: `src/core/sqlite-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `src/core/search/hybrid.ts`
- Modify: `test/sqlite-engine.test.ts`
- Modify: `test/local-offline.test.ts`
- Modify: `test/hybrid-search.test.ts`
- Modify: `test/page-embedding.test.ts`

- [ ] **Step 1: Write failing tests for candidate narrowing**

Add a SQLite-focused test that proves `searchVector()` no longer reads every chunk row:

```ts
import { describe, expect, test } from 'bun:test';

describe('SQLite vector prefilter', () => {
  test('scores only chunks from top centroid-ranked pages', async () => {
    const { engine, trace } = await createInstrumentedSqliteEngine();
    const results = await engine.searchVector(new Float32Array([1, 0]), { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(trace.chunkCandidatePageCount).toBeLessThanOrEqual(50);
  });
});
```

Add a page-embedding recalculation test:

```ts
test('page centroid updates after chunk upsert', async () => {
  await engine.upsertChunks('concepts/test', [
    { chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', embedding: new Float32Array([1, 0]) },
    { chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth', embedding: new Float32Array([0, 1]) },
  ]);
  const rows = await engine.getPageEmbeddings();
  expect(Array.from(rows[0]!.embedding!)).toEqual([0.5, 0.5]);
});
```

- [ ] **Step 2: Add page-level vector prefilter helpers**

Create `src/core/search/vector-prefilter.ts`:

```ts
import { cosineSimilarity } from './vector-local.ts';

export function rankPagesByCentroid(
  queryEmbedding: Float32Array,
  pages: Array<{ page_id: number; slug: string; embedding: Float32Array | null }>,
  pageLimit: number,
): number[] {
  return pages
    .flatMap((page) => {
      const score = cosineSimilarity(queryEmbedding, page.embedding);
      return score === null ? [] : [{ page_id: page.page_id, score }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, pageLimit)
    .map((page) => page.page_id);
}
```

- [ ] **Step 3: Recompute page centroids during chunk writes**

After chunk upserts, update page-level embeddings through the shared helper:

```ts
const pageEmbedding = buildPageCentroid(chunks.map((chunk) => chunk.embedding ?? null));
await this.updatePageEmbedding(slug, pageEmbedding);
```

Do this in all engines so the data model does not diverge, but only SQLite/PGLite need the prefilter path in this phase.

- [ ] **Step 4: Rework SQLite `searchVector()` into a two-stage query**

Replace the current "select every embedded chunk" path with:

1. fetch page-level embeddings
2. score all pages in-process
3. keep the top page ids
4. fetch embedded chunks only for those pages
5. run cosine scoring on that reduced set

The SQLite path should look like:

```ts
const topPageIds = rankPagesByCentroid(
  embedding,
  await this.getPageEmbeddings(opts?.type),
  opts?.limit ? Math.max(opts.limit * 5, 50) : 50,
);

if (topPageIds.length === 0) return [];

const rows = this.database.query(`
  SELECT p.id AS page_id, p.slug, p.title, p.type, cc.chunk_text, cc.chunk_source, cc.embedding
  FROM content_chunks cc
  JOIN pages p ON p.id = cc.page_id
  WHERE cc.embedding IS NOT NULL
    AND p.id IN (${topPageIds.map(() => '?').join(', ')})
`).all(...topPageIds) as Record<string, unknown>[];

return searchLocalVectors(embedding, rows.map(rowToLocalVectorCandidate), limit);
```

- [ ] **Step 5: Verify functional and benchmark behavior**

Run:

```bash
bun test test/sqlite-engine.test.ts test/local-offline.test.ts test/hybrid-search.test.ts test/page-embedding.test.ts
bun run bench:search --query "paperpilot" --iterations 20
```

Expected:

- tests pass
- the benchmark still returns valid search results
- measured local semantic search latency improves relative to the baseline captured in Task 1

- [ ] **Step 6: Commit**

```bash
git add src/core/search/vector-prefilter.ts src/core/import-file.ts src/core/sqlite-engine.ts src/core/pglite-engine.ts src/core/search/hybrid.ts test/sqlite-engine.test.ts test/local-offline.test.ts test/hybrid-search.test.ts test/page-embedding.test.ts
git commit -m "perf: narrow local vector search with page centroids"
```

---

### Task 6: Improve local import throughput with staged concurrency instead of multi-writer assumptions

**Files:**
- Modify: `src/core/services/import-service.ts`
- Modify: `src/core/engine-capabilities.ts`
- Modify: `src/commands/import.ts`
- Modify: `test/import-service.test.ts`
- Modify: `test/import-resume.test.ts`
- Modify: `test/local-offline.test.ts`
- Modify: `scripts/bench/import.ts`

- [ ] **Step 1: Write failing tests for staged local concurrency**

Add a service-level test that exercises parse concurrency while keeping writes deterministic:

```ts
import { describe, expect, test } from 'bun:test';

describe('local import staged concurrency', () => {
  test('parses multiple files concurrently but commits in stable order', async () => {
    const summary = await runImportService(engine, {
      rootDir: fixtureDir,
      noEmbed: true,
      workers: 4,
      fresh: true,
      json: false,
    });

    expect(summary.imported).toBe(4);
    expect(summary.writeOrder).toEqual(summary.writeOrder.slice().sort());
  });
});
```

- [ ] **Step 2: Split import into explicit stages**

Refactor the service into:

- file discovery
- parse/chunk preparation
- optional embedding preparation
- single-writer commit
- checkpoint update

The queue shape should be explicit:

```ts
interface PreparedImport {
  filePath: string;
  relativePath: string;
  slug: string;
  content: string;
}
```

Use worker fanout only for prepare stages:

```ts
const prepared = await mapWithConcurrency(files, actualWorkers, async (filePath) => {
  return prepareImport(filePath, rootDir);
});

for (const item of prepared.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
  await commitPreparedImport(engine, item, { noEmbed });
}
```

- [ ] **Step 3: Keep capability checks honest**

Use `parallelWorkers` only for true multi-connection write fanout. Add a separate import-stage capability:

```ts
export interface EngineCapabilities {
  rawPostgresAccess: boolean;
  parallelWorkers: boolean;
  stagedImportConcurrency: boolean;
  localVectorPrefilter: 'none' | 'page-centroid';
}
```

Set:

- Postgres: `parallelWorkers: true`, `stagedImportConcurrency: true`
- SQLite/PGLite: `parallelWorkers: false`, `stagedImportConcurrency: true`

- [ ] **Step 4: Verify throughput and correctness**

Run:

```bash
bun test test/import-service.test.ts test/import-resume.test.ts test/local-offline.test.ts
bun run bench:import --repo test/e2e/fixtures
```

Expected:

- checkpoint behavior remains correct
- local engines now use staged concurrency
- benchmark output shows improved local import throughput against the Task 1 baseline

- [ ] **Step 5: Commit**

```bash
git add src/core/services/import-service.ts src/core/engine-capabilities.ts src/commands/import.ts test/import-service.test.ts test/import-resume.test.ts test/local-offline.test.ts scripts/bench/import.ts
git commit -m "perf: add staged local import concurrency"
```

---

### Task 7: Finish the contract cleanup pass for high-value commands

**Files:**
- Modify: `src/core/operations.ts`
- Modify: `src/cli.ts`
- Modify: `src/commands/sync.ts`
- Modify: `src/commands/embed.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/local-offline.test.ts`

- [ ] **Step 1: Write failing CLI/operation consistency tests**

Add tests that force `cli.ts` and `operations.ts` to stop drifting:

```ts
import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';

describe('high-value command registration', () => {
  test('sync remains operation-backed', () => {
    expect(operations.find((op) => op.name === 'sync_brain')).toBeDefined();
  });

  test('cli help does not hide service-backed commands', () => {
    const help = printHelpForTests();
    expect(help).toContain('doctor');
    expect(help).toContain('embed');
    expect(help).toContain('import');
  });
});
```

- [ ] **Step 2: Move shared validation and output shaping closer to the contract layer**

Refactor `operations.ts` so service-backed commands that remain CLI-only still reuse common validation/output helpers:

```ts
export function assertRequiredFlag(value: string | undefined, flag: string): string {
  if (!value) throw new OperationError('invalid_params', `Missing required flag: ${flag}`);
  return value;
}
```

Keep `sync` operation-backed and make `embed` / `doctor` use the same argument-normalization helpers even if they remain CLI-only in this phase.

- [ ] **Step 3: Shrink `CLI_ONLY` to the truly shell-specific set**

After the service extraction work, keep `CLI_ONLY` limited to commands that are genuinely process-bound, such as:

```ts
const CLI_ONLY = new Set([
  'serve',
  'setup-agent',
  'upgrade',
  'post-upgrade',
  'check-update',
]);
```

Any remaining command in `CLI_ONLY` must have a code comment explaining why it is intentionally excluded from the shared contract.

- [ ] **Step 4: Verify contract and CLI behavior**

Run:

```bash
bun test test/cli.test.ts test/local-offline.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/core/operations.ts src/cli.ts src/commands/sync.ts src/commands/embed.ts test/cli.test.ts test/local-offline.test.ts
git commit -m "refactor: reduce command contract drift"
```

---

## Self-Review

### Spec coverage

The tasks cover each requirement from `docs/superpowers/specs/2026-04-18-mbrain-inefficiency-analysis.md`:

- engine duplication: Task 2
- command/service layering: Tasks 3 and 7
- Postgres connection ownership: Task 4
- SQLite semantic search bottleneck: Task 5
- local import throughput: Task 6
- documentation drift: Task 1
- benchmark baselines: Task 1 and benchmark verification in Tasks 5 and 6

### Placeholder scan

Checked for:

- unresolved marker words
- deferred implementation language
- cross-task shorthand that hides required details

None are used as unresolved instructions in the plan body.

### Type consistency

Key shared names are consistent across tasks:

- `EngineCapabilities`
- `runImportService`
- `buildDoctorReport`
- `buildPageCentroid`
- `rankPagesByCentroid`

The plan keeps capability and service names stable so later tasks can refer back to them without ambiguity.
