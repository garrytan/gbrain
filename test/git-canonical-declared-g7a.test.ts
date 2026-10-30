/**
 * G7a, declared database-only classes of a git-canonical source (src/core/persistence/git-declared.ts). On a strict
 * source (`sources.config.canonical = "git"`, default off):
 *   - a private or alias-private page, a page under a `storage.db_only` dir and a path Git ignores are declared: no
 *     file, no door commit, no Git effect, and the row carries its class;
 *   - a page turning private is the one exception to "no private bytes in Git": the door commits the removal of its file
 *     (also when only HEAD still has it, Q7), and a later `sync --no-pull` keeps the page live and private (Q8);
 *   - the private-commit backstop (forced probe): a publication whose page became lineage-private after it was prepared
 *     is refused `git_private_commit_refused` with no commit and HEAD unchanged, a single put and a group alike;
 *   - a file under a Git LFS rule commits only with `storage.git_lfs` and an LFS-configured checkout, as an LFS pointer;
 *   - rows of a strict source take the managed writer guard's git fence (`git_protocol_required`) unless the writer
 *     declares the protocol, and a writer with no file form refuses (`assertStrictGitHome`);
 *   - the same writes on a source without the flag behave as before.
 * Runs on PGLite (publishMutation) and, with DATABASE_URL, on Postgres (publishGroup).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { createHash } from 'node:crypto';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importManagedFile } from '../src/core/persistence/import-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { assertStrictGitHome } from '../src/core/persistence/git-declared.ts';
import { preparePrivateTransition } from '../src/core/persistence/page-prepare.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const putPage = operations.find(op => op.name === 'put_page')!;
const putPages = operations.find(op => op.name === 'put_pages')!;
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) => operations.find(op => op.name === name)!.handler(ctx, params) as Promise<Record<string, any>>;
const stateOf = (result: Record<string, any>) => result.state ?? result.receipt?.state;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const page = (title: string, body: string, extra = '') => `---\ntype: note\ntitle: ${title}\n${extra}---\n\n${body}\n`;
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const put = (ctx: OperationContext, slug: string, content: string, requestId = randomUUID(), expectedRevision?: string) =>
  putPage.handler(ctx, { slug, content, request_id: requestId, wait_ms: 30_000, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) }) as Promise<Record<string, any>>;
const outcome = (promise: Promise<unknown>) => promise.then(value => value as Record<string, any>, (error: { code?: string; message?: string }) => ({ thrown: error.code, message: error.message }));
const head = (root: string) => git(root, 'rev-parse', 'HEAD').trim();
const atHead = (root: string, rel: string) => git(root, 'ls-tree', '--name-only', 'HEAD', '--', rel).trim();
const row = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ live: boolean; reason: string | null; source_path: string | null; visibility: string | null }>(
  `SELECT deleted_at IS NULL AS live, database_only_reason AS reason, source_path, frontmatter->>'visibility' AS visibility FROM pages WHERE source_id='default' AND slug=$1`, [slug]))[0] ?? null;
const gitEffects = async (engine: BrainEngine, requestId: string) => (await engine.executeRaw(
  "SELECT 1 FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.request_id=$1::uuid AND e.kind='git'", [requestId])).length;
const makePrivate = (engine: BrainEngine, slug: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'],
  () => tx.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"visibility":"private"}'::jsonb WHERE source_id='default' AND slug=$1`, [slug]), TEST_WRITE_ATTRIBUTION));
const setup = ({ root }: { root: string }) => {
  writeFileSync(join(root, '.gitignore'), 'archive/\n');
  writeFileSync(join(root, '.gitattributes'), 'lfs/** filter=lfs diff=lfs merge=lfs -text\n');
  durableGitRepo(root, ['.gitignore', '.gitattributes']);
};
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };

for (const backend of testBackends()) describe(`[${backend}] G7a: declared database-only classes of a strict source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => installFaultHook(undefined));

  test('declared classes publish database-only: no file, no commit, no Git effect, the row carries its class', () => managedBrain(async ({ engine, ctx, root }) => {
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - cache/\n');
    mkdirSync(join(root, 'cache'));
    git(root, 'add', 'gbrain.yml'); git(root, 'commit', '-qm', 'db_only');
    await strict(engine);
    const before = head(root);
    const cases: Array<[string, string, string | null]> = [
      ['notes/secret', page('Secret', 'Private.', 'visibility: private\n'), 'private'],
      ['notes/from-secret', page('From secret', 'Lineage-private.', 'derived_from: notes/secret\n'), 'lineage_private'],
      ['notes/aliased', page('Aliased', 'Alias-private.', 'visibility: world\naccess: confidential\n'), 'alias_private'],
      ['archive/scan', page('Scan', 'Ignored path.'), 'git_ignored'],
      ['cache/derived', page('Cached', 'Under a db_only dir.'), null],
    ];
    for (const [slug, content, reason] of cases) {
      const requestId = randomUUID();
      expect(await put(ctx, slug, content, requestId)).toMatchObject({ state: 'committed' });
      expect(existsSync(join(root, `${slug}.md`))).toBe(false);
      expect(await gitEffects(engine, requestId)).toBe(0);
      expect(await row(engine, slug)).toMatchObject({ live: true, reason, source_path: null });
    }
    expect(head(root)).toBe(before);
  }, { databaseUrl, setup }), 120_000);

test('Q3: every strict writer is classified when it prepares; a managed import, which builds its own file target, is refused at publication', () => managedBrain(async ({ engine, ctx, root }) => {
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - cache/\n');
    mkdirSync(join(root, 'cache'));
    git(root, 'add', 'gbrain.yml'); git(root, 'commit', '-qm', 'db_only');
    await strict(engine);
    const before = head(root);
    expect(await put(ctx, 'cache/put', page('Put', 'put_page.'))).toMatchObject({ state: 'committed' });
    expect(await putPages.handler(ctx, { request_id: randomUUID(), wait_ms: 30_000, pages: [{ slug: 'cache/batch-a', content: page('A', 'Batch a.') }, { slug: 'cache/batch-b', content: page('B', 'Batch b.') }] }))
      .toMatchObject({ state: 'committed' });
    expect(stateOf(await call(ctx, 'append_page', { slug: 'cache/put', text: 'Appended.', request_id: randomUUID() }))).toBe('committed');
    expect(stateOf(await call(ctx, 'takes_add', { slug: 'cache/put', claim: 'A cached claim.', kind: 'fact', holder: 'world', request_id: randomUUID() }))).toBe('committed');
    const text = page('Streamed', 'Uploaded in parts. '.repeat(200));
    const session = await call(ctx, 'begin_page_upload', { slug: 'cache/uploaded', mode: 'create', total_bytes: Buffer.byteLength(text), sha256: sha(text), request_id: randomUUID() });
    await call(ctx, 'upload_page_part', { upload_id: session.upload_id, part: 0, text, part_sha256: sha(text) });
    expect(stateOf(await call(ctx, 'commit_page_upload', { upload_id: session.upload_id, wait_ms: 30_000 }))).toBe('committed');
    for (const slug of ['cache/put', 'cache/batch-a', 'cache/batch-b', 'cache/uploaded']) {
      expect(existsSync(join(root, `${slug}.md`))).toBe(false);
      expect(await row(engine, slug)).toMatchObject({ live: true, source_path: null });
    }
    expect(head(root)).toBe(before);
    const input = join(root, '..', 'input'); mkdirSync(input);
    writeFileSync(join(input, 'cached.md'), page('Imported', 'Under a db_only dir.'));
    writeFileSync(join(input, 'secret.md'), page('Imported secret', 'Private.', 'visibility: private\n'));
    expect(await outcome(importManagedFile(engine, join(input, 'cached.md'), 'cache/imported.md', { sourceId: 'default', noEmbed: true }))).toMatchObject({ thrown: 'git_home_required' });
    expect(await outcome(importManagedFile(engine, join(input, 'secret.md'), 'notes/imported-secret.md', { sourceId: 'default', noEmbed: true }))).toMatchObject({ thrown: 'git_private_commit_refused' });
    expect(head(root)).toBe(before);
    for (const rel of ['cache/imported.md', 'notes/imported-secret.md']) expect(existsSync(join(root, rel))).toBe(false);
    expect(await row(engine, 'cache/imported')).toBeNull();
    expect(await row(engine, 'notes/imported-secret')).toBeNull();
  }, { databaseUrl, setup }), 120_000);

  test('a world page turning private: the door commits the removal of its file, the page stays live and private through sync --no-pull (Q8)', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const first = await put(ctx, 'notes/turning', page('Turning', 'Public first.'));
    expect(first).toMatchObject({ state: 'committed' });
    expect(atHead(root, 'notes/turning.md')).toBe('notes/turning.md');
    expect(await put(ctx, 'notes/turning', page('Turning', 'Private now.', 'visibility: private\n'), randomUUID(), first.revision)).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'notes/turning.md'))).toBe(false);
    expect(atHead(root, 'notes/turning.md')).toBe('');
    expect(git(root, 'log', '-1', '--format=%H', '--', 'notes/turning.md').trim()).toBe(head(root));
    expect(await row(engine, 'notes/turning')).toEqual({ live: true, reason: 'private', source_path: null, visibility: 'private' });
    await settleManagedGitEffects(engine);
    await performManagedSync(engine, OPTS);
    expect(await row(engine, 'notes/turning')).toEqual({ live: true, reason: 'private', source_path: null, visibility: 'private' });
    expect(git(root, 'status', '--porcelain').trim()).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('turning private when only HEAD still has the file (Q7): the removal goes through the door as a commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const first = await put(ctx, 'notes/half', page('Half', 'Public first.'));
    expect(first).toMatchObject({ state: 'committed' });
    rmSync(join(root, 'notes/half.md'));
    const before = head(root);
    expect(await put(ctx, 'notes/half', page('Half', 'Private now.', 'visibility: private\n'), randomUUID(), first.revision)).toMatchObject({ state: 'committed' });
    expect(head(root)).not.toBe(before);
    expect(atHead(root, 'notes/half.md')).toBe('');
    expect(await row(engine, 'notes/half')).toMatchObject({ live: true, reason: 'private', source_path: null });
  }, { databaseUrl, setup }), 120_000);

  test('a derive-folder page that turned private keeps its file path and writes the file back there when it turns world (G7a follow-up)', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    mkdirSync(join(root, 'concepts'), { recursive: true });
    writeFileSync(join(root, 'concepts/Turning Idea.md'), page('Turning idea', 'World first.'));
    git(root, 'add', 'concepts/Turning Idea.md'); git(root, 'commit', '-qm', 'concept');
    await performManagedSync(engine, OPTS);
    const filed = async () => (await engine.executeRaw<{ reason: string | null; source_path: string | null; withheld: string | null }>(
      "SELECT database_only_reason AS reason, source_path, withheld_source_path AS withheld FROM pages WHERE source_id='default' AND slug='concepts/turning-idea'"))[0];
    expect(await filed()).toEqual({ reason: null, source_path: 'concepts/Turning Idea.md', withheld: null });
    const world = (await engine.readPageSnapshot('concepts/turning-idea', { sourceId: 'default' }))!;
    const turned = await put(ctx, 'concepts/turning-idea', page('Turning idea', 'Private now.', 'visibility: private\n'), randomUUID(), world.revision);
    expect(turned).toMatchObject({ state: 'committed' });
    expect(atHead(root, 'concepts/Turning Idea.md')).toBe('');
    expect(await filed()).toEqual({ reason: 'private', source_path: null, withheld: 'concepts/Turning Idea.md' });
    await settleManagedGitEffects(engine);
    await performManagedSync(engine, OPTS);
    expect(await filed()).toEqual({ reason: 'private', source_path: null, withheld: 'concepts/Turning Idea.md' });
    const before = head(root);
    expect(await put(ctx, 'concepts/turning-idea', page('Turning idea', 'World again.'), randomUUID(), turned.revision)).toMatchObject({ state: 'committed' });
    expect(head(root)).not.toBe(before);
    expect(atHead(root, 'concepts/Turning Idea.md')).toBe('concepts/Turning Idea.md');
    expect(atHead(root, 'concepts/turning-idea.md')).toBe('');
    expect(git(root, 'show', 'HEAD:concepts/Turning Idea.md')).toContain('World again.');
    expect(await filed()).toEqual({ reason: null, source_path: 'concepts/Turning Idea.md', withheld: null });
    await settleManagedGitEffects(engine);
    await performManagedSync(engine, OPTS);
    expect(await filed()).toEqual({ reason: null, source_path: 'concepts/Turning Idea.md', withheld: null });
    expect(git(root, 'status', '--porcelain').trim()).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('a page that turned private writes its file back when it turns world; one under a folder declared db_only since drops its stale class', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const first = await put(ctx, 'notes/back', page('Back', 'World first.'));
    const second = await put(ctx, 'cache/quiet', page('Quiet', 'World first.'));
    const hidden = await put(ctx, 'notes/back', page('Back', 'Private now.', 'visibility: private\n'), randomUUID(), first.revision);
    const hiddenToo = await put(ctx, 'cache/quiet', page('Quiet', 'Private now.', 'visibility: private\n'), randomUUID(), second.revision);
    expect([hidden.state, hiddenToo.state]).toEqual(['committed', 'committed']);
    expect([atHead(root, 'notes/back.md'), atHead(root, 'cache/quiet.md')]).toEqual(['', '']);
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - cache/\n');
    git(root, 'add', 'gbrain.yml'); git(root, 'commit', '-qm', 'db_only');
    expect(await put(ctx, 'notes/back', page('Back', 'World again.'), randomUUID(), hidden.revision)).toMatchObject({ state: 'committed' });
    expect(git(root, 'show', 'HEAD:notes/back.md')).toContain('World again.');
    expect(await row(engine, 'notes/back')).toEqual({ live: true, reason: null, source_path: 'notes/back.md', visibility: null });
    const before = head(root);
    expect(await put(ctx, 'cache/quiet', page('Quiet', 'World again.'), randomUUID(), hiddenToo.revision)).toMatchObject({ state: 'committed' });
    expect(head(root)).toBe(before);
    expect(await row(engine, 'cache/quiet')).toEqual({ live: true, reason: null, source_path: null, visibility: null });
    await settleManagedGitEffects(engine);
    expect(git(root, 'status', '--porcelain').trim()).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('preparePrivateTransition (for GBRA-60): the removal of a strict page file; nothing on a source without the flag', () => managedBrain(async ({ engine, ctx, root }) => {
    expect(await put(ctx, 'notes/concept', page('Concept', 'World first.'))).toMatchObject({ state: 'committed' });
    await settleManagedGitEffects(engine);
    const [binding] = await engine.executeRaw<{ worktree_id: string }>("SELECT worktree_id FROM persistence_source_bindings WHERE source_id='default'");
    const target = { source_id: 'default', worktree_id: binding!.worktree_id, slug: 'notes/concept' };
    const snapshot = (await engine.readPageSnapshot('notes/concept', { sourceId: 'default' }))!;
    expect(await preparePrivateTransition(engine, target, snapshot)).toBeUndefined();
    await strict(engine);
    expect(await preparePrivateTransition(engine, target, snapshot)).toMatchObject({ root, path: join(root, 'notes/concept.md'), content: null });
  }, { databaseUrl, setup }), 120_000);

  test('backstop (forced probe): a put whose page became lineage-private after it was prepared is refused, no commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    // Postgres publishes a single write as a group of one first (publishSingleWrite); a refusal there releases the claim,
    // and when another worker claims the request before the reclaim it prepares again (now database-only) instead of
    // reaching the refusal. The probe pins the single path, the one whose refusal it asserts.
    await engine.setConfig('persistence.single_write_group', 'false');
    resetWriteSwitches();
    expect(await put(ctx, 'notes/origin', page('Origin', 'Public origin.'))).toMatchObject({ state: 'committed' });
    const requestId = randomUUID();
    let flipped = false;
    installFaultHook(async (point, detail) => {
      if (point !== 'publication:prepared' || detail.requestId !== requestId || flipped) return;
      flipped = true;
      await makePrivate(engine, 'notes/origin');
    });
    const before = head(root);
    const result = await outcome(put(ctx, 'notes/digest', page('Digest', 'Written from the origin.', 'derived_from: notes/origin\n'), requestId));
    expect(flipped).toBe(true);
    expect(result).toMatchObject({ thrown: 'git_private_commit_refused', message: expect.stringContaining('lineage-private') });
    expect(head(root)).toBe(before);
    expect(existsSync(join(root, 'notes/digest.md'))).toBe(false);
    expect(await row(engine, 'notes/digest')).toBeNull();
  }, { databaseUrl, setup }), 120_000);

  test('backstop (forced probe): a group with one member turned private is refused whole; HEAD never holds that member, and the others then publish alone', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    expect(await put(ctx, 'notes/origin', page('Origin', 'Public origin.'))).toMatchObject({ state: 'committed' });
    let flipped = false;
    installFaultHook(async (point, detail) => {
      if (point !== 'publication:prepared' || flipped) return;
      const [member] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE request_id=$1::uuid', [detail.requestId]);
      if (member?.slug !== 'notes/g-digest') return;
      flipped = true;
      await makePrivate(engine, 'notes/origin');
    });
    const before = head(root);
    const slugs = ['notes/g-a', 'notes/g-c', 'notes/g-digest'];
    const batch = await putPages.handler(ctx, { request_id: randomUUID(), wait_ms: 30_000, pages: [
      { slug: 'notes/g-a', content: page('A', 'Member a.') },
      { slug: 'notes/g-digest', content: page('Digest', 'From the origin.', 'derived_from: notes/origin\n') },
      { slug: 'notes/g-c', content: page('C', 'Member c.') },
    ] }) as Record<string, any>;
    expect(flipped).toBe(true);
    const rows = await engine.executeRaw<{ slug: string; state: string; error_code: string | null; error_message: string | null }>(
      "SELECT slug, state, error_code, error_message FROM persistence_requests WHERE source_id='default' AND slug = ANY($1::text[]) ORDER BY slug", [slugs]);
    expect(rows.find(r => r.slug === 'notes/g-digest')).toMatchObject({ state: 'failed', error_code: 'git_private_commit_refused' });
    expect(batch.counts).toMatchObject({ committed: 2, failed: 1 });
    expect(existsSync(join(root, 'notes/g-digest.md'))).toBe(false);
    expect(await row(engine, 'notes/g-digest')).toBeNull();
    // No commit since the refusal ever held the private member: the group's shared commit rolled back with its
    // transaction (Postgres publishes the batch as one group), and the existing fallback published each other member alone.
    expect(git(root, 'log', '--format=%H', `${before}..HEAD`, '--', 'notes/g-digest.md').trim()).toBe('');
    const touched = (rel: string) => git(root, 'log', '--format=%H', `${before}..HEAD`, '--', rel).trim();
    expect(touched('notes/g-a.md')).not.toBe('');
    expect(touched('notes/g-a.md')).not.toBe(touched('notes/g-c.md'));
  }, { databaseUrl, setup }), 120_000);

  test('a file under a Git LFS rule: refused while storage.git_lfs is off, committed as an LFS pointer once opted in', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const before = head(root);
    expect(await outcome(put(ctx, 'lfs/big', page('Big', 'Large body.')))).toMatchObject({ thrown: 'git_lfs_not_enabled', message: expect.stringContaining('storage.git_lfs is off') });
    await engine.setConfig('storage.git_lfs', 'true');
    expect(await outcome(put(ctx, 'lfs/big', page('Big', 'Large body.')))).toMatchObject({ thrown: 'git_lfs_not_enabled', message: expect.stringContaining('does not configure the LFS filter') });
    expect(head(root)).toBe(before);
    expect(existsSync(join(root, 'lfs/big.md'))).toBe(false);
    if (Bun.spawnSync(['git', 'lfs', 'version']).exitCode !== 0) return void console.warn('git-lfs is not installed: the LFS commit arm is skipped');
    git(root, 'lfs', 'install', '--local', '--skip-repo');
    expect(await put(ctx, 'lfs/big', page('Big', 'Large body.'))).toMatchObject({ state: 'committed' });
    expect(git(root, 'cat-file', '-p', 'HEAD:lfs/big.md')).toStartWith('version https://git-lfs.github.com/spec/v1');
    const objects = join(root, '.git', 'lfs', 'objects');
    expect(existsSync(objects) && readdirSync(objects, { recursive: true }).length > 0).toBe(true);
    expect(git(root, 'status', '--porcelain').trim()).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('the git fence: a strict source takes rows only from a writer declaring the git protocol; G4/G5 writers refuse', () => managedBrain(async ({ engine, ctx }) => {
    expect(await put(ctx, 'notes/fenced', page('Fenced', 'Body.'))).toMatchObject({ state: 'committed' });
    const legacy = (title: string) => engine.transaction(async tx => {
      await tx.executeRaw(`SELECT set_config('gbrain.write_sources','["default"]',true)`);
      await tx.executeRaw(`UPDATE pages SET title=$1 WHERE source_id='default' AND slug='notes/fenced'`, [title]);
    });
    await legacy('Before the flag');
    await expect(assertStrictGitHome(engine, { source_id: 'default', slug: 'notes/fenced' }, false)).resolves.toBeUndefined();
    await strict(engine);
    await expect(legacy('Under the flag')).rejects.toThrow(/git_protocol_required/);
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(`UPDATE pages SET title='Declared' WHERE source_id='default' AND slug='notes/fenced'`), TEST_WRITE_ATTRIBUTION));
    await expect(assertStrictGitHome(engine, { source_id: 'default', slug: 'notes/fenced' }, true)).rejects.toMatchObject({ code: 'git_home_required', reason: 'facts_lane' });
  }, { databaseUrl, setup }), 120_000);

  test('without the flag nothing changes: private, turned-private and LFS-rule writes publish their files as before', () => managedBrain(async ({ engine, ctx, root }) => {
    const slugs = ['notes/secret', 'notes/turning', 'lfs/big'];
    expect(await put(ctx, 'notes/secret', page('Secret', 'Private.', 'visibility: private\n'))).toMatchObject({ state: 'committed' });
    const first = await put(ctx, 'notes/turning', page('Turning', 'Public first.'));
    expect(first).toMatchObject({ state: 'committed' });
    expect(await put(ctx, 'notes/turning', page('Turning', 'Private now.', 'visibility: private\n'), randomUUID(), first.revision)).toMatchObject({ state: 'committed' });
    expect(await put(ctx, 'lfs/big', page('Big', 'Large body.'))).toMatchObject({ state: 'committed' });
    await settleManagedGitEffects(engine);
    for (const slug of slugs) {
      expect(existsSync(join(root, `${slug}.md`))).toBe(true);
      expect(atHead(root, `${slug}.md`)).toBe(`${slug}.md`);
      expect(await row(engine, slug)).toMatchObject({ live: true, reason: null, source_path: `${slug}.md` });
    }
  }, { databaseUrl, setup }), 120_000);
});
