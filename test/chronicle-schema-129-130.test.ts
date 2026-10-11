import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_VERSION, MIGRATIONS } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
let root: string;

describe('schema 129-130 chronicle timeline repair', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'pmbrain-schema-129-130-'));
    engine = new PGLiteEngine();
    await engine.connect({ database_path: join(root, 'brain.pglite') });
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(root, { recursive: true, force: true });
  });

  test('最新版保留 129-130 的时间线迁移', () => {
    expect(LATEST_VERSION).toBe(MIGRATIONS.at(-1)!.version);
    expect(MIGRATIONS.find(m => m.version === 129)?.name).toBe('timeline_dedup_md5_summary');
    expect(MIGRATIONS.find(m => m.version === 130)?.name).toBe('timeline_legacy_source_split_repair');
  });

  test('long summary timeline insert does not overflow btree', async () => {
    await engine.putPage('people/long-summary', {
      type: 'person',
      title: 'Long summary',
      compiled_truth: 'body',
    });
    const summary = 'x'.repeat(4000);
    await engine.addTimelineEntry('people/long-summary', {
      date: '2026-09-12',
      summary,
      source: 'meetings/long.md',
    });
    const rows = await engine.getTimeline('people/long-summary');
    expect(rows[0]?.summary.length).toBe(4000);
  });
});
