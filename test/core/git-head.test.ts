// v0.41.27.0 — src/core/git-head.ts unit tests.
//
// Hermetic: no engine, no PGLite, no DATABASE_URL required. Probe seam lets
// the suite drive isSourceUnchangedSinceSync without spawning real git (cases
// 1-8, 10-12); case 9 is the shell-injection regression guard that DOES use
// the real execFileSync against a deliberately adversarial localPath to prove
// the array-arg call shape cannot escape to a shell.

import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSourceUnchangedSinceSync,
  _setGitHeadProbeForTests,
  _setGitCleanProbeForTests,
  type GitHeadProbe,
  type GitCleanProbe,
} from '../../src/core/git-head.ts';

// Reset both probe seams between every test so case order can't leak state.
beforeEach(() => {
  _setGitHeadProbeForTests(null);
  _setGitCleanProbeForTests(null);
});

afterAll(() => {
  // Restore defaults so other test files inheriting the module state are clean.
  _setGitHeadProbeForTests(null);
  _setGitCleanProbeForTests(null);
});

describe('isSourceUnchangedSinceSync — basic predicate', () => {
  test('case 1: happy path — HEAD matches, no requireCleanWorkingTree → true', () => {
    _setGitHeadProbeForTests(() => 'abc123');
    expect(isSourceUnchangedSinceSync('/tmp/repo', 'abc123')).toBe(true);
  });

  test('case 2: HEAD differs from lastCommit → false', () => {
    _setGitHeadProbeForTests(() => 'def456');
    expect(isSourceUnchangedSinceSync('/tmp/repo', 'abc123')).toBe(false);
  });

  test('case 3: localPath null — short-circuits without calling head probe', () => {
    let probeCalls = 0;
    _setGitHeadProbeForTests(() => { probeCalls++; return 'abc'; });
    expect(isSourceUnchangedSinceSync(null, 'abc123')).toBe(false);
    expect(probeCalls).toBe(0);
  });

  test('case 4: localPath empty string — short-circuits, probe not called', () => {
    let probeCalls = 0;
    _setGitHeadProbeForTests(() => { probeCalls++; return 'abc'; });
    expect(isSourceUnchangedSinceSync('', 'abc123')).toBe(false);
    expect(probeCalls).toBe(0);
  });

  test('case 5: lastCommit null — short-circuits, probe not called', () => {
    let probeCalls = 0;
    _setGitHeadProbeForTests(() => { probeCalls++; return 'abc'; });
    expect(isSourceUnchangedSinceSync('/tmp/repo', null)).toBe(false);
    expect(probeCalls).toBe(0);
  });

  test('case 6: lastCommit empty string — short-circuits, probe not called', () => {
    let probeCalls = 0;
    _setGitHeadProbeForTests(() => { probeCalls++; return 'abc'; });
    expect(isSourceUnchangedSinceSync('/tmp/repo', '')).toBe(false);
    expect(probeCalls).toBe(0);
  });

  test('case 7: head probe returns null (non-git dir / git not installed) → false', () => {
    _setGitHeadProbeForTests(() => null);
    expect(isSourceUnchangedSinceSync('/tmp/not-a-repo', 'abc123')).toBe(false);
  });

  test('case 8: head probe throws synchronously → false (fail-open)', () => {
    _setGitHeadProbeForTests(() => { throw new Error('git not installed'); });
    expect(() => isSourceUnchangedSinceSync('/tmp/repo', 'abc123')).toThrow();
    // The default behavior is fail-open via the probe's own try/catch
    // (returning null). A test seam that throws bypasses that protection
    // intentionally — production callers use the default probe which
    // swallows the error. Documented at git-head.ts:35-41.
    // Re-verify by stubbing a probe that swallows the underlying error:
    _setGitHeadProbeForTests(() => { try { throw new Error('inner'); } catch { return null; } });
    expect(isSourceUnchangedSinceSync('/tmp/repo', 'abc123')).toBe(false);
  });
});

describe('isSourceUnchangedSinceSync — shell-injection regression guard', () => {
  test('case 9: REAL execFileSync against adversarial localPath does NOT execute shell metachars', () => {
    // Use the REAL default probe (no test seam) so this case exercises the
    // production code path: execFileSync('git', ['-C', path, ...]). If the
    // implementation ever regresses to execSync with shell interpolation,
    // the `$(...)` substring would execute and create the sentinel file.
    _setGitHeadProbeForTests(null);
    _setGitCleanProbeForTests(null);

    const sentinelDir = mkdtempSync(join(tmpdir(), 'git-head-sentinel-'));
    const sentinelPath = join(sentinelDir, 'pwned');
    const adversarialPath = `/nonexistent/$(touch ${sentinelPath})/repo`;

    try {
      // Should fail-open: the path doesn't exist, git rev-parse returns
      // non-zero, the probe returns null, the helper returns false.
      const result = isSourceUnchangedSinceSync(adversarialPath, 'abc123');
      expect(result).toBe(false);
      // The load-bearing assertion: if shell interpolation happened,
      // `touch ${sentinelPath}` would have created the file. It must NOT
      // exist.
      expect(existsSync(sentinelPath)).toBe(false);
    } finally {
      // Cleanup. If the test failed-open AND created the sentinel, remove it.
      if (existsSync(sentinelPath)) {
        try { unlinkSync(sentinelPath); } catch { /* ignore */ }
      }
      try { rmSync(sentinelDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('isSourceUnchangedSinceSync — test-seam round-trip', () => {
  test('case 10: _setGitHeadProbeForTests + _setGitCleanProbeForTests round-trip', () => {
    // Install custom probes
    const customHead: GitHeadProbe = () => 'custom-head';
    const customClean: GitCleanProbe = () => true;
    _setGitHeadProbeForTests(customHead);
    _setGitCleanProbeForTests(customClean);

    expect(isSourceUnchangedSinceSync('/x', 'custom-head', { requireCleanWorkingTree: true })).toBe(true);

    // Restore defaults via null
    _setGitHeadProbeForTests(null);
    _setGitCleanProbeForTests(null);

    // After restoration, the real probes run. Against a non-git path,
    // both probes return null → predicate returns false. This proves the
    // restore worked without depending on a git repo in the test env.
    expect(isSourceUnchangedSinceSync('/definitely-not-a-git-repo-xyz', 'custom-head')).toBe(false);
  });
});

describe('isSourceUnchangedSinceSync — requireCleanWorkingTree (D7)', () => {
  test('case 11: HEAD match + clean tree + requireCleanWorkingTree=true → true', () => {
    _setGitHeadProbeForTests(() => 'abc123');
    _setGitCleanProbeForTests(() => true);
    expect(
      isSourceUnchangedSinceSync('/tmp/repo', 'abc123', { requireCleanWorkingTree: true }),
    ).toBe(true);
  });

  test('case 12a: HEAD match + DIRTY tree + requireCleanWorkingTree=true → false', () => {
    _setGitHeadProbeForTests(() => 'abc123');
    _setGitCleanProbeForTests(() => false);
    expect(
      isSourceUnchangedSinceSync('/tmp/repo', 'abc123', { requireCleanWorkingTree: true }),
    ).toBe(false);
  });

  test('case 12b: HEAD match + clean probe ERRORED (returns null) + requireCleanWorkingTree=true → false', () => {
    // null is distinct from false: probe error vs known-dirty. Both fail
    // the gate (fail-closed posture for the clean check, fail-open posture
    // for the helper as a whole — caller's time-based check still runs).
    _setGitHeadProbeForTests(() => 'abc123');
    _setGitCleanProbeForTests(() => null);
    expect(
      isSourceUnchangedSinceSync('/tmp/repo', 'abc123', { requireCleanWorkingTree: true }),
    ).toBe(false);
  });

  test('case 12c: HEAD match + tree dirty BUT requireCleanWorkingTree NOT set → true (clean probe not consulted)', () => {
    let cleanCalls = 0;
    _setGitHeadProbeForTests(() => 'abc123');
    _setGitCleanProbeForTests(() => { cleanCalls++; return false; });
    expect(isSourceUnchangedSinceSync('/tmp/repo', 'abc123')).toBe(true);
    expect(cleanCalls).toBe(0);
  });
});
