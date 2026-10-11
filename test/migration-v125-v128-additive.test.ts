import { setTestSchemaVersion } from './helpers/schema-version.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const ADDITIVE_VERSIONS = [125, 126, 127, 128] as const;

let root: string;
let engine: PGLiteEngine;

describe('schema 125-128 additive foundation', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'pmbrain-v125-v128-'));
    engine = new PGLiteEngine();
    await engine.connect({ database_path: join(root, 'brain.pglite') });
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  test('LATEST_VERSION includes the current compatibility migrations', () => {
    expect(LATEST_VERSION).toBe(134);
  });

  test('migrations 125-128 are SQL-only and do not rewrite pages/facts/timeline content', () => {
    for (const version of ADDITIVE_VERSIONS) {
      const migration = MIGRATIONS.find(item => item.version === version);
      expect(migration).toBeDefined();
      expect(migration?.handler).toBeUndefined();
      expect(migration?.sql).toBeDefined();
      expect(migration?.sql).not.toMatch(/UPDATE\s+(pages|facts|timeline_entries)\b/i);
    }
    const openLoops = MIGRATIONS.find(item => item.version === 128);
    expect(openLoops?.name).toBe('open_loops');
    expect(openLoops?.sql).not.toMatch(/dream_verdicts/i);
    expect(openLoops?.sql).not.toMatch(/takes/i);
  });

  test('initSchema adds event_page_id and keys idx_timeline_dedup on md5(summary)', async () => {
    const columns = await engine.executeRaw<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'timeline_entries' AND column_name = 'event_page_id'
    `);
    expect(columns).toHaveLength(1);

    const indexes = await engine.executeRaw<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'timeline_entries'
         AND indexname IN ('idx_timeline_dedup', 'idx_timeline_event_page', 'idx_timeline_event_dedup')
    `);
    const dedup = indexes.find(row => row.indexname === 'idx_timeline_dedup');
    expect(dedup).toBeDefined();
    expect(dedup!.indexdef).toMatch(/page_id,\s*date,\s*md5\(summary\),\s*source/);
    expect(indexes.some(row => row.indexname === 'idx_timeline_event_page')).toBe(true);
    expect(indexes.some(row => row.indexname === 'idx_timeline_event_dedup')).toBe(true);
  });

  test('addTimelineEntry and addTimelineEntriesBatch still succeed on the old conflict target', async () => {
    await engine.putPage('people/additive-timeline', {
      type: 'person',
      title: 'Additive timeline',
      compiled_truth: 'timeline page',
    });
    await engine.addTimelineEntry('people/additive-timeline', {
      date: '2026-09-12',
      summary: 'first meeting',
      source: 'meetings/one.md',
    });
    const inserted = await engine.addTimelineEntriesBatch([
      {
        slug: 'people/additive-timeline',
        date: '2026-09-12',
        summary: 'first meeting',
        source: 'meetings/one.md',
      },
      {
        slug: 'people/additive-timeline',
        date: '2026-09-13',
        summary: 'follow-up',
        source: 'meetings/two.md',
      },
    ]);
    expect(inserted).toBe(1);
    const rows = await engine.getTimeline('people/additive-timeline');
    expect(rows.map(row => row.summary).sort()).toEqual(['first meeting', 'follow-up']);
  });

  test('entity_identities and open_loops exist and are empty', async () => {
    const identityCount = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM entity_identities`,
    );
    const loopCount = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM open_loops`,
    );
    const muteCount = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM loop_suppressions`,
    );
    expect(identityCount[0]?.count).toBe(0);
    expect(loopCount[0]?.count).toBe(0);
    expect(muteCount[0]?.count).toBe(0);
  });

  test('facts ontology columns exist and a plain fact insert still works', async () => {
    const columns = await engine.executeRaw<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'facts'
         AND column_name IN ('dimension', 'value', 'value_hash', 'dim_status')
       ORDER BY column_name
    `);
    expect(columns.map(row => row.column_name)).toEqual([
      'dim_status',
      'dimension',
      'value',
      'value_hash',
    ]);
    await engine.executeRaw(`
      INSERT INTO facts (source_id, entity_slug, fact, kind, source)
      VALUES ('default', 'people/additive-timeline', 'plain fact without dimension', 'fact', 'test')
    `);
    const rows = await engine.executeRaw<{ fact: string; dimension: string | null }>(`
      SELECT fact, dimension FROM facts
       WHERE entity_slug = 'people/additive-timeline'
    `);
    expect(rows).toEqual([{ fact: 'plain fact without dimension', dimension: null }]);
  });

  test('upgrading from schema 124 reaches 128 and leaves existing timeline event_page_id NULL', async () => {
    await engine.putPage('people/legacy-timeline', {
      type: 'person',
      title: 'Legacy timeline',
      compiled_truth: 'legacy',
    });
    await engine.addTimelineEntry('people/legacy-timeline', {
      date: '2026-01-01',
      summary: 'legacy row',
    });
    await setTestSchemaVersion(engine, '124');
    await runMigrations(engine);
    expect(await engine.getConfig('version')).toBe('134');
    const rows = await engine.executeRaw<{ event_page_id: number | null; summary: string }>(`
      SELECT te.event_page_id, te.summary
        FROM timeline_entries te
        JOIN pages p ON p.id = te.page_id
       WHERE p.slug = 'people/legacy-timeline'
    `);
    expect(rows).toEqual([{ event_page_id: null, summary: 'legacy row' }]);
  }, 120_000);
});
