/**
 * G7b-2, hosted writes (docs/designs/GIT_CANONICAL_MEMORY.md "Remote and hosted writes"): `gbrain sources host-repo` gives an
 * empty source a bare repository plus a gbrain-owned linked worktree, claimed through the ordinary claim, and makes the
 * source git-canonical. Protects:
 *   - the preview says the source becomes strict and binds the apply: a stale plan_hash refuses `preview_changed` and
 *     creates nothing; the apply leaves the worktree claimed on the repository's branch, and a second preview has nothing to do;
 *   - every remote write (OAuth client and legacy token) lands as exactly one commit on the bare repository's branch, its
 *     receipt names that commit, and a G3 pass over the source afterwards changes no page;
 *   - a door commit that landed before its grant was revoked keeps the landed commit on the receipt in this layout too;
 *   - a push into the repository is refused with the worktree and, once the worktree is removed and pruned, by the
 *     pre-receive hook alone; the preview reports a missing or changed hook and the apply reinstalls it;
 *   - the push effect carries door commits to the user's remote;
 *   - the refusals: a bound source, a source with pages, a directory that is not empty or sits in a checkout or a
 *     source's directory, an unmanaged brain (with a remote extract_entities on a strict source refused the same way);
 *   - a claim refuses a linked worktree whose link is broken (the checkout moved, or its entry was pruned).
 * PGLite here; with DATABASE_URL also Postgres (test/postgres-unit-arms.txt).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { hostRepo, hostedHookScript, type HostRepoOptions } from '../src/core/persistence/hosted-repo.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const SOURCE = 'source-a';
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const hostedDir = (root: string) => join(dirname(root), 'hosted');
const code = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; reason?: string }) => ({ code: error.code, reason: error.reason ?? null }));

async function host(engine: BrainEngine, dir: string, extra: Partial<HostRepoOptions> = {}) {
  const preview = await hostRepo(engine, { sourceId: SOURCE, dir, dryRun: true, ...extra });
  return hostRepo(engine, { sourceId: SOURCE, dir, dryRun: false, expect: preview.plan_hash, ...extra });
}

/** A remote OAuth client and a remote legacy token, both granted read and write on the hosted source. */
async function remoteCallers(engine: BrainEngine, ctx: OperationContext) {
  const clientId = `client-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES($1,'fixture-hash','example-client','read write',$2)`, [clientId, SOURCE]);
  const minted = await mintLegacyToken(engine, { name: `token-${clientId}`, scopes: ['read', 'write'], sourceGrant: [SOURCE], takesHolders: ['world'] });
  return {
    tokenId: minted.id,
    oauth: { ...ctx, sourceId: SOURCE, remote: true, transport: 'http', auth: { token: 'fixture', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['read', 'write'], sourceId: SOURCE } } as OperationContext,
    token: { ...ctx, sourceId: SOURCE, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id }, sourceId: SOURCE, allowedSources: [SOURCE], scopes: ['read', 'write'] } } as OperationContext,
  };
}

const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  (operationsByName[name]!.handler(ctx, { request_id: randomUUID(), wait_ms: 30_000, ...params }) as Promise<Record<string, any>>)
    .catch((error: Error & { code?: string }) => { throw Object.assign(error, { message: `${name}: ${error.message}` }); });
const revision = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: SOURCE }))!.revision;
const commitsTouching = (repository: string, rel: string) => git(repository, 'log', '--format=%H', 'main', '--', rel).split('\n').filter(Boolean);
/** A push from a clone of the repository: its exit code and stderr. */
function foreignPush(repository: string, clone: string): { exitCode: number | null; stderr: string } {
  if (!existsSync(clone)) git(dirname(clone), 'clone', '-q', repository, clone);
  writeFileSync(join(clone, 'foreign.md'), page('Foreign', `Pushed around the door at ${Date.now()}.`));
  git(clone, 'add', 'foreign.md');
  git(clone, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-q', '-m', 'foreign');
  const result = Bun.spawnSync(['git', '-C', clone, 'push', 'origin', 'HEAD:main'], { env: process.env });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

for (const backend of testBackends()) describe(`[${backend}] G7b-2: a hosted source commits every write in its bare repository through the door`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => installFaultHook(undefined));

  test('the preview says the source becomes strict and binds the apply; a stale plan refuses and creates nothing; the apply claims the worktree', () => managedBrain(async ({ engine, root }) => {
    const dir = hostedDir(root);
    const preview = await hostRepo(engine, { sourceId: SOURCE, dir, dryRun: true });
    expect(preview).toMatchObject({ action: 'host', dry_run: true, source: { registered: false, canonical: { before: null, after: 'git' } },
      repository: join(dir, 'repo.git'), worktree: join(dir, 'worktree'), branch: 'main', hook: { state: 'install' } });
    expect(preview.summary[0]).toContain(`Source ${SOURCE} becomes git-canonical (strict, canonical: git)`);
    expect(preview.apply).toEqual(['gbrain', 'sources', 'host-repo', SOURCE, '--dir', dir, '--expect', preview.plan_hash]);
    expect(existsSync(dir)).toBe(false);

    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: SOURCE });
    expect(await code(hostRepo(engine, { sourceId: SOURCE, dir, dryRun: false, expect: preview.plan_hash }))).toEqual({ code: 'preview_changed', reason: null });
    expect(existsSync(dir)).toBe(false);

    const hosted = await host(engine, dir);
    expect(hosted).toMatchObject({ action: 'host', dry_run: false, source: { registered: true }, hook: { state: 'ok' }, worktree_link: 'ok' });
    const [row] = await engine.executeRaw<{ config: Record<string, any>; local_path: string }>('SELECT config, local_path FROM sources WHERE id=$1', [SOURCE]);
    expect(row!.config).toMatchObject({ canonical: 'git', hosted_repo: { repository: hosted.repository, worktree: hosted.worktree, branch: 'main' } });
    const [binding] = await engine.executeRaw<{ local_path: string }>(
      'SELECT h.local_path FROM persistence_source_bindings b JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id WHERE b.source_id=$1', [SOURCE]);
    expect(binding!.local_path).toBe(hosted.worktree);
    expect(git(hosted.worktree, 'rev-parse', 'HEAD').trim()).toBe(git(hosted.repository, 'rev-parse', 'main').trim());
    expect(git(hosted.repository, 'ls-tree', '--name-only', 'main').trim()).toBe('.gitignore');
    expect(readFileSync(hosted.hook.path, 'utf8')).toBe(hostedHookScript(SOURCE));
    const again = await hostRepo(engine, { sourceId: SOURCE, dir, dryRun: true });
    expect(again).toMatchObject({ action: 'none', hook: { state: 'ok' }, worktree_link: 'ok' });
    expect(again.apply).toBeUndefined();
  }, { databaseUrl, setup }), 120_000);

  test('every remote write lands as exactly one commit on the bare branch, its receipt names it, and a G3 pass changes nothing', () => managedBrain(async ({ engine, ctx, root }) => {
    const hosted = await host(engine, hostedDir(root));
    const { oauth, token } = await remoteCallers(engine, ctx);
    const start = Number((await engine.executeRaw<{ s: number }>('SELECT COALESCE(max(sequence),0) AS s FROM persistence_requests'))[0]!.s);
    await call(oauth, 'put_page', { slug: 'notes/a', content: page('A', 'First body.') });
    await call(token, 'put_page', { slug: 'notes/b', content: page('B', 'Bee.') });
    await call(oauth, 'edit_page', { slug: 'notes/a', expected_revision: await revision(engine, 'notes/a'), edits: [{ old_text: 'First body.', new_text: 'Edited body.' }] });
    expect(await call(token, 'put_pages', { pages: [{ slug: 'notes/c', content: page('C', 'Cee.') }, { slug: 'notes/d', content: page('D', 'Dee.') }] }))
      .toMatchObject({ state: 'committed', counts: { committed: 2, failed: 0 } });
    await call(oauth, 'delete_page', { slug: 'notes/b', expected_revision: await revision(engine, 'notes/b') });

    const rows = await engine.executeRaw<{ slug: string; state: string; outcome: Record<string, any> | null }>(
      'SELECT slug, state, outcome FROM persistence_requests WHERE sequence > $1 AND source_id=$2 AND slug IS NOT NULL ORDER BY sequence', [start, SOURCE]);
    expect(rows.map(r => ({ slug: r.slug, state: r.state, git_state: r.outcome?.persistence?.git_state })))
      .toEqual(['notes/a', 'notes/b', 'notes/a', 'notes/c', 'notes/d', 'notes/b'].map(slug => ({ slug, state: 'committed', git_state: 'committed' })));
    const byCommit = new Map<string, string[]>();
    for (const r of rows) byCommit.set(r.outcome!.persistence.git_commit, [...(byCommit.get(r.outcome!.persistence.git_commit) ?? []), `${r.slug}.md`]);
    const doorCommits = git(hosted.repository, 'rev-list', 'main').split('\n').filter(Boolean).slice(0, -1);
    expect(new Set(doorCommits)).toEqual(new Set(byCommit.keys()));
    for (const [commit, paths] of byCommit)
      expect({ commit, touched: git(hosted.repository, 'diff-tree', '--no-commit-id', '--name-only', '-r', commit).split('\n').filter(Boolean).sort() })
        .toEqual({ commit, touched: [...paths].sort() });
    expect(git(hosted.worktree, 'status', '--porcelain')).toBe('');
    expect(git(hosted.repository, 'show', 'main:notes/a.md')).toContain('Edited body.');

    const pages = () => engine.executeRaw<{ slug: string; revision: string; deleted: boolean }>(
      'SELECT slug, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 ORDER BY slug', [SOURCE]);
    const before = await pages();
    expect(before.map(p => p.slug)).toEqual(['notes/a', 'notes/b', 'notes/c', 'notes/d']);
    await performManagedSync(engine, { sourceId: SOURCE, noPull: true, noEmbed: true, noExtract: true });
    expect(await pages()).toEqual(before);
    expect((await performManagedSync(engine, { sourceId: SOURCE, noPull: true, noEmbed: true, noExtract: true })).status).toBe('up_to_date');
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='sync-hold' AND completed_keys::text LIKE '%notes/%'")).toHaveLength(0);
  }, { databaseUrl, setup }), 240_000);

  test('a door commit that landed before its grant was revoked: the replay refuses, and its receipt names the landed commit in the bare repository', () => managedBrain(async ({ engine, ctx, root }) => {
    const hosted = await host(engine, hostedDir(root));
    const { token, tokenId } = await remoteCallers(engine, ctx);
    const requestId = randomUUID();
    let landed = '';
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'publication:before_commit' && !landed) { landed = git(hosted.repository, 'rev-parse', 'main').trim(); throw Object.assign(new Error('database interruption'), { code: 'CONNECTION_CLOSED' }); }
      if (point === 'publication:prepared' && landed) await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [tokenId]);
    });
    await expect(call(token, 'put_page', { request_id: requestId, slug: 'notes/landed', content: page('Landed', 'Committed, then revoked.') }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    const holder = commitsTouching(hosted.repository, 'notes/landed.md');
    expect(holder).toEqual([landed]);
    const [done] = await engine.executeRaw<{ state: string; error_code: string; outcome: Record<string, any> }>('SELECT state, error_code, outcome FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(done).toEqual({ state: 'failed', error_code: 'permission_denied', outcome: { persistence: { git_state: 'committed', git_commit: landed, landed_before_row: true } } });
    expect(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, 'notes/landed'])).toHaveLength(0);
  }, { databaseUrl, setup }), 120_000);

  test('a push into the repository is refused with the worktree and by the hook alone once it is pruned; the preview reports the hook and the apply reinstalls it', () => managedBrain(async ({ engine, root }) => {
    const dir = hostedDir(root);
    const hosted = await host(engine, dir);
    const head = git(hosted.repository, 'rev-parse', 'main').trim();
    const clone = join(dirname(root), 'clone');
    const first = foreignPush(hosted.repository, clone);
    expect({ exitCode: first.exitCode, named: first.stderr.includes(`gbrain put --source ${SOURCE}`) }).toEqual({ exitCode: 1, named: true });
    expect(git(hosted.repository, 'rev-parse', 'main').trim()).toBe(head);

    rmSync(hosted.worktree, { recursive: true, force: true });
    git(hosted.repository, 'worktree', 'prune');
    expect(git(hosted.repository, 'worktree', 'list', '--porcelain')).not.toContain(hosted.worktree);
    const second = foreignPush(hosted.repository, clone);
    expect({ exitCode: second.exitCode, named: second.stderr.includes(`gbrain put --source ${SOURCE}`) }).toEqual({ exitCode: 1, named: true });
    expect(git(hosted.repository, 'rev-parse', 'main').trim()).toBe(head);
    expect(await hostRepo(engine, { sourceId: SOURCE, dir, dryRun: true })).toMatchObject({ action: 'none', hook: { state: 'ok' }, worktree_link: 'absent' });

    writeFileSync(hosted.hook.path, '#!/bin/sh\nexit 0\n');
    const changed = await hostRepo(engine, { sourceId: SOURCE, dir, dryRun: true });
    expect(changed).toMatchObject({ action: 'reinstall_hook', hook: { state: 'changed' } });
    rmSync(hosted.hook.path);
    const missing = await hostRepo(engine, { sourceId: SOURCE, dir, dryRun: true });
    expect(missing).toMatchObject({ action: 'reinstall_hook', hook: { state: 'missing' } });
    expect(await code(hostRepo(engine, { sourceId: SOURCE, dir, dryRun: false, expect: changed.plan_hash }))).toEqual({ code: 'preview_changed', reason: null });
    expect(await hostRepo(engine, { sourceId: SOURCE, dir, dryRun: false, expect: missing.plan_hash })).toMatchObject({ action: 'reinstall_hook', hook: { state: 'ok' } });
    expect(foreignPush(hosted.repository, clone).exitCode).toBe(1);
    expect(git(hosted.repository, 'rev-parse', 'main').trim()).toBe(head);
  }, { databaseUrl, setup }), 120_000);

  test('the push effect carries door commits to the user remote', () => managedBrain(async ({ engine, ctx, root }) => {
    const remote = join(dirname(root), 'user-remote.git');
    git(dirname(root), 'init', '-q', '--bare', '--initial-branch=main', remote);
    const preview = await hostRepo(engine, { sourceId: SOURCE, dir: hostedDir(root), dryRun: true, pushRemote: remote });
    expect(preview.next).toEqual([['gbrain', 'sources', 'writer', 'git-durability', SOURCE, '--enable', '--dry-run']]);
    const hosted = await host(engine, hostedDir(root), { pushRemote: remote });
    await engine.executeRaw(`UPDATE persistence_host_bindings SET git_durability='enabled' WHERE worktree_id=(SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$1)`, [SOURCE]);
    const { oauth } = await remoteCallers(engine, ctx);
    await call(oauth, 'put_page', { slug: 'notes/pushed', content: page('Pushed', 'Reaches the user remote.') });
    await settleManagedGitEffects(engine, SOURCE);
    expect(git(remote, 'rev-parse', 'main').trim()).toBe(git(hosted.repository, 'rev-parse', 'main').trim());
    expect(git(remote, 'show', 'main:notes/pushed.md')).toContain('Reaches the user remote.');
  }, { databaseUrl, setup }), 120_000);

  test('refuses a bound source, a source with pages, and a directory that is not empty or sits in a checkout or a source directory, and creates nothing', () => managedBrain(async ({ engine, root }) => {
    const dir = join(dirname(root), 'elsewhere');
    expect(await code(hostRepo(engine, { sourceId: 'default', dir, dryRun: true }))).toEqual({ code: 'hosted_repo_refused', reason: 'source_bound' });
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'source-p' });
    await engine.transaction(tx => withCoordinatedWrite(tx, ['source-p'], () => tx.executeRaw(
      `INSERT INTO pages(source_id, slug, type, title, compiled_truth) VALUES('source-p','notes/existing','note','Existing','Existing body.')`), TEST_WRITE_ATTRIBUTION));
    expect(await code(hostRepo(engine, { sourceId: 'source-p', dir, dryRun: true }))).toEqual({ code: 'hosted_repo_refused', reason: 'source_has_pages' });
    const plain = join(dirname(root), 'plain'); mkdirSync(plain);
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'source-d', path: plain });
    expect(await code(hostRepo(engine, { sourceId: 'source-d', dir, dryRun: true }))).toEqual({ code: 'hosted_repo_refused', reason: 'source_bound' });
    mkdirSync(dir); writeFileSync(join(dir, 'stray.txt'), 'x');
    expect(await code(hostRepo(engine, { sourceId: SOURCE, dir, dryRun: true }))).toEqual({ code: 'hosted_repo_refused', reason: 'dir_not_empty' });
    expect(await code(hostRepo(engine, { sourceId: SOURCE, dir: join(root, 'hosted'), dryRun: true }))).toEqual({ code: 'overlapping_path', reason: null });
    expect(await code(hostRepo(engine, { sourceId: SOURCE, dir: join(plain, 'hosted'), dryRun: true }))).toEqual({ code: 'overlapping_path', reason: null });
    expect(existsSync(join(root, 'hosted')) || existsSync(join(plain, 'hosted'))).toBe(false);
    expect(await engine.executeRaw('SELECT 1 FROM sources WHERE id=$1', [SOURCE])).toHaveLength(0);
    expect(Object.keys(operationsByName).filter(name => name.includes('host'))).toEqual([]);
  }, { databaseUrl, setup }), 120_000);

  test('a claim refuses a linked worktree whose checkout moved or whose entry was pruned', () => managedBrain(async ({ engine, root }) => {
    const home = dirname(root), repository = join(home, 'linked.git'), worktree = join(home, 'linked-worktree'), moved = join(home, 'moved-worktree');
    git(home, 'init', '-q', '--bare', '--initial-branch=main', repository);
    git(repository, 'worktree', 'add', '-q', '--orphan', '-b', 'main', worktree);
    git(worktree, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Initial');
    renameSync(worktree, moved);
    expect(await code(runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'source-l', path: moved }))).toEqual({ code: 'git_worktree_link_broken', reason: null });
    git(repository, 'worktree', 'prune');
    expect(await code(runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'source-l', path: moved }))).toEqual({ code: 'git_worktree_link_broken', reason: null });
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='source-l'")).toHaveLength(0);
  }, { databaseUrl, setup }), 120_000);
});

const unmanaged: { backend: string; engine: BrainEngine; close: () => Promise<void> }[] = [];
beforeAll(async () => {
  for (const backend of testBackends()) {
    if (backend === 'postgres') { const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase()); unmanaged.push({ backend, engine: pg.engine, close: pg.close }); continue; }
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    unmanaged.push({ backend, engine, close: () => engine.disconnect() });
  }
}, 120_000);
afterAll(async () => { for (const { close } of unmanaged) await close(); });

for (const backend of testBackends()) test(`[${backend}] G7b-2: an unmanaged brain refuses host-repo and a remote extract_entities on a strict source with strict_requires_managed`, async () => {
  const { engine } = unmanaged.find(entry => entry.backend === backend)!;
  expect(await code(hostRepo(engine, { sourceId: SOURCE, dir: '/nonexistent/hosted', dryRun: true }))).toEqual({ code: 'strict_requires_managed', reason: null });
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"canonical":"git"}'::jsonb) ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`, [SOURCE]);
  const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: SOURCE, remote: true, transport: 'http', dryRun: false,
    logger: { info() {}, warn() {}, error() {} }, auth: { token: 'fixture', clientId: 'client-x', principal: { kind: 'oauth_client', id: 'client-x' }, scopes: ['read', 'write'], sourceId: SOURCE } } as unknown as OperationContext;
  expect(await code(operationsByName.extract_entities!.handler(ctx, { text: 'Met Alice Example at the offsite.', source_slug: 'notes/offsite' })))
    .toEqual({ code: 'strict_requires_managed', reason: null });
  expect(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1', [SOURCE])).toHaveLength(0);
}, 60_000);
