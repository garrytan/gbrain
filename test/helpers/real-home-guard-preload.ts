/**
 * Post-test guard: fail the exact test that modifies the operator's REAL
 * `~/.gbrain/autopilot-run.sh` or `~/.gbrain/env`.
 *
 * Why this exists: `gbrain-home-preload.ts` points GBRAIN_HOME at per-run
 * scratch, but a test file can undo that with `delete process.env.GBRAIN_HOME`
 * in a hook. Because Bun's `os.homedir()` ignores a runtime `$HOME` mutation,
 * `configDir()` then falls straight back to the real `~/.gbrain`, and
 * `writeWrapperScript()` regenerates the LIVE autopilot wrapper with a fixture
 * repo path and a fake CLI path. Observed on a dev box: the install suite did
 * exactly that, launchd (KeepAlive) re-ran the fixture wrapper every 60 s for
 * six days, the real autopilot never started, and no test went red.
 *
 * Mechanism: fingerprint both files (size + mtime + ctime + inode, or
 * absence) at preload time — before any test file can touch HOME or
 * GBRAIN_HOME — and compare after EVERY test, plus once at the end of the run
 * (a write from a file's own afterAll happens after its last afterEach). A
 * change throws from the afterEach, which Bun attributes to the test that just
 * ran, under its file, with exit 1. The baseline is then advanced so one
 * offending write is one failure, not a cascade across the rest of the shard.
 *
 * Scope is deliberately these two files only. Both are written solely by
 * `gbrain autopilot --install` — never by the running daemon — so a change
 * during a test run is a leak by construction. `config.json` is NOT guarded:
 * the live daemon and sibling workspaces legitimately rewrite it, which would
 * blame an innocent test. Cost: two stat() calls per test. Where no real
 * `~/.gbrain` exists (CI) the guard is inert, except that a test CREATING
 * either file is caught too — so the rule holds in CI, not just on dev boxes.
 *
 * Must stay a separate file from gbrain-home-preload.ts:
 * test/cli-import-no-signal-handlers.test.ts imports that helper via `bun -e`,
 * and registering a bun:test hook outside the test runner throws at import.
 *
 * Self-tested by test/real-home-guard-preload.test.ts. Imported by
 * `bunfig.toml` via `preload = [..., "./test/helpers/real-home-guard-preload.ts"]`.
 */
import { afterAll, afterEach } from 'bun:test';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Resolved once, at preload time: this is the operator's real home, captured
// before any test can mutate HOME (which os.homedir() would ignore anyway).
const REAL_GBRAIN_DIR = join(homedir(), '.gbrain');
const GUARDED_FILES = ['autopilot-run.sh', 'env'].map((name) => join(REAL_GBRAIN_DIR, name));

function fingerprint(path: string): string {
  try {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return 'absent';
    return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
  } catch {
    return 'unreadable';
  }
}

const baseline = new Map<string, string>(GUARDED_FILES.map((p) => [p, fingerprint(p)]));

if (process.env.GBRAIN_DEBUG_PRELOAD === '1') {
  console.error(`[real-home-guard-preload] guarding ${GUARDED_FILES.join(', ')}`);
}

function assertRealHomeUntouched(): void {
  const changed: string[] = [];
  for (const path of GUARDED_FILES) {
    const now = fingerprint(path);
    const was = baseline.get(path);
    if (now !== was) {
      baseline.set(path, now); // re-baseline: report each leak once
      changed.push(`${path} (${was} -> ${now})`);
    }
  }
  if (changed.length === 0) return;
  throw new Error(
    `[real-home-guard-preload] this test modified the operator's REAL ~/.gbrain: ${changed.join('; ')}. ` +
    `GBRAIN_HOME=${process.env.GBRAIN_HOME ?? '<unset>'} at check time. ` +
    `Tests must keep GBRAIN_HOME pointed at a scratch dir — SET it in a hook, never delete it ` +
    `(see test/helpers/gbrain-home-preload.ts). On a dev box with a live autopilot, re-run ` +
    `\`gbrain autopilot --install --repo <your-brain-repo>\` to regenerate the wrapper.`,
  );
}

// Per-test: attributes the failure to the offending test by name.
afterEach(assertRealHomeUntouched);
// Per-run backstop: a write from the last file's afterAll lands after its final
// afterEach; this reports it (unattributed, but the run still goes red).
afterAll(assertRealHomeUntouched);
