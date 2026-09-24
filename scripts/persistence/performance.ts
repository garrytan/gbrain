import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import { assertSafeE2eDatabaseUrl } from '../../test/helpers/db-guard.ts';
import { childEnvironment } from './validate.ts';
import { summarizeReadRuns } from './read-metrics.ts';
import type { ReadWorkloadOptions } from './read-workload.ts';

export async function runReadPerformance(options: ReadWorkloadOptions & { manifest?: string; thresholdPct?: number }) {
  const engine = options.engine ?? 'pglite';
  const requested = { pages: options.pages ?? 500, queries: options.queries ?? 200, writers: options.writers ?? 4,
    writesPerWriter: options.writesPerWriter ?? 25, runs: 3, thresholdPct: options.thresholdPct ?? 50 };
  for (const [key, value] of Object.entries(requested)) assert(Number.isSafeInteger(value) && value > 0, `Invalid ${key}`);
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-read-performance-'));
  const runs: Record<string, any>[] = []; const databases: string[] = [];
  let admin: ReturnType<typeof postgres> | undefined;
  function sourceHashes() {
    return Object.fromEntries(['scripts/persistence/performance.ts', 'scripts/persistence/read-workload.ts', 'scripts/persistence/read-metrics.ts', 'scripts/persistence/read-admission.ts',
      'scripts/persistence/read-diagnostics.ts', 'tests/heavy/_read_latency_workload.ts', 'src/core/persistence/coordinator.ts', 'src/core/persistence/journal.ts',
      'src/core/persistence/consumer.ts', 'src/core/persistence/activation.ts', 'src/core/persistence/page-mutations.ts', 'src/core/search/hybrid.ts',
      'src/core/pglite-engine.ts', 'src/core/postgres-engine.ts'].map(file =>
      [file, createHash('sha256').update(readFileSync(resolve(import.meta.dir, '../..', file))).digest('hex')]));
  }
  const manifest: Record<string, any> = { version: 1, engine, managed_persistence: true, runtime: `bun-${Bun.version}`, platform: process.platform,
    architecture: process.arch, started_at: new Date().toISOString(), status: 'running', requested,
    storage: engine === 'pglite' ? 'in-memory PGLite (original heavy workload)' : 'fresh PostgreSQL database per run',
    environment: { logical_cpus: availableParallelism(), cpu_model: cpus()[0]?.model, memory_bytes: totalmem(), load_average_at_start: loadavg() },
    source_hashes: sourceHashes() };
  try {
    if (engine === 'postgres') { assert(options.databaseUrl, 'Explicit test DATABASE_URL is required');
      assertSafeE2eDatabaseUrl(options.databaseUrl); admin = postgres(options.databaseUrl, { max: 1, onnotice() {} }); }
    for (let i = 0; i < requested.runs; i++) {
      assert.deepEqual(sourceHashes(), manifest.source_hashes, 'Workload source changed between measurement runs');
      const home = join(scratch, `run-${i}`); mkdirSync(home);
      const env = { ...childEnvironment(home), BRAIN_PAGES: String(requested.pages), NUM_QUERIES: String(requested.queries),
        NUM_WRITERS: String(requested.writers), WRITES_PER_WRITER: String(requested.writesPerWriter),
        GBRAIN_TEST_PERF_ENGINE: engine, STRICT: '0', THRESHOLD_PCT: String(requested.thresholdPct),
        GBRAIN_PGLITE_CLOSE_WATCHDOG_MS: '20000', GBRAIN_PGLITE_CLOSE_WATCHDOG_GRACE_MS: '10000' };
      if (admin) {
        const name = `gbrain_persistence_test_${randomUUID().replaceAll('-', '')}`; await admin.unsafe(`CREATE DATABASE ${name}`); databases.push(name);
        const url = new URL(options.databaseUrl!); url.pathname = `/${name}`; Object.assign(env, { DATABASE_URL: url.toString() });
      }
      process.stderr.write(`[read performance] ${engine}: independent run ${i + 1}/3\n`);
      const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, '../../tests/heavy/_read_latency_workload.ts')],
        { env, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 900_000);
      try {
        const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        let result: Record<string, any> | undefined;
        for (const line of output.split('\n')) { try { const value = JSON.parse(line); if (typeof value.ok === 'boolean') result = value; } catch { /* schema diagnostics */ } }
        assert.deepEqual(sourceHashes(), manifest.source_hashes, 'Workload source changed during measurement');
        runs.push(result ?? { ok: false, error: `Workload produced no result (exit=${code}, timeout=${timedOut})`, diagnostic_tail: output.slice(-4000) });
        if (code !== 0 || timedOut) { runs.at(-1)!.ok = false; runs.at(-1)!.process_error = `exit=${code}, timeout=${timedOut}`; }
        process.stderr.write(`[read performance] run ${i + 1}: valid=${runs.at(-1)!.ok}, idle_p99=${result?.phase_a?.p99_ms}, ` +
          `loaded_p99=${result?.phase_b?.p99_ms}, overlap=${result?.overlap_pct}, writes=${result?.phase_b?.writes_completed}\n`);
      } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
    }
    Object.assign(manifest, summarizeReadRuns(runs, requested.thresholdPct));
    manifest.status = manifest.verdict === 'pass' ? 'passed' : 'failed';
    manifest.full_gate = requested.pages === 500 && requested.queries === 200 && requested.writers === 4 &&
      requested.writesPerWriter === 25 && requested.thresholdPct === 50 && manifest.verdict === 'pass';
  } catch (error) { manifest.status = 'failed'; manifest.verdict = 'fail'; manifest.ok = false; manifest.full_gate = false;
    manifest.error = String(error); manifest.runs = runs; }
  finally {
    if (admin) { for (const database of databases) await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); }
    manifest.finished_at = new Date().toISOString();
    if (options.manifest) { mkdirSync(dirname(resolve(options.manifest)), { recursive: true }); writeFileSync(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`); }
    rmSync(scratch, { recursive: true, force: true });
  }
  return manifest;
}

if (import.meta.main) {
  const args = new Map(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=')]; }));
  for (const key of args.keys()) assert(['engine', 'manifest', 'pages', 'queries', 'writers', 'writes-per-writer', 'threshold', 'informational'].includes(key), `Unknown option: ${key}`);
  const engine = args.get('engine') ?? 'pglite'; assert(engine === 'pglite' || engine === 'postgres');
  const result = await runReadPerformance({ engine, databaseUrl: process.env.DATABASE_URL, pages: Number(args.get('pages') ?? 500),
    queries: Number(args.get('queries') ?? 200), writers: Number(args.get('writers') ?? 4), writesPerWriter: Number(args.get('writes-per-writer') ?? 25),
    thresholdPct: Number(args.get('threshold') ?? 50), manifest: args.get('manifest') ?? `.context/persistence-read-${engine}.json` });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = !result.ok || !args.has('informational') && result.verdict !== 'pass' ? 1 : 0;
}
