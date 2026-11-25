/**
 * Keyed-lookups bench for the Rust engine: import, link extraction and query on a fresh Rust brain, timed per stage,
 * so one addon can be compared with another on the same machine and the same synthetic corpus.
 *
 * Each run: a fresh brain in a temp directory, N synthetic pages imported one at a time through the real import path
 * (`importFromContent`), `extract links --source db` (`runExtract`), then warm-up and timed queries through the
 * `query` operation. Embeddings come from a deterministic local function (no network, no key, no spend), so both arms
 * see the same vectors. The engine members the keyed lookups replaced are timed through a proxy, and when the addon
 * exports `commitProfile` the write path's commit time is split into the closure, redb's commit call and the rest.
 *
 * Usage:
 *   bun rust/bench/keyed-lookups/bench.ts --addon <gbrain_engine.*.node> --label after \
 *     [--pages 10000] [--runs 3] [--queries 60] [--out result.json]
 *
 * To bench an older tree with this script, set GBRAIN_BENCH_ROOT to that checkout: the script then loads gbrain's
 * code from there (its TypeScript and its addon are the "before" arm).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { corpus, DIMS, median, pct, queries, round, vectorFor } from './corpus.ts';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const PAGES = Number(arg('--pages', '10000'));
const RUNS = Number(arg('--runs', '3'));
const QUERIES = Number(arg('--queries', '60'));
const LABEL = arg('--label', 'run')!;
const OUT = arg('--out');
/** `--keep <dir>`: move the last run's brain there instead of deleting it (to time a later build's format upgrade). */
const KEEP = arg('--keep');
const ADDON = resolve(arg('--addon') ?? process.env.GBRAIN_RUST_ENGINE_ADDON ?? '');
const ROOT = resolve(process.env.GBRAIN_BENCH_ROOT ?? join(import.meta.dir, '..', '..', '..'));
if (!ADDON.endsWith('.node')) throw new Error('--addon must name the addon .node file');

const load = async <T>(rel: string): Promise<T> => (await import(join(ROOT, rel))) as T;

// A private GBRAIN_HOME, so the operator's ~/.gbrain/config.json (for example a keyless `embedding_disabled` brain)
// does not decide whether the bench brain embeds; its config sets the embedding width the store records at creation.
const HOME = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gbrain-keyed-bench-home-'));
mkdirSync(join(HOME, '.gbrain'));
writeFileSync(join(HOME, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 }));
process.env.GBRAIN_HOME = HOME;
process.on('exit', () => rmSync(HOME, { recursive: true, force: true }));

const { loadRustAddon } = await load<typeof import('../../../src/core/rust-engine/addon-loader.ts')>('src/core/rust-engine/addon-loader.ts');
const { openRustEngine } = await load<typeof import('../../../src/core/rust-engine.ts')>('src/core/rust-engine.ts');
const { importFromContent } = await load<typeof import('../../../src/core/import-file.ts')>('src/core/import-file.ts');
const { runExtract } = await load<typeof import('../../../src/commands/extract.ts')>('src/commands/extract.ts');
const { operationsByName } = await load<typeof import('../../../src/core/operations.ts')>('src/core/operations.ts');
const gateway = await load<typeof import('../../../src/core/ai/gateway.ts')>('src/core/ai/gateway.ts');

const TIMED = ['cosinesByChunkIds', 'getEmbeddingsByChunkIds', 'findPagesByTitles', 'listPagesTitledIn', 'readProjectionReadiness',
  'hasSupersedeEdges', 'findDuplicatePage', 'findDuplicatePages'] as const;
type MemberTimes = Record<string, { calls: number; ms: number }>;

/** The engine with the timed members wrapped; transactions hand their callbacks a wrapped clone too. */
function timedEngine<E extends object>(engine: E, times: MemberTimes): E {
  return new Proxy(engine, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      if ((TIMED as readonly (string | symbol)[]).includes(key)) {
        return async (...args: unknown[]) => {
          const t = performance.now();
          try { return await (value as (...a: unknown[]) => unknown).apply(target, args); } finally {
            const slot = (times[key as string] ??= { calls: 0, ms: 0 });
            slot.calls += 1; slot.ms += performance.now() - t;
          }
        };
      }
      if (key === 'transaction' || key === 'transactionDirect') {
        return (fn: (tx: object) => unknown, ...rest: unknown[]) =>
          (value as (...a: unknown[]) => unknown).call(target, (tx: object) => fn(timedEngine(tx, times)), ...rest);
      }
      return value.bind(target);
    },
  });
}

type Profile = { writes: number; write_body_ns: number; commits: number; commit_ns: number; redb_commit_ns: number };

async function oneRun(addon: unknown, run: number, keep?: string) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gbrain-keyed-bench-'));
  const engine = openRustEngine({ addon: addon as never, databasePath: dir });
  await engine.connect({ engine: 'pglite', database_path: dir } as never);
  // No reranker and no autocut: nothing leaves the machine, and the query path is the same in every arm.
  await engine.setConfig('search.reranker.enabled', 'false');
  await engine.setConfig('search.autocut', 'off');
  const profile = (addon as { commitProfile?: (reset?: boolean) => Profile }).commitProfile;
  const times: MemberTimes = {};
  const timed = timedEngine(engine, times);
  const pages = corpus(PAGES);
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  try {
    // Import, one page at a time, as a sync of new files does.
    profile?.(true);
    const importMs: number[] = [];
    const t0 = performance.now();
    for (const page of pages) {
      const t = performance.now();
      await importFromContent(timed as never, page.slug, page.content, {});
      importMs.push(performance.now() - t);
    }
    const importTotal = performance.now() - t0;
    const importProfile = profile?.(true);
    const importMembers = structuredClone(times);
    for (const k of Object.keys(times)) delete times[k];

    // Link extraction from the stored pages.
    console.log = () => undefined; console.error = () => undefined; console.warn = () => undefined;
    const t1 = performance.now();
    await runExtract(timed as never, ['links', '--source', 'db']);
    const extractMs = performance.now() - t1;
    Object.assign(console, quiet);
    const extractProfile = profile?.(true);
    const links = (await engine.getStats() as { link_count?: number }).link_count ?? null;

    // Queries: five warm-ups, then two timed passes.
    const qs = queries(pages, QUERIES);
    const ctx = { engine: timed, config: { engine: 'rust' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' };
    const query = operationsByName['query']!;
    for (const q of qs.slice(0, 5)) await query.handler(ctx as never, { query: q, limit: 10 });
    for (const k of Object.keys(times)) delete times[k];
    const queryMs: number[] = [];
    let hits = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const q of qs) {
        const t = performance.now();
        const rows = await query.handler(ctx as never, { query: q, limit: 10 }) as unknown[];
        queryMs.push(performance.now() - t);
        hits += Array.isArray(rows) ? rows.length : 0;
      }
    }
    const perQuery = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, round(v.ms / queryMs.length, 3)]));
    const stats = await engine.getStats() as { page_count?: number; chunk_count?: number; embedded_count?: number };
    if (!stats.embedded_count) throw new Error('no chunk was embedded: the vector arm did not run');
    const tenth = Math.max(1, Math.floor(importMs.length / 10));
    const commit = (p: Profile | undefined) => p && {
      commits: p.commits,
      commit_ms: round(p.commit_ns / 1e6 / Math.max(1, p.commits), 3),
      redb_commit_ms: round(p.redb_commit_ns / 1e6 / Math.max(1, p.commits), 3),
      write_body_ms: round(p.write_body_ns / 1e6 / Math.max(1, p.writes), 3),
    };
    return {
      run,
      pages: stats.page_count, chunks: stats.chunk_count, embedded: stats.embedded_count, links,
      import: {
        total_s: round(importTotal / 1000, 1),
        page_p50_ms: round(median(importMs)), page_p95_ms: round(pct(importMs, 0.95)),
        first_tenth_p50_ms: round(median(importMs.slice(0, tenth))), last_tenth_p50_ms: round(median(importMs.slice(-tenth))),
        members_ms_per_page: Object.fromEntries(Object.entries(importMembers).map(([k, v]) => [k, round(v.ms / importMs.length, 3)])),
        commit: commit(importProfile),
      },
      extract_links: { total_s: round(extractMs / 1000, 1), per_10k_s: round(extractMs / 1000 * 10000 / PAGES, 1), commit: commit(extractProfile) },
      query: { n: queryMs.length, p50_ms: round(median(queryMs)), p95_ms: round(pct(queryMs, 0.95)), hits, members_ms_per_query: perQuery },
    };
  } finally {
    Object.assign(console, quiet);
    await engine.disconnect().catch(() => undefined);
    if (keep) renameSync(dir, keep);
    else rmSync(dir, { recursive: true, force: true });
  }
}

function machine() {
  const cpu = cpus();
  let sha = 'unknown';
  try { sha = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=10', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  let dirty = false;
  try { dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== ''; } catch { /* not a checkout */ }
  return {
    cpu: cpu[0]?.model ?? 'unknown', vcpus: cpu.length, mem_gb: round(totalmem() / 2 ** 30, 1), kernel: release(),
    root: ROOT, sha, dirty, addon: ADDON, addon_sha256: createHash('sha256').update(readFileSync(ADDON)).digest('hex').slice(0, 16),
  };
}

async function main() {
  process.env.GBRAIN_SWEEP ??= '0';
  gateway.configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-bench-local-only' } } as never);
  gateway.__setEmbedTransportForTests((async ({ values }: { values: string[] }) =>
    ({ embeddings: values.map(vectorFor), values, usage: { tokens: values.length }, warnings: [] })) as never);
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON } });
  const runs = [];
  for (let r = 1; r <= RUNS; r++) {
    const result = await oneRun(addon, r, r === RUNS ? KEEP : undefined);
    process.stderr.write(`[keyed-bench ${LABEL}] run ${r}: ${JSON.stringify(result)}\n`);
    runs.push(result);
  }
  const med = (f: (r: (typeof runs)[number]) => number) => round(median(runs.map(f)));
  const summary = {
    label: LABEL, machine: machine(), data: { pages: PAGES, queries_per_run: QUERIES * 2 }, n: RUNS,
    median: {
      import_page_p50_ms: med(r => r.import.page_p50_ms),
      import_page_p95_ms: med(r => r.import.page_p95_ms),
      import_first_tenth_p50_ms: med(r => r.import.first_tenth_p50_ms),
      import_last_tenth_p50_ms: med(r => r.import.last_tenth_p50_ms),
      import_total_s: med(r => r.import.total_s),
      extract_links_per_10k_s: med(r => r.extract_links.per_10k_s),
      query_p50_ms: med(r => r.query.p50_ms),
      query_p95_ms: med(r => r.query.p95_ms),
    },
    runs,
  };
  const m = summary.machine;
  console.log(`keyed-lookups bench: ${LABEL}`);
  console.log(`machine: ${m.cpu}, ${m.vcpus} vCPU, ${m.mem_gb} GB, Linux ${m.kernel}`);
  console.log(`code: ${m.root} @ ${m.sha}${m.dirty ? ' (dirty)' : ''}; addon ${m.addon} (sha256 ${m.addon_sha256})`);
  console.log(`data: ${PAGES} pages, ${QUERIES * 2} timed queries per run; N=${RUNS} runs (medians below)`);
  for (const [k, v] of Object.entries(summary.median)) console.log(`  ${k.padEnd(28)} ${v}`);
  if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n');
}

await main();
gateway.__setEmbedTransportForTests(null);
