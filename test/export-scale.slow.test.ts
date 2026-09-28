import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runExport } from '../src/commands/export.ts';
import { parseFactsFence, renderFactsTable } from '../src/core/facts-fence.ts';
import { ExportStage } from '../src/core/export-stage.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) describe(`export scale: ${backend}`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  }, 60000);
  afterAll(async () => { await engine.disconnect(); });
  test('exports all 100001 pages with bounded keyset enumeration', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'export-scale-')));
    const started = performance.now();
    let batches = 0, largestBatch = 0, ledgerReads = 0, normalizations = 0;
    let executeRawQueries = 0, rawQueries = 0, transactions = 0, stagingPayloadBytes = 0, stagingManifestBytes = 0;
    const real = engine.executeRaw, raw = engine.getRawData, transaction = engine.transaction, close = ExportStage.prototype.close;
    try {
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw("DELETE FROM fact_withdrawals WHERE source_id='default'");
      const fenced = renderFactsTable([{ rowNum: 1, claim: 'Synthetic withdrawn claim', kind: 'fact', confidence: 1,
        visibility: 'world', notability: 'medium', active: true, context: '' }]);
      await engine.executeRaw('ALTER TABLE pages DISABLE TRIGGER bump_page_generation_trg');
      try {
        await engine.executeRaw(`INSERT INTO pages (source_id,slug,type,title,compiled_truth,timeline,frontmatter,generation)
          SELECT 'default', 'scale/p' || lpad(n::text,6,'0'), 'note', 'Synthetic ' || n,
            'Body ' || n || CASE WHEN n%100=0 THEN chr(10)||$1 ELSE '' END, '', '{}'::jsonb, n
          FROM generate_series(1,100001) n`, [fenced]);
      } finally { await engine.executeRaw('ALTER TABLE pages ENABLE TRIGGER bump_page_generation_trg'); }
      await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
        SELECT 'default','world',gbrain_fact_fingerprint(CASE WHEN n=1 THEN 'Synthetic withdrawn claim'
          ELSE 'Unrelated synthetic claim '||n END) FROM generate_series(1,1000) n`);
      await engine.executeRaw("INSERT INTO tags(page_id,tag) SELECT id,'scale-tag' FROM pages WHERE right(slug,2)='00'");
      await engine.executeRaw("INSERT INTO raw_data(page_id,source,data) SELECT id,'feed',jsonb_build_object('slug',slug) FROM pages WHERE right(slug,2)='00'");
      const seededMs = performance.now() - started;
      console.log(JSON.stringify({ backend, seeded: 100001, seededMs: Math.round(seededMs) }));
      engine.executeRaw = async function (query: string, params?: unknown[], options?: never) {
        executeRawQueries++;
        const rows = await real.call(this, query, params, options);
        if (query.includes('ORDER BY p.id LIMIT 256')) { batches++; largestBatch = Math.max(largestBatch, rows.length); }
        if (query.includes('SELECT visibility,fact_hash,withdrawn_at')) ledgerReads++;
        if (query.includes('AS lines(line,ord)')) normalizations++;
        return rows as never;
      };
      engine.getRawData = async function (...args) { rawQueries++; return raw.apply(this, args); };
      engine.transaction = async function (fn) { transactions++; return transaction.call(this, fn) as never; };
      ExportStage.prototype.close = function () {
        stagingPayloadBytes = this.bytes;
        stagingManifestBytes = statSync(join(this.directory, 'manifest.sqlite')).size;
        return close.call(this);
      };
      await runExport(engine, ['--dir', dir]);
      expect(readdirSync(join(dir, 'scale')).filter(name => name.endsWith('.md')).length).toBe(100001);
      expect(readdirSync(join(dir, 'scale/.raw')).length).toBe(1000);
      expect(readFileSync(join(dir, 'scale/p100001.md'), 'utf8')).toContain('Body 100001');
      expect(readFileSync(join(dir, 'scale/p100000.md'), 'utf8')).toContain('scale-tag');
      expect(parseFactsFence(readFileSync(join(dir, 'scale/p100000.md'), 'utf8')).facts[0].active).toBe(false);
      expect(parseFactsFence(readFileSync(join(dir, 'scale/p000100.md'), 'utf8')).facts[0].active).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, 'scale/.raw/p100000.json'), 'utf8'))).toEqual({ feed: { slug: 'scale/p100000' } });
      expect(batches).toBe(392); expect(largestBatch).toBe(256);
      expect(ledgerReads).toBe(391); expect(normalizations).toBe(1000);
      expect(transactions).toBe(1); expect(rawQueries).toBe(1000);
      expect(executeRawQueries).toBe(100001 + 392 + 391 * 2 + 1000 + 2);
      expect(stagingPayloadBytes).toBeGreaterThan(100001);
      expect(stagingManifestBytes).toBeGreaterThan(stagingPayloadBytes);
      console.log(JSON.stringify({ backend, selected: 100001, processed: 100001, rawSidecars: 1000, taggedPages: 1000,
        withdrawals: 1000, fencedPages: 1000, ledgerReads, normalizations, blocked: 0, failed: 0, retries: 0,
        stagingPayloadBytes, stagingManifestBytes, executeRawQueries, rawQueries, transactions,
        totalSqlStatements: executeRawQueries + rawQueries + transactions * 2,
        batches, largestBatch, durationMs: Math.round(performance.now() - started), exportMs: Math.round(performance.now() - started - seededMs), peakRssKb: process.resourceUsage().maxRSS }));
    } finally {
      engine.executeRaw = real; engine.getRawData = raw; engine.transaction = transaction; ExportStage.prototype.close = close;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 900000);
});
