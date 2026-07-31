/**
 * `import` and `sync` are PROTECTED job names.
 *
 * Why this is a security test and not a naming test: `submit_job` is
 * `scope:'admin'` with no `localOnly`, so any OAuth client holding admin can
 * submit over HTTP. The `import` handler passes `data.dir` straight to
 * runImport and the `sync` handler passes `data.repoPath` straight to
 * performSync — both caller-supplied absolute paths. A remote caller could
 * therefore aim either at an arbitrary server directory and pull its contents
 * into the brain, where they become readable through ordinary read-scoped
 * search. Protecting the names forces `allowProtectedSubmit`, which only
 * trusted local submitters pass.
 *
 * The guard is enforced twice independently (operations.ts submit_job and
 * MinionQueue.add); this pins the shared name set that both consult.
 */

import { describe, test, expect } from 'bun:test';
import {
  PROTECTED_JOB_NAMES,
  isProtectedJobName,
} from '../src/core/minions/protected-names.ts';

describe('PROTECTED_JOB_NAMES — filesystem-reaching handlers', () => {
  test('import is protected', () => {
    expect(isProtectedJobName('import')).toBe(true);
    expect(PROTECTED_JOB_NAMES.has('import')).toBe(true);
  });

  test('sync is protected', () => {
    expect(isProtectedJobName('sync')).toBe(true);
    expect(PROTECTED_JOB_NAMES.has('sync')).toBe(true);
  });

  test('whitespace padding does not evade the check', () => {
    expect(isProtectedJobName('  import ')).toBe(true);
    expect(isProtectedJobName('\tsync\n')).toBe(true);
  });

  test('near-miss names are NOT protected (the set is exact, not prefix)', () => {
    // These are real registered job names that must keep flowing from
    // untrusted submitters — protecting them by accident would break the
    // remote ingest path.
    expect(isProtectedJobName('sync-retry-failed')).toBe(false);
    expect(isProtectedJobName('ingest_capture')).toBe(false);
    expect(isProtectedJobName('import-something-else')).toBe(false);
  });

  test('the pre-existing protected set is unchanged', () => {
    // Regression pin: adding names must not drop any.
    for (const name of [
      'shell',
      'subagent',
      'subagent_aggregator',
      'synthesize',
      'patterns',
      'consolidate',
      'contextual_reindex_per_chunk',
      'extract-takes-from-pages',
      'unify-types',
      'skillopt',
      'extract-atoms-drain',
    ]) {
      expect(isProtectedJobName(name)).toBe(true);
    }
  });
});
