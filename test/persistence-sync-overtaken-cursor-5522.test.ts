import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { __setManagedCursorKeyForTests } from '../src/core/persistence/sync-cursor-key.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';

// #5522: a commit-driven cursor and a --working-tree cursor of one source used
// different cursor keys. When the working-tree run imports a file the sliced
// commit-driven run froze as new (pageId null), resuming the commit-driven run
// used to refuse with page_identity_changed on every run.
//
// #6712 PR 1: a source has one cursor key, so a working-tree run resumes the commit
// cursor instead of overtaking it. Two such cursors now exist only when an older
// gbrain left them; these tests create them under older keys (`legacy`) and resume
// with the current key, which adopts the commit cursor (made the newest) in place
// and supersedes the finished or idle working-tree one. The #5522 invariants hold
// for the adopted cursor.

const home = mkdtempSync(join(tmpdir(), 'gbrain-5522-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); };
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const park = (engine: BrainEngine, key: string, op: string) =>
  engine.executeRaw("UPDATE op_checkpoints SET op=$2 WHERE fingerprint=$1 AND op IN ('managed-sync','managed-sync-parked')", [key, op]);
/**
 * Runs `fn` as an older gbrain whose cursor key for this source is `key`. An older gbrain never saw the other old-key
 * cursor (`hide`), so it is parked meanwhile: the current resolver would adopt it.
 */
async function legacy<T>(engine: BrainEngine, key: string, fn: () => Promise<T>, hide?: string): Promise<T> {
  __setManagedCursorKeyForTests(() => key);
  if (hide) await park(engine, hide, 'managed-sync-parked');
  try { return await fn(); } finally {
    __setManagedCursorKeyForTests(null);
    if (hide) await park(engine, hide, 'managed-sync');
  }
}
/** Makes the commit-driven cursor the newest unfinished one, so the current key adopts it. */
const ageWorking = (engine: BrainEngine, id: string) =>
  engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '1 hour' WHERE op='managed-sync' AND fingerprint=$1", [`${id}-working`]);
const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv(env, async () => { for (const engine of engines) await fn(engine); });

async function fixture(engine: BrainEngine, names: string[]) {
  const id = `s-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of names) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nObservation ${name} for the sliced run.\n`);
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const base = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
  return { id, root, base, working: { ...base, workingTree: true } };
}
const imports = async (engine: BrainEngine, id: string) =>
  (await engine.executeRaw<{ slug: string }>("SELECT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence", [id])).map(r => r.slug);
const lastCommit = async (engine: BrainEngine, id: string) =>
  (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0].last_commit;

test('#5522 a commit-driven resume overtaken by a working-tree import of the same files completes without admitting them again', async () => each(async engine => {
  const f = await fixture(engine, ['a', 'b', 'c']);
  expect(await legacy(engine, `${f.id}-commit`, () => performManagedSync(engine, f.base, { maxPages: 1, maxMs: 60_000 }))).toMatchObject({ status: 'partial', reason: 'writer_yield', filesImported: 1 });
  expect((await legacy(engine, `${f.id}-working`, () => performManagedSync(engine, f.working), `${f.id}-commit`)).status).toBe('first_sync');
  expect(await imports(engine, f.id)).toEqual(['a', 'b', 'c']);
  expect(await performManagedSync(engine, f.base)).toMatchObject({ status: 'first_sync', filesImported: 3, cursorFanIn: { adopted: true } });
  expect(await imports(engine, f.id)).toEqual(['a', 'b', 'c']);
  expect(await lastCommit(engine, f.id)).toBe(git(f.root, 'rev-parse', 'HEAD'));
  expect((await performManagedSync(engine, f.base)).status).toBe('up_to_date');
}), 180_000);

test('#5522 a resume mixing files another cursor imported and files it did not commits its checkpoint', async () => each(async engine => {
  const f = await fixture(engine, ['a', 'b', 'c']);
  await legacy(engine, `${f.id}-commit`, () => performManagedSync(engine, f.base, { maxPages: 1, maxMs: 60_000 }));
  // The working-tree run imports b and yields before c, so it never checkpoints.
  expect(await legacy(engine, `${f.id}-working`, () => performManagedSync(engine, f.working, { maxPages: 2, maxMs: 60_000 }), `${f.id}-commit`)).toMatchObject({ status: 'partial', reason: 'writer_yield' });
  expect(await imports(engine, f.id)).toEqual(['a', 'b']);
  await ageWorking(engine, f.id);
  expect(await performManagedSync(engine, f.base)).toMatchObject({ status: 'first_sync', added: 2, cursorFanIn: { adopted: true, superseded: 1 } });
  expect(await imports(engine, f.id)).toEqual(['a', 'b', 'c']);
  expect(await lastCommit(engine, f.id)).toBe(git(f.root, 'rev-parse', 'HEAD'));
}), 180_000);

// #6340: the refusals below are holds now (`concurrent_write`); the invariant they protect, that the foreign write is never overwritten, is unchanged.
test('#5522 a foreign write to the page at that origin holds the entry on resume and is never overwritten', async () => each(async engine => {
  const f = await fixture(engine, ['a', 'b', 'c']);
  await legacy(engine, `${f.id}-commit`, () => performManagedSync(engine, f.base, { maxPages: 1, maxMs: 60_000 }));
  await legacy(engine, `${f.id}-working`, () => performManagedSync(engine, f.working), `${f.id}-commit`);
  await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.executeRaw(
    "UPDATE pages SET compiled_truth='A foreign edit after the working-tree import.',content_hash='foreign' WHERE source_id=$1 AND slug='b'", [f.id]), TEST_WRITE_ATTRIBUTION));
  const resumed = await performManagedSync(engine, f.base);
  expect(resumed.status).not.toBe('blocked_by_failures');
  expect(resumed.held?.map(hold => [hold.path, hold.code])).toEqual([['b.md', 'concurrent_write']]);
  expect(await imports(engine, f.id)).toEqual(['a', 'b', 'c']);
  expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toBe('A foreign edit after the working-tree import.');
}), 180_000);

test('#5522 a page soft-deleted at that origin, or a pinned page deleted and recreated with the same text, is held', async () => each(async engine => {
  const deleted = await fixture(engine, ['a', 'b']);
  await legacy(engine, `${deleted.id}-commit`, () => performManagedSync(engine, deleted.base, { maxPages: 1, maxMs: 60_000 }));
  await legacy(engine, `${deleted.id}-working`, () => performManagedSync(engine, deleted.working), `${deleted.id}-commit`);
  await engine.transaction(tx => withCoordinatedWrite(tx, [deleted.id], () => tx.softDeletePage('b', { sourceId: deleted.id }), TEST_WRITE_ATTRIBUTION));
  const held = await performManagedSync(engine, deleted.base);
  expect(held.status).not.toBe('blocked_by_failures');
  expect(held.held?.map(hold => [hold.path, hold.code])).toEqual([['b.md', 'concurrent_write']]);
  expect(await engine.getPage('b', { sourceId: deleted.id })).toBeNull();

  // An entry enumerated against an existing page keeps its pinned identity.
  const pinned = await fixture(engine, ['a', 'b']);
  await performManagedSync(engine, pinned.base);
  for (const name of ['a', 'b']) writeFileSync(join(pinned.root, `${name}.md`), `---\ntitle: ${name}\n---\nRevised observation ${name}.\n`);
  commit(pinned.root);
  await legacy(engine, `${pinned.id}-commit`, () => performManagedSync(engine, pinned.base, { maxPages: 1, maxMs: 60_000 }));
  const before = await engine.getPage('b', { sourceId: pinned.id });
  await engine.transaction(tx => withCoordinatedWrite(tx, [pinned.id], () => tx.softDeletePage('b', { sourceId: pinned.id }), TEST_WRITE_ATTRIBUTION));
  // The older gbrain recorded no import provenance, so its working-tree run recreates the page (#6712 holds it when a record
  // shows the database side moved).
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'page_id'=$2", [SYNC_IMPORT_PROVENANCE_OP, String(before!.id)]);
  await legacy(engine, `${pinned.id}-working`, () => performManagedSync(engine, pinned.working), `${pinned.id}-commit`);
  const after = await engine.getPage('b', { sourceId: pinned.id });
  expect(after?.compiled_truth).toContain('Revised observation b');
  expect(after?.id !== before?.id || after?.updated_at !== before?.updated_at).toBe(true);
  // The recreated page holds exactly what the pinned entry would import: it is re-bound and passed, nothing is rewritten,
  // and the checkpoint accepts the target the working-tree run already reached.
  const resumed = await performManagedSync(engine, pinned.base);
  expect(resumed).toMatchObject({ status: 'synced', waived: { imports: 1, deletes: 0 } });
  expect(resumed.held ?? []).toEqual([]);
  expect((await engine.getPage('b', { sourceId: pinned.id }))?.updated_at).toEqual(after?.updated_at);
}), 180_000);
