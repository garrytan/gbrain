/**
 * G7b, remote writes in git-canonical memory (docs/designs/GIT_CANONICAL_MEMORY.md, "Remote and hosted writes"). A
 * remote MCP caller or thin client (OperationContext.remote = true, an OAuth client or a legacy token) writing a strict
 * source (`sources.config.canonical = "git"`) submits a journal request; the owner's door commits it to Git before its
 * row (src/core/persistence/git-door.ts). Protects:
 *   - every page-content operation a remote caller has commits through the door: each committed request's receipt names
 *     the commit that holds its path, reachable from HEAD, and the file is clean in the checkout;
 *   - the commit exists before the row commits (publication:before_commit), for a remote write;
 *   - with the owner down, the caller gets write_pending with its request id, and neither a row nor a commit exists;
 *     once the owner runs it, it commits exactly once and a replay of the same request id returns that revision;
 *   - a grant revoked while the request waits is refused when the owner runs it: no row and no commit.
 * PGLite here; with DATABASE_URL also Postgres (test/postgres-unit-arms.txt).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);

/** A remote OAuth client and a remote legacy token, both granted read and write on the default source. */
async function remoteCallers(engine: BrainEngine, ctx: OperationContext): Promise<{ oauth: OperationContext; token: OperationContext; tokenId: string; clientId: string }> {
  const clientId = `client-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES($1,'fixture-hash','example-client','read write','default')`, [clientId]);
  const minted = await mintLegacyToken(engine, { name: `token-${clientId}`, scopes: ['read', 'write'], sourceGrant: ['default'], takesHolders: ['world'] });
  return {
    clientId, tokenId: minted.id,
    oauth: { ...ctx, remote: true, transport: 'http', auth: { token: 'fixture', clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['read', 'write'], sourceId: 'default' } } as OperationContext,
    token: { ...ctx, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id }, sourceId: 'default', allowedSources: ['default'], scopes: ['read', 'write'] } } as OperationContext,
  };
}

const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  (operationsByName[name]!.handler(ctx, { request_id: randomUUID(), wait_ms: 30_000, ...params }) as Promise<Record<string, any>>)
    .catch((error: Error & { code?: string }) => { throw Object.assign(error, { message: `${name}: ${error.message}` }); });
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const revision = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
const lastSequence = async (engine: BrainEngine) => Number((await engine.executeRaw<{ s: number }>('SELECT COALESCE(max(sequence),0) AS s FROM persistence_requests'))[0]!.s);
const commitsTouching = (root: string, rel: string) => git(root, 'log', '--format=%H', '--', rel).split('\n').filter(Boolean);

/**
 * Every committed page request after `after`: its receipt names a commit reachable from HEAD that holds its file (or,
 * for a removal, no longer holds it), and the checkout holds that file clean. Returns how many there were.
 */
async function assertCommittedThroughDoor(engine: BrainEngine, root: string, after: number): Promise<number> {
  const rows = await engine.executeRaw<{ slug: string; operation: string; state: string; outcome: Record<string, any> | null }>(
    `SELECT slug, operation, state, outcome FROM persistence_requests WHERE sequence > $1 AND slug IS NOT NULL AND source_id='default' ORDER BY sequence`, [after]);
  const published = rows.filter(row => row.state === 'committed' && row.outcome?.persistence?.git_state !== undefined);
  for (const row of published) {
    const commit = row.outcome!.persistence.git_commit as string;
    expect({ slug: row.slug, operation: row.operation, git_state: row.outcome!.persistence.git_state, commit: typeof commit }).toEqual({ slug: row.slug, operation: row.operation, git_state: 'committed', commit: 'string' });
    git(root, 'merge-base', '--is-ancestor', commit, 'HEAD');
    const rel = `${row.slug}.md`;
    const listed = git(root, 'ls-tree', '--name-only', commit, '--', rel).trim();
    expect({ slug: row.slug, operation: row.operation, inCommit: listed === rel }).toEqual({ slug: row.slug, operation: row.operation, inCommit: row.operation !== 'delete_page' });
    expect(git(root, 'status', '--porcelain', '--', rel)).toBe('');
  }
  return published.length;
}

for (const backend of testBackends()) describe(`[${backend}] G7b: remote writes to a strict source go through the owner's door`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  afterEach(() => installFaultHook(undefined));

  test('every page-content operation of a remote caller commits to Git before its row, for an OAuth client and a legacy token', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const { oauth, token } = await remoteCallers(engine, ctx);
    for (const [name, remote] of [['oauth', oauth], ['token', token]] as const) {
      const base = `notes/${name}`;
      const start = await lastSequence(engine);
      const requestId = randomUUID();
      const seen: { blob?: string } = {};
      installFaultHook(async (point, detail) => {
        if (point === 'publication:before_commit' && detail.requestId === requestId) seen.blob = git(root, 'show', `HEAD:${base}-a.md`);
      });
      expect(await call(remote, 'put_page', { request_id: requestId, slug: `${base}-a`, content: page('A', 'First body.') })).toMatchObject({ state: 'committed' });
      installFaultHook(undefined);
      expect(seen.blob).toContain('First body.');
      await call(remote, 'edit_page', { slug: `${base}-a`, expected_revision: await revision(engine, `${base}-a`), edits: [{ old_text: 'First body.', new_text: 'Edited body.' }] });
      await call(remote, 'append_page', { slug: `${base}-a`, text: 'An appended line.' });
      await call(remote, 'add_tag', { slug: `${base}-a`, tag: 'example' });
      await call(remote, 'remove_tag', { slug: `${base}-a`, tag: 'example' });
      await call(remote, 'add_timeline_entry', { slug: `${base}-a`, date: '2026-01-01', summary: 'Met alice-example.' });
      if (name === 'token') await call(remote, 'takes_add', { slug: `${base}-a`, claim: 'Example claims are testable.', kind: 'take', holder: 'world', weight: 0.5 });
      await call(remote, 'capture', { content: `A captured note from the ${name} caller.` });
      expect(await call(remote, 'put_pages', { pages: [{ slug: `${base}-b`, content: page('B', 'Bee.') }, { slug: `${base}-c`, content: page('C', 'Cee.') }] }))
        .toMatchObject({ state: 'committed', counts: { committed: 2, failed: 0 } });
      await call(remote, 'delete_page', { slug: `${base}-c`, expected_revision: await revision(engine, `${base}-c`) });
      const deleted = await engine.readPageSnapshot(`${base}-c`, { sourceId: 'default', includeDeleted: true });
      await call(remote, 'restore_page', { slug: `${base}-c`, expected_revision: deleted!.revision });
      const [first] = await engine.executeRaw<{ id: number }>(`SELECT v.id FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id='default' AND p.slug=$1 ORDER BY v.id LIMIT 1`, [`${base}-a`]);
      await call(remote, 'revert_version', { slug: `${base}-a`, version_id: Number(first!.id), expected_revision: await revision(engine, `${base}-a`) });
      const uploaded = page('D', 'Uploaded.');
      const upload = await call(remote, 'begin_page_upload', { slug: `${base}-d`, mode: 'create', total_bytes: Buffer.byteLength(uploaded), sha256: sha256(uploaded) });
      await call(remote, 'upload_page_part', { upload_id: upload.upload_id, part: 0, text: uploaded, part_sha256: sha256(uploaded) });
      expect(await call(remote, 'commit_page_upload', { upload_id: upload.upload_id })).toMatchObject({ state: 'committed' });
      const operations = (await engine.executeRaw<{ operation: string }>("SELECT DISTINCT operation FROM persistence_requests WHERE sequence > $1 AND state='committed' AND outcome->'persistence'->>'git_state'='committed'", [start])).map(row => row.operation).sort();
      expect(operations).toEqual(expect.arrayContaining(['append_page', 'capture', 'delete_page', 'edit_page', 'put_page', 'restore_page', 'revert_version']));
      expect(await assertCommittedThroughDoor(engine, root, start)).toBeGreaterThanOrEqual(12);
    }
    expect(git(root, 'status', '--porcelain', '--', 'notes')).toBe('');
  }, { databaseUrl, setup }), 240_000);

  test('the owner down: write_pending with its request id, no row and no commit; once the owner runs it, one commit, and a replay returns it', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const { oauth } = await remoteCallers(engine, ctx);
    const [binding] = await engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees');
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$1::uuid', [randomUUID()]);
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const requestId = randomUUID();
    const pending = await call(oauth, 'put_page', { request_id: requestId, wait_ms: 1_000, slug: 'notes/pending', content: page('Pending', 'Waits for its owner.') })
      .then(() => ({ code: 'returned' }), (error: { code?: string; writeRequest?: { request_id?: string; state?: string } }) => ({ code: error.code, request: error.writeRequest }));
    expect(pending).toMatchObject({ code: 'write_pending', request: { request_id: requestId, state: 'queued' } });
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id='default' AND slug='notes/pending'")).toHaveLength(0);

    await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$1::uuid', [binding!.owner]);
    startPersistenceConsumer(engine, ctx.config as never).wake(true);
    await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed',
      { timeoutMs: 60_000, label: 'the pending remote write commits' });
    const [done] = await engine.executeRaw<{ outcome: Record<string, any> }>('SELECT outcome FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(commitsTouching(root, 'notes/pending.md')).toEqual([done!.outcome.persistence.git_commit]);
    const replay = await call(oauth, 'put_page', { request_id: requestId, slug: 'notes/pending', content: page('Pending', 'Waits for its owner.') });
    expect(replay).toMatchObject({ state: 'committed', revision: await revision(engine, 'notes/pending') });
    expect(commitsTouching(root, 'notes/pending.md')).toHaveLength(1);
  }, { databaseUrl, setup }), 120_000);

  test('a grant revoked while its write waits is refused when the owner runs it: no row and no commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const { token, tokenId } = await remoteCallers(engine, ctx);
    const [binding] = await engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees');
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$1::uuid', [randomUUID()]);
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const requestId = randomUUID();
    await expect(call(token, 'put_page', { request_id: requestId, wait_ms: 1_000, slug: 'notes/revoked', content: page('Revoked', 'Never published.') }))
      .rejects.toMatchObject({ code: 'write_pending' });
    await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE id=$1', [tokenId]);
    await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$1::uuid', [binding!.owner]);
    startPersistenceConsumer(engine, ctx.config as never).wake(true);
    await waitFor(async () => !['queued', 'running', 'recovering'].includes((await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state ?? ''),
      { timeoutMs: 60_000, label: 'the revoked remote write ends' });
    const [done] = await engine.executeRaw<{ state: string; error_code: string | null }>('SELECT state, error_code FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(done).toEqual({ state: 'failed', error_code: 'permission_denied' });
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(git(root, 'status', '--porcelain', '--', 'notes')).toBe('');
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id='default' AND slug='notes/revoked'")).toHaveLength(0);
  }, { databaseUrl, setup }), 120_000);

  test('a door commit that landed before its grant was revoked: the replay refuses, and its receipt names the landed commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const { token, tokenId } = await remoteCallers(engine, ctx);
    const requestId = randomUUID();
    let landed = '';
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'publication:before_commit' && !landed) { landed = git(root, 'rev-parse', 'HEAD').trim(); throw Object.assign(new Error('database interruption'), { code: 'CONNECTION_CLOSED' }); }
      if (point === 'publication:prepared' && landed) await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [tokenId]);
    });
    await expect(call(token, 'put_page', { request_id: requestId, slug: 'notes/landed', content: page('Landed', 'Committed, then revoked.') }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect(landed).not.toBe('');
    const [done] = await engine.executeRaw<{ state: string; error_code: string; outcome: Record<string, any> }>('SELECT state, error_code, outcome FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    const holder = commitsTouching(root, 'notes/landed.md');
    expect(holder).toHaveLength(1);
    expect(git(root, 'show', `${holder[0]}:notes/landed.md`)).toContain('Committed, then revoked.');
    expect(done).toEqual({ state: 'failed', error_code: 'permission_denied',
      outcome: { persistence: { git_state: 'committed', git_commit: holder[0], landed_before_row: true } } });
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id='default' AND slug='notes/landed'")).toHaveLength(0);
  }, { databaseUrl, setup }), 120_000);

  test('a replay after a landed door commit that commits carries the normal door receipt, without landed_before_row', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const { oauth } = await remoteCallers(engine, ctx);
    const requestId = randomUUID();
    let thrown = false;
    installFaultHook(async (point, detail) => {
      if (point === 'publication:before_commit' && detail.requestId === requestId && !thrown) { thrown = true; throw Object.assign(new Error('database interruption'), { code: 'CONNECTION_CLOSED' }); }
    });
    expect(await call(oauth, 'put_page', { request_id: requestId, slug: 'notes/replayed', content: page('Replayed', 'Landed, then indexed.') })).toMatchObject({ state: 'committed' });
    expect(thrown).toBe(true);
    const [done] = await engine.executeRaw<{ outcome: Record<string, any> }>('SELECT outcome FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(commitsTouching(root, 'notes/replayed.md')).toEqual([done!.outcome.persistence.git_commit]);
    expect(done!.outcome.persistence.git_state).toBe('committed');
    expect(done!.outcome.persistence).not.toHaveProperty('landed_before_row');
  }, { databaseUrl, setup }), 120_000);

  test('put_pages whose group commit landed before its grant was revoked: every landed member names that one commit', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const { token, tokenId } = await remoteCallers(engine, ctx);
    const slugs = ['notes/m1', 'notes/m2', 'notes/m3'];
    let thrown = false;
    installFaultHook(async (point) => {
      if (point === 'publication:before_commit' && !thrown) { thrown = true; throw Object.assign(new Error('database interruption'), { code: 'CONNECTION_CLOSED' }); }
      if (point === 'publication:prepared' && thrown) await engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [tokenId]);
    });
    await call(token, 'put_pages', { pages: slugs.map(slug => ({ slug, content: page(slug, `Body of ${slug}.`) })) }).catch(() => undefined);
    installFaultHook(undefined);
    expect(thrown).toBe(true);
    const rows = await engine.executeRaw<{ slug: string; state: string; error_code: string | null; outcome: Record<string, any> | null }>(
      "SELECT slug, state, error_code, outcome FROM persistence_requests WHERE source_id='default' AND slug = ANY($1::text[]) ORDER BY slug", [slugs]);
    expect(rows.map(row => ({ slug: row.slug, state: row.state, error_code: row.error_code }))).toEqual(slugs.map(slug => ({ slug, state: 'failed', error_code: 'permission_denied' })));
    const landed = rows.filter(row => commitsTouching(root, `${row.slug}.md`).length > 0);
    expect(landed.length).toBeGreaterThan(0);
    for (const row of rows) {
      const holder = commitsTouching(root, `${row.slug}.md`);
      expect({ slug: row.slug, persistence: row.outcome?.persistence ?? null })
        .toEqual({ slug: row.slug, persistence: holder.length ? { git_state: 'committed', git_commit: holder[0], landed_before_row: true } : null });
    }
    // Postgres publishes the batch as one group (group-publish.ts), so every member landed in one door commit; PGLite publishes one at a time.
    if (backend === 'postgres') expect({ landed: landed.length, commits: new Set(landed.map(row => row.outcome!.persistence.git_commit)).size }).toEqual({ landed: slugs.length, commits: 1 });
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id='default' AND slug = ANY($1::text[])", [slugs])).toHaveLength(0);
  }, { databaseUrl, setup }), 120_000);
});

