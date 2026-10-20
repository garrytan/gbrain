/**
 * #5856: the autopilot atom auto-drain submission pass, driven through the
 * real queue on PGLite (the tick itself is Postgres-gated; see the e2e
 * wrapper). Fairness between checkout-backed and connector sources, the
 * attempt-counted daily cap, the structural-refusal exclusion, the writer
 * pre-check and the opt-in for connector email/meeting pages.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { submitAutoDrains, AUTO_DRAIN_NEXT_KIND_KEY } from '../src/commands/autopilot-dispatch.ts';
import { resolveAutopilotAutoDrainBounds } from '../src/commands/autopilot-timeout.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: BrainEngine;
let queue: MinionQueue;
let home: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (testBackends().join() === 'postgres') {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine;
    closePostgres = pg.close;
  } else {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }
  queue = new MinionQueue(engine);
}, 120_000);
afterAll(async () => { if (closePostgres) await closePostgres(); else await engine.disconnect(); });
async function reset(): Promise<void> {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw("DELETE FROM pages");
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'autopilot.auto_drain.%' OR key LIKE 'cycle.extract_atoms.%'");
}
beforeEach(async () => {
  await reset();
  home = mkdtempSync(join(tmpdir(), 'gbrain-auto-drain-'));
  await engine.setConfig('autopilot.auto_drain.threshold', '1');
});

const DAY1 = Date.parse('2026-09-20T12:00:00Z');
const DAY2 = Date.parse('2026-09-21T12:00:00Z');
const prose = (n: string) => `A durable decision about ${n}, recorded in prose with context. `.repeat(12);

async function gitSource(id: string, pages = 2): Promise<void> {
  const root = join(home, id);
  mkdirSync(root, { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
  for (let i = 0; i < pages; i++) {
    await engine.putPage(`notes/${id}-${i}`, { type: 'note', title: `${id} ${i}`, compiled_truth: prose(`${id} ${i}`) } as never, { sourceId: id });
  }
}

async function connectorSource(id: string, type: 'email' | 'meeting' = 'email', pages = 2): Promise<void> {
  const state = join(home, `${id}-state`);
  mkdirSync(state, { recursive: true });
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,jsonb_build_object('kind','google'))", [id, state]);
  for (let i = 0; i < pages; i++) {
    await engine.putPage(`${type === 'email' ? 'emails' : 'calendar'}/${id}-${i}`, { type, title: `${id} ${i}`, compiled_truth: prose(`${id} ${i}`) } as never, { sourceId: id });
  }
}

async function tick(now = DAY1, timeoutMs = 60_000): Promise<string> {
  let stderr = '';
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    await withEnv({ GBRAIN_HOME: home }, () => submitAutoDrains(engine, queue, { timeoutMs, jsonMode: true, now: () => now }));
  } finally { process.stderr.write = write; }
  await engine.executeRaw("UPDATE minion_jobs SET created_at=$1::timestamptz WHERE idempotency_key LIKE '%:' || $2",
    [new Date(now).toISOString(), new Date(now).toISOString().slice(0, 10)]);
  return stderr;
}

async function submitted(): Promise<Array<{ source: string; repo: string | null }>> {
  return engine.executeRaw<{ source: string; repo: string | null }>(
    "SELECT data->>'sourceId' AS source, data->>'repoPath' AS repo FROM minion_jobs WHERE name='extract-atoms-drain' ORDER BY id");
}

async function priorJob(sourceId: string, day: number, row: { status: string; attempts: number; error?: string }): Promise<void> {
  const job = await queue.add('extract-atoms-drain', { sourceId, window: 120 },
    { queue: 'default', idempotency_key: `autopilot-extract-atoms-drain:${sourceId}:${new Date(day).toISOString().slice(0, 10)}`, max_attempts: 3 },
    { allowProtectedSubmit: true });
  await engine.executeRaw(`UPDATE minion_jobs SET status=$2, attempts_started=$3, attempts_made=$3, error_text=$4, created_at=$5::timestamptz WHERE id=$1`,
    [job.id, row.status, row.attempts, row.error ?? null, new Date(day).toISOString()]);
}

test('six backlogged git sources and one connector source under the default cap: the connector gets a slot', async () => {
  for (const n of [1, 2, 3, 4, 5, 6]) await gitSource(`git-${n}`);
  await connectorSource('gmail');
  await tick();
  const jobs = await submitted();
  expect(jobs).toHaveLength(6);
  expect(jobs.map(j => j.source)).toEqual(['git-1', 'gmail', 'git-2', 'git-3', 'git-4', 'git-5']);
  expect(jobs.find(j => j.source === 'gmail')!.repo).toBeNull();
  expect(jobs.find(j => j.source === 'git-1')!.repo).toBe(join(home, 'git-1'));
});

test('one slot left with a git and a connector source: the git source is submitted, the connector goes first next day', async () => {
  await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3');
  await gitSource('git-a');
  await connectorSource('gmail');
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a']);
  expect(await engine.getConfig(AUTO_DRAIN_NEXT_KIND_KEY)).toBe('connector');
  await tick(DAY2);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a', 'gmail']);
  expect(await engine.getConfig(AUTO_DRAIN_NEXT_KIND_KEY)).toBe('checkout');
});

test('a structural refusal frees its slot and is not resubmitted the same day; a provider-failure dead letter keeps its units', async () => {
  await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3');
  await gitSource('git-a');
  await gitSource('git-b');
  await priorJob('git-a', DAY1, { status: 'dead', attempts: 1, error: 'structural_refusal: owner_unavailable: Atom maintenance requires the configured canonical owner.' });
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a', 'git-b']);
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a', 'git-b']);

  await reset();
  await engine.setConfig('autopilot.auto_drain.threshold', '1');
  await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3');
  await gitSource('git-c');
  await gitSource('git-d');
  await priorJob('git-c', DAY1, { status: 'dead', attempts: 1, error: 'extract-atoms-drain: all provider calls failed this batch (batches=1, remaining=2)' });
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-c']);
});

test('the cap counts attempts: a job retried three times consumes three units', async () => {
  await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.9');
  await gitSource('git-a');
  await gitSource('git-b');
  await priorJob('git-a', DAY1, { status: 'dead', attempts: 3, error: 'extract-atoms-drain: all provider calls failed this batch (batches=1, remaining=2)' });
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a']);
  await engine.executeRaw("UPDATE minion_jobs SET attempts_started=2, attempts_made=2 WHERE data->>'sourceId'='git-a'");
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a', 'git-b']);
});

test('connector email and meeting pages drain by default; opted out, a connector backlog submits nothing', async () => {
  await engine.setConfig('cycle.extract_atoms.connector_pages', 'false');
  await connectorSource('gmail', 'email');
  await connectorSource('gcal', 'meeting');
  await tick(DAY1);
  expect(await submitted()).toEqual([]);
  await engine.executeRaw("DELETE FROM config WHERE key='cycle.extract_atoms.connector_pages'");
  await tick(DAY1);
  expect((await submitted()).map(j => j.source).sort()).toEqual(['gcal', 'gmail']);
});

test('managed brain: a source whose writer preflight would refuse is skipped with its reason; an unbound connector is submitted database-only', async () => {
  await gitSource('git-unowned');
  await connectorSource('gmail');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  let stderr: string;
  try { stderr = await tick(DAY1); }
  finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
  expect(await submitted()).toEqual([{ source: 'gmail', repo: null }]);
  const skip = stderr.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(e => e.event === 'auto_drain_source_skipped');
  expect(skip).toMatchObject({ source_id: 'git-unowned' });
  expect(skip.reason).toContain('requires the configured canonical owner');
});

test('automatic drain window and job deadline are bounded together', () => {
  // The drain hard-stops at the job deadline (#5809); its soft window is only checked between
  // batches. The deadline must cover the window plus a final chat call (two on a schema retry).
  expect(resolveAutopilotAutoDrainBounds(600_000, 120, 300_000)).toEqual({ windowSeconds: 120, timeoutMs: 780_000 });
  expect(resolveAutopilotAutoDrainBounds(600_000, 900, 300_000)).toEqual({ windowSeconds: 900, timeoutMs: 1_560_000 });
  expect(resolveAutopilotAutoDrainBounds(600_000, Number.MAX_VALUE, 300_000)).toEqual({ windowSeconds: 1140, timeoutMs: 1_800_000 });
  expect(resolveAutopilotAutoDrainBounds(3_600_000, 900, 300_000)).toEqual({ windowSeconds: 900, timeoutMs: 3_600_000 });
  expect(resolveAutopilotAutoDrainBounds(600_000, 900, 300_000.5)).toEqual({ windowSeconds: 900, timeoutMs: 1_560_001 });
  // A chat timeout that leaves no room under the anchor still gets a deadline covering its one-second window.
  expect(resolveAutopilotAutoDrainBounds(600_000, 900, 869_600)).toEqual({ windowSeconds: 1, timeoutMs: 1_800_200 });
});

for (const row of [
  { setting: null, interval: 600_000, window: 120, timeout: 780_000 },
  { setting: '900', interval: 600_000, window: 900, timeout: 1_560_000 },
  { setting: '86400', interval: 600_000, window: 1140, timeout: 1_800_000 },
  { setting: '900', interval: 3_600_000, window: 900, timeout: 3_600_000 },
]) {
  test(`queued drain covers window ${row.setting ?? 'default'} at a ${row.interval}ms dispatch deadline`, async () => {
    if (row.setting !== null) await engine.setConfig('autopilot.auto_drain.window_seconds', row.setting);
    await gitSource('git-a');
    await tick(DAY1, row.interval);
    const jobs = await engine.executeRaw<{ window: number; timeout_ms: number }>(
      "SELECT (data->>'window')::int AS window, timeout_ms FROM minion_jobs WHERE name='extract-atoms-drain'");
    expect(jobs).toHaveLength(1);
    expect(Number(jobs[0].window)).toBe(row.window);
    expect(Number(jobs[0].timeout_ms)).toBe(row.timeout);
    expect(Number(jobs[0].timeout_ms)).toBeGreaterThan(row.window * 1000);
  });
}
