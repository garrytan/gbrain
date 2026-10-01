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

async function insertCodePage(sourceId: string, slug: string, opts: { private?: boolean } = {}): Promise<number> {
  const frontmatter = opts.private ? '{"visibility":"private"}' : '{}';
  // chunker_version 999 marks the page as already past SAFE_FENCE_CHUNKER_VERSION
  // (test/code-read-currency.test.ts's convention) — without it every remote read
  // (requireSafeChunks=true) excludes the fixture entirely, which silently turns
  // every "the remote caller sees X" assertion below into a vacuous pass on [].
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, chunker_version, updated_at, created_at)
     VALUES ($1, $2, $3, 'code', 'code', '', $4::jsonb, 999, NOW(), NOW())
     RETURNING id`,
    [slug, sourceId, slug, frontmatter],
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
  await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision');
}

// Trusted local reads retain their historical source behavior.


// The four "graph" ops share routeCodeIntelScope/resolveCodeIntelScope and the new
// redaction-policy wiring (edge queries + traversal cache). code_def/code_refs were
// already remote-safe via readPolicyOpts before this change and are untouched here —
// their own coverage lives in the "trusted local definitions and references" test below
// plus pre-existing upstream behavior this suite doesn't need to re-prove.
const graphOps = ['code_callers', 'code_callees', 'code_blast', 'code_flow'] as const;
// Direction matters: code_callers/code_blast walk CALLERS of their `symbol`
// (alphaTargetFn has two: alphaCallerFn, sharedCallerFn); code_callees/code_flow
// walk CALLEES of their `symbol`/`entry_point` (alphaCallerFn calls alphaTargetFn).
// A shared params object with the wrong direction's symbol returns a legitimate
// empty result (a leaf has no callees) that would make a "succeeds" assertion
// pass vacuously — hence per-op params instead of one shared literal.
const graphParams = { symbol: 'alphaTargetFn', entry_point: 'alphaTargetFn', exact: true };
function paramsFor(name: (typeof graphOps)[number]): Record<string, unknown> {
  return name === 'code_callees' || name === 'code_flow'
    ? { symbol: 'alphaCallerFn', entry_point: 'alphaCallerFn', exact: true }
    : graphParams;
}
function resultNodeCount(name: (typeof graphOps)[number], result: Record<string, unknown>): number {
  if (name === 'code_callers') return (result.callers as unknown[]).length;
  if (name === 'code_callees') return (result.callees as unknown[]).length;
  const groups = (result.depth_groups as { nodes: unknown[] }[] | undefined) ?? [];
  return groups.reduce((n, g) => n + g.nodes.length, 0);
}

describe('code reads are remote-eligible: scoped and redacted, never brain-wide by default', () => {
  for (const name of graphOps) {
    test(`${name}: a zero-grant or empty-allowlist remote caller is refused before accessing storage`, async () => {
      let accesses = 0;
      const inaccessibleEngine = new Proxy({}, { get() { accesses++; throw new Error('storage must not be accessed'); } });
      for (const scope of [{ auth: { allowedSources: [] } }, {}]) {
        const ctx = ctxOf({ ...scope, remote: true, engine: inaccessibleEngine } as any);
        let caught: unknown;
        try { await operationsByName[name].handler(ctx, graphParams); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(OperationError);
        expect((caught as OperationError).code).toBe('permission_denied');
      }
      expect(accesses).toBe(0);
    });
  }

  for (const name of graphOps) {
    test(`${name}: an in-grant remote caller succeeds, finds real data, and sees only their own source`, async () => {
      await seedTwoSourceCodeGraph();
      const ctx = ctxOf({ remote: true, sourceId: 'srcalpha' });
      const result = (await operationsByName[name].handler(ctx, paramsFor(name))) as Record<string, unknown>;
      expect(resultNodeCount(name, result)).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain('beta');
    });
  }

  for (const name of graphOps) {
    test(`${name}: an out-of-grant source_id is refused; all_sources clamps to grant (still finds alpha's data) instead of widening`, async () => {
      await seedTwoSourceCodeGraph();
      const scopedCtx = ctxOf({ remote: true, sourceId: 'srcalpha' });
      const params = paramsFor(name);
      let caught: unknown;
      try { await operationsByName[name].handler(scopedCtx, { ...params, source_id: 'srcbeta' }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OperationError);
      expect((caught as OperationError).code).toBe('permission_denied');
      const clamped = (await operationsByName[name].handler(scopedCtx, { ...params, all_sources: true })) as Record<string, unknown>;
      expect(resultNodeCount(name, clamped)).toBeGreaterThan(0);
      expect(JSON.stringify(clamped)).not.toContain('beta');
    });
  }

  test('cross-source leak: a remote caller scoped to srcalpha never sees srcbeta edges, in either direction', async () => {
    await seedTwoSourceCodeGraph();
    const ctx = ctxOf({ remote: true, sourceId: 'srcalpha' });
    // betaCallerFn → alphaTargetFn is the cross-source trap: same TO symbol as
    // alpha's own target, but the edge is owned by srcbeta.
    const callers = (await operationsByName.code_callers.handler(ctx, { symbol: 'alphaTargetFn' })) as { callers: unknown[] };
    expect(callers.callers.length).toBeGreaterThan(0);
    expect(JSON.stringify(callers.callers)).not.toContain('beta');
    // sharedCallerFn exists (as a FROM symbol) in both sources, calling a
    // different TO symbol in each — alpha scope must only surface alpha's edge.
    const callees = (await operationsByName.code_callees.handler(ctx, { symbol: 'sharedCallerFn' })) as { callees: unknown[] };
    expect(callees.callees.length).toBeGreaterThan(0);
    expect(JSON.stringify(callees.callees)).not.toContain('beta');
  });

  test('private-page parity: code_callers/callees/blast/flow exclude a private page for a remote caller, matching code_def/code_refs', async () => {
    await seedTwoSourceCodeGraph();
    const privatePage = await insertCodePage('srcalpha', 'src/alpha-private-caller.ts', { private: true });
    const privateChunk = await insertChunk(privatePage, 0, 'privateCallerFn', 'function');
    await insertUnresolvedEdge(privateChunk, 'privateCallerFn', 'alphaTargetFn', 'srcalpha');
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision');

    const local = localAlpha(); // remote: false — sees everything, including private.
    const localCallers = (await operationsByName.code_callers.handler(local, { symbol: 'alphaTargetFn' })) as { callers: unknown[] };
    expect(JSON.stringify(localCallers.callers)).toContain('privateCallerFn');

    const remote = ctxOf({ remote: true, sourceId: 'srcalpha' });
    const remoteCallers = (await operationsByName.code_callers.handler(remote, { symbol: 'alphaTargetFn' })) as { callers: unknown[] };
    // Non-private callers (alphaCallerFn, sharedCallerFn) still surface — only
    // the private one is excluded, not everything.
    expect(remoteCallers.callers.length).toBeGreaterThan(0);
    expect(JSON.stringify(remoteCallers.callers)).not.toContain('privateCallerFn');
    const remoteBlast = (await operationsByName.code_blast.handler(remote, { symbol: 'alphaTargetFn' })) as { depth_groups?: { nodes: unknown[] }[] };
    const remoteBlastNodes = (remoteBlast.depth_groups ?? []).flatMap(g => g.nodes);
    expect(remoteBlastNodes.length).toBeGreaterThan(0);
    expect(JSON.stringify(remoteBlastNodes)).not.toContain('privateCallerFn');
  });

  test('trusted local (ctx.remote === false) behavior is unchanged: unscoped and --all-sources still span the whole brain', async () => {
    await seedTwoSourceCodeGraph();
    for (const name of graphOps) {
      const ctx = ctxOf({ remote: false, sourceId: 'srcalpha' });
      const scoped = (await operationsByName[name].handler(ctx, { ...paramsFor(name), all_sources: true })) as Record<string, unknown>;
      // Trusted local + all_sources spans every source — must find real data,
      // and (unlike the remote-scoped tests above) beta is allowed to appear.
      expect(resultNodeCount(name, scoped)).toBeGreaterThan(0);
    }
    // code_callers has the clean cross-source fixture: confirm all_sources
    // actually reaches srcbeta for a trusted caller, not just "some result".
    const allSourcesCallers = (await operationsByName.code_callers.handler(
      ctxOf({ remote: false, sourceId: 'srcalpha' }),
      { symbol: 'alphaTargetFn', all_sources: true },
    )) as { callers: unknown[] };
    expect(JSON.stringify(allSourcesCallers.callers)).toContain('beta');
  });

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

  test('trusted local code_blast and code_flow carry the readiness envelope on a miss', async () => {
    // A bare {result:'not_found'} conflates "graph not built" with "zero
    // callers". The graph IS built for srcalpha (symbol-bearing chunks exist),
    // so a miss on a symbol that lives only in srcbeta must read as a trusted
    // miss: status 'ready', ready true — the same contract the four siblings
    // (code_callers/callees/def/refs) already carry.
    await seedTwoSourceCodeGraph();
    const ctx = localAlpha();
    const blast = await operationsByName.code_blast.handler(ctx, { symbol: 'betaSecretFn' }) as { result: string; status?: string; ready?: boolean };
    const flow = await operationsByName.code_flow.handler(ctx, { entry_point: 'betaSecretFn' }) as { result: string; status?: string; ready?: boolean };
    expect(blast.result).toBe('not_found');
    expect(blast.status).toBe('ready');
    expect(blast.ready).toBe(true);
    expect(flow.result).toBe('not_found');
    expect(flow.status).toBe('ready');
    expect(flow.ready).toBe(true);
  });
});

// ─── attachWalkReadiness branches (src/core/ops/code-intel.ts → code-graph-readiness.ts) ───

type WalkEnvelope = {
  result: string;
  status?: string;
  ready?: boolean;
  scoped_source_id?: string;
  depth_groups?: { nodes: unknown[] }[];
};

describe('code_blast / code_flow readiness envelope distinguishes unbuilt, out-of-scope, and ready graphs', () => {
  test('unseeded brain (no code anywhere) → status not_built, ready false, no scoped_source_id', async () => {
    // Nothing seeded: beforeEach left every table empty. A miss here is NOT
    // a trusted miss — the graph was never built — so the envelope must say
    // so instead of the bare {result:'not_found'} an agent reads as "no callers".
    const ctx = localAlpha();
    const blast = await operationsByName.code_blast.handler(ctx, { symbol: 'alphaTargetFn' }) as WalkEnvelope;
    const flow = await operationsByName.code_flow.handler(ctx, { entry_point: 'alphaCallerFn' }) as WalkEnvelope;
    for (const walk of [blast, flow]) {
      expect(walk.result).toBe('not_found');
      expect(walk.status).toBe('not_built');
      expect(walk.ready).toBe(false);
      expect(walk.scoped_source_id).toBeUndefined();
    }
  });

  test('ctx scoped to a code-less source while code exists elsewhere → status out_of_scope naming the scoped source', async () => {
    // The graph IS built (srcalpha + srcbeta hold code) but the caller's
    // resolved scope is srcgamma, which holds none. That is a scope/grant
    // problem, not an indexing one: the envelope must carry `scoped_source_id`
    // so the hint can name the scope instead of misdirecting to `gbrain sync`.
    await seedTwoSourceCodeGraph();
    await registerSource('srcgamma');
    const ctx = ctxOf({ remote: false, sourceId: 'srcgamma' });
    const blast = await operationsByName.code_blast.handler(ctx, { symbol: 'alphaTargetFn' }) as WalkEnvelope;
    const flow = await operationsByName.code_flow.handler(ctx, { entry_point: 'alphaCallerFn' }) as WalkEnvelope;
    for (const walk of [blast, flow]) {
      expect(walk.result).toBe('not_found');
      expect(walk.status).toBe('out_of_scope');
      expect(walk.ready).toBe(false);
      expect(walk.scoped_source_id).toBe('srcgamma');
    }
  });

  test('a walk that returns nodes → status ready, ready true, no scoped_source_id', async () => {
    await seedTwoSourceCodeGraph();
    const ctx = localAlpha();
    // callers of alphaTargetFn in srcalpha: alphaCallerFn + sharedCallerFn
    const blast = await operationsByName.code_blast.handler(ctx, { symbol: 'alphaTargetFn' }) as WalkEnvelope;
    // callees of alphaCallerFn in srcalpha: alphaTargetFn
    const flow = await operationsByName.code_flow.handler(ctx, { entry_point: 'alphaCallerFn' }) as WalkEnvelope;
    for (const walk of [blast, flow]) {
      expect(walk.result).toBe('ok');
      expect((walk.depth_groups ?? []).reduce((n, g) => n + g.nodes.length, 0)).toBeGreaterThan(0);
      expect(walk.status).toBe('ready');
      expect(walk.ready).toBe(true);
      expect(walk.scoped_source_id).toBeUndefined();
    }
  });
});
