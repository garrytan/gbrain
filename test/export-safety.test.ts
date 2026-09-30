import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExport } from '../src/commands/export.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { ExportStage, EXPORT_SNAPSHOT_MS } from '../src/core/export-stage.ts';

for (const backend of testBackends()) describe(`export safety: ${backend}`, () => {
  let engine: BrainEngine;
  let target: BrainEngine;
  let closeTarget: () => Promise<void>;
  let dir: string;
  let exit: typeof process.exit;
  let log: typeof console.log;
  let err: typeof console.error;
  let messages: string[];
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    if (engine instanceof PostgresEngine) await engine.connect({ database_url: requirePostgresTestDatabase(), poolSize: 1 });
    else await engine.connect({});
    await engine.initSchema();
    if (backend === 'postgres') {
      const isolated = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      target = isolated.engine; closeTarget = isolated.close;
    } else {
      target = new PGLiteEngine();
      await target.connect({}); await target.initSchema();
      closeTarget = () => target.disconnect();
    }
  }, 60000);
  afterAll(async () => { await closeTarget?.(); await engine.disconnect(); });
  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'export-safety-')));
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('other','Other') ON CONFLICT DO NOTHING");
    exit = process.exit; log = console.log; err = console.error; messages = [];
    process.exit = ((code: number) => { throw new Error(`EXIT:${code}`); }) as never;
    console.log = console.error = (...args) => { messages.push(args.join(' ')); };
  });
  afterEach(() => { process.exit = exit; console.log = log; console.error = err; rmSync(dir, { recursive: true, force: true }); });
  async function page(slug: string, sourceId = 'default') {
    await engine.putPage(slug, { type: 'note', title: sourceId, compiled_truth: `body-${sourceId}`, timeline: '' }, { sourceId });
    await engine.addTag(slug, `tag-${sourceId}`, { sourceId });
    await engine.putRawData(slug, 'feed', { owner: sourceId }, { sourceId });
  }
  test('same-slug source collision refuses without any destination writes', async () => {
    await page('notes/shared'); await page('notes/shared', 'other');
    await expect(runExport(engine, ['--dir', dir])).rejects.toThrow('EXIT:1');
    expect(readdirSync(dir)).toEqual([]);
    expect(messages.join('\n')).not.toContain('Exported ');
  });
  test('explicit source preserves body, tags and raw identity', async () => {
    await page('notes/shared'); await page('notes/shared', 'other');
    await runExport(engine, ['--dir', dir, '--source=other']);
    const md = readFileSync(join(dir, 'notes/shared.md'), 'utf8');
    expect(md).toContain('body-other'); expect(md).toContain('tag-other'); expect(md).not.toContain('tag-default');
    expect(JSON.parse(readFileSync(join(dir, 'notes/.raw/shared.json'), 'utf8'))).toEqual({ feed: { owner: 'other' } });
  });
  test('occupied planned leaf and repeated export preserve all existing bytes', async () => {
    await page('sample'); writeFileSync(join(dir, 'sample.md'), 'operator bytes');
    await expect(runExport(engine, ['--dir', dir])).rejects.toThrow('EXIT:1');
    expect(readFileSync(join(dir, 'sample.md'), 'utf8')).toBe('operator bytes');
    expect(readdirSync(dir)).toEqual(['sample.md']);
  });
  test('same-source Unicode and case aliases refuse before publication', async () => {
    await page('first'); await page('second');
    await engine.executeRaw('UPDATE pages SET slug=$1 WHERE slug=$2', ['Notes/Café', 'first']);
    await engine.executeRaw('UPDATE pages SET slug=$1 WHERE slug=$2', ['notes/Cafe\u0301', 'second']);
    await expect(runExport(engine, ['--dir', dir])).rejects.toThrow('EXIT:1');
    expect(readdirSync(dir)).toEqual([]);
  });
  test('page/sidecar file-prefix collision refuses before publication', async () => {
    await page('one'); await page('one.md/two');
    await expect(runExport(engine, ['--dir', dir])).rejects.toThrow('EXIT:1');
    expect(readdirSync(dir)).toEqual([]);
  });
  test('unrelated files survive and only complete publication gets success', async () => {
    await page('sample'); writeFileSync(join(dir, 'keep'), 'untouched');
    await runExport(engine, ['--dir', dir]);
    expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('untouched');
    expect(readFileSync(join(dir, '.gbrain-export-status'), 'utf8')).toBe('GBRAIN EXPORT INCOMPLETE\nCOMPLETE\n');
    expect(messages.join('\n')).toContain('Exported 1 pages');
    await expect(runExport(engine, ['--dir', dir])).rejects.toThrow('EXIT:1');
    expect(existsSync(join(dir, 'sample.md'))).toBe(true);
  });
  test('missing, invalid, unknown and archived source inputs refuse without output', async () => {
    await page('sample');
    await engine.executeRaw("UPDATE sources SET archived=true WHERE id='other'");
    try {
      for (const args of [['--source'], ['--source='], ['--source', '../bad'], ['--source', 'unknown'], ['--source', 'other'],
        ['--source', 'a'.repeat(33)], ['--source', 'café'], ['--source', 'cafe\u0301'], ['--source', 'a\0b'],
        ['--source', 'default', '--source=other']]) {
        await expect(runExport(engine, ['--dir', dir, ...args])).rejects.toThrow('EXIT:1');
        expect(readdirSync(dir)).toEqual([]);
      }
    } finally { await engine.executeRaw("UPDATE sources SET archived=false WHERE id='other'"); }
  });
  test('restore checks the recorded path and limits output to the repo source and narrower prefix', async () => {
    await page('media/first'); await page('media/second'); await page('media/second', 'other'); await page('notes/third');
    const repo = join(dir, 'repo'), out = join(dir, 'out');
    mkdirSync(repo); mkdirSync(join(repo, 'Media'));
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only:\n    - media/\n');
    writeFileSync(join(repo, 'Media/First Note.md'), 'original human bytes');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo]);
    await engine.executeRaw("UPDATE pages SET source_path='Media/First Note.md' WHERE source_id='default' AND slug='media/first'");
    await runExport(engine, ['--dir', out, '--repo', repo, '--restore-only', '--slug-prefix', 'media/']);
    expect(existsSync(join(out, 'media/first.md'))).toBe(false);
    expect(readFileSync(join(out, 'media/second.md'), 'utf8')).toContain('body-default');
    expect(existsSync(join(out, 'notes/third.md'))).toBe(false);
    expect(readFileSync(join(repo, 'Media/First Note.md'), 'utf8')).toBe('original human bytes');
  });
  test('unscoped export ignores inherited source while explicit and maximum-length sources route exactly', async () => {
    const longest = 'a'.repeat(32);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET archived=false', [longest, 'Export longest source']);
    await page('default-page'); await page('other-page', 'other'); await page('long-page', longest);
    await withEnv({ GBRAIN_SOURCE: 'other' }, async () => {
      await runExport(engine, ['--dir', join(dir, 'all')]);
      for (const slug of ['default-page', 'other-page', 'long-page']) expect(existsSync(join(dir, 'all', slug + '.md'))).toBe(true);
      await runExport(engine, ['--dir', join(dir, 'default'), '--source', 'default']);
      expect(existsSync(join(dir, 'default/default-page.md'))).toBe(true);
      expect(existsSync(join(dir, 'default/other-page.md'))).toBe(false);
      await runExport(engine, ['--dir', join(dir, 'long'), '--source', longest]);
      expect(readFileSync(join(dir, 'long/long-page.md'), 'utf8')).toContain(`body-${longest}`);
    });
  });
  test('source-separated legacy-slug exports re-import independently without cross-source tags or rekeying', async () => {
    const slug = "notes/caf\u00e9-o'example";
    await page(slug); await page(slug, 'other');
    for (const source of ['default', 'other']) await runExport(engine, ['--dir', join(dir, source), '--source', source]);
    await target.executeRaw("INSERT INTO sources(id,name) VALUES ('other','Other')");
    for (const source of ['default', 'other']) {
      const imported = await importFromFile(target, join(dir, source, slug + '.md'), slug + '.md', { sourceId: source, noEmbed: true });
      expect(imported.error).toBeUndefined();
      expect(imported.slug).toBe(slug);
      const snapshot = await target.readPageSnapshot(slug, { sourceId: source });
      expect(snapshot!.page.compiled_truth).toContain(`body-${source}`);
      expect(snapshot!.tags).toEqual([`tag-${source}`]);
      expect(await target.getPage(slugifyPath(slug + '.md'), { sourceId: source })).toBeNull();
      expect(JSON.parse(readFileSync(join(dir, source, 'notes/.raw', "caf\u00e9-o'example.json"), 'utf8'))).toEqual({ feed: { owner: source } });
    }
    expect(await target.executeRaw('SELECT count(*)::int AS count FROM pages')).toEqual([{ count: 2 }]);
  }, 60000);
  test.each(['page-read', 'deadline', 'transaction-end'])('snapshot %s failure releases its transaction and staging without publishing', async fault => {
    await page('failure-page');
    const query = engine.executeRaw, transaction = engine.transaction, now = Date.now, close = ExportStage.prototype.close;
    const [before] = await engine.executeRaw("SELECT current_setting('statement_timeout') AS timeout, current_setting('transaction_isolation') AS isolation");
    let staging: string | undefined, active = false, captured: Record<string, unknown> | undefined;
    ExportStage.prototype.close = function () { staging = this.directory; return close.call(this); };
    engine.executeRaw = async function (sql, params, options) {
      if (sql.includes('AS export_tags')) {
        captured = (await query.call(this, "SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation, current_setting('statement_timeout') AS timeout"))[0] as Record<string, unknown>;
        if (fault === 'page-read') throw new Error('Injected export page read failure');
        if (fault === 'deadline') {
          const expired = now() + EXPORT_SNAPSHOT_MS + 1;
          Date.now = () => expired;
        }
      }
      return query.call(this, sql, params, options) as never;
    };
    engine.transaction = async function (fn) {
      try {
        return await transaction.call(this, async tx => {
          active = true;
          const value = await fn(tx);
          if (fault === 'transaction-end') await query.call(tx, 'SELECT 1/0');
          return value;
        }) as never;
      } finally { active = false; }
    };
    try {
      await expect(runExport(engine, ['--dir', dir])).rejects.toThrow('EXIT:1');
      expect(captured).toEqual({ read_only: 'on', isolation: 'repeatable read', timeout: '1min' });
      expect(active).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
      expect(staging).toBeDefined();
      expect(existsSync(staging!)).toBe(false);
      expect(messages.join('\n')).not.toContain('Exported ');
      if (fault === 'deadline') expect(messages.join('\n')).toContain('snapshot time limit');
    } finally { engine.executeRaw = query; engine.transaction = transaction; Date.now = now; ExportStage.prototype.close = close; }
    expect(await engine.executeRaw("SELECT current_setting('statement_timeout') AS timeout, current_setting('transaction_isolation') AS isolation")).toEqual([before]);
    await engine.transaction(async tx => { await tx.executeRaw("UPDATE pages SET title='Connection reused' WHERE slug='failure-page'"); });
    if (engine instanceof PostgresEngine) expect(engine.getPoolDiagnostics()!.tracked).toEqual({ tx: 0, raw: 0, direct: 0, reserved: 0 });
    await runExport(engine, ['--dir', dir]);
    expect(readFileSync(join(dir, 'failure-page.md'), 'utf8')).toContain('Connection reused');
  }, 60000);
  test.skipIf(backend !== 'postgres')('real PostgreSQL statement timeout rolls back and releases its sole pool connection', async () => {
    await page('timeout-page');
    expect((engine as PostgresEngine).getPoolDiagnostics()!.poolMax).toBe(1);
    const query = engine.executeRaw;
    let code: unknown;
    engine.executeRaw = async function (sql, params, options) {
      const rows = await query.call(this, sql, params, options);
      if (sql === 'SET LOCAL statement_timeout = 60000') {
        await query.call(this, 'SET LOCAL statement_timeout = 10');
        try { await query.call(this, 'SELECT pg_sleep(0.1)'); }
        catch (error) { code = (error as { code: string }).code; throw error; }
      }
      return rows as never;
    };
    try {
      await expect(runExport(engine, ['--dir', dir])).rejects.toThrow('EXIT:1');
      expect(code).toBe('57014');
      expect(readdirSync(dir)).toEqual([]);
    } finally { engine.executeRaw = query; }
    expect((engine as PostgresEngine).getPoolDiagnostics()!.tracked).toEqual({ tx: 0, raw: 0, direct: 0, reserved: 0 });
    expect(await engine.executeRaw('SELECT 42 AS value')).toEqual([{ value: 42 }]);
    await runExport(engine, ['--dir', dir]);
    expect(existsSync(join(dir, 'timeout-page.md'))).toBe(true);
  }, 60000);
  test('snapshot transaction ends before destination publication begins', async () => {
    await page('lifetime-page');
    const transaction = engine.transaction;
    let active = false, transactions = 0, publicationChecked = false;
    engine.transaction = async function (fn) {
      transactions++; active = true;
      try { return await transaction.call(this, fn) as never; }
      finally { active = false; }
    };
    const capture = console.log;
    console.log = (...args) => {
      if (String(args[0]).startsWith('Exporting ')) { expect(active).toBe(false); publicationChecked = true; }
      capture(...args);
    };
    try {
      await runExport(engine, ['--dir', dir]);
      expect(transactions).toBe(1);
      expect(publicationChecked).toBe(true);
    } finally { engine.transaction = transaction; console.log = capture; }
  });
});
