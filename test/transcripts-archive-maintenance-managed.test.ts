/**
 * GST-2768 PR 3: the maintenance pass archives a writer-claimed (managed) brain through the write coordinator, the way
 * put_page does: each day page is a put_page write request (submitPageMutation) under the trusted-local identity the
 * CLI's `gbrain transcripts archive run` uses (principal local_cli). This process is the writer owner (PGLite: its own
 * full consumer publishes), so the wait is the owner's own path; a pass called inside a coordinated write (the owner
 * publishing) submits nothing. The coordinator wait counts against the pass's time budget, and a write the coordinator
 * accepted but has not published yet counts as accepted and is not written again. Synthetic sessions only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer, startPersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { readLocalWriter, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { makeContext } from '../src/cli/main.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { ARCHIVE_MAINTENANCE_FLOOR_KEY, readArchiveMaintenance, runArchiveMaintenance } from '../src/core/transcripts/archive-maintenance.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

const NOW = new Date('2026-11-10T09:00:00Z');
let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

beforeEach(async () => {
  await stopPersistenceConsumer(engine);
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gb-managed-archive-maint-'));
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await engine.setConfig(ARCHIVE_MAINTENANCE_FLOOR_KEY, '0');
  await setArchiveEnabled(engine, true);
  await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
  await withEnv({ GBRAIN_HOME: dir }, () => registerLocalWriter(engine, 'cli'));
  return () => rmSync(dir, { recursive: true, force: true });
});

const sessions = (n: number) => [staticReader('codex', Array.from({ length: n }, (_, i) =>
  conversation('codex', 'rollout-managed-maint-' + i, [['user', '2026-11-10T08:0' + i + ':00.000Z', 'managed question ' + i]])))];

const pass = (n: number, extra: { budgetMs?: number } = {}) => withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_WRITE_WAIT_MS: undefined },
  () => runArchiveMaintenance(engine, { runner: 'test', now: NOW, readers: sessions(n), ...extra }));

const requests = () => engine.executeRaw<{ slug: string; state: string; principal_kind: string; principal_id: string }>(
  "SELECT slug, state, principal_kind, principal_id FROM persistence_requests WHERE operation = 'put_page' ORDER BY slug");

/** The coordinator stops publishing: this process's consumer ticks do nothing until restored. */
function stallCoordinator(): () => void {
  const consumer = startPersistenceConsumer(engine, { engine: 'pglite' }) as unknown as { doTick(): Promise<void> };
  consumer.doTick = async () => {};
  return () => { delete (consumer as { doTick?: unknown }).doTick; (consumer as unknown as { wake(now: boolean): void }).wake(true); };
}

describe('the maintenance pass on a writer-claimed brain', () => {
  test('writes day pages as put_page write requests under the CLI\'s local identity (local_cli), published by this process\'s own consumer', async () => {
    const outcome = await pass(1);
    expect(outcome.status).toBe('ran');
    expect(outcome.record).toMatchObject({ status: 'ok', written: 1, errors: [] });
    const pages = await archivedPages(engine);
    expect(pages.some(p => p.slug.startsWith('conversations/codex/2026-11-10/'))).toBe(true);
    const cli = await withEnv({ GBRAIN_HOME: dir }, () => readLocalWriter(engine, 'cli'));
    const rows = await requests();
    expect(rows.length).toBe(pages.length);
    for (const row of rows) expect(row).toMatchObject({ state: 'committed', principal_kind: 'local_cli', principal_id: cli.id });
  }, 120_000);

  test('a pass called inside a coordinated write (the owner publishing) submits nothing and records archive_inside_publication', async () => {
    const cli = await withEnv({ GBRAIN_HOME: dir }, () => readLocalWriter(engine, 'cli'));
    const outcome = await withCoordinatedWrite(engine, ['conversations'], () => pass(1), { requestId: null, principal: { kind: 'local_cli', id: cli.id } });
    expect(outcome).toMatchObject({ status: 'skipped', code: 'archive_inside_publication' });
    expect(await requests()).toEqual([]);
    expect((await readArchiveMaintenance(engine))?.code).toBe('archive_inside_publication');
  }, 60_000);

  test('a slow coordinator stops the pass at its time budget: the coordinator wait counts against ARCHIVE_MAINTENANCE_BUDGET_MS', async () => {
    const restore = stallCoordinator();
    try {
      const started = performance.now();
      const outcome = await pass(6, { budgetMs: 1_500 });
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(outcome.record?.stopped_at_deadline).toBe(true);
      expect(outcome.record?.status).not.toBe('failed');
      expect((await requests()).length).toBeLessThan(6);
    } finally { restore(); }
  }, 240_000);

  test('a write the coordinator accepted but has not published counts as accepted, not failed, and the next pass does not write that day again', async () => {
    const restore = stallCoordinator();
    let first;
    try { first = await pass(1, { budgetMs: 1_500 }); } finally { restore(); }
    expect(first.record).toMatchObject({ status: 'ok', errors: [] });
    expect(first.record?.accepted).toBeGreaterThanOrEqual(1);
    const submitted = (await requests()).length;
    expect(submitted).toBeGreaterThanOrEqual(1);
    await waitFor(async () => (await requests()).every(r => r.state === 'committed'), { timeoutMs: 30_000, label: 'the accepted writes publish' });

    const second = await pass(1);
    expect(second.record).toMatchObject({ status: 'ok', written: 0, errors: [] });
    expect((await requests()).length).toBe(submitted);
  }, 240_000);
});

describe('accepted writes on a writer-claimed brain (review fixes)', () => {
  const backfill = (deadline?: number) => withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_WRITE_WAIT_MS: undefined },
    () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-01', now: new Date('2026-10-10T00:00:00Z'),
      readers: [staticReader('codex', [conversation('codex', 'accepted-then-cancelled', [['user', '2026-10-01T10:00:00.000Z', 'canary-accepted-0021 note']])])],
      makeContext: source => makeContext(engine, { source, dry_run: false }), ...(deadline ? { deadlineAtMs: deadline } : {}) }));

  test('an accepted write that the coordinator later cancels is written again by the next backfill run', async () => {
    const restore = stallCoordinator();
    let first;
    try { first = await backfill(Date.now() + 1_500); } finally { restore(); }
    expect(first.accepted).toBeGreaterThanOrEqual(1);
    const cli = await withEnv({ GBRAIN_HOME: dir }, () => readLocalWriter(engine, 'cli'));
    const queued = await engine.executeRaw<{ request_id: string }>("SELECT request_id FROM persistence_requests WHERE state NOT IN ('committed','failed','cancelled')");
    const stall = stallCoordinator();
    try { for (const q of queued) await cancelWriteRequest(engine, { kind: 'local_cli', id: cli.id }, q.request_id); } finally { stall(); }
    expect((await archivedPages(engine)).some(p => p.body.includes('canary-accepted-0021'))).toBe(false);
    const second = await backfill();
    expect(second.errors).toEqual([]);
    expect((await archivedPages(engine)).some(p => p.body.includes('canary-accepted-0021'))).toBe(true);
  }, 240_000);

  test('a day still queued when the brain becomes shared gets an owner-only rule', async () => {
    await engine.setConfig('brain.audience', 'personal');
    const restore = stallCoordinator();
    try { expect((await backfill(Date.now() + 1_500)).accepted).toBeGreaterThanOrEqual(1); } finally { restore(); }
    const stall = stallCoordinator();
    try {
      await engine.setConfig('brain.audience', 'shared');
      for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
      await setOwner(engine, 'alice-example');
      await withEnv({ GBRAIN_HOME: dir }, () => runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('codex', [])], now: new Date('2026-11-05T00:00:00Z'), deadlineAtMs: Date.now() + 1_500,
        makeContext: source => makeContext(engine, { source, dry_run: false }) }));
    } finally { stall(); }
    const rules = await engine.executeRaw<{ prefix: string }>("SELECT prefix FROM access_rules WHERE source_id = 'conversations'");
    expect(rules.map(r => r.prefix)).toContain('conversations/codex/2026-10-01/');
  }, 240_000);
});
