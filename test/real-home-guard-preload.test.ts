/**
 * Self-test for test/helpers/real-home-guard-preload.ts.
 *
 * Each case generates throwaway probe test files and spawns a real
 * `bun test --preload <guard>` child on them with HOME pointed at a scratch
 * directory. A child Bun honors HOME at process start — it is only a RUNTIME
 * mutation that os.homedir() ignores — so the guard in the child watches a
 * "real" home this test owns. What is asserted is the guard's actual behavior,
 * not a re-implementation of it, and the operator's true ~/.gbrain is never
 * touched: every probe write goes through realHome(), which refuses to run
 * unless the child's homedir() IS the scratch home (fail closed).
 *
 * cwd is the scratch dir, not the repo root, so the child does NOT pick up
 * this repo's bunfig.toml preload chain — only the guard under test loads.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const GUARD = resolve(import.meta.dir, 'helpers', 'real-home-guard-preload.ts');
const MARKER = '[real-home-guard-preload]';
const DURING = "this test's run modified the operator's REAL home";
const BEFORE = 'changed BEFORE this test started';
const AFTER_LAST = 'changed after the last test finished';
// One guarded-file fingerprint as the guard prints it: size:mtimeMs:ino.
const FP = '\\d+:[\\d.]+:\\d+';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Shared probe prelude. realHome() is the containment gate: it resolves the
// CHILD's homedir() and throws before any write unless that home is the
// scratch one the parent pointed HOME at (and lives under the scratch root),
// so a Bun that ever stopped honoring the spawn-time HOME could not turn
// these probes loose on the operator's real files.
const PROBE_PRELUDE = `import { test, expect, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
function realHome() {
  const home = homedir();
  const root = process.env.GBRAIN_SELFTEST_ROOT;
  if (!root || home !== process.env.HOME || !home.startsWith(root)) {
    throw new Error('probe containment failed: homedir()=' + home + ' HOME=' + process.env.HOME + ' root=' + root);
  }
  return home;
}
function realDir() {
  const dir = join(realHome(), '.gbrain');
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writeReal(name, content = '# written by probe\\n') {
  writeFileSync(join(realDir(), name), content);
}
`;

type ProbeOpts = {
  /** Files to create under <home>/.gbrain BEFORE the child starts — the
   *  dev-box shape, where a live install already exists at preload time. */
  seed?: Record<string, string>;
  /** Make <home>/.gbrain a regular FILE, so stat() of the ~/.gbrain paths
   *  throws ENOTDIR (which, unlike ENOENT, `throwIfNoEntry: false` does not
   *  swallow) and the guard's baseline for them is `unreadable`. */
  gbrainAsFile?: boolean;
  /** Extra child env; `undefined` deletes the key. */
  env?: Record<string, string | undefined>;
  /** Additional probe files (name -> body); each gets the prelude. Bun runs
   *  files in directory-scan order, not argument order, so cases that use
   *  this must hold in either order. */
  extraFiles?: Record<string, string>;
};

// One spawn shape for every child bun in this file. A hung child would
// otherwise block the sync call past bun's own per-test timeout (which cannot
// preempt a native sync call).
function spawnBun(args: string[], opts: { cwd?: string; env: Record<string, string> }): { exitCode: number; out: string } {
  const proc = Bun.spawnSync(['bun', ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });
  return { exitCode: proc.exitCode ?? -1, out: proc.stdout.toString() + proc.stderr.toString() };
}

function childEnv(home: string, gbrainHome: string, root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.HOME = home;
  env.GBRAIN_HOME = gbrainHome;
  env.GBRAIN_SELFTEST_ROOT = root;
  // Ambient operator settings must not leak into the probe: a debug flag would
  // print the marker on every run, an allow flag would disarm the guard.
  delete env.GBRAIN_DEBUG_PRELOAD;
  delete env.GBRAIN_TEST_ALLOW_REAL_HOME_WRITES;
  return env;
}

function runProbe(probeBody: string, opts: ProbeOpts = {}): { exitCode: number; out: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-real-home-guard-selftest-'));
  const home = join(root, 'home');
  const gbrainHome = join(root, 'gbrain-home');
  mkdirSync(home);
  mkdirSync(gbrainHome);
  if (opts.seed) {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    for (const [name, content] of Object.entries(opts.seed)) {
      writeFileSync(join(home, '.gbrain', name), content);
    }
  }
  if (opts.gbrainAsFile) writeFileSync(join(home, '.gbrain'), 'not a directory\n');
  const files = ['probe.test.ts'];
  writeFileSync(join(root, 'probe.test.ts'), PROBE_PRELUDE + probeBody);
  for (const [name, body] of Object.entries(opts.extraFiles ?? {})) {
    writeFileSync(join(root, name), PROBE_PRELUDE + body);
    files.push(name);
  }
  const env = childEnv(home, gbrainHome, root);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    const r = spawnBun(['test', '--timeout=15000', '--preload', GUARD, ...files], { cwd: root, env });
    return { ...r, home };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('real-home-guard-preload', () => {
  test('containment canary: a child bun resolves os.homedir() to the spawn-time HOME (no writes performed)', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-homedir-canary-'));
    try {
      const r = spawnBun(['-e', 'process.stdout.write(require("node:os").homedir())'], {
        env: { ...childEnv(home, home, home) },
      });
      expect(r.out).toBe(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('fails the exact test that writes the real ~/.gbrain/autopilot-run.sh, without cascading', () => {
    const r = runProbe(`
test('probe: innocent before', () => { expect(1).toBe(1); });
test('probe: writes the real wrapper', () => { writeReal('autopilot-run.sh'); expect(1).toBe(1); });
test('probe: innocent after', () => { expect(1).toBe(1); });
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain(MARKER);
    expect(r.out).toContain(DURING);
    // Paths are rendered relative to the guarded home, never as the absolute
    // home path (which names the operator's account in shared CI logs).
    expect(r.out).toContain('~/.gbrain/autopilot-run.sh (absent ->');
    expect(r.out).not.toContain(join(r.home, '.gbrain', 'autopilot-run.sh'));
    // Attributed to the writer by name; the neighbours stay green.
    expect(r.out).toContain('(fail) probe: writes the real wrapper');
    expect(r.out).not.toContain('(fail) probe: innocent');
    expect(r.out).toMatch(/\b2 pass\b/);
    expect(r.out).toMatch(/\b1 fail\b/);
    // The wrapper is regenerated by a reinstall — say so.
    expect(r.out).toContain('to regenerate ~/.gbrain/autopilot-run.sh');
  }, 30_000);

  test('fails on a write to the real ~/.gbrain/env, with the env-specific remediation (a reinstall never rewrites it)', () => {
    const r = runProbe(`
test('probe: writes the real env file', () => { writeReal('env'); expect(1).toBe(1); });
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain(MARKER);
    expect(r.out).toContain('~/.gbrain/env (absent ->');
    expect(r.out).toContain('(fail) probe: writes the real env file');
    expect(r.out).toContain('never rewrites an existing env file');
    expect(r.out).toContain('restore it from a backup');
    expect(r.out).not.toContain('to regenerate ~/.gbrain/env');
  }, 30_000);

  test('the launchd plist and the systemd unit are guarded too (they resolve from HOME, not GBRAIN_HOME)', () => {
    const r = runProbe(`
test('probe: writes the real plist and unit', () => {
  const home = realHome();
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.gbrain.autopilot.plist'), '<plist/>\\n');
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(join(home, '.config', 'systemd', 'user', 'gbrain-autopilot.service'), '[Unit]\\n');
  expect(1).toBe(1);
});
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain('(fail) probe: writes the real plist and unit');
    expect(r.out).toContain('~/Library/LaunchAgents/com.gbrain.autopilot.plist (absent ->');
    expect(r.out).toContain('~/.config/systemd/user/gbrain-autopilot.service (absent ->');
  }, 30_000);

  test('the ephemeral-container start script is guarded too', () => {
    const r = runProbe(`
test('probe: writes the real start script', () => { writeReal('start-autopilot.sh', '#!/bin/bash\\n'); expect(1).toBe(1); });
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain('(fail) probe: writes the real start script');
    expect(r.out).toContain('~/.gbrain/start-autopilot.sh (absent ->');
  }, 30_000);

  test("the end-of-process backstop catches a write from the last file's afterAll", () => {
    const r = runProbe(`
test('probe: passes', () => { expect(1).toBe(1); });
afterAll(() => { writeReal('autopilot-run.sh'); });
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain(MARKER);
    expect(r.out).toContain(AFTER_LAST);
  }, 30_000);

  // A file-level beforeAll runs before the first test's guard beforeEach
  // regardless of file order, so this deterministically exercises the
  // between-tests branch: the first test carries the failure, but the report
  // must say the change predates it.
  test('a same-file beforeAll leak is reported as pre-existing on the first test, not as its own write', () => {
    const r = runProbe(`
import { beforeAll } from 'bun:test';
beforeAll(() => { writeReal('autopilot-run.sh'); });
test('probe: first test after a beforeAll leak', () => { expect(1).toBe(1); });
test('probe: second test', () => { expect(1).toBe(1); });
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain('(fail) probe: first test after a beforeAll leak');
    expect(r.out).toContain(BEFORE);
    expect(r.out).toContain('this test is likely innocent');
    expect(r.out).not.toContain(DURING);
    expect(r.out).not.toContain('(fail) probe: second test');
    expect(r.out).toMatch(/\b1 pass\b/);
    expect(r.out).toMatch(/\b1 fail\b/);
  }, 30_000);

  // Two files in one process, with the leak in one file's afterAll. Bun picks
  // the file order (directory-scan order), so both outcomes are normal: if the
  // leaking file runs first, the guard sees the change at the next file's
  // beforeEach and must report it as pre-existing; if it runs last, the
  // end-of-process backstop reports it. Either way no test is blamed for a
  // write it did not make.
  test("multi-file: an afterAll leak in one file is never reported as another file's own write", () => {
    const r = runProbe(`
test('probe: leaker file passes', () => { expect(1).toBe(1); });
afterAll(() => { writeReal('autopilot-run.sh'); });
`, {
      extraFiles: {
        'zz-innocent.test.ts': `
test('probe: innocent in the other file', () => { expect(1).toBe(1); });
`,
      },
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain(MARKER);
    expect(r.out).not.toContain(DURING);
    expect(r.out).toMatch(new RegExp(`${escapeRe(BEFORE)}|${escapeRe(AFTER_LAST)}`));
    if (r.out.includes('(fail) probe: innocent in the other file')) {
      expect(r.out).toContain(BEFORE);
      expect(r.out).toContain('this test is likely innocent');
    }
    expect(r.out).not.toContain('(fail) probe: leaker file passes');
  }, 30_000);

  test('multi-file: a body write in one file does not cascade into the other file (re-baseline holds across files)', () => {
    const r = runProbe(`
test('probe: writes the real wrapper', () => { writeReal('autopilot-run.sh'); expect(1).toBe(1); });
`, {
      extraFiles: {
        'zz-innocent.test.ts': `
test('probe: innocent in the other file', () => { expect(1).toBe(1); });
`,
      },
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain('(fail) probe: writes the real wrapper');
    expect(r.out).not.toContain('(fail) probe: innocent');
    expect(r.out).toMatch(/\b1 pass\b/);
    expect(r.out).toMatch(/\b1 fail\b/);
  }, 30_000);

  test('a write under GBRAIN_HOME (the isolated home) is allowed', () => {
    const r = runProbe(`
test('probe: writes only under GBRAIN_HOME', () => {
  const dir = join(process.env.GBRAIN_HOME, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'autopilot-run.sh'), '#!/bin/bash\\nexit 0\\n');
  writeFileSync(join(dir, 'env'), '# template\\n');
  expect(1).toBe(1);
});
`);
    expect(r.out).not.toContain(MARKER);
    expect(r.exitCode).toBe(0);
  }, 30_000);

  test('GBRAIN_TEST_ALLOW_REAL_HOME_WRITES=1 disarms the guard for a deliberate real-install run, and says so', () => {
    const r = runProbe(`
test('probe: writes the real wrapper, allowed', () => { writeReal('autopilot-run.sh'); expect(1).toBe(1); });
`, { env: { GBRAIN_TEST_ALLOW_REAL_HOME_WRITES: '1' } });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain(`${MARKER} DISARMED by GBRAIN_TEST_ALLOW_REAL_HOME_WRITES=1`);
    expect(r.out).toContain('never via a shell-profile export or a cwd .env');
    expect(r.out).not.toContain(DURING);
  }, 30_000);

  // The stand-down branch: when os.homedir() yields nothing usable the guard
  // registers no hooks and says so, instead of killing every `bun test` at
  // preload. A blank HOME reaches it (Bun returns $HOME verbatim, trim() empties
  // it); HOME='' does not, because Bun then falls back to the passwd entry.
  test('an unusable homedir() stands the guard down with an INACTIVE notice instead of failing the run', () => {
    const r = runProbe(`
test('probe: passes', () => { expect(1).toBe(1); });
`, { env: { HOME: '   ' } });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain(`${MARKER} INACTIVE: os.homedir() is unavailable`);
    expect(r.out).not.toContain('DISARMED');
    expect(r.out).not.toContain(DURING);
    expect(r.out).toMatch(/\b1 pass\b/);
  }, 30_000);

  // The dev-box shape: a LIVE install already exists when the run starts and
  // a test regenerates it — exactly what the pre-fix autopilot-install suite
  // did to the operator's real wrapper. Seeds both guarded files so the
  // report's "was" side is a real fingerprint, not `absent`, and drives a
  // second leak after an innocent test to prove re-baselining reports each
  // leak once, on its own test, rather than once for the first and never again.
  test('fails the test that overwrites an EXISTING wrapper + env (dev-box shape), names both, and a later leak fails on its own', () => {
    const r = runProbe(`
test('probe: overwrites the live install', () => {
  writeReal('autopilot-run.sh', '#!/bin/bash\\nexec gbrain autopilot --repo /tmp/fixture-repo\\n');
  writeReal('env', '# fixture template\\n');
  expect(1).toBe(1);
});
test('probe: innocent between', () => { expect(1).toBe(1); });
test('probe: second leak', () => { writeReal('autopilot-run.sh', '# regenerated again, different size\\n'); expect(1).toBe(1); });
`, {
      seed: {
        'autopilot-run.sh': '#!/bin/bash\n# live install\nexec gbrain autopilot --repo /path/to/brain\n',
        env: '# gbrain-owned env file\nSOME_KEY=redacted\n',
      },
    });
    expect(r.exitCode).not.toBe(0);
    // Both files land in ONE report, each with a real before-fingerprint, and
    // each with its own remediation.
    expect(r.out).toMatch(new RegExp(`~/\\.gbrain/autopilot-run\\.sh \\(${FP} -> ${FP}\\)`));
    expect(r.out).toMatch(new RegExp(`~/\\.gbrain/env \\(${FP} -> ${FP}\\)`));
    expect(r.out).toContain('to regenerate ~/.gbrain/autopilot-run.sh');
    expect(r.out).toContain('never rewrites an existing env file');
    // Re-baselined after the first report: the innocent neighbour is green and
    // the second leak is its own attributed failure, not an echo of the first.
    expect(r.out).toContain('(fail) probe: overwrites the live install');
    expect(r.out).toContain('(fail) probe: second leak');
    expect(r.out).not.toContain('(fail) probe: innocent');
    expect(r.out).toMatch(/\b1 pass\b/);
    expect(r.out).toMatch(/\b2 fail\b/);
  }, 30_000);

  test('fails the test that DELETES an existing real wrapper (present -> absent)', () => {
    const r = runProbe(`
test('probe: deletes the live wrapper', () => { rmSync(join(realDir(), 'autopilot-run.sh')); expect(1).toBe(1); });
`, { seed: { 'autopilot-run.sh': '#!/bin/bash\nexit 0\n' } });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toMatch(new RegExp(`~/\\.gbrain/autopilot-run\\.sh \\(${FP} -> absent\\)`));
    expect(r.out).toContain('(fail) probe: deletes the live wrapper');
  }, 30_000);

  // The exact pre-fix hook shape: a beforeEach that deletes the GBRAIN_HOME
  // override and an afterEach that restores it, with the write in between.
  // The restore runs BEFORE the guard's afterEach, so the guard cannot see the
  // override's value during the test; the report therefore never claims what
  // GBRAIN_HOME was — it names the likely cause and the rule instead. The
  // mutation lives in this string only and executes in the spawned child; the
  // parent file itself never touches process.env (isolation lint R1).
  test('reports the likely cause, the set-never-delete rule and the reinstall remediation for the delete-in-a-hook shape', () => {
    const r = runProbe(`
import { beforeEach, afterEach } from 'bun:test';
const childEnv = process.env;
let saved;
beforeEach(() => { saved = childEnv.GBRAIN_HOME; delete childEnv.GBRAIN_HOME; });
afterEach(() => { childEnv.GBRAIN_HOME = saved; });
test('probe: pre-fix hook shape', () => { writeReal('autopilot-run.sh'); expect(1).toBe(1); });
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain('(fail) probe: pre-fix hook shape');
    expect(r.out).toContain(DURING);
    expect(r.out).not.toContain('GBRAIN_HOME=');
    expect(r.out).toContain('deleted (or blanked) GBRAIN_HOME');
    expect(r.out).toContain('SET GBRAIN_HOME (and HOME, for the plist/unit paths) to a scratch dir in a hook, never delete it');
    expect(r.out).toContain('gbrain autopilot --install --repo <your-brain-repo>');
  }, 30_000);

  // `unreadable` branch: stat() throwing for a reason other than ENOENT (here
  // ENOTDIR — <home>/.gbrain is a regular file). An unchanged unreadable path
  // must never false-positive, and a test that then turns it into a real
  // install is still caught, reported as `unreadable -> <fingerprint>`.
  test('an unreadable guarded path never false-positives, and a later real write is still caught', () => {
    const r = runProbe(`
test('probe: innocent under an unreadable baseline', () => { expect(1).toBe(1); });
test('probe: replaces the file with a real install', () => {
  rmSync(join(realHome(), '.gbrain'));
  writeReal('autopilot-run.sh');
  expect(1).toBe(1);
});
`, { gbrainAsFile: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).not.toContain('(fail) probe: innocent');
    expect(r.out).toContain('(fail) probe: replaces the file with a real install');
    expect(r.out).toMatch(new RegExp(`~/\\.gbrain/autopilot-run\\.sh \\(unreadable -> ${FP}\\)`));
    expect(r.out).toMatch(/\b1 pass\b/);
    expect(r.out).toMatch(/\b1 fail\b/);
  }, 30_000);

  test('GBRAIN_DEBUG_PRELOAD=1 prints the guarded paths (home-relative) at preload time', () => {
    const r = runProbe(`
test('probe: passes', () => { expect(1).toBe(1); });
`, { env: { GBRAIN_DEBUG_PRELOAD: '1' } });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain(
      `${MARKER} guarding ~/.gbrain/autopilot-run.sh, ~/.gbrain/env, ~/.gbrain/start-autopilot.sh, ` +
      '~/Library/LaunchAgents/com.gbrain.autopilot.plist, ~/.config/systemd/user/gbrain-autopilot.service',
    );
    expect(r.out).not.toContain(r.home);
  }, 30_000);

  // Wiring pin: the guard enforces nothing unless bunfig.toml preloads it for
  // every `bun test` run from the repo root, alongside the isolation it backs.
  test('is wired into the bunfig.toml [test] preload chain next to gbrain-home-preload', () => {
    const bunfig = readFileSync(resolve(import.meta.dir, '..', 'bunfig.toml'), 'utf-8');
    const preloadLine = /^preload\s*=\s*\[(.*)\]/m.exec(bunfig);
    expect(preloadLine).not.toBeNull();
    const entries = [...preloadLine![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(entries).toContain('./test/helpers/real-home-guard-preload.ts');
    expect(entries).toContain('./test/helpers/gbrain-home-preload.ts');
  });

  // Source-shape pin: the guarded names are literals here AND in the
  // installer. If the installer renames an artefact, the guard's baseline
  // becomes `absent` forever and it turns silently inert — this is the test
  // that goes red instead.
  test('the guarded file names still match what `gbrain autopilot --install` writes', () => {
    const repo = resolve(import.meta.dir, '..');
    const guard = readFileSync(GUARD, 'utf-8');
    const autopilot = readFileSync(join(repo, 'src', 'commands', 'autopilot.ts'), 'utf-8');
    const paths = readFileSync(join(repo, 'src', 'core', 'autopilot-paths.ts'), 'utf-8');
    expect(autopilot).toContain("join(gbrainDir, 'autopilot-run.sh')");
    expect(autopilot).toContain("join(gbrainDir, 'env')");
    expect(autopilot).toContain("'.gbrain', 'start-autopilot.sh'");
    expect(autopilot).toContain("'Library', 'LaunchAgents'");
    expect(autopilot).toContain("'.config', 'systemd', 'user', AUTOPILOT_SYSTEMD_UNIT");
    expect(autopilot).toContain("AUTOPILOT_SYSTEMD_UNIT = 'gbrain-autopilot.service'");
    expect(paths).toContain("process.env.GBRAIN_AUTOPILOT_LABEL ?? 'com.gbrain.autopilot'");
    for (const literal of [
      "'.gbrain', 'autopilot-run.sh'",
      "'.gbrain', 'env'",
      "'.gbrain', 'start-autopilot.sh'",
      "'Library', 'LaunchAgents', 'com.gbrain.autopilot.plist'",
      "'.config', 'systemd', 'user', 'gbrain-autopilot.service'",
    ]) {
      expect(guard).toContain(literal);
    }
  });
});
