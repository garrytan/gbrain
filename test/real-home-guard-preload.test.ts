/**
 * Self-test for test/helpers/real-home-guard-preload.ts.
 *
 * Each case generates a throwaway probe test file and spawns a real
 * `bun test --preload <guard>` child on it with HOME pointed at a scratch
 * directory. A child Bun honors HOME at process start — it is only a RUNTIME
 * mutation that os.homedir() ignores — so the guard in the child watches a
 * "real" home this test owns. What is asserted is the guard's actual behavior,
 * not a re-implementation of it, and the operator's true ~/.gbrain is never
 * touched.
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
// One guarded-file fingerprint as the guard prints it: size:mtimeMs:ctimeMs:ino.
const FP = '\\d+:[\\d.]+:[\\d.]+:\\d+';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Shared probe prelude: writeReal() writes into the CHILD's homedir()/.gbrain,
// which the parent has pointed at scratch via HOME.
const PROBE_PRELUDE = `import { test, expect, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
function writeReal(name) {
  const dir = join(homedir(), '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), '# written by probe\\n');
}
`;

function childEnv(home: string, gbrainHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.HOME = home;
  env.GBRAIN_HOME = gbrainHome;
  // An ambient GBRAIN_DEBUG_PRELOAD=1 in the operator's shell would make the
  // guard print its marker on every run; the debug case opts back in explicitly.
  delete env.GBRAIN_DEBUG_PRELOAD;
  return env;
}

type ProbeOpts = {
  /** Files to create under <home>/.gbrain BEFORE the child starts — the
   *  dev-box shape, where a live install already exists at preload time. */
  seed?: Record<string, string>;
  /** Make <home>/.gbrain a regular FILE, so stat() of both guarded paths
   *  throws ENOTDIR (which, unlike ENOENT, `throwIfNoEntry: false` does not
   *  swallow) and the guard's baseline for them is `unreadable`. */
  gbrainAsFile?: boolean;
  /** Extra child env; `undefined` deletes the key. */
  env?: Record<string, string | undefined>;
};

function runProbe(
  probeBody: string,
  opts: ProbeOpts = {},
): { exitCode: number; out: string; home: string; gbrainHome: string } {
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
  const probe = join(root, 'probe.test.ts');
  writeFileSync(probe, PROBE_PRELUDE + probeBody);
  const env = childEnv(home, gbrainHome);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    const proc = Bun.spawnSync(['bun', 'test', '--timeout=15000', '--preload', GUARD, probe], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      // A hung child would otherwise block the sync call past bun's own
      // per-test timeout (which cannot preempt a native sync call).
      timeout: 20_000,
      killSignal: 'SIGKILL',
    });
    return {
      exitCode: proc.exitCode ?? -1,
      out: proc.stdout.toString() + proc.stderr.toString(),
      home,
      gbrainHome,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('real-home-guard-preload', () => {
  test('fails the exact test that writes the real ~/.gbrain/autopilot-run.sh, without cascading', () => {
    const r = runProbe(`
test('probe: innocent before', () => { expect(1).toBe(1); });
test('probe: writes the real wrapper', () => { writeReal('autopilot-run.sh'); expect(1).toBe(1); });
test('probe: innocent after', () => { expect(1).toBe(1); });
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain(MARKER);
    expect(r.out).toContain(join(r.home, '.gbrain', 'autopilot-run.sh'));
    // Attributed to the writer by name; the neighbours stay green.
    expect(r.out).toContain('(fail) probe: writes the real wrapper');
    expect(r.out).not.toContain('(fail) probe: innocent');
    expect(r.out).toMatch(/\b2 pass\b/);
    expect(r.out).toMatch(/\b1 fail\b/);
  }, 30_000);

  test('fails on a write to the real ~/.gbrain/env too', () => {
    const r = runProbe(`
test('probe: writes the real env file', () => { writeReal('env'); expect(1).toBe(1); });
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain(MARKER);
    expect(r.out).toContain(join(r.home, '.gbrain', 'env'));
    expect(r.out).toContain('(fail) probe: writes the real env file');
  }, 30_000);

  test('the end-of-run backstop catches a write from a file-level afterAll', () => {
    const r = runProbe(`
test('probe: passes', () => { expect(1).toBe(1); });
afterAll(() => { writeReal('autopilot-run.sh'); });
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain(MARKER);
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

  // The dev-box shape: a LIVE install already exists when the run starts and
  // a test regenerates it — exactly what the pre-fix autopilot-install suite
  // did to the operator's real wrapper. Seeds both guarded files so the
  // report's "was" side is a real fingerprint, not `absent`, and drives a
  // second leak after an innocent test to prove re-baselining reports each
  // leak once, on its own test, rather than once for the first and never again.
  test('fails the test that overwrites an EXISTING wrapper + env (dev-box shape), names both, and a later leak fails on its own', () => {
    const r = runProbe(`
function writeRealAs(name, content) { writeFileSync(join(homedir(), '.gbrain', name), content); }
test('probe: overwrites the live install', () => {
  writeRealAs('autopilot-run.sh', '#!/bin/bash\\nexec gbrain autopilot --repo /tmp/fixture-repo\\n');
  writeRealAs('env', '# fixture template\\n');
  expect(1).toBe(1);
});
test('probe: innocent between', () => { expect(1).toBe(1); });
test('probe: second leak', () => { writeRealAs('autopilot-run.sh', '# regenerated again, different size\\n'); expect(1).toBe(1); });
`, {
      seed: {
        'autopilot-run.sh': '#!/bin/bash\n# live install\nexec gbrain autopilot --repo /path/to/brain\n',
        env: '# gbrain-owned env file\nSOME_KEY=redacted\n',
      },
    });
    expect(r.exitCode).not.toBe(0);
    // Both files land in ONE report, each with a real before-fingerprint.
    const wrapper = escapeRe(join(r.home, '.gbrain', 'autopilot-run.sh'));
    const envFile = escapeRe(join(r.home, '.gbrain', 'env'));
    expect(r.out).toMatch(new RegExp(`${wrapper} \\(${FP} -> ${FP}\\)`));
    expect(r.out).toMatch(new RegExp(`${envFile} \\(${FP} -> ${FP}\\)`));
    // The override was SET here — the report says where it pointed.
    expect(r.out).toContain(`GBRAIN_HOME=${r.gbrainHome} at check time`);
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
import { rmSync } from 'node:fs';
test('probe: deletes the live wrapper', () => { rmSync(join(homedir(), '.gbrain', 'autopilot-run.sh')); expect(1).toBe(1); });
`, { seed: { 'autopilot-run.sh': '#!/bin/bash\nexit 0\n' } });
    expect(r.exitCode).not.toBe(0);
    const wrapper = escapeRe(join(r.home, '.gbrain', 'autopilot-run.sh'));
    expect(r.out).toMatch(new RegExp(`${wrapper} \\(${FP} -> absent\\)`));
    expect(r.out).toContain('(fail) probe: deletes the live wrapper');
  }, 30_000);

  // The exact pre-fix hook shape: a beforeEach that deletes the GBRAIN_HOME override,
  // then a write through the homedir() fallback (test/gbrain-home-isolation
  // pins that configDir() resolves there once the override is gone). The
  // report must say the override was UNSET at check time and carry both the
  // rule (set, never delete) and the operator's reinstall remediation.
  test('reports GBRAIN_HOME=<unset>, the set-never-delete rule, and the reinstall remediation for the delete-in-a-hook shape', () => {
    // This probe source runs only in the spawned child; the alias keeps the
    // parent file free of the literal env-mutation shape that
    // scripts/check-test-isolation.sh (R1) bans for in-process tests.
    const r = runProbe(`
import { beforeEach } from 'bun:test';
const childEnv = process.env;
beforeEach(() => { delete childEnv.GBRAIN_HOME; });
test('probe: pre-fix hook shape', () => { writeReal('autopilot-run.sh'); expect(1).toBe(1); });
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain('(fail) probe: pre-fix hook shape');
    expect(r.out).toContain('GBRAIN_HOME=<unset> at check time');
    expect(r.out).toContain('SET it in a hook, never delete it');
    expect(r.out).toContain('gbrain autopilot --install --repo <your-brain-repo>');
  }, 30_000);

  // `unreadable` branch: stat() throwing for a reason other than ENOENT (here
  // ENOTDIR — <home>/.gbrain is a regular file). An unchanged unreadable path
  // must never false-positive, and a test that then turns it into a real
  // install is still caught, reported as `unreadable -> <fingerprint>`.
  test('an unreadable guarded path never false-positives, and a later real write is still caught', () => {
    const r = runProbe(`
import { rmSync } from 'node:fs';
test('probe: innocent under an unreadable baseline', () => { expect(1).toBe(1); });
test('probe: replaces the file with a real install', () => {
  rmSync(join(homedir(), '.gbrain'));
  writeReal('autopilot-run.sh');
  expect(1).toBe(1);
});
`, { gbrainAsFile: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).not.toContain('(fail) probe: innocent');
    expect(r.out).toContain('(fail) probe: replaces the file with a real install');
    const wrapper = escapeRe(join(r.home, '.gbrain', 'autopilot-run.sh'));
    expect(r.out).toMatch(new RegExp(`${wrapper} \\(unreadable -> ${FP}\\)`));
    expect(r.out).toMatch(/\b1 pass\b/);
    expect(r.out).toMatch(/\b1 fail\b/);
  }, 30_000);

  test('GBRAIN_DEBUG_PRELOAD=1 prints the guarded paths at preload time', () => {
    const r = runProbe(`
test('probe: passes', () => { expect(1).toBe(1); });
`, { env: { GBRAIN_DEBUG_PRELOAD: '1' } });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain(
      `${MARKER} guarding ${join(r.home, '.gbrain', 'autopilot-run.sh')}, ${join(r.home, '.gbrain', 'env')}`,
    );
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
});
