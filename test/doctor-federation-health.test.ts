/**
 * Tests for src/commands/doctor.ts:checkFederationHealth (v0.40 T12).
 *
 * Three-state contract:
 *   ok    — single-source brain, or every federated source healthy
 *   warn  — lag > 1h + federated, coverage < 95% with chunks > 100, OR 3+ failures
 *   fail  — lag > 24h, OR coverage < 50% with chunks > 1000
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkFederationHealth } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`DELETE FROM sources WHERE id != 'default'`);
});

describe('checkFederationHealth', () => {
  test('single-source brain → ok with "no federation to check"', async () => {
    const check = await checkFederationHealth(engine);
    expect(check.name).toBe('federation_health');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('no federation to check');
  });

  test('multi-source healthy brain → ok with source count', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, last_sync_at) VALUES ('extra', 'extra', '{"federated":true}', NOW())`,
    );
    const check = await checkFederationHealth(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('source(s) healthy');
  });

  test('source with lag > 1h + federated → warn with remediation', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, last_sync_at) VALUES ('stale-source', 'stale-source', '{"federated":true}', NOW() - INTERVAL '2 hours')`,
    );
    const check = await checkFederationHealth(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('stale-source');
    expect(check.message).toContain('gbrain sync trigger --source stale-source');
  });

  test('source with lag > 24h → fail with remediation', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, last_sync_at) VALUES ('dead-source', 'dead-source', '{"federated":true}', NOW() - INTERVAL '48 hours')`,
    );
    const check = await checkFederationHealth(engine);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('dead-source');
    expect(check.message).toContain('gbrain sync trigger');
  });

  test('source with low embed coverage + chunks > 100 → warn', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, last_sync_at) VALUES ('uncovered', 'uncovered', '{"federated":true}', NOW())`,
    );
    // Seed 200 pages with chunks; 10 embedded.
    for (let i = 0; i < 200; i++) {
      await engine.putPage(`p${i}`, { type: 'note', title: `p${i}`, compiled_truth: `body ${i}` }, { sourceId: 'uncovered' });
      await engine.upsertChunks(
        `p${i}`,
        [{
          chunk_index: 0,
          chunk_text: `chunk ${i}`,
          chunk_source: 'compiled_truth',
          token_count: 1,
          embedding: i < 10 ? new Float32Array(1536) : undefined,
        }],
        { sourceId: 'uncovered' },
      );
    }
    const check = await checkFederationHealth(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('uncovered');
    expect(check.message).toContain('embed coverage');
    expect(check.message).toContain('gbrain jobs submit embed-backfill');
  });

  test('synced + zero pages → ok (vacuous truth, no coverage warn)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, last_sync_at) VALUES ('empty', 'empty', '{"federated":true}', NOW())`,
    );
    const check = await checkFederationHealth(engine);
    expect(check.status).toBe('ok');
  });
});
