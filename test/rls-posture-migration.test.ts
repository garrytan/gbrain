import { describe, expect, test } from 'bun:test';

describe('Phase 4D RLS posture migration', () => {
  test('v35 auto-RLS migration is a no-op for fresh installs', async () => {
    const { MIGRATIONS } = await import('../src/core/migrate.ts');
    const v35 = MIGRATIONS.find(m => m.version === 35);
    expect(v35).toBeDefined();
    expect(v35!.name).toContain('deprecated_noop');
    expect(v35!.sqlFor?.postgres).toBe('');
    expect(v35!.sqlFor?.pglite).toBe('');
  });

  test('v39 disables RLS on known service-role-only tables and drops legacy trigger', async () => {
    const {
      MIGRATIONS,
      LATEST_VERSION,
      RLS_POSTURE_COMMENT,
      RLS_SERVICE_ROLE_ONLY_TABLES,
    } = await import('../src/core/migrate.ts');
    const v39 = MIGRATIONS.find(m => m.version === 39);
    expect(v39).toBeDefined();
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(39);
    const sql = v39!.sqlFor!.postgres!;
    const handlerSource = String(v39!.handler);
    expect(sql).toContain('DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table');
    expect(sql).toContain('DROP FUNCTION IF EXISTS auto_enable_rls');
    expect(handlerSource).toContain('DISABLE ROW LEVEL SECURITY');
    expect(handlerSource).toContain('COMMENT ON TABLE ${table} IS $1');
    expect(RLS_POSTURE_COMMENT).toContain('GBRAIN:RLS_POSTURE service-role-only');
    expect(RLS_POSTURE_COMMENT).toContain('MCP/app bearer-token authorization is the security boundary');
    for (const table of ['pages', 'content_chunks', 'access_tokens', 'mcp_request_log', 'minion_jobs', 'subagent_messages']) {
      expect(RLS_SERVICE_ROLE_ONLY_TABLES as readonly string[]).toContain(table);
    }
  });

  test('Postgres schema baseline documents service-role-only RLS posture', async () => {
    const schema = await Bun.file(new URL('../src/schema.sql', import.meta.url)).text();
    expect(schema).toContain('Row Level Security posture: service-role-only by default');
    expect(schema).toContain('DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table');
    expect(schema).toContain('DISABLE ROW LEVEL SECURITY');
    expect(schema).toContain('GBRAIN:RLS_POSTURE service-role-only');
  });
});
