/**
 * Regression: `addSource` must store `sources.config` as a JSONB OBJECT on
 * Postgres, not a double-encoded JSONB string.
 *
 * The bug: passing `JSON.stringify(config)` into a `$N::jsonb` positional cast
 * makes postgres.js's `unsafe(sql, params)` serialize the already-stringified
 * JSON a second time, so the column lands as `jsonb_typeof = 'string'`. Every
 * `config->>'<key>'` lookup (remote_url, federated, managed_clone, webhook_*)
 * then returns NULL and GIN/key access breaks. PGLite hides the bug because its
 * driver re-parses the string back into an object — so this regression MUST run
 * against real Postgres to have any teeth. Same corruption class repaired by
 * `gbrain repair-jsonb` and guarded by `scripts/check-jsonb-pattern.sh`.
 *
 * Coverage note: this exercises the path-B INSERT (no --url). The path-A
 * managed-clone INSERT shares the identical `executeRawJsonb` call site, and
 * BOTH sites are pinned by the CI guard. Path A isn't separately e2e-tested
 * here because `parseRemoteUrl` is https-only with an SSRF gate, so reaching
 * its INSERT requires a live network clone — non-deterministic for CI.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { addSource } from '../../src/core/sources-ops.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;

beforeAll(async () => {
  if (skip) return;
  engine = (await setupDB()) as PostgresEngine;
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

beforeEach(async () => {
  if (skip) return;
  await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
});

async function readConfigShape(id: string) {
  const rows = await engine.executeRaw<{ typeof: string; federated: string | null }>(
    `SELECT jsonb_typeof(config) AS typeof, config->>'federated' AS federated
       FROM sources WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describeIfDB('Postgres — addSource stores config as a JSONB object', () => {
  test('federated=true: config is an object and config->>\'federated\' is retrievable', async () => {
    await addSource(engine, { id: 'jsonb-true', localPath: '/tmp/jsonb-true', federated: true });
    const shape = await readConfigShape('jsonb-true');
    expect(shape?.typeof).toBe('object');
    expect(shape?.federated).toBe('true');
  });

  test('federated=false: false is persisted and key still retrievable (not NULL)', async () => {
    await addSource(engine, { id: 'jsonb-false', localPath: '/tmp/jsonb-false', federated: false });
    const shape = await readConfigShape('jsonb-false');
    expect(shape?.typeof).toBe('object');
    expect(shape?.federated).toBe('false');
  });
});
