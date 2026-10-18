/**
 * #6865: files an older gbrain refused before refusals became holds are on disk, committed and unchanged, with no page and
 * no hold, so incremental discovery never visits them. The detector finds them (in source-path space, both slug modes),
 * `sources retry-held --unindexed` schedules them, the next plain sync imports or holds each one, and doctor
 * `unindexed_files` walks argv -> then -> verify to ok. A bounded scan that stops early is never reported clean.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Action } from '../src/core/agent-output.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { discoverManagedSync, loadSyncEligibility, resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { readGitHoldRetryPaths, readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { findUnindexedFiles, readUnindexedFiles, refreshUnindexedFiles } from '../src/core/persistence/unindexed-files.ts';
import { gitFollowUpSync, retryUnindexed, runRetryHeld } from '../src/commands/sources-retry-held.ts';
import { unindexedFilesEntry } from '../src/commands/doctor/checks/unindexed-files.ts';
import { runUnindexedFilesPhase } from '../src/core/cycle/unindexed-files.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-unindexed-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); return git(root, 'rev-parse', 'HEAD'); };
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation.\n`;
const STRAY_SLUG = '---\ntitle: Fund A\nslug: fund-a\n---\nA synthetic fund page.\n';

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

async function source(engine: BrainEngine, files: Record<string, string>, opts: { subdir?: string; mode?: 'git-root' | 'source-root' } = {}) {
  const id = `unidx-${randomUUID().replace(/-/g, '').slice(0, 20)}`, repo = join(home, id), root = opts.subdir ? join(repo, opts.subdir) : repo;
  const write = (path: string, content: string) => { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), content); };
  mkdirSync(root, { recursive: true }); git(repo, 'init', '-q');
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(repo);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, JSON.stringify(opts.mode ? { slug_root_mode: opts.mode } : {})]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = (extra: Partial<SyncOpts> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, ...extra });
  /** An older gbrain refused these files without recording a hold: committed, and the source's cursor moved past them. */
  const legacy = async (added: Record<string, string>) => {
    for (const [path, content] of Object.entries(added)) write(path, content);
    await unmanaged(engine, () => engine.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [id, commit(repo)]));
  };
  const doctor = async (): Promise<Check> => (await unindexedFilesEntry.run({ engine, sourceIds: [id] } as unknown as DoctorContext) as Check[])[0]!;
  const holds = async () => (await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? [];
  return { id, repo, root, sync, legacy, doctor, holds };
}

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); } finally { await disposePersistenceConsumer(engine); }
    }
  });
}

/** Runs a fix's sync step the way an agent would: the argv must be the plain follow-up sync of the source. */
async function runSyncStep(engine: BrainEngine, sourceId: string, step: Action, sync: () => Promise<unknown>) {
  expect(step.argv).toEqual(await gitFollowUpSync(engine, sourceId, []));
  expect(step.argv).toEqual(['gbrain', 'sync', '--source', sourceId, '--no-pull']);
  await sync();
}

test('a legacy refused file is found, scheduled by retry-held --unindexed, then imported or held by a plain sync; doctor argv -> then -> verify ends ok', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A') });
  await s.sync();
  await s.legacy({ 'notes/clean.md': note('Clean'), 'investors/fund-a.md': STRAY_SLUG });
  expect(await engine.getPage('notes/clean', { sourceId: s.id })).toBeNull();
  expect(await s.holds()).toEqual([]);

  const scan = await findUnindexedFiles(engine, s.id);
  expect(scan).toMatchObject({ complete: true, cursor: null, scanned: 3, unindexed: 2, slug_taken: 0, scheduled: 0, target: git(s.repo, 'rev-parse', 'HEAD'),
    by_code: { clean: 1, frontmatter_slug_conflict: 1 } });
  expect(scan.files.map(file => [file.path, file.code]).sort()).toEqual([['investors/fund-a.md', 'frontmatter_slug_conflict'], ['notes/clean.md', 'clean']]);

  const dry = await retryUnindexed(engine, s.id, { dryRun: true });
  expect(dry).toMatchObject({ kind: 'git', dry_run: true, scheduled: 0, fix: { argv: ['gbrain', 'sources', 'retry-held', s.id, '--unindexed'] } });
  expect(dry.items.map(item => [item.key, item.reason, item.action]).sort()).toEqual([['investors/fund-a.md', 'unindexed', 'would_retry'], ['notes/clean.md', 'unindexed', 'would_retry']]);
  expect(await readGitHoldRetryPaths(engine, s.id, (await incarnationOf(engine, s.id)))).toEqual([]);
  expect((await readUnindexedFiles(engine, [s.id])).size).toBe(0);

  const before = await s.doctor();
  expect(before).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'unknown' });
  const fix = before.fix as Action;
  expect(fix.argv).toEqual(['gbrain', 'sources', 'retry-held', s.id, '--unindexed']);
  expect(fix.verify).toEqual({ argv: ['gbrain', 'doctor', '--only', 'unindexed_files', '--json'] });
  expect(fix.then!.verify).toEqual({ argv: ['gbrain', 'doctor', '--only', 'unindexed_files', '--json'] });

  const receipt = await retryUnindexed(engine, s.id);
  expect(receipt).toMatchObject({ scheduled: 2, unindexed: { complete: true, unindexed: 2 } });
  expect(receipt.fix!.argv).toEqual(fix.then!.argv);
  expect(receipt.items.map(item => [item.key, item.code, item.reason])).toEqual(expect.arrayContaining([['notes/clean.md', 'clean', 'unindexed'],
    ['investors/fund-a.md', 'frontmatter_slug_conflict', 'unindexed']]));
  const waiting = await s.doctor();
  expect(waiting).toMatchObject({ status: 'warn', details: { sources: [{ source_id: s.id, state: 'scheduled', waiting: 2, unscheduled: 0 }] } });
  expect((waiting.fix as Action).argv).toEqual(fix.then!.argv);

  await runSyncStep(engine, s.id, fix.then!, () => s.sync());
  expect((await engine.getPage('notes/clean', { sourceId: s.id }))?.title).toBe('Clean');
  expect((await s.holds()).map(hold => [hold.path, hold.code])).toEqual([['investors/fund-a.md', 'frontmatter_slug_conflict']]);

  const verified = await s.doctor();
  expect(verified).toMatchObject({ status: 'ok', details: { sources: [{ source_id: s.id, state: 'ok', still_unindexed: 0, waiting: 0 }] } });
  expect(verified.severity).toBeUndefined();
  expect((await findUnindexedFiles(engine, s.id))).toMatchObject({ complete: true, unindexed: 0, scheduled: 0 });
  const empty = await retryUnindexed(engine, s.id);
  expect(empty).toMatchObject({ scheduled: 0, items: [], next_action: `No unindexed files for ${s.id}.` });
}), 240_000);

async function incarnationOf(engine: BrainEngine, id: string): Promise<string> {
  return (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]))[0]!.incarnation;
}

test('files a pass could not schedule warn with retry-held --unindexed; argv -> then -> verify ends ok', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A') });
  await s.sync();
  await s.legacy({ 'notes/b.md': note('B'), 'notes/c.md': note('C') });
  const first = await refreshUnindexedFiles(engine, s.id, { keep: 1 });
  expect(first.scheduled).toEqual(['notes/b.md']);
  const check = await s.doctor();
  expect(check).toMatchObject({ status: 'warn', details: { sources: [{ state: 'unindexed', unscheduled: 1, waiting: 1 }] } });
  expect(check.message).toContain('notes/b.md [clean]');
  const fix = check.fix as Action;
  expect(fix.argv).toEqual(['gbrain', 'sources', 'retry-held', s.id, '--unindexed']);
  const receipt = await retryUnindexed(engine, s.id);
  expect(receipt.items.map(item => item.key)).toEqual(['notes/c.md']);
  expect(receipt.unindexed).toMatchObject({ already_scheduled: 1, unindexed: 1 });
  await runSyncStep(engine, s.id, fix.then!, () => s.sync());
  expect((await engine.getPage('notes/c', { sourceId: s.id }))?.title).toBe('C');
  expect(await s.doctor()).toMatchObject({ status: 'ok', details: { sources: [{ state: 'ok' }] } });
}), 240_000);

test('a file whose path slug belongs to a database-only page is not indexed: it is reported as slug_taken', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A') });
  await s.sync();
  await s.legacy({ 'notes/db-only.md': note('Db only') });
  await unmanaged(engine, () => engine.putPage('notes/db-only', { type: 'note', title: 'Db only', compiled_truth: 'Written database-only.' }, { sourceId: s.id }));
  const [page] = await engine.executeRaw<{ source_path: string | null }>('SELECT source_path FROM pages WHERE source_id=$1 AND slug=$2', [s.id, 'notes/db-only']);
  expect(page!.source_path).toBeNull();
  const scan = await findUnindexedFiles(engine, s.id);
  expect(scan).toMatchObject({ unindexed: 1, slug_taken: 1, samples: [{ path: 'notes/db-only.md', code: 'clean', slug_taken: true }] });
}), 240_000);

test('a titled file named like folder scaffolding is reported as metafile_skipped, never scheduled, and only an info finding with a user fix', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A') });
  await s.sync();
  await s.legacy({ 'investors/fund-a/index.md': '---\ntitle: Fund A\ntype: company\n---\nA synthetic fund overview.\n', 'notes/README.md': 'Plain scaffolding, no frontmatter.\n' });
  const scan = await findUnindexedFiles(engine, s.id);
  expect(scan).toMatchObject({ complete: true, scanned: 1, unindexed: 0, metafile_skipped: 1, metafile_samples: ['investors/fund-a/index.md'] });
  const receipt = await retryUnindexed(engine, s.id);
  expect(receipt).toMatchObject({ scheduled: 0, items: [], unindexed: { metafile_skipped: 1 }, next_action: `No unindexed files for ${s.id}.` });
  expect(await readGitHoldRetryPaths(engine, s.id, await incarnationOf(engine, s.id))).toEqual([]);
  const check = await s.doctor();
  expect(check).toMatchObject({ status: 'ok', severity: 'info', details: { sources: [{ state: 'ok', metafile_skipped: 1, metafile_samples: ['investors/fund-a/index.md'] }] } });
  const fix = check.fix as Action;
  expect(fix).toMatchObject({ actor: 'user', argv: ['gbrain', 'sync', '--source', s.id, '--no-pull'] });
  expect(fix.user_message).toContain('investors/fund-a/index.md -> investors/fund-a.md');
  expect(fix.user_message).toContain('on purpose');
}), 240_000);

test('a bounded scan that stops early is incomplete and never clean; later passes resume and cover the late paths', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/b.md': note('B'), 'notes/c.md': note('C') });
  await s.sync();
  await s.legacy({ 'notes/z.md': note('Z') });
  const head = await findUnindexedFiles(engine, s.id, { batch: 1, maxScanned: 1 });
  expect(head).toMatchObject({ complete: false, cursor: 'notes/a.md', scanned: 1, unindexed: 0 });
  const first = await refreshUnindexedFiles(engine, s.id, { batch: 1, maxScanned: 1 });
  expect(first.record).toMatchObject({ complete: false, cursor: 'notes/a.md', unindexed: 0 });
  const partial = await s.doctor();
  expect(partial).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'unknown', details: { sources: [{ state: 'partial' }] } });
  expect(partial.message).toContain('incomplete');
  let passes = 1, record = first.record;
  while (!record.complete && passes < 10) { record = (await refreshUnindexedFiles(engine, s.id, { batch: 1, maxScanned: 1 })).record; passes++; }
  expect(passes).toBe(5);
  expect(record).toMatchObject({ complete: true, cursor: null, scanned: 4, unindexed: 1, scheduled_now: 1, pending: ['notes/z.md'] });
  expect((await s.doctor()).details).toMatchObject({ sources: [{ state: 'scheduled', waiting: 1 }] });
}), 240_000);

test('slug collisions and deleted pages are reported for a person, never scheduled; syncs keep working and doctor does not warn', () => each(async engine => {
  const s = await source(engine, { 'notes/a-b.md': note('AB'), 'notes/Case.md': note('Case'), 'notes/gone.md': note('Gone') });
  await s.sync();
  await unmanaged(engine, () => engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug='notes/gone'", [s.id]));
  await s.legacy({ 'notes/a b.md': note('A space B'), 'notes/case.md': note('Lower case') });
  const scan = await findUnindexedFiles(engine, s.id);
  expect(scan).toMatchObject({ complete: true, unindexed: 3, slug_taken: 2, deleted_page: 1 });
  const phase = await runUnindexedFilesPhase(engine, { dryRun: false });
  expect(phase.details).toMatchObject({ scheduled_now: 0 });
  expect(await readGitHoldRetryPaths(engine, s.id, await incarnationOf(engine, s.id))).toEqual([]);
  expect((await retryUnindexed(engine, s.id)).scheduled).toBe(0);
  writeFileSync(join(s.repo, 'notes/new.md'), note('New'));
  commit(s.repo);
  await s.sync();
  expect(await engine.getPage('notes/new', { sourceId: s.id })).not.toBeNull();
  const [gone] = await engine.executeRaw<{ deleted_at: string | null }>("SELECT deleted_at FROM pages WHERE source_id=$1 AND slug='notes/gone'", [s.id]);
  expect(gone!.deleted_at).not.toBeNull();
  const check = await s.doctor();
  expect(check).toMatchObject({ status: 'ok', severity: 'info', details: { sources: [{ state: 'ok', slug_taken: 2, deleted_page: 1 }] } });
  expect((check.fix as Action).actor).toBe('user');
  expect(check.message).toContain('3 committed file(s) cannot be imported as they are');
}), 240_000);

test('a stored incomplete scan whose target commit moved starts over instead of continuing its cursor', () => each(async engine => {
  const s = await source(engine, { 'notes/m.md': note('M'), 'notes/z.md': note('Z') });
  await s.sync();
  const first = await refreshUnindexedFiles(engine, s.id, { batch: 1, maxScanned: 1 });
  expect(first.record).toMatchObject({ complete: false, cursor: 'notes/m.md' });
  await s.legacy({ 'notes/a.md': note('A') });
  const second = await refreshUnindexedFiles(engine, s.id);
  expect(second.record).toMatchObject({ complete: true, scanned: 3, unindexed: 1, target: git(s.repo, 'rev-parse', 'HEAD') });
  expect(second.record.pending).toEqual(['notes/a.md']);
}), 240_000);

test('a pass past its deadline reads no more blobs: found files count as unscreened and the scan is incomplete', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A') });
  await s.sync();
  await s.legacy({ 'notes/b.md': note('B') });
  const scan = await findUnindexedFiles(engine, s.id, { deadlineAt: 0 });
  expect(scan).toMatchObject({ complete: false, unindexed: 1, by_code: { unscreened: 1 } });
}), 240_000);

for (const mode of ['git-root', 'source-root'] as const) {
  test(`a subdirectory source in ${mode} mode: discovery and the detector share one eligibility, compared in source-path space`, () => each(async engine => {
    const s = await source(engine, { 'brain/notes/a.md': note('A'), 'brain/notes/b.md': note('B'), 'brain/.hidden/h.md': note('H'), 'other/x.md': note('X') },
      { subdir: 'brain', mode });
    const opts = { sourceId: s.id, noPull: true, dryRun: true } as SyncOpts;
    const context = await resolveManagedSyncContext(engine, opts);
    const eligibility = await loadSyncEligibility(engine, context, opts);
    expect(eligibility).toMatchObject({ scope: 'brain', slugMode: mode });
    const listed = git(s.repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(eligibility.eligible).map(eligibility.sourcePath).sort();
    const discovered = (await discoverManagedSync(engine, opts)).entries.filter(entry => entry.action === 'import').map(entry => entry.sourcePath).sort();
    expect(discovered).toEqual(listed);
    expect(listed).toEqual(mode === 'git-root' ? ['brain/notes/a.md', 'brain/notes/b.md'] : ['notes/a.md', 'notes/b.md']);
    await s.sync();
    await s.legacy({ 'brain/notes/c.md': note('C'), 'other/y.md': note('Y') });
    const scan = await findUnindexedFiles(engine, s.id);
    expect(scan).toMatchObject({ complete: true, scanned: 3, unindexed: 1 });
    expect(scan.files).toEqual([{ path: 'notes/c.md', source_path: mode === 'git-root' ? 'brain/notes/c.md' : 'notes/c.md', code: 'clean', slug_taken: false, deleted_page: false }]);
  }), 240_000);
}

test('the maintenance phase stores the result and schedules the paths; a dry run reports without writing', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A') });
  await s.sync();
  await s.legacy({ 'notes/b.md': note('B') });
  const dry = await runUnindexedFilesPhase(engine, { dryRun: true });
  expect(dry.details).toMatchObject({ mode: 'dry_run', scheduled_now: 0 });
  expect((dry.details.sources as Array<{ source_id: string; unindexed: number }>).find(entry => entry.source_id === s.id)).toMatchObject({ unindexed: 1 });
  expect((await readUnindexedFiles(engine, [s.id])).size).toBe(0);
  const live = await runUnindexedFilesPhase(engine, { dryRun: false });
  expect(live.status).toBe('ok');
  expect(live.summary).not.toContain('notes/b.md');
  expect((live.details.sources as Array<{ source_id: string; scheduled_now: number }>).find(entry => entry.source_id === s.id)).toMatchObject({ scheduled_now: 1 });
  expect((await readUnindexedFiles(engine, [s.id])).get(s.id)).toMatchObject({ complete: true, unindexed: 1, pending: ['notes/b.md'] });
  await s.sync();
  expect((await engine.getPage('notes/b', { sourceId: s.id }))?.title).toBe('B');
}), 240_000);

test('retry-held --unindexed refuses a connector source with invalid_params', () => each(async engine => {
  const id = `unidx-conn-${randomUUID().slice(0, 8)}`;
  await unmanaged(engine, () => engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES($1,$1,'{"kind":"github"}'::jsonb)`, [id]));
  await expect(retryUnindexed(engine, id)).rejects.toMatchObject({ code: 'invalid_params' });
  await unmanaged(engine, () => engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]));
  await expect(runRetryHeld(engine, [id, '--unindexed', '--all'])).rejects.toMatchObject({ code: 'invalid_params', message: 'Unknown option: --all.' });
}), 60_000);
