/**
 * tests/heavy/_read_latency_workload.ts
 *
 * Read-latency-under-write measurement. Two phases against the SAME brain:
 *
 *   Phase A (baseline): N search queries, no concurrent writes. Records
 *                        p50/p95/p99 latency.
 *   Phase B (under load): N search queries with M parallel writer tasks
 *                          inserting pages in the background. Records
 *                          p50/p95/p99 latency under contention.
 *
 * The headline metric is `delta_pct` between phase A and phase B p99 — that's
 * what tells operators whether sync is impacting reads. PASS criterion (when
 * `STRICT=1`): delta_pct <= 50% (informational-only otherwise).
 *
 * Self-contained: builds the brain in-memory at startup, runs both phases,
 * exits. No cross-process state. PGLite-only for v1; Postgres path is a
 * follow-up (the contention character is different against a real WAL).
 *
 * Env:
 *   BRAIN_PAGES        initial fixture size (default 500; PGLite insert
 *                       superlinearity caps useful values around ~200-300
 *                       on Darwin, more on Linux CI)
 *   NUM_QUERIES        queries per phase (default 200)
 *   NUM_WRITERS        parallel writer tasks during phase B (default 4)
 *   WRITES_PER_WRITER  pages each writer inserts during phase B (default 25)
 *   STRICT             1 = exit non-zero on delta_pct > THRESHOLD_PCT (default 0)
 *   THRESHOLD_PCT      regression threshold (default 50)
 *
 * Output JSON shape (stable contract):
 *   {
 *     ok, platform, brain_page_count,
 *     phase_a: { p50_ms, p95_ms, p99_ms, queries_run },
 *     phase_b: { p50_ms, p95_ms, p99_ms, queries_run, writes_completed, writes_failed },
 *     delta_p50_pct, delta_p95_pct, delta_p99_pct,
 *     elapsed_ms, threshold_pct,
 *     verdict: 'pass' | 'fail' | 'informational',
 *     note?, error?
 *   }
 */

import { platform } from 'node:os';

interface Phase {
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  queries_run: number;
  writes_completed?: number;
  writes_failed?: number;
}

interface Result {
  ok: boolean;
  platform: string;
  brain_page_count: number;
  phase_a: Phase | null;
  phase_b: Phase | null;
  delta_p50_pct: number | null;
  delta_p95_pct: number | null;
  delta_p99_pct: number | null;
  elapsed_ms: number;
  threshold_pct: number;
  verdict: 'pass' | 'fail' | 'informational';
  note?: string;
  error?: string;
}

function percentile(sortedMs: number[], pct: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((pct / 100) * sortedMs.length));
  return sortedMs[idx]!;
}

function generatePage(i: number, prefix: string): { slug: string; title: string; body: string } {
  const pad = String(i).padStart(5, '0');
  const body =
    `# ${prefix} Page ${i}\n\n` +
    `Deterministic page for read-latency measurement. Body has stable text ` +
    `so search-index work is consistent run-to-run.\n\n` +
    `Section 1: lorem ipsum dolor sit amet consectetur adipiscing elit sed do ` +
    `eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad ` +
    `minim veniam quis nostrud exercitation ullamco laboris.\n\n` +
    `Section 2: sed ut perspiciatis unde omnis iste natus error sit voluptatem ` +
    `accusantium doloremque laudantium totam rem aperiam eaque ipsa quae.\n\n` +
    `Reference: ${prefix}-${pad}.`;
  return {
    slug: `${prefix.toLowerCase()}/page-${pad}`,
    title: `${prefix} Page ${i}`,
    body,
  };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const plat = platform();

  const BRAIN_PAGES = parseInt(process.env.BRAIN_PAGES ?? '500', 10);
  const NUM_QUERIES = parseInt(process.env.NUM_QUERIES ?? '200', 10);
  const NUM_WRITERS = parseInt(process.env.NUM_WRITERS ?? '4', 10);
  const WRITES_PER_WRITER = parseInt(process.env.WRITES_PER_WRITER ?? '25', 10);
  const STRICT = (process.env.STRICT ?? '0') === '1';
  const THRESHOLD_PCT = parseInt(process.env.THRESHOLD_PCT ?? '50', 10);

  let result: Result = {
    ok: false,
    platform: plat,
    brain_page_count: 0,
    phase_a: null,
    phase_b: null,
    delta_p50_pct: null,
    delta_p95_pct: null,
    delta_p99_pct: null,
    elapsed_ms: 0,
    threshold_pct: THRESHOLD_PCT,
    verdict: 'informational',
  };

  try {
    const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
    const { hybridSearch } = await import('../../src/core/search/hybrid.ts');

    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Build the fixture
    process.stderr.write(`[_read_latency] inserting ${BRAIN_PAGES} fixture pages...\n`);
    for (let i = 0; i < BRAIN_PAGES; i += 1) {
      const p = generatePage(i, 'Fixture');
      await engine.putPage(p.slug, {
        type: 'note',
        title: p.title,
        compiled_truth: p.body,
        timeline: '',
        frontmatter: { fixture: true, tags: ['fixture'] },
      });
    }

    const queries = [
      'lorem ipsum', 'consequat', 'voluptatem', 'aspernatur', 'magna',
      'reprehenderit', 'commodo', 'inventore', 'fixture page', 'section 1',
      'section 2', 'page 100', 'doloremque', 'architecto', 'incididunt',
    ];

    // ---- Phase A: baseline (no concurrent writes)
    process.stderr.write(`[_read_latency] phase A: ${NUM_QUERIES} queries (baseline)...\n`);
    const phaseAMs: number[] = [];
    for (let i = 0; i < NUM_QUERIES; i += 1) {
      const q = queries[i % queries.length]!;
      const t = Date.now();
      try {
        await hybridSearch(engine, q, { limit: 10 });
      } catch {
        /* tolerated; latency still recorded */
      }
      phaseAMs.push(Date.now() - t);
    }
    phaseAMs.sort((a, b) => a - b);
    result.phase_a = {
      p50_ms: percentile(phaseAMs, 50),
      p95_ms: percentile(phaseAMs, 95),
      p99_ms: percentile(phaseAMs, 99),
      queries_run: phaseAMs.length,
    };

    // ---- Phase B: under load (parallel writers)
    process.stderr.write(`[_read_latency] phase B: ${NUM_QUERIES} queries with ${NUM_WRITERS} writers...\n`);
    let writesCompleted = 0;
    let writesFailed = 0;
    let writersDone = 0;

    const writers: Promise<void>[] = [];
    for (let w = 0; w < NUM_WRITERS; w += 1) {
      writers.push((async () => {
        const base = BRAIN_PAGES + w * WRITES_PER_WRITER;
        for (let i = 0; i < WRITES_PER_WRITER; i += 1) {
          const p = generatePage(base + i, `WriterW${w}`);
          try {
            await engine.putPage(p.slug, {
              type: 'note',
              title: p.title,
              compiled_truth: p.body,
              timeline: '',
              frontmatter: { writer: w, tags: ['writer-load'] },
            });
            writesCompleted += 1;
          } catch {
            writesFailed += 1;
          }
        }
        writersDone += 1;
      })());
    }

    const phaseBMs: number[] = [];
    // Run queries until we hit NUM_QUERIES OR all writers finish, whichever
    // is LATER. Goal: every query in phase B is during sustained writer
    // pressure. If queries are too few and writers haven't finished, keep
    // going past NUM_QUERIES for fairness.
    let queryIdx = 0;
    while (queryIdx < NUM_QUERIES || writersDone < NUM_WRITERS) {
      const q = queries[queryIdx % queries.length]!;
      const t = Date.now();
      try {
        await hybridSearch(engine, q, { limit: 10 });
      } catch {
        /* tolerated */
      }
      if (queryIdx < NUM_QUERIES) {
        phaseBMs.push(Date.now() - t);
      }
      queryIdx += 1;
      // Safety stop: don't blow past 4x NUM_QUERIES if writers are wedged
      if (queryIdx >= 4 * NUM_QUERIES) break;
    }
    await Promise.allSettled(writers);
    phaseBMs.sort((a, b) => a - b);
    result.phase_b = {
      p50_ms: percentile(phaseBMs, 50),
      p95_ms: percentile(phaseBMs, 95),
      p99_ms: percentile(phaseBMs, 99),
      queries_run: phaseBMs.length,
      writes_completed: writesCompleted,
      writes_failed: writesFailed,
    };

    // Delta math: ((B - A) / A) * 100, integer percent. Guard divide-by-zero.
    function deltaPct(a: number, b: number): number {
      if (a <= 0) return 0;
      return Math.round(((b - a) / a) * 100);
    }
    result.delta_p50_pct = deltaPct(result.phase_a.p50_ms, result.phase_b.p50_ms);
    result.delta_p95_pct = deltaPct(result.phase_a.p95_ms, result.phase_b.p95_ms);
    result.delta_p99_pct = deltaPct(result.phase_a.p99_ms, result.phase_b.p99_ms);

    // Page count after both phases
    const pageRows = await engine.executeRaw('SELECT count(*)::int AS c FROM pages', []);
    result.brain_page_count =
      pageRows && pageRows[0] && typeof (pageRows[0] as { c: number }).c === 'number'
        ? (pageRows[0] as { c: number }).c
        : 0;

    await engine.disconnect();

    // Verdict
    if (STRICT) {
      result.verdict = (result.delta_p99_pct ?? 0) > THRESHOLD_PCT ? 'fail' : 'pass';
    } else {
      result.verdict = 'informational';
    }

    result.ok = true;
    result.elapsed_ms = Date.now() - t0;
  } catch (err) {
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    result.elapsed_ms = Date.now() - t0;
  }

  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exit(1);
  if (STRICT && result.verdict === 'fail') process.exit(1);
  process.exit(0);
}

void main();
