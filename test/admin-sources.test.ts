import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { queryAdminSources } from '../src/commands/serve-http.ts';
import { buildSyncStatusReport } from '../src/commands/sync.ts';

/**
 * v0.41.29 Sources tab — `/admin/api/sources` endpoint SQL.
 *
 * The endpoint is a thin Express handler over `queryAdminSources` +
 * `buildSyncStatusReport`; the source-selection SQL is the load-bearing
 * surface (same pattern as test/admin-agents-spend.test.ts).
 *
 * Pinned behaviors:
 *   - Excludes archived sources
 *   - INCLUDES sources with null local_path (push-only brains: filtering
 *     on local_path emptied the Sources tab + federation source-picker)
 *   - JSONB config surfaces as an object, defaulting to {}
 *   - Deterministic ORDER BY id
 *   - buildSyncStatusReport accepts the rows (no disk I/O on null paths)
 */

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('queryAdminSources (/admin/api/sources SQL)', () => {
  it('includes push-only sources with null local_path', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('push-only', 'push-only', NULL, '{}'::jsonb)`,
    );
    const sources = await queryAdminSources(engine);
    const ids = sources.map((s) => s.id);
    expect(ids).toContain('push-only');
    expect(sources.find((s) => s.id === 'push-only')!.local_path).toBe(null);
  });

  it('excludes archived sources', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('gone', 'gone', true)`,
    );
    const sources = await queryAdminSources(engine);
    expect(sources.map((s) => s.id)).not.toContain('gone');
  });

  it('surfaces JSONB config as an object and orders by id', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('bbb', 'bbb', '{"syncEnabled": true}'::jsonb),
              ('aaa', 'aaa', '{}'::jsonb)`,
    );
    const sources = await queryAdminSources(engine);
    const ids = sources.map((s) => s.id);
    expect(ids.indexOf('aaa')).toBeLessThan(ids.indexOf('bbb'));
    expect(sources.find((s) => s.id === 'bbb')!.config).toEqual({ syncEnabled: true });
    expect(sources.find((s) => s.id === 'aaa')!.config).toEqual({});
  });

  it('buildSyncStatusReport accepts the rows (null local_path does not throw)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('push-only', 'push-only', NULL, '{}'::jsonb)`,
    );
    const report = await buildSyncStatusReport(engine, await queryAdminSources(engine));
    expect(report.schema_version).toBe(1);
    const row = report.sources.find((s) => s.source_id === 'push-only');
    expect(row).toBeDefined();
  });
});
