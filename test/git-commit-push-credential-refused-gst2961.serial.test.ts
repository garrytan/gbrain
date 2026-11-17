/**
 * GST-2961: a push the Git host refuses for the credential git used ("Repository not found", HTTP 404, or HTTP 403)
 * is a credential fault, not a transient one. `gbrain git commit-push` stops at once with push_credential_refused
 * (exit 1, not retryable), names the credential helpers git asked in order with their scope and file, which one
 * answered and its login, and never the secret; the refusal is recorded until a push lands, where doctor's
 * git_convergence and put_page's lastPushStatus read it. A dropped connection keeps the retry it had before.
 *
 * Real git against a local smart-HTTP stub (test/fixtures/git-credential-stub/server.ts) with fake credential
 * helpers; no network and no real tokens. The machine-wide helper answers first with another account's canary
 * token, the shape of the incident.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { credentialHelperKeysArgv, credentialRefusal } from '../src/core/git/push-credential.ts';
import { readCredentialRefusal } from '../src/core/git/commit-push.ts';
import { getLastPushOutcome } from '../src/core/brain-repo-durability.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { gitConvergenceCheck } from '../src/commands/doctor/checks/git-convergence.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { policyStatus } from '../src/core/access/policy.ts';
import { withEnv } from './helpers/with-env.ts';

const CANARY = 'CANARY-gst2961-global-not-a-real-token';
const LOCAL_SECRET = 'CANARY-gst2961-local-not-a-real-token';
const INLINE_SECRET = 'CANARY-gst2961-inline-not-a-real-token';
const CLI = resolve(import.meta.dir, '../src/cli.ts');

let dir: string;
let server: ChildProcess;
let port = 0;
let globalConfig: string;
let home: string;

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', ...env } }).trim();
}

const env = (extra: Record<string, string> = {}) => ({ ...process.env, GBRAIN_HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...extra });

async function count(mode: string): Promise<number> {
  return Number(await (await fetch('http://127.0.0.1:' + port + '/__count/' + mode)).text());
}

function writeHelper(name: string, user: string, secret: string, silentVar?: string): string {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\n[ "$1" = get ] || exit 0\ncat >/dev/null\n' + (silentVar ? '[ -n "$' + silentVar + '" ] && exit 0\n' : '') + 'echo username=' + user + '\necho password=' + secret + '\n');
  chmodSync(path, 0o755);
  return path;
}

/** A checkout of a fresh bare repository served under /<mode>/, with its own helper, one commit ahead of the remote. */
function checkout(name: string, mode: string): string {
  const bare = join(dir, 'srv', name + '.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const work = join(dir, name);
  git(dir, ['clone', '-q', bare, work]);
  git(work, ['config', 'user.email', 'a@example.com']);
  git(work, ['config', 'user.name', 'a']);
  writeFileSync(join(work, 'x.md'), 'one\n');
  git(work, ['add', 'x.md']); git(work, ['commit', '-qm', 'seed']); git(work, ['push', '-q', '-u', 'origin', 'main']);
  git(work, ['config', 'credential.helper', join(dir, 'helper-local.sh')]);
  git(work, ['remote', 'set-url', 'origin', 'http://127.0.0.1:' + port + '/' + mode + '/' + name + '.git']);
  writeFileSync(join(work, 'x.md'), 'two\n');
  git(work, ['commit', '-qam', 'unpushed']);
  return work;
}

function setMode(work: string, mode: string) {
  const name = work.slice(work.lastIndexOf('/') + 1);
  git(work, ['remote', 'set-url', 'origin', 'http://127.0.0.1:' + port + '/' + mode + '/' + name + '.git']);
}

function commitPush(work: string, extra: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, [CLI, 'git', 'commit-push', '--push-only', '--path', work, '--json'], { encoding: 'utf8', env: env(extra), timeout: 120_000 });
  let doc: Record<string, unknown> = {};
  try { doc = JSON.parse(run.stdout); } catch { /* asserted below */ }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, doc };
}

/** How many receive-pack requests one plain git push makes against this mode, so attempt counts compare across git versions. */
async function onePlainPush(work: string, mode: string): Promise<number> {
  const before = await count(mode);
  spawnSync('git', ['-C', work, 'push', 'origin', 'main'], { env: env(), stdio: 'ignore' });
  return (await count(mode)) - before;
}

/** Every file gbrain could have written for this run: stdout, stderr, the push log and anything under the git dir it owns. */
function everythingWritten(work: string, run: { stdout: string; stderr: string }): string {
  const files = [join(home, '.gbrain', 'brain-push.log'), ...readdirSync(join(work, '.git')).filter(f => f.startsWith('brain-')).map(f => join(work, '.git', f))];
  return [run.stdout, run.stderr, ...files.filter(f => existsSync(f) && statSync(f).isFile()).map(f => readFileSync(f, 'utf8'))].join('\n');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gst2961-'));
  home = join(dir, 'home');
  mkdirSync(home);
  mkdirSync(join(dir, 'srv'));
  globalConfig = join(dir, 'global.gitconfig');
  writeHelper('helper-global.sh', 'user-b', CANARY, 'GLOBAL_HELPER_SILENT');
  writeHelper('helper-local.sh', 'user-a', LOCAL_SECRET);
  writeFileSync(globalConfig, '[credential]\n\thelper = ' + join(dir, 'helper-global.sh') + '\n');
  server = spawn(process.execPath, [resolve(import.meta.dir, 'fixtures/git-credential-stub/server.ts'), join(dir, 'srv')], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise<number>((done, fail) => {
    server.stdout!.once('data', chunk => done(Number(String(chunk).trim())));
    server.once('exit', code => fail(new Error('stub server exited ' + code)));
  });
});

afterAll(() => {
  server?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('credentialRefusal', () => {
  test('404 and 403 texts are credential refusals; transient and other push failures are not', () => {
    expect(credentialRefusal("remote: Repository not found.\nfatal: repository 'https://git.example/acme-example/brain.git/' not found\n")).toBe('not_found');
    expect(credentialRefusal('ERROR: Repository not found.\nfatal: Could not read from remote repository.\n')).toBe('not_found');
    expect(credentialRefusal("fatal: unable to access 'https://git.example/x.git/': The requested URL returned error: 404\n")).toBe('not_found');
    expect(credentialRefusal("remote: Permission to acme-example/brain.git denied to user-b.\nfatal: unable to access 'https://git.example/x.git/': The requested URL returned error: 403\n")).toBe('forbidden');
    expect(credentialRefusal('ERROR: Permission to acme-example/brain.git denied to user-b.\n')).toBe('forbidden');
    for (const transient of [
      "fatal: unable to access 'https://git.example/x.git/': The requested URL returned error: 502\n",
      "fatal: unable to access 'https://git.example/x.git/': Could not resolve host: git.example\n",
      'error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: the remote end hung up unexpectedly\n',
      " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'https://git.example/x.git'\n",
      " ! [remote rejected] main -> main (protected branch hook declined)\n",
    ]) expect(credentialRefusal(transient)).toBeNull();
  });
});

describe('gbrain git commit-push against a host that refuses the credential', () => {
  for (const [mode, kind, words] of [['notfound', 'not_found', 'Repository not found'], ['forbidden', 'forbidden', 'HTTP 403']] as const) {
    test(mode + ': exit 1, push_credential_refused, one attempt, names the helper and login, never the secret', async () => {
      const work = checkout('brain-' + mode, mode);
      const plain = await onePlainPush(work, mode);
      const before = await count(mode);
      const run = commitPush(work);
      expect(run.status).toBe(1);
      expect(run.doc.code).toBe('push_credential_refused');
      expect(run.doc.retryable).toBe(false);
      expect(run.doc.reason).toBe(kind);
      expect(String(run.doc.message)).toContain(words);
      expect(String(run.doc.message)).toContain(join(dir, 'helper-global.sh'));
      expect(String(run.doc.message)).toContain('(global, file:' + globalConfig + ')');
      expect(String(run.doc.message)).toContain('user-b');
      expect((run.doc.fix as { next?: string }).next).toBe('tell_user_to_run');
      expect((await count(mode)) - before).toBe(plain);
      const written = everythingWritten(work, run);
      expect(written).not.toContain(CANARY);
      expect(written).not.toContain(LOCAL_SECRET);
      const state = readCredentialRefusal(work);
      expect(state?.kind).toBe(kind);
      expect(state?.username).toBe('user-b');
      expect(state?.helpers).toEqual([{ helper: join(dir, 'helper-global.sh'), scope: 'global', origin: 'file:' + globalConfig, answered: true }]);
      expect(readFileSync(join(home, '.gbrain', 'brain-push.log'), 'utf8')).toContain('push_credential_refused');
      expect(getLastPushOutcome('main', work)).toMatchObject({ status: 'needs_attention' });
      expect(getLastPushOutcome('main', work).detail).toContain('push_credential_refused');
    }, 120_000);
  }

  test('lists every helper git asked, in order, when the first one stays silent', () => {
    const work = checkout('brain-order', 'forbidden');
    const run = commitPush(work, { GLOBAL_HELPER_SILENT: '1' });
    expect(run.doc.code).toBe('push_credential_refused');
    expect(readCredentialRefusal(work)?.helpers).toEqual([
      { helper: join(dir, 'helper-global.sh'), scope: 'global', origin: 'file:' + globalConfig, answered: false },
      { helper: join(dir, 'helper-local.sh'), scope: 'local', origin: 'file:.git/config', answered: true },
    ]);
    expect(String(run.doc.message)).toContain('user-a');
    expect(everythingWritten(work, run)).not.toContain(LOCAL_SECRET);
  }, 120_000);

  test('an inline helper whose body holds the token is shown by its program only', () => {
    const work = checkout('brain-inline', 'forbidden');
    const inlineConfig = join(dir, 'inline.gitconfig');
    writeFileSync(inlineConfig, '[credential]\n\thelper = "!f() { cat >/dev/null; echo username=user-c; echo password=' + INLINE_SECRET + '; }; f"\n');
    const run = commitPush(work, { GIT_CONFIG_GLOBAL: inlineConfig });
    expect(run.doc.code).toBe('push_credential_refused');
    expect(readCredentialRefusal(work)?.helpers[0]).toMatchObject({ helper: 'an inline shell helper', scope: 'global', answered: true });
    expect(everythingWritten(work, run)).not.toContain(INLINE_SECRET);
    const argv = (run.doc.fix as { argv: string[] }).argv;
    expect(argv).toEqual(credentialHelperKeysArgv(work));
    const listed = execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', env: env({ GIT_CONFIG_GLOBAL: inlineConfig }) });
    expect(listed).toContain('credential.helper');
    expect(listed).toContain(inlineConfig);
    expect(listed).not.toContain(INLINE_SECRET);
  }, 120_000);

  test('a dropped connection is still push_unconfirmed (exit 4) and keeps its retry', async () => {
    const work = checkout('brain-drop', 'drop');
    const plain = await onePlainPush(work, 'drop');
    const before = await count('drop');
    const run = commitPush(work);
    expect(run.status).toBe(4);
    expect(run.doc.code).toBe('push_unconfirmed');
    expect(run.doc.retryable).toBe(true);
    expect((await count('drop')) - before).toBe(2 * plain);
    expect(readCredentialRefusal(work)).toBeNull();
  }, 120_000);

  test('a token in the remote URL or given as the username never reaches the error, the push log or the state file', async () => {
    const URL_TOKEN = 'CANARY-gst2961-url-token-not-real';
    const USER_TOKEN = 'gho_CANARYgst2961helperusernotreal';
    const passwordOnly = join(dir, 'helper-password-only.sh');
    writeFileSync(passwordOnly, '#!/bin/sh\n[ "$1" = get ] || exit 0\ncat >/dev/null\necho password=' + LOCAL_SECRET + '\n');
    chmodSync(passwordOnly, 0o755);
    const urlToken = checkout('brain-urltoken', 'forbidden');
    git(urlToken, ['config', 'credential.helper', passwordOnly]);
    git(urlToken, ['remote', 'set-url', 'origin', 'http://' + URL_TOKEN + '@127.0.0.1:' + port + '/forbidden/brain-urltoken.git']);
    const viaUrl = commitPush(urlToken, { GLOBAL_HELPER_SILENT: '1' });
    expect(viaUrl.doc.code).toBe('push_credential_refused');
    expect(everythingWritten(urlToken, viaUrl)).not.toContain(URL_TOKEN);

    const userToken = checkout('brain-usertoken', 'forbidden');
    git(userToken, ['config', 'credential.helper', writeHelper('helper-token-user.sh', USER_TOKEN, LOCAL_SECRET)]);
    const viaHelper = commitPush(userToken, { GLOBAL_HELPER_SILENT: '1' });
    expect(viaHelper.doc.code).toBe('push_credential_refused');
    expect(everythingWritten(userToken, viaHelper)).not.toContain(USER_TOKEN);
    expect(everythingWritten(userToken, viaHelper)).not.toContain(LOCAL_SECRET);
  }, 180_000);

  test('a push that lands outside commit-push ends the refusal for put_page and doctor', async () => {
    const work = checkout('brain-outside', 'notfound');
    commitPush(work);
    expect(readCredentialRefusal(work)).not.toBeNull();
    setMode(work, 'ok');
    git(work, ['push', '-q', 'origin', 'main']);
    expect(readCredentialRefusal(work)).toBeNull();
    expect((await withEnv({ GBRAIN_HOME: home }, async () => getLastPushOutcome('main', work))).detail ?? '').not.toContain('push_credential_refused since');
  }, 120_000);

  test('a refusal stays while another push URL of the remote still refuses, and put_page reports it for a local branch named apart from its upstream', async () => {
    const work = checkout('brain-twourls', 'notfound');
    commitPush(work);
    git(work, ['remote', 'set-url', '--push', 'origin', 'http://127.0.0.1:' + port + '/ok/brain-twourls.git']);
    git(work, ['remote', 'set-url', '--add', '--push', 'origin', 'http://127.0.0.1:' + port + '/notfound/brain-twourls.git']);
    spawnSync('git', ['-C', work, 'push', 'origin', 'main'], { env: env(), stdio: 'ignore' });
    expect(git(work, ['rev-parse', 'refs/remotes/origin/main'])).toBe(git(work, ['rev-parse', 'HEAD']));
    expect(readCredentialRefusal(work)?.kind).toBe('not_found');

    const split = checkout('brain-split', 'notfound');
    commitPush(split);
    git(split, ['remote', 'set-url', '--push', 'origin', 'http://127.0.0.1:' + port + '/notfound/brain-split.git']);
    git(split, ['remote', 'set-url', 'origin', 'http://127.0.0.1:' + port + '/ok/brain-split.git']);
    git(split, ['push', '-q', join(dir, 'srv', 'brain-split.git'), 'main']);
    git(split, ['fetch', '-q', 'origin']);
    expect(git(split, ['rev-parse', 'refs/remotes/origin/main'])).toBe(git(split, ['rev-parse', 'HEAD']));
    expect(readCredentialRefusal(split)?.kind).toBe('not_found');

    const renamed = checkout('brain-renamed', 'notfound');
    git(renamed, ['branch', '-m', 'main', 'local-work']);
    git(renamed, ['branch', '--set-upstream-to', 'origin/main', 'local-work']);
    commitPush(renamed);
    expect(readCredentialRefusal(renamed)?.branch).toBe('main');
    const outcome = await withEnv({ GBRAIN_HOME: home }, async () => getLastPushOutcome('local-work', renamed));
    expect(outcome.status).toBe('needs_attention');
    expect(outcome.detail).toContain('push_credential_refused since');
  }, 180_000);

  test('a helper is shown by its command only when it has a command shape, never a token, an inline body or an assignment', async () => {
    const SHAPE = 'CANARY-gst2961-shape-not-a-real-token';
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ "$3" = get ] || exit 0\ncat >/dev/null\necho username=user-c\necho password=' + LOCAL_SECRET + '\n');
    chmodSync(join(bin, 'gh'), 0o755);
    const answer = join(dir, 'helper-local.sh');
    const cases = [
      { name: 'brain-shape-env', config: '[credential]\n\thelper = "!GH_TOKEN=' + SHAPE + ' gh auth git-credential"\n', shown: ['!gh …'] },
      { name: 'brain-shape-body', config: '[credential]\n\thelper = "!f() { cat >/dev/null; echo username=user-c; echo password=' + SHAPE + '; }; f"\n', shown: ['an inline shell helper'] },
      { name: 'brain-shape-quote', config: '[credential]\n\thelper = "!\'Q' + SHAPE + '\' x"\n\thelper = TOKEN=' + SHAPE + '\n\thelper = ' + answer + '\n', shown: ['an inline shell helper', 'a credential helper', answer] },
    ];
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      for (const c of cases) {
        const work = checkout(c.name, 'forbidden');
        git(work, ['config', '--unset', 'credential.helper']);
        const config = join(dir, c.name + '.gitconfig');
        writeFileSync(config, c.config);
        const run = commitPush(work, { GIT_CONFIG_GLOBAL: config, PATH: bin + ':' + String(process.env.PATH) });
        expect(run.doc.code).toBe('push_credential_refused');
        const shown = readCredentialRefusal(work)?.helpers.map(h => h.helper) ?? [];
        expect([shown[0], shown.at(-1)]).toEqual([c.shown[0], c.shown.at(-1)]);
        for (const h of shown) expect(c.shown).toContain(h);
        await engine.executeRaw('DELETE FROM sources');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['brain', work]);
        const check = await withEnv({ GIT_CONFIG_GLOBAL: config }, async () => gitConvergenceCheck(engine));
        expect(check?.message).toContain('push_credential_refused');
        const seen = [everythingWritten(work, run), check?.message ?? '', JSON.stringify(check?.fix ?? {})].join('\n');
        expect(seen).not.toContain(SHAPE);
        expect(seen).not.toContain('echo ');
      }
    } finally {
      await engine.disconnect();
    }
  }, 240_000);

  test('a narrowing gbrain access rule add on a checkout whose push the host refuses still applies the rule and reports committed_not_pushed', async () => {
    const work = checkout('brain-access', 'forbidden');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{}')", ['src-a', work]);
      await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', ['alice-example']);
      const lines: string[] = [];
      const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
      try {
        await withEnv({ GBRAIN_HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }, async () =>
          runAccessRules(engine, 'rule', ['add', '--source', 'src-a', '--prefix', 'partners/alice-example/', '--readers', 'alice-example', '--id', 'alice', '--yes', '--json'], true));
      } finally { spy.mockRestore(); }
      const r = JSON.parse(lines.join('\n'));
      expect({ store: r.store, state: r.state, outcome: r.git.outcome }).toEqual({ store: 'git', state: 'applied', outcome: 'committed_not_pushed' });
      expect(r.git.commit).toBe(git(work, ['rev-parse', 'HEAD']));
      expect(r.git.note).toContain('push_credential_refused');
      expect((await policyStatus(engine, 'src-a')).rules.map(x => x.id)).toEqual(['alice']);
    } finally {
      await engine.disconnect();
    }
  }, 180_000);

  test('doctor git_convergence warns at once, and a push that lands clears the record', async () => {
    const work = checkout('brain-clear', 'notfound');
    commitPush(work);
    commitPush(work);
    expect(readCredentialRefusal(work)?.attempts).toBe(2);
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['brain', work]);
      const check = await gitConvergenceCheck(engine);
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('push_credential_refused');
      expect(check?.message).toContain('user-b');
      expect(check?.message).not.toContain(CANARY);
      expect(check?.fix?.actor).toBe('user');
      expect(check?.fix?.argv).toContain('--name-only');

      setMode(work, 'ok');
      const landed = commitPush(work);
      expect(landed.status).toBe(0);
      expect(readCredentialRefusal(work)).toBeNull();
      expect((await withEnv({ GBRAIN_HOME: home }, async () => getLastPushOutcome('main', work))).status).toBe('ok');
      expect((await gitConvergenceCheck(engine))?.status).toBe('ok');
    } finally {
      await engine.disconnect();
    }
  }, 180_000);
});
