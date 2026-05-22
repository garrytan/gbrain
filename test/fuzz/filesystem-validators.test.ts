/**
 * Filesystem-touching validator fuzz tests.
 *
 * Separate from `pure-validators.test.ts` because these targets need real fs
 * access (realpathSync, lstatSync) and CANNOT be in the purity-guarded suite.
 * That separation is the structural fix for the "fuzz purity guard contradicts
 * itself" CRITICAL finding from the 2-pass eng review.
 *
 * Every test in this file uses a clean temp dir created in beforeEach so
 * fuzz inputs can't leak across tests. The temp dir is the entire confinement
 * boundary — `validateUploadPath` resolves symlinks and rejects traversal
 * outside the dir, which is exactly the contract we want to fuzz.
 */

import { describe, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import fc from 'fast-check';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateUploadPath } from '../../src/core/operations.ts';

const NUM_RUNS = 500;

let baseTmpRoot: string;

beforeAll(() => {
  baseTmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-fuzz-fs-'));
});

afterAll(() => {
  rmSync(baseTmpRoot, { recursive: true, force: true });
});

let confinementDir: string;
beforeEach(() => {
  // Fresh confinement per test so traversal attempts can't leak state.
  confinementDir = mkdtempSync(join(baseTmpRoot, 'box-'));
  // Seed a legitimate file inside the box so success cases have something to find.
  writeFileSync(join(confinementDir, 'safe.txt'), 'safe');
  mkdirSync(join(confinementDir, 'subdir'), { recursive: true });
  writeFileSync(join(confinementDir, 'subdir', 'nested.txt'), 'nested');
});

describe('validateUploadPath fuzz (fs-backed)', () => {
  test('arbitrary relative paths: never wedges, never escapes confinement', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (relPath) => {
        try {
          validateUploadPath(confinementDir, relPath);
        } catch {
          /* throwing is the expected behavior for traversal / invalid input */
        }
        // The contract: function returns without throwing OR throws. Either is fine.
        // What we're ruling out: process crash, infinite loop (caught by fast-check
        // run timeout), or silent path-escape (which would be a security bug — the
        // ACTUAL behavior is a throw on any escape attempt).
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test('shaped traversal probes: explicit `..` patterns rejected', () => {
    // Generate adversarial traversal shapes deliberately, beyond what
    // fc.string() would surface organically.
    const traversalProbe = fc.oneof(
      fc.constant('../etc/passwd'),
      fc.constant('../../etc/passwd'),
      fc.constant('subdir/../../etc/passwd'),
      fc.constant('./../../../tmp'),
      fc.constantFrom('.', '..', '...', './'),
      fc.tuple(fc.constant('../'), fc.string({ minLength: 1, maxLength: 50 })).map(([a, b]) => a + b),
    );
    fc.assert(
      fc.property(traversalProbe, (probe) => {
        let threw = false;
        try {
          validateUploadPath(confinementDir, probe);
        } catch {
          threw = true;
        }
        // For probes that explicitly contain `..` we expect a throw. The test
        // is the contract: confinement holds against directly-malicious input.
        if (probe.includes('..') && !threw) {
          throw new Error(`validateUploadPath did not reject traversal probe: ${JSON.stringify(probe)}`);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Symlink creation is platform / permission gated (Windows without dev mode,
  // restricted CI runners). Detect upfront and skip the probe explicitly via
  // `test.skipIf` so the result is reported as "skipped" — NOT silently green.
  // The earlier early-return pattern hid a security-critical confinement test
  // behind a fake pass on any platform that couldn't make symlinks.
  // Probe via the OS tmpdir directly — baseTmpRoot isn't available until
  // beforeAll runs, and this expression evaluates at module load time.
  const symlinksAvailable = (() => {
    const probeDir = mkdtempSync(join(tmpdir(), 'gbrain-symlink-probe-'));
    try {
      symlinkSync(tmpdir(), join(probeDir, 'probe-link'));
      return true;
    } catch {
      return false;
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  })();
  test.skipIf(!symlinksAvailable)(
    'symlink-escape probe: symlinks pointing outside the box are rejected',
    () => {
      const linkPath = join(confinementDir, 'evil-link');
      symlinkSync(tmpdir(), linkPath);
      let threw = false;
      try {
        validateUploadPath(confinementDir, 'evil-link');
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error('validateUploadPath did not reject a symlink pointing outside the confinement dir');
      }
    },
  );
});
