import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import { assertSafeE2eDatabaseUrl } from '../../test/helpers/db-guard.ts';
import { distribution, type HarnessConfig } from './harness.ts';
import { keylessBrainEnv } from '../../test/helpers/provider-env.ts';
import { boundedDiagnostic, diagnosticError, retentionMetadata } from './failure-diagnostics.ts';

export interface ValidationOptions {
  engine: 'pglite' | 'postgres'; schedules?: number; operations?: number; seed?: number;
  crashes?: boolean; databaseUrl?: string; manifest?: string;
}
interface Event { event: string; [key: string]: any; }
export const CRASH_BOUNDARIES = ['admitted', 'prepared', 'before_publication', 'staging_flushed',
  'after_publication', 'before_commit', 'after_commit', 'after_response'] as const;
export function childEnvironment(home: string): Record<string, string> {
  // Preserve the runtime executable/search paths, never an operator's brain or provider configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
    !/^(GBRAIN_|CONDUCTOR_|MCP_|OPENCLAW_|ANTHROPIC_|OPENAI_|DATABASE_URL$)/.test(key))) as Record<string, string>;
  return keylessBrainEnv(env, home, { GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1', GBRAIN_PERSISTENCE_FIXTURE_HOME: home });
}
export function spawnWorker(configPath: string, home: string, role: string, args: string[] = [], environment: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, 'worker.ts'), role, configPath, ...args],
    { env: { ...childEnvironment(home), ...environment }, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
  const events: Event[] = []; const waiters = new Set<() => void>(); let ended = false; let tail = '';
  const reading = (async () => {
    const decoder = new TextDecoder(); let pending = '';
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) { const newline = pending.indexOf('\n'); if (newline < 0) break;
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1); tail = `${tail}\n${line}`.slice(-16000);
        try { const event = JSON.parse(line); if (typeof event.event === 'string') events.push(event); } catch { /* driver startup diagnostics */ }
        for (const wake of waiters) wake();
      }
    }
    ended = true; for (const wake of waiters) wake();
  })();
  async function event(name: string, timeoutMs = 5_400_000): Promise<Event> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = events.findIndex(e => e.event === name); if (index >= 0) return events.splice(index, 1)[0];
      const failure = events.find(e => e.event === 'failure'); if (failure) throw new Error(`${role}: ${failure.message}`);
      if (ended) throw new Error(`${role} exited before ${name} (exit=${await child.exited}): ${tail}`);
      assert(Date.now() < deadline, `${role} timed out before ${name}`);
      await new Promise<void>(done => {
        const timer = setTimeout(wake, Math.min(1000, deadline - Date.now()));
        function wake() { clearTimeout(timer); waiters.delete(wake); done(); } waiters.add(wake);
      });
    }
  }
  async function done(): Promise<Event> { const result = await event('done'); assert.equal(await child.exited, 0, `${role} failed`); await reading; return result; }
  return { child, event, done,
    failureDiagnostics: () => events.filter(event => event.event === 'failure' && event.diagnostics).slice(0, 1)
      .map(event => ({ role, pid: child.pid, ...event.diagnostics })),
    async kill() { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; await reading; } };
}

/** Every PostgreSQL phase owns a new database; disk PGLite always runs in children. */
export async function runValidation(options: ValidationOptions) {
  const counts = { schedules: options.schedules ?? 1000, operations: options.operations ?? 10_000 };
  for (const [key, value] of Object.entries(counts)) assert(Number.isSafeInteger(value) && value >= 0, `Invalid ${key}`);
  assert(Number.isSafeInteger(options.seed ?? 5105) && (options.seed ?? 5105) >= 0 && (options.seed ?? 5105) <= 0xFFFFFFFF, 'Invalid unsigned 32-bit seed');
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-persistence-validation-')); const home = join(scratch, 'home'); mkdirSync(home);
  const children: ReturnType<typeof spawnWorker>[] = []; const databases: string[] = [];
  const ownerUrls: string[] = [];
  let admin: ReturnType<typeof postgres> | undefined;
  let originalFailure = false;
  const manifest: Record<string, any> = { version: 1, engine: options.engine, runtime: `bun-${Bun.version}`,
    platform: process.platform, architecture: process.arch, seed: options.seed ?? 5105,
    environment: { logical_cpus: availableParallelism(), memory_bytes: totalmem(), load_average_at_start: loadavg() },
    started_at: new Date().toISOString(), status: 'running', requested: { ...counts, crashes: options.crashes !== false },
    managed_persistence: true, scope: 'activated real journal/coordinator; fixture-only loopback transport for PGLite producers', crash_cases: [], phase_inputs: {} };
  const at = performance.now();
  try {
    if (options.engine === 'postgres') {
      assert(options.databaseUrl, 'Postgres validation requires an explicit test DATABASE_URL');
      assertSafeE2eDatabaseUrl(options.databaseUrl); admin = postgres(options.databaseUrl, { max: 1, onnotice() {} });
    }
    async function phase(name: string): Promise<{ config: HarnessConfig; path: string }> {
      const root = join(scratch, name); mkdirSync(root);
      manifest.phase_inputs[name] = Object.fromEntries(['scripts/persistence/harness.ts', 'scripts/persistence/schedules.ts',
        'scripts/persistence/worker.ts', 'scripts/persistence/validate.ts', 'scripts/persistence/failure-diagnostics.ts',
        'src/core/atomic-write.ts', 'src/core/persistence/staging.ts', 'src/core/persistence/model.ts',
        'src/core/persistence/effect-recovery.ts', 'src/core/persistence/effect-model.ts', 'src/core/persistence/effects.ts',
        'src/core/persistence/coordinator.ts', 'src/core/persistence/consumer.ts',
        'src/core/persistence/journal.ts', 'src/core/persistence/activation.ts', 'src/core/persistence/filesystem-guard.ts',
        'src/core/persistence/identity.ts', 'src/core/persistence/ownership.ts', 'src/core/pglite-engine.ts', 'src/core/postgres-engine.ts'].map(file =>
        [file, createHash('sha256').update(readFileSync(resolve(import.meta.dir, '../..', file))).digest('hex')]));
      let databaseUrl: string | undefined;
      if (admin) {
        const database = `gbrain_persistence_test_${randomUUID().replaceAll('-', '')}`;
        await admin.unsafe(`CREATE DATABASE ${database}`); databases.push(database);
        const url = new URL(options.databaseUrl!); url.pathname = `/${database}`; databaseUrl = url.toString();
      }
      const config: HarnessConfig = { kind: options.engine, root, dataDir: join(root, 'data'), databaseUrl,
        hostId: randomUUID(), seed: options.seed ?? 5105, ...counts,
        sourceIds: Array.from({ length: 4 }, (_, i) => `persistence-test-${i}`), principalIds: Array.from({ length: 4 }, () => randomUUID()) };
      const path = join(root, 'config.json'); writeFileSync(path, JSON.stringify(config), { mode: 0o600 }); return { config, path };
    }
    function start(path: string, role: string, ...args: string[]) { const child = spawnWorker(path, home, role, args); children.push(child); return child; }
    if (options.crashes !== false) for (const boundary of CRASH_BOUNDARIES) {
      const { path } = await phase(`crash-${boundary}`); const requestId = randomUUID();
      const child = start(path, 'crash', boundary, requestId);
      const reached = await child.event(boundary === 'after_response' ? 'response_ready' : 'boundary');
      assert.equal(reached.boundary, boundary); assert.equal(reached.requestId, requestId);
      if (boundary === 'after_response') {
        const response = await fetch(reached.url, { signal: AbortSignal.timeout(5_000) });
        assert(response.ok); const receipt = await response.json();
        assert.equal(receipt.request_id, requestId); assert.equal(receipt.state, 'committed');
        assert.equal(receipt.persistence.mode, 'filesystem');
      }
      await child.kill();
      const recovered = await start(path, 'recover', boundary, requestId).done();
      assert.equal(recovered.result.boundary, boundary);
      manifest.crash_cases.push({ ...recovered.result, ...(boundary === 'after_response' ? { response_read_before_kill: true } : {}) });
      process.stderr.write(`[persistence] ${options.engine}: SIGKILL/${boundary} durable recovery verified\n`);
    }
    if (counts.schedules) {
      const { path } = await phase('schedules'); await start(path, 'initialize').done();
      manifest.schedules = (await start(path, 'schedules').done()).result;
    }
    if (counts.operations) {
      const { path } = await phase('soak'); await start(path, 'initialize').done(); const started = performance.now();
      const owners = Array.from({ length: options.engine === 'postgres' ? 2 : 1 }, () => start(path, 'owner'));
      const ready = await Promise.all(owners.map(owner => owner.event('ready')));
      ownerUrls.push(...ready.map(owner => owner.url));
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => start(path, 'producer', String(i), ready[0].url).done()));
      const ownerResults = await Promise.all(ready.map(async owner => {
        const response = await fetch(new URL('stop', owner.url), { method: 'POST' }); assert(response.ok); return response.json();
      }));
      for (const owner of owners) assert.equal(await owner.child.exited, 0, 'resident must drain and close successfully');
      for (const owner of ownerResults) assert.deepEqual(owner.errors, [], 'resident storage errors require investigation');
      const verification = (await start(path, 'verify-soak').done()).result;
      assert.equal(results.reduce((sum, row) => sum + row.result.completed, 0), counts.operations);
      const duration = performance.now() - started;
      manifest.soak = { ...verification, producer_processes: 4, owner_processes: owners.length,
        producer_admission: options.engine === 'postgres' ? 'independent database clients' : 'resident fixture loopback endpoint',
        duration_ms: duration, operations_per_second: counts.operations / (duration / 1000),
        duplicate_replays: results.reduce((sum, row) => sum + row.result.replays, 0),
        admission: distribution(results.flatMap(row => row.result.admission_ms)),
        caller_completion: distribution(results.flatMap(row => row.result.completion_ms)),
        concurrent_canonical_read: distribution(ownerResults.flatMap(owner => owner.concurrent_read_ms)),
        peak_owner_rss_bytes: Math.max(...ownerResults.map(owner => owner.peak_rss_bytes)) };
    }
    manifest.status = 'passed';
    const executedBoundaries = manifest.crash_cases.map((entry: { boundary: string }) => entry.boundary);
    if (options.crashes !== false) assert.deepEqual(executedBoundaries, [...CRASH_BOUNDARIES]);
    manifest.full_gate = counts.schedules >= 1000 && counts.operations >= 10_000
      && executedBoundaries.length === CRASH_BOUNDARIES.length && CRASH_BOUNDARIES.every((boundary, index) => executedBoundaries[index] === boundary)
      && manifest.crash_cases.every((entry: { staging_cleanup_verified?: boolean }) => entry.staging_cleanup_verified === true)
      && manifest.crash_cases.find((entry: { boundary: string }) => entry.boundary === 'staging_flushed')?.flushed_before_rename_verified === true
      && manifest.crash_cases.find((entry: { boundary: string }) => entry.boundary === 'staging_flushed')?.unexpected_staging_preserved === true
      && manifest.crash_cases.find((entry: { boundary: string }) => entry.boundary === 'after_response')?.response_read_before_kill === true;
    return manifest;
  } catch (error) {
    originalFailure = true; manifest.status = 'failed'; manifest.full_gate = false; manifest.failure = String(error);
    // Cached producer state is already available; a stuck owner adds only a
    // bounded timeout marker. URLs and credentials never enter this manifest.
    manifest.failure_diagnostics = await boundedDiagnostic(async () => ({
      workers: children.flatMap(child => child.failureDiagnostics()),
      owners: await Promise.all(ownerUrls.map(url => boundedDiagnostic(async () => {
        const response = await fetch(new URL('diagnostics', url), { signal: AbortSignal.timeout(1_500) });
        assert(response.ok, 'Owner diagnostic endpoint failed'); return response.json();
      }, 1_750))),
    }));
    throw error;
  }
  finally {
    const stopChildren = async () => {
      const stopped = await Promise.allSettled(children.map(child => child.kill()));
      const failed = stopped.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    };
    const shutdown = originalFailure ? await boundedDiagnostic(stopChildren) : (await stopChildren(), { status: 'ok' as const });
    if (admin && !originalFailure) for (const database of databases) await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    if (admin) {
      if (originalFailure) manifest.admin_close_diagnostic = await boundedDiagnostic(() => admin!.end({ timeout: 1 }));
      else await admin.end();
    }
    if (manifest.status === 'failed') {
      const retainedPath = options.manifest ? `${resolve(options.manifest)}.retained.json` : join(scratch, 'retained.json');
      try {
        mkdirSync(dirname(retainedPath), { recursive: true });
        writeFileSync(retainedPath, `${JSON.stringify({ ...retentionMetadata(scratch, databases),
          worker_pids: children.map(child => child.child.pid), worker_shutdown: shutdown }, null, 2)}\n`, { mode: 0o600 });
        manifest.failure_artifacts = { retained: true, metadata_file: basename(retainedPath) };
        process.stderr.write(`[persistence] Failed fixtures retained. Private cleanup metadata: ${retainedPath}\n`);
      } catch (error) {
        manifest.failure_artifacts = { retained: true, metadata_error_code: diagnosticError(error) };
        // The scratch directory survives even when the report volume is full.
        process.stderr.write(`[persistence] Could not write cleanup metadata; synthetic scratch retained at ${scratch}\n`);
      }
    }
    manifest.finished_at = new Date().toISOString(); manifest.duration_ms = performance.now() - at;
    try {
      if (options.manifest) { mkdirSync(dirname(resolve(options.manifest)), { recursive: true }); writeFileSync(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`); }
    } catch (error) {
      if (!originalFailure) throw error;
      process.stderr.write(`[persistence] Manifest write failed (${diagnosticError(error)}); original failure preserved.\n`);
    }
    if (!originalFailure) rmSync(scratch, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const args = new Map(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=')]; }));
  for (const key of args.keys()) assert(['engine', 'schedules', 'operations', 'seed', 'no-crashes', 'manifest'].includes(key), `Unknown option: ${key}`);
  const engine = args.get('engine') ?? 'pglite'; assert(engine === 'pglite' || engine === 'postgres');
  const result = await runValidation({ engine, schedules: Number(args.get('schedules') ?? 1000), operations: Number(args.get('operations') ?? 10_000),
    seed: Number(args.get('seed') ?? 5105), crashes: !args.has('no-crashes'), databaseUrl: process.env.DATABASE_URL,
    manifest: args.get('manifest') ?? `.context/persistence-${engine}-manifest.json` });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
