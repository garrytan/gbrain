/**
 * .github/workflows/promote-stable.yml + scripts/promote-stable.ts — the
 * stable channel.
 *
 * Protects: `stable` moves only for an admin or maintainer, only to an
 * existing, published v<VERSION> release whose exact git tree passed a
 * completed, successful run of the configured soak workflow, only forward
 * unless a rollback names its reason, with the immutable stable-v<VERSION>
 * record created once and pushed atomically with the leased `stable` move. Regressions it
 * catches: accepting a soak of a different tree or workflow, a run from
 * another repository, a no-op or silent downgrade, re-creating a record tag,
 * a changed tag message contract, and the workflow interpolating inputs
 * into shell or growing a trigger other than workflow_dispatch.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  checkOrder, checkSoakRun, compareVersions, normaliseWorkflowPath, parseRunUrl, processDeps, promote, Refusal, renderSummary, renderTagMessage,
  type GitResult, type PromoteDeps, type PromoteInputs, type SoakRun, type TagFields,
} from '../../scripts/promote-stable.ts';

const ROOT = join(import.meta.dir, '..', '..');
const REPO = 'garrytan/gbrain';
const RUN_URL = `https://github.com/${REPO}/actions/runs/123456`;
const SOAK = '.github/workflows/soak.yml';
const sha = (c: string) => c.repeat(40);
const NOW = new Date('2026-10-21T17:00:00.123Z');

const refused = (fn: () => unknown, pattern: RegExp) => {
  let error: unknown;
  try { fn(); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Refusal);
  expect((error as Error).message).toMatch(pattern);
};
const refusedAsync = async (p: Promise<unknown>, pattern: RegExp) => {
  const error = await p.then(() => null, e => e);
  expect(error).toBeInstanceOf(Refusal);
  expect((error as Error).message).toMatch(pattern);
};

interface FakeRepo {
  commits: Record<string, string>;
  tags: Record<string, { commit: string; object?: string; message?: string }>;
  remote?: Record<string, string>;
  /** What `git show v<version>:VERSION` prints; default: the tag's own version. */
  versionFile?: string;
  failPush?: boolean;
}

const ok = (stdout = ''): GitResult => ({ code: 0, stdout: `${stdout}\n`, stderr: '' });
const fail: GitResult = { code: 1, stdout: '', stderr: 'fatal: bad revision' };

function fakeGit(repo: FakeRepo, calls: string[]) {
  let objects = 0;
  const resolve = (spec: string): { commit: string; object: string } | null => {
    const ref = spec.replace(/^refs\/tags\//, '');
    const tag = repo.tags[ref];
    if (tag) return { commit: tag.commit, object: tag.object ?? tag.commit };
    return repo.commits[spec] ? { commit: spec, object: spec } : null;
  };
  return async (args: string[]): Promise<GitResult> => {
    calls.push(args.join(' '));
    const [cmd, ...rest] = args;
    if (cmd === 'rev-parse') {
      const spec = rest.at(-1)!;
      const m = /^(.*?)(\^\{(commit|tree)\})?$/.exec(spec)!;
      const hit = resolve(m[1]!);
      if (!hit) return fail;
      if (m[3] === 'tree') return ok(repo.commits[hit.commit]!);
      return ok(m[3] === 'commit' ? hit.commit : hit.object);
    }
    if (cmd === 'tag' && rest[0] === '--points-at') {
      return ok(Object.entries(repo.tags).filter(([n, t]) => t.commit === rest[1] && n.startsWith('v')).map(([n]) => n).join('\n'));
    }
    if (cmd === 'tag' && rest[0] === '-a') {
      const message = rest[rest.indexOf('-m') + 1]!;
      const [name, commit] = rest.slice(-2) as [string, string];
      if (repo.tags[name] && !rest.includes('-f')) return fail;
      repo.tags[name] = { commit, object: `tagobj-${name}-${++objects}`, message };
      return ok();
    }
    if (cmd === 'push') {
      const names = rest.filter(a => a.includes(':') && !a.startsWith('--')).map(r => r.split(':')[0]!.replace(/^refs\/tags\//, ''));
      const lease = rest.find(a => a.startsWith('--force-with-lease='));
      repo.remote ??= {};
      if (repo.failPush) return { code: 1, stdout: '', stderr: 'fatal: the remote end hung up unexpectedly' };
      if (lease && lease.split(':').at(-1) !== (repo.remote.stable ?? '')) return { code: 1, stdout: '', stderr: '! [rejected] stable -> stable (stale info)' };
      for (const name of names) repo.remote[name] = repo.tags[name]!.object!;
      return ok();
    }
    if (cmd === 'show') {
      const ref = rest[0]!.replace(/:VERSION$/, '').replace(/^refs\/tags\//, '');
      return repo.tags[ref] ? ok(repo.versionFile ?? ref.replace(/^v/, '')) : fail;
    }
    if (cmd === 'fetch') return ok();
    return fail;
  };
}

interface Setup {
  role?: { permission: string; role_name?: string };
  run?: SoakRun;
  /** The GitHub release for the tag; null: there is none (404). */
  release?: { draft: boolean } | null;
  soakWorkflow?: string;
  repo?: FakeRepo;
}

function harness(setup: Setup = {}) {
  const calls: string[] = [];
  const api: string[] = [];
  const logs: string[] = [];
  const summaries: string[] = [];
  const repo: FakeRepo = setup.repo ?? {
    commits: { [sha('a')]: sha('1'), [sha('b')]: sha('2'), [sha('c')]: sha('3') },
    tags: { 'v0.60.360.0': { commit: sha('a') }, 'v0.60.361.0': { commit: sha('b') }, stable: { commit: sha('a'), object: 'tagobj-stable-old' }, 'stable-v0.60.360.0': { commit: sha('a'), object: 'tagobj-record-360' } },
    remote: { stable: 'tagobj-stable-old', 'stable-v0.60.360.0': 'tagobj-record-360' },
  };
  const run: SoakRun = setup.run ?? { status: 'completed', conclusion: 'success', path: SOAK, head_sha: sha('b') };
  const deps: PromoteDeps = {
    repo: REPO,
    actor: 'alice-example',
    soakWorkflow: setup.soakWorkflow ?? 'soak.yml',
    async ghApi(path) {
      api.push(path);
      if (path.endsWith('/permission')) return setup.role ?? { permission: 'write', role_name: 'maintain' };
      if (path.includes('/releases/tags/')) {
        if (setup.release === null) throw new Error(`gh api ${path} failed: HTTP 404: Not Found`);
        return setup.release ?? { draft: false };
      }
      return run;
    },
    git: fakeGit(repo, calls),
    now: () => NOW,
    log: line => logs.push(line),
    summary: md => summaries.push(md),
  };
  return { deps, calls, api, logs, summaries, repo };
}

const inputs = (over: Partial<PromoteInputs> = {}): PromoteInputs => ({ version: '0.60.361.0', soakRunUrl: RUN_URL, scoreboardUrl: '', rollback: false, reason: '', ...over });

describe('soak run URL parsing', () => {
  test('accepts a run, a run attempt and a trailing slash in this repository', () => {
    expect(parseRunUrl(RUN_URL, REPO)).toEqual({ runId: '123456', attempt: null });
    expect(parseRunUrl(`${RUN_URL}/attempts/2`, REPO)).toEqual({ runId: '123456', attempt: '2' });
    expect(parseRunUrl(`${RUN_URL}/`, REPO)).toEqual({ runId: '123456', attempt: null });
    expect(parseRunUrl(`${RUN_URL}/attempts/3/`, REPO)).toEqual({ runId: '123456', attempt: '3' });
  });

  test('refuses a run of another repository and anything that is not a run URL', () => {
    refused(() => parseRunUrl('https://github.com/acme-example/gbrain/actions/runs/123456', REPO), /run of acme-example\/gbrain, not garrytan\/gbrain/);
    for (const junk of ['', 'not a url', 'http://github.com/garrytan/gbrain/actions/runs/1', `${RUN_URL}/job/9`, 'https://github.com/garrytan/gbrain/actions/runs/abc', `${RUN_URL}?x=1`, 'https://example.com/garrytan/gbrain/actions/runs/1']) {
      refused(() => parseRunUrl(junk, REPO), /is not a GitHub Actions run URL/);
    }
  });
});

describe('soak run validation', () => {
  const good: SoakRun = { status: 'completed', conclusion: 'success', path: SOAK, head_sha: sha('b') };

  test('accepts a completed successful run of the configured workflow, named bare or by path', () => {
    for (const name of ['soak.yml', '.github/workflows/soak.yml', './.github/workflows/soak.yml', ' soak.yml ']) {
      expect(() => checkSoakRun(good, name, RUN_URL)).not.toThrow();
    }
    expect(normaliseWorkflowPath('soak.yml')).toBe(SOAK);
    expect(normaliseWorkflowPath('.github/workflows/soak.yml@refs/heads/master')).toBe(SOAK);
  });

  test('refuses a run that has not completed or did not succeed', () => {
    refused(() => checkSoakRun({ ...good, status: 'in_progress', conclusion: null }, 'soak.yml', RUN_URL), /is in_progress, not completed; wait for it to finish/);
    refused(() => checkSoakRun({ ...good, conclusion: 'failure' }, 'soak.yml', RUN_URL), /concluded failure, not success/);
    refused(() => checkSoakRun({ ...good, conclusion: 'cancelled' }, 'soak.yml', RUN_URL), /concluded cancelled, not success/);
  });

  test('refuses a run of another workflow', () => {
    refused(() => checkSoakRun({ ...good, path: '.github/workflows/test.yml' }, 'soak.yml', RUN_URL), /ran \.github\/workflows\/test\.yml, not the soak workflow \.github\/workflows\/soak\.yml/);
  });

  test('refuses when the STABLE_SOAK_WORKFLOW variable is unset, naming where to set it', () => {
    refused(() => checkSoakRun(good, '', RUN_URL), /set the repository variable STABLE_SOAK_WORKFLOW to the soak workflow's file \(Settings → Secrets and variables → Actions → Variables\)/);
  });
});

describe('version ordering', () => {
  test('compares 3- and 4-part versions numerically', () => {
    expect(compareVersions('0.60.361.0', '0.60.360.0')).toBe(1);
    expect(compareVersions('0.60.99.0', '0.60.100.0')).toBe(-1);
    expect(compareVersions('0.61.0', '0.60.999.9')).toBe(1);
    expect(compareVersions('0.60.1', '0.60.1.0')).toBe(0);
  });

  test('newer promotes; same is a no-op; older needs rollback and a reason', () => {
    expect(() => checkOrder('0.60.361.0', '0.60.360.0', false, '')).not.toThrow();
    expect(() => checkOrder('0.60.361.0', null, false, '')).not.toThrow();
    refused(() => checkOrder('0.60.361.0', '0.60.361.0', false, ''), /already the stable release, so there is nothing to promote/);
    refused(() => checkOrder('0.60.361.0', '0.60.361.0', true, 'retry'), /already the stable release/);
    refused(() => checkOrder('0.60.359.0', '0.60.360.0', false, ''), /older than the current stable v0\.60\.360\.0; to move stable back, re-run with rollback=true and a reason/);
    refused(() => checkOrder('0.60.359.0', '0.60.360.0', true, '  '), /A rollback needs a reason/);
    expect(() => checkOrder('0.60.359.0', '0.60.360.0', true, 'sync regression in 0.60.360.0')).not.toThrow();
  });
});

describe('tag message and summary', () => {
  const fields: TagFields = {
    version: '0.60.361.0', commit: sha('b'), tree: sha('2'), soakRun: RUN_URL, scoreboard: 'https://example.com/scoreboard',
    promotedBy: 'alice-example', promotedAt: '2026-10-21T17:00:00Z', previous: '0.60.360.0', rollback: false, reason: '',
  };

  test('renders the exact key: value body', () => {
    expect(renderTagMessage(fields)).toBe([
      'gbrain stable channel: v0.60.361.0',
      '',
      'version: 0.60.361.0',
      `commit: ${sha('b')}`,
      `tree: ${sha('2')}`,
      `soak_run: ${RUN_URL}`,
      'scoreboard: https://example.com/scoreboard',
      'promoted_by: alice-example',
      'promoted_at: 2026-10-21T17:00:00Z',
      'previous: 0.60.360.0',
      'rollback: false',
      'reason: -',
      '',
    ].join('\n'));
    const first = renderTagMessage({ ...fields, previous: null, rollback: true, reason: 'bad\nrelease' });
    expect(first).toContain('previous: none\n');
    expect(first).toContain('rollback: true\nreason: bad release\n');
  });

  test('the step summary names version, commit, tree, soak run, scoreboard, previous and rollback', () => {
    const md = renderSummary({ ...fields, rollback: true, reason: 'a | b', recordCreated: false });
    for (const part of ['## Stable channel: v0.60.361.0', sha('b'), sha('2'), RUN_URL, 'https://example.com/scoreboard', 'v0.60.360.0', 'yes: a \\| b', 'already existed']) expect(md).toContain(part);
  });
});

describe('promote', () => {
  test('a maintainer promotes a newer release: the record tag and the leased stable move in one atomic push', async () => {
    const h = harness();
    const p = await promote(h.deps, inputs());
    expect(p).toMatchObject({ version: '0.60.361.0', commit: sha('b'), tree: sha('2'), previous: '0.60.360.0', scoreboard: RUN_URL, recordCreated: true, promotedAt: '2026-10-21T17:00:00Z' });
    expect(h.api).toEqual([`repos/${REPO}/collaborators/alice-example/permission`, `repos/${REPO}/releases/tags/v0.60.361.0`, `repos/${REPO}/actions/runs/123456`]);
    const pushes = h.calls.filter(c => c.startsWith('push'));
    expect(pushes).toEqual([
      'push --atomic --force-with-lease=refs/tags/stable:tagobj-stable-old origin refs/tags/stable-v0.60.361.0:refs/tags/stable-v0.60.361.0 refs/tags/stable:refs/tags/stable',
    ]);
    expect(h.repo.tags['stable-v0.60.361.0']!.commit).toBe(sha('b'));
    expect(h.repo.tags.stable!.commit).toBe(sha('b'));
    expect(h.repo.tags.stable!.message).toBe(renderTagMessage(p));
    expect(h.repo.tags['stable-v0.60.361.0']!.message).toBe(renderTagMessage(p));
    expect(h.summaries).toHaveLength(1);
    expect(h.logs.length).toBeGreaterThanOrEqual(6);
    expect(h.calls).not.toContain(`fetch --no-tags origin ${sha('b')}`);
  });

  test('a named attempt is read from the attempts endpoint and the first promotion records previous: none', async () => {
    const h = harness({ repo: { commits: { [sha('b')]: sha('2') }, tags: { 'v0.60.361.0': { commit: sha('b') } } } });
    const p = await promote(h.deps, inputs({ soakRunUrl: `${RUN_URL}/attempts/2`, scoreboardUrl: 'https://example.com/board' }));
    expect(h.api[2]).toBe(`repos/${REPO}/actions/runs/123456/attempts/2`);
    expect(p.previous).toBeNull();
    expect(p.scoreboard).toBe('https://example.com/board');
    expect(h.calls.at(-1)).toBe('push --atomic --force-with-lease=refs/tags/stable: origin refs/tags/stable-v0.60.361.0:refs/tags/stable-v0.60.361.0 refs/tags/stable:refs/tags/stable');
  });

  test('admins pass; write, triage and read collaborators are refused before anything else is read', async () => {
    await promote(harness({ role: { permission: 'admin', role_name: 'admin' } }).deps, inputs());
    for (const role of [{ permission: 'write', role_name: 'write' }, { permission: 'read', role_name: 'triage' }, { permission: 'none' }]) {
      const h = harness({ role });
      await refusedAsync(promote(h.deps, inputs()), /only admins and maintainers promote to stable/);
      expect(h.calls).toEqual([]);
      expect(h.api).toHaveLength(1);
    }
  });

  test('refuses a malformed version and a version with no release tag', async () => {
    await refusedAsync(promote(harness().deps, inputs({ version: '0.60.361.0; rm -rf /' })), /is not a release version/);
    await refusedAsync(promote(harness().deps, inputs({ version: '0.60.362.0' })), /There is no release tag v0\.60\.362\.0/);
  });

  test('refuses a tag whose VERSION file names another version, a tag with no GitHub release and a draft release, before anything moves', async () => {
    const mismatched = harness();
    mismatched.repo.versionFile = '0.60.999.0';
    await refusedAsync(promote(mismatched.deps, inputs()), /v0\.60\.361\.0's VERSION file says "0\.60\.999\.0"/);
    const missing = harness({ release: null });
    await refusedAsync(promote(missing.deps, inputs()), /v0\.60\.361\.0 has no published GitHub release \(.*404.*\); wait for release\.yml to publish it/);
    const draft = harness({ release: { draft: true } });
    await refusedAsync(promote(draft.deps, inputs()), /is still a draft/);
    for (const h of [mismatched, missing, draft]) expect(h.calls.filter(c => c.startsWith('tag -a') || c.startsWith('push'))).toEqual([]);
  });

  test('refuses when STABLE_SOAK_WORKFLOW is unset without reading the run', async () => {
    const h = harness({ soakWorkflow: '' });
    await refusedAsync(promote(h.deps, inputs()), /set the repository variable STABLE_SOAK_WORKFLOW/);
    expect(h.api.filter(p => p.includes('/actions/runs/'))).toEqual([]);
  });

  test('refuses a soak of a different tree, naming both trees and the run head', async () => {
    const h = harness({ run: { status: 'completed', conclusion: 'success', path: SOAK, head_sha: sha('c') } });
    await refusedAsync(promote(h.deps, inputs()), new RegExp(`soak ran tree ${sha('3')} \\(run head ${sha('c')}\\) but v0\\.60\\.361\\.0 is tree ${sha('2')}`));
    expect(h.calls.filter(c => c.startsWith('tag -a') || c.startsWith('push'))).toEqual([]);
  });

  test('a soak head missing locally is fetched; a different commit with the same tree passes', async () => {
    const repo: FakeRepo = { commits: { [sha('b')]: sha('2') }, tags: { 'v0.60.361.0': { commit: sha('b') } } };
    const h = harness({ repo, run: { status: 'completed', conclusion: 'success', path: SOAK, head_sha: sha('d') } });
    const git = h.deps.git;
    h.deps.git = async args => { if (args[0] === 'fetch') repo.commits[sha('d')] = sha('2'); return git(args); };
    await promote(h.deps, inputs());
    expect(h.calls).toContain(`fetch --no-tags origin ${sha('d')}`);
  });

  test('ordering through promote: same refuses, older refuses without rollback, rollback without a reason refuses, rollback with a reason moves stable back', async () => {
    const same = harness();
    same.repo.tags.stable = { commit: sha('b'), object: 'tagobj-stable-old' };
    await refusedAsync(promote(same.deps, inputs()), /already the stable release/);
    const older = () => { const h = harness({ run: { status: 'completed', conclusion: 'success', path: SOAK, head_sha: sha('a') } }); h.repo.tags.stable = { commit: sha('b'), object: 'tagobj-stable-old' }; return h; };
    await refusedAsync(promote(older().deps, inputs({ version: '0.60.360.0' })), /older than the current stable v0\.60\.361\.0/);
    await refusedAsync(promote(older().deps, inputs({ version: '0.60.360.0', rollback: true })), /A rollback needs a reason/);
    const back = older();
    const p = await promote(back.deps, inputs({ version: '0.60.360.0', rollback: true, reason: 'sync regression' }));
    expect(p).toMatchObject({ previous: '0.60.361.0', rollback: true, recordCreated: false });
    expect(back.repo.tags.stable!.commit).toBe(sha('a'));
    expect(back.repo.tags.stable!.message).toContain('rollback: true\nreason: sync regression\n');
    expect(back.calls.filter(c => c.startsWith('push'))).toEqual(['push --atomic --force-with-lease=refs/tags/stable:tagobj-stable-old origin refs/tags/stable:refs/tags/stable']);
    expect(back.repo.tags['stable-v0.60.360.0']!.object).toBe('tagobj-record-360');
  });

  test('an existing record tag refuses without rollback and is never re-created', async () => {
    const h = harness();
    h.repo.tags['stable-v0.60.361.0'] = { commit: sha('b'), object: 'tagobj-record-361' };
    await refusedAsync(promote(h.deps, inputs()), /stable-v0\.60\.361\.0 already exists, so v0\.60\.361\.0 was promoted before/);
    expect(h.calls.filter(c => c.startsWith('tag -a') || c.startsWith('push'))).toEqual([]);
    const moved = harness();
    moved.repo.tags['stable-v0.60.361.0'] = { commit: sha('c'), object: 'tagobj-record-361' };
    await refusedAsync(promote(moved.deps, inputs({ rollback: true, reason: 'restore' })), /points at c+, not the release commit b+/);
  });

  test('stable on a commit with no release tag refuses', async () => {
    const h = harness();
    h.repo.tags.stable = { commit: sha('c'), object: 'tagobj-stable-old' };
    await refusedAsync(promote(h.deps, inputs()), /carries no v<VERSION> release tag/);
  });

  test('a stable tag moved by someone else after it was read loses the lease', async () => {
    const h = harness();
    h.repo.remote!.stable = 'tagobj-someone-else';
    await refusedAsync(promote(h.deps, inputs()), /Moving the stable tag failed.*stale info/);
  });

  test('a failed push leaves the remote unchanged, so the re-run it asks for promotes cleanly', async () => {
    const h = harness();
    h.repo.failPush = true;
    await refusedAsync(promote(h.deps, inputs()), /nothing changed on the remote.*re-run this workflow/);
    expect(h.repo.remote).toEqual({ stable: 'tagobj-stable-old', 'stable-v0.60.360.0': 'tagobj-record-360' });
    const retry = harness();
    expect((await promote(retry.deps, inputs())).recordCreated).toBe(true);
  });
});

describe('promote against real git', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  test('creates the annotated tags, pushes them and peels stable to the release commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'promote-stable-'));
    try {
      const origin = join(dir, 'origin.git');
      const work = join(dir, 'work');
      git(dir, 'init', '-q', '--bare', origin);
      git(dir, 'init', '-q', work);
      git(work, 'config', 'user.name', 'test-bot');
      git(work, 'config', 'user.email', 'test-bot@example.com');
      git(work, 'config', 'commit.gpgsign', 'false');
      git(work, 'config', 'tag.gpgsign', 'false');
      git(work, 'remote', 'add', 'origin', origin);
      for (const version of ['1.0.0', '1.0.1']) {
        writeFileSync(join(work, 'VERSION'), `${version}\n`);
        git(work, 'add', 'VERSION');
        git(work, 'commit', '-q', '-m', `release ${version}`);
        git(work, 'tag', `v${version}`);
      }
      git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/master', '--tags');
      const head = git(work, 'rev-parse', 'HEAD');
      const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
      const run: SoakRun = { status: 'completed', conclusion: 'success', path: SOAK, head_sha: head };
      const deps = (version: string): PromoteDeps => ({
        ...processDeps(env, work), repo: REPO, actor: 'alice-example', soakWorkflow: 'soak.yml', now: () => NOW, log: () => {}, summary: () => {},
        ghApi: async path => (path.endsWith('/permission') ? { permission: 'admin', role_name: 'admin' }
          : path.includes('/releases/tags/') ? { draft: false }
          : { ...run, head_sha: git(work, 'rev-parse', `v${version}^{commit}`) }),
      });

      await promote(deps('1.0.0'), inputs({ version: '1.0.0' }));
      await promote(deps('1.0.1'), inputs({ version: '1.0.1' }));
      expect(git(work, 'ls-remote', origin, 'refs/tags/stable^{}').split('\t')[0]).toBe(head);
      expect(git(work, 'cat-file', '-t', 'refs/tags/stable')).toBe('tag');
      expect(git(work, 'cat-file', '-t', 'refs/tags/stable-v1.0.1')).toBe('tag');
      const body = git(work, 'for-each-ref', '--format=%(contents)', 'refs/tags/stable');
      expect(body).toContain('gbrain stable channel: v1.0.1\n\nversion: 1.0.1\n');
      expect(body).toContain('previous: 1.0.0\nrollback: false\nreason: -');
      const remote = git(work, 'ls-remote', '--tags', origin);
      expect(remote).toContain('refs/tags/stable-v1.0.0');
      expect(remote).toContain('refs/tags/stable-v1.0.1');

      const record = git(work, 'rev-parse', 'refs/tags/stable-v1.0.0');
      await promote(deps('1.0.0'), inputs({ version: '1.0.0', rollback: true, reason: 'regression' }));
      expect(git(work, 'ls-remote', origin, 'refs/tags/stable^{}').split('\t')[0]).toBe(git(work, 'rev-parse', 'v1.0.0^{commit}'));
      expect(git(work, 'ls-remote', origin, 'refs/tags/stable-v1.0.0').split('\t')[0]).toBe(record);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('promote-stable.yml', () => {
  const workflowYml = readFileSync(join(ROOT, '.github/workflows/promote-stable.yml'), 'utf8');
  const wf = load(workflowYml) as {
    on: Record<string, { inputs: Record<string, { required?: boolean; type: string; default?: unknown }> }>;
    concurrency: { group: string; 'cancel-in-progress': boolean };
    permissions: Record<string, string>;
    jobs: { promote: { steps: Array<{ uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string }> } };
  };

  test('dispatch only, with the decided inputs, one serial group and scoped permissions', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    const i = wf.on.workflow_dispatch!.inputs;
    expect(Object.keys(i)).toEqual(['version', 'soak_run_url', 'scoreboard_url', 'rollback', 'reason']);
    expect([i.version!.required, i.soak_run_url!.required, i.scoreboard_url!.required]).toEqual([true, true, false]);
    expect(i.rollback).toMatchObject({ type: 'boolean', default: false });
    expect(wf.concurrency).toEqual({ group: 'promote-stable', 'cancel-in-progress': false });
    expect(wf.permissions).toEqual({ contents: 'write', actions: 'read' });
  });

  test('inputs reach the script through env only; actions are pinned like release.yml; full history', () => {
    const steps = wf.jobs.promote.steps;
    const run = steps.find(s => s.run?.includes('scripts/promote-stable.ts'))!;
    expect(run.env).toMatchObject({
      GH_TOKEN: '${{ github.token }}', STABLE_SOAK_WORKFLOW: '${{ vars.STABLE_SOAK_WORKFLOW }}',
      PROMOTE_VERSION: '${{ inputs.version }}', PROMOTE_SOAK_RUN_URL: '${{ inputs.soak_run_url }}', PROMOTE_SCOREBOARD_URL: '${{ inputs.scoreboard_url }}',
      PROMOTE_ROLLBACK: '${{ inputs.rollback }}', PROMOTE_REASON: '${{ inputs.reason }}',
    });
    for (const s of steps) expect(s.run ?? '').not.toContain('${{');
    const releaseYml = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    for (const s of steps.filter(x => x.uses)) {
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
      expect(releaseYml).toContain(`uses: ${s.uses}`);
    }
    expect(steps[0]!.with).toMatchObject({ 'fetch-depth': 0 });
    expect(workflowYml).not.toMatch(/bun install|ci-bun-install/);
  });
});
