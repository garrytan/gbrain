/**
 * What a failed managed Git step keeps and how `gbrain sync status` turns it into a hold and a fix (git-diagnostic.ts,
 * git-commit-holds.ts, effects.ts pushPhaseFailure).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: git's stderr is sanitized before it is kept (URL userinfo, query and fragment, scp-style credentials,
 *    Authorization values, token assignments, scanner-recognized secrets, terminal controls), then cut to its first line
 *    and capped without cutting a secret in half; an identity failure is recognized from stderr; a hold's fix is the
 *    identity question only when git said so, a settle preview for a former binding, a retry preview for parked
 *    effects, the owner status while they retry; an effect recorded before steps were kept reads "step not recorded";
 *    a git step that did not finish during the push is a push hold (git_push_unavailable, phase push).
 *  - Regression: a credential stored or printed, a wrong cause named, a bulk retry offered where it selects nothing, or
 *    a post-commit push timeout reported as a commit never made.
 *  - Why existing coverage misses it: the effect kept only its code; nothing read stderr.
 *  - Seam: the hold reader takes a stub engine answering listGitPushHoldRows; everything else is the real code.
 */
import { describe, expect, test } from 'bun:test';
import { GIT_DIAGNOSTIC_LINE_MAX, gitDiagnostic, gitDiagnosticOf, sanitizeGitStderr } from '../src/core/persistence/git-diagnostic.ts';
import { gitCommitHoldLine, readGitCommitHolds } from '../src/core/persistence/git-commit-holds.ts';
import { gitFailure } from '../src/core/persistence/effect-git.ts';
import { pushPhaseFailure } from '../src/core/persistence/effects.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('sanitizeGitStderr', () => {
  test('a token-bearing remote URL and an Authorization header leave nothing secret', () => {
    const line = sanitizeGitStderr("fatal: unable to access 'https://alice-example:hunter2tokenvalue@git.example.invalid/acme.git?access_token=qq9secretquerytoken#frag': Authorization: Bearer zz8secretbearervalue\nhint: more\n")!;
    for (const secret of ['hunter2tokenvalue', 'qq9secretquerytoken', 'zz8secretbearervalue', 'alice-example', 'frag']) expect(line).not.toContain(secret);
    expect(line).toContain('https://git.example.invalid/acme.git');
    expect(line).not.toContain('hint: more');
  });

  test('scp-style credentials, token assignments, Basic values and a raw @ in userinfo', () => {
    const out = sanitizeGitStderr('error: alice:pa55word@git.example.invalid:acme.git token=abcd1234efgh GITHUB_TOKEN: ghx_value99 Basic dXNlcjpwYXNzd29yZA== https://u:p@ss@h.example.invalid/x')!;
    for (const secret of ['pa55word', 'abcd1234efgh', 'ghx_value99', 'dXNlcjpwYXNzd29yZA', 'p@ss']) expect(out).not.toContain(secret);
    expect(out).toContain('git.example.invalid');
  });

  test('a secret the scanner recognizes is redacted', () => {
    const out = sanitizeGitStderr('remote: rejected key AKIAIOSFODNN7EXAMPLE in push')!;
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  test('terminal controls are removed, the first non-empty line is kept, the cap never cuts a secret open', () => {
    expect(sanitizeGitStderr('\n\x1b[31mfatal:\x1b[0m bad\x07 thing\nsecond')).toBe('fatal: bad thing');
    const long = `${'x'.repeat(GIT_DIAGNOSTIC_LINE_MAX - 20)} token=${'s'.repeat(60)}`;
    const out = sanitizeGitStderr(long)!;
    expect(out.length).toBeLessThanOrEqual(GIT_DIAGNOSTIC_LINE_MAX);
    expect(out).not.toContain('sss');
    expect(sanitizeGitStderr('  \n\t\n')).toBeNull();
  });
});

describe('gitDiagnostic', () => {
  test('recognizes a missing identity from stderr, and only then', () => {
    expect(gitDiagnostic('commit', 'commit-tree', 'Author identity unknown\n\n*** Please tell me who you are.\n')).toEqual({ phase: 'commit', step: 'commit-tree', line: 'Author identity unknown', identity: true });
    expect(gitDiagnostic('commit', 'commit-tree', 'fatal: no email was given and auto-detection is disabled').identity).toBe(true);
    expect(gitDiagnostic('commit', 'add', 'error: external filter failed').identity).toBeUndefined();
  });

  test('a gitFailure carries its diagnostic; a push-phase git_unavailable becomes a push hold', () => {
    const failure = gitFailure('Cannot commit.', 'git commit failed.', gitDiagnostic('commit', 'commit-tree', 'Author identity unknown'));
    expect(gitDiagnosticOf(failure)?.step).toBe('commit-tree');
    const timeout = gitFailure('Git execution did not finish within its bounded attempt.', 'timed out', gitDiagnostic('commit', 'ls-remote', 'git ls-remote did not finish'));
    const pushed = pushPhaseFailure(timeout) as OperationError;
    expect(pushed.code).toBe('git_push_unavailable');
    expect(gitDiagnosticOf(pushed)).toEqual({ phase: 'push', step: 'ls-remote', line: 'git ls-remote did not finish' });
    const other = new OperationError('writer_busy', 'busy', 'wait');
    expect(pushPhaseFailure(other)).toBe(other);
  });
});

describe('readGitCommitHolds', () => {
  const row = (over: Record<string, unknown>) => ({ source_id: 'work', root: '/brains/work', former_worktree: false, retrying: 0, parked: 1, codes: ['git_unavailable'],
    oldest_at: new Date('2026-11-26T00:00:00Z'), last_error: null, ...over });
  const holds = async (...rows: Array<Record<string, unknown>>) => readGitCommitHolds({ listGitPushHoldRows: async (codes: string[]) => { expect(codes).toEqual(['git_unavailable']); return rows; } } as unknown as BrainEngine);

  test('the identity question only when git said there is none', async () => {
    const [hold] = await holds(row({ last_error: { line: 'Author identity unknown', step: 'commit-tree', phase: 'commit', identity: true } }));
    expect(hold!.identity_missing).toBe(true);
    expect(hold!.fix).toMatchObject({ ask_user: true, actor: 'user', argv: ['git', '-C', '/brains/work', 'config', '--show-origin', '--get-regexp', '^user\\.'] });
    expect(hold!.fix.user_message).toContain('gbrain sources writer retry-effects work --parked-code git_unavailable --dry-run');
    expect(Object.keys(hold!.last_error!)).toEqual(['phase', 'step', 'line', 'identity']);
    expect(gitCommitHoldLine(hold!)).toBe('git commits not made: 0 retrying, 1 parked (git_unavailable) since 2026-11-26T00:00:00.000Z at step commit-tree: "Author identity unknown"; this checkout has no Git identity (user.name, user.email)');
  });

  test('another cause gets the retry preview, a former binding the settle preview, retrying effects the owner status', async () => {
    const [other] = await holds(row({ last_error: { phase: 'commit', step: 'add', line: 'error: external filter failed' } }));
    expect(other!.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'retry-effects', 'work', '--parked-code', 'git_unavailable', '--dry-run']);
    expect(other!.fix.ask_user).toBeUndefined();
    const [former] = await holds(row({ former_worktree: true, last_error: { phase: 'commit', step: 'commit-tree', line: 'Author identity unknown', identity: true } }));
    expect(former!.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'settle-effects', 'work', '--parked-code', 'git_unavailable', '--dry-run']);
    const [retrying] = await holds(row({ retrying: 2, parked: 0, last_error: { phase: 'commit', step: 'add', line: null } }));
    expect(retrying!.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'work', '--json']);
  });

  test('an effect recorded before steps were kept: neutral wording, no identity claim', async () => {
    const [legacy] = await holds(row({}));
    expect(legacy!.last_error).toBeNull();
    expect(legacy!.identity_missing).toBe(false);
    expect(gitCommitHoldLine(legacy!)).toBe('git effects blocked, commit state not recorded: 0 retrying, 1 parked (git_unavailable) since 2026-11-26T00:00:00.000Z; step not recorded');
  });
});
