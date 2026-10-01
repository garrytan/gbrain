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
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

// #5522: a commit-driven cursor and a --working-tree cursor of one source use
// different cursor keys. When the working-tree run imports a file the sliced
// commit-driven run froze as new (pageId null), resuming the commit-driven run
// used to refuse with page_identity_changed on every run.

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
  const base = { sourceId: id, noPull: true, noEmbed: true, noExtract: true, explicitProcessing: [] };
  return { id, root, base, working: { ...base, workingTree: true } };
}
const imports = async (engine: BrainEngine, id: string) =>
  (await engine.executeRaw<{ slug: string }>("SELECT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence", [id])).map(r => r.slug);
const lastCommit = async (engine: BrainEngine, id: string) =>
  (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0].last_commit;

test('#5522 a commit-driven resume overtaken by a working-tree import of the same files completes without admitting them again', async () => each(async engine => {
  const f = await fixture(engine, ['a', 'b', 'c']);
  expect(await performManagedSync(engine, f.base, { maxPages: 1, maxMs: 60_000 })).toMatchObject({ status: 'partial', reason: 'writer_yield', filesImported: 1 });
  expect((await performManagedSync(engine, f.working)).status).toBe('first_sync');
  expect(await imports(engine, f.id)).toEqual(['a', 'b', 'c']);
  expect(await performManagedSync(engine, f.base)).toMatchObject({ status: 'first_sync', filesImported: 3 });
  expect(await imports(engine, f.id)).toEqual(['a', 'b', 'c']);
  expect(await lastCommit(engine, f.id)).toBe(git(f.root, 'rev-parse', 'HEAD'));
  expect((await performManagedSync(engine, f.base)).status).toBe('up_to_date');
}), 180_000);

test('#5522 a resume mixing files another cursor imported and files it did not commits its checkpoint', async () => each(async engine => {
  const f = await fixture(engine, ['a', 'b', 'c']);
  await performManagedSync(engine, f.base, { maxPages: 1, maxMs: 60_000 });
  // The working-tree run imports b and yields before c, so it never checkpoints.
  expect(await performManagedSync(engine, f.working, { maxPages: 2, maxMs: 60_000 })).toMatchObject({ status: 'partial', reason: 'writer_yield' });
  expect(await imports(engine, f.id)).toEqual(['a', 'b']);
  expect(await performManagedSync(engine, f.base)).toMatchObject({ status: 'first_sync', added: 2 });
  expect(await imports(engine, f.id)).toEqual(['a', 'b', 'c']);
  expect(await lastCommit(engine, f.id)).toBe(git(f.root, 'rev-parse', 'HEAD'));
}), 180_000);

test('#5522 a foreign write to the page at that origin still refuses the resume', async () => each(async engine => {
  const f = await fixture(engine, ['a', 'b', 'c']);
  await performManagedSync(engine, f.base, { maxPages: 1, maxMs: 60_000 });
  await performManagedSync(engine, f.working);
  await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.executeRaw(
    "UPDATE pages SET compiled_truth='A foreign edit after the working-tree import.',content_hash='foreign' WHERE source_id=$1 AND slug='b'", [f.id])));
  await expect(performManagedSync(engine, f.base)).rejects.toMatchObject({ code: 'page_identity_changed' });
  expect(await imports(engine, f.id)).toEqual(['a', 'b', 'c']);
  expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toBe('A foreign edit after the working-tree import.');
}), 180_000);

test('#5522 a page soft-deleted at that origin, or a pinned page deleted and recreated with the same text, is refused', async () => each(async engine => {
  const deleted = await fixture(engine, ['a', 'b']);
  await performManagedSync(engine, deleted.base, { maxPages: 1, maxMs: 60_000 });
  await performManagedSync(engine, deleted.working);
  await engine.transaction(tx => withCoordinatedWrite(tx, [deleted.id], () => tx.softDeletePage('b', { sourceId: deleted.id })));
  await expect(performManagedSync(engine, deleted.base)).rejects.toMatchObject({ code: 'page_identity_changed' });

  // An entry enumerated against an existing page keeps its pinned identity.
  const pinned = await fixture(engine, ['a', 'b']);
  await performManagedSync(engine, pinned.base);
  for (const name of ['a', 'b']) writeFileSync(join(pinned.root, `${name}.md`), `---\ntitle: ${name}\n---\nRevised observation ${name}.\n`);
  commit(pinned.root);
  await performManagedSync(engine, pinned.base, { maxPages: 1, maxMs: 60_000 });
  const before = await engine.getPage('b', { sourceId: pinned.id });
  await engine.transaction(tx => withCoordinatedWrite(tx, [pinned.id], () => tx.softDeletePage('b', { sourceId: pinned.id })));
  await performManagedSync(engine, pinned.working);
  const after = await engine.getPage('b', { sourceId: pinned.id });
  expect(after?.compiled_truth).toContain('Revised observation b');
  expect(after?.id !== before?.id || after?.updated_at !== before?.updated_at).toBe(true);
  await expect(performManagedSync(engine, pinned.base)).rejects.toMatchObject({ code: expect.stringMatching(/^(page_identity_changed|revision_conflict)$/) });
}), 180_000);
