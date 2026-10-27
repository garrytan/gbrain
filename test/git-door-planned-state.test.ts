/**
 * The door commits exactly its planned state (src/core/persistence/git-door.ts, gbrain#7705). Protects:
 *   - D1: a target's change staged before the write is never overwritten: the publication refuses git_index_conflict,
 *     the index still names the staged blob, and HEAD, the row and the file keep the prior revision (red before: the
 *     door's index refresh wrote its own blob over the staged one);
 *   - D2: the same for a change staged while the publication runs (after its file is renamed into place);
 *   - D4: a disk edit landing during the publication is never committed: it refuses git_target_changed, HEAD and the
 *     row keep the prior revision, and recovery holds the edited file as it is (red before: HEAD held the edit while the
 *     row recorded the publication's content);
 *   - D4's recovery record pauses every later write of the worktree until `gbrain repair stuck-recovery --keep disk`
 *     resolves it: the human's bytes stay on disk, the write ends failed, the queued write publishes, Git and the row
 *     keep the prior revision until the edit is committed, and a sync then imports it;
 *   - a stale entry an interrupted refresh left (the version before the door's last commit) is restored by the next
 *     write, whose receipt names the path (`persistence.git_index_restored`) and which emits the `git_index_restored` notice;
 *   - with no interference the planned blob commits and the index and status are clean;
 *   - plumbing: a file rewritten between plan and commit refuses with nothing committed or staged; a change staged
 *     after the pre-commit check and before the index refresh is left staged and the refusal says the commit landed; an
 *     entry still holding the parent's version (a landed commit whose index refresh failed) counts as clean, so the next
 *     changed write and a replay already at HEAD both refresh it, while any other staged entry refuses (red before: the
 *     next changed write refused git_index_conflict until someone ran git restore --staged).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { publishMutation, type PublicationHooks } from '../src/core/persistence/coordinator.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { commitThroughDoor, doorSeams, indexRestoredNotice } from '../src/core/persistence/git-door.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readHeadBlockers } from '../src/core/persistence/head-blocker.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { maintenancePreflight, publishMaintenancePages } from '../src/core/persistence/prepared-maintenance.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const refusal = (work: Promise<unknown>) => work.then(() => null, (error: { code?: string; message?: string }) => error);

const SLUG = 'notes/probe';
const FILE = `${SLUG}.md`;
const page = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\nA small single-file page body.\n`;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const putPage = operations.find(op => op.name === 'put_page')!;

/** A strict source holding one committed page titled First. */
async function committedPage(engine: BrainEngine, ctx: OperationContext): Promise<void> {
  await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
  expect(await putPage.handler(ctx, { slug: SLUG, content: page('First'), request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
  await settleManagedGitEffects(engine);
}

/** One put_page publication of `content` through the door, with the coordinator's boundary hooks. */
async function publish(engine: BrainEngine, ctx: OperationContext, content: string, hooks: PublicationHooks = {}) {
  await disposePersistenceConsumer(engine);
  const host = localHostId(), binding = (await getWorktreeBinding(engine, 'default', host))!, old = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', binding.source_incarnation, SLUG);
  const intent = { slug: SLUG, content, expected_revision: old.revision };
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: binding.source_incarnation,
    slug: SLUG, pageId: old.page.id, requestId: randomUUID(), callerIntent: intent, intent, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  return publishNext(engine, ctx, hooks);
}

/** Claims and publishes the next queued write of this host. */
async function publishNext(engine: BrainEngine, ctx: OperationContext, hooks: PublicationHooks = {}) {
  const host = localHostId(), row = (await claimNextWrite(engine, host))!;
  return publishMutation(engine, row, await preparePageMutation(engine, row, ctx.config), host, hooks);
}

/** `gbrain repair <args>` in this process, returning what it printed. */
async function repairCli(engine: BrainEngine, args: string[]): Promise<string> {
  let printed = '';
  const original = console.log;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  try { await runRepairCommand(engine, args); } finally { console.log = original; }
  return printed;
}

/** Where the page stands afterwards: the row's title, HEAD's and the disk's title lines, and the index entry's blob. */
async function standing(engine: BrainEngine, root: string) {
  const title = (text: string) => /^title: (.*)$/m.exec(text)?.[1];
  return {
    row: (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.page.title,
    head: title(git(root, 'show', `HEAD:${FILE}`)),
    disk: title(readFileSync(join(root, FILE), 'utf8')),
    index: git(root, 'rev-parse', `:${FILE}`),
  };
}

for (const backend of testBackends()) describe(`[${backend}] the door commits only its planned state`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('D1: a change staged before the write is not overwritten; the write refuses git_index_conflict', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedPage(engine, ctx);
    const head = git(root, 'rev-parse', 'HEAD'), original = readFileSync(join(root, FILE), 'utf8');
    writeFileSync(join(root, FILE), original.replace('title: First', 'title: USER STAGED EDIT'));
    git(root, 'add', FILE);
    const userOid = git(root, 'rev-parse', `:${FILE}`);
    writeFileSync(join(root, FILE), original);
    const result = await publish(engine, ctx, page('Second'));
    expect(result).toMatchObject({ state: 'failed', error_code: 'git_index_conflict' });
    expect(await standing(engine, root)).toEqual({ row: 'First', head: 'First', disk: 'First', index: userOid });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  }, { databaseUrl, setup }), 120_000);

  test('D2: a change staged during the publication is not overwritten; the write refuses git_index_conflict', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedPage(engine, ctx);
    const head = git(root, 'rev-parse', 'HEAD');
    let userOid = '';
    const result = await publish(engine, ctx, page('Second'), { boundary: async name => {
      if (name !== 'after_publication') return;
      const disk = readFileSync(join(root, FILE), 'utf8');
      writeFileSync(join(root, FILE), disk.replace('title: Second', 'title: USER STAGED EDIT'));
      git(root, 'add', FILE);
      userOid = git(root, 'rev-parse', `:${FILE}`);
      writeFileSync(join(root, FILE), disk);
    } });
    expect(result).toMatchObject({ state: 'failed', error_code: 'git_index_conflict' });
    expect(await standing(engine, root)).toEqual({ row: 'First', head: 'First', disk: 'First', index: userOid });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  }, { databaseUrl, setup }), 120_000);

  test('D4: a disk edit during the publication is not committed; it refuses git_target_changed and recovery holds the file', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedPage(engine, ctx);
    const head = git(root, 'rev-parse', 'HEAD'), committed = git(root, 'rev-parse', `HEAD:${FILE}`);
    const result = await publish(engine, ctx, page('Second'), { boundary: async name => {
      if (name !== 'after_publication') return;
      writeFileSync(join(root, FILE), readFileSync(join(root, FILE), 'utf8').replace('title: Second', 'title: USER DISK EDIT'));
    } });
    expect(result).toMatchObject({ state: 'recovering', error_code: 'git_target_changed', blocked_reason: 'unexpected_file_bytes' });
    expect(await standing(engine, root)).toEqual({ row: 'First', head: 'First', disk: 'USER DISK EDIT', index: committed });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'status', '--porcelain')).toBe(`M ${FILE}`);
  }, { databaseUrl, setup }), 120_000);

  test('D4 resolution: the record pauses later writes; repair stuck-recovery --keep disk frees them, keeps the edit, and a commit of it syncs in', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedPage(engine, ctx);
    const d4 = await publish(engine, ctx, page('Second'), { boundary: async name => {
      if (name !== 'after_publication') return;
      writeFileSync(join(root, FILE), readFileSync(join(root, FILE), 'utf8').replace('title: Second', 'title: USER DISK EDIT'));
    } });
    expect(d4).toMatchObject({ state: 'recovering', error_code: 'git_target_changed', blocked_reason: 'unexpected_file_bytes' });
    const pending = await putPage.handler(ctx, { slug: 'notes/other', content: page('Other'), request_id: randomUUID(), wait_ms: 200 })
      .then(() => null, (error: { code?: string; writeRequest?: { request_id: string } }) => error);
    expect(pending).toMatchObject({ code: 'write_pending' });
    await disposePersistenceConsumer(engine);
    const [{ id: later }] = await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id=$1::uuid', [pending!.writeRequest!.request_id]);
    expect((await readHeadBlockers(engine, [later!], localHostId())).get(later!)).toMatchObject({ status: 'blocked',
      blocker: { predicate: 'request_recovery', ids: [d4.request_id], state: 'unexpected_file_bytes', intervention: true, file: { slug: SLUG } } });

    const preview = await repairCli(engine, ['stuck-recovery', '--source', 'default', '--json']);
    const hash = /"preview_hash": "([0-9a-f]{64})"/.exec(preview)![1]!;
    const applied = await repairCli(engine, ['stuck-recovery', '--source', 'default', '--keep', 'disk', '--apply', '--expect', hash, '--yes', '--json']);
    expect(applied).toContain('"resolved": 1');
    expect(await getWriteRequestById(engine, d4.id)).toMatchObject({ state: 'failed', error_code: 'git_target_changed', recovery: null });
    expect((await readHeadBlockers(engine, [later!], localHostId())).get(later!)).toEqual({ status: 'claimable' });
    expect(await publishNext(engine, ctx)).toMatchObject({ id: later, state: 'committed' });

    expect(['first_sync', 'synced', 'up_to_date']).toContain((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status);
    const head = git(root, 'rev-parse', `HEAD:${FILE}`);
    expect(await standing(engine, root)).toEqual({ row: 'First', head: 'First', disk: 'USER DISK EDIT', index: head });
    expect(git(root, 'status', '--porcelain')).toBe(`M ${FILE}`);

    git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Keep the edit', '--', FILE);
    expect(['synced', 'up_to_date']).toContain((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status);
    expect(await standing(engine, root)).toEqual({ row: 'USER DISK EDIT', head: 'USER DISK EDIT', disk: 'USER DISK EDIT', index: git(root, 'rev-parse', `HEAD:${FILE}`) });
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 180_000);

  test('D4 resolution: repair stuck-recovery --keep prior writes the committed bytes back, ends the write failed and frees later writes', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedPage(engine, ctx);
    const head = git(root, 'rev-parse', 'HEAD'), committed = git(root, 'rev-parse', `HEAD:${FILE}`);
    const d4 = await publish(engine, ctx, page('Second'), { boundary: async name => {
      if (name !== 'after_publication') return;
      writeFileSync(join(root, FILE), readFileSync(join(root, FILE), 'utf8').replace('title: Second', 'title: USER DISK EDIT'));
    } });
    expect(d4).toMatchObject({ state: 'recovering', error_code: 'git_target_changed', blocked_reason: 'unexpected_file_bytes' });
    const preview = await repairCli(engine, ['stuck-recovery', '--source', 'default', '--json']);
    const hash = /"preview_hash": "([0-9a-f]{64})"/.exec(preview)![1]!;
    const applied = await repairCli(engine, ['stuck-recovery', '--source', 'default', '--keep', 'prior', '--apply', '--expect', hash, '--yes', '--json']);
    expect(applied).toContain('"resolved": 1');
    expect(await getWriteRequestById(engine, d4.id)).toMatchObject({ state: 'failed', error_code: 'git_target_changed', recovery: null });
    expect(await standing(engine, root)).toEqual({ row: 'First', head: 'First', disk: 'First', index: committed });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(await publish(engine, ctx, page('Third'))).toMatchObject({ state: 'committed' });
    expect(await standing(engine, root)).toEqual({ row: 'Third', head: 'Third', disk: 'Third', index: git(root, 'rev-parse', `HEAD:${FILE}`) });
  }, { databaseUrl, setup }), 180_000);

  test('a stale index entry from an interrupted door refresh is restored, and the receipt and notice name the path', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedPage(engine, ctx);
    expect(await publish(engine, ctx, page('Second'))).toMatchObject({ state: 'committed' });
    git(root, 'update-index', '--cacheinfo', `100644,${git(root, 'rev-parse', `HEAD^:${FILE}`)},${FILE}`);
    const notices: Notice[] = [];
    const result = await putPage.handler({ ...ctx, emitNotice: notice => notices.push(notice) }, { slug: SLUG, content: page('Third'),
      expected_revision: (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision, request_id: randomUUID(), wait_ms: 30_000 }) as Record<string, any>;
    expect(result).toMatchObject({ state: 'committed', persistence: { git_state: 'committed', git_commit: git(root, 'rev-parse', 'HEAD'), git_index_restored: [FILE] } });
    expect(notices.filter(notice => notice.code === 'git_index_restored')).toEqual([{ code: 'git_index_restored', kind: 'info',
      why: expect.stringContaining(`restored index to HEAD after an interrupted door refresh for ${FILE}`) }]);
    expect(await standing(engine, root)).toEqual({ row: 'Third', head: 'Third', disk: 'Third', index: git(root, 'rev-parse', `HEAD:${FILE}`) });
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);

  test('with no interference the planned blob commits, and the index and status are clean', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedPage(engine, ctx);
    const result = await publish(engine, ctx, page('Second'));
    expect(result).toMatchObject({ state: 'committed' });
    expect(result.outcome).toMatchObject({ persistence: { git_state: 'committed', git_commit: git(root, 'rev-parse', 'HEAD') } });
    expect(await standing(engine, root)).toEqual({ row: 'Second', head: 'Second', disk: 'Second', index: git(root, 'rev-parse', `HEAD:${FILE}`) });
    expect(git(root, 'rev-parse', `HEAD:${FILE}`)).toBe(git(root, 'hash-object', '--', FILE));
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);
  // Generated by /ship Step 7 coverage audit (gstack), test-only.
  // Value: protects=a group publication puts git_index_restored on the receipt of the member whose stale entry it restored, and on no other;
  //   fails_when=group-publish.ts drops onIndexRestored or maps the restored path to the wrong member; why_new=the stale-entry test above runs the
  //   single-write path (coordinator.ts) only; seam=none; no_claim=PGLite never forms publication groups, so this runs on the Postgres arm only
  if (backend === 'postgres') test('a group publication names the restored path on that member\'s receipt only', () => managedBrain(async ({ engine, ctx, root }) => {
    await committedPage(engine, ctx);
    expect(await putPage.handler(ctx, { slug: 'notes/other', content: page('Other'), request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
    expect(await publish(engine, ctx, page('Second'))).toMatchObject({ state: 'committed' });
    git(root, 'update-index', '--cacheinfo', `100644,${git(root, 'rev-parse', `HEAD^:${FILE}`)},${FILE}`);
    const maintenance = (await maintenancePreflight(engine, 'default', root))!;
    const revision = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    const outcomes = await publishMaintenancePages(engine, maintenance, [
      { slug: SLUG, content: page('Third'), expectedRevision: await revision(SLUG) },
      { slug: 'notes/other', content: page('Other two'), expectedRevision: await revision('notes/other') }]);
    const [mine, other] = outcomes.map(outcome => ('receipt' in outcome ? outcome.receipt : { error: outcome.error }) as Record<string, any>);
    const head = git(root, 'rev-parse', 'HEAD');
    expect(mine).toMatchObject({ state: 'committed', persistence: { git_state: 'committed', git_commit: head, git_index_restored: [FILE] } });
    expect(other).toMatchObject({ state: 'committed', persistence: { git_state: 'committed', git_commit: head } });
    expect(other!.persistence.git_index_restored).toBeUndefined();
    expect(await standing(engine, root)).toEqual({ row: 'Third', head: 'Third', disk: 'Third', index: git(root, 'rev-parse', `HEAD:${FILE}`) });
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup }), 120_000);
});

const OLD = new Date('2001-01-01T00:00:00Z');
const roots: string[] = [];
afterEach(() => { delete doorSeams.beforeUpdateRef; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-door-plan-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (const [path, body] of Object.entries(files)) put(root, path, body);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  return root;
}
function put(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
  utimesSync(join(root, path), OLD, OLD);
}
/** Writes `body` at `path` and commits it through the door with that plan. */
const publishAt = (root: string, path: string, body: string) => { put(root, path, body); return commitThroughDoor(root, [{ path: join(root, path), planned: sha256(body) }]); };

describe('door plumbing: the planned state', () => {
  test('a file rewritten after it was planned refuses git_target_changed; nothing is committed or staged', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    const head = git(root, 'rev-parse', 'HEAD');
    put(root, 'notes/a.md', 'someone else\n');
    put(root, 'notes/new.md', 'someone else\n');
    for (const [path, planned] of [['notes/a.md', sha256('planned\n')], ['notes/new.md', sha256('planned\n')], ['notes/a.md', null]] as const) {
      expect(await refusal(commitThroughDoor(root, [{ path: join(root, path), planned }]))).toMatchObject({ code: 'git_target_changed', message: expect.stringContaining(path) });
    }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(root, 'ls-files', '--', 'notes/new.md')).toBe('');
  });

  test('a staged change of a target refuses git_index_conflict before the commit; the index keeps it', async () => {
    const root = repo({ 'notes/a.md': 'a\n', 'notes/b.md': 'b\n' });
    const head = git(root, 'rev-parse', 'HEAD');
    put(root, 'notes/b.md', 'staged\n'); git(root, 'add', 'notes/b.md');
    const staged = git(root, 'rev-parse', ':notes/b.md');
    put(root, 'notes/b.md', 'b\n');
    const error = await refusal(publishAt(root, 'notes/b.md', 'door\n')) as { code?: string; fix?: { argv?: string[]; verify?: { argv?: string[] } } };
    expect(error).toMatchObject({ code: 'git_index_conflict' });
    expect(error.fix).toMatchObject({ argv: ['git', '-C', root, 'restore', '--staged', '--', 'notes/b.md'], verify: { argv: ['git', '-C', root, 'diff', '--cached', '--name-only', '--', 'notes/b.md'] } });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'rev-parse', ':notes/b.md')).toBe(staged);
    git(root, 'restore', '--staged', '--', 'notes/b.md');
    expect(await publishAt(root, 'notes/b.md', 'door\n')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('a HEAD entry with a legacy group-writable mode (100664) is not a staged change; the write commits', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'legacy\n', env, encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['-C', root, 'hash-object', '-t', 'tree', '--literally', '-w', '--stdin'],
      { input: Buffer.concat([Buffer.from('100664 legacy.md\0'), Buffer.from(blob, 'hex')]), env, encoding: 'utf8' }).trim();
    git(root, 'update-ref', 'refs/heads/main', git(root, 'commit-tree', tree, '-p', 'HEAD', '-m', 'legacy mode'));
    git(root, 'reset', '-q', '--hard');
    expect(git(root, 'ls-files', '-s', '--', 'legacy.md')).toStartWith('100644 ');
    expect(await publishAt(root, 'legacy.md', 'door\n')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'show', 'HEAD:legacy.md')).toBe('door');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('a change staged after the check and before the index refresh is left staged; the refusal says the commit landed', async () => {
    const root = repo({ 'notes/a.md': 'a\n', 'notes/b.md': 'b\n' });
    let staged = '';
    doorSeams.beforeUpdateRef = () => {
      writeFileSync(join(root, 'notes/b.md'), 'staged meanwhile\n'); git(root, 'add', 'notes/b.md');
      staged = git(root, 'rev-parse', ':notes/b.md');
      writeFileSync(join(root, 'notes/b.md'), 'door\n');
    };
    put(root, 'notes/a.md', 'door a\n'); put(root, 'notes/b.md', 'door\n');
    const error = await refusal(commitThroughDoor(root, ['notes/a.md', 'notes/b.md'].map(path => ({ path: join(root, path), planned: sha256(readFileSync(join(root, path))) }))));
    expect(error).toMatchObject({ code: 'git_unavailable', message: expect.stringMatching(/landed, but the index of .* was left as it was for notes\/b\.md: /) });
    expect(git(root, 'show', 'HEAD:notes/b.md')).toBe('door');
    expect(git(root, 'rev-parse', ':notes/b.md')).toBe(staged);
    expect(git(root, 'rev-parse', ':notes/a.md')).toBe(git(root, 'rev-parse', 'HEAD:notes/a.md'));
  });

  test('after a door commit whose index refresh failed, the next changed write to those paths commits and leaves the index clean', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    const lock = join(root, '.git', 'index.lock');
    doorSeams.beforeUpdateRef = () => { writeFileSync(lock, ''); };
    put(root, 'notes/a.md', 'first\n'); put(root, 'notes/new.md', 'first new\n');
    const landed = await refusal(commitThroughDoor(root, ['notes/a.md', 'notes/new.md'].map(path => ({ path: join(root, path), planned: sha256(readFileSync(join(root, path))) }))));
    rmSync(lock);
    delete doorSeams.beforeUpdateRef;
    expect(landed).toMatchObject({ code: 'git_unavailable', message: expect.stringContaining('landed, but the index') });
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('first');
    expect(git(root, 'rev-parse', ':notes/a.md')).toBe(git(root, 'rev-parse', 'HEAD^:notes/a.md'));
    expect(git(root, 'ls-files', '--', 'notes/new.md')).toBe('');
    put(root, 'notes/a.md', 'second\n'); put(root, 'notes/new.md', 'second new\n');
    const restored: string[][] = [];
    const commit = await commitThroughDoor(root, ['notes/a.md', 'notes/new.md'].map(path => ({ path: join(root, path), planned: sha256(readFileSync(join(root, path))) })), undefined, paths => restored.push(paths));
    expect(restored).toEqual([['notes/a.md', 'notes/new.md']]);
    expect(indexRestoredNotice(restored[0]!)).toEqual({ code: 'git_index_restored', kind: 'info',
      why: expect.stringContaining('restored index to HEAD after an interrupted door refresh for notes/a.md, notes/new.md') });
    expect(commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('second');
    expect(git(root, 'show', 'HEAD:notes/new.md')).toBe('second new');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('a file rewritten while hash-object stores it refuses git_target_changed, with nothing committed or staged', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    const head = git(root, 'rev-parse', 'HEAD');
    const bin = mkdtempSync(join(tmpdir(), 'gbrain-git-shim-'));
    roots.push(bin);
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" hash-object -w "*) printf 'edited during hash\\n' > '${join(root, 'notes/a.md')}';; esac\nPATH='${process.env.PATH}' exec '${real}' "$@"\n`, { mode: 0o755 });
    put(root, 'notes/a.md', 'planned\n');
    await withEnv({ PATH: `${bin}:${process.env.PATH}` }, async () => {
      expect(await refusal(commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256('planned\n') }]))).toMatchObject({ code: 'git_target_changed' });
    });
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toBe('edited during hash\n');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  });

  test('a stale entry the door left still counts as its own after other commits land, and the next write to that path restores it', async () => {
    const root = repo({ 'notes/a.md': 'a\n', 'notes/q.md': 'q\n', 'other.md': 'o\n' });
    const lock = join(root, '.git', 'index.lock');
    doorSeams.beforeUpdateRef = () => { writeFileSync(lock, ''); };
    put(root, 'notes/a.md', 'first\n'); put(root, 'notes/new.md', 'first new\n');
    const landed = await refusal(commitThroughDoor(root, ['notes/a.md', 'notes/new.md'].map(path => ({ path: join(root, path), planned: sha256(readFileSync(join(root, path))) }))));
    rmSync(lock);
    delete doorSeams.beforeUpdateRef;
    expect(landed).toMatchObject({ code: 'git_unavailable', message: expect.stringContaining('landed, but the index') });
    const stale = git(root, 'rev-parse', 'HEAD^:notes/a.md');
    put(root, 'notes/q.md', 'q door\n');
    await commitThroughDoor(root, [{ path: join(root, 'notes/q.md'), planned: sha256('q door\n') }]);
    put(root, 'other.md', 'o human\n');
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Human edit', '--', 'other.md');
    expect(git(root, 'rev-parse', ':notes/a.md')).toBe(stale);
    expect(git(root, 'ls-files', '--', 'notes/new.md')).toBe('');
    put(root, 'notes/a.md', 'second\n'); put(root, 'notes/new.md', 'second new\n');
    const restored: string[][] = [];
    const commit = await commitThroughDoor(root, ['notes/a.md', 'notes/new.md'].map(path => ({ path: join(root, path), planned: sha256(readFileSync(join(root, path))) })), undefined, paths => restored.push(paths));
    expect(restored).toEqual([['notes/a.md', 'notes/new.md']]);
    expect(commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('second');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('a commit already at HEAD refreshes an entry holding the parent\'s version and refuses any other staged entry', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    const commit = await publishAt(root, 'notes/a.md', 'door\n');
    git(root, 'update-index', '--cacheinfo', `100644,${git(root, 'rev-parse', `${commit}^:notes/a.md`)},notes/a.md`);
    const restored: string[][] = [];
    expect(await commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256('door\n') }], undefined, paths => restored.push(paths))).toBe(commit);
    expect(restored).toEqual([['notes/a.md']]);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(await commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256('door\n') }], undefined, paths => restored.push(paths))).toBe(commit);
    expect(restored).toHaveLength(1);
    put(root, 'notes/a.md', 'novel\n'); git(root, 'add', 'notes/a.md');
    const novel = git(root, 'rev-parse', ':notes/a.md');
    put(root, 'notes/a.md', 'door\n');
    expect(await refusal(commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256('door\n') }]))).toMatchObject({ code: 'git_index_conflict' });
    expect(git(root, 'rev-parse', ':notes/a.md')).toBe(novel);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(commit!);
  });

  // Generated by /ship Step 7 coverage audit (gstack), test-only.
  // Value: protects=a conflicted (unmerged) target is never committed over or resolved by the door, even when its base stage is HEAD^'s version;
  //   fails_when=readIndex keeps a stage 1-3 entry as a plain entry, so the base stage reads as the door's stale refresh and update-index resolves
  //   the conflict; why_new=only stage-0 staged changes are tested; seam=none; no_claim=the unmerged entry is built with update-index --index-info, not a real merge
  test('an unmerged target refuses git_index_conflict and keeps its stages, also when its base stage is the parent\'s version', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    const commit = await publishAt(root, 'notes/a.md', 'door\n');
    const theirs = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'theirs\n', encoding: 'utf8', env }).trim();
    const stages = [['100644', git(root, 'rev-parse', `${commit}^:notes/a.md`), '1'], ['100644', git(root, 'rev-parse', `${commit}:notes/a.md`), '2'], ['100644', theirs, '3']];
    execFileSync('git', ['-C', root, 'update-index', '--index-info'], { env,
      input: [`0 ${'0'.repeat(40)}\tnotes/a.md`, ...stages.map(([mode, oid, stage]) => `${mode} ${oid} ${stage}\tnotes/a.md`)].join('\n') + '\n' });
    const listed = git(root, 'ls-files', '-s', '--', 'notes/a.md');
    expect(listed.split('\n')).toHaveLength(3);
    for (const body of ['door\n', 'novel\n']) {
      put(root, 'notes/a.md', body);
      const restored: string[][] = [];
      expect(await refusal(commitThroughDoor(root, [{ path: join(root, 'notes/a.md'), planned: sha256(body) }], undefined, paths => restored.push(paths))))
        .toMatchObject({ code: 'git_index_conflict' });
      expect(restored).toEqual([]);
      expect(git(root, 'ls-files', '-s', '--', 'notes/a.md')).toBe(listed);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(commit!);
    }
  });
});
