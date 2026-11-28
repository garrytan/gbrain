/**
 * GST-3507: company-brainify's team export and history purge.
 *
 * The skill is Markdown an agent follows literally, so its code blocks are the code. Protects: the staging copy holds only
 * the export list (scope-list files, each given the per-file read), never whole folders; Phase 4 greps look for personal
 * data; Step 1 records every remote ref and the purge pushes every branch and tag in one atomic push, each with a lease
 * on its recorded sha, so a teammate's push during the confirmation card makes the purge refuse instead of being
 * overwritten and no branch or tag is left on the old history. The staging and push blocks run as written against real
 * git repositories in a temp dir.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SKILL = 'skills/company-brainify/SKILL.md';
const PURGE = 'skills/company-brainify/HISTORY-PURGE.md';
const skillText = readFileSync(join(ROOT, SKILL), 'utf8');
const purgeText = existsSync(join(ROOT, PURGE)) ? readFileSync(join(ROOT, PURGE), 'utf8') : '';
const text = `${skillText}\n${purgeText}`;
const PURGE_DIRS = 'people meetings daily companies projects analysis';

/** Every fenced code block in the skill, with the fence's indentation removed. */
function fences(): string[] {
  const blocks: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^( *)```/);
    if (!open) continue;
    const indent = open[1].length;
    const body: string[] = [];
    for (i++; i < lines.length && !/^ *```\s*$/.test(lines[i]); i++) body.push(lines[i].slice(indent));
    blocks.push(body.join('\n'));
  }
  return blocks;
}

function fenceContaining(needle: string): string {
  const found = fences().filter(b => b.includes(needle));
  expect(found).toHaveLength(1);
  return found[0];
}

const scratch: string[] = [];
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'gbrain-brainify-')); scratch.push(d); return d; }
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
function bash(script: string, cwd: string, env: Record<string, string>) {
  return spawnSync('bash', ['-c', script], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
}
function user(repo: string): void {
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
}

describe('company-brainify export: only files that got the read ship', () => {
  test('the staging copy holds the export list and nothing else from the scanned folders', () => {
    const block = fenceContaining('brainify-staging-');
    expect(block).not.toContain('rsync -a "$d/"');
    const dir = tmp();
    const brain = join(dir, 'brain');
    write(brain, 'people/alice-example.md', 'Staff engineer.\n');
    write(brain, 'people/family-member-example.md', 'Private.\n');
    write(brain, 'daily/2026-01-02.md', 'Private day.\n');
    write(brain, 'meetings/staff-sync.md', 'Payments review.\n');
    write(brain, 'conversations/chat.md', 'Never ships.\n');
    const scope = join(dir, 'scope.txt');
    writeFileSync(scope, 'people/alice-example.md\nmeetings/staff-sync.md\nconversations/chat.md\n');
    const script = block.replaceAll('/tmp/brainify-scope.txt', scope) + '\necho "STAGING=$STAGING"';
    expect(script).not.toBe(block);
    const run = bash(script, brain, { HOME: join(dir, 'home') });
    expect(run.status).toBe(0);
    const staging = run.stdout.match(/STAGING=(.*)/)![1];
    const shipped = execFileSync('find', ['.', '-type', 'f'], { cwd: staging, encoding: 'utf8' }).trim().split('\n').sort();
    expect(shipped).toEqual(['./meetings/staff-sync.md', './people/alice-example.md']);
    expect(readFileSync(`${staging}.export-list`, 'utf8')).toBe('meetings/staff-sync.md\npeople/alice-example.md\n');
  });

  test('the export commit refuses files off the export list, and the skill no longer claims a folder copy was read', () => {
    const step0 = fenceContaining('Initial import');
    expect(step0).toContain('comm -23 - "$STAGING.export-list"');
    expect(step0).not.toMatch(/git add -A &&/);
    expect(text).not.toContain("holds nothing the pass didn't read");
  });

  test('re-auditing an existing shared brain carries the sanitized tree into the purge clone and lists every page in it', () => {
    const block = fenceContaining('brainify-reaudit-');
    const dir = tmp();
    const checkout = join(dir, 'checkout');
    write(checkout, 'people/alice-example.md', 'Staff engineer.\n');
    write(checkout, 'people/bob-example.md', 'Never flagged by a scan.\n');
    write(checkout, 'meetings/staff-sync.md', 'Payments review.\n');
    write(checkout, 'conversations/chat.md', 'Outside the purged folders.\n');
    git(dir, 'init', '-q', checkout); user(checkout);
    git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'shared');
    const run = bash(block + '\necho "STAGING=$STAGING"', checkout, { HOME: join(dir, 'home') });
    expect(run.status).toBe(0);
    const staging = run.stdout.match(/STAGING=(.*)/)![1];
    expect(readFileSync(`${staging}.export-list`, 'utf8')).toBe('meetings/staff-sync.md\npeople/alice-example.md\npeople/bob-example.md\n');
    expect(readFileSync(`${staging}.base`, 'utf8').trim()).toBe(git(checkout, 'rev-parse', 'HEAD'));
    const clone = join(dir, 'clone');
    write(clone, 'people/alice-example.md', 'Staff engineer. Salary 200k.\n');
    write(clone, 'people/bob-example.md', 'Never flagged by a scan.\n');
    write(clone, 'meetings/staff-sync.md', 'Payments review.\n');
    const step1 = fenceContaining('Sanitize: strip sensitive content before history purge');
    const guard = step1.slice(step1.indexOf(`for d in ${PURGE_DIRS}; do\n  [ -d "$STAGING/$d" ]`), step1.indexOf('SANITIZED=""'));
    const purge = bash(guard, clone, { STAGING: staging });
    expect(purge.status).toBe(0);
    expect(purge.stdout).not.toContain('ABORT');
    expect(readFileSync(join(clone, 'people/alice-example.md'), 'utf8')).toBe('Staff engineer.\n');
  });

  test('the purge stops when the shared repo keeps a page that is not on the export list', () => {
    const step1 = fenceContaining('Sanitize: strip sensitive content before history purge');
    const start = step1.indexOf(`for d in ${PURGE_DIRS}; do\n  [ -d "$STAGING/$d" ]`);
    const end = step1.indexOf('SANITIZED=""');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const guard = step1.slice(start, end);
    const dir = tmp();
    const staging = join(dir, 'staging');
    write(staging, 'people/alice-example.md', 'Staff engineer.\n');
    writeFileSync(`${staging}.export-list`, 'people/alice-example.md\n');
    const shared = join(dir, 'shared');
    write(shared, 'people/alice-example.md', 'Old copy.\n');
    write(shared, 'people/family-member-example.md', 'Private, from an earlier folder export.\n');
    const stale = bash(guard, shared, { STAGING: staging });
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain('people/family-member-example.md');
    expect(stale.stdout).not.toContain('people/alice-example.md');
    rmSync(join(shared, 'people/family-member-example.md'));
    const clean = bash(guard, shared, { STAGING: staging });
    expect(clean.status).toBe(0);
    const noList = bash(guard, shared, { STAGING: join(dir, 'no-such-staging') });
    expect(noList.status).toBe(1);
    expect(noList.stdout).toContain('no export list');
    expect(readFileSync(join(shared, 'people/alice-example.md'), 'utf8')).toBe('Staff engineer.\n');
  });

  /**
   * GST-4108: a shared repo, a checkout sanitized in place and staged with the re-audit block, then a teammate push.
   * The purge clones the remote fresh and must never copy the staged tree over a page the teammate changed after staging.
   */
  const RAW = 'Staff engineer.\nSalary 200k.\n' + 'Filler.\n'.repeat(6) + 'Notes: none.\n';
  const CLEAN = RAW.replace('Salary 200k.\n', '');
  function reaudit(teammate: (seed: string) => void) {
    const dir = tmp();
    const remote = join(dir, 'remote.git');
    git(dir, 'init', '--bare', '-q', '-b', 'main', remote);
    const seed = join(dir, 'seed');
    git(dir, 'init', '-q', '-b', 'main', seed); user(seed);
    write(seed, 'people/alice-example.md', RAW);
    write(seed, 'people/bob-example.md', 'Staff engineer.\n');
    write(seed, 'meetings/staff-sync.md', 'Payments review.\n');
    write(seed, 'README.md', 'Team brain.\n');
    git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'shared');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-q', 'origin', 'main');
    const checkout = join(dir, 'checkout');
    git(dir, 'clone', '-q', remote, checkout); user(checkout);
    write(checkout, 'people/alice-example.md', CLEAN);
    const staged = bash(fenceContaining('brainify-reaudit-') + '\necho "STAGING=$STAGING"', checkout, { HOME: join(dir, 'home') });
    expect(staged.status).toBe(0);
    const staging = staged.stdout.match(/STAGING=(.*)/)![1];
    teammate(seed);
    git(seed, 'push', '-q', 'origin', 'main');
    const clone = (name: string) => { const c = join(dir, name); git(dir, 'clone', '-q', remote, c); user(c); return c; };
    return { dir, remote, seed, checkout, stageDir: staging, shared: clone('shared'), clone };
  }
  function step1(from: string, to: string): string {
    const block = fenceContaining('Sanitize: strip sensitive content before history purge');
    const start = block.indexOf(from);
    const end = block.indexOf(to);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return block.slice(start, end);
  }
  const overlay = () => step1('BASE=$(cat "$STAGING.base"', 'SANITIZED=""');
  const teammateEdit = (seed: string, path: string, body: string) => {
    write(seed, path, body); git(seed, 'add', path); git(seed, 'commit', '-q', '-m', 'teammate'); git(seed, 'push', '-q', 'origin', 'main');
  };

  test('the purge copies the staged tree when the shared repo moved only outside the sanitized folders', () => {
    const r = reaudit(seed => { write(seed, 'README.md', 'Team brain, v2.\n'); git(seed, 'commit', '-q', '-am', 'readme'); });
    const run = bash(overlay(), r.shared, { STAGING: r.stageDir });
    expect(run.stdout).not.toContain('ABORT');
    expect(run.status).toBe(0);
    expect(readFileSync(join(r.shared, 'people/alice-example.md'), 'utf8')).toBe(CLEAN);
  });

  test("a teammate's page changed, added or deleted after staging is never overwritten: the purge lists it and stops", () => {
    for (const [change, page] of [
      [(seed: string) => { write(seed, 'people/bob-example.md', 'Now leads payments.\n'); git(seed, 'commit', '-q', '-am', 'bob'); }, 'people/bob-example.md'],
      [(seed: string) => { write(seed, 'people/new-hire-example.md', 'Joined.\n'); git(seed, 'add', 'people'); git(seed, 'commit', '-q', '-m', 'hire'); }, 'people/new-hire-example.md'],
      [(seed: string) => { git(seed, 'rm', '-q', 'meetings/staff-sync.md'); git(seed, 'commit', '-q', '-m', 'drop'); }, 'meetings/staff-sync.md'],
    ] as const) {
      const r = reaudit(change);
      const before = git(r.shared, 'status', '--porcelain');
      const run = bash(overlay(), r.shared, { STAGING: r.stageDir });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('changed on the shared repo after staging');
      expect(run.stdout).toContain(page);
      expect(run.stdout).not.toContain('people/alice-example.md');
      expect(git(r.shared, 'status', '--porcelain')).toBe(before);
      expect(readFileSync(join(r.shared, 'people/alice-example.md'), 'utf8')).toBe(RAW);
    }
  });

  test('the purge stops when the staging base is missing or not on the shared repo', () => {
    const r = reaudit(() => {});
    writeFileSync(`${r.stageDir}.base`, git(r.checkout, 'commit-tree', '-m', 'local only', git(r.checkout, 'write-tree')) + '\n');
    const unpushed = bash(overlay(), r.shared, { STAGING: r.stageDir });
    expect(unpushed.status).toBe(1);
    expect(unpushed.stdout).toContain('is not a commit on the shared repo');
    rmSync(`${r.stageDir}.base`);
    const missing = bash(overlay(), r.shared, { STAGING: r.stageDir });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('staging base missing');
    expect(readFileSync(join(r.shared, 'people/alice-example.md'), 'utf8')).toBe(RAW);
  });

  /** Step 1 from the base check to the remote pin, with commit-push stubbed as commit, merge the remote, push. TEAMMATE runs first. */
  const sanitizePush = () =>
    'gbrain() { shift 5; bash -c "$TEAMMATE"; git add -- "$@"; git commit -q -m sanitize; git pull -q --no-rebase --no-edit origin main && git push -q origin HEAD:main; }\n'
    + step1('BASE=$(cat "$STAGING.base"', '# Pin the remote NOW');

  test('a teammate push to the sanitized folders that the sanitize push merged in stops the purge, even into a page we sanitized', () => {
    for (const [path, body, stops] of [
      ['people/bob-example.md', 'Changed during the sanitize push.\n', true],
      ['people/alice-example.md', RAW.replace('Notes: none.', 'Notes: on a performance plan.'), true],
      ['README.md', 'Changed during the sanitize push.\n', false],
    ] as const) {
      const r = reaudit(() => {});
      const base = readFileSync(`${r.stageDir}.base`, 'utf8').trim();
      const teammate = `cd '${r.seed}' && printf '%s' '${body}' > '${path}' && git commit -q -am teammate && git push -q origin main`;
      const run = bash(sanitizePush(), r.shared, { WORK: r.dir, STAGING: r.stageDir, TEAMMATE: teammate });
      expect(run.stdout.includes('a teammate pushed to the sanitized folders')).toBe(stops);
      expect(run.status).toBe(stops ? 1 : 0);
      const after = readFileSync(`${r.stageDir}.base`, 'utf8').trim();
      expect(after).toBe(stops ? base : git(r.shared, 'rev-parse', 'HEAD'));
    }
  });

  test('an ignored file the staging copy carried does not stop the sanitize push', () => {
    const r = reaudit(seed => { write(seed, '.gitignore', '*.swp\n'); git(seed, 'add', '.gitignore'); git(seed, 'commit', '-q', '-m', 'ignore'); });
    write(r.stageDir, 'people/.alice-example.md.swp', 'editor swap file\n');
    const list = readFileSync(`${r.stageDir}.export-list`, 'utf8').trim().split('\n').concat('people/.alice-example.md.swp').sort();
    writeFileSync(`${r.stageDir}.export-list`, list.join('\n') + '\n');
    const run = bash(sanitizePush(), r.shared, { WORK: r.dir, STAGING: r.stageDir, TEAMMATE: 'true' });
    expect(run.stdout).not.toContain('ABORT');
    expect(run.status).toBe(0);
    expect(git(r.dir, '--git-dir', r.remote, 'show', 'main:people/alice-example.md') + '\n').toBe(CLEAN);
  });

  test('a restart of Step 1 after the sanitize push only stops on pushes made after it', () => {
    const r = reaudit(() => {});
    const first = bash(sanitizePush(), r.shared, { WORK: r.dir, STAGING: r.stageDir, TEAMMATE: 'true' });
    expect(first.status).toBe(0);
    expect(git(r.dir, '--git-dir', r.remote, 'show', 'main:people/alice-example.md') + '\n').toBe(CLEAN);
    git(r.seed, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
    teammateEdit(r.seed, 'README.md', 'Pushed while the card waited.\n');
    const again = bash(sanitizePush(), r.clone('restart'), { WORK: r.dir, STAGING: r.stageDir, TEAMMATE: 'true' });
    expect(again.stdout).not.toContain('ABORT');
    expect(again.status).toBe(0);
    git(r.seed, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
    teammateEdit(r.seed, 'people/bob-example.md', 'Pushed while the card waited.\n');
    const moved = bash(sanitizePush(), r.clone('restart-2'), { WORK: r.dir, STAGING: r.stageDir, TEAMMATE: 'true' });
    expect(moved.status).toBe(1);
    expect(moved.stdout).toContain('people/bob-example.md');
    expect(moved.stdout).not.toContain('people/alice-example.md');
  });

  test('Phase 4 greps look for personal data across every scanned folder', () => {
    const greps = fenceContaining('# Rating fields remaining in frontmatter');
    expect(greps).toContain("grep -v -i '@acme-example\\.com$'");
    for (const word of ['home address', 'wife', 'medical', 'diagnos', 'lawsuit', 'custody']) expect(greps).toContain(word);
    const phone = greps.split('\n').find(l => l.includes('[0-9]{4}'))!;
    expect(phone).toContain('daily/');
  });
});

describe('company-brainify purge: every ref leased and pushed', () => {
  test('no code block force-pushes without a lease', () => {
    const pushes = fences().flatMap(b => b.split('\n')).filter(l => /git push/.test(l));
    expect(pushes.length).toBeGreaterThan(0);
    for (const line of pushes) expect(line).not.toMatch(/--force(?!-with-lease)|\s-f\s/);
  });

  test('Step 1 pins every remote ref and the card lists them with the risk', () => {
    const step1 = fenceContaining('Sanitize: strip sensitive content before history purge');
    expect(step1).toContain('git ls-remote origin > "$WORK/remote-refs.txt"');
    expect(step1).toContain('git clone --mirror <SHARED_REPO_URL> "$BACKUP_PATH"');
    const card = fenceContaining('force-push every branch and tag under a lease');
    expect(card).toContain('Refs (git ls-remote origin');
    expect(card).toContain('Lease: main pinned at $LEASE');
    expect(card).toContain('Risk while this card waits');
    expect(text).not.toMatch(/old SHAs become unreachable/);
    expect(text).not.toContain('unreachable from every ref is usually enough');
  });

  /**
   * A shared repo with main (a sensitive page), a branch and an annotated tag. Step 1's recording runs, then the rewrite
   * is emulated the way filter-repo leaves the clone: new main with only the sanitized tree, the branch rewritten, the
   * tag marked delete, and origin re-added with no tracking refs.
   */
  function sharedRepo() {
    const dir = tmp();
    const remote = join(dir, 'remote.git');
    git(dir, 'init', '--bare', '-q', '-b', 'main', remote);
    const seed = join(dir, 'seed');
    git(dir, 'init', '-q', '-b', 'main', seed);
    user(seed);
    write(seed, 'people/charlie-example.md', 'salary 210,000\n');
    git(seed, 'add', 'people'); git(seed, 'commit', '-q', '-m', 'sensitive');
    git(seed, 'tag', '-a', 'v1', '-m', 'v1');
    git(seed, 'checkout', '-q', '-b', 'feat');
    write(seed, 'people/dana-example.md', 'considering leaving\n');
    git(seed, 'add', 'people'); git(seed, 'commit', '-q', '-m', 'feat');
    git(seed, 'checkout', '-q', 'main');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-q', 'origin', 'main', 'feat', 'v1');
    const work = join(dir, 'work');
    const shared = join(work, 'shared');
    git(dir, 'clone', '-q', remote, shared);
    user(shared);
    writeFileSync(join(work, 'remote-refs.txt'), git(shared, 'ls-remote', 'origin') + '\n');
    const mk = (files: Record<string, string>) => {
      const repo = join(dir, `tree-${Object.keys(files).join('-').replace(/\W/g, '')}`);
      git(dir, 'init', '-q', repo); user(repo);
      for (const [p, b] of Object.entries(files)) write(repo, p, b);
      git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'rewritten');
      git(shared, 'fetch', '-q', repo, 'HEAD');
      return git(shared, 'rev-parse', 'FETCH_HEAD');
    };
    const newMain = mk({ 'people/charlie-example.md': 'Staff engineer.\n' });
    const newFeat = mk({ 'README.md': 'feat\n' });
    git(shared, 'remote', 'remove', 'origin');
    git(shared, 'remote', 'add', 'origin', remote);
    git(shared, 'update-ref', 'refs/heads/main', newMain);
    git(shared, 'branch', '-f', 'feat', newFeat);
    git(shared, 'tag', '-d', 'v1');
    writeFileSync(join(work, 'delete-refs.txt'), 'refs/tags/v1\n');
    return { dir, remote, seed, work, shared, newMain, newFeat, oldMain: git(seed, 'rev-parse', 'main'), oldFeat: git(seed, 'rev-parse', 'feat') };
  }

  test('with nothing moved, every branch is rewritten, the deleted tag goes and no old history stays reachable', () => {
    const r = sharedRepo();
    const run = bash(fenceContaining('--force-with-lease=$ref:$old'), r.dir, { WORK: r.work, PURGE_DIRS });
    expect(run.stderr + run.stdout).not.toContain('STOP');
    expect(run.status).toBe(0);
    expect(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'main')).toBe(r.newMain);
    expect(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'feat')).toBe(r.newFeat);
    expect(git(r.dir, '--git-dir', r.remote, 'tag', '-l')).toBe('');
  });

  test('a teammate push during the card is never overwritten: the lease alone refuses the whole push', () => {
    const r = sharedRepo();
    write(r.seed, 'people/new-hire-example.md', 'Joined.\n');
    git(r.seed, 'add', 'people'); git(r.seed, 'commit', '-q', '-m', 'teammate');
    git(r.seed, 'push', '-q', 'origin', 'main');
    const teammate = git(r.seed, 'rev-parse', 'main');
    const block = fenceContaining('--force-with-lease=$ref:$old');
    const leaseOnly = block.replace(/git ls-remote origin \| cmp[^\n]*\n[^\n]*\n/, '');
    expect(leaseOnly).not.toBe(block);
    for (const script of [block, leaseOnly]) {
      const run = bash(script, r.dir, { WORK: r.work, PURGE_DIRS });
      expect(run.status).not.toBe(0);
      expect(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'main')).toBe(teammate);
      expect(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'feat')).toBe(r.oldFeat);
      expect(git(r.dir, '--git-dir', r.remote, 'tag', '-l')).toBe('v1');
    }
  });

  test('a branch missing locally that was not marked delete stops the purge, and the remote keeps it', () => {
    const r = sharedRepo();
    git(r.shared, 'branch', '-D', 'feat');
    const run = bash(fenceContaining('--force-with-lease=$ref:$old'), r.dir, { WORK: r.work, PURGE_DIRS });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('refs/heads/feat is missing locally but was not marked delete');
    expect(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'feat')).toBe(r.oldFeat);
    expect(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'main')).toBe(r.oldMain);
    expect(git(r.dir, '--git-dir', r.remote, 'tag', '-l')).toBe('v1');
  });

  test('a branch added during the card stops the purge before anything is pushed', () => {
    const r = sharedRepo();
    git(r.seed, 'push', '-q', 'origin', 'main:refs/heads/late-branch');
    const run = bash(fenceContaining('--force-with-lease=$ref:$old'), r.dir, { WORK: r.work, PURGE_DIRS });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('moved since Step 1');
    expect(git(r.dir, '--git-dir', r.remote, 'rev-parse', 'main')).toBe(r.oldMain);
  });
});

describe('company-brainify copies', () => {
  test('SKILL.md sends the purge to HISTORY-PURGE.md, the plugin copies match and skills.lock.json records the bytes', () => {
    expect(skillText).toContain('[HISTORY-PURGE.md](HISTORY-PURGE.md)');
    const body = (s: string) => s.slice(s.indexOf('\n---\n', 4));
    expect(body(readFileSync(join(ROOT, 'plugin', SKILL), 'utf8'))).toBe(body(skillText));
    expect(readFileSync(join(ROOT, 'plugin', PURGE), 'utf8')).toBe(purgeText);
    const lock = JSON.parse(readFileSync(join(ROOT, 'skills/skills.lock.json'), 'utf8')) as Record<string, string>;
    for (const path of [SKILL, PURGE]) {
      expect(lock[path.slice('skills/'.length)]).toBe(createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex'));
    }
  });
});
