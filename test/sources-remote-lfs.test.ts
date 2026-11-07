/**
 * Sources a remote caller adds by URL never download git-lfs objects (security wave, CSO SINK-1, option B).
 *
 * A repository's committed .lfsconfig names the LFS endpoint, and git-lfs contacts it outside the remote-URL gate.
 * On a host with git-lfs installed globally, a remote caller's sources_add could make the brain host send requests to
 * any HTTP endpoint the repository named, on the clone and on every later pull. Protects:
 * - a skipLfs clone, and every later pull, merge or push in it, leave pointer files and contact no LFS endpoint (real git and git-lfs);
 * - sources_add from a remote caller clones that way, records it on the source, and a re-clone follows the record;
 * - sources_add from the trusted local CLI keeps LFS downloads;
 * - a remote caller's failed clone gets a fixed message instead of git's own error.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneRepo, pullRepo } from '../src/core/git-remote.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { lfsDownloadsOff, recloneIfMissing } from '../src/core/sources-ops.ts';
import { cloneTopologyCheckout } from '../src/core/persistence/topology-filesystem.ts';
import { withEnv } from './helpers/with-env.ts';

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0 && process.platform !== 'win32';
const ROOT = mkdtempSync(join(tmpdir(), 'gbrain-remote-lfs-'));
const OID = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 5\n`;

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe.skipIf(!hasLfs)('real git-lfs: skipLfs contacts no LFS endpoint', () => {
  const globalConfig = join(ROOT, 'gitconfig');
  const work = join(ROOT, 'work');
  const bare = join(ROOT, 'repo.git');
  const hitsLog = join(ROOT, 'lfs-hits.log');
  const hits = () => readFileSync(hitsLog, 'utf8').split('\n').filter(Boolean);
  let servers: { kill(): void } | undefined;
  let url: string;
  let lfsPort: number;
  const env = () => ({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' });
  const authorConfig = join(ROOT, 'author-gitconfig');
  // The fixture repository is written without git-lfs, so only the code under test ever runs the LFS filter.
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: authorConfig, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' });

  beforeAll(async () => {
    // cloneRepo blocks this process while git runs, so both servers live in a child process.
    const script = join(ROOT, 'servers.ts');
    writeFileSync(hitsLog, '');
    writeFileSync(script, `
import { appendFileSync } from 'node:fs';
const lfs = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { appendFileSync(${JSON.stringify(hitsLog)}, req.method + ' ' + new URL(req.url).pathname + '\\n'); return new Response('{}', { status: 404 }); } });
const git = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url);
  const body = new Uint8Array(await req.arrayBuffer());
  const proc = Bun.spawn(['git', 'http-backend'], { stdin: body, stdout: 'pipe', stderr: 'pipe', env: {
    PATH: process.env.PATH, GIT_PROJECT_ROOT: ${JSON.stringify(ROOT)}, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1),
    REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers.get('content-type') ?? '', CONTENT_LENGTH: String(body.length), GIT_PROTOCOL: req.headers.get('git-protocol') ?? '' } });
  const out = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  const sep = out.indexOf('\\r\\n\\r\\n');
  const headers = new Headers();
  let status = 200;
  for (const line of out.subarray(0, sep).toString().split('\\r\\n')) {
    const i = line.indexOf(':');
    const key = line.slice(0, i).trim();
    if (key.toLowerCase() === 'status') status = parseInt(line.slice(i + 1), 10); else headers.set(key, line.slice(i + 1).trim());
  }
  return new Response(out.subarray(sep + 4), { status, headers });
} });
console.log(git.port + ' ' + lfs.port);
`);
    const proc = Bun.spawn([process.execPath, '--no-env-file', script], { stdout: 'pipe', stderr: 'inherit' });
    servers = proc;
    const reader = proc.stdout.getReader();
    let first = '';
    while (!first.includes('\n')) { const { value, done } = await reader.read(); if (done) break; first += new TextDecoder().decode(value); }
    reader.releaseLock();
    const [gitPort, lfsPortText] = first.trim().split(' ');
    lfsPort = Number(lfsPortText);
    url = `http://127.0.0.1:${gitPort}/repo.git`;
    writeFileSync(globalConfig, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n');
    writeFileSync(authorConfig, '[user]\n\tname = example\n\temail = example@example.invalid\n');
    mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main', '.');
    writeFileSync(join(work, '.lfsconfig'), `[lfs]\n\turl = http://127.0.0.1:${lfsPort}/internal-lfs\n\tfetchinclude = *\n\tfetchexclude =\n`);
    writeFileSync(join(work, 'x.bin'), pointer);
    writeFileSync(join(work, 'note.md'), '# note\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'pointer');
    writeFileSync(join(work, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    git(work, 'add', '.gitattributes');
    git(work, 'commit', '-q', '-m', 'attributes');
    git(ROOT, 'clone', '-q', '--bare', work, bare);
    git(bare, 'update-server-info');
  });
  afterAll(() => { servers?.kill(); });
  beforeEach(() => { writeFileSync(hitsLog, ''); });

  test('control: a clone without skipLfs asks the repository-named LFS endpoint', async () => {
    await withEnv(env(), async () => {
      try { cloneRepo(url, join(ROOT, 'control'), { timeoutMs: 60_000 }); } catch { /* the endpoint answers 404 */ }
    });
    expect(hits().length).toBeGreaterThan(0);
  }, 90_000);

  test('a skipLfs clone, a later pull, a plain git merge and a push leave pointers and contact no LFS endpoint', async () => {
    const dest = join(ROOT, 'skipped');
    await withEnv(env(), async () => { cloneRepo(url, dest, { timeoutMs: 60_000, depth: 0, skipLfs: true }); });
    expect(readFileSync(join(dest, 'x.bin'), 'utf8')).toBe(pointer);
    writeFileSync(join(work, 'y.bin'), pointer.replace('size 5', 'size 6'));
    git(work, 'add', 'y.bin');
    git(work, 'commit', '-q', '-m', 'second pointer');
    git(work, 'push', '-q', bare, 'main');
    git(bare, 'update-server-info');
    await withEnv(env(), async () => { await pullRepo(dest, { timeoutMs: 60_000 }); });
    expect(readFileSync(join(dest, 'y.bin'), 'utf8')).toContain('size 6');
    // Managed refresh and commit-push move the same checkout with their own plain git calls.
    writeFileSync(join(work, 'z.bin'), pointer.replace('size 5', 'size 7'));
    git(work, 'add', 'z.bin');
    git(work, 'commit', '-q', '-m', 'third pointer');
    git(work, 'push', '-q', bare, 'main');
    git(bare, 'update-server-info');
    const plain = { ...process.env, ...env() };
    execFileSync('git', ['-C', dest, 'fetch', '-q', 'origin'], { env: plain, stdio: 'pipe' });
    execFileSync('git', ['-C', dest, 'merge', '--ff-only', '-q', 'origin/main'], { env: plain, stdio: 'pipe' });
    expect(readFileSync(join(dest, 'z.bin'), 'utf8')).toContain('size 7');
    writeFileSync(join(dest, 'page.md'), '# page\n');
    execFileSync('git', ['-C', dest, 'add', 'page.md'], { env: plain, stdio: 'pipe' });
    execFileSync('git', ['-C', dest, '-c', 'user.name=example', '-c', 'user.email=example@example.invalid', 'commit', '-q', '-m', 'page'], { env: plain, stdio: 'pipe' });
    execFileSync('git', ['-C', dest, 'push', '-q', bare, 'HEAD:refs/heads/from-brain'], { env: plain, stdio: 'pipe' });
    expect(hits()).toEqual([]);
  }, 90_000);
});

describe('sources_add: a remote caller\'s URL source clones without LFS downloads', () => {
  const fakeDir = join(ROOT, 'fake-git');
  const log = join(fakeDir, 'calls.log');
  const mode = join(fakeDir, 'mode');
  const home = join(ROOT, 'home');
  let engine: PGLiteEngine;

  beforeAll(async () => {
    mkdirSync(fakeDir, { recursive: true });
    const recorder = join(fakeDir, 'record.ts');
    writeFileSync(recorder, `
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args }) + '\\n');
if (readFileSync(${JSON.stringify(mode)}, 'utf8') === 'fail') { console.error('fatal: unable to access internal-detail-example: 502'); process.exit(128); }
if (args.includes('clone')) mkdirSync(args[args.length - 1]!, { recursive: true });
`);
    writeFileSync(join(fakeDir, 'git'), `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${recorder}' "$@"\n`);
    chmodSync(join(fakeDir, 'git'), 0o755);
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1').catch(() => {});
  });
  afterAll(async () => { await engine?.disconnect(); });
  beforeEach(() => { writeFileSync(log, ''); writeFileSync(mode, 'ok'); });

  const clones = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { args: string[] }).filter(call => call.args.includes('clone'))
    .map(call => call.args.includes('lfs.fetchexclude=*'));
  const add = (remote: boolean, id: string) => withEnv({ PATH: `${fakeDir}:${process.env.PATH}`, GBRAIN_HOME: home }, () =>
    operationsByName.sources_add!.handler({ engine, remote, auth: remote ? { token: 't', clientId: 'c-admin', scopes: ['sources_admin'] } : undefined } as never,
      { id, url: `https://example.com/acme-example/${id}.git` }));
  const config = async (id: string) => {
    const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [id]);
    return (typeof row?.config === 'string' ? JSON.parse(row.config) : row?.config) as Record<string, unknown>;
  };

  test('a remote caller\'s clone runs with LFS downloads off, and the source records it', async () => {
    await add(true, 'remote-added');
    expect(clones()).toEqual([true]);
    expect((await config('remote-added')).added_by_remote_caller).toBe(true);
  });

  test('a re-clone of that source keeps LFS downloads off', async () => {
    const [row] = await engine.executeRaw<{ local_path: string }>("SELECT local_path FROM sources WHERE id = 'remote-added'");
    rmSync(row!.local_path, { recursive: true, force: true });
    await withEnv({ PATH: `${fakeDir}:${process.env.PATH}`, GBRAIN_HOME: home }, () => recloneIfMissing(engine, 'remote-added'));
    expect(clones()).toEqual([true]);
  });

  test('the trusted local CLI keeps LFS downloads', async () => {
    await add(false, 'local-added');
    expect(clones()).toEqual([false]);
    expect((await config('local-added')).added_by_remote_caller).toBeUndefined();
  });

  test('a remote caller\'s failed clone gets a fixed message; the local CLI keeps git\'s error', async () => {
    writeFileSync(mode, 'fail');
    const remote = await add(true, 'remote-fails').catch((err: Error) => err);
    expect((remote as Error).message).not.toContain('internal-detail-example');
    expect((remote as Error).message).toContain('git clone failed');
    const local = await add(false, 'local-fails').catch((err: Error) => err);
    expect((local as Error).message).toContain('internal-detail-example');
  });
});

describe('cloneTopologyCheckout: the managed reclone writes the same lock-down into the clone', () => {
  const fakeDir = join(ROOT, 'fake-topology-git');
  const log = join(fakeDir, 'calls.log');
  const home = join(ROOT, 'topology-home');
  beforeAll(() => {
    mkdirSync(fakeDir, { recursive: true });
    const recorder = join(fakeDir, 'record.ts');
    writeFileSync(recorder, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
    writeFileSync(join(fakeDir, 'git'), `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${recorder}' "$@"\n`);
    chmodSync(join(fakeDir, 'git'), 0o755);
  });
  beforeEach(() => { writeFileSync(log, ''); });
  const cloneArgs = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
  const run = (destination: string, skipLfs: boolean) => withEnv({ PATH: `${fakeDir}:${process.env.PATH}`, GBRAIN_HOME: home }, async () => {
    mkdirSync(destination, { recursive: true });
    await cloneTopologyCheckout('https://example.com/acme-example/brain.git', destination, 1 << 20, { skipLfs });
  });

  test('skipLfs puts lfs.fetchexclude=*, core.hooksPath=/dev/null and lfs.locksverify=false in the clone config', async () => {
    await run(join(ROOT, 'topology-skip'), true);
    const [args] = cloneArgs();
    const after = args!.slice(args!.indexOf('clone'));
    for (const setting of ['lfs.fetchexclude=*', 'core.hooksPath=/dev/null', 'lfs.locksverify=false'])
      expect(after[after.indexOf(setting) - 1]).toBe('--config');
  });

  test('without skipLfs the clone config is left alone', async () => {
    await run(join(ROOT, 'topology-plain'), false);
    const [args] = cloneArgs();
    expect(args!.includes('lfs.fetchexclude=*')).toBe(false);
    expect(args!.includes('--config')).toBe(false);
  });
});

test('lfsDownloadsOff reads the record from an object or a JSON string and never throws', () => {
  expect(lfsDownloadsOff({ added_by_remote_caller: true })).toBe(true);
  expect(lfsDownloadsOff('{"added_by_remote_caller":true}')).toBe(true);
  expect(lfsDownloadsOff('{not json')).toBe(false);
  expect(lfsDownloadsOff(null)).toBe(false);
  expect(lfsDownloadsOff({ added_by_remote_caller: 'true' })).toBe(false);
});
