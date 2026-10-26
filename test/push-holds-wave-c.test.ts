/**
 * Wave C 1A (spec §10 1A, §17 default 3, dx-r3-native-1, dx-r3-outside-6): the Git effect's push holds. A push the
 * pre-push backstop holds (git_push_secret_found: an external commit carries a credential) or the preflight holds
 * (git_push_pack_too_large: one commit over git.push_max_pack_bytes) parks on its first attempt, since no retry can
 * clear it, and \`gbrain sources writer status\` / doctor name an ask_user fix: allowlist the rotated fingerprint through
 * gbrain git commit-push, or raise the cap. Protects:
 *   - the first failing attempt parks (no five retries), nothing is pushed, and the hold names the commit, path, rule and
 *     fingerprint (never the value) or the commit's bytes and the cap;
 *   - a later clean page write stays held behind the external commit;
 *   - after the user's fix, retry-effects --parked-pushes publishes every held write without rewriting history.
 * Seams: GBRAIN_JOB_CHILD_CLI runs this checkout's CLI for the keep-checkout publish. PGLite always, Postgres when
 * DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { readGitPushHolds } from '../src/core/persistence/git-push-holds.ts';
import { pushTiming, setPushMaxPackConfig } from '../src/core/persistence/push-preflight.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { loadConfigFileOnly, saveConfig, type GBrainConfig } from '../src/core/config.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { checkParkedEffects } from '../src/commands/doctor/checks/parked-effects.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { effectSql, pauseGitEffects, release } from './helpers/git-coalescing-fixture.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const MiB = 1024 ** 2;
const longPushBytes = pushTiming.longPushBytes;
const TOKEN = 'AKIA' + 'QX7EXAMPLEZ3K9TB';
const LINE = 'Acme example meeting note, nothing secret in this line at all.\n';
const filler = (bytes: number) => LINE.repeat(Math.ceil(bytes / LINE.length)).slice(0, bytes);
const putPage = operations.find(op => op.name === 'put_page')!;
const page = (title: string, body: string) => '---\ntype: note\ntitle: ' + title + '\n---\n\n' + body + '\n';
const put = (ctx: OperationContext, slug: string, body: string) =>
  putPage.handler(ctx, { slug, content: page(slug, body), request_id: randomUUID(), wait_ms: 30_000 }) as Promise<Record<string, any>>;

function setup({ root }: { root: string }): void {
  writeFileSync(join(root, '.gitignore'), '\n');
  durableGitRepo(root, ['.gitignore']);
  git(root, 'branch', '-M', 'main');
  const remote = join(root, '..', 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
}
const remoteTip = (root: string) => git(join(root, '..', 'remote.git'), 'rev-parse', 'refs/heads/main').trim();
/** A commit made outside gbrain (a hand import), with a clean one on top. */
function externalCommit(root: string, rel: string, data: string | Buffer): string {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), data);
  git(root, 'add', rel); git(root, 'commit', '-q', '-m', 'Imported by hand');
  const sha = git(root, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(root, 'later.txt'), 'A later edit\n');
  git(root, 'add', 'later.txt'); git(root, 'commit', '-q', '-m', 'Later');
  return sha;
}
async function pass(engine: BrainEngine): Promise<void> {
  await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
}
/** Each Git effect in request order; a parked effect parked on its first failure (target_failures at most 1). */
const gitEffects = async (engine: BrainEngine) => (await gitEffectRows(engine)).map(({ failures, ...row }) => { expect(failures ?? 0).toBeLessThanOrEqual(1); return row; });
const gitEffectRows = (engine: BrainEngine) => engine.executeRaw<{ state: string; error_code: string | null; parked: string | null; failures: number | null }>(
  "SELECT e.state, e.error_code, (SELECT string_agg(p->>'error_code', ',') FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) p) AS parked, (e.data->>'target_failures')::int AS failures FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' ORDER BY r.sequence");
function childCli(root: string): string {
  const cli = join(root, '..', 'gbrain-child');
  writeFileSync(cli, '#!/bin/sh\nexec \'' + process.execPath + '\' \'' + resolve(import.meta.dir, '../src/cli.ts') + '\' "$@"\n');
  chmodSync(cli, 0o700);
  return cli;
}
/** The setter `gbrain config set git.push_max_pack_bytes <size>` runs, against this test's GBRAIN_HOME (the file plane). */
function setCap(value: string): void {
  expect(setPushMaxPackConfig(loadConfigFileOnly() ?? ({} as GBrainConfig), value, saveConfig)).toBeNull();
}

for (const backend of testBackends()) describe('[' + backend + '] Wave C 1A: push holds park at once with ask_user fixes', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a secret in an external commit parks the push on its first attempt; a later clean write stays held; the allowlist fix releases both', () => managedBrain(async ({ engine, ctx, root }) => withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
    const pushed = remoteTip(root);
    const bad = externalCommit(root, 'imports/export.md', filler(12 * MiB) + '\naws_key = ' + TOKEN + '\n' + filler(13 * MiB));
    expect(await put(ctx, 'notes/first', 'First page.')).toMatchObject({ state: 'committed' });
    await pass(engine);
    expect(await gitEffects(engine)).toEqual([{ state: 'failed', error_code: 'targets_parked', parked: 'git_push_secret_found' }]);
    expect(remoteTip(root)).toBe(pushed);
    const [hold] = await readGitPushHolds(engine, ['default']);
    expect(structuredClone(hold)).toMatchObject({ root, parked: 1, codes: ['git_push_secret_found'],
      held: { commit: bad, path: 'imports/export.md', rule: 'aws_access_key', fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{16}$/) } });
    const fingerprint = String(hold!.held!.fingerprint);
    expect(structuredClone(hold!.fix)).toMatchObject({ ask_user: true, actor: 'user', argv: ['gbrain', 'git', 'commit-push', '--path', root, '-m', expect.any(String), '--', '.gbrain-scan-allow'] });
    expect(hold!.fix.user_message).toContain(fingerprint);
    expect(hold!.fix.user_message).toContain('retry-effects default --parked-pushes');
    expect(JSON.stringify(hold)).not.toContain(TOKEN.slice(4));
    expect(JSON.stringify(hold!.fix)).not.toMatch(/rebase|filter-branch|filter-repo|reset|--force/);
    expect((await checkParkedEffects(engine, ['default'])).status).toBe('warn');

    expect(await put(ctx, 'notes/second', 'A later clean page.')).toMatchObject({ state: 'committed' });
    await pass(engine);
    expect((await gitEffects(engine)).map(e => e.parked)).toEqual(['git_push_secret_found', 'git_push_secret_found']);
    expect(remoteTip(root)).toBe(pushed);

    writeFileSync(join(root, '.gbrain-scan-allow'), fingerprint + '\n');
    const fix = Bun.spawnSync([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), ...hold!.fix.argv!.slice(1)], { env: { ...process.env }, cwd: root });
    expect({ exit: fix.exitCode, stderr: fix.exitCode ? fix.stderr.toString() : '' }).toEqual({ exit: 0, stderr: '' });
    expect(await runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: 'default', parked_pushes: true })).toMatchObject({ status: 'ok', requests: 2 });
    await pass(engine);
    expect((await gitEffects(engine)).map(e => e.state)).toEqual(['committed', 'committed']);
    expect(remoteTip(root)).toBe(git(root, 'rev-parse', 'HEAD').trim());
    git(root, 'merge-base', '--is-ancestor', bad, 'HEAD');
    expect(await readGitPushHolds(engine, ['default'])).toEqual([]);
  }), { databaseUrl, setup }), 240_000);

  test('one commit over git.push_max_pack_bytes parks git_push_pack_too_large at once; raising the cap releases it', () => managedBrain(async ({ engine, ctx, root }) => withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', GBRAIN_JOB_CHILD_CLI: childCli(root) }, async () => {
    const pushed = remoteTip(root);
    setCap(String(MiB));
    externalCommit(root, 'imports/blob.bin', randomBytes(2 * MiB));
    expect(await put(ctx, 'notes/first', 'First page.')).toMatchObject({ state: 'committed' });
    await pass(engine);
    expect(await gitEffects(engine)).toEqual([{ state: 'failed', error_code: 'targets_parked', parked: 'git_push_pack_too_large' }]);
    expect(remoteTip(root)).toBe(pushed);
    const [hold] = await readGitPushHolds(engine, ['default']);
    const bytes = Number(hold!.held!.bytes);
    expect(bytes).toBeGreaterThan(2 * MiB - 1);
    expect(hold!.held!.cap).toBe(MiB);
    const argv = [...hold!.fix.argv!];
    expect(structuredClone(hold!.fix)).toMatchObject({ ask_user: true, actor: 'host_admin' });
    expect(argv.slice(0, 4)).toEqual(['gbrain', 'config', 'set', 'git.push_max_pack_bytes']);
    expect(Number(argv[4])).toBeGreaterThan(bytes);
    setCap(argv[4]!);
    expect(await runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: 'default', parked_pushes: true })).toMatchObject({ status: 'ok', requests: 1 });
    await pass(engine);
    expect((await gitEffects(engine)).map(e => e.state)).toEqual(['committed']);
    expect(remoteTip(root)).toBe(git(root, 'rev-parse', 'HEAD').trim());
  }), { databaseUrl, setup }), 240_000);
});

describe('[pglite] Wave C 1A review: a long Git effect push runs without the worktree writer lock', () => {
  /** The remote's pre-receive hook tries the worktree writer lock from another process and logs free or busy per push. */
  async function probeDuringPush(engine: BrainEngine, root: string): Promise<string> {
    const binding = await getWorktreeBinding(engine, 'default');
    const log = join(root, '..', 'lock-probe.log'), probe = join(root, '..', 'lock-probe.ts');
    writeFileSync(probe, "import { tryAcquireNativeLock } from '" + resolve(import.meta.dir, '../src/core/persistence/native-lock.ts') + "';\n"
      + "const lock = await tryAcquireNativeLock(process.argv[2]!);\nconsole.log(lock ? 'free' : 'busy');\nawait lock?.release();\n");
    const hook = join(root, '..', 'remote.git', 'hooks', 'pre-receive');
    writeFileSync(hook, "#!/bin/sh\ncat >/dev/null\n'" + process.execPath + "' '" + probe + "' '" + binding!.coordination_path + "' >> '" + log + "' 2>&1\n");
    chmodSync(hook, 0o755);
    writeFileSync(log, '');
    return log;
  }

  test('forced probe: under the threshold the push holds the lock', () => managedBrain(async ({ engine, ctx, root }) => withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
    const log = await probeDuringPush(engine, root);
    expect(await put(ctx, 'notes/first', 'First page.')).toMatchObject({ state: 'committed' });
    await pass(engine);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['busy']);
    expect(remoteTip(root)).toBe(git(root, 'rev-parse', 'HEAD').trim());
  }), { setup }), 240_000);

  test('over the threshold the page effect releases the lock before it pushes', () => managedBrain(async ({ engine, ctx, root }) => withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
    const log = await probeDuringPush(engine, root);
    pushTiming.longPushBytes = 0;
    try {
      expect(await put(ctx, 'notes/first', 'First page.')).toMatchObject({ state: 'committed' });
      await pass(engine);
    } finally { pushTiming.longPushBytes = longPushBytes; }
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['free']);
    expect((await gitEffects(engine)).map(e => e.state)).toEqual(['committed']);
    expect(remoteTip(root)).toBe(git(root, 'rev-parse', 'HEAD').trim());
  }), { setup }), 240_000);
  test('a Git page walk (the source-scan path) releases the lock before a long push too', () => managedBrain(async ({ engine, ctx, root }) => withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
    expect(await put(ctx, 'notes/first', 'First page.')).toMatchObject({ state: 'committed' });
    await pass(engine);
    await pauseGitEffects(engine, () => put(ctx, 'notes/second', 'Second page.'));
    const [walk] = await engine.executeRaw<{ id: string }>("SELECT e.id FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' ORDER BY r.sequence DESC LIMIT 1");
    await effectSql(engine, "UPDATE persistence_effects SET data=data||'{\"source_scan\":true,\"after_slug\":\"zzzz\"}'::jsonb WHERE id=$1", [walk!.id]);
    writeFileSync(join(root, 'later.txt'), 'A later edit\n');
    git(root, 'add', 'later.txt'); git(root, 'commit', '-q', '-m', 'Later');
    const log = await probeDuringPush(engine, root);
    pushTiming.longPushBytes = 0;
    try {
      await release(engine);
      await pass(engine);
    } finally { pushTiming.longPushBytes = longPushBytes; }
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['free']);
    expect(remoteTip(root)).toBe(git(root, 'rev-parse', 'HEAD').trim());
  }), { setup }), 240_000);
});
