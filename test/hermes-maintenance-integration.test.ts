/**
 * Real PGLite + SQLite path for Hermes maintenance: the registered CLI identity
 * is verified by the resident owner, import writes through that same engine,
 * and the report's source-scoped readback observes the committed page.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import { registerLocalWriter, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { startDelegatedHermesMaintenance, getDelegatedHermesMaintenanceStatus, shutdownDelegatedHermesMaintenance } from '../src/core/serve-hermes-runner.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-hermes-maintenance-integration-'));
const home = join(root, 'home');
const databasePath = join(root, 'brain-db');
const sourceId = `hermes-integ-${randomUUID().slice(0, 10)}`;
let engine: PGLiteEngine;
let competitor: PGLiteEngine;
let registration: Awaited<ReturnType<typeof registerLocalWriter>>;
let stateDb: string;

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    engine = new PGLiteEngine();
    competitor = new PGLiteEngine();
    await engine.connect({ database_path: databasePath });
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    registration = await registerLocalWriter(engine, 'cli');
  });
  stateDb = buildHermesFixture(root);
}, 120_000);

afterAll(async () => {
  if (competitor) await competitor.disconnect().catch(() => {});
  if (engine) {
    await shutdownDelegatedHermesMaintenance(engine);
    await engine.disconnect();
  }
  rmSync(root, { recursive: true, force: true });
});

test('resident owner claims the real registration, imports into its live engine, and reads the source back', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const options = { stateDb, sourceId, limit: 10, windowSeconds: 20 };
    const first = await startDelegatedHermesMaintenance(engine, options, 'synthetic-import-intent', registration, sourceId);
    expect(first).toMatchObject({ ok: true, protocol: 2 });
    const retry = await startDelegatedHermesMaintenance(engine, options, 'synthetic-import-intent', registration, sourceId);
    expect(retry.jobId).toBe(first.jobId);
    let status = getDelegatedHermesMaintenanceStatus(engine, first.jobId!, sourceId);
    for (let i = 0; i < 200 && status.state === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      status = getDelegatedHermesMaintenanceStatus(engine, first.jobId!, sourceId);
    }
    expect(status).toMatchObject({ ok: true, state: 'done', report: { status: 'ok', source_id: sourceId,
      validation: { checked: 2, missing: [] }, ingest: { sessionsSeen: 2, sessionsImported: 2 } } });
    const slugs = status.report?.ingest?.slugsTouched ?? [];
    expect(slugs).toHaveLength(2);
    for (const slug of slugs) expect(await engine.getPage(slug, { sourceId })).toBeTruthy();
    const rows = await engine.executeRaw<{ slug: string; source_id: string }>(
      "SELECT slug,source_id FROM pages WHERE source_id=$1 AND slug LIKE 'conversations/sessions/%' ORDER BY slug", [sourceId]);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.source_id === sourceId)).toBe(true);
  });
}, 60_000);

test('an exact but empty Hermes selection remains non-success and performs no new source writes', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const before = await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM pages WHERE source_id=$1', [sourceId]);
    const start = await startDelegatedHermesMaintenance(engine,
      { stateDb, sourceId, sessionSources: ['source-that-does-not-exist'], windowSeconds: 20 },
      'empty-selection-intent', registration, sourceId);
    expect(start.ok).toBe(true);
    let status = getDelegatedHermesMaintenanceStatus(engine, start.jobId!, sourceId);
    for (let i = 0; i < 200 && status.state === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      status = getDelegatedHermesMaintenanceStatus(engine, start.jobId!, sourceId);
    }
    expect(status).toMatchObject({ state: 'done', report: { status: 'partial', reasons: expect.arrayContaining(['no_sessions']) } });
    expect(await engine.executeRaw('SELECT count(*)::int AS count FROM pages WHERE source_id=$1', [sourceId])).toEqual(before);
  });
});

test('a second PGLite engine cannot compete with the resident owner on its datastore', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    try {
      await expect(competitor.connect({ database_path: databasePath })).rejects.toThrow();
    } finally {
      try { await competitor.disconnect(); } catch { /* failed opens have no connection to release */ }
    }
  });
}, 60_000);

test('revoked native registration is refused before touching the imported source', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const before = await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM pages WHERE source_id=$1', [sourceId]);
    expect(await revokeLocalWriter(engine, registration.id)).toBe(true);
    const result = await startDelegatedHermesMaintenance(engine, { stateDb, sourceId }, 'revoked-intent', registration, sourceId);
    expect(result).toMatchObject({ ok: false, protocol: 2, error: 'permission_denied' });
    const after = await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM pages WHERE source_id=$1', [sourceId]);
    expect(after).toEqual(before);
  });
});
