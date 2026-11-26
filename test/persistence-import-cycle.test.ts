/**
 * Loading the persistence modules in a fresh process never trips a temporal-dead-zone read.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `import('./src/core/persistence/parked-groups.ts')` in a fresh Bun process exits 0. The sync pass row
 *    module (persistence/sync-pass-row.ts) reads MANAGED_SYNC_PASS_OP at load, so the constant must not come through an
 *    import cycle that reaches back to it (it lives in the leaf engine-sql/sync-hold-op.ts).
 *  - Regression: sync-pass-row.ts imported the constant from engine-sql/sync-hold-store.ts, which imports
 *    persistence-journal.ts, which imported it back from sync-pass-row.ts; loading parked-groups.ts first died with
 *    "Cannot access 'MANAGED_SYNC_PASS_OP' before initialization" at sync-pass-row.ts:25.
 *  - Why existing coverage misses it: a test file's own import order loads the cycle from the other end, so the error
 *    appears only for the module that is loaded first; only a fresh process reproduces it.
 *  - Seam: none. A child process imports the module and exits.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

test('importing persistence/parked-groups.ts in a fresh process exits 0', () => {
  const run = Bun.spawnSync(['bun', '-e', "await import('./src/core/persistence/parked-groups.ts')"], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const err = new TextDecoder().decode(run.stderr);
  expect({ exitCode: run.exitCode, tdz: /before initialization/.test(err) }).toEqual({ exitCode: 0, tdz: false });
});
