/**
 * Environment probes for tests that depend on OS behavior the host may not
 * provide. Some sandboxes (Vercel sandboxes, certain container/FUSE overlay
 * filesystems, root shells) do not enforce file permission bits: writes into
 * a 0555 directory and reads of a 0000 file both succeed. Tests that assert
 * "this write MUST fail" are unrunnable there — skip them visibly instead of
 * failing red. CI (ubuntu runners, non-root) enforces permissions, so the
 * skips never fire where the coverage matters.
 *
 * Probes are cached: one filesystem round-trip per process.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let _permsEnforced: boolean | undefined;

/** True when the host actually refuses writes into a read-only directory. */
export function permsEnforced(): boolean {
  if (_permsEnforced !== undefined) return _permsEnforced;
  const root = mkdtempSync(join(tmpdir(), 'gbrain-perm-probe-'));
  try {
    const ro = join(root, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o555);
    try {
      writeFileSync(join(ro, 'probe'), 'x');
      _permsEnforced = false; // write into 0555 dir succeeded → not enforced
    } catch {
      _permsEnforced = true;
    }
  } finally {
    try {
      chmodSync(join(root, 'ro'), 0o755);
    } catch {
      /* probe dir may not exist */
    }
    rmSync(root, { recursive: true, force: true });
  }
  return _permsEnforced;
}

let _crontab: boolean | undefined;

/** True when a `crontab` binary is on PATH (absent in some sandboxes). */
export function crontabAvailable(): boolean {
  if (_crontab !== undefined) return _crontab;
  _crontab = Bun.which('crontab') !== null;
  return _crontab;
}
