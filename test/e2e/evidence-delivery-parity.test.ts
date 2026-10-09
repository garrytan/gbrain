/**
 * Evidence delivery engine parity (PGLite vs Postgres) and product-path
 * parity (plan amendment 8 / E3):
 *   - the off-path golden holds on Postgres too (a config-level chunk unit is
 *     byte-identical to the pre-feature release fixture);
 *   - getChunkWindows returns the same windows, authorization and seal
 *     decisions on both engines;
 *   - for the same ordered hits, `query`/`search` and `assemble_evidence`
 *     produce the same evidence fingerprint, and both engines deliver the
 *     same text for every unit;
 *   - the implied `auto` default (return_unit omitted) delivers exactly what
 *     `assemble_evidence` with `auto` delivers for the same hits;
 *   - under an explicit budget (the cap, every search.auto_packing value)
 *     live `query`/`search` and frozen-hit assembly deliver the same fields a
 *     reader consumes, effective_date included, within the budget, on both
 *     engines.
 *
 * Postgres arm runs when DATABASE_URL is set.
 *
 * The off-path golden is a keyless capture: with an embedding key the query
 * family turns on the vector path and the reranker, which changes the
 * retrieval meta and can reorder rows (the nightly full-corpus lane carries
 * OPENAI_API_KEY and ANTHROPIC_API_KEY, run 37273083933). So the golden is
 * compared under an explicitly keyless gateway in every lane, and a keyed lane
 * additionally checks the keyed capture: key-independent calls (keyword search,
 * think's prompt) still match the frozen bytes, and query/recall report the
 * vector path as on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { AUTO_PACKINGS, assembleEvidenceForHits, countEvidenceTokens, evidenceFingerprint, pageEvidenceText } from '../../src/core/search/evidence-delivery.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { captureOffPath, seedOffPath, withCostWave } from '../helpers/evidence-delivery-fixture.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { PROVIDER_ENV_KEYS } from '../helpers/provider-env.ts';
import { emptyHome, withEnv } from '../helpers/with-env.ts';

const FIXTURE = join(import.meta.dir, '../fixtures/goldens/evidence-delivery/off-path.json');
const backends = process.env.DATABASE_URL ? ['pglite', 'postgres'] as const : ['pglite'] as const;
const UNITS = ['window', 'section', 'page', 'auto'] as const;
const engines: Partial<Record<(typeof backends)[number], BrainEngine>> = {};
const closers: Array<() => Promise<void>> = [];

function ctxOf(engine: BrainEngine, remote = false): OperationContext {
  return { engine: engine as never, config: {} as never, logger: console as never, dryRun: false, remote, sourceId: 'default' } as OperationContext;
}

const op = (name: string) => operations.find(o => o.name === name)!;
const keyedLane = PROVIDER_ENV_KEYS.some(k => k.endsWith('_API_KEY') && process.env[k]);
const gatewayFromProcessEnv = () => configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { ...process.env } });

async function keyless<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await withEnv({ ...Object.fromEntries(PROVIDER_ENV_KEYS.map(k => [k, undefined])), GBRAIN_HOME: emptyHome() }, async () => {
      gatewayFromProcessEnv();
      return fn();
    });
  } finally {
    gatewayFromProcessEnv();
  }
}

const KEY_INDEPENDENT = /^(search|search-remote|search-subagent|mcp-search)(:chunk)?$|^think-prompt$/;

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
      const engine = engines[backend]!;
      const want = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
      await engine.setConfig('search.return_unit', 'chunk');
      await engine.setConfig('think.return_unit', 'chunk');
      try {
        const got = await keyless(() => captureOffPath(engine));
        for (const key of Object.keys(want)) expect(`${key}: ${got[key]}`).toBe(`${key}: ${withCostWave(key, want[key])}`);
        if (keyedLane) {
          const keyed = await captureOffPath(engine);
          const independent = Object.keys(want).filter(k => KEY_INDEPENDENT.test(k));
          expect(independent.length).toBe(8);
          for (const key of independent) expect(`${key}: ${keyed[key]}`).toBe(`${key}: ${withCostWave(key, want[key])}`);
          for (const key of Object.keys(want).filter(k => /^query/.test(k))) {
            const retrieval = (JSON.parse(keyed[key]).meta as Array<{ key: string; value: { vector_enabled: boolean; degraded?: Array<{ stage: string }> } }>)
              .find(m => m.key === 'retrieval')!.value;
            expect(`${key}: vector_enabled=${retrieval.vector_enabled}`).toBe(`${key}: vector_enabled=true`);
            expect((retrieval.degraded ?? []).map(d => d.stage)).not.toContain('embed_unavailable');
          }
          for (const key of Object.keys(want).filter(k => /^recall/.test(k))) {
            expect(JSON.parse(keyed[key]).result.search_degraded).toBeUndefined();
          }
        }
      } finally {
        await engine.executeRaw(`DELETE FROM config WHERE key IN ('search.return_unit', 'think.return_unit')`);
      }
    }, 120_000);

    test(`the implied auto default matches assemble_evidence auto for the same hits (${backend})`, async () => {
      const engine = engines[backend]!;
      let expanded = 0;
      for (const remote of [false, true]) {
        for (const query of ['ocelot', 'ocelot renewal roadmap']) {
          // fields: 'full': these checks compare complete rows (page_id, delivered) with assemble_evidence.
          const hits = await op('search').handler(ctxOf(engine, remote), { fields: 'full', query, return_unit: 'chunk' }) as SearchResult[];
          const viaDefault = await op('search').handler(ctxOf(engine, remote), { fields: 'full', query }) as SearchResult[];
          const viaAssemble = await op('assemble_evidence').handler(ctxOf(engine, remote), {
            hits: hits.map(h => ({ source_id: h.source_id, slug: h.slug, chunk_id: h.chunk_id })), return_unit: 'auto',
          }) as { results: SearchResult[] };
          expect(evidenceFingerprint(viaAssemble.results)).toBe(evidenceFingerprint(viaDefault));
          const chat = viaDefault.filter(r => r.slug === 'chat/session-a');
          for (const r of chat) {
            const [page] = await engine.executeRaw<{ compiled_truth: string; timeline: string }>('SELECT compiled_truth, timeline FROM pages WHERE id = $1', [r.page_id]);
            expect(r.delivered).toMatchObject({ unit: 'page', reason: 'conversation_slug' });
            expect(r.chunk_text).toBe(pageEvidenceText(page, true).text.trimEnd());
            expanded++;
          }
        }
      }
      expect(expanded).toBeGreaterThan(0);
    }, 120_000);

    test(`an explicit budget delivers the same capped, dated evidence live and from frozen hits, every packing (${backend})`, async () => {
      const engine = engines[backend]!;
      const recount = (rows: SearchResult[]) => rows.reduce((n, r) => n + countEvidenceTokens(r.title ?? '') + countEvidenceTokens(r.chunk_text), 0);
      const consumed = (rows: SearchResult[]) => rows.map(r => ({
        slug: r.slug, title: r.title, chunk_text: r.chunk_text, effective_date: r.effective_date ?? null, effective_date_source: r.effective_date_source ?? null,
        unit: r.delivered?.unit, spans: r.delivered?.match_spans, tokens: r.delivered?.tokens, truncated: r.delivered?.truncated, reason: r.delivered?.reason,
      }));
      await engine.executeRaw(`UPDATE pages SET effective_date = '2026-02-03', effective_date_source = 'frontmatter' WHERE slug = 'chat/session-a'`);
      try {
        let dated = 0;
        for (const packing of AUTO_PACKINGS) {
          await engine.setConfig('search.auto_packing', packing);
          for (const remote of [false, true]) {
            const hits = await op('query').handler(ctxOf(engine, remote), { fields: 'full', query: 'ocelot', expand: false, return_unit: 'chunk' }) as SearchResult[];
            for (const budget of [400, 2500]) {
              const live = await op('query').handler(ctxOf(engine, remote), { fields: 'full', query: 'ocelot', expand: false, return_unit: 'auto', token_budget: budget }) as SearchResult[];
              const viaOp = await op('assemble_evidence').handler(ctxOf(engine, remote), {
                hits: hits.map(h => ({ source_id: h.source_id, slug: h.slug, chunk_id: h.chunk_id })), return_unit: 'auto', token_budget: budget,
              }) as { results: SearchResult[] };
              const viaLib = await assembleEvidenceForHits(engine, {
                hits: hits.map(h => ({ source_id: h.source_id!, slug: h.slug, chunk_id: h.chunk_id })), return_unit: 'auto', budget_tokens: budget, auto_packing: packing, caller: { remote },
              });
              const label = `${packing} remote=${remote} @${budget}`;
              expect(consumed(viaOp.results), label).toEqual(consumed(live));
              expect(consumed(viaLib.results as SearchResult[]), label).toEqual(consumed(live));
              if (packing !== 'off') expect(recount(live), label).toBeLessThanOrEqual(budget);
              dated += live.filter(r => r.slug === 'chat/session-a' && r.effective_date === '2026-02-03').length;
            }
          }
        }
        expect(dated).toBeGreaterThan(0);
      } finally {
        await engine.executeRaw(`UPDATE pages SET effective_date = NULL, effective_date_source = NULL WHERE slug = 'chat/session-a'`);
        await engine.executeRaw(`DELETE FROM config WHERE key = 'search.auto_packing'`);
      }
    }, 120_000);

    test(`page evidence is byte-identical to the stored body minus frontmatter and protected content (${backend})`, async () => {
      const engine = engines[backend]!;
      for (const remote of [false, true]) {
        const rows = await op('search').handler(ctxOf(engine, remote), { fields: 'full', query: 'ocelot', return_unit: 'page', token_budget: 32000 }) as SearchResult[];
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
        const hits = await op('search').handler(ctxOf(engine, remote), { fields: 'full', query: 'ocelot' }) as SearchResult[];
        expect(hits.length).toBeGreaterThan(0);
        for (const unit of UNITS) {
          const viaSearch = await op('search').handler(ctxOf(engine, remote), { fields: 'full', query: 'ocelot', return_unit: unit, token_budget: 2500 }) as SearchResult[];
          const viaAssemble = await op('assemble_evidence').handler(ctxOf(engine, remote), {
            hits: hits.map(h => ({ source_id: h.source_id, slug: h.slug, chunk_id: h.chunk_id })), return_unit: unit, token_budget: 2500,
          }) as { results: SearchResult[] };
          expect(evidenceFingerprint(viaAssemble.results)).toBe(evidenceFingerprint(viaSearch));
        }
        const qHits = await op('query').handler(ctxOf(engine, remote), { fields: 'full', query: 'ocelot pricing', expand: false }) as SearchResult[];
        const viaQuery = await op('query').handler(ctxOf(engine, remote), { fields: 'full', query: 'ocelot pricing', expand: false, return_unit: 'page', token_budget: 2500 }) as SearchResult[];
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
      for (const unit of [...UNITS, undefined]) {
        const ra = await op('search').handler(ctxOf(a), { fields: 'full', query: 'ocelot', return_unit: unit, token_budget: 2500 }) as SearchResult[];
        const rb = await op('search').handler(ctxOf(b), { fields: 'full', query: 'ocelot', return_unit: unit, token_budget: 2500 }) as SearchResult[];
        expect(textOf(rb)).toEqual(textOf(ra));
      }
      for (const packing of AUTO_PACKINGS) {
        for (const engine of [a, b]) await engine.setConfig('search.auto_packing', packing);
        try {
          for (const budget of [300, 2500]) {
            const ra = await op('query').handler(ctxOf(a), { fields: 'full', query: 'ocelot', expand: false, return_unit: 'auto', token_budget: budget }) as SearchResult[];
            const rb = await op('query').handler(ctxOf(b), { fields: 'full', query: 'ocelot', expand: false, return_unit: 'auto', token_budget: budget }) as SearchResult[];
            expect(textOf(rb), `${packing} @${budget}`).toEqual(textOf(ra));
          }
        } finally {
          for (const engine of [a, b]) await engine.executeRaw(`DELETE FROM config WHERE key = 'search.auto_packing'`);
        }
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
