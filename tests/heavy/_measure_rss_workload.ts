/**
 * tests/heavy/_measure_rss_workload.ts
 *
 * Single-process RSS measurement workload. Builds a synthetic brain
 * in-memory, runs a representative read workload, self-reports peak RSS
 * as JSON on stdout. No cross-process state — the brain lives only inside
 * this process, which keeps the measurement honest.
 *
 * Self-measurement (Linux): polls `/proc/self/status` every 100ms, keeps
 * the max RssAnon+RssShmem. Same metric as `getAccurateRss` in
 * src/core/minions/worker.ts so "what CI measures" matches "what the
 * runtime watchdog measures."
 *
 * Self-measurement (non-Linux): falls back to `process.memoryUsage().rss`
 * (VmRSS). The orchestrator (measure_rss.sh) refuses to write a CI baseline
 * from a macOS run because of this.
 *
 * Env:
 *   BRAIN_PAGES  number of synthetic pages to insert (default 1000)
 *   NUM_QUERIES  number of search queries to run (default 100)
 *
 * Output JSON shape (stable contract for the orchestrator):
 *   {
 *     ok: boolean,
 *     platform: string,
 *     measurement_path: 'proc' | 'fallback',
 *     queries_run: number,
 *     peak_rss_kb: number,
 *     elapsed_ms: number,
 *     brain_page_count: number,
 *     note?: string,
 *     error?: string
 *   }
 */

import { readFileSync } from 'node:fs';
import { platform } from 'node:os';

interface Result {
  ok: boolean;
  platform: string;
  measurement_path: 'proc' | 'fallback';
  queries_run: number;
  peak_rss_kb: number;
  elapsed_ms: number;
  brain_page_count: number;
  note?: string;
  error?: string;
}

function readProcRss(): number | null {
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    let anon = 0;
    let shmem = 0;
    let found = false;
    for (const line of status.split('\n')) {
      if (line.startsWith('RssAnon:')) {
        const m = line.match(/(\d+)/);
        if (m) {
          anon = parseInt(m[1]!, 10);
          found = true;
        }
      } else if (line.startsWith('RssShmem:')) {
        const m = line.match(/(\d+)/);
        if (m) {
          shmem = parseInt(m[1]!, 10);
          found = true;
        }
      }
    }
    return found ? anon + shmem : null;
  } catch {
    return null;
  }
}

function readFallbackRss(): number {
  return Math.floor(process.memoryUsage().rss / 1024);
}

function generatePage(i: number): { slug: string; title: string; body: string } {
  const pad = String(i).padStart(5, '0');
  const next1 = String(i + 1).padStart(5, '0');
  const next7 = String(i + 7).padStart(5, '0');
  // Deterministic body — stable across runs so measurement compares apples to
  // apples. ~500 chars; realistic for the workload.
  const body =
    `# Synthetic Page ${i}\n\n` +
    `This is a deterministic synthetic page for RSS measurement runs. Page ` +
    `number ${i}. The body is stable so that successive runs produce ` +
    `identical chunks and identical search-result orderings.\n\n` +
    `Section 1: lorem ipsum dolor sit amet, consectetur adipiscing elit, sed ` +
    `do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ` +
    `ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut.\n\n` +
    `Section 2: sed ut perspiciatis unde omnis iste natus error sit ` +
    `voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ` +
    `ipsa quae ab illo inventore veritatis et quasi architecto beatae.\n\n` +
    `Page ${i} references page-${next1} and page-${next7}.`;
  return {
    slug: `synthetic/page-${pad}`,
    title: `Synthetic Page ${i}`,
    body,
  };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const plat = platform();
  const linuxProcWorks = plat === 'linux' && readProcRss() !== null;
  const measurementPath: 'proc' | 'fallback' = linuxProcWorks ? 'proc' : 'fallback';
  const readRss = linuxProcWorks ? () => readProcRss() ?? 0 : readFallbackRss;

  const PAGES = parseInt(process.env.BRAIN_PAGES ?? '1000', 10);
  const QUERIES = parseInt(process.env.NUM_QUERIES ?? '100', 10);

  let peakRss = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  function startPolling() {
    pollTimer = setInterval(() => {
      const rss = readRss();
      if (rss > peakRss) peakRss = rss;
    }, 100);
  }
  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  let result: Result;
  try {
    startPolling();

    // Lazy imports so PGLite WASM cold-start is counted in the peak.
    const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
    const { hybridSearch } = await import('../../src/core/search/hybrid.ts');

    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Build the brain in-memory by inserting N synthetic pages directly via
    // engine.putPage. This is the same code path the import command uses;
    // we just skip the markdown file parsing.
    process.stderr.write(`[_measure_rss_workload] inserting ${PAGES} pages...\n`);
    for (let i = 0; i < PAGES; i += 1) {
      const page = generatePage(i);
      await engine.putPage(page.slug, {
        type: 'note',
        title: page.title,
        compiled_truth: page.body,
        timeline: '',
        frontmatter: { synthetic: true, tags: ['synthetic', 'rss-fixture'] },
      });
      if (i > 0 && i % 500 === 0) {
        process.stderr.write(`[_measure_rss_workload] inserted ${i}\n`);
      }
    }

    const pageCountRows = await engine.executeRaw('SELECT count(*)::int AS c FROM pages', []);
    const brainPageCount =
      pageCountRows && pageCountRows[0] && typeof (pageCountRows[0] as { c: number }).c === 'number'
        ? (pageCountRows[0] as { c: number }).c
        : 0;

    process.stderr.write(`[_measure_rss_workload] running ${QUERIES} queries...\n`);
    const queries = [
      'synthetic page', 'lorem ipsum', 'consequat', 'voluptatem', 'aspernatur',
      'magna aliqua', 'reprehenderit', 'commodo', 'inventore', 'architecto',
      'page 100', 'page 500', 'rss-fixture', 'section 1', 'section 2',
    ];
    let queriesRun = 0;
    for (let i = 0; i < QUERIES; i += 1) {
      const q = queries[i % queries.length]!;
      try {
        await hybridSearch(engine, q, { limit: 10 });
      } catch {
        /* keyword-only fallback if no embeddings — fine for the measurement */
      }
      queriesRun += 1;
    }

    await engine.disconnect();
    const finalRss = readRss();
    if (finalRss > peakRss) peakRss = finalRss;

    result = {
      ok: true,
      platform: plat,
      measurement_path: measurementPath,
      queries_run: queriesRun,
      peak_rss_kb: peakRss,
      elapsed_ms: Date.now() - t0,
      brain_page_count: brainPageCount,
      ...(measurementPath === 'fallback'
        ? { note: 'macOS/non-Linux fallback path (VmRSS, mmap-inflated)' }
        : {}),
    };
  } catch (err) {
    result = {
      ok: false,
      platform: plat,
      measurement_path: measurementPath,
      queries_run: 0,
      peak_rss_kb: peakRss,
      elapsed_ms: Date.now() - t0,
      brain_page_count: 0,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  } finally {
    stopPolling();
  }

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

void main();
