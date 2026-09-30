import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { childEnvironment } from '../persistence/validate.ts';
import { summarizeLifecycleReadGate, validateOptions } from './lifecycle-metrics.ts';

export interface LifecycleOptions {
  engine: 'pglite' | 'postgres'; sizes: number[]; members: number; queries: number; runs: number;
  maxWrites: number; assetBytes: number; warmChecks: number; manifest: string; smoke?: boolean; databaseUrl?: string;
}
const SOURCE_FILES = [
  'scripts/shared-skills/lifecycle.ts', 'scripts/shared-skills/lifecycle-worker.ts', 'scripts/shared-skills/lifecycle-fixture.ts', 'scripts/shared-skills/lifecycle-metrics.ts',
  'scripts/persistence/read-admission.ts', 'scripts/persistence/read-metrics.ts',
  'src/core/shared-skills/catalog.ts', 'src/core/shared-skills/publication.ts', 'src/core/shared-skills/policy.ts', 'src/core/shared-skills/membership.ts',
  'src/core/shared-skills/retention.ts', 'src/core/shared-skills/schema.ts', 'src/core/shared-skills/schema-all.ts',
  'src/core/persistence/coordinator.ts', 'src/core/persistence/journal.ts', 'src/core/persistence/consumer.ts',
  'src/core/pglite-engine.ts', 'src/core/postgres-engine.ts', 'src/mcp/http-transport.ts', 'src/mcp/dispatch.ts',
];
function sourceHashes() {
  return Object.fromEntries(SOURCE_FILES.map(path => [path, createHash('sha256').update(readFileSync(resolve(import.meta.dir, '../..', path))).digest('hex')]));
}
export async function runLifecycleBenchmark(options: LifecycleOptions) {
  validateOptions(options);
  assert(Number.isSafeInteger(options.warmChecks) && options.warmChecks >= 1 && options.warmChecks <= 20, 'warmChecks must be from1 to20');
  assert(options.engine !== 'postgres' || options.databaseUrl, 'Postgres requires an explicit guarded test DATABASE_URL');
  const manifestPath = resolve(options.manifest);
  const sampleDirectory = join(dirname(manifestPath), `${basename(manifestPath, '.json')}.samples`, randomUUID());
  mkdirSync(sampleDirectory, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-shared-lifecycle-'));
  const requested = { engine: options.engine, sizes: options.sizes, members: options.members, queries: options.queries, runs: options.runs,
    max_writes: options.maxWrites, asset_bytes: options.assetBytes, warm_checks: options.warmChecks };
  const manifest: Record<string, any> = { schema_version: 1, benchmark: 'shared_skill_lifecycle', started_at: new Date().toISOString(),
    requested, coverage: options.smoke ? 'tiny correctness smoke, not the full measurement gate' : 'opt-in lifecycle measurement',
    status: 'running', full_gate: false, correctness_pass: false,
    thresholds: { median_loaded_p99_ratio_max: 1.5, minimum_public_mutation_overlap_pct: 90, independent_runs: 3 },
    source_hashes: sourceHashes(), environment: { bun: Bun.version, platform: process.platform, architecture: process.arch,
      logical_cpus: availableParallelism(), cpu: cpus()[0]?.model, memory_bytes: totalmem(), load_average_at_start: loadavg() },
    external_providers: 'disabled by isolated keyless child environments; no model or embedding calls',
    publication_scope: 'corpus is seeded matching filesystem/projection fixtures; measured updates use real authenticated HTTP put_skill and the canonical durable coordinator',
    samples: [] as Record<string, any>[], summaries: [] as Record<string, any>[] };
  try {
    for (const size of options.sizes) {
      const group: Record<string, any>[] = [];
      for (let run = 1; run <= options.runs; run++) {
        assert.deepEqual(sourceHashes(), manifest.source_hashes, 'Measured source changed between samples');
        const root = join(scratch, `size-${size}-run-${run}`); mkdirSync(root);
        const ownership = randomUUID(); writeFileSync(join(root, '.lifecycle-owned'), ownership);
        const samplePath = join(sampleDirectory, `size-${size}-run-${run}.json`);
        const logPath = join(sampleDirectory, `size-${size}-run-${run}.log`);
        const env = { ...childEnvironment(join(root, 'home')), GBRAIN_TEST_LIFECYCLE_OWNERSHIP: ownership,
          GBRAIN_MODEL_DISCOVERY: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', ...(options.engine === 'postgres' ? { DATABASE_URL: options.databaseUrl! } : {}) };
        process.stderr.write(`[shared lifecycle] ${options.engine}: ${size} skills, independent run ${run}/${options.runs}\n`);
        const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.path), '--worker', `--engine=${options.engine}`, `--size=${size}`,
          `--members=${options.members}`, `--queries=${options.queries}`, `--max-writes=${options.maxWrites}`, `--asset-bytes=${options.assetBytes}`,
          `--warm-checks=${options.warmChecks}`, `--root=${root}`, `--manifest=${samplePath}`], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 900_000);
        try {
          const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
          writeFileSync(logPath, `STDOUT\n${stdout}\nSTDERR\n${stderr}\nEXIT=${code}\nTIMED_OUT=${timedOut}\n`);
          let sample: Record<string, any>;
          try { sample = JSON.parse(readFileSync(samplePath, 'utf8')); }
          catch { sample = { correctness_pass: false, failure: { phase: 'worker', code: 'missing_sample_manifest' } }; }
          if (code !== 0 || timedOut) { sample.correctness_pass = false; sample.process_failure = { exit_code: code, timed_out: timedOut }; }
          sample = { ...sample, corpus: size, independent_run: run, manifest_path: samplePath, log_path: logPath };
          group.push(sample); manifest.samples.push(sample);
          assert.deepEqual(sourceHashes(), manifest.source_hashes, 'Measured source changed during a sample');
          process.stderr.write(`[shared lifecycle] valid_calls=${sample.correctness_pass}, reads=${sample.gate_sample?.phase_b?.queries_run}, ` +
            `writes=${sample.publication?.count}, overlap=${sample.gate_sample?.overlap_pct}\n`);
          if (!sample.correctness_pass) throw new Error('A lifecycle sample failed correctness or cleanup');
        } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
      }
      manifest.summaries.push({ corpus: size, ...summarizeLifecycleReadGate(group.map(sample => sample.gate_sample)) });
    }
    manifest.correctness_pass = manifest.samples.every((sample: Record<string, any>) => sample.correctness_pass);
    manifest.measurement_valid = manifest.summaries.every((summary: Record<string, any>) => summary.ok);
    manifest.relative_latency_gate_pass = manifest.summaries.every((summary: Record<string, any>) => summary.verdict === 'pass');
    manifest.full_gate = !options.smoke && options.sizes.join(',') === '10,100,1000' && options.runs === 3 && options.queries === 200 &&
      options.members === 3 && options.assetBytes === 16 * 1024 && options.warmChecks === 5 && options.maxWrites === 256 &&
      manifest.correctness_pass && manifest.measurement_valid && manifest.relative_latency_gate_pass;
    manifest.status = options.smoke ? 'smoke_completed' : manifest.full_gate ? 'passed' : 'measured_not_full_gate_pass';
  } catch (error) {
    manifest.status = 'failed'; manifest.correctness_pass = false;
    manifest.failure = { name: (error as Error).name, message: (error as Error).message.split('\n')[0] };
  } finally {
    manifest.finished_at = new Date().toISOString();
    mkdirSync(dirname(manifestPath), { recursive: true }); writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(scratch, { recursive: true, force: true });
  }
  return manifest;
}

if (import.meta.main) {
  const args = new Map(process.argv.slice(2).map(argument => { const [key, ...value] = argument.replace(/^--/, '').split('='); return [key, value.join('=')]; }));
  for (const key of args.keys()) assert(['worker', 'smoke', 'engine', 'sizes', 'size', 'members', 'queries', 'runs', 'max-writes', 'asset-bytes', 'warm-checks', 'root', 'manifest', 'informational'].includes(key), `Unknown option: ${key}`);
  const engine = args.get('engine') ?? 'pglite'; assert(engine === 'pglite' || engine === 'postgres');
  if (args.has('worker')) {
    const { runLifecycleWorker } = await import('./lifecycle-worker.ts');
    const result = await runLifecycleWorker({ engine, root: resolve(args.get('root')!), size: Number(args.get('size')), members: Number(args.get('members')),
      queries: Number(args.get('queries')), maxWrites: Number(args.get('max-writes')), assetBytes: Number(args.get('asset-bytes')),
      warmChecks: Number(args.get('warm-checks')), databaseUrl: engine === 'postgres' ? process.env.DATABASE_URL : undefined });
    writeFileSync(resolve(args.get('manifest')!), `${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.correctness_pass ? 0 : 1;
  } else {
    const smoke = args.has('smoke');
    const result = await runLifecycleBenchmark({ engine, smoke,
      sizes: (args.get('sizes') ?? (smoke ? '2' : '10,100,1000')).split(',').map(Number),
      members: Number(args.get('members') ?? (smoke ? 2 : 3)), queries: Number(args.get('queries') ?? (smoke ? 4 : 200)),
      runs: Number(args.get('runs') ?? (smoke ? 1 : 3)), maxWrites: Number(args.get('max-writes') ?? (smoke ? 4 : 256)),
      assetBytes: Number(args.get('asset-bytes') ?? (smoke ? 128 : 16 * 1024)), warmChecks: Number(args.get('warm-checks') ?? (smoke ? 1 : 5)),
      manifest: args.get('manifest') ?? `.context/shared-skills-lifecycle-${engine}.json`, databaseUrl: engine === 'postgres' ? process.env.DATABASE_URL : undefined });
    process.stdout.write(`${JSON.stringify({ status: result.status, correctness_pass: result.correctness_pass, full_gate: result.full_gate,
      summaries: result.summaries.map((summary: Record<string, unknown>) => ({ corpus: summary.corpus, verdict: summary.verdict, overlap_pct: summary.overlap_pct, delta_p99_pct: summary.delta_p99_pct })) })}\n`);
    process.exitCode = !result.correctness_pass || !smoke && (!result.measurement_valid || !args.has('informational') && !result.relative_latency_gate_pass) ? 1 : 0;
  }
}
