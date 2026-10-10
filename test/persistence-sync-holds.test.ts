/**
 * #5988 Lane B: managed sync holds a file gbrain refuses deterministically
 * instead of blocking the source. The rest imports, the checkpoint advances,
 * the hold stays until the file changes, leaves, or a newer reader imports
 * it, and blocked cursors from older releases convert in place.
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
import { sha256 } from '../src/core/persistence/digest.ts';
import { GIT_HOLD_OP, SYNC_IMPORT_PROVENANCE_OP, gitHoldItem, readGitSourceHolds, recordContentHoldRepair, requestGitHoldRetry } from '../src/core/persistence/sync-holds.ts';
import { printSyncResult, type SyncOpts, type SyncResult } from '../src/commands/sync.ts';
import { gitHoldStatusLines, readGitHoldStatuses } from '../src/core/persistence/connector-status.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

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
      finally { await disposePersistenceConsumer(engine); for (const key of ['sync.holds', 'sync.parser_regression', 'sync.hold_escalate_count']) await engine.unsetConfig(key); }
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

test('slug conflicts and files over 5 MB and over the 10 MiB read bound are held; valid files keep importing', () => each(async engine => {
  const big = `---\ntitle: Big\n---\n${'x'.repeat(6_000_000)}\n`;
  const huge = `---\ntitle: Huge\n---\n${'y'.repeat(11 * 1024 * 1024)}\n`;
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
  s.write('notes/history.md', `---\ntitle: History\n---\n${'z'.repeat(11 * 1024 * 1024)}\n`); commit(s.root, 'big');
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
  const s = await source(engine, { 'notes/old.md': long('Old') });
  await s.sync();
  const page = (await engine.getPage('notes/old', { sourceId: s.id }))!;
  git(s.root, 'mv', 'notes/old.md', 'notes/new.md'); s.write('notes/new.md', longBroken); commit(s.root, 'rename to broken');
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
  const s = await source(engine, { 'notes/a.md': long('A'), 'notes/x.md': long('X') });
  await s.sync();
  const a = (await engine.getPage('notes/a', { sourceId: s.id }))!;
  git(s.root, 'mv', 'notes/a.md', 'notes/b.md'); s.write('notes/b.md', longBroken); commit(s.root, 'a to b broken');
  await s.sync();
  git(s.root, 'mv', 'notes/b.md', 'notes/c.md'); s.write('notes/c.md', long('C')); commit(s.root, 'b to c fixed');
  await s.sync();
  expect((await engine.getPage('notes/c', { sourceId: s.id }))?.id).toBe(a.id);
  expect(await s.holds()).toEqual([]);

  const x = (await engine.getPage('notes/x', { sourceId: s.id }))!;
  git(s.root, 'mv', 'notes/x.md', 'notes/y.md'); s.write('notes/y.md', longBroken); commit(s.root, 'x to y broken');
  await s.sync();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE id=$1', [x.id]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  s.write('notes/y.md', long('Y')); commit(s.root, 'fix y');
  const result = await s.sync();
  expect(result.held?.[0]).toMatchObject({ path: 'notes/y.md', code: 'rename_held', reason: 'rename_source_changed' });
  expect((await engine.getPage('notes/x', { sourceId: s.id }))?.id).toBe(x.id);
}), 240_000);

test('the hold write and the cursor step past it commit together: a crash between them persists neither', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'notes/broken.md': FOLDED, 'notes/c.md': note('C') });
  const cursor = async () => (await engine.executeRaw<{ header: { runId: string; index: number; counts: { held?: number } } }>(
    "SELECT completed_keys->0 AS header FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [s.id]))[0]?.header;
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
  try { await s.sync().catch(error => error); }
  finally { delete (target as Partial<typeof target>).transaction; }
  expect(injected).toBe(1);
  expect(await s.holdRows()).toEqual([]);
  const stopped = await cursor();
  const [manifest] = await engine.executeRaw<{ entries: Array<{ path: string }> }>("SELECT completed_keys AS entries FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [stopped!.runId]);
  expect(manifest!.entries[stopped!.index]!.path).toBe('notes/broken.md');
  expect(stopped!.counts.held ?? 0).toBe(0);
  expect(await s.lastCommit()).toBeNull();

  // Without the crash the same cursor resumes: the hold and the step past it land together.
  const resumed = await s.sync();
  expect(resumed).toMatchObject({ status: 'first_sync', held_count: 1 });
  expect((await s.holds()).map(hold => hold.path)).toEqual(['notes/broken.md']);
  expect(await engine.getPage('notes/c', { sourceId: s.id })).not.toBeNull();
}), 180_000);

test('a cursor blocked by a pre-upgrade failed receipt converts in place: held when still broken, imported when now readable', () => each(async engine => {
  await engine.setConfig('sync.holds', 'fail');
  const s = await source(engine, { 'notes/broken.md': FOLDED, 'notes/roundup.md': AUTHOR, 'notes/ok.md': note('Ok') });
  expect((await s.sync()).status).toBe('blocked_by_failures');
  const [failed] = await engine.executeRaw<{ request_id: string }>("SELECT request_id::text AS request_id FROM persistence_requests WHERE source_id=$1 AND state='failed'", [s.id]);
  // The exact text an older release stored for this refusal.
  await engine.executeRaw("UPDATE persistence_requests SET error_code='invalid_params',error_message=$2 WHERE request_id=$1::uuid",
    [failed!.request_id, 'Invalid YAML frontmatter: bad indentation of a mapping entry (3:1)']);
  await engine.unsetConfig('sync.holds');
  const converted = await s.sync();
  expect(converted.converted_from_failed).toEqual([failed!.request_id]);
  expect(converted).toMatchObject({ status: 'first_sync', held_count: 1 });
  expect(converted.held?.[0]?.path).toBe('notes/broken.md');
  expect(await engine.getPage('notes/ok', { sourceId: s.id })).not.toBeNull();
  // sources status keeps the conversion as history after later runs.
  await s.sync();
  const status = (await readGitHoldStatuses(engine, [s.id])).get(s.id)!;
  expect(status.recent_conversions).toMatchObject([{ request_id: failed!.request_id, path: 'notes/broken.md', outcome: 'held' }]);
  expect(gitHoldStatusLines(s.id, status).join('\n')).toContain(`${failed!.request_id} (notes/broken.md): held`);

  // Already fixed: a working-tree cursor re-freezes the fixed bytes in place under a new request and imports them.
  await engine.setConfig('sync.holds', 'fail');
  const t = await source(engine, { 'notes/ok.md': note('Ok') });
  t.write('notes/draft.md', FOLDED);
  expect((await t.sync({ workingTree: true })).status).toBe('blocked_by_failures');
  const [draft] = await engine.executeRaw<{ request_id: string }>("SELECT request_id::text AS request_id FROM persistence_requests WHERE source_id=$1 AND state='failed'", [t.id]);
  await engine.unsetConfig('sync.holds');
  t.write('notes/draft.md', AUTHOR);
  const fixed = await t.sync({ workingTree: true });
  expect(fixed.converted_from_failed).toEqual([draft!.request_id]);
  expect(fixed.status).not.toBe('blocked_by_failures');
  expect((await engine.getPage('notes/draft', { sourceId: t.id }))?.title).toBe('Payments roundup');
  expect(await t.holds()).toEqual([]);
  // No hold remains, but the conversion still shows in sources status.
  expect((await readGitHoldStatuses(engine, [t.id])).get(t.id)).toMatchObject({ count: 0, items: [],
    recent_conversions: [{ request_id: draft!.request_id, path: 'notes/draft.md', outcome: 'refrozen' }] });
}), 240_000);

test('a flagless sync converts a --no-embed cursor with its stored options, and the loop guard mints no receipt per run', () => each(async engine => {
  await engine.setConfig('sync.holds', 'fail');
  const s = await source(engine, { 'notes/broken.md': FOLDED });
  expect((await s.sync({ noEmbed: true })).status).toBe('blocked_by_failures');
  await engine.unsetConfig('sync.holds');
  s.write('notes/broken.md', note('Fixed in the working tree only'));
  // Pinned bytes still refuse, so the entry is held; the stored --no-embed survives the flagless run.
  const converted = await performManagedSync(engine, { sourceId: s.id, noPull: true, explicitProcessing: [] });
  expect(converted.held_count).toBe(1);
  const [cursor] = await engine.executeRaw<{ completed_keys: Array<{ processingOptions: { noEmbed: boolean } }> }>(
    "SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [s.id]);
  expect(cursor!.completed_keys[0]!.processingOptions.noEmbed).toBe(true);
  const requests = await engine.executeRaw<{ intent: { processingOptions?: { noEmbed: boolean } } }>('SELECT intent FROM persistence_requests WHERE source_id=$1', [s.id]);
  expect(requests.every(row => !row.intent.processingOptions || row.intent.processingOptions.noEmbed === true)).toBe(true);

  // Loop guard: a stored content refusal the screen does not reproduce is re-frozen at most once for the same bytes.
  const t = await source(engine, { 'notes/z.md': note('Z') });
  await t.sync();
  t.write('notes/z.md', note('Z committed')); commit(t.root, 'change z');
  t.write('notes/z.md', note('Z newer uncommitted edit'));
  // #6340 holds this refusal when holds are on; `sync.holds=fail` leaves the blocked cursor the loop guard is about.
  await engine.setConfig('sync.holds', 'fail');
  try { expect((await t.sync()).status).toBe('blocked_by_failures'); } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
  await engine.executeRaw("UPDATE persistence_requests SET error_code='invalid_params',error_message='Invalid YAML frontmatter: bad indentation of a mapping entry (3:1)' WHERE source_id=$1 AND state IN ('failed','conflict')", [t.id]);
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,pending,converted}','true'::jsonb)
    WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1`, [t.id]);
  const receipts = async () => (await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [t.id])).length;
  const before = await receipts();
  for (let run = 0; run < 2; run++) expect((await t.sync()).status).toBe('blocked_by_failures');
  expect(await receipts()).toBe(before);
}), 240_000);

test('parser regression: stops only when provenance proves the same bytes imported validated; hold policy continues; no provenance holds normally', () => each(async engine => {
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
  await expect(s.sync()).rejects.toMatchObject({ code: 'sync_parser_regression' });
  expect(await s.lastCommit()).toBe(head);
  await engine.setConfig('sync.parser_regression', 'hold');
  const held = await s.sync({ retryFailed: true });
  expect(held.held?.[0]).toMatchObject({ path: 'notes/a.md', code: 'parser_regression' });
  expect(await s.lastCommit()).not.toBe(head);

  // A page without provenance (imported before validation) is held normally on a full walk, never a stop.
  await engine.unsetConfig('sync.parser_regression');
  const t = await source(engine, { 'notes/b.md': note('B') });
  await t.sync();
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2', [SYNC_IMPORT_PROVENANCE_OP, `${t.id}:%`]);
  t.write('notes/b.md', FOLDED); commit(t.root, 'break b');
  const full = await t.sync({ full: true });
  expect(full.held?.[0]).toMatchObject({ path: 'notes/b.md', code: 'invalid_frontmatter', stale: true });
}), 240_000);

test('escalation flags a source past its threshold; sync.holds=fail restores blocking; retry-held re-screens an unchanged hold', () => each(async engine => {
  await engine.setConfig('sync.hold_escalate_count', '1');
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
}), 240_000);

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
  const state = { action: 'merge_into' as const, reason: 'merge_recommended', canonical: 'notes/elsewhere', named: 'notes/elsewhere', model: 'anthropic:claude-opus-5-5', at: new Date().toISOString(), next_attempt_after: null };
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
