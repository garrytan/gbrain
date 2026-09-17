/**
 * Post-test guard: fail the test whose run modifies an install artefact in the
 * operator's REAL home — everything `gbrain autopilot --install` writes there:
 * `~/.gbrain/autopilot-run.sh`, `~/.gbrain/env`, `~/.gbrain/start-autopilot.sh`,
 * `~/Library/LaunchAgents/com.gbrain.autopilot.plist` and
 * `~/.config/systemd/user/gbrain-autopilot.service`.
 *
 * Why this exists: `gbrain-home-preload.ts` points GBRAIN_HOME at per-run
 * scratch, but a test file can undo that with `delete process.env.GBRAIN_HOME`
 * in a hook. Because Bun's `os.homedir()` ignores a runtime `$HOME` mutation,
 * `configDir()` then falls straight back to the real `~/.gbrain`, and
 * `writeWrapperScript()` regenerates the LIVE autopilot wrapper with a fixture
 * repo path and a fake CLI path. Observed on a dev box: the install suite did
 * exactly that, launchd (KeepAlive) re-ran the fixture wrapper every 60 s for
 * six days, the real autopilot never started, and no test went red. The
 * installer resolves the plist, unit and start-script paths from `$HOME` (not
 * GBRAIN_HOME), so an in-process install test must set BOTH, and the guard
 * watches all of them.
 *
 * Mechanism: fingerprint each file (size + mtime + inode, or `absent` /
 * `unreadable`) at preload time — before any test file can touch HOME or
 * GBRAIN_HOME — and compare before AND after every test, plus once at the end
 * of the process. A change seen by the afterEach is attributed to the test
 * that just ran ("during this test"); a change seen by the beforeEach happened
 * between tests (a previous file's afterAll, this file's beforeAll, another
 * test process sharing this home, or an operator command) and is reported
 * with that wording so the named test is not chased as the culprit. Each check
 * re-baselines, so one leak is one failure, not a cascade. Bun runs a preload's
 * beforeAll/afterAll once per PROCESS, so the afterAll only covers the last
 * file's afterAll; an earlier file's afterAll leak surfaces at the next file's
 * first beforeEach with the between-tests wording.
 *
 * Scope: one bun process. The sharded runner starts N processes that all
 * baseline the SAME real files, so one leak (or an operator running
 * `gbrain autopilot --install` mid-run) can trip the in-flight test in every
 * shard; the message says so, and the earliest marker in the logs owns it.
 * ctime is deliberately NOT in the fingerprint: an operator `chmod 600
 * ~/.gbrain/env` or a cloud-sync xattr change must not blame a test.
 * `config.json` is NOT guarded: the live daemon and sibling workspaces
 * legitimately rewrite it. Cost: five stat() calls per check, two checks per
 * test. Where no real install exists (CI) the guard is inert, except that a
 * test CREATING any of the files is caught too — so the rule holds in CI, not
 * just on dev boxes. Escape hatch for a deliberate real-install run:
 * `GBRAIN_TEST_ALLOW_REAL_HOME_WRITES=1` (a GBRAIN_TEST_* var, which
 * operator-env-preload keeps) — one-shot on the command line, never a
 * shell-profile export or a cwd `.env` (bun auto-loads those); the guard
 * prints a DISARMED notice so a stale opt-in can't silently recreate the
 * failure mode it exists to close.
 *
 * Must stay a separate file from gbrain-home-preload.ts:
 * test/cli-import-no-signal-handlers.test.ts imports that helper via `bun -e`,
 * and registering a bun:test hook outside the test runner throws at import.
 *
 * Self-tested by test/real-home-guard-preload.test.ts, which also pins the
 * guarded names against src/commands/autopilot.ts and
 * src/core/autopilot-paths.ts. Imported by `bunfig.toml` via
 * `preload = [..., "./test/helpers/real-home-guard-preload.ts"]`.
 */
import { afterAll, afterEach, beforeEach } from 'bun:test';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEBUG = process.env.GBRAIN_DEBUG_PRELOAD === '1';
const ALLOW = process.env.GBRAIN_TEST_ALLOW_REAL_HOME_WRITES === '1';

// Resolved once, at preload time: the operator's real home, captured before any
// test can mutate HOME (which os.homedir() would ignore anyway), normalised so
// the home-relative rendering below can't miss on a `/./`-style $HOME.
// homedir() can throw for a uid with no passwd entry (`docker --user 12345`);
// the guard then stands down instead of killing every `bun test` at preload.
function resolveRealHome(): string | null {
  try {
    const home = homedir();
    return home && home.trim() !== '' ? resolve(home) : null;
  } catch {
    return null;
  }
}

// Every file `gbrain autopilot --install` writes into the operator's home, at
// the default launchd label. Kept in lockstep with src/commands/autopilot.ts and
// src/core/autopilot-paths.ts by a source-shape pin in the self-test.
function guardedFiles(home: string): string[] {
  return [
    join(home, '.gbrain', 'autopilot-run.sh'),
    join(home, '.gbrain', 'env'),
    join(home, '.gbrain', 'start-autopilot.sh'),
    join(home, 'Library', 'LaunchAgents', 'com.gbrain.autopilot.plist'),
    join(home, '.config', 'systemd', 'user', 'gbrain-autopilot.service'),
  ];
}

function fingerprint(path: string): string {
  try {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return 'absent';
    return `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return 'unreadable';
  }
}

function tilde(path: string, home: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function remediation(path: string, home: string): string {
  const rel = tilde(path, home);
  if (rel.endsWith('/.gbrain/env')) {
    return `${rel} holds your API keys and \`gbrain autopilot --install\` never rewrites an existing env file — ` +
      'restore it from a backup or re-enter your keys, then re-run the install';
  }
  return `re-run \`gbrain autopilot --install --repo <your-brain-repo>\` to regenerate ${rel}`;
}

const REAL_HOME = resolveRealHome();

if (REAL_HOME === null) {
  console.error(
    '[real-home-guard-preload] INACTIVE: os.homedir() is unavailable, so the operator\'s real install artefacts are unguarded for this run.',
  );
} else if (ALLOW) {
  console.error(
    '[real-home-guard-preload] DISARMED by GBRAIN_TEST_ALLOW_REAL_HOME_WRITES=1 — the operator\'s real install ' +
    'artefacts are unguarded for this run. Opt in one-shot on the command line only, never via a shell-profile ' +
    'export or a cwd .env (bun auto-loads those).',
  );
} else {
  const home = REAL_HOME;
  const files = guardedFiles(home);
  const baseline = new Map<string, string>(files.map((p) => [p, fingerprint(p)]));
  if (DEBUG) {
    console.error(`[real-home-guard-preload] guarding ${files.map((p) => tilde(p, home)).join(', ')}`);
  }

  const check = (when: 'before' | 'during' | 'end'): void => {
    const changed: string[] = [];
    const fixes: string[] = [];
    for (const path of files) {
      const now = fingerprint(path);
      const was = baseline.get(path);
      if (now !== was) {
        baseline.set(path, now); // re-baseline: report each leak once
        changed.push(`${tilde(path, home)} (${was} -> ${now})`);
        fixes.push(remediation(path, home));
      }
    }
    if (changed.length === 0) return;
    const lead = when === 'during'
      ? "this test's run modified the operator's REAL home"
      : when === 'before'
        ? "the operator's REAL home changed BEFORE this test started — a previous file's afterAll/afterEach, " +
          "this file's beforeAll, another test process sharing this home, or an operator command wrote it; " +
          'this test is likely innocent'
        : "the operator's REAL home changed after the last test finished (a file-level afterAll or another process)";
    throw new Error(
      `[real-home-guard-preload] ${lead}: ${changed.join('; ')}. ` +
      'Likely cause: a hook or test deleted (or blanked) GBRAIN_HOME — Bun\'s os.homedir() ignores a runtime HOME ' +
      'mutation, so configDir() falls back to the real home. SET GBRAIN_HOME (and HOME, for the plist/unit paths) ' +
      'to a scratch dir in a hook, never delete it (see test/helpers/gbrain-home-preload.ts). Other bun test ' +
      'processes on this machine may report the same change; the earliest marker in the logs owns it. ' +
      `Remediation: ${fixes.join('; ')}. ` +
      'GBRAIN_TEST_ALLOW_REAL_HOME_WRITES=1 (one-shot, on the command line) disarms this guard for a deliberate real-install run.',
    );
  };

  // Between tests: a change that predates this test is reported as such.
  beforeEach(() => check('before'));
  // Per-test: attributes the failure to the test that just ran.
  afterEach(() => check('during'));
  // Per-process backstop: a write from the last file's afterAll lands after
  // its final afterEach.
  afterAll(() => check('end'));
}
