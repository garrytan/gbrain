#!/usr/bin/env bun
/**
 * Broad-term keyword probe (#7082): times the Postgres keyword statements for
 * broad, medium and rare terms on a corpus.ts brain and prints their plans.
 * Opt-in bench code, never run in CI.
 *
 *   bun scripts/bench/retrieval-scale/keyword-broad.ts --url <direct postgres url> [--terms a,b,c] [--n 10]
 *     [--calls arm,arm_phrase,arm_remote,arm_all_sources,arm_small_source,arm_person,pages,pages_remote,count] [--explain <dir>] [--label <name>] [--out results.jsonl]
 *     [--rows rows.jsonl] [--tree <checkout>] [--no-share]
 *
 * Without --terms it picks one term per band from a 1% sample of chunks
 * (broad: 20-40% of chunks, medium: 1-5%, rare: under 0.05%) and reports each
 * term's exact share. For every term it times, --n times each, the hybrid
 * keyword arm (searchKeyword with orFallback, limit 50: plain, with the
 * keyword phrase factor, and with an MCP caller's excludePrivate and
 * requireSafeChunks, alone, scoped to every live source as the search
 * operation scopes it, and narrowed to the smallest source or to person pages), the keyword-mode page statement (searchKeywordPages,
 * limit 20, local and MCP scope) and the strict page count, with the configured statement timeout
 * lifted to 120 s so a slow statement is measured instead of cancelled.
 * --explain writes EXPLAIN (ANALYZE, BUFFERS) of each captured statement,
 * run with the same transaction-local settings. --tree runs another
 * checkout's engine (for example master) against the same brain; --rows writes
 * each call's first result list (slug, chunk id, score) so two trees can be diffed.
 * --no-share skips counting each term's matches, which reads every match and
 * would warm the cache ahead of a cold measurement.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from '#postgres';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const url = flag('--url')!;
const N = Number(flag('--n', '10'));
const explainDir = flag('--explain');
const out = flag('--out');
const tree = resolve(flag('--tree', resolve(import.meta.dir, '..', '..', '..'))!);
const label = flag('--label', 'tree');
const rowsOut = flag('--rows');
const sql = postgres(url, { max: 2, prepare: false, onnotice: () => {} });

async function pickTerms(): Promise<Array<{ band: string; term: string }>> {
  const stats = await sql.unsafe("SELECT word, ndoc FROM ts_stat('SELECT search_vector FROM content_chunks TABLESAMPLE SYSTEM (1) REPEATABLE (7)') ORDER BY ndoc DESC") as Array<{ word: string; ndoc: number }>;
  const [{ n }] = await sql.unsafe('SELECT count(*)::int AS n FROM content_chunks TABLESAMPLE SYSTEM (1) REPEATABLE (7)') as any;
  const share = (w: { ndoc: number }) => Number(w.ndoc) / n;
  const pick = (lo: number, hi: number) => stats.find(w => /^[a-z]{4,}$/.test(w.word) && share(w) >= lo && share(w) < hi)?.word;
  return [['broad', pick(0.2, 0.4)], ['medium', pick(0.01, 0.05)], ['rare', pick(0.00005, 0.0005)]]
    .filter(([, t]) => t).map(([band, term]) => ({ band: band!, term: term! }));
}

const terms = flag('--terms') ? flag('--terms')!.split(',').map(t => ({ band: 'given', term: t })) : await pickTerms();
const [{ chunks }] = await sql.unsafe('SELECT count(*)::int AS chunks FROM content_chunks') as any;
const liveSources = (await sql.unsafe('SELECT id FROM sources WHERE NOT archived ORDER BY id') as Array<{ id: string }>).map(r => r.id);

const { createEngine } = await import(join(tree, 'src/core/engine-factory.ts'));
const engine = await createEngine({ engine: 'postgres' });
await engine.connect({ database_url: url });
const target = engine as unknown as Record<string, any>;
target.keywordStatementTimeoutSetting = async () => '120s';
let captured: Array<{ sql: string; params: unknown[]; settings: Record<string, unknown> }> = [];
const original = target.withScopedReadTransaction;
target.withScopedReadTransaction = function (ids: unknown, id: unknown, callback: (tx: any) => unknown, opts: any) {
  return original.call(this, ids, id, (tx: any) => callback(new Proxy(tx, {
    get(t, prop, receiver) {
      if (prop !== 'unsafe') return Reflect.get(t, prop, receiver);
      return (text: string, params: unknown[]) => { captured.push({ sql: text, params, settings: opts?.settings ?? {} }); return t.unsafe(text, params); };
    },
  })), opts);
};

const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!; };
const calls: Record<string, (term: string) => Promise<unknown[] | number>> = {
  arm: term => engine.searchKeyword(term, { limit: 50, orFallback: true }),
  arm_phrase: term => engine.searchKeyword(term, { limit: 50, orFallback: true, keywordPhrase: true }),
  arm_remote: term => engine.searchKeyword(term, { limit: 50, orFallback: true, excludePrivate: true, requireSafeChunks: true }),
  arm_all_sources: term => engine.searchKeyword(term, { limit: 50, orFallback: true, excludePrivate: true, requireSafeChunks: true, sourceIds: liveSources }),
  arm_small_source: term => engine.searchKeyword(term, { limit: 50, orFallback: true, excludePrivate: true, requireSafeChunks: true, sourceIds: ['source-c'] }),
  arm_person: term => engine.searchKeyword(term, { limit: 50, orFallback: true, excludePrivate: true, requireSafeChunks: true, types: ['person'] }),
  pages: term => engine.searchKeywordPages(term, undefined, { limit: 20 }),
  pages_remote: term => engine.searchKeywordPages(term, { excludePrivate: true, requireSafeChunks: true }, { limit: 20 }),
  count: term => engine.countKeywordPages(term, {}),
};
const only = flag('--calls')?.split(',');
if (only) for (const name of Object.keys(calls)) if (!only.includes(name)) delete calls[name];
if (explainDir) mkdirSync(explainDir, { recursive: true });
for (const { band, term } of terms) {
  const [{ m }] = argv.includes('--no-share') ? [{ m: null }] : await sql.unsafe("SELECT count(*)::int AS m FROM content_chunks WHERE search_vector @@ websearch_to_tsquery('english', $1)", [term]) as any;
  for (const [name, call] of Object.entries(calls)) {
    const ms: number[] = [];
    let rows = 0, err: string | undefined, first: unknown[] | undefined;
    captured = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      try { const r = await call(term); rows = Array.isArray(r) ? r.length : Number(r); first ??= Array.isArray(r) ? r.map((x: any) => [x.slug, x.chunk_id, x.score]) : [r]; } catch (e) { err = (e as Error).message.slice(0, 80); }
      ms.push(performance.now() - t);
    }
    const row = { label, band, term, chunks, matched: m, share: m === null ? null : Math.round((1000 * m) / chunks) / 10, call: name, n: N, first_ms: Math.round(ms[0]!), p50_ms: Math.round(pct(ms, 0.5)), p95_ms: Math.round(pct(ms, 0.95)), rows, err };
    console.log(JSON.stringify(row));
    if (out) appendFileSync(out, JSON.stringify(row) + '\n');
    if (rowsOut) appendFileSync(rowsOut, JSON.stringify({ label, term, call: name, rows: first }) + '\n');
    if (explainDir && captured[0]) {
      const c = captured[0];
      const plan = await sql.begin(async tx => {
        await tx.unsafe("SET LOCAL jit = off; SET LOCAL statement_timeout = '120s'");
        for (const [k, v] of Object.entries(c.settings)) if (k !== 'statement_timeout') await tx.unsafe('SET LOCAL ' + k + " = '" + String(v) + "'");
        return tx.unsafe('EXPLAIN (ANALYZE, BUFFERS) ' + c.sql, c.params as any[]);
      }) as Array<Record<string, string>>;
      writeFileSync(join(explainDir, label + '-' + band + '-' + term.replace(/\W+/g, '_') + '-' + name + '.txt'), c.sql + '\n\n-- params: ' + JSON.stringify(c.params).slice(0, 400) + '\n\n' + plan.map(r => r['QUERY PLAN']).join('\n') + '\n');
    }
  }
}
await engine.disconnect();
await sql.end();
