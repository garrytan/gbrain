/**
 * #7149: on a large, busy managed Git source the #6865 unindexed-file scan never finished and the files it scheduled
 * never left the "waiting" state, so committed files stayed out of search with nothing reporting them.
 *
 * - A stored incomplete scan used to start over whenever the source's commit moved, which on a busy source is every
 *   maintenance run; it now continues its cursor and first re-examines the paths before the cursor that changed.
 * - The maintenance phase scanned sources in id order under one shared deadline, so the first large source used it up
 *   on every run; sources now run least recently scanned first, each within a budget sized to its pages.
 * - A sync pass consumed the re-screen requests only when it stamped, so one that stopped first (timeout,
 *   writer_pending, not_converged) imported the files and left them reported as waiting; it now consumes each request
 *   once it settles the path, and doctor counts a scheduled path with a page or a hold as settled.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { readGitHoldRetryPaths, readGitSourceHolds, requestGitHoldRetry } from '../src/core/persistence/sync-holds.ts';
import { readUnindexedFiles, refreshUnindexedFiles, unindexedBudgetForPages } from '../src/core/persistence/unindexed-files.ts';
import { unindexedFilesEntry } from '../src/commands/doctor/checks/unindexed-files.ts';
import { runUnindexedFilesPhase } from '../src/core/cycle/unindexed-files.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-unindexed-7149-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); return git(root, 'rev-parse', 'HEAD'); };
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation.\n`;

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

/** Fixture writes the managed writer guard would refuse (the state an older gbrain left), made with persistence briefly off. */
async function unmanaged<T>(engine: BrainEngine, run: () => Promise<T>): Promise<T> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await run(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

async function source(engine: BrainEngine, prefix: string, files: Record<string, string>) {
  const id = `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`, root = join(home, id);
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(root);
  await unmanaged(engine, () => engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}'::jsonb)", [id, root]));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = (extra: Partial<SyncOpts> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, ...extra });
  /** Committed files an older gbrain refused without a hold: the source's commit moves past them and no sync imports them. */
  const legacy = async (added: Record<string, string>) => {
    for (const [path, content] of Object.entries(added)) write(path, content);
    const head = commit(root);
    await unmanaged(engine, () => engine.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [id, head]));
    return head;
  };
  const incarnation = async () => (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]))[0]!.incarnation;
  const doctor = async (): Promise<Check> => (await unindexedFilesEntry.run({ engine, sourceIds: [id] } as unknown as DoctorContext) as Check[])[0]!;
  return { id, root, sync, legacy, incarnation, doctor };
}

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); } finally { await disposePersistenceConsumer(engine); }
    }
  });
}

const files = (prefix: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}/f${String(i).padStart(2, '0')}.md`, note(`${prefix} ${i}`)]));

test('a bounded scan converges while commits keep landing: it keeps its cursor and re-examines the changed paths before it', () => each(async engine => {
  const s = await source(engine, 'unidx7149-busy', files('notes', 20));
  await s.sync();
  await s.legacy({ 'zz/late.md': note('Late') });
  const first = await refreshUnindexedFiles(engine, s.id, { batch: 4, maxScanned: 4 });
  expect(first.record).toMatchObject({ complete: false, cursor: 'notes/f03.md', scanned: 4 });
  let record = first.record, passes = 1;
  while (!record.complete && passes < 12) {
    // Every maintenance run sees a new commit: one file lands before the cursor, one after it.
    await s.legacy({ [`notes/a${passes}.md`]: note(`Early ${passes}`), [`zz/m${passes}.md`]: note(`Mid ${passes}`) });
    record = (await refreshUnindexedFiles(engine, s.id, { batch: 4, maxScanned: 4 })).record;
    passes++;
  }
  expect(record.complete).toBe(true);
  expect(passes).toBeLessThanOrEqual(10);
  expect(record.started_at).toBe(first.record.started_at);
  expect(record.target).toBe(git(s.root, 'rev-parse', 'HEAD'));
  const expected = ['zz/late.md', ...Array.from({ length: passes - 1 }, (_, i) => [`notes/a${i + 1}.md`, `zz/m${i + 1}.md`]).flat()].sort();
  expect([...record.pending].sort()).toEqual(expected);
  expect(record.unindexed).toBe(expected.length);
  expect([...await readGitHoldRetryPaths(engine, s.id, await s.incarnation())].sort()).toEqual(expected);
}), 240_000);

test('a file the scan found before its cursor and a later commit deleted leaves the continued result; doctor does not report it missing', () => each(async engine => {
  const s = await source(engine, 'unidx7149-gone', files('notes', 8));
  await s.sync();
  await s.legacy({ 'notes/a-legacy.md': note('Legacy') });
  const first = await refreshUnindexedFiles(engine, s.id, { batch: 2, maxScanned: 2 });
  expect(first.record).toMatchObject({ complete: false, cursor: 'notes/f00.md', pending: ['notes/a-legacy.md'] });
  rmSync(join(s.root, 'notes/a-legacy.md'));
  await s.legacy({});
  let record = first.record;
  for (let pass = 0; !record.complete && pass < 10; pass++) record = (await refreshUnindexedFiles(engine, s.id, { batch: 2, maxScanned: 2 })).record;
  expect(record).toMatchObject({ complete: true, pending: [] });
  await s.sync();
  expect((await s.doctor()).details).toMatchObject({ sources: [{ source_id: s.id, still_unindexed: 0, waiting: 0 }] });
}), 240_000);

test('the maintenance phase serves the least recently scanned source first, so a source a large one starved is scanned on the next run', () => each(async engine => {
  const a = await source(engine, 'unidx7149-a', files('notes', 3));
  const b = await source(engine, 'unidx7149-b', files('notes', 3));
  await a.sync(); await b.sync();
  await a.legacy({ 'notes/legacy-a.md': note('Legacy A') });
  await b.legacy({ 'notes/legacy-b.md': note('Legacy B') });
  // A clock that moves 20 s per reading under a 50 s phase budget: the first source scanned uses the phase up.
  let clock = 1_000_000_000_000;
  const now = () => (clock += 20_000);
  const run = async () => { const start = clock; return runUnindexedFilesPhase(engine, { dryRun: false, now, deadlineAtMs: start + 150_000 + 20_000 }); };
  const skipped = (phase: Awaited<ReturnType<typeof run>>) => (phase.details.skipped as Array<{ source_id: string; reason: string }>).map(entry => entry.source_id);
  const scannedIds = (phase: Awaited<ReturnType<typeof run>>) => (phase.details.sources as Array<{ source_id: string }>).map(entry => entry.source_id);
  const first = await run();
  expect(scannedIds(first)[0]).not.toBe(b.id);
  expect(skipped(first)).toContain(b.id);
  const second = await run();
  expect(scannedIds(second)[0]).toBe(b.id);
  expect((await readUnindexedFiles(engine, [b.id])).get(b.id)).toMatchObject({ unindexed: 1, pending: ['notes/legacy-b.md'] });
}), 240_000);

test('a committed symlink with no page is named symlink, not screened as page content; the next sync holds it, so it ends in a terminal state', () => each(async engine => {
  const s = await source(engine, 'unidx7149-link', files('notes', 2));
  await s.sync();
  // GST-2515: a link to a file outside the checkout (a link to nothing is skipped by sync; the next test).
  const elsewhere = mkdtempSync(join(tmpdir(), 'unidx7149-elsewhere-'));
  writeFileSync(join(elsewhere, 'target.md'), note('Elsewhere'));
  symlinkSync(join(elsewhere, 'target.md'), join(s.root, 'notes/link.md'));
  await s.legacy({});
  const found = await refreshUnindexedFiles(engine, s.id);
  expect(found.scan).toMatchObject({ complete: true, unindexed: 1, by_code: { symlink: 1 } });
  expect(found.scheduled).toEqual(['notes/link.md']);
  await s.sync();
  expect(((await readGitSourceHolds(engine, { sourceIds: [s.id] }))[0]?.holds ?? []).map(hold => hold.path)).toEqual(['notes/link.md']);
  expect((await s.doctor()).details).toMatchObject({ sources: [{ source_id: s.id, state: 'ok', still_unindexed: 0, waiting: 0 }] });
  rmSync(elsewhere, { recursive: true, force: true });
}), 240_000);

test('GST-2515: a committed symlink to nothing is skipped by sync and is not unindexed: no hold, no schedule, doctor ok', () => each(async engine => {
  const s = await source(engine, 'unidx7149-dangling', files('notes', 2));
  await s.sync();
  symlinkSync('/nonexistent/elsewhere/target.md', join(s.root, 'notes/link.md'));
  await s.legacy({});
  const found = await refreshUnindexedFiles(engine, s.id);
  expect(found.scan).toMatchObject({ complete: true, unindexed: 0 });
  expect(found.scheduled).toEqual([]);
  await s.sync();
  expect(((await readGitSourceHolds(engine, { sourceIds: [s.id] }))[0]?.holds ?? []).map(hold => hold.path)).toEqual([]);
  expect((await s.doctor()).details).toMatchObject({ sources: [{ source_id: s.id, state: 'ok', still_unindexed: 0, waiting: 0 }] });
}), 240_000);

test('a source gets one minute of scan budget per started 100k live pages, at most five', () => {
  expect([0, 1, 100_000, 100_001, 245_000, 311_000, 2_000_000].map(unindexedBudgetForPages)).toEqual([60_000, 60_000, 60_000, 120_000, 180_000, 240_000, 300_000]);
});

test('a sync pass that stops before its stamp still consumes the re-screens it settled; doctor reports the imported files ok, not waiting', () => each(async engine => {
  const s = await source(engine, 'unidx7149-stop', files('notes', 4));
  await s.sync();
  await s.legacy({ 'notes/legacy-1.md': note('Legacy 1'), 'notes/legacy-2.md': note('Legacy 2') });
  expect((await refreshUnindexedFiles(engine, s.id)).scheduled.sort()).toEqual(['notes/legacy-1.md', 'notes/legacy-2.md']);
  const abort = new AbortController();
  // The pass imports in its first round and is stopped as its second (confirming) round starts, before any stamp.
  installFaultHook(async (point, detail) => {
    if (point !== 'sync:round_start' || detail.sourceId !== s.id || (detail as { round?: number }).round !== 2) return;
    abort.abort();
    throw Object.assign(new Error('stopped before the stamp'), { name: 'AbortError' });
  });
  let result;
  try { result = await s.sync({ signal: abort.signal }); } finally { installFaultHook(undefined); }
  expect(result).toMatchObject({ status: 'partial', reason: 'timeout' });
  expect((await engine.getPage('notes/legacy-1', { sourceId: s.id }))?.title).toBe('Legacy 1');
  expect((await engine.getPage('notes/legacy-2', { sourceId: s.id }))?.title).toBe('Legacy 2');
  expect(await readGitHoldRetryPaths(engine, s.id, await s.incarnation())).toEqual([]);
  expect((await s.doctor()).details).toMatchObject({ sources: [{ source_id: s.id, state: 'ok', waiting: 0, still_unindexed: 0 }] });
}), 240_000);

test('doctor counts a scheduled path that has a page as settled even while the re-screen row still names it', () => each(async engine => {
  const s = await source(engine, 'unidx7149-row', files('notes', 2));
  await s.sync();
  await s.legacy({ 'notes/legacy.md': note('Legacy') });
  await refreshUnindexedFiles(engine, s.id);
  await s.sync();
  expect((await engine.getPage('notes/legacy', { sourceId: s.id }))?.title).toBe('Legacy');
  await requestGitHoldRetry(engine, s.id, await s.incarnation(), ['notes/legacy.md']);
  expect((await s.doctor()).details).toMatchObject({ sources: [{ source_id: s.id, state: 'ok', waiting: 0, still_unindexed: 0 }] });
}), 240_000);
