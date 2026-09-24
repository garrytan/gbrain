import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { acquireWorktree, claimWorktree } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { publicEffectsForRequest } from '../src/core/persistence/effect-journal.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { git, gitFixture } from './helpers/git-publication.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

let engine: BrainEngine;
let closePostgres: (() => Promise<void>) | undefined;
const fixtures: ReturnType<typeof gitFixture>[] = [];
const hostId = localHostId();
const config: GBrainConfig = { engine: 'pglite', embedding_disabled: true };
const page = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
beforeAll(async () => {
  const f = gitFixture(); fixtures.push(f);
  if (process.env.GBRAIN_TEST_REQUIRE_CASE_INSENSITIVE === '1') expect(f.caseInsensitive).toBe(true);
  console.log(`Native publication fixture: platform=${process.platform} caseInsensitive=${f.caseInsensitive}`);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engine = pg.engine; closePostgres = pg.close;
  } else {
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  }
  config.engine = engine.kind;
  console.log(`Publication journal engine: ${engine.kind}`);
  await registerLocalWriter(engine, 'cli');
}, 120_000);
afterAll(async () => {
  try { if (closePostgres) await closePostgres(); else await engine?.disconnect(); }
  finally { for (const f of fixtures) f.cleanup(); }
});

async function fixture() {
  const f = gitFixture(); fixtures.push(f);
  const sourceId = `publication-${randomUUID()}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, f.root]);
  const binding = await claimWorktree(engine, sourceId, f.root, hostId);
  const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId,
    logger: { info() {}, warn() {}, error() {} } };
  return { ...f, sourceId, binding, ctx };
}

async function publish(f: Awaited<ReturnType<typeof fixture>>, slug: string, options: { oldPath?: string; deletion?: boolean } = {}) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: f.sourceId });
  const authority = await submissionAuthority(f.ctx, 'put_page', f.sourceId, f.binding.source_incarnation, slug);
  const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: f.sourceId,
    sourceIncarnation: f.binding.source_incarnation, slug, pageId: snapshot?.page.id ?? null, requestId: randomUUID(),
    callerIntent: { content: 'Published' }, intent: { content: 'Published' }, worktreeId: f.binding.worktree_id,
    topologyGeneration: f.binding.topology_generation });
  const row = (await claimNextWrite(engine, hostId))!;
  expect(row.id).toBe(admitted.id);
  const content = options.deletion ? null : 'Published\n';
  const file = options.oldPath ? { root: f.root, path: join(f.root, options.oldPath), content }
    : (await prepareFileTarget(engine, row, snapshot, content, hostId))!;
  const result = await publishMutation(engine, row, { observedRevision: snapshot?.revision ?? null, file,
    apply: async tx => {
      await tx.putPage(slug, page('Published'), { sourceId: f.sourceId });
      if (options.deletion) await tx.softDeletePage(slug, { sourceId: f.sourceId });
      return { status: options.deletion ? 'soft_deleted' : 'created_or_updated' };
    } }, hostId);
  expect(result.state).toBe('committed');
  const receipt = await getWriteRequestById(engine, row.id);
  const [effect] = await engine.executeRaw<{ id: string; data: Record<string, unknown> }>(
    "SELECT id,data FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [row.id]);
  return { row, receipt, effect, file };
}

async function run(id: string) {
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour'");
  await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [id]);
  await runPersistenceEffects(engine, config, { hostId, limit: 1 });
  return (await engine.executeRaw<{ id: string; request_id: string; attempts: number; state: string; error_code: string | null;
    data: Record<string, unknown>; outcome: Record<string, unknown> | null }>(
    'SELECT id,request_id,attempts,state,error_code,data,outcome FROM persistence_effects WHERE id=$1', [id]))[0];
}

function expectBlob(f: Awaited<ReturnType<typeof fixture>>, path: string) {
  expect(git(f.root, 'show', `HEAD:${path}`)).toBe('Published\n');
  expect(git(f.remote, 'show', `refs/heads/main:${path}`)).toBe('Published\n');
}

test('new-page preparation and journal publication use actual native directory spelling', async () => {
  const f = await fixture();
  const { file, row, receipt, effect } = await publish(f, 'notes/new');
  const target = f.caseInsensitive ? 'Notes/new.md' : 'notes/new.md';
  expect(await run(effect.id)).toMatchObject({ state: 'committed', outcome: { git: 'committed', push: 'committed' } });
  expectBlob(f, target);
  expect(git(f.remote, 'ls-tree', '-r', '-z', '--name-only', 'refs/heads/main').split('\0').filter(Boolean).sort())
    .toEqual(['initial.md', target].sort());
  expect(git(f.root, 'diff', '--cached', '--name-only')).toBe('');
  expect(relative(f.root, file.path).split(sep).join('/')).toBe(target);
  expect(effect.data.relative_path).toBe(target);
  expect(await getWriteRequestById(engine, row.id)).toEqual(receipt);
});

test('already recorded spelling is resolved before preparing an existing page', async () => {
  const f = await fixture(); const slug = 'notes/old';
  await engine.putPage(slug, page('Before'), { sourceId: f.sourceId });
  const recorded = f.caseInsensitive ? 'notes/old.md' : 'Notes/Old.md';
  await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', [recorded, f.sourceId, slug]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: f.sourceId }))!;
  writeFileSync(join(f.root, 'Notes', 'Old.md'), serializePageToMarkdown(snapshot.page, snapshot.tags));
  const { file, effect } = await publish(f, slug);
  expect(relative(f.root, file.path).split(sep).join('/')).toBe('Notes/Old.md');
  expect(await run(effect.id)).toMatchObject({ state: 'committed', outcome: { git: 'committed', push: 'committed' } });
  expectBlob(f, 'Notes/Old.md');
  expect((await engine.readPageSnapshot(slug, { sourceId: f.sourceId }))!.page.source_path).toBe(recorded);
});

test('old queued targets resolve at execution without changing their frozen data or receipt', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'Notes', 'old.md'), 'Before\n');
  git(f.root, 'add', 'Notes/old.md'); git(f.root, '-c', 'core.hooksPath=', 'commit', '-m', 'Old target');
  writeFileSync(join(f.root, 'unrelated.md'), 'Staged\n'); git(f.root, 'add', 'unrelated.md');
  const index = git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md');
  const { row, receipt, effect } = await publish(f, 'notes/old', { oldPath: f.caseInsensitive ? 'notes/old.md' : 'Notes/old.md' });
  expect(await run(effect.id)).toMatchObject({ state: 'committed', data: effect.data, outcome: { git: 'committed', push: 'committed' } });
  expectBlob(f, 'Notes/old.md');
  expect(git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md')).toBe(index);
  expect(git(f.root, 'diff', '--cached', '--name-only', '-z')).toBe('unrelated.md\0');
  expect(await getWriteRequestById(engine, row.id)).toEqual(receipt);
});

test('lost completion acknowledgment reclaims the same Git effect without another commit', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'unrelated.md'), 'Staged\n'); git(f.root, 'add', 'unrelated.md');
  const index = git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md');
  const base = git(f.root, 'rev-parse', 'HEAD').trim();
  const { row, receipt, effect } = await publish(f, 'notes/replay');
  const target = effect.data.relative_path as string;
  await engine.executeRaw(`CREATE FUNCTION test_reject_git_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='git' AND OLD.state='running' AND NEW.state='committed' THEN
        RAISE EXCEPTION 'injected Git completion failure';
      END IF;
      RETURN NEW;
    END $$`);
  try {
    await engine.executeRaw(`CREATE TRIGGER test_reject_git_completion BEFORE UPDATE ON persistence_effects
      FOR EACH ROW EXECUTE FUNCTION test_reject_git_completion()`);
    expect(await run(effect.id)).toMatchObject({ id: effect.id, request_id: row.id, attempts: 1,
      state: 'queued', error_code: 'effect_unavailable', outcome: null, data: effect.data });
    expectBlob(f, target);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(git(f.remote, 'rev-parse', 'refs/heads/main'));
    expect(git(f.root, 'rev-list', '--count', `${base}..HEAD`)).toBe('1\n');
    expect(git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md')).toBe(index);
    expect(await getWriteRequestById(engine, row.id)).toEqual(receipt);
    expect((await publicEffectsForRequest(engine, row.id)).find(item => item.kind === 'git'))
      .toEqual({ kind: 'git', state: 'queued', reason: 'effect_unavailable' });
  } finally {
    await engine.executeRaw('DROP TRIGGER IF EXISTS test_reject_git_completion ON persistence_effects');
    await engine.executeRaw('DROP FUNCTION test_reject_git_completion()');
  }
  const committed = git(f.root, 'rev-parse', 'HEAD');
  expect(await run(effect.id)).toMatchObject({ id: effect.id, request_id: row.id, attempts: 2,
    state: 'committed', error_code: null, data: effect.data, outcome: { git: 'unchanged', push: 'committed' } });
  expectBlob(f, target);
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(committed);
  expect(git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(committed);
  expect(git(f.remote, 'rev-list', '--count', `${base}..refs/heads/main`)).toBe('1\n');
  expect(git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md')).toBe(index);
  expect(git(f.root, 'diff', '--cached', '--name-only', '-z')).toBe('unrelated.md\0');
  expect(await getWriteRequestById(engine, row.id)).toEqual(receipt);
  expect((await publicEffectsForRequest(engine, row.id)).find(item => item.kind === 'git'))
    .toEqual({ kind: 'git', state: 'committed', push: 'committed' });
  expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [row.id]))
    .toEqual([{ id: effect.id }]);
});

test('a rejected journal push retains its local commit and retries the same effect', async () => {
  const f = await fixture();
  const base = git(f.root, 'rev-parse', 'HEAD').trim();
  git(f.remote, 'config', 'receive.denyNonFastForwards', 'true');
  writeFileSync(join(f.root, 'remote-only.md'), 'Remote ahead\n'); git(f.root, 'add', 'remote-only.md');
  git(f.root, '-c', 'core.hooksPath=', 'commit', '-m', 'Remote ahead'); git(f.root, 'push');
  const remoteHead = git(f.remote, 'rev-parse', 'refs/heads/main');
  git(f.root, 'reset', '--hard', base);
  writeFileSync(join(f.root, 'unrelated.md'), 'Staged\n'); git(f.root, 'add', 'unrelated.md');
  const index = git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md');
  const { row, receipt, effect } = await publish(f, 'notes/rejected');
  const target = effect.data.relative_path as string;
  expect(await run(effect.id)).toMatchObject({ id: effect.id, request_id: row.id, attempts: 1,
    state: 'queued', error_code: 'git_push_unavailable', outcome: null, data: effect.data });
  const committed = git(f.root, 'rev-parse', 'HEAD');
  expect(git(f.root, 'show', `HEAD:${target}`)).toBe('Published\n');
  expect(git(f.root, 'rev-list', '--count', `${base}..HEAD`)).toBe('1\n');
  expect(git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(remoteHead);
  expect(git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('initial.md\nremote-only.md\n');
  expect(git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md')).toBe(index);
  expect(await getWriteRequestById(engine, row.id)).toEqual(receipt);
  expect((await publicEffectsForRequest(engine, row.id)).find(item => item.kind === 'git'))
    .toEqual({ kind: 'git', state: 'queued', reason: 'git_push_unavailable' });
  git(f.remote, 'update-ref', 'refs/heads/main', base);
  expect(await run(effect.id)).toMatchObject({ id: effect.id, request_id: row.id, attempts: 2,
    state: 'committed', error_code: null, data: effect.data, outcome: { git: 'unchanged', push: 'committed' } });
  expectBlob(f, target);
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(committed);
  expect(git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(committed);
  expect(git(f.remote, 'rev-list', '--count', `${base}..refs/heads/main`)).toBe('1\n');
  expect(git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md')).toBe(index);
  expect(git(f.root, 'diff', '--cached', '--name-only', '-z')).toBe('unrelated.md\0');
  expect(await getWriteRequestById(engine, row.id)).toEqual(receipt);
  expect((await publicEffectsForRequest(engine, row.id)).find(item => item.kind === 'git'))
    .toEqual({ kind: 'git', state: 'committed', push: 'committed' });
});

test('mixed-case captured file URI publishes its exact bound file through the journal', async () => {
  const f = await fixture(); const slug = 'notes/captured-uri';
  const target = join(f.root, 'Notes', 'Captured Note.md');
  const uri = pathToFileURL(f.caseInsensitive ? join(f.root, 'notes', 'captured note.md') : target).href;
  await engine.putPage(slug, page('Before capture'), { sourceId: f.sourceId });
  await engine.executeRaw('UPDATE pages SET source_uri=$1 WHERE source_id=$2 AND slug=$3', [uri, f.sourceId, slug]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: f.sourceId }))!;
  const before = serializePageToMarkdown(snapshot.page, snapshot.tags); writeFileSync(target, before);
  const fallback = join(f.root, `${slug}.md`); mkdirSync(dirname(fallback), { recursive: true }); writeFileSync(fallback, 'Unrelated fallback\n');
  const { row, receipt, effect, file } = await publish(f, slug);
  expect(file).toMatchObject({ root: f.root, path: target, expectedBeforeHash: sha256(before) });
  expect(effect.data).toMatchObject({ relative_path: 'Notes/Captured Note.md', expected_hash: sha256('Published\n') });
  expect(await run(effect.id)).toMatchObject({ id: effect.id, request_id: row.id,
    state: 'committed', data: effect.data, outcome: { git: 'committed', push: 'committed' } });
  expectBlob(f, 'Notes/Captured Note.md');
  expect(git(f.remote, 'ls-tree', '-r', '-z', '--name-only', 'refs/heads/main')).toBe('Notes/Captured Note.md\0initial.md\0');
  expect(readFileSync(fallback, 'utf8')).toBe('Unrelated fallback\n');
  expect((await engine.readPageSnapshot(slug, { sourceId: f.sourceId }))!.page.source_uri).toBe(uri);
  expect(await getWriteRequestById(engine, row.id)).toEqual(receipt);
});

test('real Git effect keeps glob neighbors staged and out of the remote', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'a1.md'), 'Unrelated\n'); git(f.root, 'add', 'a1.md');
  const index = git(f.root, 'ls-files', '--stage', '-z', '--', 'a1.md');
  const { effect } = await publish(f, 'bracketed', { oldPath: 'a[1].md' });
  expect(await run(effect.id)).toMatchObject({ state: 'committed', outcome: { git: 'committed', push: 'committed' } });
  expectBlob(f, 'a[1].md');
  expect(git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('a[1].md\ninitial.md\n');
  expect(git(f.root, 'ls-files', '--stage', '-z', '--', 'a1.md')).toBe(index);
});

test('queued Git work respects the native owner lock and expected file hash', async () => {
  const f = await fixture();
  const { effect, file } = await publish(f, 'notes/guarded');
  const lock = (await acquireWorktree(f.binding))!;
  expect(lock).not.toBeNull();
  try { expect(await run(effect.id)).toMatchObject({ state: 'queued', error_code: 'writer_busy' }); }
  finally { await lock.release(); }
  writeFileSync(file.path, 'External edit\n');
  const index = readFileSync(join(f.root, '.git', 'index'));
  expect(await run(effect.id)).toMatchObject({ state: 'committed', outcome: { git: 'superseded' } });
  expect(git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('initial.md\n');
  expect(readFileSync(join(f.root, '.git', 'index'))).toEqual(index);
});

test('root replacement refuses queued work without changing canonical receipts', async () => {
  const f = await fixture();
  const { effect, row, receipt } = await publish(f, 'notes/replaced');
  const displaced = join(f.home, 'displaced'); renameSync(f.root, displaced); mkdirSync(f.root);
  const result = await run(effect.id);
  expect(result.state).toBe('queued');
  expect(result.error_code).toBe('recovery_required');
  expect(git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('initial.md\n');
  expect(await getWriteRequestById(engine, row.id)).toEqual(receipt);
});

for (const staged of [false, true]) test(`old queued deletion refuses an unprovable spelling without rewriting its identity (staged=${staged})`, async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'Notes', 'Old.md'), 'Tracked\n');
  git(f.root, 'add', 'Notes/Old.md'); git(f.root, '-c', 'core.hooksPath=', 'commit', '-m', 'Tracked target'); git(f.root, 'push');
  rmSync(join(f.root, 'Notes', 'Old.md'));
  if (staged) git(f.root, 'add', '-u', '--', 'Notes/Old.md');
  const { effect, row, receipt } = await publish(f, 'notes/old', { oldPath: 'Notes/old.md', deletion: true });
  const head = git(f.root, 'rev-parse', 'HEAD');
  const index = readFileSync(join(f.root, '.git', 'index'));
  expect(await run(effect.id)).toMatchObject({ state: 'queued', error_code: 'git_target_unsafe', data: effect.data });
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head);
  expect(readFileSync(join(f.root, '.git', 'index'))).toEqual(index);
  expect(git(f.remote, 'show', 'refs/heads/main:Notes/Old.md')).toBe('Tracked\n');
  expect(await getWriteRequestById(engine, row.id)).toEqual(receipt);
});

test('queued Git target cannot escape through a replaced ancestor symlink', async () => {
  const f = await fixture();
  const { effect, row, receipt, file } = await publish(f, 'notes/escape');
  const external = join(f.home, 'external'); mkdirSync(external); writeFileSync(join(external, 'escape.md'), 'Published\n');
  rmSync(dirname(file.path), { recursive: true });
  symlinkSync(external, dirname(file.path), process.platform === 'win32' ? 'junction' : 'dir');
  const index = readFileSync(join(f.root, '.git', 'index'));
  expect(await run(effect.id)).toMatchObject({ state: 'queued', error_code: 'source_changed', data: effect.data });
  expect(readFileSync(join(external, 'escape.md'), 'utf8')).toBe('Published\n');
  expect(readFileSync(join(f.root, '.git', 'index'))).toEqual(index);
  expect(await getWriteRequestById(engine, row.id)).toEqual(receipt);
});

test('native ambiguous old queued alias refuses without choosing a hardlink', async () => {
  const f = await fixture();
  if (!f.caseInsensitive) return;
  const { effect, row, receipt, file } = await publish(f, 'notes/old', { oldPath: 'notes/old.md' });
  renameSync(file.path, join(f.root, 'Notes', 'temporary.md'));
  renameSync(join(f.root, 'Notes', 'temporary.md'), join(f.root, 'Notes', 'Old.md'));
  linkSync(join(f.root, 'Notes', 'Old.md'), join(f.root, 'Notes', 'Other.md'));
  const index = readFileSync(join(f.root, '.git', 'index'));
  expect(await run(effect.id)).toMatchObject({ state: 'queued', error_code: 'git_target_unsafe', data: effect.data });
  expect(git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('initial.md\n');
  expect(readFileSync(join(f.root, '.git', 'index'))).toEqual(index);
  expect(await getWriteRequestById(engine, row.id)).toEqual(receipt);
});

test.skipIf(process.platform === 'win32')('recorded POSIX literal backslash does not select its slash neighbor', async () => {
  const f = await fixture(); const slug = 'literal';
  await engine.putPage(slug, page('Before'), { sourceId: f.sourceId });
  await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', ['literal\\page.md', f.sourceId, slug]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: f.sourceId }))!;
  writeFileSync(join(f.root, 'literal\\page.md'), serializePageToMarkdown(snapshot.page, snapshot.tags));
  const neighbor = join(f.root, 'literal', 'page.md'); mkdirSync(dirname(neighbor)); writeFileSync(neighbor, 'Unrelated\n');
  const { effect } = await publish(f, slug);
  expect(await run(effect.id)).toMatchObject({ state: 'committed', outcome: { git: 'committed', push: 'committed' } });
  expectBlob(f, 'literal\\page.md');
  expect(readFileSync(neighbor, 'utf8')).toBe('Unrelated\n');
});
