/**
 * Probe: does a failing SSRF-flagged `git fetch`'s stderr begin with git's
 * OWN error? Some environments PATH-shim git with a wrapper that prints its
 * own diagnostics before delegating (e.g. Conductor workspaces' auth-broker
 * shim warns "could not reach the GitHub auth broker socket" ahead of git's
 * `fatal:` when its socket env was scrubbed by the test preloads). Tests
 * that pin "the real git stderr leads within the first N chars" are
 * unrunnable behind such a wrapper — skip them visibly there. CI runners
 * exec real git, so the skip never fires where the coverage matters.
 *
 * The probe replicates git-remote.ts's exact failing shape (SSRF `-c` config
 * flags + blocked file transport + GIT_ENV overrides): wrapper shims can
 * behave differently per subcommand/argv shape, and only a failing
 * invocation surfaces the pollution the guarded tests slice into.
 *
 * Cached: one subprocess per test process.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let _gitStderrLeads: boolean | undefined;

/** True when a failing git command's stderr begins with git's own output. */
export function gitStderrLeads(): boolean {
  if (_gitStderrLeads !== undefined) return _gitStderrLeads;
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-git-probe-'));
  try {
    execFileSync('git', ['init', '-q', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    try {
      execFileSync(
        'git',
        ['-C', dir, '-c', 'protocol.file.allow=never', 'fetch', 'file:///nonexistent-gbrain-stderr-probe'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' },
          timeout: 15_000,
        },
      );
      // A fetch of a nonexistent blocked-transport URL succeeding means the
      // host's git is too strange to certify — treat as not-leading.
      _gitStderrLeads = false;
    } catch (e) {
      const err = e as { stderr?: Buffer | string };
      stderr = (err.stderr?.toString() ?? '').trimStart();
      _gitStderrLeads = stderr.startsWith('fatal:') || stderr.startsWith('error:');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return _gitStderrLeads;
}
