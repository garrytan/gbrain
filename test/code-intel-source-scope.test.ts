/**
 * A13 — code-intel op scoping (test-plan item A13).
 *
 * Pins the per-op source-scope CONTRACT of the code-intel cluster
 * (src/core/ops/code-intel.ts) so none of it stays ambiguous:
 *
 *   - code_def / code_refs — BRAIN-WIDE BY DESIGN (documented decision:
 *     the brain-wide comments in code_def's and code_refs' handlers in
 *     src/core/ops/code-intel.ts say "brain-wide (not source-scoped)", and
 *     the underlying SQL in src/commands/code-def.ts:findCodeDef /
 *     src/commands/code-refs.ts:findCodeRefs carries NO source filter). A
 *     remote caller scoped to srcalpha (scalar or federated grant) CAN see
 *     srcbeta definitions and references. Rows do NOT project source_id
 *     (slug is the only source signal) — pinned below so a future scoping
 *     change trips this suite deliberately rather than drifting silently.
 *
 *   - code_blast / code_flow — fenced through resolveCodeIntelScope
 *     (src/core/ops/context.ts): remote + no source in scope → the
 *     resolver's permission_denied throw; remote + multi-source federated
 *     grant → its invalid_params "single source" throw; scoped →
 *     single-source traversal (disambiguation AND edge walk both filter by
 *     that source).
 *
 *   - code_callees — mirrors code_callers' contract (already pinned for
 *     LOCAL ctx by the code_callers assertions in
 *     test/e2e/code-intel-mcp-ops-pglite.test.ts; those
 *     assertions are NOT duplicated here). This suite adds the REMOTE side:
 *     scalar/federated alpha scope isolates beta edges, and all_sources=true
 *     from a remote caller collapses to the caller's grant instead of
 *     widening brain-wide.
 *
 * Fixture: two sources (srcalpha / srcbeta) with code chunks + symbol edges;
 * every beta-side identifier carries the lowercase marker 'beta' and no
 * alpha-side identifier does, so a whole-JSON scan for 'beta' is a complete
 * leak probe. Anti-vacuity: every isolation assertion is paired with a
 * control call that CAN see the beta marker, so an inadequate fixture fails
 * loudly instead of passing vacuously.
 *
 * Registered as the owner of code_def/code_refs/code_blast/code_flow in
 * test/operations-source-isolation-matrix.test.ts (mode: 'skip' rows).
 */
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
const remoteAlpha = () => ctxOf({ sourceId: 'srcalpha' });
const remoteBeta = () => ctxOf({ sourceId: 'srcbeta' });
const remoteFederatedAlpha = () => ctxOf({ auth: { allowedSources: ['srcalpha'] } as any });
const remoteNoScope = () => ctxOf({});
const localAlpha = () => ctxOf({ remote: false, sourceId: 'srcalpha' });

/** Whole-payload leak probe: every beta-side identifier contains 'beta'. */
function containsBeta(payload: unknown): boolean {
  return (JSON.stringify(payload) ?? '').includes('beta');
}

async function expectOpError(promise: Promise<unknown>, code: string, msgFragment: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(OperationError);
  expect((caught as OperationError).code).toBe(code as OperationError['code']);
  expect((caught as OperationError).message).toContain(msgFragment);
}

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

// ─── (1) code_def / code_refs: brain-wide by design — pinned explicitly ────

describe('A13 — code_def / code_refs are brain-wide by design (documented decision)', () => {
  test('code_def: alpha-scoped remote caller sees a beta-only definition (brain-wide handler)', async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_def!;
    // DOCUMENTED DECISION: code_def does not route through ctx scope — the
    // findCodeDef SQL (src/commands/code-def.ts) has no source filter and the
    // brain-wide comment in code_def's handler (src/core/ops/code-intel.ts)
    // names it brain-wide.
    const result = (await op.handler(remoteAlpha(), { symbol: 'betaSecretFn' })) as {
      count: number;
      defs: Array<Record<string, unknown>>;
    };
    expect(result.count).toBe(1);
    expect(result.defs[0]!.slug).toBe('src/beta-lib.ts');
    // Rows do not project source_id; the slug is the only source signal.
    // Pinned so a future projection/scoping change fails here consciously.
    expect('source_id' in result.defs[0]!).toBe(false);
    // Sanity: the same brain-wide read also sees the caller's own source.
    const own = (await op.handler(remoteAlpha(), { symbol: 'alphaTargetFn' })) as { count: number };
    expect(own.count).toBe(1);
  });

  test('code_def: a federated grant does not scope it either (brain-wide for federated remote callers)', async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_def!;
    const result = (await op.handler(remoteFederatedAlpha(), { symbol: 'betaSecretFn' })) as {
      count: number;
      defs: Array<{ slug: string }>;
    };
    expect(result.count).toBe(1);
    expect(result.defs[0]!.slug).toBe('src/beta-lib.ts');
  });

  test('code_refs: alpha-scoped remote caller sees beta chunk text (brain-wide handler)', async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_refs!;
    // DOCUMENTED DECISION: findCodeRefs (src/commands/code-refs.ts) is an
    // unscoped ILIKE scan over content_chunks; the brain-wide comment in
    // code_refs' handler (src/core/ops/code-intel.ts) names it brain-wide.
    const result = (await op.handler(remoteAlpha(), { symbol: 'betaSecretFn' })) as {
      count: number;
      refs: Array<Record<string, unknown>>;
    };
    expect(result.count).toBe(1);
    expect(result.refs[0]!.slug).toBe('src/beta-lib.ts');
    expect(String(result.refs[0]!.snippet)).toContain('betaSecretFn');
    // No source_id projection on ref rows either — pinned (see code_def above).
    expect('source_id' in result.refs[0]!).toBe(false);
  });
});

// ─── (2) code_blast / code_flow: the resolveCodeIntelScope fence ──────────

describe('A13 — code_blast / code_flow resolveCodeIntelScope fence', () => {
  test('code_blast: remote ctx with NO scope is refused with permission_denied (resolveCodeIntelScope no-scope throw)', async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_blast!;
    await expectOpError(
      op.handler(remoteNoScope(), { symbol: 'alphaTargetFn' }),
      'permission_denied',
      'No source in scope',
    );
  });

  test('code_flow: remote ctx with NO scope is refused with permission_denied (resolveCodeIntelScope no-scope throw)', async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_flow!;
    await expectOpError(
      op.handler(remoteNoScope(), { entry_point: 'sharedCallerFn' }),
      'permission_denied',
      'No source in scope',
    );
  });

  test("code_blast: remote multi-source federated grant is refused with invalid_params (resolveCodeIntelScope's multi-source throw)", async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_blast!;
    // Traversal is single-source by design; a two-source grant must name one.
    // (Shared fence — code_flow routes through the identical resolver branch.)
    await expectOpError(
      op.handler(ctxOf({ auth: { allowedSources: ['srcalpha', 'srcbeta'] } as any }), { symbol: 'alphaTargetFn' }),
      'invalid_params',
      'single source',
    );
  });

  test('code_blast: alpha scope walks alpha edges only — the beta-owned edge into the same target stays invisible', async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_blast!;
    const result = (await op.handler(remoteAlpha(), { symbol: 'alphaTargetFn' })) as {
      result: string;
      depth_groups: Array<{ depth: number; nodes: Array<{ symbol: string }> }>;
    };
    expect(result.result).toBe('ok');
    const symbols = result.depth_groups.flatMap((g) => g.nodes.map((n) => n.symbol));
    expect(symbols).toContain('alphaCallerFn');
    expect(symbols).toContain('sharedCallerFn');
    // srcbeta's betaCallerFn → alphaTargetFn edge must not surface anywhere.
    expect(containsBeta(result)).toBe(false);
    // Anti-vacuity control: a beta-scoped caller CAN see that beta edge
    // (exact=true skips bare-name disambiguation, which is source-scoped and
    // would otherwise not_found a symbol whose defining chunk lives in alpha).
    const control = (await op.handler(remoteBeta(), { symbol: 'alphaTargetFn', exact: true })) as {
      result: string;
      depth_groups: Array<{ nodes: Array<{ symbol: string }> }>;
    };
    expect(control.result).toBe('ok');
    expect(control.depth_groups.flatMap((g) => g.nodes.map((n) => n.symbol))).toContain('betaCallerFn');
  });

  test('code_blast: a beta-only symbol is not_found under alpha scope (source-scoped disambiguation)', async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_blast!;
    const scoped = (await op.handler(remoteAlpha(), { symbol: 'betaSecretFn' })) as {
      result: string;
      did_you_mean: unknown[];
    };
    expect(scoped.result).toBe('not_found');
    // The did_you_mean suggestions are source-scoped too — no beta leak.
    expect(containsBeta(scoped.did_you_mean)).toBe(false);
    // Anti-vacuity control: beta scope resolves and walks the same symbol.
    const control = (await op.handler(remoteBeta(), { symbol: 'betaSecretFn' })) as {
      result: string;
      depth_groups: Array<{ nodes: Array<{ symbol: string }> }>;
    };
    expect(control.result).toBe('ok');
    expect(control.depth_groups.flatMap((g) => g.nodes.map((n) => n.symbol))).toContain('betaCallerFn');
  });

  test('code_flow: alpha scope traces alpha callees only; beta scope sees the beta branch (anti-vacuity)', async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_flow!;
    // sharedCallerFn exists in BOTH sources with different callees — the
    // sharpest probe: same entry point, scope decides what is disclosed.
    const alpha = (await op.handler(remoteAlpha(), { entry_point: 'sharedCallerFn' })) as {
      result: string;
      depth_groups: Array<{ nodes: Array<{ symbol: string }> }>;
    };
    expect(alpha.result).toBe('ok');
    const alphaSymbols = alpha.depth_groups.flatMap((g) => g.nodes.map((n) => n.symbol));
    expect(alphaSymbols).toContain('alphaTargetFn');
    expect(containsBeta(alpha)).toBe(false);
    const beta = (await op.handler(remoteBeta(), { entry_point: 'sharedCallerFn' })) as {
      result: string;
      depth_groups: Array<{ nodes: Array<{ symbol: string }> }>;
    };
    expect(beta.result).toBe('ok');
    expect(beta.depth_groups.flatMap((g) => g.nodes.map((n) => n.symbol))).toContain('betaSecretFn');
  });
});

// ─── (3) code_callees: isolation mirror of code_callers' pinned contract ──

describe('A13 — code_callees remote isolation (mirrors code_callers, pinned in code-intel-mcp-ops e2e)', () => {
  test('remote scalar alpha scope: beta callee edges invisible; local all_sources control sees them', async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_callees!;
    const scoped = (await op.handler(remoteAlpha(), { symbol: 'sharedCallerFn' })) as {
      count: number;
      callees: Array<{ to_symbol_qualified: string; source_id: string | null }>;
    };
    expect(scoped.count).toBe(1);
    expect(scoped.callees[0]!.to_symbol_qualified).toBe('alphaTargetFn');
    expect(containsBeta(scoped)).toBe(false);
    // Anti-vacuity control: trusted local caller spanning all sources sees
    // srcbeta's sharedCallerFn → betaSecretFn edge.
    const control = (await op.handler(localAlpha(), { symbol: 'sharedCallerFn', all_sources: true })) as {
      callees: Array<{ to_symbol_qualified: string }>;
    };
    expect(control.callees.map((c) => c.to_symbol_qualified)).toContain('betaSecretFn');
  });

  test('remote federated grant [srcalpha]: same isolation as the scalar scope', async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_callees!;
    const scoped = (await op.handler(remoteFederatedAlpha(), { symbol: 'sharedCallerFn' })) as {
      count: number;
      callees: Array<{ to_symbol_qualified: string }>;
    };
    expect(scoped.count).toBe(1);
    expect(scoped.callees[0]!.to_symbol_qualified).toBe('alphaTargetFn');
    expect(containsBeta(scoped)).toBe(false);
  });

  test('remote all_sources=true collapses to the grant — never widens brain-wide', async () => {
    await seedTwoSourceCodeGraph();
    const op = operationsByName.code_callees!;
    const remote = (await op.handler(remoteAlpha(), { symbol: 'sharedCallerFn', all_sources: true })) as {
      callees: Array<{ to_symbol_qualified: string }>;
    };
    expect(remote.callees.map((c) => c.to_symbol_qualified)).toContain('alphaTargetFn');
    expect(containsBeta(remote)).toBe(false);
    // Anti-vacuity control: the SAME args from a trusted local caller DO span
    // sources — proving the collapse above is the trust fence, not the fixture.
    const control = (await op.handler(localAlpha(), { symbol: 'sharedCallerFn', all_sources: true })) as {
      callees: Array<{ to_symbol_qualified: string }>;
    };
    expect(control.callees.map((c) => c.to_symbol_qualified)).toContain('betaSecretFn');
  });
});
