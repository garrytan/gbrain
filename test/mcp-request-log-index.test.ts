import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

async function expectTokenIndex(engine: BrainEngine): Promise<void> {
  const [row] = await engine.executeRaw<{ token_index: string | null; legacy_index: string | null; time_index: boolean }>(
    `SELECT pg_get_indexdef(to_regclass('idx_mcp_log_token_time')) AS token_index,
            to_regclass('idx_mcp_log_agent_time')::text AS legacy_index,
            to_regclass('idx_mcp_log_time_agent') IS NOT NULL AS time_index`,
  );
  expect(row.token_index).not.toBeNull();
  expect(row.token_index!).toContain('(token_name, created_at DESC)');
  expect(row.legacy_index).toBeNull();
  expect(row.time_index).toBe(true);
}

for (const kind of testBackends()) {
  describe(`request-log token index (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
        return;
      }
      engine = new PGLiteEngine();
      close = () => engine.disconnect();
      await engine.connect({});
      await engine.initSchema();
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('indexes the token filter on fresh and existing brains', async () => {
      await expectTokenIndex(engine);

      const migration = MIGRATIONS.find(m => m.name === 'mcp_request_log_token_index')!;
      await engine.executeRaw('DROP INDEX idx_mcp_log_token_time');
      await engine.executeRaw('CREATE INDEX idx_mcp_log_agent_time ON mcp_request_log(agent_name, created_at DESC)');
      await engine.executeRaw(`INSERT INTO mcp_request_log(token_name, agent_name, operation, latency_ms, status)
                               VALUES ('client-id', 'Friendly name', 'query', 5, 'success')`);
      await engine.setConfig('version', String(migration.version - 1));
      await engine.initSchema();
      await expectTokenIndex(engine);

      // An interrupted migration can have spent the build already. Replaying
      // both the schema and handler must still keep exactly these indexes.
      await engine.executeRaw('CREATE INDEX idx_mcp_log_agent_time ON mcp_request_log(agent_name, created_at DESC)');
      await engine.setConfig('version', String(migration.version - 1));
      await engine.initSchema();
      await engine.initSchema();
      await expectTokenIndex(engine);
      expect(await engine.executeRaw('SELECT token_name, agent_name FROM mcp_request_log')).toEqual([
        { token_name: 'client-id', agent_name: 'Friendly name' },
      ]);
    }, 120_000);
  });
}
