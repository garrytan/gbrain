/**
 * #5988 Lane B: managed sync holds a file gbrain refuses deterministically
 * instead of blocking the source. The rest imports, the checkpoint advances,
 * the hold stays until the file changes, leaves, or a newer reader imports
 * it. #6712 PR 4b: a non-company source runs the live pass, so there is no blocked cursor to convert in place: a failed
 * receipt an older release left is kept as it was while the next pass holds or imports the file, and a blocked pass's
 * opt-outs ride its episode.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { GIT_HOLD_OP, SYNC_IMPORT_PROVENANCE_OP, gitHoldItem, readGitSourceHolds, recordContentHoldRepair, requestGitHoldRetry } from '../src/core/persistence/sync-holds.ts';
import { CONTENT_REPAIR_LANE_VERSION } from '../src/core/persistence/sync-fault-class.ts';
import { printSyncResult, type SyncOpts, type SyncResult } from '../src/commands/sync.ts';
import { readGitHoldStatuses } from '../src/core/persistence/connector-status.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-holds-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'content') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const note = (title: string, body = 'A synthetic observation.') => `---\ntitle: ${title}\n---\n${body}\n`;
const FOLDED = '---\ntitle: alice-example first line\nalice-example second line\n---\nA synthetic post.\n';
const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i} of a long synthetic observation that keeps Git rename detection certain.`).join('\n');
/** Same long body, so Git still detects a rename when only the frontmatter changes. */
const long = (title: string) => `---\ntitle: ${title}\n---\n${LONG}\n`;
/** #6729: an explicit slug: line that an exact move (R100) leaves pointing at the old path, so the moved file is held with the old page's identity. */
const pinned = (title: string, slug: string) => `---\ntitle: ${title}\nslug: ${slug}\n---\n${LONG}\n`;
const longBroken = `---\ntitle: alice-example first line\nalice-example second line\n---\n${LONG}\n`;
const AUTHOR = '---\ntitle: Payments roundup\nauthor: PYMNTS (citing Reuters / Bloomberg) (original: https://x.com/a/status/1)\n---\nA synthetic roundup.\n';

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function source(engine: BrainEngine, files: Record<string, string>) {
  const id = `hold-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = (extra: Partial<SyncOpts> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, ...extra });
  const holds = async () => (await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? [];
  const holdRows = () => engine.executeRaw<{ completed_keys: unknown; updated_at: unknown }>("SELECT completed_keys,updated_at FROM op_checkpoints WHERE op LIKE 'sync-hold%' AND fingerprint LIKE $1 ORDER BY op,fingerprint", [`${id}:%`]);
  const lastCommit = async () => (await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0]!.last_commit;
  return { id, root, sync, holds, holdRows, lastCommit, write: (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); } };
}

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); }
      finally { await disposePersistenceConsumer(engine); for (const key of ['sync.holds', 'sync.parser_regression']) await engine.unsetConfig(key); }
    }
  });
}

const printed = (result: SyncResult) => { let out = ''; printSyncResult(result, { write: (text: string) => { out += text; return true; } } as NodeJS.WriteStream); return out; };

test('three good files and one broken one: the sync completes, holds one, advances, and says what to do', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/b.md': note('B'), 'notes/c.md': note('C'), 'notes/broken.md': FOLDED });
  const head = git(s.root, 'rev-parse', 'HEAD');
  const result = await s.sync();
  expect(result).toMatchObject({ status: 'first_sync', added: 3, held_count: 1, holds_outstanding: 1 });
  expect(await s.lastCommit()).toBe(head);
  expect(await engine.getPage('notes/broken', { sourceId: s.id })).toBeNull();
  expect(result.held![0]).toMatchObject({ path: 'notes/broken.md', code: 'invalid_frontmatter', reason: 'needs_interpretation', key: 'title', line: 2, stale: false,
    docs: 'docs/guides/write-refusals.md#invalid_frontmatter-needs_interpretation' });
  expect(result.held![0]!.fix.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', s.id, '--include-ambiguous']);
  const text = printed(result);
  expect(text).toContain('Held notes/broken.md: invalid_frontmatter (needs_interpretation) at line 2, key "title"');
  expect(text).toContain(`gbrain sources status ${s.id}`);
  expect(text).not.toContain('alice-example');
  const [row] = await engine.executeRaw<{ completed_keys: unknown }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2', [GIT_HOLD_OP, `${s.id}:%`]);
  expect(JSON.stringify(row!.completed_keys)).not.toContain('alice-example');
  // A no-change run still reports the outstanding hold.
  const again = await s.sync();
  expect(again).toMatchObject({ status: 'up_to_date', holds_outstanding: 1, held_count: 0 });
  expect(printed(again)).toContain('1 held in source');
}), 180_000);

test('fixing and committing the file imports it and clears the hold; deleting a held file clears it too', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': FOLDED, 'notes/b.md': FOLDED, 'notes/ok.md': note('Ok') });
  expect((await s.sync()).held_count).toBe(2);
  s.write('notes/a.md', note('Fixed A')); unlinkSync(join(s.root, 'notes/b.md')); commit(s.root, 'fix and delete');
  const result = await s.sync();
  expect(result).toMatchObject({ status: 'synced', added: 1 });
  expect((await engine.getPage('notes/a', { sourceId: s.id }))?.title).toBe('Fixed A');
  expect(await s.holds()).toEqual([]);
  expect(result.holds_outstanding).toBeUndefined();
}), 180_000);

test('slug conflicts and files over the page ceiling (the sync read bound) are held; valid files keep importing', () => each(async engine => {
  const big = `---\ntitle: Big\n---\n${'x'.repeat(PAGE_MAX_BYTES + 16)}\n`;
  const huge = `---\ntitle: Huge\n---\n${'y'.repeat(PAGE_MAX_BYTES + 1024 * 1024)}\n`;
  const s = await source(engine, { 'notes/slug.md': '---\ntitle: Slug\nslug: notes/elsewhere\n---\nBody.\n', 'notes/big.md': big, 'notes/huge.md': huge, 'notes/ok.md': note('Ok') });
  const result = await s.sync();
  expect(result).toMatchObject({ status: 'first_sync', added: 1, held_count: 3 });
  const byPath = Object.fromEntries((await s.holds()).map(hold => [hold.path, hold]));
  expect(byPath['notes/slug.md']).toMatchObject({ code: 'frontmatter_slug_conflict' });
  expect(byPath['notes/slug.md']!.message).not.toContain('elsewhere');
  expect(byPath['notes/big.md']).toMatchObject({ code: 'file_too_large' });
  expect(byPath['notes/huge.md']).toMatchObject({ code: 'file_too_large', upstream_version: null });
  expect(byPath['notes/huge.md']!.meta.blob_oid).toBe(git(s.root, 'rev-parse', 'HEAD:notes/huge.md'));
  expect(result.held!.find(item => item.code === 'file_too_large')!.fix.why).toContain('size limit is fixed');
}), 180_000);

test('an oversized pinned blob is held by its size even when the working copy is small', () => each(async engine => {
  const s = await source(engine, { 'notes/ok.md': note('Ok') });
  s.write('notes/history.md', `---\ntitle: History\n---\n${'z'.repeat(PAGE_MAX_BYTES + 1024 * 1024)}\n`); commit(s.root, 'big');
  s.write('notes/history.md', note('Small now'));
  const result = await s.sync();
  expect(result.held?.map(item => [item.path, item.code])).toEqual([['notes/history.md', 'file_too_large']]);
  expect((await s.holds())[0]).toMatchObject({ upstream_version: null, meta: { blob_oid: git(s.root, 'rev-parse', 'HEAD:notes/history.md') } });
}), 180_000);

test('dry run lists every would-be hold, writes nothing, and leaves hold rows byte-identical', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': FOLDED, 'notes/ok.md': note('Ok') });
  await s.sync();
  s.write('notes/a.md', '---\ntitle: still broken\nmore broken text\n---\nBody.\n'); s.write('notes/new.md', FOLDED); commit(s.root, 'more');
  const before = await s.holdRows();
  const requests = await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [s.id]);
  const dry = await s.sync({ dryRun: true });
  expect(dry).toMatchObject({ status: 'dry_run', dry_run: true, would_hold_count: 2 });
  expect(dry.would_hold!.map(item => item.path).sort()).toEqual(['notes/a.md', 'notes/new.md']);
  expect(await s.holdRows()).toEqual(before);
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [s.id])).toEqual(requests);
  expect(printed(dry)).toContain('Would hold notes/new.md');
}), 180_000);

test('a sliced run that has not reached a held file leaves its hold untouched; a failed publication keeps the hold', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/z.md': note('Z') });
  await s.sync();
  s.write('notes/z.md', FOLDED); commit(s.root, 'break z');
  expect((await s.sync()).held_count).toBe(1);
  s.write('notes/a.md', note('A2')); s.write('notes/z.md', note('Z fixed')); commit(s.root, 'fix z');
  const before = await s.holdRows();
  const partial = await performManagedSync(engine, { sourceId: s.id, noPull: true, noEmbed: true, noExtract: true }, { maxPages: 1, maxMs: 60_000 });
  expect(partial).toMatchObject({ status: 'partial', reason: 'writer_yield', holds_pending_screen: true });
  expect(await s.holdRows()).toEqual(before);
  // The committed fix is admitted, but newer uncommitted working-tree bytes make its publication refuse. #6340: the refusal
  // becomes a `worktree_dirty` hold of the same path (the run finishes; the frontmatter hold is replaced, never cleared).
  s.write('notes/z.md', note('Z newer uncommitted edit'));
  const held = await s.sync();
  expect(held).toMatchObject({ status: 'synced', held: [{ path: 'notes/z.md', code: 'worktree_dirty' }] });
  const code = (rows: Array<{ completed_keys: unknown }>) => rows.map(row => (row.completed_keys as Array<{ code?: string }>)[0]?.code).filter(Boolean);
  expect(code(before)).toEqual(['invalid_frontmatter']);
  expect(code(await s.holdRows())).toEqual(['worktree_dirty']);
}), 180_000);

test('renamed to a broken file keeps the old page, a later fix moves it with its id, and a full walk never deletes it meanwhile', () => each(async engine => {
  const s = await source(engine, { 'notes/old.md': pinned('Old', 'notes/old') });
  await s.sync();
  const page = (await engine.getPage('notes/old', { sourceId: s.id }))!;
  git(s.root, 'mv', 'notes/old.md', 'notes/new.md'); commit(s.root, 'exact move onto a stale slug: line');
  expect(git(s.root, 'diff', '--name-status', '-M', 'HEAD~1', 'HEAD')).toMatch(/^R100\t/);
  const held = await s.sync();
  expect(held.held?.[0]).toMatchObject({ path: 'notes/new.md', stale: false });
  expect((await s.holds())[0]!.meta.rename_from).toMatchObject({ slug: 'notes/old', pageId: page.id });
  expect((await engine.getPage('notes/old', { sourceId: s.id }))?.id).toBe(page.id);
  const full = await s.sync({ full: true });
  expect(full.status).not.toBe('blocked_by_failures');
  expect((await engine.getPage('notes/old', { sourceId: s.id }))?.deleted_at ?? null).toBeNull();
  s.write('notes/new.md', long('New')); commit(s.root, 'fix');
  await s.sync();
  const moved = (await engine.getPage('notes/new', { sourceId: s.id }))!;
  expect(moved.id).toBe(page.id);
  expect(await s.holds()).toEqual([]);
}), 240_000);

test('a chained rename carries the held identity, and a changed old page keeps the rename held as rename_held', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': pinned('A', 'notes/a'), 'notes/x.md': pinned('X', 'notes/x') });
  await s.sync();
  const a = (await engine.getPage('notes/a', { sourceId: s.id }))!;
  git(s.root, 'mv', 'notes/a.md', 'notes/b.md'); commit(s.root, 'a to b, held');
  await s.sync();
  git(s.root, 'mv', 'notes/b.md', 'notes/c.md'); commit(s.root, 'b to c, still held');
  await s.sync();
  s.write('notes/c.md', long('C')); commit(s.root, 'fix c');
  await s.sync();
  expect((await engine.getPage('notes/c', { sourceId: s.id }))?.id).toBe(a.id);
  expect(await s.holds()).toEqual([]);

  const x = (await engine.getPage('notes/x', { sourceId: s.id }))!;
  git(s.root, 'mv', 'notes/x.md', 'notes/y.md'); commit(s.root, 'x to y, held');
  await s.sync();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE id=$1', [x.id]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  s.write('notes/y.md', long('Y')); commit(s.root, 'fix y');
  const result = await s.sync();
  expect(result.held?.[0]).toMatchObject({ path: 'notes/y.md', code: 'rename_held', reason: 'rename_source_changed' });
  expect((await engine.getPage('notes/x', { sourceId: s.id }))?.id).toBe(x.id);
}), 240_000);

test('#6729: an inexact rename onto a broken file is a delete plus an add; the old page stays recorded, and once the file is fixed the record names the new page', () => each(async engine => {
  const s = await source(engine, { 'notes/old.md': long('Old') });
  await s.sync();
  const page = (await engine.getPage('notes/old', { sourceId: s.id }))!;
  git(s.root, 'mv', 'notes/old.md', 'notes/new.md'); s.write('notes/new.md', longBroken); commit(s.root, 'rename to broken');
  expect(git(s.root, 'diff', '--name-status', '-M', 'HEAD~1', 'HEAD')).toMatch(/^R0\d\d\tnotes\/old.md\tnotes\/new.md$/);
  const held = await s.sync();
  expect(held.held?.[0]).toMatchObject({ path: 'notes/new.md', code: 'invalid_frontmatter' });
  expect((await s.holds())[0]!.meta.rename_from).toBeUndefined();
  expect(held.identityDowngrades).toMatchObject([{ from: 'notes/old.md', to: 'notes/new.md', old_slug: 'notes/old', old_page_id: page.id, new_slug: null }]);
  const oldRow = async () => (await engine.executeRaw<{ id: number; deleted_at: string | null }>('SELECT id, deleted_at FROM pages WHERE source_id=$1 AND slug=$2', [s.id, 'notes/old']))[0];
  expect((await oldRow())!.deleted_at).not.toBeNull();
  s.write('notes/new.md', long('New')); commit(s.root, 'fix');
  await s.sync();
  const fresh = (await engine.getPage('notes/new', { sourceId: s.id }))!;
  expect(fresh.id).not.toBe(page.id);
  const { listIdentityDowngrades } = await import('../src/core/sync-identity-downgrades.ts');
  expect((await listIdentityDowngrades(engine, [s.id])).map(record => [record.old_slug, record.new_slug])).toEqual([['notes/old', 'notes/new']]);
}), 240_000);

// #6712 PR 4b: a non-company pass steps an in-memory round batch, not a cursor row, so the hold write commits in the
// transaction of the batch step that passes its file (sync-pass-batch.ts passBatchStep), and the pass row is saved after.
// A crash inside that transaction persists neither the hold nor the step (no hold or summary row, no request for the
// file, the pass row still open with nothing held), and the next pass holds the file once. A crash after the hold
// committed but before the pass saved its row leaves the hold beside a stale pass row; the next pass completes the sync
// without a second hold (the one record, one attempt) and without re-importing what the crashed pass committed.
test('the hold write and the batch step past it commit together: a crash between them persists neither, and a crash before the pass row save leaves one hold the next pass completes without duplicating', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/broken.md': FOLDED, 'notes/c.md': note('C') });
  const passRow = async (id: string) => (await engine.executeRaw<{ v: { telemetry: { pass_id: string; outcome: string; counts: { held?: number } } } }>(
    "SELECT completed_keys->0 AS v FROM op_checkpoints WHERE op='managed-sync-pass' AND fingerprint LIKE $1", [id + ':%']))[0]?.v.telemetry;
  const receipts = (id: string) => engine.executeRaw<{ path: string | null; state: string; pass_id: string }>(
    "SELECT intent->>'path' AS path,state,intent->>'passId' AS pass_id FROM persistence_requests WHERE source_id=$1 ORDER BY sequence", [id]);
  const target = engine as unknown as { transaction: (this: unknown, fn: (tx: BrainEngine) => Promise<unknown>) => Promise<unknown> };
  const inherited = Object.getPrototypeOf(engine).transaction as typeof target.transaction;
  let injected = 0;
  target.transaction = function (fn) {
    return inherited.call(this, (tx: BrainEngine) => fn(new Proxy(tx, { get(t, prop) {
      if (prop === 'executeRaw') {
        return async (sql: string, params?: unknown[]) => {
          const rows = await t.executeRaw(sql, params);
          if (params?.[0] === GIT_HOLD_OP && /^\s*INSERT/.test(sql)) { injected++; throw new Error('injected crash after the hold write'); }
          return rows;
        };
      }
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    } }) as BrainEngine));
  };
  let crashed: unknown;
  try { crashed = await s.sync().then(() => null, error => error); }
  finally { delete (target as Partial<typeof target>).transaction; }
  expect(injected).toBe(1);
  expect(String((crashed as Error | null)?.message)).toContain('injected crash after the hold write');
  expect(await s.holdRows()).toEqual([]);
  const stopped = (await passRow(s.id))!;
  expect(stopped).toMatchObject({ outcome: 'open' });
  expect(stopped.counts.held ?? 0).toBe(0);
  expect(await s.lastCommit()).toBeNull();
  expect(await receipts(s.id)).toEqual([{ path: 'notes/a.md', state: 'committed', pass_id: stopped.pass_id }]);
  expect(await engine.getPage('notes/c', { sourceId: s.id })).toBeNull();

  // Without the crash the next pass holds the file once and imports the rest; notes/a.md is not imported again.
  const resumed = await s.sync();
  expect(resumed).toMatchObject({ status: 'first_sync', held_count: 1, held: [{ path: 'notes/broken.md', code: 'invalid_frontmatter' }], pass: { outcome: 'synced' } });
  expect((await s.holds()).map(hold => [hold.path, hold.run_id, hold.meta.attempts])).toEqual([['notes/broken.md', resumed.pass!.pass_id, 1]]);
  expect(await engine.getPage('notes/c', { sourceId: s.id })).not.toBeNull();
  expect((await receipts(s.id)).filter(row => row.path === 'notes/a.md')).toHaveLength(1);
  expect((await passRow(s.id))!.counts.held).toBe(1);
  expect(await s.lastCommit()).toBe(git(s.root, 'rev-parse', 'HEAD'));

  // The hold committed, then the process died before the pass saved its row.
  const t = await source(engine, { 'notes/a.md': note('A'), 'notes/broken.md': FOLDED, 'notes/c.md': note('C') });
  let killed = 0;
  installFaultHook(async (point, detail) => {
    if (point !== 'sync:mid_checkpoint' || detail.sourceId !== t.id || killed) return;
    if (!(await t.holds()).length) return;
    killed++;
    throw new Error('injected kill after the hold committed');
  });
  try { await expect(t.sync()).rejects.toThrow('injected kill after the hold committed'); }
  finally { installFaultHook(undefined); }
  expect(killed).toBe(1);
  const [hold] = await t.holds();
  const lagging = (await passRow(t.id))!;
  expect(hold).toMatchObject({ path: 'notes/broken.md', code: 'invalid_frontmatter', run_id: lagging.pass_id, meta: { attempts: 1 } });
  expect(lagging).toMatchObject({ outcome: 'open' });
  expect(lagging.counts.held ?? 0).toBe(0);
  expect(await t.lastCommit()).toBeNull();
  const rows = await t.holdRows();
  const completed = await t.sync();
  expect(completed).toMatchObject({ status: 'first_sync', holds_outstanding: 1, pass: { outcome: 'synced' } });
  expect(await t.holdRows()).toEqual(rows);
  expect(await engine.getPage('notes/c', { sourceId: t.id })).not.toBeNull();
  expect(await engine.getPage('notes/broken', { sourceId: t.id })).toBeNull();
  expect((await receipts(t.id)).filter(row => row.path === 'notes/a.md')).toHaveLength(1);
  expect(await t.lastCommit()).toBe(git(t.root, 'rev-parse', 'HEAD'));
  expect(await readManagedSyncFailures(engine, [s.id, t.id])).toEqual([]);
}), 180_000);

// #6712 PR 4b: a non-company source has no blocked cursor to convert; a legacy cursor row is retired by the first pass
// (sync-pass-cursor-retirement-6712), which re-classifies the file. A failed receipt an older release left for the file
// (here: a blocked pass under sync.holds=fail, its error rewritten to the older text) is not converted or rewritten: once
// holds are on, the next pass holds the file when its bytes still refuse and imports it under a request of its own when
// they now read, and the old receipt stays exactly as it was.
test('a pre-upgrade failed receipt is left as it was by the pass: the file is held when still broken and imported under a new request when now readable', () => each(async engine => {
  const receipts = (id: string) => engine.executeRaw<{ request_id: string; state: string; error_code: string | null; error_message: string | null; path: string | null; pass_id: string }>(
    "SELECT request_id::text AS request_id,state,error_code,error_message,intent->>'path' AS path,intent->>'passId' AS pass_id FROM persistence_requests WHERE source_id=$1 ORDER BY sequence", [id]);
  await engine.setConfig('sync.holds', 'fail');
  const s = await source(engine, { 'notes/broken.md': FOLDED, 'notes/roundup.md': AUTHOR, 'notes/ok.md': note('Ok') });
  expect((await s.sync()).status).toBe('blocked_by_failures');
  const [failed] = await engine.executeRaw<{ request_id: string }>("SELECT request_id::text AS request_id FROM persistence_requests WHERE source_id=$1 AND state='failed'", [s.id]);
  // The exact text an older release stored for this refusal.
  await engine.executeRaw("UPDATE persistence_requests SET error_code='invalid_params',error_message=$2 WHERE request_id=$1::uuid",
    [failed!.request_id, 'Invalid YAML frontmatter: bad indentation of a mapping entry (3:1)']);
  const old = await receipts(s.id);
  expect(old).toEqual([expect.objectContaining({ request_id: failed!.request_id, state: 'failed', error_code: 'invalid_params', path: 'notes/broken.md' })]);
  await engine.unsetConfig('sync.holds');
  const held = await s.sync();
  expect(held).toMatchObject({ status: 'first_sync', held_count: 1, held: [{ path: 'notes/broken.md', code: 'invalid_frontmatter' }], pass: { outcome: 'synced' } });
  expect(held.converted_from_failed).toBeUndefined();
  expect(await engine.getPage('notes/broken', { sourceId: s.id })).toBeNull();
  expect(await engine.getPage('notes/ok', { sourceId: s.id })).not.toBeNull();
  expect((await engine.getPage('notes/roundup', { sourceId: s.id }))?.title).toBe('Payments roundup');
  expect((await s.holds()).map(hold => [hold.path, hold.code, hold.run_id, hold.meta.attempts])).toEqual([['notes/broken.md', 'invalid_frontmatter', held.pass!.pass_id, 1]]);
  const after = await receipts(s.id);
  expect(after[0]).toEqual(old[0]);
  // The still-broken file is held by the screen, so the pass admits no request for it.
  expect(after.slice(1).map(row => [row.path, row.state, row.pass_id]).sort()).toEqual([[null, 'committed', held.pass!.pass_id], ['notes/ok.md', 'committed', held.pass!.pass_id],
    ['notes/roundup.md', 'committed', held.pass!.pass_id]].sort());
  expect(await s.sync()).toMatchObject({ status: 'up_to_date', holds_outstanding: 1 });
  expect(await receipts(s.id)).toEqual(after);
  expect((await readGitHoldStatuses(engine, [s.id])).get(s.id)).toMatchObject({ count: 1, items: [{ path: 'notes/broken.md', code: 'invalid_frontmatter' }] });

  // Already fixed: a working-tree pass imports the fixed bytes under a new request; the old receipt stays as it was.
  await engine.setConfig('sync.holds', 'fail');
  const t = await source(engine, { 'notes/ok.md': note('Ok') });
  t.write('notes/draft.md', FOLDED);
  expect((await t.sync({ workingTree: true })).status).toBe('blocked_by_failures');
  const [draft] = await receipts(t.id);
  expect(draft).toMatchObject({ state: 'failed', error_code: 'invalid_params', path: 'notes/draft.md' });
  await engine.unsetConfig('sync.holds');
  t.write('notes/draft.md', AUTHOR);
  const fixed = await t.sync({ workingTree: true });
  expect(fixed).toMatchObject({ status: 'synced', pass: { outcome: 'synced' } });
  expect(fixed.held_count ?? 0).toBe(0);
  expect((await engine.getPage('notes/draft', { sourceId: t.id }))?.title).toBe('Payments roundup');
  expect(await t.holds()).toEqual([]);
  const drafts = (await receipts(t.id)).filter(row => row.path === 'notes/draft.md');
  expect(drafts).toEqual([draft, expect.objectContaining({ state: 'committed', error_code: null, pass_id: fixed.pass!.pass_id })]);
  expect(drafts[1]!.request_id).not.toBe(draft!.request_id);
  expect(await readManagedSyncFailures(engine, [s.id, t.id])).toEqual([]);
}), 240_000);

// #6712 PR 4b: a non-company source keeps its opt-outs on the pass row's episode, not on a cursor. The --no-embed pass
// that blocked under sync.holds=fail opened an episode carrying them, so the next flagless pass inherits them
// (result.inherited_options, as sync-pass-cursor-retirement-6712 shows for a legacy cursor's options) and every request it
// admits carries noEmbed. Repeated syncs of a refusal the pass held mint no new receipt per run, under the hold policy
// or sync.holds=fail.
test('a flagless pass inherits a blocked --no-embed pass\'s options from its episode, and repeated syncs of a held refusal mint no receipt per run, under the hold policy or sync.holds=fail', () => each(async engine => {
  const receipts = (id: string) => engine.executeRaw<{ request_id: string; path: string | null; state: string; no_embed: boolean | null }>(
    "SELECT request_id::text AS request_id,intent->>'path' AS path,state,(intent->'processingOptions'->>'noEmbed')::boolean AS no_embed FROM persistence_requests WHERE source_id=$1 ORDER BY sequence", [id]);
  await engine.setConfig('sync.holds', 'fail');
  const s = await source(engine, { 'notes/broken.md': FOLDED });
  const blocked = await s.sync({ noEmbed: true });
  expect(blocked).toMatchObject({ status: 'blocked_by_failures', pass: { outcome: 'blocked' } });
  const [row] = await engine.executeRaw<{ episode: { inherited: { noEmbed: boolean; from: string } } }>(
    "SELECT completed_keys->0->'obligations'->'episode' AS episode FROM op_checkpoints WHERE op='managed-sync-pass' AND fingerprint LIKE $1", [s.id + ':%']);
  expect(row!.episode.inherited).toMatchObject({ noEmbed: true, from: 'flag' });
  await engine.unsetConfig('sync.holds');
  s.write('notes/broken.md', note('Fixed in the working tree only'));
  // Pinned bytes still refuse, so the file is held; the stored --no-embed survives the flagless run.
  const held = await performManagedSync(engine, { sourceId: s.id, noPull: true });
  expect(held).toMatchObject({ status: 'first_sync', held_count: 1, held: [{ path: 'notes/broken.md', code: 'invalid_frontmatter' }] });
  expect(held.inherited_options).toContain('noEmbed');
  const admitted = await receipts(s.id);
  expect(admitted.length).toBeGreaterThan(1);
  expect(admitted.every(receipt => receipt.no_embed === true)).toBe(true);
  for (let run = 0; run < 2; run++) expect((await performManagedSync(engine, { sourceId: s.id, noPull: true })).status).toBe('up_to_date');
  expect(await receipts(s.id)).toEqual(admitted);

  // A stored content refusal the screen does not reproduce (a pinned-worktree conflict whose receipt carries an older
  // YAML refusal text): the next pass under the hold policy holds the file worktree_dirty under one new receipt, and
  // neither later plain syncs nor sync.holds=fail mint another.
  const t = await source(engine, { 'notes/z.md': note('Z') });
  await t.sync();
  t.write('notes/z.md', note('Z committed')); commit(t.root, 'change z');
  t.write('notes/z.md', note('Z newer uncommitted edit'));
  await engine.setConfig('sync.holds', 'fail');
  try { expect((await t.sync()).status).toBe('blocked_by_failures'); } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
  await engine.executeRaw("UPDATE persistence_requests SET error_code='invalid_params',error_message='Invalid YAML frontmatter: bad indentation of a mapping entry (3:1)' WHERE source_id=$1 AND state IN ('failed','conflict')", [t.id]);
  const stored = await receipts(t.id);
  const rescreened = await t.sync();
  expect(rescreened).toMatchObject({ status: 'synced', held: [{ path: 'notes/z.md', code: 'worktree_dirty' }] });
  const once = await receipts(t.id);
  expect(once.slice(0, stored.length)).toEqual(stored);
  expect(once.slice(stored.length).filter(receipt => receipt.path === 'notes/z.md')).toEqual([expect.objectContaining({ state: 'conflict' })]);
  for (let run = 0; run < 2; run++) expect((await t.sync()).status).toBe('up_to_date');
  await engine.setConfig('sync.holds', 'fail');
  try { for (let run = 0; run < 2; run++) expect((await t.sync()).status).toBe('up_to_date'); } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
  expect(await receipts(t.id)).toEqual(once);
  expect((await t.holds()).map(hold => [hold.path, hold.code, hold.meta.attempts])).toEqual([['notes/z.md', 'worktree_dirty', 1]]);
}), 240_000);

test('parser regression: GBRAIN_SYNC_PARSER_REGRESSION=stop stops only when provenance proves the same bytes imported validated; the default holds and continues; no provenance holds normally', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/ok.md': note('Ok') });
  await s.sync();
  const page = (await engine.getPage('notes/a', { sourceId: s.id }))!;
  const [provenance] = await engine.executeRaw<{ completed_keys: Array<{ raw_sha256: string; validated: boolean }> }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2',
    [SYNC_IMPORT_PROVENANCE_OP, `${s.id}:%:${page.id}`]);
  expect(provenance!.completed_keys[0]).toMatchObject({ raw_sha256: sha256(note('A')), validated: true });
  s.write('notes/a.md', FOLDED); commit(s.root, 'break a');
  // Simulate a reader regression: the provenance claims these exact bytes imported validated.
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,raw_sha256}',to_jsonb($3::text)) WHERE op=$1 AND fingerprint LIKE $2`,
    [SYNC_IMPORT_PROVENANCE_OP, `${s.id}:%:${page.id}`, sha256(FOLDED)]);
  const head = await s.lastCommit();
  await withEnv({ GBRAIN_SYNC_PARSER_REGRESSION: 'stop' }, () => expect(s.sync()).rejects.toMatchObject({ code: 'sync_parser_regression' }));
  expect(await s.lastCommit()).toBe(head);
  // #6712 PR 2: a stored sync.parser_regression (retired) is not applied; the process's GBRAIN_SYNC_PARSER_REGRESSION is.
  await engine.setConfig('sync.parser_regression', 'hold');
  await withEnv({ GBRAIN_SYNC_PARSER_REGRESSION: 'stop' }, () => expect(s.sync({ retryFailed: true })).rejects.toMatchObject({ code: 'sync_parser_regression' }));
  expect(await s.lastCommit()).toBe(head);
  await engine.setConfig('sync.parser_regression', 'stop');
  // GBRA-108: with the variable unset the default holds (and a stored stop is not applied either).
  const held = await withEnv({ GBRAIN_SYNC_PARSER_REGRESSION: undefined }, () => s.sync({ retryFailed: true }));
  await engine.unsetConfig('sync.parser_regression');
  expect(held.held?.[0]).toMatchObject({ path: 'notes/a.md', code: 'parser_regression' });
  expect(await s.lastCommit()).not.toBe(head);

  // A page without provenance (imported before validation) is held normally on a full walk, never a stop.
  const t = await source(engine, { 'notes/b.md': note('B') });
  await t.sync();
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2', [SYNC_IMPORT_PROVENANCE_OP, `${t.id}:%`]);
  t.write('notes/b.md', FOLDED); commit(t.root, 'break b');
  const full = await t.sync({ full: true });
  expect(full.held?.[0]).toMatchObject({ path: 'notes/b.md', code: 'invalid_frontmatter', stale: true });
}), 240_000);

test('escalation flags a source past its threshold; sync.holds=fail restores blocking; retry-held re-screens an unchanged hold', () => each(async engine => withEnv({ GBRAIN_SYNC_HOLD_ESCALATE_COUNT: '1' }, async () => {
  const s = await source(engine, { 'notes/a.md': FOLDED, 'notes/b.md': FOLDED, 'notes/ok.md': note('Ok') });
  const result = await s.sync();
  expect(result).toMatchObject({ held_count: 2, holds_escalated: true });
  expect(printed(result)).toContain('HOLDS ESCALATED');
  const [held] = await s.holds();
  await requestGitHoldRetry(engine, s.id, held!.incarnation, ['notes/a.md']);
  s.write('notes/ok.md', note('Ok 2')); commit(s.root, 'touch ok');
  const retried = await s.sync();
  expect(retried.held?.map(item => item.path)).toEqual(['notes/a.md']);
  const [request] = await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='sync-hold-retry' AND fingerprint LIKE $1", [`${s.id}:%`]);
  expect(request).toBeUndefined();

  await engine.setConfig('sync.holds', 'fail');
  const t = await source(engine, { 'notes/a.md': FOLDED });
  expect((await t.sync()).status).toBe('blocked_by_failures');
  expect(await t.holds()).toEqual([]);
})), 240_000);

test('files imported by quoting are counted with their common directory', () => each(async engine => {
  const s = await source(engine, { 'tweets/2026/one.md': AUTHOR, 'tweets/2026/two.md': AUTHOR.replace('Payments roundup', 'Second roundup') });
  const result = await s.sync();
  expect(result.recovered_frontmatter).toMatchObject({ count: 2, common_prefix: 'tweets/2026' });
  expect(result.recovered_frontmatter!.fix!.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', s.id]);
  expect(printed(result)).toContain('under tweets/2026/');
}), 180_000);

test('a hold an older reader wrote is re-screened by the next sync even though Git did not touch the file', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': FOLDED, 'notes/ok.md': note('Ok') });
  const first = await s.sync();
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,recovery_version}','0'::jsonb) WHERE op=$1 AND fingerprint LIKE $2`, [GIT_HOLD_OP, `${s.id}:%`]);
  s.write('notes/ok.md', note('Ok 2')); commit(s.root, 'touch ok');
  const second = await s.sync();
  expect(second.held?.map(item => item.path)).toEqual(['notes/a.md']);
  const [hold] = await s.holds();
  expect(hold!.meta.recovery_version).toBeGreaterThan(0);
  expect(hold!.run_id).not.toBe(first.runId);
}), 180_000);

test('#6377: a slug-conflict hold carries the content-repair verdict only for the bytes it judged, keeps it across a re-screen of the same bytes, and drops it when the file changes', () => each(async engine => {
  const s = await source(engine, { 'notes/slug.md': '---\ntitle: Slug\nslug: notes/elsewhere\n---\nBody.\n', 'notes/ok.md': note('Ok') });
  await s.sync();
  const [hold] = await s.holds();
  expect(hold).toMatchObject({ code: 'frontmatter_slug_conflict' });
  expect(gitHoldItem(hold!).fix.argv).toEqual(['gbrain', 'repair', 'content', '--source', s.id, '--only', 'notes/slug.md']);
  expect(gitHoldItem(hold!).fix.why).toContain('The content-repair lane clears this itself on the next maintenance run');
  const state = { action: 'merge_into' as const, reason: 'merge_recommended', canonical: 'notes/elsewhere', named: 'notes/elsewhere', model: 'anthropic:claude-opus-5-5', at: new Date().toISOString(), next_attempt_after: null, lane_version: CONTENT_REPAIR_LANE_VERSION };
  // Conditional on the judged bytes and the code: other bytes or another path record nothing.
  expect(await recordContentHoldRepair(engine, { sourceId: s.id, incarnation: hold!.incarnation, path: 'notes/slug.md', upstreamVersion: sha256('other bytes'), state })).toBe(false);
  expect(await recordContentHoldRepair(engine, { sourceId: s.id, incarnation: hold!.incarnation, path: 'notes/ok.md', upstreamVersion: null, state })).toBe(false);
  expect(await recordContentHoldRepair(engine, { sourceId: s.id, incarnation: hold!.incarnation, path: 'notes/slug.md', upstreamVersion: hold!.upstream_version, state })).toBe(true);
  const judged = (await s.holds())[0]!;
  expect(judged.meta.content_repair).toEqual(state);
  expect(judged.observed_at).toBe(hold!.observed_at);
  const item = gitHoldItem(judged);
  expect(item).toMatchObject({ content_repair: state, docs: 'docs/guides/write-refusals.md#merge_recommended' });
  expect(item.fix).toMatchObject({ actor: 'user', argv: ['gbrain', 'repair', 'content', '--source', s.id, '--only', 'notes/slug.md'] });
  expect(item.fix.user_message).toContain('`notes/elsewhere`');
  expect(item.fix.user_message).toContain('gbrain does not merge pages by itself yet');
  // A re-screen of the same bytes (slug conflicts always re-screen) keeps the verdict, with or without a retry request.
  s.write('notes/ok.md', note('Ok 2')); commit(s.root, 'touch ok');
  await s.sync();
  expect((await s.holds())[0]!.meta.content_repair).toEqual(state);
  await requestGitHoldRetry(engine, s.id, hold!.incarnation, ['notes/slug.md']);
  await s.sync();
  expect((await s.holds())[0]!.meta).toMatchObject({ content_repair: state, attempts: 3 });
  // Changed bytes under the same code drop it: the verdict was about other content.
  s.write('notes/slug.md', '---\ntitle: Slug\nslug: notes/elsewhere\n---\nBody, edited.\n'); commit(s.root, 'edit slug file');
  await s.sync();
  const changed = (await s.holds())[0]!;
  expect(changed.code).toBe('frontmatter_slug_conflict');
  expect(changed.meta.content_repair).toBeUndefined();
  expect(gitHoldItem(changed).docs).toBe('docs/guides/write-refusals.md#frontmatter_slug_conflict');
}), 180_000);
