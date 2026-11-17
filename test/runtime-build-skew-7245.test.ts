/**
 * #7245: several foresights builds run at once on one host and nothing reported it.
 * After a checkout reset or an upgrade on disk, serve, the jobs supervisor and
 * the worker parents keep the build they loaded (in memory) while every
 * `jobs run-child` runs the build on disk. Pins the records each long-running
 * process now writes (worker registry, supervisor PID file, serve /health) and
 * the job child's per-job comparison with its worker's build: a differing
 * version runs and is recorded in the job's history; a protocol or feature the
 * worker needs and the child lacks refuses the job.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runChildJobEntry } from '../src/core/minions/run-child.ts';
import { runJobInChild } from '../src/core/minions/child-job-runner.ts';
import { decodeChildOutcomeFile } from '../src/core/minions/job-isolation.ts';
import { WORKER_EXIT_CONFIGURATION } from '../src/core/minions/worker-exit-codes.ts';
import { CHILD_READINESS_FEATURES, CHILD_READINESS_PROTOCOL_VERSION, JOB_BUILD_SKEW_PREFIX, jobChildBuildVerdict, parentBuildEnvValue } from '../src/core/minions/child-readiness.ts';
import { installedVersion, runtimeInstallRoot, serveBuild } from '../src/core/runtime-build.ts';
import { pidFileContents, readSupervisorBuild } from '../src/core/minions/supervisor-pid.ts';
import { registerWorker, workerRegistryDir } from '../src/core/minions/worker-registry.ts';
import { createMetricsCounters, mountHealth } from '../src/commands/serve-http-metrics.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { VERSION } from '../src/version.ts';
import { withEnv } from './helpers/with-env.ts';

const OLD = '0.60.1.0';
let engine: PGLiteEngine;
let queue: MinionQueue;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
  dir = mkdtempSync(join(tmpdir(), 'gbrain-build-skew-7245-'));
});
afterAll(async () => {
  await engine.disconnect();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS reaps tmpdir */ }
});
beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

const parentBuild = (over: { version?: string; protocol_version?: number; features?: string[] } = {}) => JSON.stringify({
  version: over.version ?? OLD, protocol_version: over.protocol_version ?? CHILD_READINESS_PROTOCOL_VERSION,
  features: over.features ?? ['local-configuration-outcome-v1', 'postgres-cancellation-v1'] });

async function claimed(name: string) {
  await queue.add(name, {});
  const job = await queue.claim('worker-7245:1', 30_000, 'default', [name]);
  if (!job) throw new Error('claim failed in test setup');
  return job;
}

describe('runtime build identity', () => {
  test('the install root this process loaded from holds this VERSION on disk', () => {
    const root = runtimeInstallRoot();
    expect(root).not.toBeNull();
    expect(installedVersion(root)).toBe(VERSION);
  });

  test('installedVersion reads the version on disk now, and nothing it cannot trust', () => {
    const root = join(dir, 'install');
    mkdirSync(root, { recursive: true });
    expect(installedVersion(root)).toBeNull();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'gbrain', version: '0.60.9.0' }));
    expect(installedVersion(root)).toBe('0.60.9.0');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'other-package', version: '0.60.9.0' }));
    expect(installedVersion(root)).toBeNull();
    expect(installedVersion(null)).toBeNull();
  });

  test('serve reports its build with no path in it', () => {
    const build = serveBuild(Date.now() + 3_600_000);
    expect(build).toEqual({ version: VERSION, installed_version: VERSION, restart_pending: false });
  });

  test('/health carries the build on a 200', async () => {
    const app = express();
    mountHealth(app, { engine, config: { engine: 'pglite' }, requireAdmin: () => undefined, metricsCounters: createMetricsCounters() } as unknown as ServeHttpContext);
    const server: Server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    try {
      const addr = server.address();
      const res = await fetch(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.build).toEqual({ version: VERSION, installed_version: VERSION, restart_pending: false });
      expect(JSON.stringify(body)).not.toContain(runtimeInstallRoot()!);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('a worker registry entry records the worker build and install', () => {
    const home = join(dir, 'home-registry');
    withEnv({ GBRAIN_HOME: home }, () => {
      const cleanup = registerWorker({ pid: process.pid, queue: 'default', nice_requested: null, nice_effective: null, started_at: Date.now() });
      try {
        const entry = JSON.parse(readFileSync(join(workerRegistryDir(), `worker-${process.pid}.json`), 'utf8'));
        expect(entry.version).toBe(VERSION);
        expect(entry.install_root).toBe(runtimeInstallRoot());
      } finally { cleanup(); }
    });
  });

  test('the supervisor PID file records its build on lines 4 and 5; an older three-line file reads as unrecorded', () => {
    const lines = pidFileContents(process.pid, 'host-a').split('\n');
    expect(lines[2]).toBe('host-a');
    expect(lines[3]).toBe(VERSION);
    expect(lines[4]).toBe(runtimeInstallRoot() ?? '');
    const file = join(dir, 'supervisor.pid');
    writeFileSync(file, pidFileContents(process.pid, 'host-a'));
    expect(readSupervisorBuild(file)).toEqual({ version: VERSION, install_root: runtimeInstallRoot() });
    writeFileSync(file, `${process.pid}\n\nhost-a\n`);
    expect(readSupervisorBuild(file)).toBeNull();
    expect(readSupervisorBuild(join(dir, 'missing.pid'))).toBeNull();
  });
});

describe('job child build verdict', () => {
  test('the worker build names the features the job needs', () => {
    expect(JSON.parse(parentBuildEnvValue(false))).toEqual({ version: VERSION, protocol_version: CHILD_READINESS_PROTOCOL_VERSION,
      features: ['local-configuration-outcome-v1', 'postgres-cancellation-v1'] });
    expect(JSON.parse(parentBuildEnvValue(true)).features).toContain('spend-enforcement-v1');
  });

  test('the same build, an older worker that sends none and an unreadable value report nothing', () => {
    expect(jobChildBuildVerdict(parentBuildEnvValue(true), 42)).toBeNull();
    expect(jobChildBuildVerdict(undefined, 42)).toBeNull();
    expect(jobChildBuildVerdict('not json', 42)).toBeNull();
    expect(jobChildBuildVerdict(JSON.stringify({ version: 'v-latest' }), 42)).toBeNull();
  });

  test('a differing version with a compatible protocol runs and names both builds', () => {
    const verdict = jobChildBuildVerdict(parentBuild(), 42)!;
    expect(verdict.refused).toBe(false);
    expect(verdict.worker_version).toBe(OLD);
    expect(verdict.note).toStartWith(`${JOB_BUILD_SKEW_PREFIX} job child v${VERSION} ran under worker pid 42 v${OLD}`);
  });

  test('a protocol mismatch or a feature the child lacks refuses the job', () => {
    const protocol = jobChildBuildVerdict(parentBuild({ protocol_version: CHILD_READINESS_PROTOCOL_VERSION + 1 }), 42)!;
    expect(protocol.refused).toBe(true);
    expect(protocol.note).toStartWith(`${JOB_BUILD_SKEW_PREFIX} job child v${VERSION} refused to run under worker pid 42 v${OLD}`);
    const feature = jobChildBuildVerdict(parentBuild({ version: VERSION, features: [...CHILD_READINESS_FEATURES, 'future-feature-v9'] }), 42)!;
    expect(feature.refused).toBe(true);
    expect(feature.note).toContain('this child lacks future-feature-v9');
  });
});

describe('runChildJobEntry records the build decision on the job', () => {
  test('a skewed child runs the handler and leaves one history entry naming both builds', async () => {
    const job = await claimed('sync');
    const resultPath = join(dir, `skew-${job.id}.json`);
    let ran = false;
    const code = await runChildJobEntry(engine, { jobId: job.id, lockToken: 'worker-7245:1', resultPath, parentPid: 4242, parentBuild: parentBuild() },
      { resolveHandler: () => async () => { ran = true; return { ok: true }; } });
    expect(code).toBe(0);
    expect(ran).toBe(true);
    expect(decodeChildOutcomeFile(resultPath).outcome).toBe('success');
    const after = await queue.getJob(job.id);
    const notes = after!.stacktrace.filter(line => line.startsWith(JOB_BUILD_SKEW_PREFIX));
    expect(notes).toEqual([jobChildBuildVerdict(parentBuild(), 4242)!.note]);
  });

  test('a child missing what the worker needs runs nothing and reports a configuration outcome', async () => {
    const job = await claimed('sync');
    const resultPath = join(dir, `refuse-${job.id}.json`);
    let ran = false;
    const build = parentBuild({ features: ['local-configuration-outcome-v1', 'future-feature-v9'] });
    const code = await runChildJobEntry(engine, { jobId: job.id, lockToken: 'worker-7245:1', resultPath, parentPid: 4242, parentBuild: build },
      { resolveHandler: () => async () => { ran = true; } });
    expect(code).toBe(WORKER_EXIT_CONFIGURATION);
    expect(ran).toBe(false);
    const outcome = decodeChildOutcomeFile(resultPath);
    if (outcome.outcome !== 'error') throw new Error('expected an error outcome');
    expect(outcome.errorKind).toBe('local_configuration');
    expect(JSON.stringify(outcome)).toContain('child_protocol_incompatible');
    const after = await queue.getJob(job.id);
    expect(after!.stacktrace.some(line => line.startsWith(`${JOB_BUILD_SKEW_PREFIX} job child v${VERSION} refused to run under worker pid 4242 v${OLD}`))).toBe(true);
  });

  test('a child on its worker build writes no history entry', async () => {
    const job = await claimed('sync');
    const resultPath = join(dir, `same-${job.id}.json`);
    const code = await runChildJobEntry(engine, { jobId: job.id, lockToken: 'worker-7245:1', resultPath, parentPid: 4242, parentBuild: parentBuildEnvValue(false) },
      { resolveHandler: () => async () => ({ ok: true }) });
    expect(code).toBe(0);
    expect((await queue.getJob(job.id))!.stacktrace).toEqual([]);
  });
});

describe('runJobInChild hands the worker build to every job child', () => {
  test('the child env carries this worker build and the features the job needs', async () => {
    const harness = join(dir, 'echo-build.mjs');
    writeFileSync(harness, `import { writeFileSync, renameSync } from 'node:fs';
const RESULT = process.env.GBRAIN_JOB_RESULT_PATH;
writeFileSync(RESULT + '.tmp', JSON.stringify({ outcome: 'success', result: { build: process.env.GBRAIN_JOB_PARENT_BUILD } }));
renameSync(RESULT + '.tmp', RESULT);
`);
    const result = await runJobInChild({ jobId: 7245, jobName: 'sync', lockToken: 'tok-7245', abortSignal: new AbortController().signal,
      shutdownSignal: new AbortController().signal, invocation: { cmd: process.execPath, argsPrefix: [harness] }, tiniPath: '' }) as { build: string };
    expect(JSON.parse(result.build)).toEqual(JSON.parse(parentBuildEnvValue(false)));
  }, 30_000);
});
