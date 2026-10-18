/**
 * Managed sync rename of a segmented page (Wave B).
 *
 * 1. Protects: a rename prepares the file where the page stands and, inside
 *    the publication, again at its new slug. With unchanged inputs the second
 *    preparation publishes the first one's staging (one staging per rename,
 *    nothing staged inside the publication); when the move changes them (here
 *    a title humanized from the slug), the first staging is aborted and the applied preparation's
 *    afterCommit sweeps its rows. Either way the rename leaves no live staging
 *    and no staged manifest rows behind, and the page is sealed and
 *    round-trips byte-identical at its new slug.
 * 2. Fails when: the publication restages an unchanged body, the prepare-time
 *    staging stays open or prepared after the rename publishes, or afterCommit
 *    runs the import that did not publish.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { reconstructedPage } from '../helpers/segmented-page-checks.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-rename-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
/** #6729: the frontmatter id confirms the edited renames below (an inexact pair whose title changes keeps its identity only on a shared id). */
const original = conversationPage(1536 * 1024, { seed: 61 }).replace('title: Conversation log\n', 'id: conversation-log-6729\ntitle: Conversation log\n');
/** Every fourth body line edited: git still pairs the files as a rename, and most segments change. */
const edited = (text: string) => text.split('\n').map((line, i) => i > 6 && i % 4 === 0 && line ? `${line} edited` : line).join('\n');

function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string): void { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'test content'); }

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

async function syncedFixture(engine: BrainEngine) {
  const sourceId = `rename-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'notes/big.md'), original);
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect(await performManagedSync(engine, { sourceId, noPull: true })).toMatchObject({ status: 'first_sync', filesImported: 1 });
  return { sourceId, root };
}

async function stagings(engine: BrainEngine, sourceId: string) {
  return engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE source_id=$1', [sourceId]);
}

async function expectRenamed(engine: BrainEngine, sourceId: string, content: string) {
  const { page, body, hash } = await reconstructedPage(engine, 'notes/moved', sourceId);
  const parsed = parseMarkdown(content, 'notes/moved.md');
  expect(page.body_storage).toBe('segmented');
  expect(page.title).toBe(parsed.title);
  expect(body.compiled_truth).toBe(parsed.compiled_truth);
  expect(page.content_hash).toBe(hash);
  expect(page.text_projection_revision).toBe(page.knowledge_revision);
  expect(await engine.getPage('notes/big', { sourceId })).toBeNull();
  expect((await stagings(engine, sourceId)).filter(row => row.state === 'open' || row.state === 'prepared')).toEqual([]);
  expect(await engine.executeRaw('SELECT occurrence_id FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NOT NULL', [page.id])).toEqual([]);
}

test('an edited rename with unchanged identity publishes its prepare-time staging and stages once', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('pages.flip_retire_max_rows', '1');
    const f = await syncedFixture(engine);
    const before = (await stagings(engine, f.sourceId)).length;
    git(f.root, 'mv', 'notes/big.md', 'notes/moved.md');
    const content = edited(original);
    writeFileSync(join(f.root, 'notes/moved.md'), content);
    commit(f.root);
    expect(await performManagedSync(engine, { sourceId: f.sourceId, noPull: true })).toMatchObject({ status: 'synced', renamed: 1 });
    expect((await stagings(engine, f.sourceId)).length).toBe(before + 1);
    await expectRenamed(engine, f.sourceId, content);
    await disposePersistenceConsumer(engine);
  }
}), 300_000);

test('a rename whose title follows the slug aborts the prepare-time staging and sweeps its rows after commit', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('pages.flip_retire_max_rows', '1');
    const f = await syncedFixture(engine);
    git(f.root, 'mv', 'notes/big.md', 'notes/moved.md');
    const content = edited(original).replace('title: Conversation log\n', '');
    writeFileSync(join(f.root, 'notes/moved.md'), content);
    commit(f.root);
    expect(await performManagedSync(engine, { sourceId: f.sourceId, noPull: true })).toMatchObject({ status: 'synced', renamed: 1 });
    expect((await stagings(engine, f.sourceId)).map(row => row.state)).toContain('aborted');
    await expectRenamed(engine, f.sourceId, content);
    await disposePersistenceConsumer(engine);
  }
}), 300_000);
