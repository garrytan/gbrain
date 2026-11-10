/**
 * get_status_snapshot lists only the sources inside the caller's grant: a remote caller bound to source-a sees
 * source-a's sync row and never source-b's id, local_path, counts or commit. The trusted local CLI keeps every source.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const op = operationsByName.get_status_snapshot!;
const MARK_PATH = '/srv/source-b-checkout';
const MARK_COMMIT = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';

for (const kind of testBackends()) {
  describe(`get_status_snapshot source scope (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('source-a', 'source-a', '/srv/source-a-checkout') ON CONFLICT (id) DO NOTHING`);
      await engine.executeRaw(`INSERT INTO sources (id, name, local_path, last_commit, last_sync_at) VALUES ('source-b', 'source-b', $1, $2, now()) ON CONFLICT (id) DO NOTHING`, [MARK_PATH, MARK_COMMIT]);
    }, 120_000);
    afterAll(async () => { await close?.(); });

    const ctx = (extra: Record<string, unknown>): any => ({
      engine, config: {}, dryRun: false, logger: { info() {}, warn() {}, error() {} }, ...extra,
    });

    test('a remote caller bound to source-a sees no other source', async () => {
      const out = await op.handler(ctx({ remote: true, sourceId: 'source-a', auth: { clientId: 'c1', scopes: ['admin'], sourceId: 'source-a' } }), {});
      const text = JSON.stringify(out);
      expect(text).toContain('source-a');
      expect(text).not.toContain('source-b');
      expect(text).not.toContain(MARK_PATH);
      expect(text).not.toContain(MARK_COMMIT);
    });

    test('a federated grant sees exactly its granted sources', async () => {
      const out = await op.handler(ctx({ remote: true, auth: { clientId: 'c1', scopes: ['admin'], allowedSources: ['source-b'] } }), {});
      const text = JSON.stringify(out);
      expect(text).toContain(MARK_COMMIT);
      expect(text).not.toContain('/srv/source-a-checkout');
    });

    test('the trusted local CLI keeps the brain-wide view', async () => {
      const text = JSON.stringify(await op.handler(ctx({ remote: false }), {}));
      expect(text).toContain('source-a');
      expect(text).toContain(MARK_COMMIT);
    });
  });
}
