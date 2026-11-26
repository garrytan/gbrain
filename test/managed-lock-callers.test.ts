/**
 * Source guard for the managed lock seam (lane LM slice 3, gate D1): every managed worktree, topology and refresh lock
 * is taken through `managedLock` (managed-lock.ts), so a multi-user Rust store always gets its double guard. The raw
 * native-lock calls that remain in the managed modules are named here, each with the reason it is not a managed lock:
 * a probe that holds nothing, or a host-local coordination file that guards no store write.
 *
 * A new raw `acquireNativeLock` / `tryAcquireNativeLock` call in a managed module fails this test until it goes through
 * `managedLock` or is added here with its reason.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PERSISTENCE = join(import.meta.dir, '..', 'src', 'core', 'persistence');
const RAW = /\b(?:acquireNativeLock|tryAcquireNativeLock)\(/g;

/** The managed modules and how many raw native-lock calls each keeps, with why. */
const ALLOWED_RAW: Record<string, { calls: number; why: string }> = {
  'ownership.ts': { calls: 1, why: 'the claim probe: tryAcquireNativeLock on the new coordination path, released at once, before the claim transaction' },
  'refresh-run.ts': { calls: 1, why: 'the link-backlog drain lock: a host-local dedupe of one drain per brain and source, held after every refresh lock is released; it fences no store write' },
  'activation.ts': { calls: 1, why: 'the activation probe lock: released at once, it only reports a second activation on this host' },
  'administration.ts': { calls: 1, why: 'the admin status probe: released at once' },
  'coordination-lock.ts': { calls: 1, why: 'the reservation repair guard on a checkout root: host-local file repair, no store write' },
  'identity.ts': { calls: 1, why: 'the local writer registration file lock: host identity files, no store write' },
  'reconcile-backup.ts': { calls: 2, why: 'the backup directory capacity lock: host-local files' },
};
/** Modules that take managed locks: they must hold no other raw native-lock call. */
const MANAGED_MODULES = ['topology-locks.ts', 'topology-clone.ts', 'topology-recovery.ts', 'worktree-refresh.ts', 'head-blocker.ts', 'activation.ts',
  'deactivation.ts', 'pre-activation-release.ts', 'skill-activation.ts', 'ownership.ts', 'refresh-run.ts', 'consumer.ts', 'coordinator.ts', 'effects.ts',
  'group-publish.ts', 'git-conversion.ts', 'prepared-maintenance.ts', 'recovery-resolve.ts', 'connector-sync.ts', 'facts-maintenance.ts', 'atom-maintenance.ts'];

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('managed modules take their locks through managedLock', () => {
  for (const file of MANAGED_MODULES) {
    test(`${file}: only the named raw native-lock calls remain`, () => {
      // test-reads-source-ok[structural]: a source-text tripwire by design: a raw native-lock call in a managed module must go through managedLock.
      const calls = (strip(readFileSync(join(PERSISTENCE, file), 'utf8')).match(RAW) ?? []).length;
      expect({ file, calls }).toEqual({ file, calls: ALLOWED_RAW[file]?.calls ?? 0 });
    });
  }
  test('the seam names the three kinds of managed lock and the lease name form', () => {
    // test-reads-source-ok[structural]: the seam's exported names and lease name form are the contract this guard pins, as the module guard above does.
    const seam = readFileSync(join(PERSISTENCE, 'managed-lock.ts'), 'utf8');
    expect(seam).toContain("export type ManagedKind = 'topology' | 'worktree' | 'refresh';");
    expect(seam).toContain('`managed:${kind}:${id}`');
  });
});
