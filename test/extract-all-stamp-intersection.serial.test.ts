/**
 * S4 (P2.18, R11): `extract all --source db` stamped every page's combined links+timeline watermark from the links
 * phase, before the timeline phase ran. A timeline phase that threw (or a page edited between the phases) left pages
 * marked fresh whose timeline was never extracted. Each phase now reports the pages it completed, keyed by revision,
 * to the caller, which stamps their intersection in a finally. Synthetic content.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const sourceId = 'stamp-intersection';
const PAGES = 105;
const slug = (i: number) => `notes/p-${String(i).padStart(3, '0')}`;

for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])]) {
  describe(`extract all --source db stamps only what both phases completed (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; close = pg.close; }
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
      for (let i = 0; i < PAGES; i++) {
        await engine.putPage(slug(i), { type: 'note', title: slug(i), compiled_truth: `Links [[${slug((i + 1) % PAGES)}]].`, timeline: `- **2024-01-${String(1 + (i % 28)).padStart(2, '0')}** | Event ${i}` }, { sourceId });
      }
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('a timeline phase that throws after its first batch committed: those pages are stamped, the rest and an edited page are not', async () => {
      await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1', [sourceId]);
      const original = engine.readPageSnapshotsBatch;
      let calls = 0;
      // The timeline phase's reads (readTimelineBatch): before its first, another writer edits the first page; its second throws.
      engine.readPageSnapshotsBatch = async function (this: BrainEngine, ...args) {
        if (new Error().stack?.includes('readTimelineBatch')) {
          calls++;
          if (calls === 1) await engine.putPage(slug(0), { type: 'note', title: slug(0), compiled_truth: 'Edited between phases.', timeline: '- **2024-02-01** | Edited' }, { sourceId });
          if (calls === 2) throw new Error('timeline read failed');
        }
        // A transaction's engine inherits this method: keep its own receiver.
        return original.apply(this, args);
      };
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`extract exited ${code}`); });
      try {
        await expect(runExtract(engine, ['all', '--source', 'db', '--source-id', sourceId, '--json'])).rejects.toThrow('extract exited 1');
      } finally {
        engine.readPageSnapshotsBatch = original;
        errorSpy.mockRestore(); logSpy.mockRestore(); exitSpy.mockRestore();
      }
      expect(calls).toBe(2);
      const rows = await engine.executeRaw<{ slug: string; stamped: boolean }>(
        'SELECT slug,links_extracted_at IS NOT NULL AS stamped FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId]);
      const stamped = new Set(rows.filter(r => r.stamped).map(r => r.slug));
      // Timeline's first batch (pages 0..99) committed; page 0 moved between the phases, so its two completions differ.
      for (let i = 1; i < 100; i++) expect(stamped.has(slug(i))).toBe(true);
      expect(stamped.has(slug(0))).toBe(false);
      for (let i = 100; i < PAGES; i++) expect(stamped.has(slug(i))).toBe(false);
    }, 180_000);

    test('a clean run stamps every page', async () => {
      await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1', [sourceId]);
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      try { await runExtract(engine, ['all', '--source', 'db', '--source-id', sourceId, '--json']); } finally { logSpy.mockRestore(); }
      const [row] = await engine.executeRaw<{ n: number | string }>('SELECT count(*) AS n FROM pages WHERE source_id=$1 AND links_extracted_at IS NULL', [sourceId]);
      expect(Number(row!.n)).toBe(0);
    }, 180_000);
  });
}
