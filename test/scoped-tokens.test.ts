import { describe, expect, test } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operationsByName } from '../src/core/operations.ts';
import {
  PHASE_4B_TOKEN_PRESETS,
  VALID_SCOPES,
  authorizeScopes,
  normalizeTokenScopes,
  operationLogName,
} from '../src/core/scopes.ts';

describe('Phase 4B scoped token authorization', () => {
  test('all MCP operations declare fine-grained required scopes', () => {
    for (const op of Object.values(operationsByName)) {
      const requiredScopes = op.requiredScopes;
      expect(Array.isArray(requiredScopes), `${op.name} missing requiredScopes`).toBe(true);
      if (!requiredScopes) throw new Error(`${op.name} missing requiredScopes`);
      expect(requiredScopes.length, `${op.name} has empty requiredScopes`).toBeGreaterThan(0);
      for (const scope of requiredScopes) {
        expect(VALID_SCOPES, `${op.name} has invalid scope ${scope}`).toContain(scope);
      }
    }
  });

  test('read-only scoped token can read but cannot write', () => {
    const tokenScopes = ['pages:read', 'chunks:read', 'log:write'];

    expect(authorizeScopes(tokenScopes, operationsByName.get_page.requiredScopes)).toEqual({ ok: true });
    expect(authorizeScopes(tokenScopes, operationsByName.query.requiredScopes)).toEqual({ ok: true });

    expect(authorizeScopes(tokenScopes, operationsByName.put_page.requiredScopes)).toEqual({
      ok: false,
      missingScopes: ['pages:write', 'chunks:write'],
    });
  });

  test('writer scoped token cannot call admin operations', () => {
    const tokenScopes = ['pages:read', 'pages:write', 'chunks:read', 'chunks:write', 'log:write'];

    expect(authorizeScopes(tokenScopes, operationsByName.put_page.requiredScopes)).toEqual({ ok: true });
    expect(authorizeScopes(tokenScopes, operationsByName.get_health.requiredScopes)).toEqual({
      ok: false,
      missingScopes: ['admin'],
    });
  });

  test('admin scoped token can call admin only when admin is explicit', () => {
    expect(authorizeScopes(['admin'], operationsByName.get_health.requiredScopes)).toEqual({ ok: true });
    expect(authorizeScopes(['admin'], operationsByName.get_page.requiredScopes)).toEqual({
      ok: false,
      missingScopes: ['pages:read'],
    });
  });

  test('legacy read/write/admin scopes normalize without breaking existing MCP clients', () => {
    expect(normalizeTokenScopes(['read'])).toEqual(['pages:read', 'chunks:read', 'log:write']);
    expect(normalizeTokenScopes(['write'])).toEqual(['pages:read', 'pages:write', 'chunks:read', 'chunks:write', 'log:write']);
    expect(normalizeTokenScopes(['read', 'write', 'admin'])).toEqual([
      'pages:read',
      'pages:write',
      'chunks:read',
      'chunks:write',
      'log:write',
      'admin',
    ]);
  });

  test('Phase 4B named token presets are provisioned with explicit scopes', () => {
    expect(PHASE_4B_TOKEN_PRESETS['agent-cto-ryde']).toEqual(['pages:read', 'chunks:read', 'log:write']);
    expect(PHASE_4B_TOKEN_PRESETS['agent-backend-ryde']).toEqual(['pages:read', 'pages:write', 'chunks:read', 'chunks:write', 'log:write']);
    expect(PHASE_4B_TOKEN_PRESETS['agent-frontend-ryde']).toEqual(['pages:read', 'chunks:read', 'log:write']);
    expect(PHASE_4B_TOKEN_PRESETS['agent-ios-ryde']).toEqual(['pages:read', 'chunks:read', 'log:write']);
    expect(PHASE_4B_TOKEN_PRESETS['agent-head-of-product-ryde']).toEqual(['pages:read', 'pages:write', 'chunks:read', 'log:write']);
    expect(PHASE_4B_TOKEN_PRESETS['orchestrator-ryde']).toEqual(['pages:read', 'pages:write', 'chunks:read', 'chunks:write', 'log:write', 'admin']);
  });

  test('MCP dispatch enforces scopes before executing write/admin handlers', async () => {
    let healthCalls = 0;
    const fakeEngine = {
      getHealth: async () => {
        healthCalls++;
        return { status: 'ok' };
      },
    } as any;

    const readOnlyWrite = await dispatchToolCall(
      fakeEngine,
      'put_page',
      { slug: 'wiki/test', content: '# nope', dry_run: true },
      { remote: true, auth: { token: 't', clientId: 'readonly', scopes: ['pages:read', 'chunks:read', 'log:write'] } },
    );
    expect(readOnlyWrite.isError).toBe(true);
    expect(readOnlyWrite.content[0].text).toContain('insufficient_scope');
    expect(readOnlyWrite.content[0].text).toContain('pages:write');

    const writerAdmin = await dispatchToolCall(
      fakeEngine,
      'get_health',
      {},
      { remote: true, auth: { token: 't', clientId: 'writer', scopes: ['pages:read', 'pages:write', 'chunks:read', 'chunks:write', 'log:write'] } },
    );
    expect(writerAdmin.isError).toBe(true);
    expect(writerAdmin.content[0].text).toContain('admin');
    expect(healthCalls).toBe(0);

    const adminHealth = await dispatchToolCall(
      fakeEngine,
      'get_health',
      {},
      { remote: true, auth: { token: 't', clientId: 'admin', scopes: ['admin'] } },
    );
    expect(adminHealth.isError).toBeUndefined();
    expect(JSON.parse(adminHealth.content[0].text)).toEqual({ status: 'ok' });
    expect(healthCalls).toBe(1);
  });
});

describe('Phase 4B operation logging taxonomy', () => {
  test('MCP tools/call logs the real operation name, not a generic request blob', () => {
    expect(operationLogName('tools/call', 'get_page')).toBe('get_page');
    expect(operationLogName('tools/call', 'put_page')).toBe('put_page');
    expect(operationLogName('tools/list')).toBe('tools/list');
    expect(operationLogName(undefined)).toBe('unknown');
  });
});

describe('Phase 4B access token migration', () => {
  test('v37 backfills and constrains token scopes for upgraded Postgres brains', async () => {
    const { MIGRATIONS } = await import('../src/core/migrate.ts');
    const v37 = MIGRATIONS.find(m => m.version === 37);
    expect(v37).toBeDefined();
    const sql = v37!.sqlFor!.postgres!;

    expect(sql).toContain('ALTER TABLE access_tokens');
    expect(sql).toContain("SET DEFAULT '{}'::text[]");
    expect(sql).toContain("UPDATE access_tokens");
    expect(sql).toContain("WHERE scopes IS NULL OR cardinality(scopes) = 0");
    expect(sql).toContain('SET NOT NULL');
    expect(sql).toContain('idx_access_tokens_name_active_unique');
  });
});
