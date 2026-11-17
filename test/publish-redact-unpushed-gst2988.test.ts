/**
 * GST-2988 PR 2: a publish redacts values that look like secrets in unpushed commits instead of refusing them
 * (secrets.on_push redact, the default). Protects: the remote never receives the value (git log --all -S and every
 * object it holds), the checkout keeps working (marker in the file, clean status, local edits kept), the original is
 * in the encrypted spool, a backup ref keeps the old commits; messages, merges and signed commits are rebuilt; text
 * the scan cannot vouch for and scan-gate changes are held back in one local commit; other local refs holding the old
 * commits are named; commits a remote-tracking ref reaches are never rewritten; a moved index refuses as a race;
 * secrets.on_push refuse keeps the refusal; gbrain git redact-unpushed previews and applies with --expect.
 * Seams: real repositories and a bare remote; synthetic tokens only. The effect-worker tests run on PGLite, and on
 * Postgres too when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { redactUnpushed, spoolSealer, type RedactOutcome, type RedactPreview } from '../src/core/git/redact-unpushed.ts';
import { openSpooled, readSpool } from '../src/core/secret-store/spool.ts';
import { scanText } from '../src/core/secret-scan.ts';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { secretPublishMaintenance } from '../src/core/git/redact-finish.ts';
import { reveal } from '../src/core/secret-store/store.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const PG_URL = process.env.DATABASE_URL;
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-2988-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const token = 'ghp_' + 'Zt4q'.repeat(9);
const MARKER = /<REDACTED:([a-z0-9_]+):(ss_[0-9a-f]{12})>/;

interface Repo { remote: string; root: string; base: string; home: string }
let count = 0;
function repo(): Repo {
  const name = `r${++count}`;
  const remote = join(dir, `${name}.git`), root = join(dir, name), home = join(dir, `${name}-home`);
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
  git(root, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(root, 'readme.md'), 'start\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'init'); git(root, 'push', '-q', '-u', 'origin', 'main');
  return { remote, root, home, base: git(root, 'rev-parse', 'HEAD') };
}
const commit = (root: string, file: string, content: string | Buffer, message = `edit ${file}`) => {
  writeFileSync(join(root, file), content); git(root, 'add', file); git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
};
const inHome = <T>(r: Repo, fn: () => T | Promise<T>, extra: Record<string, string | undefined> = {}) =>
  withEnv({ GBRAIN_HOME: r.home, GBRAIN_SECRETS_ON_PUSH: undefined, ...extra }, fn);
const publish = (r: Repo) => inHome(r, () => commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true }));
const remoteTip = (r: Repo) => git(r.remote, 'rev-parse', 'refs/heads/main');
/** Every object the remote holds, read whole: the value must be in none of them. */
const remoteObjects = (r: Repo) => execFileSync('git', ['-C', r.remote, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 1 << 28 }).toString('latin1');
function expectRemoteClean(r: Repo) {
  expect(git(r.remote, 'log', '--all', '--oneline', '-S', token)).toBe('');
  expect(remoteObjects(r)).not.toContain(token);
}
function failure(fn: () => unknown): { code: string; message: string } {
  try { fn(); } catch (e) { return e as { code: string; message: string }; }
  throw new Error('expected a refusal');
}

describe('GST-2988 a publish redacts unpushed secrets', () => {
  test('values become store markers, the push lands, the remote never sees them, the spool and backup ref keep the original', async () => {
    const r = repo();
    commit(r.root, 'notes.md', `line one\nDeploy token ${token}\n`);
    commit(r.root, 'other.md', 'clean\n');
    const old = git(r.root, 'rev-parse', 'HEAD');
    const result = await publish(r);
    expect(result.outcome).toBe('pushed');
    expect(result.redaction).toMatchObject({ values: 1, rebuilt: 2, old_head: old, held: [], spooled: 1 });
    expect(result.notices?.map(n => n.code)).toEqual(['publish_secret_redacted', 'secret_store_spooled']);
    expect(remoteTip(r)).toBe(git(r.root, 'rev-parse', 'HEAD'));
    expectRemoteClean(r);
    const file = readFileSync(join(r.root, 'notes.md'), 'utf8');
    const marker = MARKER.exec(file)!;
    expect(file).not.toContain(token);
    expect(file.startsWith('line one\nDeploy token ')).toBe(true);
    expect(git(r.root, 'status', '--porcelain')).toBe('');
    expect(git(r.root, 'show', `${result.redaction!.backup_ref}:notes.md`)).toContain(token);
    expect(result.redaction!.backup_ref).toMatch(/^refs\/gbrain\/backup\/redact-\d{8}T\d{6}Z-[0-9a-f]{12}$/);
    await inHome(r, () => expect(openSpooled(marker[2]!)!.value).toBe(token));
    expect(JSON.stringify(result)).not.toContain(token);
  }, 60_000);

  test('a value in a commit message is redacted in the rebuilt message', async () => {
    const r = repo();
    commit(r.root, 'page.md', 'a page\n', `rotate ${token}`);
    const result = await publish(r);
    expect(result.outcome).toBe('pushed');
    expect(git(r.remote, 'log', '-1', '--format=%B', 'main')).toMatch(/^rotate <REDACTED:[a-z0-9_]+:ss_[0-9a-f]{12}>$/);
    expectRemoteClean(r);
  }, 60_000);

  test('a merge commit in range keeps both parents, and the local branch still holding the old commit is named', async () => {
    const r = repo();
    git(r.root, 'checkout', '-q', '-b', 'side');
    commit(r.root, 'side.md', `side token ${token}\n`);
    git(r.root, 'checkout', '-q', 'main');
    commit(r.root, 'main.md', 'main\n');
    git(r.root, 'merge', '-q', '--no-edit', 'side');
    const result = await publish(r);
    expect(result.outcome).toBe('pushed');
    expectRemoteClean(r);
    expect(git(r.remote, 'rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(3);
    expect(result.redaction!.side_refs).toEqual(['refs/heads/side']);
    expect(result.notices?.map(n => n.code)).toContain('publish_secret_side_refs');
    expect(git(r.root, 'show', 'side:side.md')).toContain(token);
  }, 60_000);

  test('a signed commit is rebuilt without its signature and the notice says so', async () => {
    const r = repo();
    commit(r.root, 'notes.md', `token ${token}\n`);
    const lines = (git(r.root, 'cat-file', 'commit', 'HEAD') + '\n').split('\n');
    lines.splice(lines.findIndex(l => l.startsWith('committer ')) + 1, 0, 'gpgsig -----BEGIN PGP SIGNATURE-----', ' ', ' c2lnbmF0dXJl', ' -----END PGP SIGNATURE-----');
    const signed = execFileSync('git', ['-C', r.root, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: lines.join('\n') }).toString().trim();
    git(r.root, 'update-ref', 'refs/heads/main', signed);
    const result = await publish(r);
    expect(result.redaction!.unsigned).toEqual([signed]);
    expect(result.notices?.map(n => n.code)).toContain('publish_secret_unsigned');
    expect(git(r.remote, 'cat-file', 'commit', 'main')).not.toContain('gpgsig');
    expectRemoteClean(r);
  }, 60_000);

  test('text that is not UTF-8 is held back in one local commit; a later publish pushes below it and holds it again', async () => {
    const r = repo();
    commit(r.root, 'notes.md', `token ${token}\n`);
    const legacy = Buffer.concat([Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20]), Buffer.from(`key ${token}\n`)]);
    commit(r.root, 'legacy.txt', legacy);
    const result = await publish(r);
    expect(result.outcome).toBe('pushed');
    expect(result.redaction!.held).toEqual([{ path: 'legacy.txt', reason: 'not_utf8' }]);
    expect(result.notices?.map(n => n.code)).toContain('publish_secret_held_back');
    expect(git(r.remote, 'ls-tree', '--name-only', 'main').split('\n').sort()).toEqual(['notes.md', 'readme.md']);
    expect(git(r.root, 'rev-parse', 'HEAD^')).toBe(remoteTip(r));
    expect(readFileSync(join(r.root, 'legacy.txt')).equals(legacy)).toBe(true);
    expect(git(r.root, 'status', '--porcelain')).toBe('');
    expectRemoteClean(r);

    commit(r.root, 'more.md', 'more\n');
    const again = await publish(r);
    expect(again.outcome).toBe('pushed');
    expect(git(r.remote, 'ls-tree', '--name-only', 'main').split('\n').sort()).toEqual(['more.md', 'notes.md', 'readme.md']);
    expect(git(r.root, 'rev-parse', 'HEAD^')).toBe(remoteTip(r));
    expect(git(r.root, 'log', '--format=%s', `${remoteTip(r)}..HEAD`)).toBe('gbrain: files held back from publish');
    expect(readFileSync(join(r.root, 'legacy.txt')).equals(legacy)).toBe(true);
    expectRemoteClean(r);
  }, 90_000);

  test('a .gbrain-scan-allow change is held back and the push is scanned with the remote allowlist', async () => {
    const r = repo();
    const fingerprint = scanText(`Deploy token ${token}\n`)[0]!.fingerprint;
    commit(r.root, 'notes.md', `Deploy token ${token}\n`);
    commit(r.root, '.gbrain-scan-allow', `${fingerprint}\n`);
    const result = await publish(r);
    expect(result.outcome).toBe('pushed');
    expect(result.redaction!.held).toEqual([{ path: '.gbrain-scan-allow', reason: 'gate_change' }]);
    expect(result.redaction!.values).toBe(1);
    expect(git(r.remote, 'ls-tree', '--name-only', 'main')).not.toContain('.gbrain-scan-allow');
    expect(existsSync(join(r.root, '.gbrain-scan-allow'))).toBe(true);
    expectRemoteClean(r);
  }, 60_000);

  test('a file with local edits is redacted value by value and keeps the edits', async () => {
    const r = repo();
    commit(r.root, 'notes.md', `Deploy token ${token}\n`);
    writeFileSync(join(r.root, 'notes.md'), `Deploy token ${token}\nlocal line\n`);
    const result = await publish(r);
    expect(result.outcome).toBe('pushed');
    const file = readFileSync(join(r.root, 'notes.md'), 'utf8');
    expect(file).not.toContain(token);
    expect(file).toMatch(/^Deploy token <REDACTED:[a-z0-9_]+:ss_[0-9a-f]{12}>\nlocal line\n$/);
    expect(git(r.root, 'diff')).toContain('+local line');
    expectRemoteClean(r);
  }, 60_000);

  test('a commit a remote-tracking ref reaches is never rewritten: the refusal stands', async () => {
    const r = repo();
    git(r.root, 'checkout', '-q', '-b', 'feature');
    commit(r.root, 'feature.md', `token ${token}\n`);
    git(r.root, 'push', '-q', 'origin', 'feature');
    git(r.root, 'checkout', '-q', 'main');
    git(r.root, 'merge', '-q', '--no-ff', '--no-edit', 'feature');
    const head = git(r.root, 'rev-parse', 'HEAD');
    const error = await inHome(r, () => failure(() => commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true })));
    expect(error.code).toBe('publish_secret_found');
    expect(error.message).toContain('already on a remote-tracking branch');
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(remoteTip(r)).toBe(r.base);
  }, 60_000);

  test('an index another process holds refuses as a race after 3 tries, nothing moved; the next publish redacts', async () => {
    const r = repo();
    const head = commit(r.root, 'notes.md', `token ${token}\n`);
    writeFileSync(join(r.root, '.git', 'index.lock'), '');
    const error = await inHome(r, () => failure(() => commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true })));
    expect(error.code).toBe('publish_secret_rebuild_race');
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(remoteTip(r)).toBe(r.base);
    rmSync(join(r.root, '.git', 'index.lock'));
    expect((await publish(r)).outcome).toBe('pushed');
    expectRemoteClean(r);
  }, 60_000);

  test('secrets.on_push refuse keeps the refusal and writes nothing', async () => {
    const r = repo();
    const head = commit(r.root, 'notes.md', `token ${token}\n`);
    mkdirSync(join(r.home, '.gbrain'), { recursive: true });
    writeFileSync(join(r.home, '.gbrain', 'config.json'), JSON.stringify({ secrets: { on_push: 'refuse' } }));
    const error = await inHome(r, () => failure(() => commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true })));
    expect(error.code).toBe('publish_secret_found');
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(r.root, 'for-each-ref', 'refs/gbrain/backup')).toBe('');
    expect(remoteTip(r)).toBe(r.base);
    expect(existsSync(join(r.home, '.gbrain', 'secret-store', 'spool'))).toBe(false);
  }, 60_000);

  test('redact-unpushed previews without writing, refuses a stale hash, and applies the approved one without pushing', async () => {
    const r = repo();
    const head = commit(r.root, 'notes.md', `token ${token}\n`);
    const preview = await inHome(r, () => redactUnpushed(r.root, { base: r.base })) as RedactPreview;
    expect(preview).toMatchObject({ commits: 1, paths: [{ path: 'notes.md', spans: 1 }], held: [], signed: [] });
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(head);
    const stale = await inHome(r, () => failure(() => redactUnpushed(r.root, { base: r.base, sealer: spoolSealer(r.root, null), expect: '0'.repeat(16) })));
    expect(stale.code).toBe('preview_changed');
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(head);
    const outcome = await inHome(r, () => redactUnpushed(r.root, { base: r.base, sealer: spoolSealer(r.root, null), expect: preview.hash })) as RedactOutcome;
    expect(outcome).toMatchObject({ redacted: true, old_head: head, values: 1 });
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(outcome.new_head);
    expect(remoteTip(r)).toBe(r.base);
    expect(readFileSync(join(r.root, 'notes.md'), 'utf8')).toMatch(MARKER);
  }, 60_000);

  test('gbrain git redact-unpushed: the CLI previews as JSON and applies with --expect', () => {
    const r = repo();
    commit(r.root, 'notes.md', `token ${token}\n`);
    const cli = (...args: string[]) => spawnSync(process.execPath, [resolve(import.meta.dir, '../src/cli.ts'), 'git', 'redact-unpushed', '--path', r.root, '--json', ...args],
      { encoding: 'utf8', env: { ...process.env, GBRAIN_HOME: r.home, GBRAIN_SECRETS_ON_PUSH: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, timeout: 60_000 });
    const preview = cli();
    expect(preview.status).toBe(0);
    const doc = JSON.parse(preview.stdout) as { hash: string; apply: string[] };
    expect(doc.apply).toEqual(['gbrain', 'git', 'redact-unpushed', '--path', r.root, '--apply', '--expect', doc.hash]);
    const applied = cli('--apply', '--expect', doc.hash);
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ redacted: true, pushed: false, values: 1 });
    expect(applied.stdout).not.toContain(token);
    expect(readFileSync(join(r.root, 'notes.md'), 'utf8')).toMatch(MARKER);
  }, 90_000);
});

/** A checkout with a bare remote and a child CLI wrapper, as test/effect-git-secret-gate.test.ts builds it. */
interface Managed { home: string; root: string; remote: string; cli: string }
function managedCheckout(): Managed {
  const home = realpathSync(mkdtempSync(join(dir, 'managed-')));
  const remote = join(home, 'remote.git'), root = join(home, 'brain'), cli = join(home, 'gbrain-child');
  writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${resolve(import.meta.dir, '../src/cli.ts')}' "$@"\n`);
  chmodSync(cli, 0o700);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'initial.md'), 'Initial\n');
  git(root, 'add', 'initial.md'); git(root, 'commit', '-q', '-m', 'Initial');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
  return { home, root, remote, cli };
}
const managedEnv = (c: Managed, onPush?: string) => ({ GBRAIN_HOME: join(c.home, 'home'), GBRAIN_JOB_CHILD_CLI: c.cli, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1',
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_AUDIT_DIR: join(c.home, 'audit'), GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, GBRAIN_SECRETS_ON_PUSH: onPush });

interface Run { engine: BrainEngine; sourceId: string; worktreeId: string; runEffects: () => Promise<void>; effect: () => Promise<{ state: string; error_code: string | null }> }

/** A managed source on the checkout with git durability on, a script commit holding the token in page notes/beta-example, then one page write whose Git effect is queued. */
async function managedWrite(c: Managed, databaseUrl: string | undefined, run: (w: Run) => Promise<void>): Promise<void> {
  await withEnv(managedEnv(c), async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await registerLocalWriter(engine, 'cli');
      const sourceId = 'source-a';
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, c.root]);
      const claimed = await claimWorktree(engine, sourceId, c.root, localHostId());
      await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled' WHERE worktree_id=$1::uuid", [claimed.worktree_id]);
      const page = (body: string) => ({ type: 'note' as const, title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
      await engine.putPage('notes/beta-example', page(`Deploy token ${token}`), { sourceId });
      commit(c.root, 'notes/beta-example.md', `Deploy token ${token}\n`, 'script adds a note');

      const slug = 'notes/acme-example';
      const bound = (await getWorktreeBinding(engine, sourceId, localHostId()))!;
      await engine.putPage(slug, page('Before'), { sourceId });
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
      const file = join(c.root, `${slug}.md`);
      writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
      const ctx: OperationContext = { engine, config: { engine: 'pglite', embedding_disabled: true }, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
      const authority = await submissionAuthority(ctx, 'put_page', sourceId, bound.source_incarnation, slug);
      await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
        sourceIncarnation: bound.source_incarnation, slug, pageId: snapshot.page.id, requestId: randomUUID(),
        callerIntent: { content: 'After' }, intent: { content: 'After' }, worktreeId: bound.worktree_id, topologyGeneration: bound.topology_generation });
      const row = (await claimNextWrite(engine, localHostId()))!;
      const result = await publishMutation(engine, row, { observedRevision: snapshot.revision, file: { path: file, root: c.root, content: 'After' },
        apply: async tx => { await tx.putPage(slug, page('After'), { sourceId }); return {}; } }, localHostId());
      expect(result.state).toBe('committed');
      await run({ engine, sourceId, worktreeId: bound.worktree_id,
        runEffects: async () => {
          await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git'");
          await runPersistenceEffects(engine, { engine: 'pglite', embedding_disabled: true }, { hostId: localHostId(), limit: 10 });
        },
        effect: async () => (await engine.executeRaw<{ state: string; error_code: string | null }>(
          "SELECT state,error_code FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [row.id]))[0]! });
    } finally { await disposePersistenceConsumer(engine); await close(); }
  });
}
const managedRemoteClean = (c: Managed) => {
  expect(git(c.remote, 'log', '--all', '--oneline', '-S', token)).toBe('');
  expect(execFileSync('git', ['-C', c.remote, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 1 << 28 }).toString('latin1')).not.toContain(token);
};

for (const [arm, databaseUrl] of [['pglite', undefined], ...(PG_URL ? [['postgres', PG_URL]] : [])] as Array<[string, string | undefined]>) describe(`GST-2988 through the effect worker (${arm})`, () => {
  test("a page write's Git effect publishes redacted: the store holds the original, the database page holds the same marker", async () => {
    const c = managedCheckout();
    await managedWrite(c, databaseUrl, async w => {
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'committed', error_code: null });
      expect(git(c.remote, 'rev-parse', 'refs/heads/main')).toBe(git(c.root, 'rev-parse', 'HEAD'));
      managedRemoteClean(c);
      const marker = MARKER.exec(readFileSync(join(c.root, 'notes/beta-example.md'), 'utf8'))!;
      const page = (await w.engine.getPage('notes/beta-example', { sourceId: w.sourceId }))!;
      expect(page.compiled_truth).not.toContain(token);
      expect(page.compiled_truth).toContain(marker[0]);
      expect((await reveal(w.engine, marker[2]!, 'test')).value).toBe(token);
      expect(readSpool()).toEqual([]);
    });
  }, 240_000);

  test('a push parked on publish_secret_found under refuse goes out redacted once maintenance retries it (D7a)', async () => {
    const c = managedCheckout();
    const before = git(c.remote, 'rev-parse', 'refs/heads/main');
    await managedWrite(c, databaseUrl, async w => {
      await withEnv({ GBRAIN_SECRETS_ON_PUSH: 'refuse' }, async () => {
        for (let i = 0; i < 8 && (await w.effect()).state !== 'failed'; i++) await w.runEffects();
      });
      expect(await w.effect()).toMatchObject({ state: 'failed', error_code: 'targets_parked' });
      expect(git(c.remote, 'rev-parse', 'refs/heads/main')).toBe(before);
      expect(await secretPublishMaintenance(w.engine)).toMatchObject({ secret_parked_pushes_retried: 1 });
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'committed', error_code: null });
      managedRemoteClean(c);
    });
  }, 300_000);
});
