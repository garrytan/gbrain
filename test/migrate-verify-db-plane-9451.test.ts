/** #9451 — verify must not call a brain converged while the DB-plane model disagrees with the target. */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { verifyMigrationComplete } from '../src/core/embedding-migration.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

describe('verifyMigrationComplete DB plane (#9451)', () => {
  test('DB-plane model differing from target is a blocker', async () => {
    const rows = await engine.executeRaw<{ dim: number }>(
      `SELECT atttypmod AS dim FROM pg_attribute
        WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`,
    );
    const dims = Number(rows[0]?.dim);
    const target = 'ollama:mxbai-embed-large';
    await engine.setConfig('embedding_model', 'voyage:voyage-4');
    await engine.setConfig('embedding_dimensions', String(dims));
    const verify = await verifyMigrationComplete(engine, { toModel: target, toDims: dims }, {
      filePlane: { model: target, dims },
    });
    expect(verify.complete).toBe(false);
    expect(verify.blockers.join(' ')).toMatch(/DB-plane/);
  });
});
