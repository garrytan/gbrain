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
import { inlineExportMarkdown, readExportPage, readExportPages, readExportWithdrawals } from '../src/core/export-snapshot.ts';
import { overlayCanonicalBodies } from '../src/core/page-state/snapshot.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { rowToPage } from '../src/core/utils.ts';
import { isSegmentedPage } from '../src/core/page-body/page-shape.ts';
import type { ExportWithdrawal } from '../src/core/export-snapshot.ts';

/** The per-page export read as it shipped before #7617, kept as the reference the batch read must reproduce byte for byte. */
async function referenceExportPage(tx: BrainEngine, key: { id: string; source_id: string; slug: string }, withdrawals: ExportWithdrawal[]) {
  const [row] = await tx.executeRaw<Record<string, unknown>>(`WITH export_page AS MATERIALIZED (
    SELECT * FROM pages WHERE id=$1::bigint
  ) SELECT p.*,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS export_tags
    FROM export_page p WHERE p.source_id=$2 AND p.slug=$3 AND p.deleted_at IS NULL`, [key.id, key.source_id, key.slug]);
  if (!row) throw new Error('Export snapshot unexpectedly lost a selected page.');
  const page = rowToPage(row);
  if (!isSegmentedPage(page) && (page.compiled_truth.includes('gbrain:facts:') || page.timeline.includes('gbrain:facts:'))) {
    const applicable = withdrawals.filter(w => w.subject === '*' || w.subject === page.slug)
      .map(({ visibility, fact_hash, withdrawn_at, purged }) => ({ visibility, fact_hash, withdrawn_at, ...(purged ? { purged: true } : {}) }));
    Object.assign(page, await overlayCanonicalBodies(tx.executeRaw.bind(tx), page.compiled_truth, page.timeline, applicable));
  }
  return { page, tags: row.export_tags as string[] };
}

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
  test('#7617: readExportPages gives every page exactly the snapshot the per-page read gave, in two statements', async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("DELETE FROM fact_withdrawals WHERE source_id='default'");
    await engine.executeRaw("DELETE FROM fact_purges WHERE source_id='default'");
    const fence = (...claims: string[]) => renderFactsTable(claims.map((claim, i) => ({ rowNum: i + 1, claim, kind: 'fact', confidence: 1,
      visibility: 'world', notability: 'medium', active: true, context: '' })));
    const withdraw = (claim: string, subject = '*') => engine.executeRaw(
      "INSERT INTO fact_withdrawals(source_id,visibility,fact_hash,subject) VALUES ('default','world',gbrain_fact_fingerprint($1),$2)", [claim, subject]);
    await withdraw('Withdrawn everywhere claim');
    await withdraw('Withdrawn here claim', 'shapes/fence-subject');
    await withdraw('MiXeD\t  synthetic claim');
    await engine.executeRaw("INSERT INTO fact_purges(source_id,visibility,fact_hash,subject) VALUES ('default','world',gbrain_fact_fingerprint($1),'shapes/fence-purged')", ['Purged claim']);
    const shapes: Array<[string, string, string, Record<string, unknown>]> = [
      ['shapes/plain', 'A plain body.', '', {}],
      ['shapes/empty', '', '', {}],
      ['shapes/timeline', 'Body.', '- 2026-01-01: An event.\n- 2026-01-02: Another event.', {}],
      ['shapes/crlf', 'Line one\r\nLine two\r\n', 'Timeline\r\n', {}],
      ['shapes/fence-star', 'Lead.\n\n' + fence('Withdrawn everywhere claim', 'A kept claim'), '', {}],
      ['shapes/fence-subject', fence('Withdrawn here claim'), fence('Withdrawn here claim', 'Withdrawn everywhere claim'), {}],
      ['shapes/fence-other-subject', fence('Withdrawn here claim'), '', {}],
      ['shapes/fence-purged', fence('Purged claim', 'A kept claim'), '', {}],
      ['shapes/fence-kept', fence('A kept claim'), '', {}],
      ['shapes/fence-mixed-case', fence('MIXED   synthetic claim'), '', {}],
      ['shapes/fence-timeline-only', 'No fence in the body.', fence('Withdrawn everywhere claim'), {}],
      ['shapes/marker-mention', 'Mentions gbrain:facts: without a fence.', '', {}],
      ['shapes/fence-end-only', '<!--- gbrain:facts:end -->', '', {}],
      ['shapes/fence-unclosed', fence('Withdrawn everywhere claim') + '\n<!--- gbrain:facts:begin -->', '', {}],
      ['shapes/fence-broken', '<!--- gbrain:facts:begin -->\nbroken\n<!--- gbrain:facts:end -->', '', {}],
      ['shapes/frontmatter', 'Body.', '', { aliases: ['alpha-example', 'beta-example'], nested: { key: 'value', list: [1, 2, { deep: true }] },
        empty: '', nothing: null, date: '2026-01-01', unicode: 'ünïcödé — ✓', colon: 'a: b', quote: "it's \"quoted\"", multiline: 'one\ntwo' }],
      ['shapes/slug-in-frontmatter', 'Body.', '', { slug: 'shapes/another-slug', title: 'A frontmatter title' }],
      ['shapes/tagged', 'Tagged body.', '', { tags: ['zeta', 'alpha'] }],
    ];
    for (const [slug, compiled, timeline, frontmatter] of shapes) {
      await engine.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter) VALUES ('default',$1,'note',$1,$2,$3,$4::text::jsonb)",
        [slug, compiled, timeline, JSON.stringify(frontmatter)]);
    }
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
      SELECT 'default','bulk/p'||n,'note','Bulk '||n,CASE WHEN n%5=0 THEN $1 ELSE 'Bulk body '||n END,'','{}'::jsonb FROM generate_series(1,300) n`,
    [fence('Withdrawn everywhere claim', 'A kept claim')]);
    await engine.executeRaw(`INSERT INTO tags(page_id,tag) SELECT id,t FROM pages, unnest(ARRAY['zeta','alpha','mid']) t WHERE slug IN ('shapes/tagged','bulk/p7')`);
    await engine.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter,deleted_at) VALUES ('default','shapes/deleted','note','Deleted','Gone.','','{}'::jsonb,now())");
    // Reverse id order: the result follows the keys, not the table.
    const keys = await engine.executeRaw<{ id: string; source_id: string; slug: string }>("SELECT id::text,source_id,slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY id DESC");
    expect(keys.length).toBe(shapes.length + 300);
    await engine.transaction(async tx => {
      await tx.executeRaw('SET TRANSACTION READ ONLY');
      const withdrawals = await readExportWithdrawals(tx, 'default');
      const real = tx.executeRaw;
      let statements = 0;
      tx.executeRaw = async function (query, params, options) { statements++; return real.call(this, query, params, options) as never; };
      let batch;
      try { batch = await readExportPages(tx, keys, withdrawals); } finally { tx.executeRaw = real; }
      expect(statements).toBe(2);
      expect(batch.length).toBe(keys.length);
      let overlaid = 0;
      for (const [i, key] of keys.entries()) {
        const single = await referenceExportPage(tx, key, withdrawals);
        expect(batch[i]!.page.slug).toBe(key.slug);
        expect(JSON.stringify(batch[i])).toBe(JSON.stringify(single));
        expect(inlineExportMarkdown(batch[i]!)).toBe(inlineExportMarkdown(single));
        expect(JSON.stringify(await readExportPage(tx, key, withdrawals))).toBe(JSON.stringify(single));
        if ([single.page.compiled_truth, single.page.timeline].some(text => parseFactsFence(text).facts.some(fact => fact.active === false))) overlaid++;
      }
      // The overlay really ran: withdrawn rows read inactive in the fenced shapes and every fifth bulk page.
      expect(overlaid).toBeGreaterThan(60);
      expect(parseFactsFence(batch[keys.findIndex(key => key.slug === 'shapes/fence-subject')]!.page.compiled_truth).facts[0].active).toBe(false);
      expect(parseFactsFence(batch[keys.findIndex(key => key.slug === 'shapes/fence-other-subject')]!.page.compiled_truth).facts[0].active).toBe(true);
      expect(parseFactsFence(batch[keys.findIndex(key => key.slug === 'shapes/fence-purged')]!.page.compiled_truth).facts.map(fact => fact.claim)).toEqual(['A kept claim']);
      expect(batch[keys.findIndex(key => key.slug === 'shapes/tagged')]!.tags).toEqual(['alpha', 'mid', 'zeta']);
      expect(await readExportPages(tx, [], withdrawals)).toEqual([]);
      const [deleted] = await tx.executeRaw<{ id: string; source_id: string; slug: string }>("SELECT id::text,source_id,slug FROM pages WHERE slug='shapes/deleted'");
      await expect(readExportPages(tx, [keys[0]!, deleted!], withdrawals)).rejects.toThrow('Export snapshot unexpectedly lost a selected page.');
    });
  }, 60000);
  /**
   * Value: protects=a per-page export read (export.ts calls readExportPage once per page) looks its row up by primary key,
   * so exporting a large source stays linear; fails_when=readExportPages joins pages on the keys and the planner answers a
   * one-key join from the source index, filtering every page of the source; seam=the plan of the statement itself.
   */
  test('#7618: a one-key export read looks its page up by primary key and examines no other page', async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
      SELECT 'default','scale/p'||n,'note','Synthetic','A synthetic body.','','{}'::jsonb FROM generate_series(1,5000) n`);
    const [key] = await engine.executeRaw<{ id: string; source_id: string; slug: string }>("SELECT id::text AS id, source_id, slug FROM pages WHERE slug='scale/p2500'");
    const real = engine.executeRaw;
    let read: { query: string; params: unknown[] } | undefined;
    engine.executeRaw = async function (query, params, options) {
      if (!read && query.includes('export_tags')) read = { query, params: params ?? [] };
      return real.call(this, query, params, options) as never;
    };
    try { expect((await readExportPages(engine, [key!], []))[0]!.page.slug).toBe('scale/p2500'); }
    finally { engine.executeRaw = real; }
    const [row] = await engine.executeRaw<Record<string, unknown>>(`EXPLAIN (ANALYZE, FORMAT JSON) ${read!.query}`, read!.params);
    const raw = Object.values(row!)[0];
    const nodes: Record<string, unknown>[] = [];
    const walk = (node: Record<string, unknown>) => { nodes.push(node); for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child); };
    walk(((typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: Record<string, unknown> }[])[0]!.Plan);
    const scans = nodes.filter(node => node['Relation Name'] === 'pages');
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect(scan['Index Name']).toBe('pages_pkey');
      expect(Number(scan['Rows Removed by Filter'] ?? 0) + Number(scan['Rows Removed by Index Recheck'] ?? 0)).toBe(0);
    }
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
