/**
 * bun run merge-queue (scripts/merge-queue.ts) against throwaway git repositories: a bare origin, a master clone
 * that plays GitHub's merge button, and owner branches pushed to origin. The GitHub client is an in-memory fake;
 * release:restamp is the real one with its generator seams pointed at the fixture (as in release-restamp.test.ts).
 *
 * Fixtures: three stacked entries (versions, migrations, CHANGELOG sections and since: rows keep their owners'
 * versions), landing in order with the landing-tree check, refusals (out of order, red full-suite, outside master
 * commit, owner pushed after inclusion, contributor PR, CI self-attestation entry not last), a red master push that
 * freezes the queue, a pending post-merge wait, fix in place (refresh) and a rebuild that drops an entry.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  SELF_ATTESTATION_PATHS, branchName, compareVersions, inheritedProblems, main, parseBranch, queueNote, readNote, waitPostMerge,
  type CheckRun, type Gh, type PullRequest, type WorkflowRun,
} from '../../scripts/merge-queue.ts';
import { main as releaseRestamp } from '../../scripts/release-restamp.ts';
import { splitChangelog } from '../../scripts/lib/restamp.ts';

const REPO = join(import.meta.dir, '..', '..');
const GEN = join(REPO, 'scripts', 'build-schema-migrations.ts');
const ORDER = join(REPO, 'scripts', 'check-schema-migration-order.ts');
const DIR = 'src/core/schema-migrations';
const NOTICE = 'src/core/behavior-change-notice.ts';
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const rev = (cwd: string, ref: string) => git(cwd, 'rev-parse', ref).trim();
const isAncestor = (cwd: string, a: string, b: string) => {
  try {
    git(cwd, 'merge-base', '--is-ancestor', a, b);
    return true;
  } catch {
    return false;
  }
};

function put(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function migration(version: number, name: string): string {
  return `import type { Migration } from './types.ts';\n\nexport const v${version}: Migration = {\n  version: ${version},\n  name: '${name}',\n  idempotent: true,\n  sql: \`CREATE TABLE IF NOT EXISTS ${name} (id INT);\`,\n};\n`;
}
const migrationFile = (version: number, name: string) => `${DIR}/v${version}-${name.replace(/_/g, '-')}.ts`;

function stamps(version: string): Record<string, string> {
  const json = (name: string) => `{\n  "name": "${name}",\n  "version": "${version}"\n}\n`;
  return {
    VERSION: `${version}\n`,
    'package.json': `{\n  "name": "fixture",\n  "version": "${version}",\n  "dependencies": {}\n}\n`,
    'openclaw.plugin.json': json('openclaw-fixture'),
    '.codex-plugin/plugin.json': json('codex-fixture'),
    '.claude-plugin/plugin.json': json('claude-fixture'),
    'BOOTSTRAP_FOR_AGENTS.md': `<!-- gbrain-runbook-stamp: ${version} -->\n# Bootstrap\n`,
  };
}

const notice = (rows: string[]) => `export const BEHAVIOR_CHANGES = [\n${rows.join('\n')}\n];\n`;
const row = (since: string, id: string) => `  { since: '${since}', id: '${id}', text: 'Changed ${id}.' },`;

interface Fx { root: string; origin: string; master: string; work: string; gh: FakeGh }

function fixture(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-merge-queue-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const master = join(root, 'master');
  const work = join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(root, 'clone', '-q', origin, master);
  for (const [k, v] of [['user.email', 't@t.co'], ['user.name', 't']]) git(master, 'config', k!, v!);
  git(master, 'checkout', '-q', '-b', 'master');
  put(master, {
    ...stamps('0.1.0.0'),
    'CHANGELOG.md': '# Changelog\n\n## [0.1.0.0] - 2026-01-01\n\nFirst release.\n',
    'TODOS.md': '# TODOS\n',
    [NOTICE]: notice([row('0.1.0.0', 'seed')]),
    'src/a.ts': 'export const A = 0;\n',
    'src/b.ts': 'export const B = 0;\n',
    'src/c.ts': 'export const C = 0;\n',
    [`${DIR}/types.ts`]: 'export interface Migration { version: number; name: string; idempotent?: boolean; sql?: string }\n',
    [migrationFile(207, 'seed_one')]: migration(207, 'seed_one'),
    [migrationFile(208, 'seed_two')]: migration(208, 'seed_two'),
  });
  execFileSync('bun', [GEN, '--dir', DIR], { cwd: master, stdio: 'ignore' });
  git(master, 'add', '-A');
  git(master, 'commit', '-q', '-m', 'v0.1.0.0 seed');
  git(master, 'push', '-q', 'origin', 'master');
  git(root, 'clone', '-q', origin, work);
  for (const [k, v] of [['user.email', 't@t.co'], ['user.name', 't']]) git(work, 'config', k!, v!);
  return { root, origin, master, work, gh: new FakeGh(origin, master) };
}

/** An owner branch off master, shipped the way /ship leaves it: stamped master + 1, its own CHANGELOG entry and since: row. */
function ownerBranch(fx: Fx, n: number, file: string, opts: { migration?: [number, string]; extra?: Record<string, string>; author?: string } = {}): void {
  const w = fx.work;
  git(w, 'fetch', '-q', 'origin');
  git(w, 'checkout', '-q', '-B', `owner-${n}`, 'origin/master');
  const version = '0.1.1.0';
  const log = splitChangelog(readFileSync(join(w, 'CHANGELOG.md'), 'utf8'));
  const rows = readFileSync(join(w, NOTICE), 'utf8').split('\n').filter((l) => l.includes('since:'));
  put(w, {
    ...stamps(version),
    'CHANGELOG.md': [log.preamble, `## [${version}] - 2026-11-09\n\nChange ${n} (v${version}).\n`, ...log.sections.map((s) => s.text)].join('\n'),
    [NOTICE]: notice([...rows, row(version, `change_${n}`)]),
    [file]: `export const CHANGED_${n} = true;\n`,
    ...(opts.migration ? { [migrationFile(...opts.migration)]: migration(...opts.migration) } : {}),
    ...opts.extra,
  });
  execFileSync('bun', [GEN, '--dir', DIR], { cwd: w, stdio: 'ignore' });
  git(w, 'add', '-A');
  git(w, 'commit', '-q', '-m', `v${version} change ${n}`);
  git(w, 'push', '-q', '-f', 'origin', `owner-${n}`);
  fx.gh.addOwner(n, `owner-${n}`, `v${version} fix(area): change ${n}`, opts.author ?? 'garrytan');
}

class FakeGh implements Gh {
  prs = new Map<number, PullRequest & { owner: boolean }>();
  next = 100;
  red = new Set<string>();
  extra: CheckRun[] = [];
  postMerge: Record<string, string> = {};
  releaseGate: string | null = 'success';
  merged: Array<{ n: number; sha: string; title: string }> = [];
  beforeMerge: (() => void) | null = null;
  posted: Array<{ n: number; body: string }> = [];
  constructor(readonly origin: string, readonly master: string) {}
  private head(branch: string): string {
    return git(this.origin, 'rev-parse', `refs/heads/${branch}`).trim();
  }
  private view(p: PullRequest & { owner: boolean }): PullRequest {
    return { ...p, headRefOid: p.state === 'OPEN' ? this.head(p.headRefName) : p.headRefOid };
  }
  addOwner(n: number, branch: string, title: string, author: string): void {
    this.prs.set(n, { number: n, title, body: '', headRefOid: '', headRefName: branch, state: 'OPEN', isCrossRepository: false, author, labels: [], mergeStateStatus: 'CLEAN', owner: true });
  }
  repoOwner(): string { return 'garrytan'; }
  pr(n: number): PullRequest { return this.view(this.prs.get(n)!); }
  openPrForBranch(branch: string): PullRequest | null {
    const p = [...this.prs.values()].find((x) => x.headRefName === branch && x.state === 'OPEN');
    return p ? this.view(p) : null;
  }
  createPr(o: { head: string; title: string; body: string }): number {
    const n = this.next++;
    this.prs.set(n, { number: n, title: o.title, body: o.body, headRefOid: '', headRefName: o.head, state: 'OPEN', isCrossRepository: false, author: 'garrytan', labels: [], mergeStateStatus: 'CLEAN', owner: false });
    return n;
  }
  addLabel(n: number, label: string): void { this.prs.get(n)!.labels.push(label); }
  comment(n: number, body: string): void { this.posted.push({ n, body }); }
  comments(n: number): string[] { return this.notes(n); }
  notes(n: number): string[] { return this.posted.filter((c) => c.n === n).map((c) => c.body); }
  closePr(n: number): void { this.prs.get(n)!.state = 'CLOSED'; }
  checks(sha: string): CheckRun[] {
    return ['Test/cheap-tier', 'Test/full-suite', 'E2E Tests/e2e-full-suite'].map((name) => ({ name, status: 'completed', conclusion: this.red.has(`${sha}:${name}`) ? 'failure' : 'success' } as CheckRun)).concat(this.extra);
  }
  merge(n: number, sha: string, title: string, message: string): string {
    const p = this.prs.get(n)!;
    if (this.head(p.headRefName) !== sha) throw new Error('head moved');
    this.beforeMerge?.();
    git(this.master, 'fetch', '-q', 'origin');
    git(this.master, 'reset', '-q', '--hard', 'origin/master');
    git(this.master, 'merge', '-q', '--no-ff', '-m', title, '-m', message, sha);
    git(this.master, 'push', '-q', 'origin', 'master');
    const merged = rev(this.master, 'HEAD');
    p.state = 'MERGED';
    p.headRefOid = sha;
    for (const o of this.prs.values()) if (o.owner && o.state === 'OPEN' && isAncestor(this.origin, this.head(o.headRefName), merged)) o.state = 'MERGED';
    this.merged.push({ n, sha: merged, title });
    return merged;
  }
  pushRuns(sha: string): WorkflowRun[] {
    return ['Test', 'E2E Tests', 'Release'].map((name, i) => ({ id: i + 1, name, status: this.postMerge[name] === 'in_progress' ? 'in_progress' : 'completed', conclusion: this.postMerge[name] ?? 'success' }));
  }
  jobConclusion(): string | null { return this.releaseGate; }
  receiptHead(pr: number): string | null { return this.pr(pr).headRefOid; }
}

const STEPS = JSON.stringify([{ name: 'schema migration registry', argv: ['bun', GEN, '--dir', DIR] }]);
const CHECKS = JSON.stringify([
  { name: 'schema migration registry fresh', argv: ['bun', GEN, '--dir', DIR, '--check'] },
  { name: 'schema migration order', argv: ['bun', ORDER] },
]);

function mq(fx: Fx, argv: string[]): { code: number; out: string } {
  const lines: string[] = [];
  const env = { ...process.env, GBRAIN_RESTAMP_STEPS: STEPS, GBRAIN_RESTAMP_CHECKS: CHECKS, GBRAIN_RESTAMP_DATE: '2026-11-09', GBRAIN_RESTAMP_PR_TITLE: 'fix(area): change', GBRAIN_MQ_WORKTREES: join(fx.root, 'wt') };
  const code = main(argv, {
    cwd: fx.work, env, gh: fx.gh, log: (l) => lines.push(l), install: () => {}, sleep: () => {}, now: () => 0,
    restamp: (cwd, args) => releaseRestamp(args, { cwd, env, log: (l) => lines.push(l) }),
  });
  return { code, out: lines.join('\n') };
}

const show = (fx: Fx, ref: string, path: string) => git(fx.origin, 'show', `${ref}:${path}`);
const queuePr = (fx: Fx, branch: string) => fx.gh.openPrForBranch(branch)!.number;

function threeEntries(): Fx {
  const fx = fixture();
  ownerBranch(fx, 1, 'src/a.ts', { migration: [209, 'one_widgets'] });
  ownerBranch(fx, 2, 'src/b.ts');
  ownerBranch(fx, 3, 'src/c.ts', { migration: [209, 'three_gadgets'] });
  const r = mq(fx, ['build', '1', '2', '3']);
  expect(r.out).not.toContain('refused');
  expect(r.code).toBe(0);
  return fx;
}

describe('merge-queue build', () => {
  test('stacks three entries: each contains the ones ahead, versions and migrations in queue order, earlier stamps kept', () => {
    const fx = threeEntries();
    const [q1, q2, q3] = ['mq/0.1.1.0-pr1', 'mq/0.1.2.0-pr2', 'mq/0.1.3.0-pr3'];
    expect(isAncestor(fx.origin, q1, q2) && isAncestor(fx.origin, q2, q3)).toBe(true);
    for (const [b, v] of [[q1, '0.1.1.0'], [q2, '0.1.2.0'], [q3, '0.1.3.0']]) expect(show(fx, b!, 'VERSION').trim()).toBe(v!);
    expect(splitChangelog(show(fx, q3, 'CHANGELOG.md')).sections.map((s) => s.header)).toEqual([
      '## [0.1.3.0] - 2026-11-09', '## [0.1.2.0] - 2026-11-09', '## [0.1.1.0] - 2026-11-09', '## [0.1.0.0] - 2026-01-01',
    ]);
    expect(show(fx, q3, 'CHANGELOG.md')).toContain('Change 2 (v0.1.2.0).');
    const rows = show(fx, q3, NOTICE);
    for (const [v, id] of [['0.1.1.0', 'change_1'], ['0.1.2.0', 'change_2'], ['0.1.3.0', 'change_3']]) expect(rows).toContain(`since: '${v}', id: '${id}'`);
    const migs = git(fx.origin, 'ls-tree', '--name-only', `${q3}:${DIR}`);
    expect(migs).toContain('v209-one-widgets.ts');
    expect(migs).toContain('v210-three-gadgets.ts');
    const pr3 = fx.gh.pr(queuePr(fx, q3));
    expect(pr3.title).toBe('v0.1.3.0 fix(area): change 3');
    expect(pr3.labels).toEqual(['full-ci']);
    expect(readNote(fx.gh.notes(pr3.number))).toEqual({ owner: 3, ownerHead: rev(fx.origin, 'refs/heads/owner-3'), base: q2, baseHead: rev(fx.origin, q2) });
  }, 120_000);

  test('refuses a contributor PR, and an entry changing the CI self-attestation files unless it is last', () => {
    const fx = fixture();
    ownerBranch(fx, 1, 'src/a.ts', { extra: { '.github/workflows/test.yml': 'name: Test\n' } });
    ownerBranch(fx, 2, 'src/b.ts');
    ownerBranch(fx, 3, 'src/c.ts', { author: 'outside-dev' });
    expect(mq(fx, ['plan', '3']).out).toContain('#3 is a contributor PR');
    const r = mq(fx, ['plan', '1', '2']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('#1 changes .github/workflows/test.yml');
    expect(mq(fx, ['plan', '2', '1']).out).toContain('PLAN: +2 #1 mq/0.1.2.0-pr1 version=0.1.2.0 base=mq/0.1.1.0-pr2');
    expect(mq(fx, ['build', '2', '1']).code).toBe(0);
    ownerBranch(fx, 4, 'src/d.ts');
    expect(mq(fx, ['build', '4']).out).toContain('changes the CI self-attestation files');

    expect(mq(fx, ['land', String(queuePr(fx, 'mq/0.1.1.0-pr2'))]).code).toBe(0);
    const last = queuePr(fx, 'mq/0.1.2.0-pr1');
    const tree = git(fx.origin, 'rev-parse', 'mq/0.1.2.0-pr1^{tree}').trim();
    const refused = mq(fx, ['verify', String(last)]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('pass --vm-gate-tree');
    expect(mq(fx, ['verify', String(last), '--vm-gate-tree', '0'.repeat(40)]).out).toContain('pass --vm-gate-tree');
    expect(mq(fx, ['verify', String(last), '--vm-gate-tree', tree]).code).toBe(0);
  }, 180_000);
});

describe('merge-queue verify and land', () => {
  test('lands in order: only Q1 may land, each later landing tree is the gated tree, owner PRs show merged', () => {
    const fx = threeEntries();
    const q = ['mq/0.1.1.0-pr1', 'mq/0.1.2.0-pr2', 'mq/0.1.3.0-pr3'].map((b) => ({ n: queuePr(fx, b), head: rev(fx.origin, b) }));
    const early = mq(fx, ['land', String(q[1]!.n)]);
    expect(early.code).toBe(1);
    expect(early.out).toContain('only Q1');
    for (const e of q) {
      const r = mq(fx, ['land', String(e.n), '--expect-head', e.head]);
      expect(r.out).toContain(`VERIFY: ok #${e.n}`);
      expect(r.out).toContain('POST_MERGE: green');
      expect(r.code).toBe(0);
      expect(git(fx.origin, 'rev-parse', 'refs/heads/master^{tree}').trim()).toBe(git(fx.origin, 'rev-parse', `${e.head}^{tree}`).trim());
    }
    expect(fx.gh.merged.map((m) => m.title)).toEqual(['fix(area): change 1 (#100)', 'fix(area): change 2 (#101)', 'fix(area): change 3 (#102)']);
    expect([1, 2, 3].map((n) => fx.gh.pr(n).state)).toEqual(['MERGED', 'MERGED', 'MERGED']);
    expect(mq(fx, ['status']).out).toBe('QUEUE: empty');
  }, 180_000);

  test('refuses a red full-suite, an outside master commit, and an owner push after inclusion', () => {
    const fx = fixture();
    ownerBranch(fx, 1, 'src/a.ts');
    expect(mq(fx, ['build', '1']).code).toBe(0);
    const n = queuePr(fx, 'mq/0.1.1.0-pr1');
    const head = rev(fx.origin, 'mq/0.1.1.0-pr1');
    fx.gh.red.add(`${head}:Test/full-suite`);
    expect(mq(fx, ['verify', String(n)]).out).toContain('Test/full-suite is failure on the exact head');
    fx.gh.red.clear();
    fx.gh.extra = [{ name: 'Test/full-suite', status: 'completed', conclusion: 'skipped' }];
    expect(mq(fx, ['verify', String(n)]).code).toBe(0);
    fx.gh.extra = [{ name: 'Test/full-suite', status: 'completed', conclusion: 'failure' }];
    expect(mq(fx, ['verify', String(n)]).out).toContain('Test/full-suite is failure on the exact head');
    fx.gh.extra = [];

    git(fx.work, 'checkout', '-q', 'owner-1');
    put(fx.work, { 'src/a.ts': 'export const CHANGED_1 = 2;\n' });
    git(fx.work, 'commit', '-qam', 'owner fix');
    git(fx.work, 'push', '-q', 'origin', 'owner-1');
    expect(mq(fx, ['verify', String(n)]).out).toContain('owner #1 pushed after inclusion');

    put(fx.master, { 'src/c.ts': 'export const C = 1;\n' });
    git(fx.master, 'commit', '-qam', 'outside commit');
    git(fx.master, 'push', '-q', 'origin', 'master');
    expect(mq(fx, ['verify', String(n)]).out).toContain('landing-tree check');
  }, 120_000);

  test('a merge that lands on a moved master freezes the queue instead of waiting on an ungated tree', () => {
    const fx = fixture();
    ownerBranch(fx, 1, 'src/a.ts');
    expect(mq(fx, ['build', '1']).code).toBe(0);
    fx.gh.beforeMerge = () => {
      fx.gh.beforeMerge = null;
      git(fx.master, 'fetch', '-q', 'origin');
      git(fx.master, 'reset', '-q', '--hard', 'origin/master');
      put(fx.master, { 'src/c.ts': 'export const C = 1;\n' });
      git(fx.master, 'add', '-A');
      git(fx.master, 'commit', '-qm', 'outside commit');
      git(fx.master, 'push', '-q', 'origin', 'master');
    };
    const r = mq(fx, ['land', String(queuePr(fx, 'mq/0.1.1.0-pr1'))]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('QUEUE_FROZEN: master moved before the merge');
    expect(r.out).not.toContain('POST_MERGE');
  }, 120_000);

  test('rejects unknown, misplaced and malformed flags', () => {
    const fx = fixture();
    for (const argv of [['verify', '1', '--expect-hed', 'a'.repeat(40)], ['plan', '1', '--vm-gate-tree', 'a'.repeat(40)], ['land', '1', '--expect-head', 'abc'], ['land', '1', '--timeout-minutes', '0'], ['verify', '1', '2'], ['status', '1'], ['bogus']]) {
      expect(mq(fx, argv).code).toBe(2);
    }
  }, 60_000);

  test('a red master push freezes the queue, and a running Release ci-gate leaves it waiting', () => {
    const fx = fixture();
    ownerBranch(fx, 1, 'src/a.ts');
    expect(mq(fx, ['build', '1']).code).toBe(0);
    fx.gh.postMerge = { Test: 'failure' };
    const r = mq(fx, ['land', String(queuePr(fx, 'mq/0.1.1.0-pr1'))]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('POST_MERGE: red');
    expect(r.out).toContain('QUEUE_FROZEN');

    const gh = new FakeGh(fx.origin, fx.master);
    gh.releaseGate = null;
    let t = 0;
    const lines: string[] = [];
    expect(waitPostMerge(gh, 'abc', 60_000, { now: () => t, sleep: (ms) => { t += ms; } }, (l) => lines.push(l))).toBe('pending');
    expect(lines.join('\n')).toContain('Release ci-gate=running');
  }, 120_000);
});

describe('merge-queue refresh and rebuild', () => {
  test('refresh fixes an entry in place: versions stay, the entry behind re-merges the new head', () => {
    const fx = fixture();
    ownerBranch(fx, 1, 'src/a.ts');
    ownerBranch(fx, 2, 'src/b.ts');
    expect(mq(fx, ['build', '1', '2']).code).toBe(0);
    git(fx.work, 'checkout', '-q', 'owner-1');
    put(fx.work, { 'src/a.ts': 'export const CHANGED_1 = 2;\n' });
    git(fx.work, 'commit', '-qam', 'owner fix');
    git(fx.work, 'push', '-q', 'origin', 'owner-1');
    const fix = rev(fx.work, 'HEAD');
    const r = mq(fx, ['refresh', String(queuePr(fx, 'mq/0.1.1.0-pr1'))]);
    expect(r.code).toBe(0);
    const [q1, q2] = ['mq/0.1.1.0-pr1', 'mq/0.1.2.0-pr2'];
    expect(isAncestor(fx.origin, fix, q1) && isAncestor(fx.origin, q1, q2)).toBe(true);
    expect([show(fx, q1, 'VERSION').trim(), show(fx, q2, 'VERSION').trim()]).toEqual(['0.1.1.0', '0.1.2.0']);
    expect(readNote(fx.gh.notes(queuePr(fx, q1)))!.ownerHead).toBe(fix);
    expect(mq(fx, ['verify', String(queuePr(fx, q1))]).code).toBe(0);
  }, 180_000);

  test('rebuild --drop builds the tail on fresh names without the dropped entry and closes what it replaced', () => {
    const fx = threeEntries();
    const old = [queuePr(fx, 'mq/0.1.2.0-pr2'), queuePr(fx, 'mq/0.1.3.0-pr3')];
    const r = mq(fx, ['rebuild', String(old[0]), '--drop', '2']);
    expect(r.code).toBe(0);
    expect(git(fx.origin, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/mq/').trim().split('\n')).toEqual(['mq/0.1.1.0-pr1', 'mq/0.1.2.0-pr3-r2']);
    expect(isAncestor(fx.origin, 'refs/heads/owner-2', 'mq/0.1.2.0-pr3-r2')).toBe(false);
    expect(show(fx, 'mq/0.1.2.0-pr3-r2', NOTICE)).toContain("since: '0.1.2.0', id: 'change_3'");
    expect(old.map((n) => fx.gh.pr(n).state)).toEqual(['CLOSED', 'CLOSED']);
    expect(fx.gh.notes(old[0]!).at(-1)).toContain('dropped #2');
  }, 180_000);
});

describe('merge-queue helpers', () => {
  test('branch names, versions and the queue note round-trip', () => {
    expect(branchName('0.60.621.0', 8898)).toBe('mq/0.60.621.0-pr8898');
    expect(parseBranch('mq/0.60.622.0-pr8915-r3')).toEqual({ version: '0.60.622.0', owner: 8915, round: 3 });
    expect(parseBranch('capy/mq-thing')).toBeNull();
    expect(['0.60.99.0', '0.60.100.0', '0.60.9.0'].sort(compareVersions)).toEqual(['0.60.9.0', '0.60.99.0', '0.60.100.0']);
    const sha = 'a'.repeat(40);
    const older = queueNote({ owner: 7, ownerHead: 'b'.repeat(40), base: 'master', baseHead: sha });
    const newer = queueNote({ owner: 7, ownerHead: sha, base: 'mq/0.1.1.0-pr6', baseHead: sha });
    expect(readNote([older, 'Queue-Owner-Head: #9 ' + sha, newer, 'a later review comment'])).toEqual({ owner: 7, ownerHead: sha, base: 'mq/0.1.1.0-pr6', baseHead: sha });
    expect(readNote(['no note here'])).toBeNull();
  });

  test('inheritedProblems names a moved since: row and a changed earlier CHANGELOG section', () => {
    const base = { changelog: '# C\n\n## [0.1.1.0] - d\n\nOne.\n\n## [0.1.0.0] - d\n\nSeed.\n', notice: notice([row('0.1.1.0', 'one')]) };
    const good = { changelog: '# C\n\n## [0.1.2.0] - d\n\nTwo.\n\n## [0.1.1.0] - d\n\nOne.\n\n## [0.1.0.0] - d\n\nSeed.\n', notice: notice([row('0.1.1.0', 'one'), row('0.1.2.0', 'two')]) };
    expect(inheritedProblems(base, good, '0.1.2.0')).toEqual([]);
    const moved = { changelog: good.changelog.replace('One.', 'One (v0.1.2.0).'), notice: notice([row('0.1.2.0', 'one'), row('0.1.2.0', 'two')]) };
    const problems = inheritedProblems(base, moved, '0.1.2.0');
    expect(problems.some((p) => p.includes('## [0.1.1.0]'))).toBe(true);
    expect(problems.some((p) => p.includes("since: '0.1.1.0', id: 'one'"))).toBe(true);
    expect(inheritedProblems(base, good, '0.1.3.0')[0]).toContain('expected ## [0.1.3.0]');
  });

  test('SELF_ATTESTATION_PATHS is the list scripts/pregate-remote-gate.sh guards', () => {
    const line = readFileSync(join(REPO, 'scripts', 'pregate-remote-gate.sh'), 'utf8').split('\n').find((l) => l.includes('for path in .github/workflows/test.yml'))!;
    const listed = line.replace(/^.*for path in /, '').replace(/ "\$@".*$/, '').split(' ');
    expect([...SELF_ATTESTATION_PATHS].sort()).toEqual(listed.sort());
  });
});
