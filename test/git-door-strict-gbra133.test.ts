/**
 * G2, the door of git-canonical memory (src/core/persistence/git-door.ts). On a strict source
 * (`sources.config.canonical = "git"`, default off) a page write is committed to Git before its database row:
 *   - the commit exists at the publication's before_commit seam, inside the transaction, and the receipt names it;
 *   - a publication interrupted after that commit (the before_commit seam, a dropped connection) keeps the committed
 *     file instead of restoring the prior bytes, and its replay completes the row against it: one commit, the one made
 *     before the interruption (forced probe);
 *   - interrupted before the commit (after_publication), recovery restores the prior bytes and the replay commits once;
 *   - the Git effect only pushes: the remote receives the publication's commit and no second commit is made;
 *   - a source without the flag behaves as before: nothing is committed before the row, and the effect commits later.
 * Runs on PGLite (publishMutation) and, with DATABASE_URL, on Postgres (a single write publishes as a group of one).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const putPage = operations.find(op => op.name === 'put_page')!;
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
const interruption = (code: string) => Object.assign(new Error(`database interruption ${code}`), { code });
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const put = (ctx: OperationContext, slug: string, content: string, requestId = randomUUID(), expectedRevision?: string) =>
  putPage.handler(ctx, { slug, content, request_id: requestId, wait_ms: 30_000, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) }) as Promise<Record<string, any>>;
const receipt = async (engine: BrainEngine, requestId: string) => (await engine.executeRaw<{ state: string; outcome: Record<string, any> | null }>(
  'SELECT state, outcome FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]!;
const commitsTouching = (root: string, rel: string) => git(root, 'log', '--format=%H', '--', rel).split('\n').filter(Boolean);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

for (const backend of testBackends()) describe(`[${backend}] G2: a strict source commits before its row`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => installFaultHook(undefined));

  test('the commit exists at before_commit, inside the transaction, and the receipt names it', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const requestId = randomUUID();
    const seen: { head?: string; blob?: string } = {};
    installFaultHook(async (point, detail) => {
      if (point !== 'publication:before_commit' || detail.requestId !== requestId) return;
      seen.head = git(root, 'rev-parse', 'HEAD').trim();
      seen.blob = git(root, 'show', 'HEAD:notes/door.md');
    });
    expect(await put(ctx, 'notes/door', page('Door', 'Committed before indexed.'), requestId)).toMatchObject({ state: 'committed' });
    expect(seen.blob).toContain('Committed before indexed.');
    const done = await receipt(engine, requestId);
    expect(done.state).toBe('committed');
    expect(done.outcome?.persistence).toMatchObject({ git_state: 'committed', git_commit: seen.head });
    expect(commitsTouching(root, 'notes/door.md')).toEqual([seen.head!]);
    expect(git(root, 'status', '--porcelain', '--', 'notes/door.md')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('interrupted after its commit (forced probe): the committed file is kept and the replay completes against it', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const first = await put(ctx, 'notes/kept', page('Kept', 'First revision.'));
    expect(first).toMatchObject({ state: 'committed' });
    const requestId = randomUUID();
    const at: { crash?: string; file?: string } = {};
    let thrown = 0;
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'publication:before_commit' && !thrown) { thrown++; at.crash = git(root, 'rev-parse', 'HEAD').trim(); throw interruption('CONNECTION_CLOSED'); }
      if (point === 'publication:prepared' && thrown && at.file === undefined) at.file = readFileSync(join(root, 'notes/kept.md'), 'utf8');
    });
    expect(await put(ctx, 'notes/kept', page('Kept', 'Second revision.'), requestId, first.revision)).toMatchObject({ state: 'committed' });
    expect(thrown).toBe(1);
    // The interrupted publication's own commit holds the second revision; recovery did not restore the first.
    expect(git(root, 'show', `${at.crash}:notes/kept.md`)).toContain('Second revision.');
    expect(at.file).toContain('Second revision.');
    expect(commitsTouching(root, 'notes/kept.md')[0]).toBe(at.crash!);
    expect(commitsTouching(root, 'notes/kept.md')).toHaveLength(2);
    expect(git(root, 'status', '--porcelain', '--', 'notes/kept.md')).toBe('');
    const done = await receipt(engine, requestId);
    expect(done.outcome?.persistence).toMatchObject({ git_commit: at.crash });
    const [row] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE source_id='default' AND slug='notes/kept'");
    expect(row!.compiled_truth).toContain('Second revision.');
  }, { databaseUrl, setup }), 120_000);

  test('a removal interrupted after its commit is kept, and its replay deletes the row', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const first = await put(ctx, 'notes/removed', page('Removed', 'Soon gone.'));
    expect(first).toMatchObject({ state: 'committed' });
    const requestId = randomUUID();
    let crash = '';
    installFaultHook(async (point, detail) => {
      if (point === 'publication:before_commit' && detail.requestId === requestId && !crash) { crash = git(root, 'rev-parse', 'HEAD').trim(); throw interruption('CONNECTION_CLOSED'); }
    });
    const deletePage = operations.find(op => op.name === 'delete_page')!;
    expect(await deletePage.handler(ctx, { slug: 'notes/removed', request_id: requestId, expected_revision: first.revision, wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
    expect(crash).not.toBe('');
    expect(commitsTouching(root, 'notes/removed.md')[0]).toBe(crash);
    expect(existsSync(join(root, 'notes/removed.md'))).toBe(false);
    const [row] = await engine.executeRaw<{ deleted: boolean }>("SELECT deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id='default' AND slug='notes/removed'");
    expect(row?.deleted).toBe(true);
  }, { databaseUrl, setup }), 120_000);

  test('interrupted before its commit: the prior bytes are restored and the replay commits once', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const first = await put(ctx, 'notes/restored', page('Restored', 'First revision.'));
    expect(first).toMatchObject({ state: 'committed' });
    const requestId = randomUUID();
    let thrown = 0, file = '';
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'publication:after_publication' && !thrown) { thrown++; throw interruption('CONNECTION_CLOSED'); }
      if (point === 'publication:prepared' && thrown && !file) file = readFileSync(join(root, 'notes/restored.md'), 'utf8');
    });
    expect(await put(ctx, 'notes/restored', page('Restored', 'Second revision.'), requestId, first.revision)).toMatchObject({ state: 'committed' });
    expect(thrown).toBe(1);
    expect(file).toContain('First revision.');
    expect(commitsTouching(root, 'notes/restored.md')).toHaveLength(2);
    expect(git(root, 'show', 'HEAD:notes/restored.md')).toContain('Second revision.');
  }, { databaseUrl, setup }), 120_000);

  test('the Git effect only pushes: the remote gets the publication\'s commit and no second commit is made', () => managedBrain(async ({ engine, ctx, root }) => {
    const remote = join(root, '..', 'remote.git');
    git(root, 'init', '-q', '--bare', remote);
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-q', '-u', 'origin', 'HEAD');
    await strict(engine);
    const requestId = randomUUID();
    expect(await put(ctx, 'notes/pushed', page('Pushed', 'Pushed by the effect.'), requestId)).toMatchObject({ state: 'committed' });
    const head = git(root, 'rev-parse', 'HEAD').trim();
    await settleManagedGitEffects(engine);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(git(remote, 'rev-parse', 'HEAD').trim()).toBe(head);
    const [effect] = await engine.executeRaw<{ state: string; data: Record<string, unknown> }>(
      "SELECT e.state, e.data FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.request_id=$1::uuid AND e.kind='git'", [requestId]);
    expect(effect).toMatchObject({ state: 'committed', data: { push_only: true } });
  }, { databaseUrl, setup }), 120_000);

  test('put_pages: every member is committed before its row; a group shares one commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const putPages = operations.find(op => op.name === 'put_pages')!;
    const slugs = ['notes/g1', 'notes/g2', 'notes/g3', 'notes/g4'];
    const batch = await putPages.handler(ctx, { request_id: randomUUID(), wait_ms: 30_000, pages: slugs.map(slug => ({ slug, content: page(slug, `Body of ${slug}.`) })) }) as Record<string, any>;
    expect(batch).toMatchObject({ state: 'committed', counts: { committed: slugs.length, failed: 0 } });
    const rows = await engine.executeRaw<{ slug: string; state: string; outcome: Record<string, any> }>(
      "SELECT slug, state, outcome FROM persistence_requests WHERE source_id='default' AND slug = ANY($1::text[]) ORDER BY slug", [slugs]);
    expect(rows.map(row => row.state)).toEqual(slugs.map(() => 'committed'));
    for (const row of rows) expect(git(root, 'show', `${row.outcome.persistence.git_commit}:${row.slug}.md`)).toContain(`Body of ${row.slug}.`);
    const commits = new Set(rows.map(row => row.outcome.persistence.git_commit));
    // Postgres publishes the batch as groups (group-publish.ts): fewer commits than pages; PGLite publishes one at a time.
    if (backend === 'postgres') expect(commits.size).toBeLessThan(slugs.length);
    expect(git(root, 'log', '--format=%H', '--', ...slugs.map(slug => `${slug}.md`)).split('\n').filter(Boolean).sort()).toEqual([...commits].sort());
  }, { databaseUrl, setup }), 120_000);

  test('a path Git would refuse is never written or committed: G7a declares it git_ignored (database-only, no Git effect)', () => managedBrain(async ({ engine, ctx, root }) => {
    writeFileSync(join(root, '.gitignore'), 'notes/ignored.md\n');
    git(root, 'commit', '-qam', 'ignore one path');
    await strict(engine);
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const requestId = randomUUID();
    expect(await put(ctx, 'notes/ignored', page('Ignored', 'Never in Git.'), requestId)).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'notes/ignored.md'))).toBe(false);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(await engine.executeRaw("SELECT database_only_reason FROM pages WHERE source_id='default' AND slug='notes/ignored' AND deleted_at IS NULL")).toEqual([{ database_only_reason: 'git_ignored' }]);
    expect(await engine.executeRaw("SELECT 1 FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.request_id=$1::uuid AND e.kind='git'", [requestId])).toHaveLength(0);
  }, { databaseUrl, setup }), 120_000);

  test('without the flag nothing is committed before the row; the effect commits it later', () => managedBrain(async ({ engine, ctx, root }) => {
    const requestId = randomUUID();
    let blob: string | null = 'unread';
    const initial = git(root, 'rev-parse', 'HEAD').trim();
    installFaultHook(async (point, detail) => {
      if (point !== 'publication:before_commit' || detail.requestId !== requestId) return;
      blob = git(root, 'rev-parse', 'HEAD').trim() === initial ? null : 'moved';
    });
    expect(await put(ctx, 'notes/classic', page('Classic', 'Committed by the effect.'), requestId)).toMatchObject({ state: 'committed' });
    expect(blob).toBeNull();
    const done = await receipt(engine, requestId);
    expect(done.outcome?.persistence?.git_commit).toBeUndefined();
    expect(done.outcome?.persistence?.git_state).toBe('queued');
    await settleManagedGitEffects(engine);
    expect(commitsTouching(root, 'notes/classic.md')).toHaveLength(1);
  }, { databaseUrl, setup }), 120_000);
});
