/**
 * v0.41.22.2 — meta-test for scripts/check-worker-lock-renewal-shape.sh.
 *
 * Runs the CI guard against fixture worker.ts variants and asserts:
 *   1. Good shape (the v0.41.22.2 final form) exits 0.
 *   2. Bug pattern at the lock-renewal site (`lockTimer = setInterval(async ...)`)
 *      exits 1.
 *   3. Missing call site (`runLockRenewalTick` not referenced) exits 1.
 *   4. False-positive defense: `lockTimer = setInterval(syncCallback, ms)` with a
 *      named-ref second arg is allowed (NOT the bug pattern even if `async`
 *      appears later in the file in a different context).
 *
 * Uses the GBRAIN_LOCK_RENEWAL_SHAPE_TARGET env knob (built into the
 * script) to swap the scanned file without git-mucking. Hermetic via
 * per-test tempfiles.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const GUARD_SH = resolve(REPO_ROOT, 'scripts/check-worker-lock-renewal-shape.sh');

const tmpDirs: string[] = [];
function makeTempWorker(contents: string): string {
  const d = mkdtempSync(join(tmpdir(), 'lock-renewal-shape-'));
  tmpDirs.push(d);
  const file = join(d, 'worker.ts');
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
});

function runGuard(targetPath: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [GUARD_SH], {
    encoding: 'utf-8',
    env: { ...process.env, GBRAIN_LOCK_RENEWAL_SHAPE_TARGET: targetPath },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const GOOD_SHAPE = `
import { runLockRenewalTick } from './lock-renewal-tick.ts';

class MinionWorker {
  launchJob(job, lockToken) {
    let cancelled = false;
    let tickInFlight = false;
    const lockTimer = setInterval(() => {
      if (tickInFlight) return;
      tickInFlight = true;
      void runLockRenewalTick(deps, state)
        .then(handleResult)
        .finally(() => { tickInFlight = false; });
    }, this.opts.lockDuration / 2);
  }
}
`;

const BUG_PATTERN = `
import { runLockRenewalTick } from './lock-renewal-tick.ts';

class MinionWorker {
  launchJob(job, lockToken) {
    const lockTimer = setInterval(async () => {
      const renewed = await this.queue.renewLock(job.id, lockToken, dur);
      if (!renewed) abort.abort(new Error('lock-lost'));
    }, this.opts.lockDuration / 2);
  }
}
`;

const MISSING_CALL_SITE = `
class MinionWorker {
  launchJob(job, lockToken) {
    let tickInFlight = false;
    const lockTimer = setInterval(() => {
      if (tickInFlight) return;
      tickInFlight = true;
      // The pure function call site has been removed (regression).
    }, this.opts.lockDuration / 2);
  }
}
`;

const FALSE_POSITIVE_NAMED_REF = `
import { runLockRenewalTick } from './lock-renewal-tick.ts';

// This file has a different setInterval(async ...) elsewhere — like the
// stall detector at the real worker.ts line ~269. The shape guard MUST
// NOT flag this site because the lockTimer assignment uses the safe
// shape; the unrelated async setInterval is out of scope (codex C13).
class MinionWorker {
  start() {
    const stalledTimer = setInterval(async () => {
      try { await this.queue.handleStalled(); } catch { /* noop */ }
    }, this.opts.stalledInterval);
  }
  launchJob(job, lockToken) {
    const lockTimer = setInterval(() => {
      void runLockRenewalTick(deps, state).then(handleResult);
    }, this.opts.lockDuration / 2);
  }
}
`;

describe('check-worker-lock-renewal-shape.sh', () => {
  it('case 1 — good shape exits 0', () => {
    const file = makeTempWorker(GOOD_SHAPE);
    const r = runGuard(file);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('lock-renewal shape OK');
  });

  it('case 2 — bug pattern (lockTimer = setInterval(async ...)) exits 1', () => {
    const file = makeTempWorker(BUG_PATTERN);
    const r = runGuard(file);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('v0.41.22.1 bug pattern');
  });

  it('case 3 — missing runLockRenewalTick call site exits 1', () => {
    const file = makeTempWorker(MISSING_CALL_SITE);
    const r = runGuard(file);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('runLockRenewalTick');
  });

  it('case 4 — unrelated setInterval(async ...) elsewhere is NOT flagged (codex C13 scope)', () => {
    const file = makeTempWorker(FALSE_POSITIVE_NAMED_REF);
    const r = runGuard(file);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('lock-renewal shape OK');
  });

  it('case 5 — missing target file emits clear error', () => {
    const r = runGuard('/nonexistent/path/to/worker.ts');
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('not found');
  });
});
