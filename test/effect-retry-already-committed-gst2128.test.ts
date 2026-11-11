/**
 * GST-2128 / GBRA-398: the recovery for a group of Git effects parked on `git_unavailable` is to commit their files by name and
 * then retry them. A retried effect whose target bytes are already in HEAD must complete as `unchanged` and join the push,
 * not park again; one that still has changes in the same group commits as usual.
 * Seams: real PGLite journal and effect runner, a claimed worktree on a real repository; the operator's commit is plain git.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { retryParkedEffects } from '../src/core/persistence/effect-retry.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { gitAsync } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
const config = { engine: 'pglite' as const, embedding_disabled: true };
const page = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-retry-committed-'));
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function write(root: string, sourceId: string, slug: string): Promise<{ id: string; requestId: string }> {
  const binding = (await getWorktreeBinding(engine, sourceId, localHostId()))!;
  await engine.putPage(slug, page('Before'), { sourceId });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const file = join(root, `${slug}.md`); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
  const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', sourceId, binding.source_incarnation, slug);
  const requestId = randomUUID();
  const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
    sourceIncarnation: binding.source_incarnation, slug, pageId: snapshot.page.id, requestId,
    callerIntent: { content: 'After' }, intent: { content: 'After' }, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const row = (await claimNextWrite(engine, localHostId()))!;
  expect(row.id).toBe(admitted.id);
  const result = await publishMutation(engine, row, { observedRevision: snapshot.revision, file: { path: file, root, content: 'After' },
    apply: async tx => { await tx.putPage(slug, page('After'), { sourceId }); return {}; } }, localHostId());
  expect(result.state).toBe('committed');
  await engine.executeRaw(`UPDATE persistence_effects SET state='failed',error_code='targets_parked',
    data=data || $2::text::jsonb WHERE request_id=$1::uuid AND kind='git'`,
  [row.id, JSON.stringify({ parked: [{ slug, error_code: 'git_unavailable' }], target_failures: 5 })]);
  return { id: row.id, requestId };
}
const effect = async (id: string) => (await engine.executeRaw<{ state: string; outcome: Record<string, unknown> | null; error_code: string | null }>(
  "SELECT state,outcome,error_code FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [id]))[0];

/** A claimed, durable worktree on a repository that tracks a bare remote; `seed` runs before the first commit. */
async function claimedRepo(name: string, seed: (root: string) => void = () => {}) {
  await registerLocalWriter(engine, 'cli');
  const root = join(home, name); mkdirSync(root);
  await gitAsync(root, 'init', '-q', '-b', 'main');
  await gitAsync(root, 'config', 'user.name', 'Example Writer'); await gitAsync(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'initial.md'), 'Initial\n');
  seed(root);
  await gitAsync(root, 'add', '-A'); await gitAsync(root, 'commit', '-q', '-m', 'Initial');
  const remote = join(home, `${name}.git`);
  await gitAsync(home, 'init', '-q', '--bare', '-b', 'main', remote);
  await gitAsync(root, 'remote', 'add', 'origin', remote); await gitAsync(root, 'push', '-q', '-u', 'origin', 'main');
  const sourceId = `retry-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const binding = await claimWorktree(engine, sourceId, root, localHostId());
  await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled' WHERE worktree_id=$1::uuid", [binding.worktree_id]);
  return { root, remote, sourceId };
}
const isolated = (fn: () => Promise<void>) => () => withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined,
  GBRAIN_DATABASE_URL: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, fn);
const runEffects = async () => {
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git'");
  await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 10 });
};

test('a retried git effect whose target bytes are already committed completes as unchanged and joins the push, without parking', isolated(async () => {
    const { root, remote, sourceId } = await claimedRepo('brain');
    const committed = await write(root, sourceId, 'people/alice-example');
    const pending = await write(root, sourceId, 'people/bob-example');
    await gitAsync(root, 'add', '--', 'people/alice-example.md');
    await gitAsync(root, 'commit', '-q', '-m', 'Commit the parked page by name', '--', 'people/alice-example.md');
    const head = (await gitAsync(root, 'rev-parse', 'HEAD')).trim();
    for (const w of [committed, pending]) expect(await retryParkedEffects(engine, sourceId, w.requestId, false)).toMatchObject({});
    await runEffects();
    expect(await effect(committed.id)).toMatchObject({ state: 'committed', outcome: { git: 'unchanged', push: 'committed' }, error_code: null });
    expect(await effect(pending.id)).toMatchObject({ state: 'committed', outcome: { git: 'committed', push: 'committed' }, error_code: null });
    expect((await gitAsync(root, 'rev-list', '--count', `${head}..HEAD`)).trim()).toBe('1');
    expect((await gitAsync(root, 'status', '--porcelain')).trim()).toBe('');
    expect((await gitAsync(remote, 'rev-parse', 'main')).trim()).toBe((await gitAsync(root, 'rev-parse', 'HEAD')).trim());
}), 120_000);

test('one retried target tracked under a folder an ignore rule now covers does not park its group, whose other targets are already committed', isolated(async () => {
  // The relabel shape: a page tracked before a later .gitignore rule covered its folder.
  const { root, remote, sourceId } = await claimedRepo('ignored', root => {
    mkdirSync(join(root, 'archive')); writeFileSync(join(root, 'archive', 'carol-example.md'), 'Tracked before the rule.\n');
  });
  writeFileSync(join(root, '.gitignore'), 'archive/\n');
  await gitAsync(root, 'add', '.gitignore'); await gitAsync(root, 'commit', '-q', '-m', 'Ignore the archive folder');
  const writes = [await write(root, sourceId, 'people/alice-example'), await write(root, sourceId, 'people/bob-example'), await write(root, sourceId, 'archive/carol-example')];
  await gitAsync(root, 'add', '--', 'people/'); await gitAsync(root, 'commit', '-q', '-m', 'Commit the parked pages by name', '--', 'people/');
  for (const w of writes) await retryParkedEffects(engine, sourceId, w.requestId, false);
  await runEffects();
  const [alice, bob, carol] = await Promise.all(writes.map(w => effect(w.id)));
  expect(alice).toMatchObject({ state: 'committed', outcome: { git: 'unchanged' }, error_code: null });
  expect(bob).toMatchObject({ state: 'committed', outcome: { git: 'unchanged' }, error_code: null });
  expect(carol).toMatchObject({ state: 'committed', outcome: { git: 'committed' }, error_code: null });
  expect((await gitAsync(root, 'show', 'HEAD:archive/carol-example.md'))).toContain('After');
  expect((await gitAsync(root, 'status', '--porcelain')).trim()).toBe('');
  expect((await gitAsync(remote, 'rev-parse', 'main')).trim()).toBe((await gitAsync(root, 'rev-parse', 'HEAD')).trim());
}), 120_000);

test('a push the secret scan holds keeps the effect commit standing and leaves nothing staged', isolated(async () => {
  const { root, remote, sourceId } = await claimedRepo('scan');
  const tip = (await gitAsync(remote, 'rev-parse', 'main')).trim();
  // A script's plain commit below the effect's adds a value that looks like a token, so the effect's push is held.
  mkdirSync(join(root, 'notes')); writeFileSync(join(root, 'notes', 'script.md'), `token: ghp_${'Zt4q'.repeat(9)}\n`);
  await gitAsync(root, 'add', 'notes/script.md'); await gitAsync(root, 'commit', '-q', '-m', 'A script commit');
  const w = await write(root, sourceId, 'people/alice-example');
  await retryParkedEffects(engine, sourceId, w.requestId, false);
  await runEffects();
  const [held] = await engine.executeRaw<{ data: { parked?: { error_code: string }[] } }>("SELECT data FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [w.id]);
  expect(held!.data.parked).toEqual([expect.objectContaining({ error_code: 'publish_secret_found' })]);
  expect(await gitAsync(root, 'show', 'HEAD:people/alice-example.md')).toContain('After');
  expect((await gitAsync(root, 'status', '--porcelain')).trim()).toBe('');
  expect((await gitAsync(remote, 'rev-parse', 'main')).trim()).toBe(tip);
}), 120_000);
