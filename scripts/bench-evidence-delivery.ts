#!/usr/bin/env bun
/**
 * Evidence delivery latency benchmark (plan amendment 10).
 *
 *   bun scripts/bench-evidence-delivery.ts [--pages 10000] [--iterations 200] [--postgres <url>] [--json]
 *
 * Builds a synthetic brain (in-memory PGLite, or a fresh database on the
 * given test Postgres server) with a realistic page-size mix: 60% curated
 * notes (3-12 chunks, headed sections), 30% conversation sessions (6-24
 * chunks), 5% large pages (120 chunks) and 5% CJK pages. Chunks are written
 * sealed and projection-current, exactly as the importer leaves them; each
 * page's body is stored too (evidence text is cut from the sanitized body).
 *
 * Measures the ADDED latency of the evidence stage (deliverEvidence: one
 * batched getChunkWindows call + body sanitizing, chunk location, cutting,
 * token counting and packing) for every unit, on ranked hit lists of 5 hits over distinct
 * random pages, with a 6,000-token budget:
 *   - cold: the first call per unit after connect;
 *   - warm p50 / p95 over --iterations calls;
 *   - large-page and CJK-only hit lists;
 *   - 8 concurrent requests (per-request p95);
 * and reports rows/bytes read per request (bounded work, no N+1: the stage
 * issues exactly one engine call per request, counted here).
 */
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { deliverEvidence, type EvidencePlan } from '../src/core/search/evidence-delivery.ts';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const PAGES = Number(arg('--pages') ?? 10000);
const ITER = Number(arg('--iterations') ?? 200);
const databaseUrl = arg('--postgres');
const json = process.argv.includes('--json');
const UNITS = ['window', 'section', 'page', 'auto'] as const;
const BUDGET = 6000;

let seed = 20260930;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const WORDS = ['alpha', 'river', 'launch', 'march', 'budget', 'widget', 'acme', 'notes', 'said', 'moved', 'plan', 'review', 'quarter', 'team', 'draft', 'owner'];
const sentence = () => Array.from({ length: 8 + Math.floor(rand() * 10) }, () => pick(WORDS)).join(' ') + '.';
const para = (n: number) => Array.from({ length: n }, sentence).join(' ');
const CJK = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏';

/** One chunk (~1,600 chars) per kind; the 50-word overlap is reproduced like the chunker. */
function chunkTexts(kind: 'note' | 'chat' | 'large' | 'cjk', count: number): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < count; i++) {
    if (kind === 'chat') bodies.push(Array.from({ length: 4 }, (_, t) => `**${t % 2 ? 'assistant' : 'user'}:** ${para(3)}`).join('\n\n'));
    else if (kind === 'cjk') bodies.push(Array.from({ length: 600 }, () => pick(CJK.split(''))).join('').replace(/(.{60})/g, '$1。'));
    else bodies.push(`${i % 3 === 0 ? `## Section ${i}\n\n` : ''}${para(6)}\n\n${para(6)}`);
  }
  return bodies;
}

/** The chunks the chunker would store for these bodies: each carries the previous body's last 50 words. */
function overlapped(bodies: string[], kind: string): string[] {
  return bodies.map((b, i) => (i === 0 || kind === 'cjk' ? b : `${bodies[i - 1].split(' ').slice(-50).join(' ')}\n\n${b}`));
}

async function build(engine: BrainEngine): Promise<Array<{ id: number; kind: string; chunks: number }>> {
  const pages: Array<{ id: number; kind: string; chunks: number }> = [];
  const BATCH = 500;
  for (let start = 0; start < PAGES; start += BATCH) {
    const slugs: string[] = []; const kinds: string[] = [];
    for (let i = start; i < Math.min(PAGES, start + BATCH); i++) {
      const r = rand();
      kinds.push(r < 0.6 ? 'note' : r < 0.9 ? 'chat' : r < 0.95 ? 'large' : 'cjk');
      slugs.push(`bench/p${i}`);
    }
    const bodies = kinds.map(kind => chunkTexts(kind as 'note', kind === 'note' ? 3 + Math.floor(rand() * 10) : kind === 'chat' ? 6 + Math.floor(rand() * 19) : kind === 'large' ? 120 : 8));
    const rows = await engine.executeRaw<{ id: number; slug: string }>(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline, source_id)
       SELECT s, 'note', s, b, '', 'default' FROM unnest($1::text[], $2::text[]) AS t(s, b) RETURNING id, slug`,
      [slugs, bodies.map(b => b.join('\n\n'))]);
    const pageIds: number[] = []; const idx: number[] = []; const texts: string[] = [];
    for (const row of rows) {
      const k = slugs.indexOf(row.slug);
      overlapped(bodies[k], kinds[k]).forEach((t, i) => { pageIds.push(row.id); idx.push(i); texts.push(t); });
      pages.push({ id: row.id, kind: kinds[k], chunks: bodies[k].length });
    }
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
       SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::text[])`,
      [pageIds, idx, texts, texts.map(() => 'compiled_truth')]);
  }
  await engine.executeRaw(`UPDATE pages SET chunker_version = 4, text_projection_revision = knowledge_revision WHERE slug LIKE 'bench/%'`);
  await engine.executeRaw('ANALYZE');
  return pages;
}

async function hitsFor(engine: BrainEngine, pages: Array<{ id: number; chunks: number }>): Promise<SearchResult[]> {
  const chosen = new Map<number, number>();
  while (chosen.size < Math.min(5, pages.length)) {
    const p = pick(pages);
    chosen.set(p.id, Math.floor(rand() * p.chunks));
  }
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT cc.id, cc.page_id, cc.chunk_index, cc.chunk_text, p.slug, p.title FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE (cc.page_id, cc.chunk_index) IN (SELECT * FROM unnest($1::int[], $2::int[]))`,
    [[...chosen.keys()], [...chosen.values()]]);
  return rows.map(r => ({
    slug: String(r.slug), page_id: Number(r.page_id), title: String(r.title), type: 'note', chunk_text: String(r.chunk_text),
    chunk_source: 'compiled_truth', chunk_id: Number(r.id), chunk_index: Number(r.chunk_index), score: 1, stale: false, source_id: 'default',
  }) as SearchResult);
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const r1 = (n: number) => Math.round(n * 10) / 10;

async function main() {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  if (databaseUrl) {
    const { isolatedPersistencePostgres } = await import('../test/helpers/persistence-postgres.ts');
    ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
  } else {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    close = () => engine.disconnect();
  }
  const t0 = performance.now();
  const pages = await build(engine);
  const buildMs = performance.now() - t0;
  let calls = 0; let rowsRead = 0; let bytesRead = 0;
  const counted = new Proxy(engine, {
    get(target, prop, recv) {
      if (prop !== 'getChunkWindows') return Reflect.get(target, prop, recv);
      return async (...args: Parameters<BrainEngine['getChunkWindows']>) => {
        calls++;
        const out = await target.getChunkWindows(...args);
        for (const p of out) { rowsRead += p.chunks.length; bytesRead += p.compiled_truth.length + p.timeline.length; for (const c of p.chunks) bytesRead += c.chunk_text.length; }
        return out;
      };
    },
  }) as BrainEngine;
  const plan = (unit: EvidencePlan['unit']): EvidencePlan => ({ requestedUnit: unit, unit, window: 1, budgetTokens: BUDGET, explicitUnit: true });
  const scope = { excludePrivate: true, requireSafeChunks: true };
  const results: Record<string, unknown>[] = [];
  const large = pages.filter(p => p.kind === 'large');
  const cjk = pages.filter(p => p.kind === 'cjk');
  for (const unit of UNITS) {
    const coldHits = await hitsFor(engine, pages);
    let s = performance.now();
    await deliverEvidence(counted, coldHits, plan(unit), scope);
    const cold = performance.now() - s;
    const warm: number[] = [];
    calls = 0; rowsRead = 0; bytesRead = 0;
    for (let i = 0; i < ITER; i++) {
      const hits = await hitsFor(engine, pages);
      s = performance.now();
      await deliverEvidence(counted, hits, plan(unit), scope);
      warm.push(performance.now() - s);
    }
    const callsPerRequest = calls / ITER;
    const rowsPerRequest = rowsRead / ITER;
    const bytesPerRequest = bytesRead / ITER;
    const special = async (subset: typeof pages) => {
      const xs: number[] = [];
      for (let i = 0; i < Math.min(60, ITER); i++) {
        const hits = await hitsFor(engine, subset);
        s = performance.now();
        await deliverEvidence(engine, hits, plan(unit), scope);
        xs.push(performance.now() - s);
      }
      return { p50: r1(pct(xs, 0.5)), p95: r1(pct(xs, 0.95)) };
    };
    const conc: number[] = [];
    for (let round = 0; round < Math.max(5, ITER / 20); round++) {
      const batch = await Promise.all(Array.from({ length: 8 }, () => hitsFor(engine, pages)));
      await Promise.all(batch.map(async hits => {
        const t = performance.now();
        await deliverEvidence(engine, hits, plan(unit), scope);
        conc.push(performance.now() - t);
      }));
    }
    results.push({
      unit, cold_ms: r1(cold), warm_p50_ms: r1(pct(warm, 0.5)), warm_p95_ms: r1(pct(warm, 0.95)),
      large_page: await special(large), cjk: await special(cjk),
      concurrent8_p95_ms: r1(pct(conc, 0.95)),
      engine_calls_per_request: callsPerRequest, rows_per_request: r1(rowsPerRequest), kb_per_request: r1(bytesPerRequest / 1024),
    });
  }
  await close();
  const summary = { engine: databaseUrl ? 'postgres' : 'pglite', pages: PAGES, iterations: ITER, budget_tokens: BUDGET, build_s: r1(buildMs / 1000), results };
  if (json) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`evidence delivery bench — ${summary.engine}, ${PAGES} pages, ${ITER} warm iterations, budget ${BUDGET}`);
  console.log('| unit | cold ms | warm p50 | warm p95 | large p95 | CJK p95 | 8-conc p95 | calls/req | rows/req | KB/req |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results as Array<Record<string, any>>) {
    console.log(`| ${r.unit} | ${r.cold_ms} | ${r.warm_p50_ms} | ${r.warm_p95_ms} | ${r.large_page.p95} | ${r.cjk.p95} | ${r.concurrent8_p95_ms} | ${r.engine_calls_per_request} | ${r.rows_per_request} | ${r.kb_per_request} |`);
  }
}

await main();
