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
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { redactUnpushed, spoolSealer, type RedactOutcome, type RedactPreview } from '../src/core/git/redact-unpushed.ts';
import * as redactModule from '../src/core/git/redact-unpushed.ts';
import * as spawnModule from '../src/core/spawn.ts';
const realRedact = redactModule.redactUnpushed;
import { addSpoolOccurrences, allowedLocally, drainSpool, openSpooled, readSpool, refreshAllowedCache, spoolValue, undrainedCount } from '../src/core/secret-store/spool.ts';
import { currentKey, macKeyOf } from '../src/core/secret-store/keyring.ts';
import { backgroundPublish } from '../src/core/git/background-publish.ts';
import { runSecrets } from '../src/commands/secrets.ts';
import { scanText } from '../src/core/secret-scan.ts';
import { createHash, createHmac, randomUUID } from 'node:crypto';
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
import { finishRedactions, secretPublishMaintenance, settlePublishRedactions } from '../src/core/git/redact-finish.ts';
import { purgeSecretsForSlugs, recordOccurrence, reveal, seal } from '../src/core/secret-store/store.ts';
import { computeIsoWeekFilename } from '../src/core/audit/audit-writer.ts';
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
    const spooledNotice = result.notices!.find(n => n.code === 'secret_store_spooled')!;
    expect(spooledNotice.kind).toBe('info');
    expect(spooledNotice.why).toStartWith('1 original(s) were sealed in this machine\'s encrypted spool');
    expect(spooledNotice.why).toContain('gbrain git commit-push does not move them itself');
    expect(spooledNotice.why).not.toContain('could not be written');
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

  test('with no git identity configured anywhere, a held-back publish still pushes and every rebuilt commit keeps its original author and committer', async () => {
    const r = repo();
    git(r.root, 'config', 'user.useConfigOnly', 'true');
    const empty = join(dir, `${r.root.split('/').pop()}-nohome`);
    mkdirSync(empty);
    const noIdentity: Record<string, string | undefined> = { HOME: empty, XDG_CONFIG_HOME: empty, GIT_CONFIG_NOSYSTEM: '1', EMAIL: undefined,
      GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined };
    const who = (rev: string) => git(r.root, 'log', '-1', '--format=%an|%ae|%ad|%cn|%ce|%cd', '--date=raw', rev);
    const as = (name: string, email: string, when: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: `${name} Committer`, GIT_COMMITTER_EMAIL: `c-${email}`, GIT_COMMITTER_DATE: when });
    const commitAs = (path: string, data: string | Buffer, env: NodeJS.ProcessEnv) => {
      writeFileSync(join(r.root, path), data);
      execFileSync('git', ['-C', r.root, 'add', path]);
      execFileSync('git', ['-C', r.root, '-c', 'commit.gpgsign=false', 'commit', '-qm', path], { env });
    };
    commitAs('notes.md', `token ${token}\n`, as('Alice Example', 'alice@example.invalid', '1700000000 +0100'));
    commitAs('legacy.txt', Buffer.concat([Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20]), Buffer.from(`key ${token}\n`)]), as('Bob Example', 'bob@example.invalid', '1700000100 -0500'));
    const before = [who('HEAD~1'), who('HEAD')];
    const bare = Object.fromEntries(Object.entries({ ...process.env, ...noIdentity }).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;
    expect(spawnSync('git', ['-C', r.root, 'var', 'GIT_AUTHOR_IDENT'], { env: bare }).status).not.toBe(0);
    const result = await inHome(r, () => commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true }), noIdentity);
    expect(result.outcome).toBe('pushed');
    expect(result.redaction!.held).toEqual([{ path: 'legacy.txt', reason: 'not_utf8' }]);
    expect([who('HEAD~2'), who('HEAD~1')]).toEqual(before);
    expect(who('HEAD')).toBe(before[1]!);
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

  test('a publish whose redaction waits on a busy commit lock stops at its overall budget, not at the lock wait', async () => {
    const r = repo();
    const head = commit(r.root, 'notes.md', `token ${token}\n`);
    const lockPath = resolve(r.root, git(r.root, 'rev-parse', '--git-path', 'brain-commit.lock'));
    const holder = spawn(process.execPath, ['-e', `const { acquireNativeLockSync } = await import(${JSON.stringify(resolve('src/core/persistence/native-lock.ts'))}); const held = acquireNativeLockSync(${JSON.stringify(lockPath)}, { timeoutMs: 0 }); if (!held) process.exit(3); console.log('held'); await new Promise(r => setTimeout(r, 60_000)); held.release();`], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>(held => holder.stdout!.on('data', d => { if (String(d).includes('held')) held(); }));
      const started = Date.now();
      const error = await inHome(r, () => failure(() => commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true, scanTimeoutMs: 3_000, lockWaitMs: 20_000 })));
      expect(error.code).toBe('publish_secret_rebuild_unbounded');
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(git(r.root, 'rev-parse', 'HEAD')).toBe(head);
      expect(remoteTip(r)).toBe(r.base);
    } finally { holder.kill(); }
  }, 60_000);

  test('planning a range with a thousand distinct values in one file stays linear: the preview finishes in seconds, every value once', async () => {
    const r = repo();
    const rows = Array.from({ length: 1000 }, (_, i) => `row ${i} token ghp_${createHash('sha256').update(String(i)).digest('hex').slice(0, 36)} ${'lorem ipsum '.repeat(160)}`);
    commit(r.root, 'export.md', rows.join('\n') + '\n');
    const started = Date.now();
    const preview = await inHome(r, () => redactUnpushed(r.root, { base: r.base })) as RedactPreview;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(preview.rules.github_token).toMatchObject({ values: 1000, hits: 1000 });
  }, 120_000);

  test('the first scan and the redaction share one deadline: the redaction gets what is left of the publish budget, not a fresh one', async () => {
    const r = repo();
    commit(r.root, 'notes.md', `token ${token}\n`);
    const deadlines: Array<number | undefined> = [], calledAt: number[] = [];
    const spy = spyOn(redactModule, 'redactUnpushed').mockImplementation((root, opts) => { deadlines.push(opts.deadline); calledAt.push(Date.now()); return realRedact(root, opts); });
    try {
      const started = Date.now();
      expect((await inHome(r, () => commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true, scanTimeoutMs: 60_000 }))).outcome).toBe('pushed');
      expect(deadlines).toHaveLength(1);
      expect(deadlines[0]).toBeGreaterThan(started);
      expect(deadlines[0]).toBeLessThan(calledAt[0]! + 60_000);
    } finally { spy.mockRestore(); }
    expectRemoteClean(r);
  }, 60_000);

  test('planning about 48,000 hits of a few repeated credentials across three 20 MB files, plus rare ones, finishes in seconds', async () => {
    const r = repo();
    const at = '@', creds = Array.from({ length: 6 }, (_, i) => `https://svc${i}:Zt4qXk9mPw${i}Lr7Qa${at}db${i}.example.invalid/q`);
    for (let f = 0; f < 3; f++) {
      const lines = Array.from({ length: 400_000 }, (_, i) => i % 25 === 0 ? `sync ${i} via ${creds[(i / 25 + f) % 6]} ok` : `line ${i} of the export with ordinary text here`);
      if (f === 0) for (let k = 0; k < 17; k++) lines[k * 7 + 3] = `rare https://ops${k}:Qm${k}Vt8Wn3Rp${at}vault${k}.example.invalid/k`;
      writeFileSync(join(r.root, `export-${f}.md`), lines.join('\n') + '\n');
    }
    git(r.root, 'add', '.'); git(r.root, 'commit', '-qm', 'exports');
    const started = Date.now();
    const preview = await inHome(r, () => redactUnpushed(r.root, { base: r.base, budgetMs: 600_000 })) as RedactPreview;
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(preview.rules.url_credentials).toMatchObject({ values: 23, hits: 48_017 });
  }, 180_000);

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

  test('a file with thousands of hits redacts inside the budget, one occurrence per hit, and the moved branch is journaled', async () => {
    const r = repo();
    const keyId = 'AKIA' + 'Q7RZ' + '00' + 'X3M9P2K4W8';
    const lines = Array.from({ length: 8000 }, (_, n) => `GET /r${n}.pdf?X-Amz-Credential=${keyId}%2F20250101 200`);
    commit(r.root, 'access.log.md', `${lines.join('\n')}\n`);
    const started = performance.now();
    const outcome = await inHome(r, () => redactUnpushed(r.root, { base: r.base, sealer: spoolSealer(r.root, null), budgetMs: 10_000 })) as RedactOutcome;
    console.log(`[GST-2988 8000-hit file] redaction took ${Math.round(performance.now() - started)} ms`);
    expect(outcome).toMatchObject({ redacted: true, values: 1, rules: { aws_access_key: { values: 1, hits: 8000, signed_link: 8000, bare: 0 } } });
    const spooled = await inHome(r, () => readSpool());
    expect(spooled).toHaveLength(1);
    expect(spooled[0]!.occurrences.map(o => o.line)).toEqual(lines.map((_, n) => n + 1));
    const journal = readFileSync(join(r.root, '.git', 'gbrain', 'redactions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(journal).toEqual([expect.objectContaining({ old_head: outcome.old_head, new_head: outcome.new_head })]);
  }, 120_000);

  test('a budget that runs out just after the branch moves still journals the move and reports the redaction', async () => {
    const r = repo();
    commit(r.root, 'notes.md', `token ${token}\n`);
    const realNow = Date.now.bind(Date), realSpawn = spawnModule.spawnSync;
    let shift = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + shift);
    const spawnSpy = spyOn(spawnModule, 'spawnSync').mockImplementation(((command: string, ...rest: unknown[]) => {
      const out = (realSpawn as (...a: unknown[]) => unknown)(command, ...rest);
      if (Array.isArray(rest[0]) && (rest[0] as string[]).includes('update-ref') && (rest[0] as string[]).some(a => a.includes('secrets replaced by store markers'))) shift = 3_600_000;
      return out;
    }) as typeof spawnModule.spawnSync);
    let outcome: RedactOutcome;
    try {
      outcome = await inHome(r, () => redactUnpushed(r.root, { base: r.base, sealer: spoolSealer(r.root, null), budgetMs: 60_000 })) as RedactOutcome;
    } finally { spawnSpy.mockRestore(); clock.mockRestore(); }
    expect(outcome).toMatchObject({ redacted: true });
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(outcome.new_head);
    const journal = readFileSync(join(r.root, '.git', 'gbrain', 'redactions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(journal).toEqual([expect.objectContaining({ old_head: outcome.old_head, new_head: outcome.new_head })]);
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
  test('GBRAIN_SECRETS_ON_PUSH only tightens: refuse beats config redact, and redact, off or empty never loosens config refuse', async () => {
    const r = repo();
    const head = commit(r.root, 'notes.md', `token ${token}\n`);
    const attempt = (value: string) => inHome(r, () => failure(() => commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true })), { GBRAIN_SECRETS_ON_PUSH: value });
    expect((await attempt('refuse')).code).toBe('publish_secret_found');
    mkdirSync(join(r.home, '.gbrain'), { recursive: true });
    writeFileSync(join(r.home, '.gbrain', 'config.json'), JSON.stringify({ secrets: { on_push: 'refuse' } }));
    for (const value of ['redact', 'off', '']) expect((await attempt(value)).code).toBe('publish_secret_found');
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(r.root, 'for-each-ref', 'refs/gbrain/backup')).toBe('');
    expect(remoteTip(r)).toBe(r.base);
    expect(existsSync(join(r.home, '.gbrain', 'secret-store', 'spool'))).toBe(false);
  }, 60_000);

  test('any other GBRAIN_SECRETS_ON_PUSH value changes nothing and prints one notice on stderr', () => {
    const r = repo();
    const mode = (env: string | undefined, config?: object) => {
      if (config) { mkdirSync(join(r.home, '.gbrain'), { recursive: true }); writeFileSync(join(r.home, '.gbrain', 'config.json'), JSON.stringify(config)); }
      const child = spawnSync(process.execPath, ['-e', `const { onPushMode } = await import(${JSON.stringify(resolve(import.meta.dir, '../src/core/git/redact-unpushed.ts'))}); console.log(onPushMode(), onPushMode());`],
        { encoding: 'utf8', env: { ...process.env, GBRAIN_HOME: r.home, GBRAIN_SECRETS_ON_PUSH: env }, timeout: 30_000 });
      expect(child.status).toBe(0);
      return { modes: child.stdout.trim(), notices: child.stderr.split('\n').filter(l => l.includes('GBRAIN_SECRETS_ON_PUSH')) };
    };
    const notice = (value: string) => `[gbrain notice] GBRAIN_SECRETS_ON_PUSH=${JSON.stringify(value)} is ignored: its only value is refuse; secrets.on_push in the config decides.`;
    expect(mode('off')).toEqual({ modes: 'redact redact', notices: [notice('off')] });
    expect(mode('refuse')).toEqual({ modes: 'refuse refuse', notices: [] });
    expect(mode(undefined)).toEqual({ modes: 'redact redact', notices: [] });
    expect(mode('redact', { secrets: { on_push: 'refuse' } })).toEqual({ modes: 'refuse refuse', notices: [notice('redact')] });
    expect(mode('', { secrets: { on_push: 'refuse' } })).toEqual({ modes: 'refuse refuse', notices: [notice('')] });
  }, 60_000);
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
/**
 * The child CLI answers a foreground keep-checkout publish as one past its budget (publish_secret_rebuild_unbounded)
 * and logs its arguments; a publish given the background budget (--scan-timeout 600) runs for real unless always is set.
 */
function overBudgetChild(c: Managed, always: boolean): string {
  const log = join(c.home, 'child-args.log');
  const real = `exec '${process.execPath}' '${resolve(import.meta.dir, '../src/cli.ts')}' "$@"`;
  const fake = `printf '%s\\n' '{"code":"publish_secret_rebuild_unbounded","message":"Redacting the unpushed commits ran past its budget."}'; exit 1`;
  writeFileSync(c.cli, ['#!/bin/sh', `echo "$*" >> '${log}'`, 'case " $* " in',
    `  *" commit-push "*"--scan-timeout 600 "*) ${always ? fake : real} ;;`, `  *" commit-push "*) ${fake} ;;`, 'esac', real, ''].join('\n'));
  chmodSync(c.cli, 0o700);
  return log;
}
async function backgroundDone(root: string): Promise<void> {
  for (let i = 0; i < 900 && backgroundPublish(root).state === 'running'; i++) await Bun.sleep(200);
  expect(backgroundPublish(root).state).toBe('done');
}
async function secretsOutput(engine: BrainEngine, args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runSecrets(engine, args); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

for (const [arm, databaseUrl] of [['pglite', undefined], ...(PG_URL ? [['postgres', PG_URL]] : [])] as Array<[string, string | undefined]>) describe(`GST-2988 through the effect worker (${arm})`, () => {
  test("a page write's Git effect publishes redacted: the store holds the original, the database page holds the same marker", async () => {
    const c = managedCheckout();
    await managedWrite(c, databaseUrl, async w => {
      const auditFile = join(c.home, 'audit', computeIsoWeekFilename('secret-spans'));
      mkdirSync(join(c.home, 'audit'), { recursive: true });
      writeFileSync(auditFile, '', { mode: 0o644 });
      chmodSync(auditFile, 0o644);
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'committed', error_code: null });
      expect(git(c.remote, 'rev-parse', 'refs/heads/main')).toBe(git(c.root, 'rev-parse', 'HEAD'));
      managedRemoteClean(c);
      expect(readFileSync(auditFile, 'utf8')).toContain('"kind":"publish-redact"');
      expect(readFileSync(auditFile, 'utf8')).not.toContain(token);
      expect(statSync(auditFile).mode & 0o777).toBe(0o600);
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

  test('a process that stops between its push and the drain loses nothing; the next owner run drains the spool', async () => {
    const c = managedCheckout();
    await managedWrite(c, databaseUrl, async w => {
      // The publish alone, with no drain after it: what a process killed between the two leaves behind.
      expect(commitAndPush({ repo: c.root, cwd: c.root, paths: [], pushOnly: true, keepCheckout: true }).outcome).toBe('pushed');
      managedRemoteClean(c);
      const id = MARKER.exec(readFileSync(join(c.root, 'notes/beta-example.md'), 'utf8'))![2]!;
      expect(undrainedCount()).toBe(1);
      expect((await reveal(w.engine, id, 'test')).value).toBe(token);
      expect(await secretsOutput(w.engine, ['list'])).toContain("1 original(s) a publish redacted wait in this machine's spool for the store");
      expect(JSON.parse(await secretsOutput(w.engine, ['list', '--json']))).toMatchObject({ entries: [], spooled: 1 });

      // A store row that does not read back keeps the spool file.
      const blind = new Proxy(w.engine, { get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => sql.startsWith('SELECT id,source_id,rule,ciphertext') ? Promise.resolve([]) : target.executeRaw(sql, params);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      expect(await drainSpool(blind)).toMatchObject({ moved: 0 });
      expect(undrainedCount()).toBe(1);
      expect(openSpooled(id)!.value).toBe(token);

      // The next owner run: the page write's Git effect redacts nothing itself and still drains what was left.
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'committed', error_code: null });
      expect(readSpool()).toEqual([]);
      expect(undrainedCount()).toBe(0);
      expect((await reveal(w.engine, id, 'test')).value).toBe(token);
      expect(JSON.parse(await secretsOutput(w.engine, ['list', '--json']))).toMatchObject({ entries: [{ id }], spooled: 0 });
      expect(await secretsOutput(w.engine, ['list'])).not.toContain('spool');
      expect((await w.engine.getPage('notes/beta-example', { sourceId: w.sourceId }))!.compiled_truth).toContain(`:${id}>`);
      managedRemoteClean(c);
    });
  }, 300_000);

  test('allowed.json holds an HMAC under the store key (never a bare hash of the value) and is mode 0600', async () => {
    const home = realpathSync(mkdtempSync(join(dir, 'allowed-')));
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SECRET_STORE_KEY: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.executeRaw("INSERT INTO sources(id,name) VALUES('source-a','source-a')");
        const sealed = await seal(engine, { sourceId: 'source-a', rule: 'github_token', value: token });
        await engine.executeRaw("UPDATE secret_store SET status='allowed' WHERE id=$1", [sealed.id]);
        await refreshAllowedCache(engine);
        const file = join(home, '.gbrain', 'secret-store', 'allowed.json');
        expect(statSync(file).mode & 0o777).toBe(0o600);
        const text = readFileSync(file, 'utf8');
        const key = currentKey({ create: false })!;
        const mac = createHmac('sha256', macKeyOf(key.key)).update(token, 'utf8').digest('hex');
        expect(JSON.parse(text)).toEqual([{ key_id: sealed.key_id, value_mac: mac }]);
        expect(text).not.toContain(token);
        expect(text).not.toContain(createHash('sha256').update(token, 'utf8').digest('hex'));
        expect(text).not.toContain(createHmac('sha256', key.key).update(token, 'utf8').digest('hex'));
        expect(allowedLocally(token)).toBe(true);
        expect(allowedLocally(token + 'x')).toBe(false);
      } finally { await close(); }
    });
  }, 120_000);

  test('a publish past its budget retries once in the background with 2x the budget; the root waits as a dependency, then settles the redaction', async () => {
    const c = managedCheckout();
    const log = overBudgetChild(c, false);
    await managedWrite(c, databaseUrl, async w => {
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'queued', error_code: 'publish_secret_rebuild_unbounded' });
      expect(backgroundPublish(c.root).state).not.toBe('none');
      await backgroundDone(c.root);
      expect(readFileSync(log, 'utf8')).toContain(`git commit-push --push-only --keep-checkout --scan-secrets --scan-timeout 600 --path ${c.root} --json`);
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'committed', error_code: null });
      expect(backgroundPublish(c.root).state).toBe('none');
      expect(git(c.remote, 'rev-parse', 'refs/heads/main')).toBe(git(c.root, 'rev-parse', 'HEAD'));
      managedRemoteClean(c);
      const marker = MARKER.exec(readFileSync(join(c.root, 'notes/beta-example.md'), 'utf8'))!;
      expect((await reveal(w.engine, marker[2]!, 'test')).value).toBe(token);
      expect(readSpool()).toEqual([]);
      expect((await w.engine.getPage('notes/beta-example', { sourceId: w.sourceId }))!.compiled_truth).toContain(marker[0]);
    });
  }, 300_000);

  test('a background publish past its 2x budget again holds the pushes as publish_scan_unreadable, new commits or not, until the remote branch moves', async () => {
    const c = managedCheckout();
    const before = git(c.remote, 'rev-parse', 'refs/heads/main');
    const log = overBudgetChild(c, true);
    await managedWrite(c, databaseUrl, async w => {
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'queued', error_code: 'publish_secret_rebuild_unbounded' });
      await backgroundDone(c.root);
      // A page write lands meanwhile: HEAD moves, and the hold must not turn into a fresh background run.
      commit(c.root, 'notes/later.md', 'later\n');
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'queued', error_code: 'publish_scan_unreadable' });
      await w.runEffects();
      expect(readFileSync(log, 'utf8').split('\n').filter(line => line.includes('--scan-timeout 600'))).toHaveLength(1);
      expect(git(c.remote, 'rev-parse', 'refs/heads/main')).toBe(before);
      managedRemoteClean(c);

      // The fix the hold names: a publish by hand with a longer budget moves the remote branch, and the backups go on.
      const manual = spawnSync(process.execPath, [resolve(import.meta.dir, '../src/cli.ts'), 'git', 'commit-push', '--push-only', '--keep-checkout', '--scan-secrets',
        '--scan-timeout', '600', '--path', c.root, '--json'], { encoding: 'utf8', env: process.env, timeout: 120_000 });
      expect(JSON.parse(manual.stdout.trim().split('\n').pop()!)).toMatchObject({ outcome: 'pushed' });
      await w.runEffects();
      expect(await w.effect()).toMatchObject({ state: 'committed', error_code: null });
      expect(backgroundPublish(c.root).state).toBe('none');
      expect(git(c.remote, 'rev-parse', 'refs/heads/main')).toBe(git(c.root, 'rev-parse', 'HEAD'));
      managedRemoteClean(c);
    });
  }, 300_000);

  test('a page redaction that fails leaves the journal entry pending, and the next pass redacts the page', async () => {
    const c = managedCheckout();
    await managedWrite(c, databaseUrl, async w => {
      expect(commitAndPush({ repo: c.root, cwd: c.root, paths: [], pushOnly: true, keepCheckout: true }).outcome).toBe('pushed');
      await drainSpool(w.engine);
      const failing = new Proxy(w.engine, { get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === 'transaction') return () => Promise.reject(Object.assign(new Error('connection lost'), { code: 'pg_connection_lost' }));
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      expect(await finishRedactions(failing, c.root)).toMatchObject({ redactions: 0, pages: { pg_connection_lost: 1 } });
      expect((await w.engine.getPage('notes/beta-example', { sourceId: w.sourceId }))!.compiled_truth).toContain(token);
      expect(await finishRedactions(w.engine, c.root)).toMatchObject({ redactions: 1, pages: { redacted: 1 } });
      const marker = MARKER.exec(readFileSync(join(c.root, 'notes/beta-example.md'), 'utf8'))!;
      const page = (await w.engine.getPage('notes/beta-example', { sourceId: w.sourceId }))!;
      expect(page.compiled_truth).not.toContain(token);
      expect(page.compiled_truth).toContain(marker[0]);
      expect(await finishRedactions(w.engine, c.root)).toMatchObject({ redactions: 0 });
    });
  }, 300_000);

  /** A plain checkout (no managed worktree) whose sources live in a fresh brain at this arm. */
  const withBrain = (home: string, run: (engine: BrainEngine) => Promise<void>) =>
    withEnv({ GBRAIN_HOME: home, GBRAIN_SECRETS_ON_PUSH: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try { await run(engine); } finally { await close(); }
    });
  const note = (body: string) => ({ type: 'note' as const, title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });

  test('a spooled original the store already holds under another id stays spooled as a duplicate, and reveal still reads it', async () => {
    const r = repo();
    await withBrain(r.home, async engine => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-a', r.root]);
      const sealed = await seal(engine, { sourceId: 'source-a', rule: 'github_token', value: token });
      const id = spoolValue({ root: r.root, sourceId: 'source-a', rule: 'github_token', value: token });
      expect(id).not.toBe(sealed.id);
      addSpoolOccurrences(id, [{ commit: 'c'.repeat(40), path: 'notes.md', line: 1, field: 'file' }]);
      expect(await drainSpool(engine)).toMatchObject({ moved: 0, remaining: 0 });
      expect(await engine.executeRaw('SELECT commit_sha FROM secret_store_occurrence WHERE entry_id = $1', [sealed.id])).toEqual([{ commit_sha: 'c'.repeat(40) }]);
      await recordOccurrence(engine, { entryId: sealed.id, sourceId: 'source-a', slug: 'notes/held', field: 'compiled_truth', origin: 'repair' });
      expect(await purgeSecretsForSlugs(engine, 'source-a', ['notes/held'])).toEqual({ occurrences: 1, entries: 0 });
      expect(readSpool().find(entry => entry.id === id)?.duplicate_of).toBe(sealed.id);
      expect(undrainedCount()).toBe(0);
      expect((await reveal(engine, id, 'test')).value).toBe(token);
      expect(await engine.executeRaw('SELECT id FROM secret_store')).toEqual([{ id: sealed.id }]);
    });
  }, 120_000);

  test('in a checkout that backs two sources, a spooled original goes to the source holding its file, so file and page carry the same marker', async () => {
    const r = repo();
    mkdirSync(join(r.root, 'sub'));
    commit(r.root, 'sub/notes.md', `Deploy token ${token}\n`);
    await withBrain(r.home, async engine => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2),($3,$3,$4)', ['source-a', r.root, 'source-b', join(r.root, 'sub')]);
      await engine.putPage('notes', note(`Deploy token ${token}\n`), { sourceId: 'source-b' });
      expect(commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true }).outcome).toBe('pushed');
      await settlePublishRedactions(engine, r.root);
      const marker = MARKER.exec(readFileSync(join(r.root, 'sub/notes.md'), 'utf8'))!;
      expect((await engine.getPage('notes', { sourceId: 'source-b' }))!.compiled_truth).toContain(marker[0]);
      expect(await engine.executeRaw('SELECT id, source_id FROM secret_store')).toEqual([{ id: marker[2], source_id: 'source-b' }]);
      expectRemoteClean(r);
    });
  }, 180_000);

  test('a folder of emails with presigned links: only each key id becomes a marker, one entry per value, one occurrence per hit, counted by rule', async () => {
    const r = repo();
    const keyIds = Array.from({ length: 6 }, (_, i) => 'AKIA' + 'Q7RZ' + String(i).padStart(2, '0') + 'X3M9P2K4W8');
    const signature = 'a1b2c3d4'.repeat(8);
    const link = (id: string, n: number) => `https://files-example.s3.amazonaws.com/reports/r${n}.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${id}%2F20250101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20250101T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=${signature}`;
    const emails = Array.from({ length: 20 }, (_, n): [string, string] => [`mail/msg-${String(n).padStart(2, '0')}.md`,
      [`From: sender@example.invalid`, `Subject: Your report ${n}`, '', 'Download it here (the link expires in an hour):',
        link(keyIds[n % 6]!, n), ...(n < 5 ? [link(keyIds[(n + 1) % 6]!, n + 100)] : []), ...(n === 19 ? [`The old key id was ${keyIds[0]} until rotation.`] : []), ''].join('\n')]);
    mkdirSync(join(r.root, 'mail'));
    for (const [file, body] of emails) writeFileSync(join(r.root, file), body);
    git(r.root, 'add', 'mail'); git(r.root, 'commit', '-qm', 'import mail');
    await withBrain(r.home, async engine => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-a', r.root]);
      for (const [file, body] of emails) await engine.putPage(file.replace(/\.md$/, ''), note(body), { sourceId: 'source-a' });
      const started = performance.now();
      const result = commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true });
      const wallMs = Math.round(performance.now() - started);
      console.log(`[GST-2988 presigned-link fixture] 20 files, 26 hits, 6 values: publish with redaction took ${wallMs} ms`);
      expect(wallMs).toBeLessThan(30_000);
      expect(result.outcome).toBe('pushed');
      const counts = { values: 6, hits: 26, signed_link: 25, bare: 1 };
      expect(result.redaction).toMatchObject({ values: 6, rules: { aws_access_key: counts } });
      expect(result.notices?.find(n => n.code === 'publish_secret_redacted')?.why)
        .toContain('aws_access_key: 26 hit(s) of 6 value(s), 25 in a signed-link credential parameter (X-Amz-Credential=), 1 bare');
      for (const id of keyIds) {
        expect(git(r.remote, 'log', '--all', '--oneline', '-S', id)).toBe('');
        expect(remoteObjects(r)).not.toContain(id);
      }
      for (const [file, body] of emails) {
        const redacted = readFileSync(join(r.root, file), 'utf8');
        expect(redacted).toContain('X-Amz-Credential=<REDACTED:aws_access_key:ss_');
        expect(redacted).toContain(`%2F20250101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20250101T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=${signature}`);
        expect(redacted.replace(new RegExp(MARKER.source, 'g'), (_, _rule, id) => openSpooled(id)!.value)).toBe(body);
      }
      expect(readSpool()).toHaveLength(6);
      expect(readSpool().reduce((n, entry) => n + entry.occurrences.length, 0)).toBe(26);

      await settlePublishRedactions(engine, r.root);
      expect(undrainedCount()).toBe(0);
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM secret_store')).toEqual([{ n: 6 }]);
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM secret_store_occurrence WHERE commit_sha IS NOT NULL')).toEqual([{ n: 26 }]);
      const listed = JSON.parse(await secretsOutput(engine, ['list', '--json']));
      expect(listed.by_rule.aws_access_key.entries).toBe(6);
      expect(listed.publish_redactions).toEqual({ redactions: 1, rules: { aws_access_key: counts } });
      const human = await secretsOutput(engine, ['list']);
      expect(human).toContain('aws_access_key: 6 entries');
      expect(human).toContain('publish redactions on this machine, aws_access_key: 26 hit(s) of 6 value(s), 25 in a signed-link credential parameter (X-Amz-Credential=), 1 bare');
      const marker = MARKER.exec(readFileSync(join(r.root, 'mail/msg-00.md'), 'utf8'))!;
      expect((await engine.getPage('mail/msg-00', { sourceId: 'source-a' }))!.compiled_truth).toContain(marker[0]);
    });
  }, 300_000);
});
