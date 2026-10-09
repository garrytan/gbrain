/**
 * #6278 (B1): a managed sync member whose owner gave up preparing it
 * (`preparation_stalled`) is held, never re-entered: an import by its bytes, a
 * delete as a delete hold, a rename with its endpoints; the checkpoint never
 * holds; `sync.holds=fail` keeps blocking. The hold lands behind the narrowed
 * gate: an unrelated maintenance write on the same source no longer blocks
 * it, a write on the same page still does, and a run killed before the cursor
 * consumed the failure holds the entry at the start of the next run. Every
 * surface routes the hold to writer status, then `sources retry-held` and the
 * same sync with its options, never to frontmatter repair. The forced probe
 * throws the terminal code from the consumer's `consumer:prepared` seam (the
 * single path) or the `publication:before_commit` seam inside the group transaction, so
 * the receipt is exactly what Lane A's consumer writes. Synthetic content only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { installFaultHook, type FaultPoint } from '../src/core/persistence/fault-points.ts';
import { readGitSourceHolds, holdRescreenDue, readGitHoldRetryPaths, GIT_HOLD_SUMMARY_OP } from '../src/core/persistence/sync-holds.ts';
import { drainManagedSync, readManagedSyncBacklog } from '../src/core/persistence/sync-drain.ts';
import { preparationStallMeta } from '../src/core/persistence/sync-screen.ts';
import { readHeldCoverage, coverageRoute } from '../src/core/persistence/held-reads.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { gitHeldFilesCheck } from '../src/commands/doctor/checks/git-holds.ts';
import { printSyncResult, type SyncOpts, type SyncResult } from '../src/commands/sync.ts';
import { VERSION } from '../src/version.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-stalled-holds-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'content') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation about ${title}.\n`;

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  installFaultHook(undefined);
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

/** The forced probe: the owner finishes the request for one of `paths` `failed` with `preparation_stalled` at `point`. */
function stallPaths(engine: BrainEngine, sourceId: string, paths: Set<string>, point: FaultPoint = 'consumer:prepared'): { fired: string[] } {
  const fired: string[] = [];
  installFaultHook(async (at, detail) => {
    if (at !== point || detail.sourceId !== sourceId || !detail.requestId) return;
    const [row] = await engine.executeRaw<{ path: string | null }>("SELECT intent->>'path' AS path FROM persistence_requests WHERE request_id=$1::uuid", [detail.requestId]);
    if (!row?.path || !paths.has(row.path)) return;
    fired.push(row.path);
    throw new OperationError('preparation_stalled', `Preparation of ${row.path} did not finish within its attempts (forced probe).`, 'Inspect the writer with gbrain sources writer status.');
  });
  return { fired };
}

async function source(engine: BrainEngine, files: Record<string, string>) {
  const id = `stall-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, '{}']);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = (extra: Partial<SyncOpts> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, ...extra });
  const holds = async () => (await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? [];
  const lastCommit = async () => (await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0]!.last_commit;
  const failedRequests = () => engine.executeRaw<{ request_id: string; error_code: string; state: string; path: string | null }>(
    "SELECT request_id::text AS request_id,error_code,state,intent->>'path' AS path FROM persistence_requests WHERE source_id=$1 AND state IN ('failed','conflict','cancelled') ORDER BY sequence", [id]);
  const ledger = () => engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys::text LIKE $1", [`%${id}%`]);
  const summary = async () => (await engine.executeRaw<{ s: Record<string, number> }>('SELECT completed_keys->0 AS s FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2', [GIT_HOLD_SUMMARY_OP, `${id}:%`]))[0]?.s;
  const incarnation = async () => (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]))[0]!.incarnation;
  /** A maintenance write another process left unfinished on this source (a live claim nobody here sweeps), on `slug`; database-only, so it never sits in the worktree FIFO. */
  const unfinishedWrite = async (slug: string, pageId: number | null, path: string | null = null) => {
    const requestId = randomUUID();
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,page_id,slug,digest,authority,intent,intent_bytes,terminal_reservation,
        state,execution_token,claim_expires_at)
      SELECT 'local_cli','cli:example',$2::uuid,'submit_job',$1,incarnation,$3,$4,'d','{}'::jsonb,$5::text::jsonb,1,16384,'running',gen_random_uuid(),now()+interval '1 hour' FROM sources WHERE id=$1`,
    [id, requestId, pageId, slug, JSON.stringify({ kind: 'managed_maintenance_adopt_fact_fence', ...(path ? { path } : {}) })]);
    return { requestId, finish: () => engine.executeRaw("UPDATE persistence_requests SET state='committed',execution_token=NULL,claim_expires_at=NULL,completed_at=now() WHERE request_id=$1::uuid", [requestId]) };
  };
  return { id, root, write, sync, holds, lastCommit, failedRequests, ledger, summary, incarnation, unfinishedWrite };
}

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); }
      finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); await engine.unsetConfig('sync.holds'); }
    }
  });
}

const printed = (result: SyncResult) => { let out = ''; printSyncResult(result, { write: (text: string) => { out += text; return true; } } as NodeJS.WriteStream); return out; };
const expectRoutedToWriter = (fix: NonNullable<SyncResult['held']>[number]['fix'], id: string) => {
  expect(fix.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', id, '--json']);
  expect(fix.then?.argv).toEqual(['gbrain', 'sources', 'retry-held', id]);
  expect(fix.then?.then?.argv).toEqual(['gbrain', 'sync', '--source', id, '--no-pull', '--no-embed', '--no-extract']);
  expect(fix.docs).toBe('docs/guides/write-refusals.md#preparation_stalled');
  expect(JSON.stringify(fix)).not.toContain('repair frontmatter');
};

test('an import whose preparation stalls is held in the same run, the run finishes, and every surface routes it to writer status then retry-held and the same sync', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/stuck.md': note('Stuck'), 'notes/z.md': note('Z') });
  const probe = stallPaths(engine, s.id, new Set(['notes/stuck.md']));
  const head = git(s.root, 'rev-parse', 'HEAD');
  const result = await s.sync();
  expect(probe.fired).toEqual(['notes/stuck.md']);
  expect(result).toMatchObject({ status: 'first_sync', added: 2, held_count: 1, holds_outstanding: 1 });
  expect(await s.lastCommit()).toBe(head);
  expect(await engine.getPage('notes/stuck', { sourceId: s.id })).toBeNull();
  expect(await engine.getPage('notes/z', { sourceId: s.id })).not.toBeNull();
  const failed = await s.failedRequests();
  expect(failed).toEqual([expect.objectContaining({ error_code: 'preparation_stalled', state: 'failed', path: 'notes/stuck.md' })]);
  expect(result.converted_from_failed).toEqual([failed[0]!.request_id]);
  expect(await s.ledger()).toEqual([]);
  const [hold] = result.held!;
  expect(hold).toMatchObject({ path: 'notes/stuck.md', code: 'preparation_stalled', stale: false, docs: 'docs/guides/write-refusals.md#preparation_stalled' });
  expect(hold!.message).toContain(failed[0]!.request_id);
  expectRoutedToWriter(hold!.fix, s.id);
  expect(result.holds_fix!.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', s.id, '--json']);
  expect(result.holds_fix!.why).toContain('not file problems');
  for (const blob of [JSON.stringify(result), printed(result)]) expect(blob).not.toContain('repair frontmatter');
  // The stored record: the receipt, this gbrain's version, the resume arguments; the summary counts it under `stalled`.
  const [record] = await s.holds();
  expect(record).toMatchObject({ code: 'preparation_stalled', upstream_version: expect.any(String), meta: { stall: { request_id: failed[0]!.request_id, gbrain_version: VERSION,
    sync_argv: ['--source', s.id, '--no-pull', '--no-embed', '--no-extract'] } } });
  expect(record!.meta.deleted).toBeUndefined();
  expect(await s.summary()).toMatchObject({ count: 1, stalled: 1, fences: 0 });
  expect(coverageRoute((await readHeldCoverage(engine, { sourceId: s.id }))[0]!)).toEqual({ fences: 0, others: 0, stalled: 1 });
  // It waits: the next run neither re-screens the held bytes nor mints another receipt...
  expect(holdRescreenDue(record!, false)).toBe(false);
  expect(await s.sync()).toMatchObject({ status: 'up_to_date', holds_outstanding: 1 });
  expect(await s.failedRequests()).toHaveLength(1);
  // ...a different gbrain version would re-screen it...
  expect(holdRescreenDue({ code: 'preparation_stalled', meta: { ...record!.meta, stall: { ...record!.meta.stall!, gbrain_version: '0.0.1' } } }, false)).toBe(true);
  // ...doctor and retry-held route it the same way, and the retry's sync keeps the run's options.
  const check = await gitHeldFilesCheck(engine, [s.id]);
  expect(check.status).toBe('warn');
  expect(check.message).toContain('gbrain sources writer status --source ' + s.id);
  expect(check.message).not.toContain('repair frontmatter');
  const retry = await retryHeld(engine, s.id);
  expect(retry).toMatchObject({ scheduled: 1, items: [{ key: 'notes/stuck.md', code: 'preparation_stalled' }] });
  expect(retry.fix!.argv).toEqual(['gbrain', 'sync', '--source', s.id, '--no-pull', '--no-embed', '--no-extract']);
  expect(retry.next_action).not.toContain('repair frontmatter');
  // With the cause gone, the scheduled re-screen imports the file and clears the hold.
  installFaultHook(undefined);
  expect(await s.sync()).toMatchObject({ status: 'synced', added: 1 });
  expect(await engine.getPage('notes/stuck', { sourceId: s.id })).not.toBeNull();
  expect(await s.holds()).toEqual([]);
  expect(await s.summary()).toMatchObject({ count: 0, stalled: 0 });
}), 180_000);

test('a stalled delete becomes a delete hold (no bytes); the page stays until retry-held and the same sync delete it', () => each(async engine => {
  const s = await source(engine, { 'notes/keep.md': note('Keep'), 'notes/gone.md': note('Gone') });
  expect((await s.sync()).status).toBe('first_sync');
  unlinkSync(join(s.root, 'notes/gone.md')); s.write('notes/new.md', note('New'));
  const head = commit(s.root, 'delete one, add one');
  stallPaths(engine, s.id, new Set(['notes/gone.md']));
  const result = await s.sync();
  expect(result).toMatchObject({ status: 'synced', added: 1, deleted: 0, held_count: 1 });
  expect(await s.lastCommit()).toBe(head);
  expect(await engine.getPage('notes/gone', { sourceId: s.id })).not.toBeNull();
  const [record] = await s.holds();
  expect(record).toMatchObject({ path: 'notes/gone.md', code: 'preparation_stalled', upstream_version: null, page_id: expect.any(Number), meta: { deleted: true } });
  expect(result.held![0]!.fix.why).toContain('its deletion could not finish preparing');
  expectRoutedToWriter(result.held![0]!.fix, s.id);
  // The absent file is not "a change": the hold waits instead of re-admitting the delete every run.
  expect(await s.sync()).toMatchObject({ status: 'up_to_date', holds_outstanding: 1 });
  expect(await s.failedRequests()).toHaveLength(1);
  installFaultHook(undefined);
  await retryHeld(engine, s.id);
  expect(await s.sync()).toMatchObject({ status: 'synced', deleted: 1 });
  expect(await engine.getPage('notes/gone', { sourceId: s.id })).toBeNull();
  expect(await s.holds()).toEqual([]);
}), 180_000);

test('a stalled rename holds the destination with its origin; the hold gate locks both endpoints; a stalled checkpoint never holds', () => each(async engine => {
  const s = await source(engine, { 'notes/old.md': note('Old'), 'notes/other.md': note('Other') });
  expect((await s.sync()).status).toBe('first_sync');
  renameSync(join(s.root, 'notes/old.md'), join(s.root, 'notes/new.md'));
  commit(s.root, 'rename');
  stallPaths(engine, s.id, new Set(['notes/new.md']));
  const result = await s.sync();
  expect(result).toMatchObject({ status: 'synced', renamed: 0, held_count: 1 });
  const [record] = await s.holds();
  expect(record).toMatchObject({ path: 'notes/new.md', code: 'preparation_stalled', meta: { rename_from: { slug: 'notes/old' } } });
  expect(await engine.getPage('notes/old', { sourceId: s.id })).not.toBeNull();
  expect(await engine.getPage('notes/new', { sourceId: s.id })).toBeNull();
  // The checkpoint request is never held: a stall there blocks the run with the typed failure.
  installFaultHook(undefined);
  s.write('notes/more.md', note('More')); commit(s.root, 'more');
  installFaultHook(async (at, detail) => {
    if (at !== 'consumer:prepared' || detail.sourceId !== s.id || !detail.requestId) return;
    const [row] = await engine.executeRaw<{ kind: string }>("SELECT intent->>'kind' AS kind FROM persistence_requests WHERE request_id=$1::uuid", [detail.requestId]);
    if (row?.kind === 'managed_sync_checkpoint') throw new OperationError('preparation_stalled', 'The checkpoint did not finish preparing (forced probe).', 'Inspect the writer.');
  });
  const blocked = await s.sync();
  expect(blocked).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'preparation_stalled', count: 1 }] });
  expect(blocked.managedWrite).toMatchObject({ write_error: 'preparation_stalled' });
  expect(await s.holds()).toHaveLength(1);
}), 180_000);

test('sync.holds=fail keeps blocking with the typed receipt; the next run after holds are on converts it at its start (a kill before the cursor consumed the failure)', () => each(async engine => {
  await engine.setConfig('sync.holds', 'fail');
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/stuck.md': note('Stuck') });
  stallPaths(engine, s.id, new Set(['notes/stuck.md']));
  const blocked = await s.sync();
  expect(blocked).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'preparation_stalled', count: 1 }] });
  expect(blocked.managedWrite?.write_error).toBe('preparation_stalled');
  expect(await s.holds()).toEqual([]);
  expect(await s.ledger()).toHaveLength(1);
  const [failed] = await s.failedRequests();
  // The cursor is still pending on the failed receipt (as after a watchdog kill): the next run with holds on converts it before admitting anything.
  await engine.unsetConfig('sync.holds');
  installFaultHook(undefined);
  const converted = await s.sync();
  expect(converted).toMatchObject({ status: 'first_sync', held_count: 1, converted_from_failed: [failed!.request_id] });
  expect(converted.held![0]).toMatchObject({ path: 'notes/stuck.md', code: 'preparation_stalled' });
  expect(await engine.getPage('notes/a', { sourceId: s.id })).not.toBeNull();
  expect(await s.failedRequests()).toHaveLength(1);
}), 180_000);

test('narrowed gate: an unfinished maintenance write on another page of the same source no longer blocks the hold; one on the same page still does', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/stuck.md': note('Stuck'), 'notes/other.md': note('Other') });
  expect((await s.sync()).status).toBe('first_sync');
  const other = (await engine.readPageSnapshot('notes/other', { sourceId: s.id }))!.page.id;
  const stuck = (await engine.readPageSnapshot('notes/stuck', { sourceId: s.id }))!.page.id;
  s.write('notes/stuck.md', note('Stuck v2')); s.write('notes/a.md', note('A v2'));
  commit(s.root, 'edit two');
  // Before this change the source-wide gate returned writer_pending for as long as any request on the source was unfinished.
  const unrelated = await s.unfinishedWrite('notes/other', other);
  stallPaths(engine, s.id, new Set(['notes/stuck.md']));
  const started = performance.now();
  const result = await s.sync();
  expect(performance.now() - started).toBeLessThan(4000);
  expect(result).toMatchObject({ status: 'synced', modified: 1, held_count: 1 });
  expect(result.held![0]).toMatchObject({ path: 'notes/stuck.md', code: 'preparation_stalled', stale: true });
  await unrelated.finish();
  // Same page, by page id: the hold waits for it, and the run yields writer_pending within its wait budget.
  installFaultHook(undefined);
  await retryHeld(engine, s.id);
  s.write('notes/stuck.md', note('Stuck v3')); commit(s.root, 'edit again');
  const samePage = await s.unfinishedWrite('notes/stuck', stuck);
  stallPaths(engine, s.id, new Set(['notes/stuck.md']));
  const pending = await s.sync();
  expect(pending).toMatchObject({ status: 'partial', reason: 'writer_pending' });
  expect(await s.holds()).toHaveLength(1);
  expect((await s.holds())[0]!.meta.stall!.request_id).not.toBe((await s.failedRequests()).at(-1)!.request_id);
  // Once it settles, the next pass holds the entry from the same failed receipt without a new request.
  await samePage.finish();
  const before = (await s.failedRequests()).length;
  const held = await s.sync();
  expect(held).toMatchObject({ status: 'synced', held_count: 1 });
  expect((await s.failedRequests()).length).toBe(before);
  expect((await s.holds())[0]!.meta.stall!.request_id).toBe((await s.failedRequests()).at(-1)!.request_id);
  // The same-path match also works for a write that names the file rather than the slug.
  installFaultHook(undefined);
  await retryHeld(engine, s.id);
  s.write('notes/stuck.md', note('Stuck v4')); commit(s.root, 'edit once more');
  const byPath = await s.unfinishedWrite('elsewhere/slug', null, 'notes/stuck.md');
  stallPaths(engine, s.id, new Set(['notes/stuck.md']));
  expect(await s.sync()).toMatchObject({ status: 'partial', reason: 'writer_pending' });
  await byPath.finish();
  expect(await s.sync()).toMatchObject({ status: 'synced', held_count: 1 });
}), 240_000);

test('bulk groups: a stalled first, middle or last member is held, the committed prefix stays, the rest is re-frozen and the run finishes in one invocation', () => each(async engine => {
  if (engine.kind !== 'postgres') return;
  for (const position of ['first', 'middle', 'last'] as const) {
    const files: Record<string, string> = {};
    for (let i = 0; i < 7; i++) files[`notes/n${i}.md`] = note(`N${i}`);
    const s = await source(engine, files);
    const target = position === 'first' ? 'notes/n0.md' : position === 'middle' ? 'notes/n3.md' : 'notes/n6.md';
    stallPaths(engine, s.id, new Set([target]), 'publication:before_commit');
    const head = git(s.root, 'rev-parse', 'HEAD');
    const result = await s.sync({ bulk: { enabled: true, reason: null, size: 8, maxTxnMs: 15_000 } });
    expect(result).toMatchObject({ status: 'first_sync', added: 6, held_count: 1 });
    expect(result.held![0]).toMatchObject({ path: target, code: 'preparation_stalled' });
    expect(await s.lastCommit()).toBe(head);
    expect(await s.ledger()).toEqual([]);
    const [grouped] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'path'=$2 AND intent ? 'group'", [s.id, target]);
    expect(grouped!.n).toBeGreaterThan(0);
    // Every other member committed (cancelled followers were re-frozen under new requests) and the checkpoint found none incomplete.
    for (let i = 0; i < 7; i++) expect(await engine.getPage(`notes/n${i}`, { sourceId: s.id }) === null).toBe(`notes/n${i}.md` === target);
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine);
  }
}), 300_000);

// ── #6278 (B7): retry-held against a backlog ──

/** The committed import request for `path`, with the attempt counter the owner left on it. */
const committedAttempts = async (engine: BrainEngine, sourceId: string, path: string) => (await engine.executeRaw<{ n: number }>(
  "SELECT preparation_attempts::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'path'=$2 AND state='committed' ORDER BY sequence DESC LIMIT 1", [sourceId, path]))[0]?.n;

test('retry-held against an unfinished cursor: the printed sync finishes the backlog and re-screens the scheduled file in the same drain (Phase 4.1b)', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/stuck.md': note('Stuck'), 'notes/z1.md': note('Z1'), 'notes/z2.md': note('Z2'), 'notes/z3.md': note('Z3') });
  stallPaths(engine, s.id, new Set(['notes/stuck.md']));
  // A sliced pass holds the stalled entry and yields with entries left: the cursor is a backlog, as after the lock run's queue_capacity exit.
  const sliced = await performManagedSync(engine, { sourceId: s.id, noPull: true, noEmbed: true, noExtract: true }, { maxPages: 2, maxMs: 60_000 });
  expect(sliced).toMatchObject({ status: 'partial', reason: 'writer_yield', held_count: 1 });
  expect(sliced.managedCursor!.index).toBeLessThan(5);
  const [failed] = await s.failedRequests();
  expect(failed).toMatchObject({ error_code: 'preparation_stalled', path: 'notes/stuck.md' });
  const [backlog] = await readManagedSyncBacklog(engine, [s.id]);
  expect(backlog!.remaining).toBeGreaterThan(0);
  // The cause is gone; the operator follows the route: retry-held prints the backlog's own resume command.
  installFaultHook(undefined);
  const retry = await retryHeld(engine, s.id);
  expect(retry).toMatchObject({ scheduled: 1, items: [{ key: 'notes/stuck.md', code: 'preparation_stalled', action: 'retry_scheduled' }] });
  expect(retry.fix!.argv).toEqual(['gbrain', 'sync', ...backlog!.resume_args]);
  expect(await readGitHoldRetryPaths(engine, s.id, await s.incarnation())).toEqual(['notes/stuck.md']);
  // The printed sync, drained as the CLI drains it: the backlog finishes, then the scheduled re-screen runs before the drain reports synced.
  const drained = await drainManagedSync(engine, { sourceId: s.id, noPull: true, noEmbed: true, noExtract: true }, false);
  expect(drained.drain).toMatchObject({ outcome: 'synced', remaining: 0 });
  expect(drained.drain!.passes).toBeGreaterThanOrEqual(2);
  // The report covers both runs: the backlog cursor's four pages (two from the sliced pass) plus the re-screened one; the drain itself wrote three.
  expect(drained).toMatchObject({ status: 'synced', added: 5, modified: 0 });
  expect(drained.drain!.written).toBe(5 - sliced.added);
  expect(drained.holds_outstanding ?? 0).toBe(0);
  expect(await engine.getPage('notes/stuck', { sourceId: s.id })).not.toBeNull();
  for (const slug of ['notes/a', 'notes/z1', 'notes/z2', 'notes/z3']) expect(await engine.getPage(slug, { sourceId: s.id })).not.toBeNull();
  expect(await s.holds()).toEqual([]);
  expect(await s.summary()).toMatchObject({ count: 0, stalled: 0 });
  expect(await committedAttempts(engine, s.id, 'notes/stuck.md')).toBe(0);
  expect(await readGitHoldRetryPaths(engine, s.id, await s.incarnation())).toEqual([]);
  expect(await s.failedRequests()).toHaveLength(1);
  expect(await s.ledger()).toEqual([]);
  expect(await s.sync()).toMatchObject({ status: 'up_to_date' });
}), 240_000);

test('retry-held while the stall persists: the file is re-held once under the new receipt, counted once, with one hold row', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/stuck.md': note('Stuck') });
  stallPaths(engine, s.id, new Set(['notes/stuck.md']));
  expect(await s.sync()).toMatchObject({ status: 'first_sync', added: 1, held_count: 1 });
  const [first] = await s.failedRequests();
  await retryHeld(engine, s.id);
  const rescreened = await s.sync();
  expect(rescreened).toMatchObject({ status: 'synced', added: 0, held_count: 1, holds_outstanding: 1 });
  const failed = await s.failedRequests();
  expect(failed).toHaveLength(2);
  expect(failed.map(row => row.error_code)).toEqual(['preparation_stalled', 'preparation_stalled']);
  const holds = await s.holds();
  expect(holds).toHaveLength(1);
  expect(holds[0]).toMatchObject({ path: 'notes/stuck.md', code: 'preparation_stalled', meta: { stall: { request_id: failed[1]!.request_id } } });
  expect(holds[0]!.meta.stall!.request_id).not.toBe(first!.request_id);
  expect(await s.summary()).toMatchObject({ count: 1, stalled: 1 });
  expect(await readGitHoldRetryPaths(engine, s.id, await s.incarnation())).toEqual([]);
  expect(await engine.getPage('notes/stuck', { sourceId: s.id })).toBeNull();
  // It waits again: no third receipt without another retry.
  expect(await s.sync()).toMatchObject({ status: 'up_to_date', holds_outstanding: 1 });
  expect(await s.failedRequests()).toHaveLength(2);
}), 180_000);

test('a scheduled re-screen survives a run killed before it reached the file; a run killed after freezing it carries it in its manifest and leaves no stale schedule', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/stuck.md': note('Stuck') });
  stallPaths(engine, s.id, new Set(['notes/stuck.md']));
  expect(await s.sync()).toMatchObject({ status: 'first_sync', held_count: 1 });
  installFaultHook(undefined);
  await retryHeld(engine, s.id);
  const incarnation = await s.incarnation();
  // Killed before discovery: the schedule is untouched.
  const aborted = new AbortController(); aborted.abort();
  expect((await s.sync({ signal: aborted.signal })).status).toBe('partial');
  expect(await readGitHoldRetryPaths(engine, s.id, incarnation)).toEqual(['notes/stuck.md']);
  // Killed right after the fresh cursor is saved: the manifest carries the entry and the schedule was consumed with the same save.
  let killed = 0;
  installFaultHook(async (point, detail) => { if (point === 'sync:mid_checkpoint' && detail.sourceId === s.id && killed++ === 0) throw new Error('injected kill after the cursor save'); });
  await expect(s.sync()).rejects.toThrow('injected kill');
  installFaultHook(undefined);
  expect(killed).toBe(1);
  const [cursor] = await engine.executeRaw<{ c: { entries?: Array<{ path: string }>; total: number; index: number } }>(
    "SELECT completed_keys->0 AS c FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [s.id]);
  expect(cursor!.c).toMatchObject({ total: 1, index: 0 });
  expect(await readGitHoldRetryPaths(engine, s.id, incarnation)).toEqual([]);
  // The next run resumes that cursor and imports the file; nothing is left scheduled, so the run after it has nothing to do.
  expect(await s.sync()).toMatchObject({ status: 'synced', added: 1 });
  expect(await engine.getPage('notes/stuck', { sourceId: s.id })).not.toBeNull();
  expect(await s.holds()).toEqual([]);
  expect(await readGitHoldRetryPaths(engine, s.id, incarnation)).toEqual([]);
  expect(await s.sync()).toMatchObject({ status: 'up_to_date' });
}), 180_000);

// ── #6278 (B2): the systemic breaker ──

test('breaker: five consecutive stalled entries with no commit between stop the run with one systemic diagnostic; the next run re-freezes and re-screens instead of holding', () => each(async engine => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 7; i++) files[`notes/s${i}.md`] = note(`S${i}`);
  const s = await source(engine, files);
  stallPaths(engine, s.id, new Set(Object.keys(files)));
  const tripped = await s.sync();
  expect(tripped).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'preparation_stalled', count: 5 }],
    breaker: { code: 'preparation_systemic', rule: 'consecutive', stalled: 5, consecutive: 5 } });
  expect(tripped.breaker!.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', s.id, '--json']);
  expect(tripped.managedWrite?.write_error).toBe('preparation_stalled');
  // Four holds were written before the trip; the fifth receipt is counted, not held, and the cursor still points at it.
  expect((await s.holds()).map(hold => hold.path).sort()).toEqual(['notes/s0.md', 'notes/s1.md', 'notes/s2.md', 'notes/s3.md']);
  expect(await s.failedRequests()).toHaveLength(5);
  const [cursor] = await engine.executeRaw<{ c: { index: number; breaker: { stalled: string[]; streak: number; tripped?: { rule: string } }; pending: { intent: { path: string } } } }>(
    "SELECT completed_keys->0 AS c FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [s.id]);
  expect(cursor!.c).toMatchObject({ index: 4, pending: { intent: { path: 'notes/s4.md' } }, breaker: { streak: 5, tripped: { rule: 'consecutive' } } });
  expect(cursor!.c.breaker.stalled).toHaveLength(5);
  // Cause fixed: the next run re-freezes the stopped entry under a fresh request (nothing held), finishes, and scheduled the run's four stalled holds
  // for a re-screen. B7: that schedule is the same catch-up's work, so the pass yields (`writer_yield`) for the drain's next pass to discover and take it.
  installFaultHook(undefined);
  const resumed = await s.sync();
  expect(resumed).toMatchObject({ status: 'partial', reason: 'writer_yield', added: 3, managedCursor: { index: 7, total: 7 } });
  expect(resumed.converted_from_failed).toEqual([...cursor!.c.breaker.stalled]);
  expect(await s.failedRequests()).toHaveLength(5);
  expect(await engine.getPage('notes/s4', { sourceId: s.id })).not.toBeNull();
  expect(await s.holds()).toHaveLength(4);
  const rescreened = await s.sync();
  expect(rescreened).toMatchObject({ status: 'synced', added: 4 });
  expect(await s.holds()).toEqual([]);
}), 240_000);

test('breaker: the count rule trips above sync.hold_escalate_count (greater than), and a committed page resets the consecutive streak', () => each(async engine => {
  await engine.setConfig('sync.hold_escalate_count', '2');
  try {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`notes/s${i}.md`] = note(`S${i}`);
    const s = await source(engine, files);
    stallPaths(engine, s.id, new Set(Object.keys(files)));
    const tripped = await s.sync();
    expect(tripped).toMatchObject({ status: 'blocked_by_failures', breaker: { rule: 'count', stalled: 3, consecutive: 3 } });
    expect(await s.holds()).toHaveLength(2);
  } finally { await engine.unsetConfig('sync.hold_escalate_count'); }
  // Streak: four stalled, one committed, four stalled: eight holds and no trip.
  const files: Record<string, string> = { 'notes/m-ok.md': note('Ok') };
  for (let i = 0; i < 4; i++) { files[`notes/a${i}.md`] = note(`A${i}`); files[`notes/z${i}.md`] = note(`Z${i}`); }
  const t = await source(engine, files);
  stallPaths(engine, t.id, new Set(Object.keys(files).filter(path => path !== 'notes/m-ok.md')));
  const result = await t.sync();
  expect(result).toMatchObject({ status: 'first_sync', added: 1, held_count: 8 });
  expect(result.breaker).toBeUndefined();
  expect(result.holds_escalated).toBeUndefined();
}), 240_000);

test('preparationStallMeta keeps the receipt step vocabulary only and tolerates receipts without detail', () => {
  const full = preparationStallMeta({ request_id: 'r1', error_detail: { step: 'origin_check', waiting_on: 'db', attempts: 2, message: 'never stored' } }, ['--source', 'x', '--no-pull']);
  expect(full).toEqual({ request_id: 'r1', step: 'origin_check', waiting_on: 'db', attempts: 2, gbrain_version: VERSION, sync_argv: ['--source', 'x', '--no-pull'] });
  expect(preparationStallMeta({ request_id: 'r2', error_detail: null }, [])).toMatchObject({ step: null, waiting_on: null, attempts: null });
  expect(preparationStallMeta({ request_id: 'r3', error_detail: { waiting_on: 'lock', step: 42 } }, [])).toMatchObject({ step: null, waiting_on: null });
});
