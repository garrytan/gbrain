/**
 * What a failed managed Git step keeps and how `gbrain sync status` turns it into a hold and a fix (git-diagnostic.ts,
 * git-commit-holds.ts, effect-git.ts pushPhaseFailure).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a failed git step keeps only its phase, a plain step name and one reason code from the closed list
 *    GIT_REASONS (GCH-01); git's stderr is classified in memory and never stored or printed, and a stored diagnostic an
 *    older release wrote with git's own line reads back without it. Every checkout path placed in a command the user is
 *    told to run is shell-quoted (GCH-02). The checkout a hold names is the owner host's binding, and the identity
 *    question is offered only when this host owns the worktree (GCH-05). Holds go most urgent first (GCH-06). The line
 *    says commits are held, not "not made", because a group can mix an older push failure (GCH-07). An effect recorded
 *    before steps were kept reads "step not recorded"; a git step that did not finish during the push is a push hold.
 *  - Regression: a token, private path or URL password stored or printed; a path with a space or a shell metacharacter
 *    split or executed when pasted; an identity edit offered on a host that does not make the commits, or on the wrong
 *    binding; a retrying hold listed before the one a person must answer.
 *  - Why existing coverage misses it: the sanitizer tests fed only inputs its denylist knew.
 *  - Seam: the hold reader takes a stub engine answering listGitPushHoldRows, with its host id given by setEngineHostId;
 *    everything else is the real code. Commands are parsed by a real `sh`.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gitDiagnosticModule from '../src/core/persistence/git-diagnostic.ts';
import { gitCommitHoldLine, readGitCommitHolds } from '../src/core/persistence/git-commit-holds.ts';
import { gitFailure, pushPhaseFailure } from '../src/core/persistence/effect-git.ts';
import { setEngineHostId } from '../src/core/persistence/identity.ts';
import { readGitPushHolds } from '../src/core/persistence/git-push-holds.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Read off the module namespace, not named imports, so this file loads on a tree without the reason list (bf547a9497)
// and each finding's test fails on its own assertion there, not all of them on one missing export.
const { gitDiagnostic, gitDiagnosticOf } = gitDiagnosticModule;
const GIT_REASONS = gitDiagnosticModule.GIT_REASONS ?? [];
const gitReason = (stderr: string | undefined) => gitDiagnosticModule.gitReason(stderr);

/** Inputs a denylist sanitizer let through unchanged (the second-model review of bf547a9497), and other secret carriers. */
const LEAKS = [
  ['error: filter failed: sk_live_8fJ2kQ9xZ7vP3mN1', ['sk_live_8fJ2kQ9xZ7vP3mN1']],
  ['fatal: unable to read /home/alice-example/.ssh/id_ed25519', ['alice-example', 'id_ed25519', '.ssh']],
  ['fatal: https://bob:pa/ss@example.com/repo', ['bob', 'pa/ss', 'ss@example']],
  ['error: "password": "ab\\"cdsecret123"', ['cdsecret123']],
  ['fatal: credential helper printed username=bob password=hunter2value', ['hunter2value', 'bob']],
  ["fatal: unable to access 'https://alice-example:hunter2tokenvalue@git.example.invalid/acme.git?access_token=qq9secret': Authorization: Bearer zz8secretbearer", ['hunter2tokenvalue', 'qq9secret', 'zz8secretbearer', 'alice-example']],
] as const;

describe('GCH-01: a diagnostic keeps a step and a reason code, never git\'s words', () => {
  test('each leaking input becomes exactly { phase, step, reason } with no secret anywhere', () => {
    for (const [stderr, secrets] of LEAKS) {
      const diag = gitDiagnostic('commit', 'add', stderr);
      expect(Object.keys(diag).sort()).toEqual(['phase', 'reason', 'step']);
      expect(diag.phase).toBe('commit');
      expect(diag.step).toBe('add');
      expect(GIT_REASONS).toContain(diag.reason);
      for (const secret of secrets) expect(JSON.stringify(diag)).not.toContain(secret);
    }
    expect(gitDiagnostic('commit', 'add', LEAKS[0][0])).toEqual({ phase: 'commit', step: 'add', reason: 'filter_failed' });
    expect(gitDiagnostic('commit', 'add', LEAKS[1][0])).toEqual({ phase: 'commit', step: 'add', reason: 'other' });
    expect(gitDiagnostic('push', 'push', LEAKS[2][0])).toEqual({ phase: 'push', step: 'push', reason: 'other' });
  });

  test('the classifier names the common causes from a closed list', () => {
    expect(gitReason('Author identity unknown\n\n*** Please tell me who you are.\n')).toBe('identity_missing');
    expect(gitReason('fatal: no email was given and auto-detection is disabled')).toBe('identity_missing');
    expect(gitReason('git commit-tree did not finish within 30 seconds or could not start')).toBe('timeout');
    expect(gitReason("fatal: Unable to create '/brains/w/.git/index.lock': File exists.")).toBe('index_locked');
    expect(gitReason('error: unable to write file: No space left on device')).toBe('disk_full');
    expect(gitReason('error: insufficient permission for adding an object to repository database .git/objects')).toBe('permission_denied');
    expect(gitReason('error: external filter \'/x/clean\' failed 1')).toBe('filter_failed');
    expect(gitReason('fatal: not a git repository (or any of the parent directories): .git')).toBe('not_a_repository');
    expect(gitReason('fatal: bad object HEAD')).toBe('object_missing');
    expect(gitReason('fatal: Authentication failed for \'https://git.example.invalid/acme.git/\'')).toBe('auth_failed');
    expect(gitReason('fatal: Could not read from remote repository.')).toBe('remote_unreachable');
    expect(gitReason(' ! [remote rejected] main -> main (pre-receive hook declined)')).toBe('hook_rejected');
    expect(gitReason('something git never says')).toBe('other');
    expect(gitReason(undefined)).toBe('other');
  });

  test('a step that is not a plain subcommand name is stored as git', () => {
    expect(gitDiagnostic('commit', 'add; rm -rf /', 'x').step).toBe('git');
    expect(gitDiagnostic('commit', 'commit-tree', 'x').step).toBe('commit-tree');
  });

  test('an identity failure carries identity; a push-phase git_unavailable becomes a push hold with its reason', () => {
    expect(gitDiagnostic('commit', 'commit-tree', 'Author identity unknown')).toEqual({ phase: 'commit', step: 'commit-tree', reason: 'identity_missing', identity: true });
    const failure = gitFailure('Cannot commit.', 'git commit failed.', gitDiagnostic('commit', 'commit-tree', 'Author identity unknown'));
    expect(gitDiagnosticOf(failure)?.step).toBe('commit-tree');
    const timeout = gitFailure('Git execution did not finish within its bounded attempt.', 'timed out', gitDiagnostic('commit', 'ls-remote', 'git ls-remote did not finish within 30 seconds or could not start'));
    const pushed = pushPhaseFailure(timeout) as OperationError;
    expect(pushed.code).toBe('git_push_unavailable');
    expect(gitDiagnosticOf(pushed)).toEqual({ phase: 'push', step: 'ls-remote', reason: 'timeout' });
    const other = new OperationError('writer_busy', 'busy', 'wait');
    expect(pushPhaseFailure(other)).toBe(other);
  });
});

const HOST = 'a0000000-0000-4000-8000-0000000000a1';
const OTHER = 'b0000000-0000-4000-8000-0000000000b2';
const row = (over: Record<string, unknown>) => ({ source_id: 'work', root: '/brains/work', former_worktree: false, retrying: 0, parked: 1, codes: ['git_unavailable'],
  oldest_at: new Date('2026-11-26T00:00:00Z'), last_error: null, worktree_id: 'c0000000-0000-4000-8000-0000000000c3', owner_host_id: HOST, owner_root: '/brains/work', ...over });
const holds = async (...rows: Array<Record<string, unknown>>) => {
  const engine = { listGitPushHoldRows: async (codes: string[]) => { expect(codes).toEqual(['git_unavailable']); return rows; } } as unknown as BrainEngine;
  setEngineHostId(engine, HOST);
  return readGitCommitHolds(engine);
};
const identity = { phase: 'commit', step: 'commit-tree', reason: 'identity_missing', identity: true } as const;

describe('GCH-01: a stored diagnostic reads back in a fixed shape', () => {
  test('git\'s own line an older release stored is dropped, never printed', async () => {
    const [hold] = await holds(row({ last_error: { line: 'error: filter failed: sk_live_8fJ2kQ9xZ7vP3mN1', step: 'add', phase: 'commit' } }));
    expect(hold!.last_error).toEqual({ phase: 'commit', step: 'add', reason: 'other' });
    const printed = JSON.stringify(hold) + gitCommitHoldLine(hold!);
    expect(printed).not.toContain('sk_live_');
    const [legacyIdentity] = await holds(row({ last_error: { line: 'Author identity unknown', step: 'commit-tree', phase: 'commit', identity: true } }));
    expect(legacyIdentity!.last_error).toEqual(identity);
    expect(Object.keys(legacyIdentity!.last_error!)).toEqual(['phase', 'step', 'reason', 'identity']);
    const [unlisted] = await holds(row({ last_error: { phase: 'commit', step: '$(boom)', reason: 'made up' } }));
    expect(unlisted!.last_error).toEqual({ phase: 'commit', step: 'git', reason: 'other' });
  });
});

describe('F1 (slice 4): a push hold carries the same fixed-shape diagnostic', () => {
  const pushHolds = async (...rows: Array<Record<string, unknown>>) => {
    const engine = { listGitPushHoldRows: async () => rows } as unknown as BrainEngine;
    setEngineHostId(engine, HOST);
    return readGitPushHolds(engine);
  };
  test('a classified push failure keeps its step and reason; a legacy line is dropped; a row with none reads null', async () => {
    const [classified] = await pushHolds(row({ codes: ['push_unconfirmed'], root: null, last_error: { reason: 'auth_failed', step: 'commit-push', phase: 'push' } }));
    expect(classified!.last_error).toEqual({ phase: 'push', step: 'commit-push', reason: 'auth_failed' });
    expect(Object.keys(classified!.last_error!)).toEqual(['phase', 'step', 'reason']);
    const [legacy] = await pushHolds(row({ codes: ['git_push_unavailable'], root: null,
      last_error: { phase: 'push', step: 'push', line: "fatal: unable to access 'https://alice-example:pa/ss@git.example.invalid/' sk_live_8fJ2kQ9xZ7vP3mN1" } }));
    expect(legacy!.last_error).toEqual({ phase: 'push', step: 'push', reason: 'other' });
    expect(JSON.stringify(legacy)).not.toMatch(/sk_live_|pa\/ss|alice-example|git\.example/);
    const [none] = await pushHolds(row({ codes: ['git_push_unavailable'], root: null, last_error: null }));
    expect(none!.last_error).toBeNull();
  });
});

/** The argv a POSIX shell builds from `command`, run in an empty directory so a substitution that runs leaves a file. */
function shellArgv(command: string): { argv: string[]; ran: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-shell-quote-'));
  try {
    const out = execFileSync('sh', ['-c', `set -- ${command}; printf '%s\\0' "$@"`], { cwd: dir, encoding: 'utf8' });
    return { argv: out.split('\0').slice(0, -1), ran: existsSync(join(dir, 'x')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('GCH-02: every checkout path in a command the user runs is shell-quoted', () => {
  const roots = ['/brains/my work', '/brains/$(touch x)', "/brains/o'neil `touch x`"];

  test('the identity commands in user_message keep the path whole and run nothing', async () => {
    for (const root of roots) {
      const [hold] = await holds(row({ root, owner_root: root, last_error: identity }));
      expect(hold!.fix.argv).toEqual(['git', '-C', root, 'config', '--show-origin', '--get-regexp', '^user\\.']);
      const commands = /Set them with (git -C .*? config user\.name "<name>") and (git -C .*? config user\.email "<email>");/.exec(hold!.fix.user_message ?? '');
      expect(commands).not.toBeNull();
      expect(shellArgv(commands![1]!)).toEqual({ argv: ['git', '-C', root, 'config', 'user.name', '<name>'], ran: false });
      expect(shellArgv(commands![2]!)).toEqual({ argv: ['git', '-C', root, 'config', 'user.email', '<email>'], ran: false });
    }
  });

  test('the parked fix\'s git status command keeps the path whole and runs nothing', async () => {
    for (const root of roots) {
      const [hold] = await holds(row({ root, owner_root: root, last_error: { phase: 'commit', step: 'add', reason: 'filter_failed' } }));
      const command = /\((git -C .*? status)\b/.exec(hold!.fix.why ?? '');
      expect(command).not.toBeNull();
      expect(shellArgv(command![1]!)).toEqual({ argv: ['git', '-C', root, 'status'], ran: false });
    }
  });
});

describe('GCH-05: the identity question goes to the host that makes the commits, about its own checkout', () => {
  test('this host owns: the owner\'s binding is the root, not the lexically first one', async () => {
    const [hold] = await holds(row({ root: '/brains/aaa-other-host', owner_root: '/brains/work-owner', last_error: identity }));
    expect(hold!.owner_host).toBe('this_host');
    expect(hold!.root).toBe('/brains/work-owner');
    expect(hold!.fix).toMatchObject({ ask_user: true, actor: 'user', argv: ['git', '-C', '/brains/work-owner', 'config', '--show-origin', '--get-regexp', '^user\\.'] });
    expect(hold!.fix.user_message).toContain('gbrain sources writer retry-effects work --parked-code git_unavailable --dry-run');
  });

  test('another host owns: no local identity edit; the fix says to set it on the owner host', async () => {
    const [hold] = await holds(row({ root: '/brains/here', owner_host_id: OTHER, owner_root: '/brains/there', last_error: identity }));
    expect(hold!.owner_host).toBe('other_host');
    expect(hold!.fix.ask_user).toBeUndefined();
    expect(hold!.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'retry-effects', 'work', '--parked-code', 'git_unavailable', '--dry-run']);
    expect(hold!.fix.why).toContain('set it on the owner host (not this one)');
    const [retrying] = await holds(row({ retrying: 1, parked: 0, owner_host_id: OTHER, last_error: identity }));
    expect(retrying!.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'work', '--json']);
    expect(retrying!.fix.why).toContain('set it on the owner host');
  });

  test('no owner recorded, or no binding on any host: no local identity edit', async () => {
    const [unowned] = await holds(row({ owner_host_id: null, owner_root: null, last_error: identity }));
    expect(unowned!.owner_host).toBe('unknown');
    expect(unowned!.root).toBe('/brains/work');
    expect(unowned!.fix.ask_user).toBeUndefined();
    const [unbound] = await holds(row({ root: null, owner_root: null, last_error: identity }));
    expect(unbound!.fix.ask_user).toBeUndefined();
    expect(unbound!.fix.why).toContain('git -C <checkout> status');
  });

  test('this host owns but has no binding of its own: no identity command against another host\'s path', async () => {
    const [hold] = await holds(row({ root: '/brains/aaa-other-host', owner_root: null, last_error: identity }));
    expect(hold!.owner_host).toBe('this_host');
    expect(hold!.root).toBeNull();
    expect(hold!.fix.ask_user).toBeUndefined();
    expect(JSON.stringify(hold)).not.toContain('/brains/aaa-other-host');
  });
});

describe('GCH-06: holds go most urgent first', () => {
  test('identity this host can set, then a former worktree\'s parked, then parked, then retrying; ties keep engine order', async () => {
    const out = await holds(
      row({ source_id: 'a-retrying', retrying: 2, parked: 0, last_error: { phase: 'commit', step: 'add', reason: 'other' } }),
      row({ source_id: 'b-parked', last_error: { phase: 'commit', step: 'add', reason: 'other' } }),
      row({ source_id: 'c-former', former_worktree: true, last_error: identity }),
      row({ source_id: 'd-parked', last_error: { phase: 'commit', step: 'add', reason: 'other' } }),
      row({ source_id: 'e-identity', retrying: 1, parked: 0, last_error: identity }),
    );
    expect(out.map(hold => hold.source_id)).toEqual(['e-identity', 'c-former', 'b-parked', 'd-parked', 'a-retrying']);
  });
});

describe('GCH-07: the hold line says commits are held, with the reason code', () => {
  test('identity, another cause, and an effect recorded before steps were kept', async () => {
    const [id] = await holds(row({ last_error: identity }));
    expect(gitCommitHoldLine(id!)).toBe('git commits held: 0 retrying, 1 parked (git_unavailable) since 2026-11-26T00:00:00.000Z at step commit-tree (reason: identity_missing); this checkout has no Git identity (user.name, user.email)');
    const [filter] = await holds(row({ codes: ['git_push_unavailable', 'git_unavailable'], last_error: { phase: 'commit', step: 'add', reason: 'filter_failed' } }));
    expect(gitCommitHoldLine(filter!)).toBe('git commits held: 0 retrying, 1 parked (git_push_unavailable, git_unavailable) since 2026-11-26T00:00:00.000Z at step add (reason: filter_failed)');
    expect(gitCommitHoldLine(filter!)).not.toContain('not made');
    const [legacy] = await holds(row({}));
    expect(legacy!.last_error).toBeNull();
    expect(legacy!.identity_missing).toBe(false);
    expect(gitCommitHoldLine(legacy!)).toBe('git effects blocked, commit state not recorded: 0 retrying, 1 parked (git_unavailable) since 2026-11-26T00:00:00.000Z; step not recorded');
  });

  test('another cause gets the retry preview, a former binding the settle preview, retrying effects the owner status', async () => {
    const [other] = await holds(row({ last_error: { phase: 'commit', step: 'add', reason: 'filter_failed' } }));
    expect(other!.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'retry-effects', 'work', '--parked-code', 'git_unavailable', '--dry-run']);
    expect(other!.fix.ask_user).toBeUndefined();
    const [former] = await holds(row({ former_worktree: true, last_error: identity }));
    expect(former!.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'settle-effects', 'work', '--parked-code', 'git_unavailable', '--dry-run']);
    const [retrying] = await holds(row({ retrying: 2, parked: 0, last_error: { phase: 'commit', step: 'add', reason: 'other' } }));
    expect(retrying!.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'work', '--json']);
  });
});
