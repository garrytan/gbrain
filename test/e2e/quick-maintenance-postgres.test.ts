/** Postgres parity for Quick Maintenance on a Source with no usable checkout. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDream } from '../../src/commands/dream.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runByMentionCore, runHistoricalMarkdownCatchUp } from '../../src/commands/extract.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;
let testHome = '';

beforeAll(async () => {
  if (skip) return;
  testHome = mkdtempSync(join(tmpdir(), 'pmbrain-quick-pg-'));
  engine = (await setupDB()) as PostgresEngine;
  await engine.executeRaw(
    `DELETE FROM op_checkpoints WHERE op IN ('extract-by-mention', 'extract-markdown-catchup')`,
  );
  await engine.executeRaw(
    `DELETE FROM sources WHERE id IN ('moved-source', 'mention-source', 'duwu-catchup')`,
  );
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
  rmSync(testHome, { recursive: true, force: true });
});

describeIfDB('Postgres Quick Maintenance — stale Source local_path', () => {
  test('skips file-side phases and keeps Source-scoped DB phases running', async () => {
    const missingPath = join(testHome, 'moved-away-source');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('moved-source', 'Moved Source', $1, '{}'::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
      [missingPath],
    );
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, updated_at, created_at)
       VALUES
         ('moved-source', 'notes/kept', 'note', 'Kept', 'Database content remains available.', '', '{}'::jsonb, NOW(), NOW()),
         ('default', 'notes/other', 'note', 'Other', 'A different source page.', '', '{}'::jsonb, NOW(), NOW())`,
    );

    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`unexpected exit ${code}`);
    }) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const report = await withEnv(
        { PMBRAIN_HOME: testHome, GBRAIN_HOME: testHome },
        () => runDream(engine, ['--preset', 'quick', '--source', 'moved-source', '--json']),
      );
      expect(report).toBeTruthy();
      if (!report) return;

      expect(report.brain_dir).toBeNull();
      expect(report.status).not.toBe('failed');
      expect(report.phases.find(item => item.phase === 'sync')?.details?.reason).toBe('no_brain_dir');
      expect(report.phases.find(item => item.phase === 'extract')?.details?.by_mention).toBe(true);
      expect(report.phases.find(item => item.phase === 'resolve_symbol_edges')?.details?.sources_walked).toBe(1);
      expect(report.phases.find(item => item.phase === 'orphans')?.details?.total_pages).toBe(1);
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }, 120_000);
});

describeIfDB('Postgres Quick Maintenance - mention relation parity', () => {
  test('recognizes company aliases, preserves explicit links, and removes an inferred link after ambiguity appears', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, created_at)
       VALUES ('mention-source', 'mention-source', '{}'::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config`,
    );
    await engine.putPage('companies/openai', {
      type: 'company', title: 'OpenAI', compiled_truth: 'OpenAI company.', timeline: '',
      frontmatter: { aliases: ['Open AI'] },
    }, { sourceId: 'mention-source' });
    await engine.putPage('notes/inferred', {
      type: 'note', title: 'Inferred', compiled_truth: 'Open AI released a model.', timeline: '', frontmatter: {},
    }, { sourceId: 'mention-source' });
    await engine.putPage('notes/explicit', {
      type: 'note', title: 'Explicit', compiled_truth: 'OpenAI released a model.', timeline: '', frontmatter: {},
    }, { sourceId: 'mention-source' });
    await engine.addLink(
      'notes/explicit', 'companies/openai', 'explicit Markdown relation', 'related_to', 'markdown',
      undefined, undefined, { fromSourceId: 'mention-source', toSourceId: 'mention-source' },
    );

    const first = await runByMentionCore(engine, { sourceIdFilter: 'mention-source', quiet: true });
    expect(first.created).toBe(1);
    expect(first.removed).toBe(0);
    expect(first.ambiguousNames).toBe(0);
    const firstRows = await engine.executeRaw<{ slug: string; link_source: string }>(
      `SELECT f.slug, l.link_source FROM links l
       JOIN pages f ON f.id = l.from_page_id
       WHERE f.source_id = 'mention-source' ORDER BY f.slug, l.link_source`,
    );
    expect(firstRows).toEqual([
      { slug: 'notes/explicit', link_source: 'markdown' },
      { slug: 'notes/inferred', link_source: 'mentions' },
    ]);

    await engine.putPage('companies/openai-duplicate', {
      type: 'company', title: 'OpenAI', compiled_truth: 'Duplicate name.', timeline: '', frontmatter: { aliases: ['Open AI'] },
    }, { sourceId: 'mention-source' });
    const second = await runByMentionCore(engine, { sourceIdFilter: 'mention-source', quiet: true });
    expect(second.created).toBe(0);
    expect(second.removed).toBe(1);
    expect(second.ambiguousNames).toBeGreaterThanOrEqual(1);
    const finalRows = await engine.executeRaw<{ slug: string; link_source: string }>(
      `SELECT f.slug, l.link_source FROM links l
       JOIN pages f ON f.id = l.from_page_id
       WHERE f.source_id = 'mention-source' ORDER BY f.slug, l.link_source`,
    );
    expect(finalRows).toEqual([{ slug: 'notes/explicit', link_source: 'markdown' }]);
  }, 120_000);
});

describeIfDB('Postgres Quick Maintenance — historical Markdown catch-up', () => {
  test('writes exact relative links only inside the selected Source and is idempotent', async () => {
    const repo = join(testHome, 'markdown-catchup-source');
    const fromSlug = 'wiki/重庆保供项目/项目-重庆保供项目';
    const toSlug = 'youdao/重庆保供项目/事件管理中心.note';
    const fromFile = join(repo, `${fromSlug}.md`);
    const toFile = join(repo, `${toSlug}.md`);
    mkdirSync(dirname(fromFile), { recursive: true });
    mkdirSync(dirname(toFile), { recursive: true });
    writeFileSync(fromFile, '查看 [事件管理中心](../../youdao/重庆保供项目/事件管理中心.note.md)。');
    writeFileSync(toFile, '# 事件管理中心');

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('duwu-catchup', 'duwu-catchup', $1, '{}'::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
      [repo],
    );
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, updated_at, created_at)
       VALUES
         ('duwu-catchup', $1, 'note', '项目：重庆保供项目', 'body', '', '{}'::jsonb, NOW(), NOW()),
         ('duwu-catchup', $2, 'note', '事件管理中心', 'body', '', '{}'::jsonb, NOW(), NOW()),
         ('default', $2, 'note', '其他 Source 同 slug 页面', 'body', '', '{}'::jsonb, NOW(), NOW())`,
      [fromSlug, toSlug],
    );

    const first = await runHistoricalMarkdownCatchUp(engine, {
      brainDir: repo,
      sourceId: 'duwu-catchup',
      maxHistoricalPages: 50,
    });
    const second = await runHistoricalMarkdownCatchUp(engine, {
      brainDir: repo,
      sourceId: 'duwu-catchup',
      maxHistoricalPages: 50,
    });
    expect(first.linksCreated).toBe(1);
    expect(second.linksCreated).toBe(0);
    expect(second.historicalPages).toBe(0);

    const checkpoints = await engine.executeRaw<{ completed_kind: string; completed_count: number }>(
      `SELECT jsonb_typeof(completed_keys) AS completed_kind,
              jsonb_array_length(completed_keys)::int AS completed_count
         FROM op_checkpoints
        WHERE op = 'extract-markdown-catchup'`,
    );
    expect(checkpoints).toEqual([{ completed_kind: 'array', completed_count: 2 }]);

    const rows = await engine.executeRaw<{ from_source: string; to_source: string }>(
      `SELECT f.source_id AS from_source, t.source_id AS to_source
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       WHERE f.source_id = 'duwu-catchup'`,
    );
    expect(rows).toEqual([{ from_source: 'duwu-catchup', to_source: 'duwu-catchup' }]);
  }, 120_000);
});
