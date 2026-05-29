/**
 * SECURITY (#authz — `__all__` isolation bypass).
 *
 * Pre-fix: the read ops (`query`, `code_callers`, `code_callees`,
 * `search_by_image`) resolved an explicit `source_id: "__all__"` /
 * `all_sources: true` to "no source filter" (`{}` / `undefined` /
 * `allSources: true`). A remote, source-scoped OAuth client could therefore
 * search content out of ISOLATED sources (e.g. `hr-restricted`) it has no
 * `federated_read` grant for — the exact escape `sourceScopeOpts` guards
 * against for the empty-`allowedSources` case (operations.ts:416-419).
 *
 * Fix: `crossSourceScope(ctx)` bounds `__all__` to the caller's authorized
 * sources. Local CLI (OS-trusted) and unrestricted/admin clients stay
 * unrestricted; a source-scoped remote client is bounded to its own scope.
 */
import { describe, test, expect } from 'bun:test';
import { crossSourceScope } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

// Minimal ctx — crossSourceScope only reads remote / auth.allowedSources / sourceId.
function ctx(partial: Partial<OperationContext>): OperationContext {
  return partial as OperationContext;
}

describe('crossSourceScope — __all__ is bounded by authorization', () => {
  test('local CLI (remote=false) is unrestricted', () => {
    expect(crossSourceScope(ctx({ remote: false }))).toEqual({});
    // even with a pin, local trusts the OS boundary
    expect(crossSourceScope(ctx({ remote: false, sourceId: 'hr-restricted' }))).toEqual({});
  });

  test('remote admin / unrestricted client (no scope) stays cross-source', () => {
    expect(crossSourceScope(ctx({ remote: true }))).toEqual({});
    expect(crossSourceScope(ctx({ remote: true, auth: {} as never }))).toEqual({});
  });

  test('remote source-scoped client is BOUNDED to its federated_read set', () => {
    const scope = crossSourceScope(ctx({
      remote: true,
      auth: { allowedSources: ['agent-context', 'youtube'] } as never,
    }));
    expect(scope).toEqual({ sourceIds: ['agent-context', 'youtube'] });
    // crucially: an isolated source it was NOT granted is absent
    expect((scope.sourceIds ?? []).includes('hr-restricted')).toBe(false);
  });

  test('remote scalar-bound client is bounded to its single source', () => {
    expect(crossSourceScope(ctx({ remote: true, sourceId: 'agent-context' })))
      .toEqual({ sourceId: 'agent-context' });
  });

  test('empty allowedSources does NOT widen to all sources', () => {
    // attacker-controlled [] must fall through to scalar, never {} (=all)
    expect(crossSourceScope(ctx({
      remote: true,
      sourceId: 'agent-context',
      auth: { allowedSources: [] } as never,
    }))).toEqual({ sourceId: 'agent-context' });
  });
});
