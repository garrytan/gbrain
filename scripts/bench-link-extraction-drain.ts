/**
 * Link re-extraction drain benchmark: how long a brain takes to re-derive
 * every page's links after the extraction watermark moves (a
 * LINK_EXTRACTOR_VERSION_TS bump or a line-grammar setting change), and what
 * put_page latency looks like with the grammar off and on.
 *
 * Seeds N synthetic pages (people with prose, typed relation lines and dated
 * timelines; companies; notes with ordinary lists), runs one full extraction,
 * then turns the grammar on (which moves the watermark the same way a version
 * bump does) and times the complete drain with `extract --stale --catch-up`.
 * A probe halfway through the drain reports the backlog and confirms reads
 * still answer while it runs. Zero model calls.
 *
 * Usage: bun scripts/bench-link-extraction-drain.ts --pages 10000 [--json]
 *        DATABASE_URL=postgres://... bun scripts/bench-link-extraction-drain.ts --pages 100000 --json
 * Postgres runs need an empty, disposable database (the script initializes the schema).
 */
import { performance } from 'node:perf_hooks';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { applyLineGrammarConfigChange } from '../src/core/line-grammar-config.ts';
import { effectiveLinkExtractorWatermark } from '../src/core/link-extraction-watermark.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const PAGES = Number(arg('--pages', '10000'));
const WRITES = Number(arg('--writes', '200'));
const json = process.argv.includes('--json');
const ROLES = ['senior engineer', 'designer', 'product manager', 'head of sales', 'CTO'];

function personBody(i: number, companies: number): string {
  const c = (k: number) => `companies/company-${(i * 7 + k * 13) % companies}`;
  return [
    `Person ${i} works at [[${c(0)}]] as a ${ROLES[i % ROLES.length]} and advises [[${c(1)}]].`,
    `Previously at [[${c(2)}]]; invested in [[${c(3)}]] early.`,
    '',
    `- works_at [[${c(0)}]] (since 20${10 + (i % 14)})`,
    `- [preference] Prefers async updates #work`,
    '- Ordinary list item about a project.',
    `- Met [[people/person-${(i + 1) % Math.max(1, PAGES)}]] for coffee.`,
  ].join('\n');
}
const personTimeline = (i: number, companies: number) => [
  `- **2021-0${1 + (i % 9)}-01** | Joined [[companies/company-${(i * 7) % companies}]] as ${ROLES[i % ROLES.length]}`,
  `- **2019-0${1 + (i % 9)}-15** | Left [[companies/company-${(i * 7 + 26) % companies}]]`,
].join('\n');

async function openEngine(): Promise<BrainEngine> {
  if (process.env.DATABASE_URL) {
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    const engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.DATABASE_URL } as never);
    await engine.initSchema();
    return engine as unknown as BrainEngine;
  }
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine as unknown as BrainEngine;
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function putLatency(engine: BrainEngine, label: string): Promise<{ p50: number; p95: number; p99: number }> {
  const ctx: OperationContext = { engine, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} },
    dryRun: false, remote: false, sourceId: 'default' };
  const put = operationsByName['put_page'];
  const ms: number[] = [];
  for (let i = 0; i < WRITES; i++) {
    const t = performance.now();
    await put.handler(ctx, { slug: `notes/latency-${label}-${i}`, content: `---\ntype: person\ntitle: Latency ${label} ${i}\n---\n\nWritten in the ${label} arm.\n${personBody(i, Math.max(1, Math.floor(PAGES / 10)))}\n` });
    ms.push(performance.now() - t);
  }
  return { p50: pct(ms, 0.5), p95: pct(ms, 0.95), p99: pct(ms, 0.99) };
}

async function main() {
  const engine = await openEngine();
  const companies = Math.max(1, Math.floor(PAGES / 10));
  const people = Math.floor(PAGES * 0.6);
  const notes = PAGES - companies - people;
  const seedStart = performance.now();
  for (let i = 0; i < companies; i++) await engine.putPage(`companies/company-${i}`, { type: 'company', title: `Company ${i}`, compiled_truth: `Company ${i} builds things.`, timeline: '', frontmatter: {} });
  for (let i = 0; i < people; i++) await engine.putPage(`people/person-${i}`, { type: 'person', title: `Person ${i}`, compiled_truth: personBody(i, companies), timeline: personTimeline(i, companies), frontmatter: {} });
  for (let i = 0; i < notes; i++) await engine.putPage(`notes/note-${i}`, { type: 'note', title: `Note ${i}`, compiled_truth: `- [Time] - [Event]\n- Agenda item ${i}\n- See [[people/person-${i % Math.max(1, people)}]]`, timeline: '', frontmatter: {} });
  const seedMs = performance.now() - seedStart;

  const opts = { dryRun: false, jsonMode: true, quiet: true, catchUp: true } as const;
  let t = performance.now();
  const first = await extractStaleFromDB(engine, opts);
  const firstMs = performance.now() - t;
  const latencyOff = await putLatency(engine, 'off');

  const change = await applyLineGrammarConfigChange(engine, tx => tx.setConfig('line_grammar.enabled', 'true'));
  const queued = await engine.countStalePagesForExtraction({ versionTs: await effectiveLinkExtractorWatermark(engine) });
  t = performance.now();
  const half = await extractStaleFromDB(engine, { ...opts, catchUp: false, timeBudgetMs: Math.max(1, firstMs / 2) });
  const probeStart = performance.now();
  const probe = await operationsByName['get_links'].handler({ engine, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} },
    dryRun: false, remote: false, sourceId: 'default' }, { slug: 'people/person-1' }) as unknown[];
  const probeMs = performance.now() - probeStart;
  const midBacklog = await engine.countStalePagesForExtraction({ versionTs: await effectiveLinkExtractorWatermark(engine) });
  const rest = await extractStaleFromDB(engine, opts);
  const drainMs = performance.now() - t;
  const latencyOn = await putLatency(engine, 'on');

  const result = {
    engine: engine.kind, pages: PAGES, seed_ms: Math.round(seedMs),
    initial_extraction: { ms: Math.round(firstMs), pages: first.pagesProcessed, ms_per_page: +(firstMs / Math.max(1, first.pagesProcessed)).toFixed(2) },
    toggle: { changed: change.changed, pages_queued: queued },
    drain: { ms: Math.round(drainMs), pages: half.pagesProcessed + rest.pagesProcessed, ms_per_page: +(drainMs / Math.max(1, half.pagesProcessed + rest.pagesProcessed)).toFixed(2),
      remaining: rest.staleRemaining, mid_drain_backlog: midBacklog, mid_drain_get_links_ms: +probeMs.toFixed(1), mid_drain_get_links_rows: Array.isArray(probe) ? probe.length : null },
    put_page_ms: { grammar_off: latencyOff, grammar_on: latencyOn },
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.engine}, ${PAGES} pages: initial extraction ${result.initial_extraction.ms} ms (${result.initial_extraction.ms_per_page} ms/page)`);
    console.log(`toggle queued ${queued} pages; drain ${result.drain.ms} ms (${result.drain.ms_per_page} ms/page), ${result.drain.remaining} remaining; mid-drain backlog ${midBacklog}, get_links ${result.drain.mid_drain_get_links_ms} ms`);
    console.log(`put_page p50/p95/p99 off ${latencyOff.p50.toFixed(1)}/${latencyOff.p95.toFixed(1)}/${latencyOff.p99.toFixed(1)} ms; on ${latencyOn.p50.toFixed(1)}/${latencyOn.p95.toFixed(1)}/${latencyOn.p99.toFixed(1)} ms`);
  }
  await engine.disconnect();
}

await main();
