/**
 * #1712 (dupes #2289, #2140) — the `__all__` sentinel must work in EVERY
 * resolution tier, not just as a per-call `source_id` param.
 *
 * The bug: SOURCE_ID_RE forbids underscores, so `--source __all__` and
 * `GBRAIN_SOURCE=__all__` threw in the resolver; the CLI's makeContext
 * blanket-caught that and silently fell back to `sourceId: 'default'` —
 * making the documented span-everything flag STRICTLY NARROWER than passing
 * no flag at all (the catch also discarded the #2561/#3242 federated
 * widening). Meanwhile sourceScopeOpts treated a ctx.sourceId of '__all__'
 * as an unsatisfiable literal.
 *
 * Uses the literal '__all__' (not the ALL_SOURCES constant) so these tests
 * load and run behaviorally against pre-fix trees.
 */
import { describe, test, expect } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import {
  resolveSourceId,
  resolveSourceIdEngineFree,
  resolveSourceWithTier,
} from '../src/core/source-resolver.ts';
import {
  sourceScopeOpts,
  federatedSearchScope,
  type OperationContext,
} from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Stub engine: registered sources + no local_path rows + no default config.
function makeStub(registeredSources: string[]): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const target = params?.[0];
        return registeredSources.includes(target as string)
          ? [{ id: target } as unknown as T]
          : [];
      }
      return [];
    },
    getConfig: async () => null,
  } as unknown as BrainEngine;
}

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: {} as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

// ── Resolver tiers pass the sentinel through verbatim ──────────────────

describe('source-resolver — __all__ sentinel pass-through', () => {
  test('resolveSourceId: explicit --source __all__ resolves (no regex throw, no existence check)', async () => {
    // '__all__' is deliberately NOT in the registered set — the sentinel
    // must skip assertSourceExists (it is not a source id).
    const id = await resolveSourceId(makeStub(['default']), '__all__', '/nonexistent');
    expect(id).toBe('__all__');
  });

  test('resolveSourceId: GBRAIN_SOURCE=__all__ resolves (#2140)', async () => {
    await withEnv({ GBRAIN_SOURCE: '__all__' }, async () => {
      const id = await resolveSourceId(makeStub(['default']), null, '/nonexistent');
      expect(id).toBe('__all__');
    });
  });

  test('resolveSourceIdEngineFree: explicit + env __all__ (thin-client path)', async () => {
    expect(resolveSourceIdEngineFree('__all__', '/nonexistent')).toBe('__all__');
    await withEnv({ GBRAIN_SOURCE: '__all__' }, () => {
      expect(resolveSourceIdEngineFree(null, '/nonexistent')).toBe('__all__');
    });
  });

  test('resolveSourceWithTier: flag and env tiers carry the sentinel', async () => {
    const flag = await resolveSourceWithTier(makeStub(['default']), '__all__', '/nonexistent');
    expect(flag).toMatchObject({ source_id: '__all__', tier: 'flag' });
    await withEnv({ GBRAIN_SOURCE: '__all__' }, async () => {
      const env = await resolveSourceWithTier(makeStub(['default']), null, '/nonexistent');
      expect(env).toMatchObject({ source_id: '__all__', tier: 'env' });
    });
  });

  test('a genuinely invalid --source still throws (SOURCE_ID_RE not loosened)', async () => {
    await expect(resolveSourceId(makeStub(['default']), 'my_source', '/nonexistent'))
      .rejects.toThrow(/Invalid --source/);
    expect(() => resolveSourceIdEngineFree('my_source', '/nonexistent'))
      .toThrow(/Invalid --source/);
  });
});

// ── sourceScopeOpts — the single read-scope choke point ─────────────────

describe('sourceScopeOpts — __all__ sentinel', () => {
  test('trusted local (remote === false): spans the whole brain (empty scope)', () => {
    expect(sourceScopeOpts(ctxOf({ remote: false, sourceId: '__all__' }))).toEqual({});
  });

  test('remote: keeps the unsatisfiable literal — fail-closed, never widens', () => {
    expect(sourceScopeOpts(ctxOf({ remote: true, sourceId: '__all__' })))
      .toEqual({ sourceId: '__all__' });
  });

  test('anything not strictly remote === false is untrusted (fail-closed)', () => {
    // undefined / missing remote must behave like remote, per the trust rule.
    const ctx = ctxOf({ sourceId: '__all__' });
    (ctx as any).remote = undefined;
    expect(sourceScopeOpts(ctx)).toEqual({ sourceId: '__all__' });
  });

  test('a federated grant always wins over the sentinel', () => {
    const ctx = ctxOf({
      remote: true,
      sourceId: '__all__',
      auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['a', 'b'] } as any,
    });
    expect(sourceScopeOpts(ctx)).toEqual({ sourceIds: ['a', 'b'] });
  });
});

// ── Never narrower than passing no flag (#2561 regression shape) ────────

describe('__all__ is never narrower than an unqualified read', () => {
  test('local __all__ spans the brain even when federated widening exists', () => {
    // Unqualified read on a federated brain widens to the federated array…
    const unqualified = ctxOf({
      remote: false,
      sourceId: 'default',
      localFederatedSourceIds: ['default', 'src-a', 'src-b'],
    });
    expect(federatedSearchScope(unqualified)).toEqual({
      sourceIds: ['default', 'src-a', 'src-b'],
    });
    // …and __all__ must be a superset of that: the whole brain ({}).
    const all = ctxOf({ remote: false, sourceId: '__all__' });
    expect(federatedSearchScope(all)).toEqual({});
  });
});

// ── makeContext — explicit --source failures error loudly ───────────────

describe('cli makeContext — no silent default fallback for explicit --source', () => {
  test('--source __all__ produces ctx.sourceId __all__ (was: silent default)', async () => {
    const { makeContext } = await import('../src/cli.ts');
    const ctx = await makeContext(makeStub(['default']), { source: '__all__' });
    expect(ctx.sourceId).toBe('__all__');
    expect(ctx.remote).toBe(false);
  });

  test('an explicit --source that fails to resolve throws instead of becoming default', async () => {
    const { makeContext } = await import('../src/cli.ts');
    await expect(makeContext(makeStub(['default']), { source: 'ghost' }))
      .rejects.toThrow(/not found/);
    await expect(makeContext(makeStub(['default']), { source: 'my_source' }))
      .rejects.toThrow(/Invalid --source/);
  });

  test('ambient resolution failure still falls back silently (pre-init brains)', async () => {
    const { makeContext } = await import('../src/cli.ts');
    const broken = {
      kind: 'pglite',
      executeRaw: async () => { throw new Error('relation "sources" does not exist'); },
      getConfig: async () => { throw new Error('relation "config" does not exist'); },
    } as unknown as BrainEngine;
    const ctx = await makeContext(broken, {});
    expect(ctx.sourceId).toBe('default');
  });
});
