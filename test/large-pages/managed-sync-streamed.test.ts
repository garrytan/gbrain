/**
 * Wave B managed sync of a Markdown file over the single-string ceiling.
 *
 * 1. Protects: with `pages.segmented_storage` on, `performManagedSync` freezes
 *    a committed file over PAGE_MAX_BYTES by reference (`body_ref`: its
 *    sha256, size and pinned blob; no content in the journal) and its owner
 *    streams it into a segmented page that round-trips byte-identical, with
 *    the canonical file untouched; on a source at a repository subdirectory
 *    (git-root slugs), on an edit, on a full walk and on a rename. A file the
 *    streamed path refuses (a facts fence) is held `file_too_large` and the
 *    run checkpoints, as before. A dry run lists the file as screened only by
 *    its owner (`page_body_segmented`), not as a hold. With the switch off the
 *    hold is unchanged. The crash window: managed-sync-streamed-crash.test.ts.
 * 2. Fails when: managed sync holds such a file, the journal carries its body,
 *    a rename leaves the page at its old slug, or a streamed refusal blocks
 *    the run instead of holding the file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { reconstructedPage } from '../helpers/segmented-page-checks.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-streamed-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const huge = conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 71 });

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

/** A managed source over a Git repository; `scope` puts the source at a subdirectory of it, pinned to git-root slugs (origins include the scope). */
async function fixture(engine: BrainEngine, files: Record<string, string>, scope = '') {
  await disposePersistenceConsumer(engine);
  const sourceId = `streamed-sync-${randomUUID().slice(0, 8)}`;
  const repo = join(home, sourceId), root = join(repo, scope);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(repo, 'init', '-q');
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
  commit(repo);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [sourceId, root, JSON.stringify(scope ? { slug_root_mode: 'git-root' } : {})]);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, repo, root };
}

/** One managed sync to a settled result: a streamed page outlasts a pass's bounded wait (`partial` / `writer_pending`), as the drain's next pass picks it up. */
async function sync(engine: BrainEngine, opts: { sourceId: string; full?: boolean; workingTree?: boolean }) {
  for (let pass = 0; ; pass++) {
    const result = await performManagedSync(engine, { ...opts, noPull: true, noEmbed: true });
    if (result.status !== 'partial' || result.reason !== 'writer_pending' || pass === 30) return result;
  }
}

async function syncRequest(engine: BrainEngine, sourceId: string, slug: string) {
  const [row] = await engine.executeRaw<{ intent_bytes: string; intent: Record<string, unknown>; state: string }>(
    `SELECT intent_bytes::text AS intent_bytes, intent, state FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_sync_import'
      ORDER BY sequence DESC LIMIT 1`, [sourceId, slug]);
  return row;
}

async function expectStreamed(engine: BrainEngine, sourceId: string, slug: string, content: string, path: string) {
  const parsed = parseMarkdown(content, path);
  const { page, body, hash } = await reconstructedPage(engine, slug, sourceId);
  expect(page.body_storage).toBe('segmented');
  expect(body.compiled_truth).toBe(parsed.compiled_truth);
  expect(body.timeline).toBe(parsed.timeline);
  expect(page.content_hash).toBe(hash);
  expect(page.text_projection_revision).toBe(page.knowledge_revision);
  const request = (await syncRequest(engine, sourceId, slug))!;
  expect(request.state).toBe('committed');
  expect(Number(request.intent_bytes)).toBeLessThan(16 * 1024);
  expect(request.intent.content).toBeNull();
  expect(request.intent.body_ref).toMatchObject({ sha256: sha256(Buffer.from(content)), bytes: Buffer.byteLength(content) });
  expect(await engine.executeRaw(`SELECT 1 FROM page_body_stagings WHERE page_id=$1 AND state IN ('open','prepared')`, [page.id])).toEqual([]);
  return page;
}

describe('managed sync over the single-string ceiling', () => {
  test('switch on: a committed file streams in by reference, then an edit, a full walk and a rename follow it', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await engine.setConfig('pages.segmented_storage', 'on');
      const f = await fixture(engine, { 'notes/huge.md': huge, 'notes/small.md': '---\ntitle: Small\n---\nA small note.\n' });
      const file = join(f.root, 'notes/huge.md');
      const before = statSync(file);
      const preview = await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, dryRun: true });
      expect(preview.would_hold).toBeUndefined();
      expect(preview.screen_skipped).toEqual([{ path: 'notes/huge.md', code: 'page_body_segmented' }]);
      expect(await sync(engine, { sourceId: f.sourceId })).toMatchObject({ status: 'first_sync', filesImported: 2 });
      await expectStreamed(engine, f.sourceId, 'notes/huge', huge, 'notes/huge.md');
      expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
      expect(sha256(readFileSync(file))).toBe(sha256(Buffer.from(huge)));
      expect((await readGitSourceHolds(engine, { sourceIds: [f.sourceId] }))[0]?.holds ?? []).toEqual([]);

      const edited = `${huge.trimEnd()}\n\n**alice-example**: a closing streamed remark.\n`;
      writeFileSync(file, edited);
      commit(f.repo);
      expect(await sync(engine, { sourceId: f.sourceId })).toMatchObject({ status: 'synced' });
      const updated = await expectStreamed(engine, f.sourceId, 'notes/huge', edited, 'notes/huge.md');
      expect((await sync(engine, { sourceId: f.sourceId, full: true })).status).not.toBe('failed');
      expect((await reconstructedPage(engine, 'notes/huge', f.sourceId)).page.body_generation).toBe(updated.body_generation);

      git(f.repo, 'mv', 'notes/huge.md', 'notes/moved.md');
      commit(f.repo);
      expect(await sync(engine, { sourceId: f.sourceId })).toMatchObject({ status: 'synced', renamed: 1 });
      const moved = await expectStreamed(engine, f.sourceId, 'notes/moved', edited, 'notes/moved.md');
      expect(moved.id).toBe(updated.id);
      expect(await engine.getPage('notes/huge', { sourceId: f.sourceId })).toBeNull();
      const [origin] = await engine.executeRaw<{ source_path: string }>('SELECT source_path FROM pages WHERE id=$1', [moved.id]);
      expect(origin!.source_path).toBe('notes/moved.md');

      git(f.repo, 'mv', 'notes/moved.md', 'notes/again.md');
      const renamedEdit = `${edited.trimEnd()}\n\n**bob-example**: one more remark after the move.\n`;
      writeFileSync(join(f.root, 'notes/again.md'), renamedEdit);
      commit(f.repo);
      expect(await sync(engine, { sourceId: f.sourceId })).toMatchObject({ status: 'synced', renamed: 1 });
      const again = await expectStreamed(engine, f.sourceId, 'notes/again', renamedEdit, 'notes/again.md');
      expect(again.id).toBe(updated.id);
      expect(again.body_generation).toBe(moved.body_generation + 1);
      expect(await engine.getPage('notes/moved', { sourceId: f.sourceId })).toBeNull();
      await disposePersistenceConsumer(engine);
    }
  }), 900_000);

  test('a source at a repository subdirectory streams with git-root slugs', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await engine.setConfig('pages.segmented_storage', 'on');
      const f = await fixture(engine, { 'notes/huge.md': huge }, 'brain');
      expect(await sync(engine, { sourceId: f.sourceId })).toMatchObject({ status: 'first_sync', filesImported: 1 });
      const page = await expectStreamed(engine, f.sourceId, 'brain/notes/huge', huge, 'brain/notes/huge.md');
      expect((await engine.executeRaw<{ source_path: string }>('SELECT source_path FROM pages WHERE id=$1', [page.id]))[0]!.source_path).toBe('brain/notes/huge.md');
      await disposePersistenceConsumer(engine);
    }
  }), 600_000);

  test('an uncommitted file synced from the working tree streams by reference', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await engine.setConfig('pages.segmented_storage', 'on');
      const f = await fixture(engine, { 'notes/small.md': '---\ntitle: Small\n---\nA small note.\n' });
      writeFileSync(join(f.root, 'notes/huge.md'), huge);
      expect((await sync(engine, { sourceId: f.sourceId, workingTree: true })).status).not.toBe('failed');
      await expectStreamed(engine, f.sourceId, 'notes/huge', huge, 'notes/huge.md');
      expect((await syncRequest(engine, f.sourceId, 'notes/huge'))!.intent.body_ref).toMatchObject({ kind: 'input_file' });
      await disposePersistenceConsumer(engine);
    }
  }), 600_000);

  test('a file the streamed path refuses (a facts fence) is held file_too_large and the run checkpoints', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await engine.setConfig('pages.segmented_storage', 'on');
      const fenced = `${huge.trimEnd()}\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Example fact | fact | 1.0 | world | high | | | test | |\n<!--- gbrain:facts:end -->\n`;
      const f = await fixture(engine, { 'notes/fenced.md': fenced, 'notes/small.md': '---\ntitle: Small\n---\nA small note.\n' });
      const result = await sync(engine, { sourceId: f.sourceId });
      expect(result.status).toBe('first_sync');
      const holds = (await readGitSourceHolds(engine, { sourceIds: [f.sourceId] }))[0]?.holds ?? [];
      expect(holds.map(hold => [hold.path, hold.code])).toEqual([['notes/fenced.md', 'file_too_large']]);
      expect(holds[0]!.message).toContain('facts and takes fences');
      expect(await engine.getPage('notes/fenced', { sourceId: f.sourceId })).toBeNull();
      expect(await engine.getPage('notes/small', { sourceId: f.sourceId })).not.toBeNull();
      await disposePersistenceConsumer(engine);
    }
  }), 600_000);

  test('switch off: the file is held by its size, as before', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await engine.setConfig('pages.segmented_storage', 'off');
      const f = await fixture(engine, { 'notes/huge.md': huge });
      expect((await sync(engine, { sourceId: f.sourceId })).status).toBe('first_sync');
      const holds = (await readGitSourceHolds(engine, { sourceIds: [f.sourceId] }))[0]?.holds ?? [];
      expect(holds.map(hold => [hold.path, hold.code])).toEqual([['notes/huge.md', 'file_too_large']]);
      expect(await syncRequest(engine, f.sourceId, 'notes/huge')).toBeUndefined();
      await disposePersistenceConsumer(engine);
    }
  }), 600_000);
});
