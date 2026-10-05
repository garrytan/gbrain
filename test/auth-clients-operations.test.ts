/**
 * `gbrain auth clients` operation-snapshot visibility (#6008). Authoring gate:
 * (1) protects the four distinct operation states the listing reports (SQL
 * NULL = `all` with includes_future_operations and a re-pin fix, [] =
 * deny-all, an explicit list, `unavailable` on a schema without the column)
 * and the revoked marker; (2) fails when a NULL snapshot reads like a pinned
 * grant or an old schema is guessed; (3) the existing listClientRows test
 * covers only scope/surface/source columns; (4) no production seam. Both
 * engines: PGLite here, PostgreSQL through
 * test/e2e/auth-clients-operations-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { clientOperationsLines, clientOperationsView, listClientRows } from '../src/commands/auth.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const CLIENTS: Array<[id: string, ops: string[] | null, revoked: boolean]> = [
  ['c-ops-all', null, false],
  ['c-ops-none', [], false],
  ['c-ops-list', ['search', 'get_page'], false],
  ['c-ops-revoked', null, true],
];

for (const kind of testBackends()) {
  describe(`auth clients operation states (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      for (const [id, ops, revoked] of CLIENTS) {
        await engine.executeRaw(
          `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read, allowed_operations, deleted_at)
           VALUES ($1, $1, 'read', 'default', ARRAY['default'], $2::text[], ${revoked ? 'now()' : 'NULL'})`,
          [id, ops],
        );
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    const byId = async () => new Map((await listClientRows(engine)).map(r => [r.client_id, r]));

    test('SQL NULL is `all` with includes_future_operations and a re-pin fix', async () => {
      const row = (await byId()).get('c-ops-all')!;
      expect(row.allowed_operations).toBeNull();
      const view = clientOperationsView(row);
      expect(view).toMatchObject({ operations: 'all', operations_state: 'all', includes_future_operations: true, revoked: false });
      expect(view.fix?.argv?.slice(0, 7)).toEqual(['gbrain', 'auth', 'rescope', '--client', 'c-ops-all', '--operations', '<OPERATIONS>']);
      expect(view.fix?.inputs?.[0]?.how).toContain('--profile');
      expect(view.fix?.next).toBe('run');
      const lines = clientOperationsLines(row).join('\n');
      expect(lines).toContain('operations: all');
      expect(lines).toContain('re-pin: gbrain auth rescope --client c-ops-all --operations');
    });

    test('an empty array is deny-all, not `all`', async () => {
      const row = (await byId()).get('c-ops-none')!;
      expect(clientOperationsView(row)).toEqual({ operations: [], operations_state: 'none', includes_future_operations: false, revoked: false });
      expect(clientOperationsLines(row).join('\n')).toContain('operations: none (deny-all snapshot)');
    });

    test('an explicit list is pinned and reports no future operations', async () => {
      const row = (await byId()).get('c-ops-list')!;
      expect(clientOperationsView(row)).toEqual({ operations: ['search', 'get_page'], operations_state: 'list', includes_future_operations: false, revoked: false });
      expect(clientOperationsLines(row).join('\n')).toContain('operations: 2 pinned (search, get_page)');
    });

    test('a revoked client is marked revoked and gets no re-pin fix', async () => {
      const row = (await byId()).get('c-ops-revoked')!;
      const view = clientOperationsView(row);
      expect(view).toMatchObject({ operations: 'all', revoked: true });
      expect(view.fix).toBeUndefined();
      const lines = clientOperationsLines(row).join('\n');
      expect(lines).toContain('revoked:');
      expect(lines).not.toContain('re-pin');
    });

    test('a schema without the snapshot columns reports `unavailable` (old-schema fallback)', async () => {
      // Last test of the suite: the engine is a throwaway brain (in-memory PGLite / an isolated Postgres database).
      await engine.executeRaw('ALTER TABLE oauth_clients DROP COLUMN allowed_operations');
      const rows = await listClientRows(engine);
      const row = rows.find(r => r.client_id === 'c-ops-list')!;
      expect(row.allowed_operations).toBeUndefined();
      expect(clientOperationsView(row)).toEqual({ operations: 'unavailable', operations_state: 'unavailable', includes_future_operations: null, revoked: false });
      expect(clientOperationsLines(row).join('\n')).toContain('operations: unavailable');
      expect(row.scope).toBe('read');
    });
  });
}
