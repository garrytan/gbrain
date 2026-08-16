/**
 * `gbrain serve --source-guard` (EV1, plugin lanes) — fail-closed write
 * routing for user-global serves whose cwd is meaningless (plugin snapshots).
 *
 * Three layers under test:
 *   1. sourceGuardBlocksWrite tier policy (source-resolver.ts) — deliberate/
 *      unambiguous tiers pass, cwd-derived and ambiguous tiers block, engine
 *      errors fail CLOSED.
 *   2. The dispatch gate (dispatch.ts) — write/admin ops blocked with the
 *      source_binding_required envelope BEFORE validation/handler; reads
 *      always pass; guard off (no sourceGuardTier) is byte-identical to
 *      today.
 *   3. resolveMcpStdioSourceScope tier passthrough (server.ts) — the
 *      transport reports which tier won so the gate can decide per call.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import { sourceGuardBlocksWrite, WRITE_SAFE_SOURCE_TIERS, __resetSourceGuardQueryShape, type SourceTier } from '../src/core/source-resolver.ts';
import { resolveMcpStdioSourceScope } from '../src/mcp/server.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function engineWithSources(ids: string[]): BrainEngine {
  return {
    kind: 'postgres',
    // Emulates just enough SQL semantics for the guard's bounded probe:
    // the `id <> 'default'` filter (both the archived and legacy shapes).
    executeRaw: async (sql: string) => {
      const rows = ids.map(id => ({ id }));
      return sql.includes("id <> 'default'") ? rows.filter(r => r.id !== 'default') : rows;
    },
    getConfig: async () => null,
    sql: async () => [],
  } as unknown as BrainEngine;
}

/** Pre-`archived`-column schema: the filtered-by-archived query throws, the
 *  legacy shape succeeds. */
function legacyEngine(ids: string[]): BrainEngine {
  return {
    kind: 'postgres',
    executeRaw: async (sql: string) => {
      if (sql.includes('archived')) throw new Error('column "archived" does not exist');
      const rows = ids.map(id => ({ id }));
      return sql.includes("id <> 'default'") ? rows.filter(r => r.id !== 'default') : rows;
    },
    getConfig: async () => null,
  } as unknown as BrainEngine;
}

const throwingEngine = {
  kind: 'postgres',
  executeRaw: async () => {
    throw new Error('db down');
  },
  getConfig: async () => null,
} as unknown as BrainEngine;

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('sourceGuardBlocksWrite tier policy', () => {
  beforeEach(() => {
    // The query-shape memo is module-level; reset so each test exercises the
    // shape it constructs rather than inheriting a prior test's probe result.
    __resetSourceGuardQueryShape();
  });

  test('deliberate/unambiguous tiers never block (no engine consulted)', async () => {
    for (const tier of WRITE_SAFE_SOURCE_TIERS) {
      expect(await sourceGuardBlocksWrite(throwingEngine, tier)).toBe(false);
    }
  });

  test("seed_default passes while 'default' is the sole source", async () => {
    expect(await sourceGuardBlocksWrite(engineWithSources(['default']), 'seed_default')).toBe(false);
    expect(await sourceGuardBlocksWrite(engineWithSources([]), 'seed_default')).toBe(false);
  });

  test('seed_default blocks the moment another source exists', async () => {
    expect(await sourceGuardBlocksWrite(engineWithSources(['default', 'wiki']), 'seed_default')).toBe(true);
    expect(await sourceGuardBlocksWrite(engineWithSources(['wiki']), 'seed_default')).toBe(true);
  });

  test('engine failure fails CLOSED on seed_default', async () => {
    expect(await sourceGuardBlocksWrite(throwingEngine, 'seed_default')).toBe(true);
  });

  test('sole_non_default is write-safe (one real source = unambiguous)', async () => {
    // The tier fires when exactly one non-default source exists; the write
    // can only go there, so it is NOT a misroute. Engine never consulted.
    expect(await sourceGuardBlocksWrite(throwingEngine, 'sole_non_default')).toBe(false);
  });

  test('local_path blocks only when another source exists (sole-source is safe)', async () => {
    __resetSourceGuardQueryShape();
    expect(await sourceGuardBlocksWrite(engineWithSources(['default']), 'local_path')).toBe(false);
    __resetSourceGuardQueryShape();
    expect(await sourceGuardBlocksWrite(engineWithSources(['default', 'wiki']), 'local_path')).toBe(true);
  });

  test('pre-archived-column schema resolves through the legacy fallback', async () => {
    expect(await sourceGuardBlocksWrite(legacyEngine(['default']), 'seed_default')).toBe(false);
    __resetSourceGuardQueryShape();
    expect(await sourceGuardBlocksWrite(legacyEngine(['default', 'wiki']), 'seed_default')).toBe(true);
  });

  test('legacy shape is memoized — the archived query throws once, not per call', async () => {
    let archivedAttempts = 0;
    const counting = {
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        if (sql.includes('archived')) {
          archivedAttempts++;
          throw new Error('column "archived" does not exist');
        }
        return [];
      },
      getConfig: async () => null,
    } as unknown as BrainEngine;
    await sourceGuardBlocksWrite(counting, 'seed_default');
    await sourceGuardBlocksWrite(counting, 'seed_default');
    expect(archivedAttempts).toBe(1);
  });
});

describe('dispatch gate', () => {
  const multiSource = engineWithSources(['default', 'wiki']);
  const A_WRITE_OP = 'put_page';
  const A_READ_OP = 'search';
  const A_WRITE_VERB = 'remember';

  test('fixture ops still carry the scopes this suite assumes', () => {
    expect(operations.find(o => o.name === A_WRITE_OP)?.scope).toBe('write');
    expect(operations.find(o => o.name === A_READ_OP)?.scope).toBe('read');
    expect(operations.find(o => o.name === A_WRITE_VERB)?.scope).toBe('write');
  });

  test('write op + ambient tier → source_binding_required before validation', async () => {
    // Deliberately invalid params: the guard must fire FIRST, so the caller
    // learns the routing rule, not the op's parameter shape.
    const result = await dispatchToolCall(multiSource, A_WRITE_OP, {}, {
      remote: true, transport: 'stdio', sourceId: 'default', sourceGuardTier: 'local_path',
    });
    expect(result.isError).toBe(true);
    expect(parsed(result).error).toBe('source_binding_required');
    expect(parsed(result).suggestion).toContain('GBRAIN_SOURCE');
  });

  test('write VERB envelope carries protocol_version', async () => {
    const result = await dispatchToolCall(multiSource, A_WRITE_VERB, {}, {
      remote: true, transport: 'stdio', sourceId: 'default', sourceGuardTier: 'seed_default',
    });
    expect(parsed(result).error).toBe('source_binding_required');
    expect(parsed(result).protocol_version).toBeDefined();
  });

  test('read op passes the gate on every tier', async () => {
    const result = await dispatchToolCall(multiSource, A_READ_OP, { query: 'x' }, {
      remote: true, transport: 'stdio', sourceId: 'default', sourceGuardTier: 'local_path',
    });
    // The stub engine can't run the real handler; the contract is only that
    // the guard did not fire on a read.
    if (result.isError) {
      expect(parsed(result).error).not.toBe('source_binding_required');
    }
  });

  test('write op + deliberate tier (env) passes the gate', async () => {
    const result = await dispatchToolCall(multiSource, A_WRITE_OP, {}, {
      remote: true, transport: 'stdio', sourceId: 'wiki', sourceGuardTier: 'env',
    });
    if (result.isError) {
      expect(parsed(result).error).not.toBe('source_binding_required');
    }
  });

  test('__all__ sentinel write is blocked with a sentinel-specific hint even on a write-safe tier', async () => {
    const result = await dispatchToolCall(multiSource, A_WRITE_OP, {}, {
      remote: true, transport: 'stdio', sourceId: '__all__', sourceGuardTier: 'env',
    });
    expect(result.isError).toBe(true);
    expect(parsed(result).error).toBe('source_binding_required');
    expect(parsed(result).message).toContain('__all__');
  });

  test('guard off (no sourceGuardTier) never blocks — regression pin', async () => {
    const result = await dispatchToolCall(multiSource, A_WRITE_OP, {}, {
      remote: true, transport: 'stdio', sourceId: 'default',
    });
    if (result.isError) {
      expect(parsed(result).error).not.toBe('source_binding_required');
    }
  });
});

describe('resolveMcpStdioSourceScope tier passthrough', () => {
  const savedEnv = process.env.GBRAIN_SOURCE;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GBRAIN_SOURCE;
    else process.env.GBRAIN_SOURCE = savedEnv;
  });

  test('ambient fallback reports seed_default (cwd outside any source)', async () => {
    delete process.env.GBRAIN_SOURCE;
    const scope = await resolveMcpStdioSourceScope(engineWithSources([]), '/nonexistent/plugin-snapshot');
    expect(scope.sourceId).toBe('default');
    expect(scope.tier).toBe('seed_default');
  });

  test('GBRAIN_SOURCE reports the env tier even on resolver failure', async () => {
    process.env.GBRAIN_SOURCE = 'wiki';
    const scope = await resolveMcpStdioSourceScope(throwingEngine, '/nonexistent/plugin-snapshot');
    expect(scope.sourceId).toBe('wiki');
    expect(scope.tier).toBe('env');
  });
});
