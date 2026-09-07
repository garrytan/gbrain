/** Temporary remote code-read suspension: no raw/cached storage access; trusted local controls remain available. */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// ─── ctx factory (copied from test/operations-source-isolation-matrix.test.ts) ───

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    dryRun: false,
    remote: true,
    transport: 'stdio',
    ...overrides,
  } as OperationContext;
}
const localAlpha = () => ctxOf({ remote: false, sourceId: 'srcalpha' });

// ─── Fixture seeding (approach reused from test/e2e/code-intel-mcp-ops-pglite.test.ts) ───

async function registerSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $1, $2, '{}'::jsonb, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id, `/fake/${id}`],
  );
}

async function insertCodePage(sourceId: string, slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ($1, $2, $3, 'code', 'code', '', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    [slug, sourceId, slug],
  );
  return rows[0]!.id;
}

async function insertChunk(pageId: number, chunkIndex: number, symbolName: string, symbolType: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name, symbol_name_qualified, symbol_type)
     VALUES ($1, $2, $3, 'compiled_truth', 'typescript', $4, $4, $5)
     RETURNING id`,
    [pageId, chunkIndex, `// ${symbolName} body`, symbolName, symbolType],
  );
  return rows[0]!.id;
}

async function insertUnresolvedEdge(fromChunkId: number, fromSymbol: string, toSymbol: string, sourceId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata)
     VALUES ($1, $2, $3, 'calls', $4, '{}'::jsonb)`,
    [fromChunkId, fromSymbol, toSymbol, sourceId],
  );
}

/**
 * Two-source code graph:
 *   srcalpha: alphaCallerFn  → alphaTargetFn
 *             sharedCallerFn → alphaTargetFn
 *   srcbeta:  betaCallerFn   → betaSecretFn
 *             sharedCallerFn → betaSecretFn   (same FROM symbol as alpha's)
 *             betaCallerFn   → alphaTargetFn  (cross-source trap: same TO
 *                              symbol as alpha's target, edge owned by beta —
 *                              an alpha-scoped walk must never surface it)
 */
async function seedTwoSourceCodeGraph(): Promise<void> {
  await registerSource('srcalpha');
  await registerSource('srcbeta');

  const alphaLib = await insertCodePage('srcalpha', 'src/alpha-lib.ts');
  const alphaCaller = await insertCodePage('srcalpha', 'src/alpha-caller.ts');
  const alphaShared = await insertCodePage('srcalpha', 'src/shared-caller.ts');
  await insertChunk(alphaLib, 0, 'alphaTargetFn', 'function');
  const alphaCallerChunk = await insertChunk(alphaCaller, 0, 'alphaCallerFn', 'function');
  const alphaSharedChunk = await insertChunk(alphaShared, 0, 'sharedCallerFn', 'function');
  await insertUnresolvedEdge(alphaCallerChunk, 'alphaCallerFn', 'alphaTargetFn', 'srcalpha');
  await insertUnresolvedEdge(alphaSharedChunk, 'sharedCallerFn', 'alphaTargetFn', 'srcalpha');

  const betaLib = await insertCodePage('srcbeta', 'src/beta-lib.ts');
  const betaCaller = await insertCodePage('srcbeta', 'src/beta-caller.ts');
  const betaShared = await insertCodePage('srcbeta', 'src/beta-shared-caller.ts');
  await insertChunk(betaLib, 0, 'betaSecretFn', 'function');
  const betaCallerChunk = await insertChunk(betaCaller, 0, 'betaCallerFn', 'function');
  const betaSharedChunk = await insertChunk(betaShared, 0, 'sharedCallerFn', 'function');
  await insertUnresolvedEdge(betaCallerChunk, 'betaCallerFn', 'betaSecretFn', 'srcbeta');
  await insertUnresolvedEdge(betaSharedChunk, 'sharedCallerFn', 'betaSecretFn', 'srcbeta');
  await insertUnresolvedEdge(betaCallerChunk, 'betaCallerFn', 'alphaTargetFn', 'srcbeta');
}

// Trusted local reads retain their historical source behavior.


const readOps = ['code_callers', 'code_callees', 'code_def', 'code_refs', 'code_blast', 'code_flow'] as const;
const parameters = { symbol: 'betaOnlyFunction', entry_point: 'betaOnlyFunction', exact: true };

describe('code reads require trusted local context while remote authorization is suspended', () => {
  for (const name of readOps) {
    test(`${name}: remote and omitted trust fail before accessing storage for every source grant`, async () => {
      let accesses = 0;
      const inaccessibleEngine = new Proxy({}, { get() { accesses++; throw new Error('storage must not be accessed'); } });
      for (const remote of [true, undefined]) {
        for (const scope of [{ sourceId: 'srcalpha' }, { auth: { allowedSources: ['srcalpha', 'srcbeta'] } }, { auth: { allowedSources: [] } }, {}]) {
          const ctx = ctxOf({ ...scope, remote, engine: inaccessibleEngine } as any);
          let caught: unknown;
          try { await operationsByName[name].handler(ctx, parameters); } catch (error) { caught = error; }
          expect(caught).toBeInstanceOf(OperationError);
          expect((caught as OperationError).code).toBe('permission_denied');
          expect((caught as Error).message).toContain('temporarily unavailable');
        }
      }
      expect(accesses).toBe(0);
      expect(operationsByName[name].description).toContain('agent-facing code reads are suspended');
    });
  }

  test('trusted local definitions and references retain the brain-wide public contract', async () => {
    await seedTwoSourceCodeGraph();
    const ctx = localAlpha();
    const defs = await operationsByName.code_def.handler(ctx, { symbol: 'betaSecretFn' }) as { count: number; defs: unknown[] };
    const refs = await operationsByName.code_refs.handler(ctx, { symbol: 'betaSecretFn' }) as { count: number; refs: unknown[] };
    expect(defs.count).toBeGreaterThan(0);
    expect(refs.count).toBeGreaterThan(0);
    expect(JSON.stringify(defs.defs)).toContain('beta');
    expect(JSON.stringify(refs.refs)).toContain('beta');
  });
});
