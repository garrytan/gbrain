import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runExport } from '../src/commands/export.ts';
import { parseFactsFence, renderFactsTable } from '../src/core/facts-fence.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { readExportPage, readExportWithdrawals } from '../src/core/export-snapshot.ts';
import { overlayCanonicalBodies } from '../src/core/page-state/snapshot.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) describe(`coherent export: ${backend}`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  }, 60000);
  afterAll(async () => { await engine.disconnect(); });
  test('batch-local withdrawal ledgers stay source-isolated and are not read per page', async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('ledger-other','Ledger synthetic') ON CONFLICT (id) DO UPDATE SET archived=false");
    await engine.executeRaw("DELETE FROM fact_withdrawals WHERE source_id IN ('default','ledger-other')");
    const body = renderFactsTable([{ rowNum: 1, claim: 'Shared synthetic claim', kind: 'fact', confidence: 1,
      visibility: 'world', notability: 'medium', active: true, context: '' }]);
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
      SELECT CASE WHEN n%2=1 THEN 'default' ELSE 'ledger-other' END,'ledger/p'||n,'note','Synthetic',
      CASE WHEN n<=4 THEN $1 ELSE 'No fact markers' END,'','{}'::jsonb FROM generate_series(1,513) n`, [body]);
    await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES ('default','world',gbrain_fact_fingerprint($1))", ['Shared synthetic claim']);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'export-ledger-')));
    const real = engine.executeRaw;
    const reads: string[] = [];
    let normalizations = 0;
    engine.executeRaw = async function (query, params, options) {
      if (query.includes('SELECT visibility,fact_hash,withdrawn_at')) reads.push(String(params?.[0]));
      if (query.includes('AS lines(line,ord)')) normalizations++;
      return real.call(this, query, params, options) as never;
    };
    try {
      await runExport(engine, ['--dir', dir]);
      expect(reads.filter(source => source === 'default')).toHaveLength(3);
      expect(reads.filter(source => source === 'ledger-other')).toHaveLength(2);
      expect(normalizations).toBe(2);
      expect(parseFactsFence(readFileSync(join(dir, 'ledger/p1.md'), 'utf8')).facts[0].active).toBe(false);
      expect(parseFactsFence(readFileSync(join(dir, 'ledger/p2.md'), 'utf8')).facts[0].active).toBe(true);
      expect(parseFactsFence(readFileSync(join(dir, 'ledger/p3.md'), 'utf8')).facts[0].active).toBe(false);
      expect(parseFactsFence(readFileSync(join(dir, 'ledger/p4.md'), 'utf8')).facts[0].active).toBe(true);
    } finally { engine.executeRaw = real; rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
  test('export-local marker shortcut preserves canonical malformed and orphan fence handling', async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("DELETE FROM fact_withdrawals WHERE source_id='default'");
    await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES ('default','world',gbrain_fact_fingerprint($1))", ['MiXeD\t  synthetic claim']);
    const body = renderFactsTable([{ rowNum: 1, claim: 'MIXED   synthetic claim', kind: 'fact', confidence: 1,
      visibility: 'world', notability: 'medium', active: true, context: '' }]);
    const variants = ['Plain text without a marker', body, '<!--- gbrain:facts:end -->',
      'gbrain:facts:begin malformed', body + '\n<!--- gbrain:facts:begin -->',
      '<!--- gbrain:facts:begin -->\n' + body, '<!--- gbrain:facts:begin -->\nbroken\n<!--- gbrain:facts:end -->'];
    await engine.transaction(async tx => {
      const withdrawals = await readExportWithdrawals(tx, 'default');
      for (let n = 0; n < variants.length; n++) {
        const compiled = variants[n], timeline = variants[variants.length - 1 - n];
        const [key] = await tx.executeRaw<{ id: string; source_id: string; slug: string }>(`INSERT INTO pages
          (source_id,slug,type,title,compiled_truth,timeline,frontmatter) VALUES ('default',$1,'note','Synthetic',$2,$3,'{}')
          RETURNING id::text,source_id,slug`, ['adversarial/p' + n, compiled, timeline]);
        const canonical = await overlayCanonicalBodies(tx.executeRaw.bind(tx), compiled, timeline, withdrawals);
        let normalized = 0;
        const real = tx.executeRaw;
        tx.executeRaw = async function (query, params, options) {
          if (query.includes('AS lines(line,ord)')) normalized++;
          return real.call(this, query, params, options) as never;
        };
        try {
          const snapshot = await readExportPage(tx, key, withdrawals);
          expect(snapshot.page.compiled_truth).toBe(canonical.compiled_truth);
          expect(snapshot.page.timeline).toBe(canonical.timeline);
          expect(normalized).toBe(1);
        } finally { tx.executeRaw = real; }
      }
    });
  }, 60000);
  test('source/page/tag/raw changes after snapshot do not tear the export', async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('snapshot-source','Snapshot') ON CONFLICT (id) DO UPDATE SET archived=false");
    await engine.putPage('sample', { type: 'note', title: 'Before', compiled_truth: 'before-body', timeline: '' }, { sourceId: 'snapshot-source' });
    await engine.addTag('sample', 'before-tag', { sourceId: 'snapshot-source' });
    await engine.putRawData('sample', 'feed', { state: 'before' }, { sourceId: 'snapshot-source' });
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'export-snapshot-')));
    const real = engine.executeRaw;
    let writer: Promise<void> | undefined;
    engine.executeRaw = async function (query, params, options) {
      const result = await real.call(this, query, params, options);
      if (!query.includes('AS export_tags')) return result as never;
      writer = engine.transaction(async tx => {
        await tx.executeRaw("UPDATE pages SET compiled_truth='after-body' WHERE source_id='snapshot-source'");
        await tx.executeRaw("UPDATE tags SET tag='after-tag' WHERE page_id IN (SELECT id FROM pages WHERE source_id='snapshot-source')");
        await tx.executeRaw("UPDATE raw_data SET data=$1::text::jsonb WHERE page_id IN (SELECT id FROM pages WHERE source_id='snapshot-source')", ['{"state":"after"}']);
        await tx.executeRaw("UPDATE sources SET archived=true WHERE id='snapshot-source'");
      });
      if (backend === 'postgres') await writer;
      return result as never;
    };
    try {
      await runExport(engine, ['--dir', dir, '--source', 'snapshot-source']);
      await writer;
      const md = readFileSync(join(dir, 'sample.md'), 'utf8');
      expect(md).toContain('before-body'); expect(md).toContain('before-tag'); expect(md).not.toContain('after-');
      expect(JSON.parse(readFileSync(join(dir, '.raw/sample.json'), 'utf8'))).toEqual({ feed: { state: 'before' } });
    } finally { engine.executeRaw = real; await writer; rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
  test('pre-snapshot withdrawal is reflected and later withdrawal preserves historical snapshot', async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("DELETE FROM fact_withdrawals WHERE source_id='default'");
    const body = renderFactsTable([
      { rowNum: 1, claim: 'Earlier synthetic claim', kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true, context: '' },
      { rowNum: 2, claim: 'Later synthetic claim', kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true, context: '' },
    ]);
    await engine.putPage('claims', { type: 'note', title: 'Claims', compiled_truth: body, timeline: '' }, { sourceId: 'default' });
    await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES ('default','world',gbrain_fact_fingerprint($1))", ['Earlier synthetic claim']);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'export-withdrawal-')));
    const real = engine.executeRaw;
    let writer: Promise<unknown> | undefined;
    engine.executeRaw = async function (query, params, options) {
      const result = await real.call(this, query, params, options);
      if (!query.includes('AS export_tags')) return result as never;
      writer = engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES ('default','world',gbrain_fact_fingerprint($1))", ['Later synthetic claim']);
      if (backend === 'postgres') await writer;
      return result as never;
    };
    try {
      await runExport(engine, ['--dir', dir, '--source', 'default']);
      await writer;
      const exported = parseFactsFence(readFileSync(join(dir, 'claims.md'), 'utf8')).facts;
      expect(exported.map(fact => fact.active)).toEqual([false, true]);
      engine.executeRaw = real;
      const imported = await importFromContent(engine, 'claims', readFileSync(join(dir, 'claims.md'), 'utf8'), { sourceId: 'default', noEmbed: true });
      expect(imported.error).toBeUndefined();
      const current = await engine.readPageSnapshot('claims', { sourceId: 'default' });
      expect(parseFactsFence(current!.page.compiled_truth).facts.map(fact => fact.active)).toEqual([false, false]);
    } finally { engine.executeRaw = real; await writer; rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
  test('deleting and recreating a source after S cannot replace its raw sidecar', async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('incarnation-source','Synthetic') ON CONFLICT DO NOTHING");
    await engine.putPage('same', { type: 'note', title: 'Original', compiled_truth: 'original', timeline: '' }, { sourceId: 'incarnation-source' });
    await engine.putRawData('same', 'feed', { incarnation: 'old' }, { sourceId: 'incarnation-source' });
    const real = engine.executeRaw;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'export-incarnation-')));
    let writer: Promise<void> | undefined;
    engine.executeRaw = async function (query, params, options) {
      const result = await real.call(this, query, params, options);
      if (!query.includes('AS export_tags')) return result as never;
      writer = engine.transaction(async tx => {
        await tx.executeRaw("DELETE FROM sources WHERE id='incarnation-source'");
        await tx.executeRaw("INSERT INTO sources(id,name) VALUES ('incarnation-source','Replacement')");
        await tx.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter) VALUES ('incarnation-source','same','note','Replacement','new','', '{}'::jsonb)");
        await tx.executeRaw("INSERT INTO raw_data(page_id,source,data) SELECT id,'feed',$1::text::jsonb FROM pages WHERE source_id='incarnation-source'", ['{"incarnation":"new"}']);
      });
      if (backend === 'postgres') await writer;
      return result as never;
    };
    try {
      await runExport(engine, ['--dir', dir, '--source', 'incarnation-source']); await writer;
      expect(JSON.parse(readFileSync(join(dir, '.raw/same.json'), 'utf8'))).toEqual({ feed: { incarnation: 'old' } });
    } finally { engine.executeRaw = real; await writer; rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
  test('keyset batches preserve S while an unseen page is removed and a new page appears', async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
      SELECT 'default','batch/p'||n,'note','Synthetic','Original','','{}'::jsonb FROM generate_series(1,513) n`);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'export-keyset-')));
    const real = engine.executeRaw;
    let writer: Promise<void> | undefined;
    let batches = 0;
    engine.executeRaw = async function (query, params, options) {
      const rows = await real.call(this, query, params, options);
      if (query.includes('ORDER BY p.id LIMIT 256')) {
        batches++;
        if (!writer) {
          writer = engine.transaction(async tx => {
            await tx.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug='batch/p400'");
            await tx.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter) VALUES ('default','batch/new','note','New','New','','{}'::jsonb)");
          });
          if (backend === 'postgres') await writer;
        }
      }
      return rows as never;
    };
    try {
      await runExport(engine, ['--dir', dir, '--source', 'default']); await writer;
      expect(batches).toBe(4);
      expect(readdirSync(join(dir, 'batch')).length).toBe(513);
      expect(existsSync(join(dir, 'batch/p400.md'))).toBe(true);
      expect(existsSync(join(dir, 'batch/new.md'))).toBe(false);
    } finally { engine.executeRaw = real; await writer; rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
