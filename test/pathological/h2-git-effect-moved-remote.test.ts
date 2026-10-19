/**
 * H-2 (#7010): a Git effect whose push meets a moved remote publishes over it without moving the checkout.
 *
 * Protects: a canonical page write commits in the database and in a local commit of the managed checkout; its Git
 * effect pushes. When another machine pushed to the same branch first, the push is rejected as non-fast-forward.
 * The effect then publishes through the shared keep-checkout publish: the remote commits are merged in memory and
 * the merge is pushed, the effect commits, and the checkout (HEAD and files) stays where it was, so
 * `gbrain sources refresh` stays the only importer of remote files. An effect such a rejection parked before this
 * release goes through `retry-effects <source> --parked-pushes`, which doctor names. When both sides changed the
 * page file, the effect holds with `integrate_conflict`: nothing is pushed, the checkout stays, and doctor and
 * `gbrain sync status` name the user's choice (`--keep-checkout --resolve`); after the choice is pushed the effect
 * commits.
 * Seams: a second clone of the bare remote moves the branch; the publish runs as this checkout's own CLI
 * (GBRAIN_JOB_CHILD_CLI points at src/cli.ts).
 * Fails when: `pushGitRoot` throws `git_push_unavailable` on a non-fast-forward rejection (master before the fix:
 * the effect retries, parks after five failures, and the commits stay on this host), or the recovery advances or
 * merges into the checkout.
 * PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { readSyncStatus } from '../../src/core/persistence/sync-status.ts';
import { commitAndPush } from '../../src/core/git/commit-push.ts';
import { checkParkedEffects } from '../../src/commands/doctor/checks/parked-effects.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { git } from '../helpers/git-publication.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const config = { engine: 'pglite' as const, embedding_disabled: true };
const page = (body: string) => ({ type: 'note', title: 'Acme example', compiled_truth: body.trim(), timeline: '', frontmatter: {} });

interface Brain { engine: BrainEngine; home: string; root: string; remote: string; other: string; sourceId: string; worktreeId: string }

async function brain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-h2-'));
  const cli = join(home, 'gbrain-child');
  writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${resolve(import.meta.dir, '../../src/cli.ts')}' "$@"\n`);
  chmodSync(cli, 0o700);
  try {
    await withEnv({ GBRAIN_HOME: join(home, 'home'), GBRAIN_AUDIT_DIR: join(home, 'audit'), GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined,
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', GBRAIN_JOB_CHILD_CLI: cli }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const remote = join(home, 'remote.git'), root = join(home, 'brain'), other = join(home, 'other');
        git(home, 'init', '-q', '--bare', '-b', 'main', remote);
        mkdirSync(join(root, 'notes'), { recursive: true });
        git(root, 'init', '-q', '-b', 'main');
        git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
        writeFileSync(join(root, 'initial.md'), 'Initial\n');
        git(root, 'add', 'initial.md'); git(root, 'commit', '-q', '-m', 'Initial');
        git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
        git(home, 'clone', '-q', remote, other);
        git(other, 'config', 'user.name', 'Other Machine'); git(other, 'config', 'user.email', 'other@example.invalid');
        await registerLocalWriter(engine, 'cli');
        const sourceId = `h2-${randomUUID().slice(0, 8)}`;
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        const binding = await claimWorktree(engine, sourceId, root, localHostId());
        await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled' WHERE worktree_id=$1::uuid", [binding.worktree_id]);
        await run({ engine, home, root, remote, other, sourceId, worktreeId: binding.worktree_id });
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** A committed page write whose Git effect is queued; returns the journal id effects reference. */
async function committedWrite(b: Brain, slug: string, content: string): Promise<string> {
  const { engine, root, sourceId } = b;
  const bound = (await getWorktreeBinding(engine, sourceId, localHostId()))!;
  await engine.putPage(slug, page('Before'), { sourceId });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const file = join(root, `${slug}.md`); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
  const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', sourceId, bound.source_incarnation, slug);
  const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
    sourceIncarnation: bound.source_incarnation, slug, pageId: snapshot.page.id, requestId: randomUUID(),
    callerIntent: { content }, intent: { content }, worktreeId: bound.worktree_id, topologyGeneration: bound.topology_generation });
  const row = (await claimNextWrite(engine, localHostId()))!;
  expect(row.id).toBe(admitted.id);
  const result = await publishMutation(engine, row, { observedRevision: snapshot.revision, file: { path: file, root, content },
    apply: async tx => { await tx.putPage(slug, page(content), { sourceId }); return {}; } }, localHostId());
  expect(result.state).toBe('committed');
  return row.id;
}

async function effect(engine: BrainEngine, id: string) {
  const [row] = await engine.executeRaw<{ state: string; error_code: string | null; outcome: Record<string, unknown> | null; data: Record<string, unknown> }>(
    "SELECT state,error_code,outcome,data FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [id]);
  return row!;
}
async function runEffects(engine: BrainEngine) {
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git'");
  await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 10 });
}
/** Another machine pushes a commit to the shared branch. */
function moveRemote(b: Brain, path: string, content: string): string {
  git(b.other, 'pull', '-q', '--ff-only');
  mkdirSync(dirname(join(b.other, path)), { recursive: true });
  writeFileSync(join(b.other, path), content);
  git(b.other, 'add', path); git(b.other, 'commit', '-q', '-m', `Other machine edits ${path}`); git(b.other, 'push', '-q');
  return git(b.other, 'rev-parse', 'HEAD').trim();
}
const remoteTip = (b: Brain) => git(b.remote, 'rev-parse', 'refs/heads/main').trim();
const onRemote = (b: Brain, sha: string) => { try { git(b.remote, 'merge-base', '--is-ancestor', sha, 'refs/heads/main'); return true; } catch { return false; } };

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`H-2 Git effects publish over a moved remote [${backend}]`, () => {
    test('a moved remote: the effect commits, the remote holds both machines\' commits, and the checkout does not move', () => brain(databaseUrl, async b => {
      const id = await committedWrite(b, 'notes/acme-example', 'After');
      const theirs = moveRemote(b, 'notes/other-example.md', 'From the other machine\n');
      await runEffects(b.engine);
      const done = await effect(b.engine, id);
      expect(done).toMatchObject({ state: 'committed', error_code: null, outcome: { git: 'committed', push: 'committed', integrated: 1 } });
      const head = git(b.root, 'rev-parse', 'HEAD').trim();
      expect(git(b.root, 'log', '-1', '--format=%s', '--', 'notes/acme-example.md').trim()).not.toBe('');
      expect(onRemote(b, head)).toBe(true);
      expect(onRemote(b, theirs)).toBe(true);
      expect(git(b.root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
      expect(existsSync(join(b.root, 'notes/other-example.md'))).toBe(false);
      expect(git(b.root, 'status', '--porcelain').trim()).toBe('');
      expect((await checkParkedEffects(b.engine, [b.sourceId])).details).toMatchObject({ parked_effects: 0, git_push_holds: [] });
    }), 180_000);

    test('an effect a moved remote parked before this release goes through retry-effects --parked-pushes, which doctor names', () => brain(databaseUrl, async b => {
      const id = await committedWrite(b, 'notes/acme-parked', 'Parked');
      moveRemote(b, 'notes/other-example.md', 'From the other machine\n');
      await b.engine.executeRaw(`UPDATE persistence_effects SET state='failed',error_code='targets_parked',
        data=data || $2::text::jsonb WHERE request_id=$1::uuid AND kind='git'`,
      [id, JSON.stringify({ parked: [{ slug: 'notes/acme-parked', error_code: 'git_push_unavailable' }], target_failures: 5 })]);
      const doctor = await checkParkedEffects(b.engine, [b.sourceId]);
      expect(doctor.status).toBe('warn');
      expect(doctor.details).toMatchObject({ git_push_holds: [{ source_id: b.sourceId, root: b.root, retrying: 0, parked: 1, codes: ['git_push_unavailable'], conflict: null,
        fix: { actor: 'agent', argv: ['gbrain', 'sources', 'writer', 'retry-effects', b.sourceId, '--parked-pushes'] } }] });
      expect(doctor.message).toContain(`gbrain sources writer retry-effects ${b.sourceId} --parked-pushes`);
      const preview = await runPersistenceAdministration(b.engine, 'writer_retry_effects', { source_id: b.sourceId, parked_pushes: true, dry_run: true });
      expect(preview).toMatchObject({ action: 'writer_retry_parked_pushes', dry_run: true, status: 'ok', requests: 1, queued: 1, refused: [] });
      expect(await effect(b.engine, id)).toMatchObject({ state: 'failed', error_code: 'targets_parked' });
      expect(await runPersistenceAdministration(b.engine, 'writer_retry_effects', { source_id: b.sourceId, parked_pushes: true }))
        .toMatchObject({ status: 'ok', requests: 1, queued: 1 });
      await runEffects(b.engine);
      expect(await effect(b.engine, id)).toMatchObject({ state: 'committed', outcome: { push: 'committed', integrated: 1 } });
      expect(onRemote(b, git(b.root, 'rev-parse', 'HEAD').trim())).toBe(true);
      expect(existsSync(join(b.root, 'notes/other-example.md'))).toBe(false);
    }), 180_000);

    test('both machines changed the page file: the effect holds integrate_conflict, nothing is pushed, the checkout stays, and the user\'s choice releases it', () => brain(databaseUrl, async b => {
      const id = await committedWrite(b, 'notes/acme-conflict', 'Ours');
      const theirs = moveRemote(b, 'notes/acme-conflict.md', 'The other machine\'s version\n');
      await runEffects(b.engine);
      const held = await effect(b.engine, id);
      expect(held).toMatchObject({ state: 'queued', error_code: 'integrate_conflict' });
      expect(remoteTip(b)).toBe(theirs);
      const head = git(b.root, 'rev-parse', 'HEAD').trim();
      expect(onRemote(b, head)).toBe(false);
      expect(readFileSync(join(b.root, 'notes/acme-conflict.md'), 'utf8')).toContain('Ours');
      expect(git(b.root, 'status', '--porcelain').trim()).toBe('');
      const status = await readSyncStatus(b.engine, b.sourceId);
      expect(status.git_push_holds).toHaveLength(1);
      const hold = status.git_push_holds[0]!;
      expect(hold).toMatchObject({ retrying: 1, parked: 0, codes: ['integrate_conflict'], conflict: { paths: ['notes/acme-conflict.md'], remote: theirs } });
      expect(hold.fix).toMatchObject({ ask_user: true, actor: 'user',
        argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', b.root, '--expect-remote', theirs, '--resolve', 'notes/acme-conflict.md=<ours|theirs>'] });
      expect(hold.fix.user_message).toContain('Which version should win');
      expect(status.next).toEqual(hold.fix);
      expect((await checkParkedEffects(b.engine, [b.sourceId])).status).toBe('warn');
      // The user chose this machine's version; the choice publishes without moving the checkout.
      const chosen = commitAndPush({ repo: b.root, pushOnly: true, keepCheckout: true, publishWaitMs: 0,
        resolutions: new Map([['notes/acme-conflict.md', { kind: 'ours' as const }]]), expectRemote: theirs });
      expect(chosen).toMatchObject({ outcome: 'pushed', checkout: 'unchanged' });
      expect(git(b.root, 'rev-parse', 'HEAD').trim()).toBe(head);
      await runEffects(b.engine);
      expect(await effect(b.engine, id)).toMatchObject({ state: 'committed', error_code: null, outcome: { push: 'committed' } });
      expect(git(b.remote, 'show', 'refs/heads/main:notes/acme-conflict.md')).toContain('Ours');
      expect((await readSyncStatus(b.engine, b.sourceId)).git_push_holds).toEqual([]);
    }), 180_000);
  });
}
