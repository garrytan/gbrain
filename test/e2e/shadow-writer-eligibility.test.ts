/**
 * Swap eligibility's writer observations on a Postgres primary (src/shadow/writer-observations.ts, eligibility.ts).
 *
 * Protects: on Postgres, a wrapped process notes committed writes once per refresh interval and never for a rolled-back
 * transaction; two processes on two hosts are two writer hosts; concurrent writers from one process do not wait on the
 * observation row; the eligibility SELECT runs on the pool the caller holds and a dropped database leaves the writer
 * fields out with the error code only. Regression it catches: Postgres-only behavior PGLite hides (pool concurrency,
 * real connection errors, timestamptz parameter binding).
 * Needs DATABASE_URL; skips without it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hasDatabase } from './helpers.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { wrapShadowEngine } from '../../src/shadow/wrapper.ts';
import { newMirrorCounters } from '../../src/shadow/mirror.ts';
import { WriterObserver } from '../../src/shadow/writer-observations.ts';
import { buildEligibilityStatus } from '../../src/shadow/eligibility.ts';

const d = hasDatabase() ? describe : describe.skip;

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
const dirs: string[] = [];
const observers: WriterObserver[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-writer-elig-pg-'));
  dirs.push(dir);
  return dir;
}

function observer(primary: BrainEngine, dir: string, host: string, app: string): WriterObserver {
  const o = new WriterObserver({ primary, dir, identity: () => ({ hostId: host, applicationName: app, processKind: 'serve', gbrainVersion: 'test' }) });
  observers.push(o);
  return o;
}

async function settle(o: WriterObserver): Promise<void> { while (o.inFlight) await o.inFlight; }

const sink = { counters: newMirrorCounters(), offer: () => undefined, active: () => true };
const put = (e: BrainEngine, slug: string) => e.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}`, timeline: '' } as never);

d('writer observations on Postgres', () => {
  beforeAll(async () => { template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); }, 60_000);
  afterEach(async () => {
    for (const o of observers.splice(0)) o.stop();
    await close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('committed writes note one row per process; a rolled-back transaction notes none', async () => {
    const dir = tempDir();
    const o = observer(engine, dir, '11111111-1111-4111-8111-111111111111', 'gbrain serve:10:aaaaaaaa');
    const wrapped = wrapShadowEngine(engine, sink, { sampleRate: 0, onCommittedWrite: () => o.note() });
    await expect(wrapped.transaction(async (tx) => { await put(tx, 'notes/rb'); throw new Error('roll back'); })).rejects.toThrow('roll back');
    await settle(o);
    expect(await engine.executeRaw('SELECT count(*)::int AS n FROM engine_writer_observations')).toEqual([{ n: 0 }]);
    await Promise.all(Array.from({ length: 8 }, (_, i) => put(wrapped, `notes/p${i}`)));
    await settle(o);
    expect(await engine.executeRaw('SELECT count(*)::int AS n FROM engine_writer_observations')).toEqual([{ n: 1 }]);
  }, 60_000);

  test('two hosts are two writer hosts; one process on one host is one', async () => {
    const dir = tempDir();
    const a = observer(engine, dir, '11111111-1111-4111-8111-111111111111', 'gbrain serve:10:aaaaaaaa');
    a.note(); await settle(a);
    const one = await buildEligibilityStatus({ dir, state: null, engine, source: { name: 't', unknownPaths: () => 0 }, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' });
    expect(one.eligibility.writer_hosts_7d).toBe(1);
    const b = observer(engine, dir, '22222222-2222-4222-8222-222222222222', 'gbrain sync:20:bbbbbbbb');
    b.note(); await settle(b);
    const two = await buildEligibilityStatus({ dir, state: null, engine, source: { name: 't', unknownPaths: () => 0 }, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' });
    expect(two.eligibility.writer_hosts_7d).toBe(2);
  }, 60_000);

  test('a closed pool leaves the writer fields out and reports only the error code', async () => {
    const dir = tempDir();
    const { engine: other, close: closeOther } = await template.clone();
    await closeOther();
    const out = await buildEligibilityStatus({ dir, state: null, engine: other, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' });
    expect('writer_hosts_7d' in out.eligibility).toBe(false);
    expect(out.eligibility_evidence?.state).toBe('read_failed');
    expect(Object.keys(out.eligibility_evidence ?? {}).sort()).toEqual(['code', 'state']);
    expect(out.eligibility_evidence!.code).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
  }, 60_000);
});
