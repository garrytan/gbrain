/**
 * Evidence delivery engine parity (PGLite vs Postgres) and product-path
 * parity (plan amendment 8 / E3):
 *   - the off-path golden holds on Postgres too (byte-identical to the
 *     pre-feature release fixture);
 *   - getChunkWindows returns the same windows, authorization and seal
 *     decisions on both engines;
 *   - for the same ordered hits, `query`/`search` and `assemble_evidence`
 *     produce the same evidence fingerprint, and both engines deliver the
 *     same text for every unit.
 *
 * Postgres arm runs when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { evidenceFingerprint, pageEvidenceText } from '../../src/core/search/evidence-delivery.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { captureOffPath, seedOffPath } from '../helpers/evidence-delivery-fixture.ts';

const FIXTURE = join(import.meta.dir, '../fixtures/goldens/evidence-delivery/off-path.json');
const backends = process.env.DATABASE_URL ? ['pglite', 'postgres'] as const : ['pglite'] as const;
const UNITS = ['window', 'section', 'page', 'auto'] as const;
const engines: Partial<Record<(typeof backends)[number], BrainEngine>> = {};
const closers: Array<() => Promise<void>> = [];

function ctxOf(engine: BrainEngine, remote = false): OperationContext {
  return { engine: engine as never, config: {} as never, logger: console as never, dryRun: false, remote, sourceId: 'default' } as OperationContext;
}

const op = (name: string) => operations.find(o => o.name === name)!;

beforeAll(async () => {
  for (const backend of backends) {
    let engine: BrainEngine;
    if (backend === 'postgres') {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = isolated.engine;
      closers.push(isolated.close);
    } else {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      closers.push(() => engine.disconnect());
    }
    await seedOffPath(engine);
    engines[backend] = engine;
  }
}, 240_000);

afterAll(async () => {
  for (const close of closers) await close();
}, 120_000);

describe('evidence delivery parity', () => {
  for (const backend of backends) {
    test(`off-path output is byte-identical to the pre-feature release (${backend})`, async () => {
      const want = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
      const got = await captureOffPath(engines[backend]!);
      for (const key of Object.keys(want)) expect(`${key}: ${got[key]}`).toBe(`${key}: ${want[key]}`);
    }, 120_000);

    test(`page evidence is byte-identical to the stored body minus frontmatter and protected content (${backend})`, async () => {
      const engine = engines[backend]!;
      for (const remote of [false, true]) {
        const rows = await op('search').handler(ctxOf(engine, remote), { query: 'ocelot', return_unit: 'page', token_budget: 32000 }) as SearchResult[];
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
          const [page] = await engine.executeRaw<{ compiled_truth: string; timeline: string }>('SELECT compiled_truth, timeline FROM pages WHERE id = $1', [r.page_id]);
          expect(r.chunk_text).toBe(pageEvidenceText(page, true).text.trimEnd());
        }
      }
    }, 120_000);

    test(`search/query and assemble_evidence deliver identical evidence for the same hits (${backend})`, async () => {
      const engine = engines[backend]!;
      for (const remote of [false, true]) {
        const hits = await op('search').handler(ctxOf(engine, remote), { query: 'ocelot' }) as SearchResult[];
        expect(hits.length).toBeGreaterThan(0);
        for (const unit of UNITS) {
          const viaSearch = await op('search').handler(ctxOf(engine, remote), { query: 'ocelot', return_unit: unit, token_budget: 2500 }) as SearchResult[];
          const viaAssemble = await op('assemble_evidence').handler(ctxOf(engine, remote), {
            hits: hits.map(h => ({ source_id: h.source_id, slug: h.slug, chunk_id: h.chunk_id })), return_unit: unit, token_budget: 2500,
          }) as { results: SearchResult[] };
          expect(evidenceFingerprint(viaAssemble.results)).toBe(evidenceFingerprint(viaSearch));
        }
        const qHits = await op('query').handler(ctxOf(engine, remote), { query: 'ocelot pricing', expand: false }) as SearchResult[];
        const viaQuery = await op('query').handler(ctxOf(engine, remote), { query: 'ocelot pricing', expand: false, return_unit: 'page', token_budget: 2500 }) as SearchResult[];
        const viaAssemble = await op('assemble_evidence').handler(ctxOf(engine, remote), {
          hits: qHits.map(h => ({ source_id: h.source_id, slug: h.slug, chunk_id: h.chunk_id })), return_unit: 'page', token_budget: 2500,
        }) as { results: SearchResult[] };
        expect(evidenceFingerprint(viaAssemble.results)).toBe(evidenceFingerprint(viaQuery));
      }
    }, 120_000);
  }

  if (backends.length === 2) {
    test('both engines deliver the same windows and the same text for every unit', async () => {
      const [a, b] = [engines.pglite!, engines.postgres!];
      const textOf = (rows: SearchResult[]) => rows.map(r => [r.slug, r.chunk_text, r.delivered?.unit, r.delivered?.tokens, r.delivered?.truncated]);
      for (const unit of UNITS) {
        const ra = await op('search').handler(ctxOf(a), { query: 'ocelot', return_unit: unit, token_budget: 2500 }) as SearchResult[];
        const rb = await op('search').handler(ctxOf(b), { query: 'ocelot', return_unit: unit, token_budget: 2500 }) as SearchResult[];
        expect(textOf(rb)).toEqual(textOf(ra));
      }
      const windows = async (engine: BrainEngine) => {
        const ids = await engine.executeRaw<{ id: number; slug: string }>(`SELECT id, slug FROM pages ORDER BY slug`);
        const pages = await engine.getChunkWindows(ids.map((p, i) => ({ page_id: p.id, from_index: 0, to_index: 3, priority: i })),
          { excludePrivate: true, requireSafeChunks: true, chunkSources: ['compiled_truth', 'timeline'], maxRows: 5 });
        return pages.map(p => ({ slug: p.slug, sealed: p.sealed, max: p.max_chunk_index, limited: p.row_limited, chunks: p.chunks.map(c => [c.chunk_index, c.chunk_source, c.chunk_text]) }));
      };
      expect(await windows(b)).toEqual(await windows(a));
    }, 120_000);
  }
});
