/**
 * #8896: the managed writer's Git effects scan what they publish. A script's plain `git commit` in a managed checkout
 * never passed the write path's scan; the Git effect's push used to publish it with the next page write, even after
 * `gbrain sources refresh` refused it with `publish_secret_found`.
 * Protects: a checkout only ahead of its upstream whose unpublished commits add a value that looks like a secret is
 * refused `publish_secret_found` by `pushGitRoot` and nothing is pushed; a diverged checkout (the remote moved) is
 * refused by the keep-checkout publish its child runs, and nothing is pushed; a remote rewound past a commit holding
 * one (the tracking ref still names it) is not re-published; a remote without the branch refuses
 * instead of scanning nothing; a clean ahead checkout still pushes. Through the effect worker, the page write's Git
 * effect holds on `publish_secret_found` (the remote keeps its tip), `gbrain sync status` names the user's fix, and an
 * allowlisted false positive releases it; commits the scan cannot read in full hold it as `publish_scan_unreadable`.
 * Seams: real repositories and a bare remote; the keep-checkout publish runs this checkout's own CLI
 * (GBRAIN_JOB_CHILD_CLI points at src/cli.ts); PGLite for the effect worker.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { commitGitTargets, pushGitRoot } from '../src/core/persistence/effect-git.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { scanText } from '../src/core/secret-scan.ts';
import { recordCommit, resetLedgerCacheForTests } from '../src/core/git/commit-ledger.ts';
import { retryParkedPushes } from '../src/core/persistence/git-durability-administration.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { git } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';

const token = 'ghp_' + 'Zt4q'.repeat(9);
const config = { engine: 'pglite' as const, embedding_disabled: true };
const dirs: string[] = [];
afterEach(() => { resetLedgerCacheForTests(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Checkout { home: string; root: string; remote: string; other: string; cli: string }

/** A checkout on main pushed to a bare remote, a second clone that can move the remote, and a child CLI wrapper. */
function checkout(): Checkout {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-8896-'))); dirs.push(home);
  const remote = join(home, 'remote.git'), root = join(home, 'brain'), other = join(home, 'other'), cli = join(home, 'gbrain-child');
  writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${resolve(import.meta.dir, '../src/cli.ts')}' "$@"\n`);
  chmodSync(cli, 0o700);
  git(home, 'init', '-q', '--bare', '-b', 'main', remote);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'initial.md'), 'Initial\n');
  git(root, 'add', 'initial.md'); git(root, 'commit', '-q', '-m', 'Initial');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
  git(home, 'clone', '-q', remote, other);
  git(other, 'config', 'user.name', 'Other Machine'); git(other, 'config', 'user.email', 'other@example.invalid');
  return { home, root, remote, other, cli };
}

/** A script's plain `git commit`: never through gbrain's write path, so never scanned there. */
function scriptCommit(root: string, path: string, content: string): string {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  git(root, 'add', path); git(root, 'commit', '-q', '-m', `script edits ${path}`);
  return git(root, 'rev-parse', 'HEAD').trim();
}
/** Another machine pushes a commit to the shared branch. */
function moveRemote(c: Checkout, path: string): string {
  mkdirSync(dirname(join(c.other, path)), { recursive: true });
  writeFileSync(join(c.other, path), 'From the other machine\n');
  git(c.other, 'add', path); git(c.other, 'commit', '-q', '-m', `Other machine edits ${path}`); git(c.other, 'push', '-q');
  return git(c.other, 'rev-parse', 'HEAD').trim();
}
const remoteTip = (c: Checkout) => git(c.remote, 'rev-parse', 'refs/heads/main').trim();
const childEnv = (c: Checkout) => ({ GBRAIN_HOME: join(c.home, 'home'), GBRAIN_JOB_CHILD_CLI: c.cli, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1',
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined });
async function refusal(run: Promise<unknown>) {
  try { await run; } catch (e) { return e as { code: string; message: string; suggestion?: string; detail?: string; fix?: { user_message?: string; ask_user?: boolean; argv?: string[] } }; }
  throw new Error('expected publish_secret_found');
}

describe('#8896 pushGitRoot scans the commits it publishes', () => {
  test('a checkout only ahead of its upstream with a script commit holding a token: refused, nothing pushed', async () => {
    const c = checkout();
    const before = remoteTip(c);
    const added = scriptCommit(c.root, 'notes/deploy.md', `Deploy token ${token}\n`);
    scriptCommit(c.root, 'notes/page.md', 'A clean page write on top\n');
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root)));
    expect(error.code).toBe('publish_secret_found');
    expect(error.message).toContain('notes/deploy.md:1 (');
    expect(error.message).toContain(added.slice(0, 7));
    expect(error.message).toContain('Nothing was pushed');
    expect(error.fix?.ask_user).toBe(true);
    expect(error.fix?.user_message).toContain('held');
    expect(JSON.stringify(error)).not.toContain(token);
    expect(remoteTip(c)).toBe(before);
  }, 60_000);

  test('a diverged checkout (the remote moved): the keep-checkout publish refuses, nothing pushed', async () => {
    const c = checkout();
    scriptCommit(c.root, 'notes/deploy.md', `Deploy token ${token}\n`);
    const theirs = moveRemote(c, 'notes/other-example.md');
    const head = git(c.root, 'rev-parse', 'HEAD').trim();
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root)));
    expect(error.code).toBe('publish_secret_found');
    expect(error.message).toContain('notes/deploy.md:1 (');
    expect(error.fix?.user_message).toContain('held');
    expect(JSON.stringify(error)).not.toContain(token);
    expect(remoteTip(c)).toBe(theirs);
    expect(git(c.root, 'rev-parse', 'HEAD').trim()).toBe(head);
  }, 120_000);

  test('a remote rewound past a published secret (the tracking ref is stale): it is not published again', async () => {
    const c = checkout();
    const base = remoteTip(c);
    scriptCommit(c.root, 'notes/deploy.md', `Deploy token ${token}\n`);
    git(c.root, 'push', '-q');
    git(c.remote, 'update-ref', 'refs/heads/main', base);
    scriptCommit(c.root, 'notes/page.md', 'A clean page write on top\n');
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root)));
    expect(error.code).toBe('publish_secret_found');
    expect(error.message).toContain('notes/deploy.md:1 (');
    expect(error.fix?.user_message).toContain('held');
    expect(remoteTip(c)).toBe(base);
  }, 120_000);

  test('a remote rewound past a published secret that also moved the same file refuses on the secret, never on a conflict whose resolve would publish it', async () => {
    const c = checkout();
    const base = remoteTip(c);
    scriptCommit(c.root, 'notes/deploy.md', `Deploy token ${token}\n`);
    git(c.root, 'push', '-q');
    git(c.remote, 'update-ref', 'refs/heads/main', base);
    const theirs = moveRemote(c, 'notes/page.md');
    scriptCommit(c.root, 'notes/page.md', 'This machine\'s version\n');
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root)));
    expect(error.code).toBe('publish_secret_found');
    expect(error.message).toContain('notes/deploy.md:1 (');
    expect(remoteTip(c)).toBe(theirs);
  }, 120_000);

  test('a conflict the scanned publish reports hands back a resolve that still scans', async () => {
    const c = checkout();
    const theirs = moveRemote(c, 'notes/page.md');
    scriptCommit(c.root, 'notes/page.md', 'This machine\'s version\n');
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root)));
    expect(error.code).toBe('integrate_conflict');
    expect(error.fix?.argv).toEqual(['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--scan-secrets', '--path', c.root,
      '--expect-remote', theirs, '--resolve', 'notes/page.md=<ours|theirs>']);
    expect(error.suggestion).toContain('--keep-checkout --scan-secrets --expect-remote');
    expect(remoteTip(c)).toBe(theirs);
  }, 120_000);

  test('a scanned publish whose push the remote keeps rejecting hands back a rerun that still scans', async () => {
    const c = checkout();
    const theirs = moveRemote(c, 'notes/other.md');
    scriptCommit(c.root, 'notes/page.md', 'A clean local page\n');
    writeFileSync(join(c.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(c.remote, 'hooks', 'pre-receive'), 0o755);
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root)));
    expect(error.code).toBe('push_unconfirmed');
    expect(`${error.message} ${error.suggestion ?? ''}`).toContain('gbrain git commit-push --push-only --keep-checkout --scan-secrets');
    expect(remoteTip(c)).toBe(theirs);
  }, 120_000);

  test('a remote without the branch (a first push): a clean history creates it', async () => {
    const c = checkout();
    scriptCommit(c.root, 'notes/page.md', 'A clean page\n');
    git(c.remote, 'update-ref', '-d', 'refs/heads/main');
    expect(await withEnv(childEnv(c), () => pushGitRoot(c.root))).toEqual({ push: 'committed' });
    expect(remoteTip(c)).toBe(git(c.root, 'rev-parse', 'HEAD').trim());
  }, 60_000);

  test('a remote without the branch: a secret anywhere in the history refuses, and no branch is created', async () => {
    const c = checkout();
    scriptCommit(c.root, 'notes/deploy.md', `Deploy token ${token}\n`);
    git(c.root, 'push', '-q');
    scriptCommit(c.root, 'notes/page.md', 'A clean page write on top\n');
    git(c.remote, 'update-ref', '-d', 'refs/heads/main');
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root)));
    expect(error.code).toBe('publish_secret_found');
    expect(error.message).toContain('notes/deploy.md:1 (');
    expect(error.message).toContain('and its whole history');
    expect(() => git(c.remote, 'rev-parse', '--verify', 'refs/heads/main')).toThrow();
  }, 60_000);

  test('a remote without the branch whose history scan runs past the in-process budget holds, naming the upstream check', async () => {
    const c = checkout();
    scriptCommit(c.root, 'notes/page.md', 'A clean page\n');
    git(c.remote, 'update-ref', '-d', 'refs/heads/main');
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root, undefined, 0)));
    expect(error.code).toBe('publish_scan_unreadable');
    expect(error.message).toContain('origin has no branch main');
    expect(error.fix?.argv).toEqual(['git', '-C', c.root, 'ls-remote', '--heads', '--', 'origin']);
    expect(error.fix?.user_message).not.toContain('fsck');
    expect(() => git(c.remote, 'rev-parse', '--verify', 'refs/heads/main')).toThrow();
  }, 60_000);

  test('a commit changing .gitattributes is held and the user is told to review and push it', async () => {
    const c = checkout();
    const before = remoteTip(c);
    scriptCommit(c.root, '.gitattributes', '*.md binary\n');
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root)));
    expect(error.code).toBe('publish_secret_found');
    expect(error.message).toContain('.gitattributes (changes what the scan sees');
    expect(error.suggestion).toContain('never published automatically');
    expect(error.suggestion).toContain(`git -C ${c.root} push`);
    expect(remoteTip(c)).toBe(before);
  }, 60_000);

  test('a scan past the in-process budget moves to the keep-checkout publish, which still refuses a secret', async () => {
    const c = checkout();
    const before = remoteTip(c);
    scriptCommit(c.root, 'notes/deploy.md', `Deploy token ${token}\n`);
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root, undefined, 0)));
    expect(error.code).toBe('publish_secret_found');
    expect(error.message).toContain('notes/deploy.md:1 (');
    expect(remoteTip(c)).toBe(before);
  }, 120_000);

  test('a scan past the in-process budget moves to the keep-checkout publish, which pushes a clean commit', async () => {
    const c = checkout();
    scriptCommit(c.root, 'notes/page.md', 'A clean page\n');
    const pushed = await withEnv(childEnv(c), () => pushGitRoot(c.root, undefined, 0));
    expect(pushed.push).toBe('committed');
    expect(remoteTip(c)).toBe(git(c.root, 'rev-parse', 'HEAD').trim());
  }, 120_000);

  test('commits the scan cannot read in full hold the push as publish_scan_unreadable, nothing pushed', async () => {
    const c = checkout();
    const before = remoteTip(c);
    scriptCommit(c.root, 'notes/page.md', 'plain text\n');
    const blob = git(c.root, 'rev-parse', 'HEAD:notes/page.md').trim();
    git(c.root, 'rm', '-q', 'notes/page.md'); git(c.root, 'commit', '-q', '-m', 'drop page');
    rmSync(join(c.root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root)));
    expect(error.code).toBe('publish_scan_unreadable');
    expect(error.message).not.toContain('look like secrets');
    expect(error.fix?.user_message).toContain('held');
    expect(remoteTip(c)).toBe(before);
  }, 60_000);

  test('a commit the ledger records as a page write is not scanned; a commit-push commit still is', async () => {
    const c = checkout();
    const page = scriptCommit(c.root, 'notes/page.md', `Saved note with ${token}\n`);
    recordCommit(c.root, { sha: page, writer: 'effect', ref: null, verified: true });
    expect(await withEnv(childEnv(c), () => pushGitRoot(c.root))).toEqual({ push: 'committed' });
    expect(remoteTip(c)).toBe(page);
    const script = scriptCommit(c.root, 'notes/deploy.md', `Deploy token ${token}\n`);
    recordCommit(c.root, { sha: script, writer: 'commit_push', ref: null });
    const error = await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root)));
    expect(error.code).toBe('publish_secret_found');
    expect(error.message).toContain('notes/deploy.md:1 (');
    expect(error.message).not.toContain('notes/page.md');
    expect(remoteTip(c)).toBe(page);
  }, 60_000);

  test('a page-write record that adopted an outside edit, an unverified one, or a ledger that cannot be read, leaves the commit scanned', async () => {
    const c = checkout();
    const adopted = scriptCommit(c.root, 'notes/page.md', `Adopted edit with ${token}\n`);
    recordCommit(c.root, { sha: adopted, writer: 'effect', ref: null, verified: true, adopted: ['notes/page.md'] });
    expect((await withEnv(childEnv(c), () => refusal(pushGitRoot(c.root)))).code).toBe('publish_secret_found');

    const e = checkout();
    const legacy = scriptCommit(e.root, 'notes/page.md', `Saved note with ${token}\n`);
    recordCommit(e.root, { sha: legacy, writer: 'effect', ref: null });
    expect((await withEnv(childEnv(e), () => refusal(pushGitRoot(e.root)))).code).toBe('publish_secret_found');

    const d = checkout();
    const page = scriptCommit(d.root, 'notes/page.md', `Saved note with ${token}\n`);
    recordCommit(d.root, { sha: page, writer: 'effect', ref: null, verified: true });
    const ledger = join(d.root, '.git', 'gbrain', 'commit-ledger.jsonl');
    rmSync(ledger); mkdirSync(ledger);
    expect((await withEnv(childEnv(d), () => refusal(pushGitRoot(d.root)))).code).toBe('publish_secret_found');
    expect(remoteTip(d)).not.toBe(page);
  }, 60_000);

  test('a clean ahead checkout still pushes', async () => {
    const c = checkout();
    scriptCommit(c.root, 'notes/page.md', 'A clean page\n');
    expect(await withEnv(childEnv(c), () => pushGitRoot(c.root))).toEqual({ push: 'committed' });
    expect(remoteTip(c)).toBe(git(c.root, 'rev-parse', 'HEAD').trim());
  }, 60_000);
});

/**
 * A PATH whose `git` runs `step` once (`{git}` in it is the real git), before or after the first call whose arguments
 * contain one of `match`. The real git runs with the original PATH, so a git that is itself a PATH-resolving shim never finds
 * this wrapper again.
 */
function racingGit(c: Checkout, match: string[], when: 'before' | 'after', step: string): string {
  const path = process.env.PATH ?? '', real = `PATH='${path}' '${Bun.which('git')!}'`;
  const bin = join(c.home, 'race-bin'), mark = join(c.home, 'raced');
  const hook = `if [ ! -f '${mark}' ]; then touch '${mark}'; ${step.replaceAll('{git}', real)}; fi`;
  const cases = match.map(m => `*" ${m} "*`).join('|');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), ['#!/bin/sh',
    when === 'before' ? `case " $* " in ${cases}) ${hook};; esac` : '',
    `${real} "$@"`, 'code=$?',
    when === 'after' ? `case " $* " in ${cases}) if [ $code -eq 0 ]; then ${hook}; fi;; esac` : '',
    'exit $code', ''].join('\n'), { mode: 0o755 });
  return `${bin}:${path}`;
}

/** The git call after which the Git effect's commit exists: the porcelain commit, or the plumbing commit's ref move. */
const EFFECT_COMMIT = ['commit --only', 'update-ref -m commit:'];

interface ManagedWrite { engine: BrainEngine; sourceId: string; worktreeId: string; runEffects: () => Promise<void>; effect: () => Promise<{ state: string; error_code: string | null }> }

/** A managed source on the checkout with git durability on; `script` commits into the checkout before one page write whose Git effect is queued. */
async function managedWrite(c: Checkout, script: () => void, run: (w: ManagedWrite) => Promise<void>, body = 'After'): Promise<void> {
  await withEnv({ ...childEnv(c), GBRAIN_AUDIT_DIR: join(c.home, 'audit'), GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(undefined);
    try {
      await registerLocalWriter(engine, 'cli');
      const sourceId = `s8896-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, c.root]);
      const claimed = await claimWorktree(engine, sourceId, c.root, localHostId());
      await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled' WHERE worktree_id=$1::uuid", [claimed.worktree_id]);
      script();

      const slug = 'notes/acme-example';
      const page = (body: string) => ({ type: 'note', title: 'Acme example', compiled_truth: body, timeline: '', frontmatter: {} });
      const bound = (await getWorktreeBinding(engine, sourceId, localHostId()))!;
      await engine.putPage(slug, page('Before'), { sourceId });
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
      const file = join(c.root, `${slug}.md`);
      writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
      const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
      const authority = await submissionAuthority(ctx, 'put_page', sourceId, bound.source_incarnation, slug);
      await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
        sourceIncarnation: bound.source_incarnation, slug, pageId: snapshot.page.id, requestId: randomUUID(),
        callerIntent: { content: body }, intent: { content: body }, worktreeId: bound.worktree_id, topologyGeneration: bound.topology_generation });
      const row = (await claimNextWrite(engine, localHostId()))!;
      const result = await publishMutation(engine, row, { observedRevision: snapshot.revision, file: { path: file, root: c.root, content: body },
        apply: async tx => { await tx.putPage(slug, page(body), { sourceId }); return {}; } }, localHostId());
      expect(result.state).toBe('committed');
      await run({ engine, sourceId, worktreeId: bound.worktree_id,
        runEffects: async () => {
          await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git'");
          await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 10 });
        },
        effect: async () => (await engine.executeRaw<{ state: string; error_code: string | null }>(
          "SELECT state,error_code FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [row.id]))[0]! });
    } finally { await disposePersistenceConsumer(engine); await close(); }
  });
}

describe('#8896 through the effect worker', () => {
  test("a page write's Git effect holds on publish_secret_found, sync status names the fix, and an allowlisted false positive releases it", async () => {
    const c = checkout();
    const before = remoteTip(c);
    await managedWrite(c, () => scriptCommit(c.root, 'scripts-out/deploy.md', `Deploy token ${token}\n`), async w => {
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'queued', error_code: 'publish_secret_found' });
      expect(remoteTip(c)).toBe(before);
      const hold = (await readSyncStatus(w.engine, w.sourceId)).git_push_holds[0]!;
      expect(hold).toMatchObject({ retrying: 1, parked: 0, codes: ['publish_secret_found'] });
      expect(hold.fix).toMatchObject({ ask_user: true, actor: 'user' });
      expect(hold.fix.user_message).toContain('look like secrets');

      writeFileSync(join(c.root, '.gbrain-scan-allow'), `${scanText(`Deploy token ${token}\n`)[0]!.fingerprint}\n`);
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'committed', error_code: null });
      expect(remoteTip(c)).toBe(git(c.root, 'rev-parse', 'HEAD').trim());
    });
  }, 180_000);

  test('commits the scan cannot read hold the Git effect as publish_scan_unreadable, and sync status names git fsck', async () => {
    const c = checkout();
    const before = remoteTip(c);
    await managedWrite(c, () => {
      scriptCommit(c.root, 'scripts-out/report.md', 'plain text\n');
      const blob = git(c.root, 'rev-parse', 'HEAD:scripts-out/report.md').trim();
      git(c.root, 'rm', '-q', 'scripts-out/report.md'); git(c.root, 'commit', '-q', '-m', 'drop report');
      rmSync(join(c.root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    }, async w => {
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'queued', error_code: 'publish_scan_unreadable' });
      expect(remoteTip(c)).toBe(before);
      const hold = (await readSyncStatus(w.engine, w.sourceId)).git_push_holds[0]!;
      expect(hold).toMatchObject({ retrying: 1, parked: 0, codes: ['publish_scan_unreadable'] });
      expect(hold.fix).toMatchObject({ ask_user: true, actor: 'user', argv: ['git', '-C', c.root, 'fsck'] });

      writeFileSync(join(c.home, 'restored.txt'), 'plain text\n');
      git(c.root, 'hash-object', '-w', join(c.home, 'restored.txt'));
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'committed', error_code: null });
      expect(remoteTip(c)).toBe(git(c.root, 'rev-parse', 'HEAD').trim());
    });
  }, 180_000);

  test('a page write whose body holds a credential-shaped value still backs up: page bodies are stored raw by design', async () => {
    const c = checkout();
    await managedWrite(c, () => {}, async w => {
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'committed', error_code: null });
      expect(remoteTip(c)).toBe(git(c.root, 'rev-parse', 'HEAD').trim());
      expect(git(c.remote, 'show', 'main:notes/acme-example.md')).toContain(token);
    }, `Connection notes: ${token}`);
  }, 180_000);

  test('a script commit that lands right after the effect commit is not ledgered as a page write, so its secret holds the push', async () => {
    const c = checkout();
    const before = remoteTip(c);
    const PATH = racingGit(c, EFFECT_COMMIT, 'after', `mkdir -p '${c.root}/scripts-out'; printf 'Deploy token %s\\n' '${token}' > '${c.root}/scripts-out/race.md';`
      + ` {git} -C '${c.root}' add scripts-out/race.md && {git} -C '${c.root}' -c core.hooksPath=/dev/null commit -q -m 'script races the effect'`);
    await withEnv({ PATH }, () => managedWrite(c, () => {}, async w => {
      await w.runEffects();
      expect(git(c.root, 'log', '-1', '--format=%s').trim()).toBe('script races the effect');
      expect(await w.effect()).toMatchObject({ error_code: 'publish_secret_found' });
      expect(remoteTip(c)).toBe(before);
    }));
  }, 180_000);

  test('a script amending the effect commit (same parent) is not ledgered as a page write, so its secret holds the push', async () => {
    const c = checkout();
    const before = remoteTip(c);
    const PATH = racingGit(c, EFFECT_COMMIT, 'after', `mkdir -p '${c.root}/scripts-out'; printf 'Deploy token %s\\n' '${token}' > '${c.root}/scripts-out/race.md';`
      + ` {git} -C '${c.root}' add scripts-out/race.md && {git} -C '${c.root}' -c core.hooksPath=/dev/null commit -q --amend --no-edit`);
    await withEnv({ PATH }, () => managedWrite(c, () => {}, async w => {
      await w.runEffects();
      expect(git(c.root, 'log', '-1', '--format=%s').trim()).not.toBe('script races the effect');
      expect(git(c.root, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toContain('scripts-out/race.md');
      expect(await w.effect()).toMatchObject({ error_code: 'publish_secret_found' });
      expect(remoteTip(c)).toBe(before);
    }));
  }, 180_000);

  test('a script rewording the effect commit (same parent, paths and bytes) is not trusted, so its message is scanned', async () => {
    const c = checkout();
    const before = remoteTip(c);
    const PATH = racingGit(c, EFFECT_COMMIT, 'after', `{git} -C '${c.root}' -c core.hooksPath=/dev/null commit -q --amend -m "Deploy token ${token}"`);
    await withEnv({ PATH }, () => managedWrite(c, () => {}, async w => {
      await w.runEffects();
      expect(git(c.root, 'log', '-1', '--format=%B')).toContain(token);
      expect(await w.effect()).toMatchObject({ error_code: 'publish_secret_found' });
      expect(remoteTip(c)).toBe(before);
    }));
  }, 180_000);

  test('a source-scan walk commits a page whose body holds a credential-shaped value as gbrain\'s own, so it still backs up', async () => {
    const c = checkout();
    await managedWrite(c, () => {}, async w => {
      const snapshot = (await w.engine.readPageSnapshot('notes/acme-example', { sourceId: w.sourceId }))!;
      writeFileSync(join(c.root, 'notes/acme-example.md'), serializePageToMarkdown(snapshot.page, snapshot.tags));
      await w.engine.executeRaw(`UPDATE persistence_effects SET data = data || '{"source_scan": true}'::jsonb WHERE kind='git'`);
      for (let i = 0; i < 4 && (await w.effect()).state !== 'committed'; i++) await w.runEffects();
      expect(git(c.root, 'log', '-1', '--format=%s').trim()).not.toBe('Initial');
      expect(await w.effect()).toMatchObject({ state: 'committed', error_code: null });
      expect(git(c.remote, 'show', 'main:notes/acme-example.md')).toContain(token);
    }, `Connection notes: ${token}`);
  }, 180_000);

  test('a page file changed after the effect checked its bytes is not ledgered as verified, so the changed bytes are scanned', async () => {
    const c = checkout();
    const before = remoteTip(c);
    const PATH = racingGit(c, ['add -A'], 'before', `printf 'Deploy token %s\\n' '${token}' >> '${c.root}/notes/acme-example.md'`);
    await withEnv({ PATH }, () => managedWrite(c, () => {}, async w => {
      await w.runEffects();
      expect(git(c.root, 'show', 'HEAD:notes/acme-example.md')).toContain(token);
      expect(await w.effect()).toMatchObject({ error_code: 'publish_secret_found' });
      expect(remoteTip(c)).toBe(before);
    }));
  }, 180_000);

  test('a parked publish_secret_found effect is released by retry-effects --parked-pushes once the value is allowlisted', async () => {
    const c = checkout();
    const before = remoteTip(c);
    await managedWrite(c, () => scriptCommit(c.root, 'scripts-out/deploy.md', `Deploy token ${token}\n`), async w => {
      for (let i = 0; i < 8 && (await w.effect()).state !== 'failed'; i++) await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'failed', error_code: 'targets_parked' });
      expect(remoteTip(c)).toBe(before);
      writeFileSync(join(c.root, '.gbrain-scan-allow'), `${scanText(`Deploy token ${token}\n`)[0]!.fingerprint}\n`);
      expect(await retryParkedPushes(w.engine, w.worktreeId, false)).toMatchObject({ status: 'ok', requests: 1, queued: 1 });
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'committed', error_code: null });
      expect(remoteTip(c)).toBe(git(c.root, 'rev-parse', 'HEAD').trim());
    });
  }, 240_000);
});

describe('#8896 the Git effect commit is made by plumbing', () => {
  /** A committed repository at `root` with notes/a.md, ready for commitGitTargets. */
  function repo(root: string): void {
    mkdirSync(join(root, 'notes'), { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
    writeFileSync(join(root, 'notes', 'a.md'), 'Before\n');
    git(root, 'add', 'notes/a.md'); git(root, 'commit', '-q', '-m', 'Initial');
  }

  test('a checkout whose path holds a newline commits', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-8896-'))); dirs.push(home);
    const root = join(home, 'line\nbreak-brain');
    repo(root);
    writeFileSync(join(root, 'notes', 'a.md'), 'After\n');
    const outcome = await withEnv({ GBRAIN_HOME: join(home, 'gbrain-home') }, () => commitGitTargets(root, ['notes/a.md']));
    expect(outcome.get('notes/a.md')).toEqual({ git: 'committed' });
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('After\n');
  }, 60_000);

  test('an index another process reset after staging fails the commit instead of committing the old bytes', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-8896-'))); dirs.push(home);
    const root = join(home, 'brain');
    repo(root);
    const before = git(root, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(root, 'notes', 'a.md'), 'After\n');
    const PATH = racingGit({ home, root, remote: '', other: '', cli: '' }, ['diff --cached'], 'after', `{git} -C '${root}' reset -q`);
    const outcome = await withEnv({ PATH, GBRAIN_HOME: join(home, 'gbrain-home') }, () => commitGitTargets(root, ['notes/a.md']));
    expect(outcome.get('notes/a.md')).toBeInstanceOf(Error);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(before);
  }, 60_000);

  /** A git that logs each `maintenance` call's arguments and, with `refuseDetach`, rejects --detach the way git before 2.47 does. */
  function maintenanceGit(home: string, refuseDetach: boolean): { PATH: string; calls: () => string[] } {
    const path = process.env.PATH ?? '', bin = join(home, 'maint-bin'), log = join(home, 'maintenance.log');
    mkdirSync(bin);
    const refuse = refuseDetach ? `; case " $* " in *" --detach "*) echo 'error: unknown option detach' >&2; exit 129;; esac` : '';
    writeFileSync(join(bin, 'git'), ['#!/bin/sh',
      `case " $* " in *" maintenance "*) echo "$*" >> '${log}'${refuse};; esac`,
      `PATH='${path}' exec '${Bun.which('git')!}' "$@"`, ''].join('\n'), { mode: 0o755 });
    const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n').map(line => line.slice(line.indexOf('maintenance'))); } catch { return []; } };
    return { PATH: `${bin}:${path}`, calls };
  }

  test('the effect commit runs auto maintenance detached, so a repack never runs under the writer lock', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-8896-'))); dirs.push(home);
    const root = join(home, 'brain');
    repo(root);
    writeFileSync(join(root, 'notes', 'a.md'), 'After\n');
    const shim = maintenanceGit(home, false);
    const outcome = await withEnv({ PATH: shim.PATH, GBRAIN_HOME: join(home, 'gbrain-home') }, () => commitGitTargets(root, ['notes/a.md']));
    expect(outcome.get('notes/a.md')).toEqual({ git: 'committed' });
    expect(shim.calls()).toEqual(['maintenance run --auto --quiet --detach']);
  }, 60_000);

  test('on a git without maintenance --detach the effect commit still runs auto maintenance', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-8896-'))); dirs.push(home);
    const root = join(home, 'brain');
    repo(root);
    writeFileSync(join(root, 'notes', 'a.md'), 'After\n');
    const shim = maintenanceGit(home, true);
    const outcome = await withEnv({ PATH: shim.PATH, GBRAIN_HOME: join(home, 'gbrain-home') }, () => commitGitTargets(root, ['notes/a.md']));
    expect(outcome.get('notes/a.md')).toEqual({ git: 'committed' });
    expect(shim.calls()).toEqual(['maintenance run --auto --quiet --detach', 'maintenance run --auto --quiet']);
  }, 60_000);
});
