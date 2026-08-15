/**
 * `bootstrap repo` + `bootstrap attach` unit tests [G8, CX2-1, CX-P1.5].
 *
 * All gh/git interaction goes through a recording fake ExecRunner — no real
 * subprocesses, no network, no git commands against this repo. The e2e
 * lifecycle test (another task) exercises PATH-shimmed fakes; these pin the
 * library contracts: gate ordering, name-collision suffixing, the hard
 * privacy gate (false vs unavailable are DISTINCT), origin refusal vs attach
 * acceptance, template-state refusal, and remote-URL-keyed idempotency.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  createPrivateRepo,
  GITHUB_URL_PLACEHOLDER,
  parseGithubRemote,
  slugifyRepoName,
  type ExecResult,
  type ExecRunner,
  type RepoReceipt,
} from '../src/core/bootstrap/repo.ts';
import { attachWorkspace } from '../src/core/bootstrap/attach.ts';
import { BootstrapError } from '../src/core/bootstrap/lock.ts';
import { readReceipt, writeManifest, writeReceipt, type AgentManifest } from '../src/core/bootstrap/format.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Rule {
  /** Substring of the joined argv this rule answers. First match wins. */
  key: string;
  /** How many calls this rule answers before falling through (default ∞). */
  times?: number;
  code?: number;
  stdout?: string;
  stderr?: string;
}

function makeRunner(rules: Rule[]): { runner: ExecRunner; calls: string[][] } {
  const calls: string[][] = [];
  const state = rules.map((r) => ({ ...r, left: r.times ?? Infinity }));
  const runner: ExecRunner = async (argv: string[]): Promise<ExecResult> => {
    calls.push(argv);
    const joined = argv.join(' ');
    for (const r of state) {
      if (r.left > 0 && joined.includes(r.key)) {
        r.left--;
        return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

const INITIALIZED_MANIFEST: AgentManifest = {
  format_version: 1,
  initialized: true,
  agent_name: 'Test Agent',
  created_by: '0.0.0-test',
  created_at: '2026-01-01T00:00:00.000Z',
  source_id: 'workspace',
};

let ws: string;
let home: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'gbrain-bootstrap-ws-'));
  home = mkdtempSync(join(tmpdir(), 'gbrain-bootstrap-home-'));
  // writeReceipt requires the bootstrap/ subdir (render creates it in prod).
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  writeManifest(ws, { ...INITIALIZED_MANIFEST });
  writeFileSync(join(ws, 'GITHUB.md'), `This workspace is durably backed up to **${GITHUB_URL_PLACEHOLDER}**.\n`, 'utf8');
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Baseline happy-path rules; tests override by prepending / replacing. */
function happyRules(overrides: Rule[] = []): Rule[] {
  return [
    ...overrides,
    // Realistic modern `gh --version` output — Gate 2 parses this to decide
    // whether `--active` (added in cli/cli v2.57.0) is safe to pass.
    { key: 'gh --version', code: 0, stdout: 'gh version 2.97.0 (2026-07-31)\nhttps://github.com/cli/cli/releases/tag/v2.97.0\n' },
    { key: 'auth status', code: 0 },
    // First origin probe: no remote yet. After create, git reports the URL.
    { key: 'remote get-url origin', times: 1, code: 2, stderr: 'error: No such remote' },
    { key: 'rev-parse --git-dir', code: 1, stderr: 'fatal: not a git repository' },
    { key: 'gh api user', stdout: '{"login":"alice","id":123}\n' },
    // NOTE: the -2 probe rule must precede the base probe rule — substring
    // matching would otherwise answer the -2 probe with the base rule.
    { key: 'repo view alice/test-agent-workspace-2', code: 1, stderr: 'Could not resolve to a Repository' },
    { key: 'repo view alice/test-agent-workspace', code: 0, stdout: 'exists' },
    { key: 'repo create', code: 0 },
    { key: 'remote get-url origin', code: 0, stdout: 'https://github.com/alice/test-agent-workspace-2\n' },
    { key: '--jq .private', code: 0, stdout: 'true\n' },
  ];
}

async function expectBootstrapError(p: Promise<unknown>): Promise<BootstrapError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BootstrapError);
    return e as BootstrapError;
  }
  throw new Error('expected a BootstrapError, got success');
}

// ---------------------------------------------------------------------------
// createPrivateRepo
// ---------------------------------------------------------------------------

describe('createPrivateRepo', () => {
  test('create flow: name collision → -2 suffix, identity set, privacy verified, receipt + GITHUB.md updated', async () => {
    const { runner, calls } = makeRunner(happyRules());
    const result = await createPrivateRepo(ws, { runner, gbrainHomeDir: home });

    expect(result.name).toBe('test-agent-workspace-2');
    expect(result.url).toBe('https://github.com/alice/test-agent-workspace-2');
    expect(result.reused).toBe(false);

    // git init -b main ran (rev-parse said not-a-repo).
    expect(calls).toContainEqual(['git', '-C', ws, 'init', '-b', 'main']);
    // Repo-local identity from gh api user (login + noreply address).
    expect(calls).toContainEqual(['git', '-C', ws, 'config', 'user.name', 'alice']);
    expect(calls).toContainEqual(['git', '-C', ws, 'config', 'user.email', '123+alice@users.noreply.github.com']);
    // The create call is exact: private, sourced from the workspace, and
    // WITHOUT --push — nothing leaves this machine before the privacy verify [G8].
    expect(calls).toContainEqual(['gh', 'repo', 'create', 'test-agent-workspace-2', '--private', '--source', ws]);
    // Privacy verify hit the API for the created repo…
    expect(calls).toContainEqual(['gh', 'api', 'repos/alice/test-agent-workspace-2', '--jq', '.private']);
    // …and the first push ran only AFTER the verify passed (create → verify → push).
    const verifyIdx = calls.findIndex((c) => c.join(' ') === `gh api repos/alice/test-agent-workspace-2 --jq .private`);
    const pushIdx = calls.findIndex((c) => c.join(' ') === `git -C ${ws} push -u origin main`);
    expect(pushIdx).toBeGreaterThan(verifyIdx);

    // GITHUB.md placeholder replaced with the real URL.
    const githubMd = readFileSync(join(ws, 'GITHUB.md'), 'utf8');
    expect(githubMd).toContain(result.url);
    expect(githubMd).not.toContain(GITHUB_URL_PLACEHOLDER);

    // Receipt records the created repo URL (the idempotency key).
    const receipt = readReceipt(home) as RepoReceipt | null;
    expect(receipt).not.toBeNull();
    expect(receipt?.repo_url).toBe(result.url);
    expect(receipt?.brain_created_by_bootstrap).toBe(false);
  });

  test('[FIX3] freshly-rendered (uncommitted) workspace → stages + secret-scans + commits, then pushes content', async () => {
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'rev-parse --verify HEAD', code: 1, stderr: 'fatal: needed a single revision' },
        { key: 'status --porcelain', code: 0, stdout: ' M GITHUB.md\n?? agent.json\n' },
        { key: 'ls-files --cached --others', code: 0, stdout: 'agent.json\0GITHUB.md' },
        { key: 'diff --cached --name-only', code: 0, stdout: 'agent.json\nGITHUB.md\n' },
      ]),
    );
    const result = await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    expect(result.reused).toBe(false);

    // The commit was created before the push (no empty-remote push).
    expect(calls).toContainEqual(['git', '-C', ws, 'add', '-A']);
    expect(calls).toContainEqual(['git', '-C', ws, 'commit', '-m', 'gbrain: bootstrap workspace']);
    expect(calls).toContainEqual(['git', '-C', ws, 'push', '-u', 'origin', 'main']);

    const joined = calls.map((c) => c.join(' '));
    const verifyIdx = joined.indexOf('gh api repos/alice/test-agent-workspace-2 --jq .private');
    const commitIdx = joined.indexOf(`git -C ${ws} commit -m gbrain: bootstrap workspace`);
    const pushIdx = joined.indexOf(`git -C ${ws} push -u origin main`);
    expect(commitIdx).toBeGreaterThan(verifyIdx); // create → verify → commit → push
    expect(pushIdx).toBeGreaterThan(commitIdx);
  });

  test('[FIX3] a rendered workspace with NO files to commit refuses (REPO_CREATE_FAILED), never pushes empty', async () => {
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'rev-parse --verify HEAD', code: 1, stderr: 'fatal: needed a single revision' },
        { key: 'status --porcelain', code: 0, stdout: '' },
        { key: 'ls-files --cached --others', code: 0, stdout: '' },
        { key: 'diff --cached --name-only', code: 0, stdout: '' },
      ]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('REPO_CREATE_FAILED');
    expect(err.message).toContain('no files to commit');
    expect(calls.some((c) => c.join(' ').includes('push -u origin'))).toBe(false);
  });

  test('[FIX3] a secret in the workspace blocks the first commit + push (SECRET_SCAN_BLOCKED)', async () => {
    writeFileSync(join(ws, 'leak.md'), `token: sk-${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'}\n`, 'utf8');
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'rev-parse --verify HEAD', code: 1, stderr: 'fatal: needed a single revision' },
        { key: 'status --porcelain', code: 0, stdout: '?? leak.md\n' },
        { key: 'ls-files --cached --others', code: 0, stdout: 'leak.md' },
        { key: 'diff --cached --name-only', code: 0, stdout: 'leak.md\n' },
      ]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('SECRET_SCAN_BLOCKED');
    expect(err.message).not.toContain('sk-A1b2C3d4'); // value never surfaces
    expect(calls.some((c) => c.join(' ').includes('commit -m'))).toBe(false);
    expect(calls.some((c) => c.join(' ').includes('push -u origin'))).toBe(false);
  });

  test('[FIX4] origin swapped between the privacy verify and the push → ORIGIN_EXISTS, no push', async () => {
    const { runner, calls } = makeRunner([
      // origin probes, in call order: gate-4 (no remote) → postOrigin (created)
      // → assertOriginMatches (SWAPPED after verify).
      { key: 'remote get-url origin', times: 1, code: 2, stderr: 'error: No such remote' },
      { key: 'remote get-url origin', times: 1, code: 0, stdout: 'https://github.com/alice/test-agent-workspace-2\n' },
      { key: 'remote get-url origin', code: 0, stdout: 'https://github.com/mallory/swapped\n' },
      { key: 'gh --version', code: 0 },
      { key: 'auth status', code: 0 },
      { key: 'rev-parse --git-dir', code: 1, stderr: 'fatal: not a git repository' },
      { key: 'gh api user', stdout: '{"login":"alice","id":123}\n' },
      { key: 'repo view alice/test-agent-workspace-2', code: 1, stderr: 'Could not resolve to a Repository' },
      { key: 'repo view alice/test-agent-workspace', code: 0, stdout: 'exists' },
      { key: 'repo create', code: 0 },
      { key: '--jq .private', code: 0, stdout: 'true\n' },
    ]);
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('ORIGIN_EXISTS');
    expect(err.message).toContain('verified-private');
    expect(calls.some((c) => c.join(' ').includes('push -u origin'))).toBe(false); // nothing pushed
  });

  test('privacy verify says false → hard REPO_NOT_PRIVATE error', async () => {
    const { runner } = makeRunner(happyRules([{ key: '--jq .private', code: 0, stdout: 'false\n' }]));
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('REPO_NOT_PRIVATE');
  });

  test('privacy verify 500 → VERIFY_UNAVAILABLE (distinct from not-private), tells the user to re-run', async () => {
    const { runner } = makeRunner(happyRules([{ key: '--jq .private', code: 1, stderr: 'gh: HTTP 500 Internal Server Error' }]));
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('VERIFY_UNAVAILABLE');
    expect(err.code).not.toBe('REPO_NOT_PRIVATE');
    expect(err.message).toContain('re-run');
  });

  test('pre-existing origin bootstrap did not create → ORIGIN_EXISTS pointing at attach [G8]', async () => {
    const { runner, calls } = makeRunner(
      happyRules([{ key: 'remote get-url origin', code: 0, stdout: 'https://github.com/someone/else.git\n' }]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('ORIGIN_EXISTS');
    expect(err.message).toContain('bootstrap attach');
    // Refused before any create.
    expect(calls.some((c) => c.join(' ').includes('repo create'))).toBe(false);
  });

  test('template manifest → TEMPLATE_UNINITIALIZED [CX2-1]', async () => {
    writeManifest(ws, { ...INITIALIZED_MANIFEST, initialized: false });
    const { runner } = makeRunner(happyRules());
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('TEMPLATE_UNINITIALIZED');
    expect(err.message).toContain('bootstrap render');
  });

  test('absent manifest → NOT_A_WORKSPACE', async () => {
    rmSync(join(ws, 'agent.json'));
    const { runner } = makeRunner(happyRules());
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('NOT_A_WORKSPACE');
  });

  test('idempotent re-run keyed off the remote URL: adopts our origin, re-verifies, never creates', async () => {
    const url = 'https://github.com/alice/test-agent-workspace-2';
    writeReceipt(home, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Test Agent',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: '0.0.0-test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [],
      repo_url: url,
    } as RepoReceipt);
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'remote get-url origin', code: 0, stdout: `${url}\n` },
        // [FIX3] the remote already carries our branch → reused success is
        // honest; no re-push.
        { key: 'ls-remote --heads origin', code: 0, stdout: `deadbeef\trefs/heads/main\n` },
      ]),
    );
    const result = await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    expect(result.reused).toBe(true);
    expect(result.url).toBe(url);
    expect(result.name).toBe('test-agent-workspace-2');
    expect(calls.some((c) => c.join(' ').includes('repo create'))).toBe(false);
    // Privacy still verified on the re-run (couldn't-verify would refuse).
    expect(calls).toContainEqual(['gh', 'api', 'repos/alice/test-agent-workspace-2', '--jq', '.private']);
    // Remote already has content → no re-push.
    expect(calls.some((c) => c.join(' ').includes('push -u origin'))).toBe(false);
  });

  test('[FIX3] idempotent re-run whose prior push FAILED (empty remote) → completes the deferred push', async () => {
    const url = 'https://github.com/alice/test-agent-workspace-2';
    writeReceipt(home, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Test Agent',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: '0.0.0-test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [],
      repo_url: url,
    } as RepoReceipt);
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'remote get-url origin', code: 0, stdout: `${url}\n` },
        // Empty remote (prior push never landed): ls-remote returns nothing.
        { key: 'ls-remote --heads origin', code: 0, stdout: '' },
      ]),
    );
    const result = await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    expect(result.reused).toBe(true);
    expect(calls.some((c) => c.join(' ').includes('repo create'))).toBe(false);
    // The deferred push was completed rather than false-succeeding on empty.
    expect(calls).toContainEqual(['git', '-C', ws, 'push', '-u', 'origin', 'main']);
  });

  test('crash recovery: receipt for this workspace without repo_url adopts the origin and records it', async () => {
    const url = 'https://github.com/alice/test-agent-workspace';
    writeReceipt(home, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Test Agent',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: '0.0.0-test',
      brain_created_by_bootstrap: true,
      created_paths: [],
      registrations: [],
    });
    const { runner } = makeRunner(happyRules([{ key: 'remote get-url origin', code: 0, stdout: `${url}\n` }]));
    const result = await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    expect(result.reused).toBe(true);
    expect((readReceipt(home) as RepoReceipt).repo_url).toBe(url);
    // Adoption must not clobber the existing receipt's brain ownership.
    expect((readReceipt(home) as RepoReceipt).brain_created_by_bootstrap).toBe(true);
  });

  test('receipt url mismatch with origin → ORIGIN_EXISTS (never silently adopts a swapped remote)', async () => {
    writeReceipt(home, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Test Agent',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: '0.0.0-test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [],
      repo_url: 'https://github.com/alice/test-agent-workspace',
    } as RepoReceipt);
    const { runner } = makeRunner(
      happyRules([{ key: 'remote get-url origin', code: 0, stdout: 'https://github.com/mallory/swapped\n' }]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('ORIGIN_EXISTS');
  });

  test('gh missing → GH_MISSING with exit-code-2 semantics', async () => {
    const { runner } = makeRunner([{ key: 'gh --version', code: 127, stderr: 'command not found' }]);
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('GH_MISSING');
    expect(err.exitCode).toBe(2);
  });

  test('gh unauthenticated → GH_AUTH with exit-code-2 semantics', async () => {
    const { runner } = makeRunner([
      { key: 'gh --version', code: 0 },
      { key: 'auth status', code: 1, stderr: 'You are not logged into any GitHub hosts' },
    ]);
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('GH_AUTH');
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain('gh auth login');
  });

  test('Gate 2 on a modern gh checks only the active account on github.com — a stale, invalid non-active/other-host account must not false-block bootstrap', async () => {
    // `gh auth status` (no flags) aggregates every registered account on
    // every host and exits 1 if ANY one of them is invalid, even if the
    // active github.com account (what `gh`/`git` actually use for this
    // flow) is perfectly healthy — confirmed against cli/cli's status.go
    // (statusRun: the non-active-account loop at `if opts.Active { continue }`
    // is skipped entirely under `--active`, so only the active account's
    // entry can contribute to the exit code; `--hostname` narrows Hosts()
    // to the given host before that loop even starts). Gate 2 must pass
    // both flags on a `gh` that supports them — this test pins the exact
    // argv so a regression back to the unscoped bare form is caught.
    const { runner, calls } = makeRunner(happyRules());
    await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    const authCall = calls.find((c) => c[0] === 'gh' && c[1] === 'auth' && c[2] === 'status');
    expect(authCall).toEqual(['gh', 'auth', 'status', '--active', '--hostname', 'github.com']);
  });

  test('Gate 2 on a pre-2.57.0 gh (no `--active` support) falls back to the host-scoped bare form instead of hard-failing on an unknown flag', async () => {
    // `--active` was added in cli/cli v2.57.0 (confirmed: present in the
    // v2.57.0 status.go, absent in v2.56.0 and earlier). Passing it to an
    // older `gh` would make the WHOLE command fail on an unrecognized flag —
    // a false GH_AUTH for a perfectly authenticated user. Gate 2 must detect
    // this from the `gh --version` output already captured in Gate 1 and
    // drop only `--active` (keeping `--hostname`, which has existed since
    // gh's early versions). Pinned right at the boundary (2.56.0, one minor
    // below the flag's introduction) rather than an arbitrarily old version,
    // so an off-by-one in the `>=` comparison would fail this test.
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'gh --version', code: 0, stdout: 'gh version 2.56.0 (2024-08-01)\n' },
      ]),
    );
    await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    const authCall = calls.find((c) => c[0] === 'gh' && c[1] === 'auth' && c[2] === 'status');
    expect(authCall).toEqual(['gh', 'auth', 'status', '--hostname', 'github.com']);
  });

  test('Gate 2 on exactly gh 2.57.0 (the version that introduced `--active`) uses the enhanced form', async () => {
    const { runner, calls } = makeRunner(
      happyRules([{ key: 'gh --version', code: 0, stdout: 'gh version 2.57.0 (2024-09-11)\n' }]),
    );
    await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    const authCall = calls.find((c) => c[0] === 'gh' && c[1] === 'auth' && c[2] === 'status');
    expect(authCall).toEqual(['gh', 'auth', 'status', '--active', '--hostname', 'github.com']);
  });

  test('Gate 2 with an unparseable `gh --version` falls back to the host-scoped bare form (fail conservative, not assume `--active` support)', async () => {
    const { runner, calls } = makeRunner(
      happyRules([{ key: 'gh --version', code: 0, stdout: 'not a recognizable version string\n' }]),
    );
    await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    const authCall = calls.find((c) => c[0] === 'gh' && c[1] === 'auth' && c[2] === 'status');
    expect(authCall).toEqual(['gh', 'auth', 'status', '--hostname', 'github.com']);
  });

  // ── create-repo-first adoption (the human made the repo, opened it in Claude
  //    Code / Codex, then ran bootstrap) + hardening of the adoption path ──────

  /** The receipt `render` writes: this workspace, no repo_url yet. */
  function renderReceiptNoUrl(): void {
    writeReceipt(home, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Test Agent',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: '0.0.0-test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [],
    });
  }

  test("create-repo-first: adopts an EMPTY private user-owned repo (disposition 'adopted', sets identity, pushes, records after push)", async () => {
    const url = 'https://github.com/alice/my-brain';
    renderReceiptNoUrl();
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'remote get-url origin', code: 0, stdout: `${url}\n` },
        // assertAdoptableOrigin: all-refs ls-remote → empty (freshly created repo).
        { key: 'ls-remote origin refs/heads/main', code: 0, stdout: '' },
        { key: 'ls-remote origin', code: 0, stdout: '' },
        // ensureRemoteHasWorkspace: --heads empty → first push.
        { key: 'ls-remote --heads origin', code: 0, stdout: '' },
        // Freshly rendered, uncommitted → stage + scan + commit, then push.
        { key: 'rev-parse --verify HEAD', code: 1, stderr: 'fatal: needed a single revision' },
        { key: 'status --porcelain', code: 0, stdout: ' M GITHUB.md\n' },
        { key: 'ls-files --cached --others', code: 0, stdout: 'GITHUB.md' },
        { key: 'diff --cached --name-only', code: 0, stdout: 'GITHUB.md\n' },
        { key: '--jq .private', code: 0, stdout: 'true\n' },
      ]),
    );
    const result = await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    expect(result.disposition).toBe('adopted');
    expect(result.reused).toBe(true);
    expect(result.url).toBe(url);
    // Adopted the human's repo — never created one.
    expect(calls.some((c) => c.join(' ').includes('repo create'))).toBe(false);
    // Repo-local identity set on the ADOPTION path (fresh-machine commit safety).
    expect(calls).toContainEqual(['git', '-C', ws, 'config', 'user.name', 'alice']);
    expect(calls).toContainEqual(['git', '-C', ws, 'config', 'user.email', '123+alice@users.noreply.github.com']);
    // Workspace pushed, and repo_url recorded AFTER the push.
    expect(calls).toContainEqual(['git', '-C', ws, 'push', '-u', 'origin', 'main']);
    expect((readReceipt(home) as RepoReceipt).repo_url).toBe(url);
  });

  test('[CRITICAL] create-repo-first pointed at a NON-empty repo → ORIGIN_NOT_EMPTY, never a silent no-op', async () => {
    const url = 'https://github.com/alice/existing-project';
    renderReceiptNoUrl();
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'remote get-url origin', code: 0, stdout: `${url}\n` },
        { key: 'ls-remote origin refs/heads/main', code: 0, stdout: '' },
        // Non-empty remote (foreign content) + no local commit → foreign, refuse.
        { key: 'ls-remote origin', code: 0, stdout: 'cafe1234\trefs/heads/main\n' },
        { key: 'rev-parse --verify HEAD', code: 1, stderr: 'fatal: needed a single revision' },
      ]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('ORIGIN_NOT_EMPTY');
    expect(err.message).toContain('EMPTY');
    // No silent no-op: nothing pushed, repo_url never recorded.
    expect(calls.some((c) => c.join(' ').includes('push -u origin'))).toBe(false);
    expect((readReceipt(home) as RepoReceipt).repo_url).toBeUndefined();
  });

  test('[CRITICAL] non-empty repo with NO pending marker → ORIGIN_NOT_EMPTY (never adopt a user project from a git-ancestry guess)', async () => {
    // Even if the remote HEAD looks like ours, without a pending_repo_url proof
    // we cannot distinguish our push from a user's existing project → refuse.
    const url = 'https://github.com/alice/existing-project';
    renderReceiptNoUrl();
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'remote get-url origin', code: 0, stdout: `${url}\n` },
        { key: 'ls-remote origin', code: 0, stdout: 'abc123\trefs/heads/main\n' },
      ]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('ORIGIN_NOT_EMPTY');
    expect(calls.some((c) => c.join(' ').includes('push -u origin'))).toBe(false);
    expect((readReceipt(home) as RepoReceipt).repo_url).toBeUndefined();
  });

  test('interrupted push recovery: non-empty remote matching pending_repo_url → adopts (resumes)', async () => {
    const url = 'https://github.com/alice/my-brain';
    // A prior run pushed but crashed before recording repo_url — pending proves ours.
    writeReceipt(home, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Test Agent',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: '0.0.0-test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [],
      pending_repo_url: url,
    } as RepoReceipt);
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'remote get-url origin', code: 0, stdout: `${url}\n` },
        // Remote already carries our branch (the interrupted push landed) → no re-push.
        { key: 'ls-remote --heads origin', code: 0, stdout: 'abc123\trefs/heads/main\n' },
        { key: '--jq .private', code: 0, stdout: 'true\n' },
      ]),
    );
    const result = await createPrivateRepo(ws, { runner, gbrainHomeDir: home });
    expect(result.disposition).toBe('adopted');
    // pending bypassed the emptiness check — never probed all-refs ls-remote.
    expect(calls.some((c) => c.join(' ') === `git -C ${ws} ls-remote origin`)).toBe(false);
    const receipt = readReceipt(home) as RepoReceipt;
    expect(receipt.repo_url).toBe(url);
    expect(receipt.pending_repo_url).toBeUndefined(); // cleared on record
  });

  test('create-repo-first under an ORG (owner != login) → ORIGIN_EXISTS (personal-account only, D2=A)', async () => {
    const url = 'https://github.com/acme-org/brain';
    renderReceiptNoUrl();
    const { runner, calls } = makeRunner(
      happyRules([{ key: 'remote get-url origin', code: 0, stdout: `${url}\n` }]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('ORIGIN_EXISTS');
    // Ownership fails first — never even probes the remote for emptiness.
    expect(calls.some((c) => c.join(' ') === `git -C ${ws} ls-remote origin`)).toBe(false);
  });

  test('create-repo-first pointed at a PUBLIC repo → REPO_NOT_PRIVATE', async () => {
    const url = 'https://github.com/alice/public-brain';
    renderReceiptNoUrl();
    const { runner } = makeRunner(
      happyRules([
        { key: 'remote get-url origin', code: 0, stdout: `${url}\n` },
        { key: 'ls-remote origin', code: 0, stdout: '' }, // empty → adoptable
        { key: '--jq .private', code: 0, stdout: 'false\n' },
      ]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('REPO_NOT_PRIVATE');
  });

  test("create-repo-first when the origin can't be listed → REMOTE_CHECK_FAILED, nothing pushed", async () => {
    const url = 'https://github.com/alice/my-brain';
    renderReceiptNoUrl();
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'remote get-url origin', code: 0, stdout: `${url}\n` },
        { key: 'ls-remote origin', code: 1, stderr: 'fatal: could not read from remote repository' },
      ]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('REMOTE_CHECK_FAILED');
    expect(calls.some((c) => c.join(' ').includes('push -u origin'))).toBe(false);
  });

  test('adoption push fails → repo_url NOT recorded (status stays resumable) [finding 3]', async () => {
    const url = 'https://github.com/alice/my-brain';
    renderReceiptNoUrl();
    const { runner } = makeRunner(
      happyRules([
        { key: 'remote get-url origin', code: 0, stdout: `${url}\n` },
        { key: 'ls-remote origin', code: 0, stdout: '' },
        { key: 'ls-remote --heads origin', code: 0, stdout: '' },
        { key: 'rev-parse --verify HEAD', code: 1, stderr: 'fatal: needed a single revision' },
        { key: 'status --porcelain', code: 0, stdout: ' M GITHUB.md\n' },
        { key: 'ls-files --cached --others', code: 0, stdout: 'GITHUB.md' },
        { key: 'diff --cached --name-only', code: 0, stdout: 'GITHUB.md\n' },
        { key: '--jq .private', code: 0, stdout: 'true\n' },
        { key: 'push -u origin', code: 1, stderr: 'fatal: unable to access' },
      ]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('REPO_CREATE_FAILED');
    // repo_url must NOT be recorded on push failure (else status false-reports done).
    expect((readReceipt(home) as RepoReceipt).repo_url).toBeUndefined();
  });

  test('adoption secret-scans the workspace before pushing (SECRET_SCAN_BLOCKED) [finding 4]', async () => {
    const url = 'https://github.com/alice/my-brain';
    renderReceiptNoUrl();
    writeFileSync(join(ws, 'leak.md'), `token: sk-${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'}\n`, 'utf8');
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'remote get-url origin', code: 0, stdout: `${url}\n` },
        { key: 'ls-remote origin', code: 0, stdout: '' },
        { key: 'ls-remote --heads origin', code: 0, stdout: '' },
        { key: 'rev-parse --verify HEAD', code: 1, stderr: 'fatal: needed a single revision' },
        { key: 'status --porcelain', code: 0, stdout: '?? leak.md\n' },
        { key: 'ls-files --cached --others', code: 0, stdout: 'leak.md' },
        { key: '--jq .private', code: 0, stdout: 'true\n' },
      ]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('SECRET_SCAN_BLOCKED');
    expect(calls.some((c) => c.join(' ').includes('push -u origin'))).toBe(false);
  });

  test('[finding 4] a CLEAN committed tree is still secret-scanned before the deferred push', async () => {
    const url = 'https://github.com/alice/test-agent-workspace-2';
    writeReceipt(home, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Test Agent',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: '0.0.0-test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [],
      repo_url: url,
    } as RepoReceipt);
    writeFileSync(join(ws, 'secrets.md'), `token: sk-${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'}\n`, 'utf8');
    const { runner, calls } = makeRunner(
      happyRules([
        { key: 'remote get-url origin', code: 0, stdout: `${url}\n` },
        { key: 'ls-remote --heads origin', code: 0, stdout: '' }, // empty → deferred-push path
        { key: 'rev-parse --verify HEAD', code: 0, stdout: 'abc\n' }, // has a commit
        { key: 'status --porcelain', code: 0, stdout: '' }, // clean tree
        { key: 'ls-files -z', code: 0, stdout: 'secrets.md' }, // committed tree to scan
      ]),
    );
    const err = await expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home }));
    expect(err.code).toBe('SECRET_SCAN_BLOCKED');
    expect(calls.some((c) => c.join(' ').includes('push -u origin'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// attachWorkspace
// ---------------------------------------------------------------------------

describe('attachWorkspace', () => {
  test('accepts an initialized clone: writes the receipt, returns the 4-step todo list', () => {
    const result = attachWorkspace(ws, { gbrainHomeDir: home, harness: 'codex', createdBy: '0.0.0-test' });
    expect(result.manifest.agent_name).toBe('Test Agent');
    expect(result.steps.map((s) => s.kind)).toEqual(['register_source', 'hooks_repair', 'mcp_add', 'verify']);
    const receipt = readReceipt(home);
    expect(receipt).not.toBeNull();
    expect(receipt?.brain_created_by_bootstrap).toBe(false); // attach adopts, never claims [CX2-12]
    expect(receipt?.source_id).toBe('workspace');
    expect(receipt?.created_paths).toEqual([]);
  });

  test('template state → TEMPLATE_UNINITIALIZED pointing at render [CX2-1]', () => {
    writeManifest(ws, { ...INITIALIZED_MANIFEST, initialized: false });
    try {
      attachWorkspace(ws, { gbrainHomeDir: home });
      throw new Error('expected refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(BootstrapError);
      expect((e as BootstrapError).code).toBe('TEMPLATE_UNINITIALIZED');
      expect((e as BootstrapError).message).toContain('bootstrap render');
    }
  });

  test('absent manifest → NOT_A_WORKSPACE', () => {
    rmSync(join(ws, 'agent.json'));
    try {
      attachWorkspace(ws, { gbrainHomeDir: home });
      throw new Error('expected refusal');
    } catch (e) {
      expect((e as BootstrapError).code).toBe('NOT_A_WORKSPACE');
    }
  });

  test('conflict-markered manifest → MANIFEST_INVALID, agent-readable [G12]', () => {
    writeFileSync(join(ws, 'agent.json'), '<<<<<<< HEAD\n{}\n>>>>>>> theirs\n', 'utf8');
    try {
      attachWorkspace(ws, { gbrainHomeDir: home });
      throw new Error('expected refusal');
    } catch (e) {
      expect((e as BootstrapError).code).toBe('MANIFEST_INVALID');
      expect((e as BootstrapError).message).toContain('conflict');
    }
  });

  test('re-attach on the same machine preserves brain ownership + created_paths', () => {
    const hooked = join(home, 'integrations', 'hooks');
    mkdirSync(hooked, { recursive: true });
    writeReceipt(home, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Test Agent',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: '0.0.0-test',
      brain_created_by_bootstrap: true,
      created_paths: [hooked],
      registrations: [{ host: 'claude-code', scope: 'project' }],
    });
    attachWorkspace(ws, { gbrainHomeDir: home });
    const receipt = readReceipt(home);
    expect(receipt?.brain_created_by_bootstrap).toBe(true);
    expect(receipt?.created_paths).toEqual([hooked]);
    expect(receipt?.registrations).toEqual([{ host: 'claude-code', scope: 'project' }]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('repo helpers', () => {
  test('slugifyRepoName', () => {
    expect(slugifyRepoName('Test Agent')).toBe('test-agent');
    expect(slugifyRepoName('  Ada :: Lovelace!! ')).toBe('ada-lovelace');
    expect(slugifyRepoName('***')).toBe('agent');
  });

  test('parseGithubRemote handles https and ssh forms', () => {
    expect(parseGithubRemote('https://github.com/alice/repo')).toEqual({ owner: 'alice', name: 'repo' });
    expect(parseGithubRemote('https://github.com/alice/repo.git')).toEqual({ owner: 'alice', name: 'repo' });
    expect(parseGithubRemote('git@github.com:alice/repo.git')).toEqual({ owner: 'alice', name: 'repo' });
    expect(parseGithubRemote('https://gitlab.com/alice/repo')).toBeNull();
  });
});

// ── cloud-sandbox create guard [D-cloud] ────────────────────────────────────
//
// A repo created from inside a proxied cloud session is never attached to the
// session's GitHub scope — REST verification 403s and pushes are denied — so
// createPrivateRepo must fail FAST with the flow that works (create outside,
// open the session ON the repo, `gbrain bootstrap attach`) instead of leaving
// a half-created, unpushable repo behind.

describe('createPrivateRepo cloud-sandbox guard [CLOUD_SANDBOX_REPO]', () => {
  test('cloud sandbox + no existing origin → CLOUD_SANDBOX_REPO before any create call', async () => {
    const { runner, calls } = makeRunner(happyRules());
    const err = await withEnv({ CLAUDE_CODE_REMOTE: 'true' }, () =>
      expectBootstrapError(createPrivateRepo(ws, { runner, gbrainHomeDir: home })),
    );
    expect(err.code).toBe('CLOUD_SANDBOX_REPO');
    expect(err.message).toContain('gbrain bootstrap attach');
    // No repo was created and nothing was pushed.
    expect(calls.some((c) => c.join(' ').includes('repo create'))).toBe(false);
    expect(calls.some((c) => c.join(' ').includes('push'))).toBe(false);
  });

  test('local env: the same rules create normally (guard is cloud-only)', async () => {
    const { runner, calls } = makeRunner(happyRules());
    const result = await withEnv({ CLAUDE_CODE_REMOTE: undefined }, () =>
      createPrivateRepo(ws, { runner, gbrainHomeDir: home }),
    );
    expect(result.disposition).toBe('created');
    expect(calls.some((c) => c.join(' ').includes('repo create'))).toBe(true);
  });
});
