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

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import fc from 'fast-check';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { validateUploadPath } from '../../src/core/operations.ts';

const NUM_RUNS = 500;

let baseTmpRoot: string;
let savedCwd: string;

beforeAll(() => {
  baseTmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-fuzz-fs-'));
  // #4479: the `..`-probe expectations assume a cwd DEEP enough that
  // resolve('..') stays well below the filesystem root. In the CI container
  // the workdir is the depth-1 /app mount, where '..' resolves to '/' and
  // relative('/', box) no longer starts with '..' — the probe "passes"
  // confinement and the test false-fails as a container-only failure. Run
  // the whole file from a guaranteed-deep working directory instead of
  // depending on where the harness happened to be launched.
  savedCwd = process.cwd();
  const deepCwd = join(baseTmpRoot, 'deep', 'cwd', 'for', 'traversal', 'probes');
  mkdirSync(deepCwd, { recursive: true });
  process.chdir(deepCwd);
});

afterAll(() => {
  // Restore BEFORE removing baseTmpRoot — rmSync of the cwd's ancestor
  // leaves the process in a deleted directory otherwise.
  process.chdir(savedCwd);
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
  test('arbitrary relative paths: never wedges, and any RETURNED path is inside the box', () => {
    // A6 fix: the original suite passed (confinementDir, probe) — args
    // reversed against the (filePath, root, strict) signature — and swallowed
    // every throw, so the traversal/symlink properties tested nothing. The
    // property now is real: candidate = join(box, probe), and when the
    // validator RETURNS, the realpath it hands back must live inside the box.
    const realBox = realpathSync(confinementDir);
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (relPath) => {
        let returned: string | null = null;
        try {
          returned = validateUploadPath(join(confinementDir, relPath), confinementDir);
        } catch {
          /* throwing IS the contract for traversal / unresolvable input */
        }
        if (returned !== null && !returned.startsWith(realBox + sep)) {
          throw new Error(`validateUploadPath returned an out-of-box path for ${JSON.stringify(relPath)}: ${returned}`);
        }
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
          validateUploadPath(join(confinementDir, probe), confinementDir);
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
        validateUploadPath(linkPath, confinementDir);
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error('validateUploadPath did not reject a symlink pointing outside the confinement dir');
      }
    },
  );

  // A6: loose mode (strict:false) — outside-box files are allowed, but a
  // final-component symlink is STILL rejected in both modes.
  test('strict:false resolves an outside-box file but still rejects symlinks', () => {
    const outsideFile = join(baseTmpRoot, 'outside.txt');
    writeFileSync(outsideFile, 'outside');
    const real = validateUploadPath(outsideFile, confinementDir, false);
    expect(real).toBe(realpathSync(outsideFile));
    expect(real.startsWith(realpathSync(confinementDir))).toBe(false);
  });

  test.skipIf(!symlinksAvailable)('strict:false still rejects a final-component symlink', () => {
    const target = join(baseTmpRoot, 'loose-target.txt');
    writeFileSync(target, 'target');
    const linkPath = join(confinementDir, 'loose-link');
    symlinkSync(target, linkPath);
    let threw = false;
    try {
      validateUploadPath(linkPath, confinementDir, false);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
