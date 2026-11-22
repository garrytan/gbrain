/**
 * GST-3497: a checkout that fell behind its remote while another clone pushed unrelated paths publishes by merging the
 * remote commits in memory, the way the multi-agent rules promise, and its publish lock is never held longer for it.
 *
 * Protects: `gbrain git commit-push --push-only` (keep-checkout or not) and `-m <msg> -- <paths>` from a behind clone
 * integrate the other clone's commits and push; an overlapping file refuses `integrate_conflict`; a publish reads each
 * unpushed commit once even when it fetches and merges a moved remote (before, every attempt rescanned them with a fresh
 * budget, so a publish from a behind checkout took about three scans and held the push lock that long); a busy push
 * lock names the process holding it (`reason: publish_lock_busy`); a push the remote refuses is never reported as lock
 * contention.
 * Regression it catches: the triple scan that kept a production-size publish past its child's 600 s bound, and a
 * busy-lock refusal that cannot say who holds the lock.
 * Seams: a `git` shim on the child CLI's PATH that logs what each secret scan reads and holds a push while a sentinel file exists; otherwise a
 * real bare remote, two real clones and the real CLI.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
let root: string;
let shimDir: string;
let scanLog: string;

const git = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GBRAIN_HOME: join(root, 'home'), GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1',
    SHIM_LOG: scanLog, GBRAIN_SECRETS_ON_PUSH: 'refuse', ...extra };
}

function cli(cwd: string, args: string[], extra: Record<string, string> = {}): { code: number; doc: Record<string, unknown> } {
  const out = spawnSync(process.execPath, [CLI, 'git', 'commit-push', '--path', cwd, '--json', ...args], { cwd, env: env(extra), encoding: 'utf8', timeout: 120_000 });
  return { code: out.status ?? -1, doc: JSON.parse(out.stdout.trim() || '{}') as Record<string, unknown> };
}

/** remote-a plus two clones: clone-a (another agent's checkout) and clone-b (the brain checkout). */
function setup(): { bare: string; a: string; b: string } {
  const bare = join(root, 'remote-a.git');
  execFileSync(REAL_GIT, ['init', '-q', '--bare', '-b', 'main', bare]);
  const clone = (name: string) => {
    const dir = join(root, name);
    execFileSync(REAL_GIT, ['clone', '-q', bare, dir], { stdio: 'ignore' });
    git(dir, 'config', 'user.name', name); git(dir, 'config', 'user.email', `${name}@example.invalid`);
    return dir;
  };
  const a = clone('clone-a');
  mkdirSync(join(a, 'notes')); mkdirSync(join(a, 'people'));
  writeFileSync(join(a, 'notes', 'shared.md'), 'v1\n'); writeFileSync(join(a, 'people', 'base.md'), 'base\n');
  git(a, 'add', '.'); git(a, 'commit', '-qm', 'seed'); git(a, 'push', '-q', 'origin', 'main');
  return { bare, a, b: clone('clone-b') };
}

/** clone-a pushes n commits under people/, clone-b makes n local commits under notes/: n ahead and n behind. */
function diverge(a: string, b: string, n = 4): string[] {
  for (let i = 0; i < n; i++) { writeFileSync(join(a, 'people', `a${i}.md`), `a${i}\n`); git(a, 'add', 'people'); git(a, 'commit', '-qm', `agent ${i}`); }
  git(a, 'push', '-q', 'origin', 'main');
  const local: string[] = [];
  for (let i = 0; i < n; i++) { writeFileSync(join(b, 'notes', `b${i}.md`), `b${i}\n`); git(b, 'add', 'notes'); git(b, 'commit', '-qm', `brain ${i}`); local.push(git(b, 'rev-parse', 'HEAD')); }
  git(b, 'fetch', '-q', 'origin');
  expect(git(b, 'rev-list', '--left-right', '--count', 'HEAD...origin/main')).toBe(`${n}\t${n}`);
  return local;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gst3497-'));
  shimDir = join(root, 'bin'); scanLog = join(root, 'scan.log');
  mkdirSync(shimDir); mkdirSync(join(root, 'home'));
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh
PATH=$(printf '%s' "$PATH" | sed 's#${shimDir}:##g'); export PATH
case " $* " in *" diff-tree --stdin "*) tee -a "$SHIM_LOG" | '${REAL_GIT}' "$@"; exit $? ;; esac
case " $* " in *" push "*) while [ -n "$SHIM_PUSH_HOLD" ] && [ -e "$SHIM_PUSH_HOLD" ]; do sleep 0.1; done ;; esac
exec '${REAL_GIT}' "$@"
`);
  chmodSync(join(shimDir, 'git'), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const scansOf = (sha: string) => (existsSync(scanLog) ? readFileSync(scanLog, 'utf8') : '').split('\n').filter(line => line === sha).length;

test('push-only from a behind checkout merges the remote commits in memory, pushes, and scans each local commit once', () => {
  const { bare, a, b } = setup();
  const local = diverge(a, b);
  const head = git(b, 'rev-parse', 'HEAD');
  const { code, doc } = cli(b, ['--push-only', '--keep-checkout', '--scan-secrets']);
  expect(code).toBe(0);
  expect(doc).toMatchObject({ outcome: 'pushed', integrated: 4, confirmed: 'push', checkout: 'unchanged' });
  const tip = git(bare, 'rev-parse', 'refs/heads/main');
  expect(doc.sha).toBe(tip);
  git(b, 'merge-base', '--is-ancestor', head, tip);
  git(b, 'merge-base', '--is-ancestor', git(a, 'rev-parse', 'HEAD'), tip);
  expect(git(b, 'rev-parse', 'HEAD')).toBe(head);
  for (const sha of local) expect(scansOf(sha)).toBe(1);
}, 120_000);

test('commit-push with paths from a behind checkout commits, merges, pushes and advances the checkout', () => {
  const { bare, a, b } = setup();
  diverge(a, b);
  writeFileSync(join(b, 'notes', 'new.md'), 'new\n');
  const { code, doc } = cli(b, ['-m', 'add a note', '--', 'notes/new.md']);
  expect(code).toBe(0);
  expect(doc).toMatchObject({ outcome: 'pushed', integrated: 4, checkout: 'advanced' });
  expect(git(b, 'rev-parse', 'HEAD')).toBe(git(bare, 'rev-parse', 'refs/heads/main'));
  expect(readFileSync(join(b, 'people', 'a3.md'), 'utf8')).toBe('a3\n');
}, 120_000);

test('an overlapping file refuses integrate_conflict and pushes nothing', () => {
  const { bare, a, b } = setup();
  writeFileSync(join(a, 'notes', 'shared.md'), 'from a\n'); git(a, 'commit', '-qam', 'a edits shared'); git(a, 'push', '-q', 'origin', 'main');
  writeFileSync(join(b, 'notes', 'shared.md'), 'from b\n'); git(b, 'commit', '-qam', 'b edits shared');
  const remote = git(bare, 'rev-parse', 'refs/heads/main');
  const { code, doc } = cli(b, ['--push-only', '--keep-checkout', '--scan-secrets']);
  expect(code).not.toBe(0);
  expect(doc.code).toBe('integrate_conflict');
  expect(JSON.parse(String(doc.detail)).paths).toEqual(['notes/shared.md']);
  expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(remote);
}, 120_000);

test('a busy push lock names the publish holding it, and that publish pushes the waiting HEAD too', async () => {
  const { bare, a, b } = setup();
  diverge(a, b);
  const hold = join(root, 'hold-push');
  writeFileSync(hold, '');
  const holder = spawn(process.execPath, [CLI, 'git', 'commit-push', '--push-only', '--keep-checkout', '--scan-secrets', '--path', b, '--json'],
    { cwd: b, env: env({ SHIM_PUSH_HOLD: hold }), stdio: 'ignore' });
  const exited = new Promise<number | null>(resolve => holder.on('exit', resolve));
  const record = join(git(b, 'rev-parse', '--absolute-git-dir'), 'brain-publish.holder');
  for (let i = 0; i < 100 && !existsSync(record); i++) await new Promise(r => setTimeout(r, 100));
  const { code, doc } = cli(b, ['--push-only', '--keep-checkout', '--scan-secrets'], { GBRAIN_PUBLISH_LOCK_WAIT_SECONDS: '0' });
  expect(code).not.toBe(0);
  expect(doc).toMatchObject({ code: 'push_unconfirmed', reason: 'publish_lock_busy' });
  expect(String(doc.message)).toContain(`pid ${holder.pid}`);
  expect(String(doc.message)).toContain('gbrain git commit-push --push-only --keep-checkout');
  rmSync(hold);
  expect(await exited).toBe(0);
  git(b, 'merge-base', '--is-ancestor', 'HEAD', git(bare, 'rev-parse', 'refs/heads/main'));
  expect(existsSync(record)).toBe(false);
}, 120_000);

test('a push the remote refuses is reported as the refusal, never as lock contention', () => {
  const { bare, a, b } = setup();
  diverge(a, b, 1);
  writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "refused by remote-a policy" >&2\nexit 1\n');
  chmodSync(join(bare, 'hooks', 'pre-receive'), 0o755);
  const { code, doc } = cli(b, ['--push-only', '--keep-checkout', '--scan-secrets']);
  expect(code).not.toBe(0);
  expect(doc.code).toBe('push_unconfirmed');
  expect(doc.reason).toBeUndefined();
  expect(String(doc.message)).not.toContain('push lock');
  expect(String(doc.suggestion)).toContain('refused by remote-a policy');
}, 120_000);
