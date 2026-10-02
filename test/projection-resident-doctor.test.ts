/**
 * #5401 E-T1: while a PGLite resident holds the datastore, doctor cannot open
 * the engine; the resident answers a read-only projection_status IPC op with
 * counts only, and doctor's filesystem-lane entry reports the backlog from it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { projectionBacklog } from '../src/core/page-state/projections.ts';
import {
  PersistenceIpcTransportError, persistenceSocketPathForConfig, requestPersistenceProjectionStatus, startPersistenceIpcServer, type PersistenceIpcProvider,
} from '../src/core/persistence/ipc.ts';
import { projectionResidentEntry } from '../src/commands/doctor/checks/projection-readiness.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-projection-resident-'));
const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect(config); await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('resident-example','resident-example')");
  for (const slug of ['notes/a', 'notes/b', 'notes/c']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Example ${slug}.` }, { sourceId: 'resident-example' });
  }
  await engine.executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE source_id='resident-example'");
  await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,'test_backlog' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id='resident-example'
    ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision`);
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

const provider = (status?: PersistenceIpcProvider['projectionStatus']): PersistenceIpcProvider => ({
  brainId: randomUUID(), dispatch: async () => { throw new Error('not used'); }, ...(status ? { projectionStatus: status } : {}),
});
const doctorContext = (overrides: Partial<DoctorContext> = {}) => ({ engine: null, fastMode: false, ...overrides }) as DoctorContext;
const runEntry = (ctx: DoctorContext) => withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
  async () => await projectionResidentEntry.run(ctx) as Check[]);

test('the resident answers projection_status with counts only; an owner without it refuses', async () => {
  const socket = persistenceSocketPathForConfig(config)!;
  const server = (await startPersistenceIpcServer(socket, provider(() => projectionBacklog(engine))))!;
  try {
    const status = await requestPersistenceProjectionStatus(socket);
    expect(status).toMatchObject({ pending: 3, failed: 0 });
    expect(Object.keys(status).sort()).toEqual(['failed', 'oldest_age_seconds', 'pending']);
    expect(status.oldest_age_seconds).toBeGreaterThanOrEqual(0);
  } finally { server.close(); }
  const old = (await startPersistenceIpcServer(socket, provider()))!;
  try {
    await expect(requestPersistenceProjectionStatus(socket)).rejects.toMatchObject({ code: 'unavailable' });
  } finally { old.close(); }
});

test('stalled projection_status requests count toward the listener bound and cannot pile up', async () => {
  const socket = persistenceSocketPathForConfig(config)!;
  const stalled = Promise.withResolvers<void>();
  let calls = 0;
  const server = (await startPersistenceIpcServer(socket, provider(async () => { calls++; await stalled.promise; return { pending: 0, failed: 0, oldest_age_seconds: null }; })))!;
  try {
    const abandoned = await Promise.allSettled(Array.from({ length: 8 }, () => requestPersistenceProjectionStatus(socket, 200)));
    expect(abandoned.every(result => result.status === 'rejected')).toBe(true);
    expect(calls).toBe(8);
    // The abandoned clients are gone, but until the listener observes their
    // sockets closing it refuses new connections at the transport level; once
    // it does, the eight stalled handlers still hold the bound.
    let refusal: unknown;
    for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
      refusal = await requestPersistenceProjectionStatus(socket).then(() => null, (error: unknown) => error);
      if (!(refusal instanceof PersistenceIpcTransportError)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(refusal).toMatchObject({ code: 'queue_capacity' });
    expect(calls).toBe(8);
    stalled.resolve();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await requestPersistenceProjectionStatus(socket)).toEqual({ pending: 0, failed: 0, oldest_age_seconds: null });
  } finally { stalled.resolve(); server.close(); }
});

test('doctor reports the resident backlog, its pid and the stop-drain-restart path while the resident holds the brain', async () => {
  const socket = persistenceSocketPathForConfig(config)!;
  const server = (await startPersistenceIpcServer(socket, provider(() => projectionBacklog(engine))))!;
  let draining: Check[];
  try { draining = await runEntry(doctorContext()); } finally { server.close(); }
  expect(draining).toHaveLength(1);
  expect(draining[0]).toMatchObject({ name: 'text_projection_readiness', status: 'warn',
    details: { readiness: 'projection_pending', ready: false, pending: 3, failed: 0, owner_pid: process.pid } });
  expect(draining[0].message).toContain(`(pid ${process.pid}) holds this PGLite brain and is draining 3 queued text projections`);
  expect(draining[0].message).toContain('systemctl --user stop gbrain-serve.service && { gbrain projections drain; systemctl --user start gbrain-serve.service; }');
  expect(draining[0].message).toContain(`kill ${process.pid}`);

  const silent = await runEntry(doctorContext());
  expect(silent[0]).toMatchObject({ name: 'text_projection_readiness', status: 'warn', details: { readiness: 'unknown' } });
  expect(silent[0].message).toContain('may predate the faster projection drain');

  expect(await runEntry(doctorContext({ engine: engine as never }))).toEqual([]);
  expect(await runEntry(doctorContext({ fastMode: true }))).toEqual([]);
}, 60_000);
