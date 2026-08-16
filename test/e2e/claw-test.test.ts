/**
 * gbrain claw-test scripted-mode E2E.
 *
 * Invokes the harness via `bun run src/cli.ts` (NOT a compiled binary —
 * `bun build --compile` doesn't bundle PGLite's runtime assets like
 * pglite.data, so a compiled gbrain can't init a fresh PGLite brain).
 * Uses a tiny shim script that the harness can spawn as if it were the
 * gbrain binary.
 *
 * Asserts:
 *   - exit code 0 on a clean tree
 *   - the friction JSONL has zero error/blocker entries
 *   - the harness recorded progress events for the expected phases
 *
 * Tagged-skip env: CLAW_TEST_SKIP_E2E=1 to opt out (e.g. when PGLite
 * WASM is broken on the host — the macOS 26.3 #223 bug class).
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const BIN_CACHE = join(REPO_ROOT, 'test', '.cache');
const BIN_PATH = join(BIN_CACHE, 'gbrain.sh');
const SCENARIOS_DIR = join(REPO_ROOT, 'test', 'fixtures', 'claw-test-scenarios');

beforeAll(() => {
  if (!existsSync(BIN_CACHE)) mkdirSync(BIN_CACHE, { recursive: true });
  // Shim that delegates to `bun run src/cli.ts` so PGLite assets resolve from
  // the source tree (bun --compile doesn't bundle them). Marked executable so
  // child_process.spawn can run it directly.
  const shim = `#!/bin/sh\nexec bun run "${join(REPO_ROOT, 'src', 'cli.ts')}" "$@"\n`;
  writeFileSync(BIN_PATH, shim, 'utf-8');
  chmodSync(BIN_PATH, 0o755);
}, 30_000);

describe('gbrain claw-test --scenario fresh-install (scripted)', () => {
  test('runs end-to-end clean and produces zero error/blocker friction', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-fresh-'));
    try {
      const result = spawnSync(BIN_PATH, ['claw-test', '--scenario', 'fresh-install', '--keep-tempdir'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GBRAIN_HOME: tmp,
          GBRAIN_BIN_OVERRIDE: BIN_PATH,
          GBRAIN_CLAW_SCENARIOS_DIR: join(REPO_ROOT, 'test', 'fixtures', 'claw-test-scenarios'),
        },
        encoding: 'utf-8',
        timeout: 120_000,
      });
      if (result.status !== 0) {
        console.error('STDOUT:', result.stdout);
        console.error('STDERR:', result.stderr);
      }
      expect(result.status).toBe(0);

      // Inspect the friction JSONL the harness wrote.
      const frictionDir = join(tmp, '.gbrain', 'friction');
      expect(existsSync(frictionDir)).toBe(true);
      const files = readdirSync(frictionDir).filter(f => f.endsWith('.jsonl'));
      expect(files.length).toBeGreaterThan(0);
      const runFile = join(frictionDir, files[0]);
      const lines = readFileSync(runFile, 'utf-8').split('\n').filter(l => l.trim());
      const entries = lines.map(l => JSON.parse(l));
      const blockers = entries.filter(e => e.kind === 'friction' && (e.severity === 'error' || e.severity === 'blocker'));
      if (blockers.length > 0) {
        console.error('unexpected friction entries:', blockers);
      }
      expect(blockers.length).toBe(0);

      // REGRESSION pin: scripted runs stamp agent 'scripted' (previously the
      // misleading parseArgs default 'openclaw'). friction diff's agent-name
      // resolution reads this stamp off the start marker.
      expect(entries[0].kind).toBe('phase-marker');
      expect(entries[0].marker).toBe('start');
      expect(entries[0].agent).toBe('scripted');
      expect(entries[0].scenario).toBe('fresh-install');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000);

  test('break path: an invented command produces an error friction entry and exits non-zero', () => {
    // We do this by setting GBRAIN_BIN_OVERRIDE to a script that pretends to be gbrain
    // and rejects the `import` subcommand specifically.
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-break-'));
    const fakeBin = join(tmp, 'fake-gbrain');
    try {
      // Write a shim that delegates to real gbrain but rejects 'import' to simulate breakage.
      const shimContent = `#!/bin/sh\nif [ "$1" = "import" ]; then echo "fake import error" >&2; exit 17; fi\nexec "${BIN_PATH}" "$@"\n`;
      const { writeFileSync, chmodSync } = require('fs');
      writeFileSync(fakeBin, shimContent, 'utf-8');
      chmodSync(fakeBin, 0o755);

      const result = spawnSync(BIN_PATH, ['claw-test', '--scenario', 'fresh-install', '--keep-tempdir'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GBRAIN_HOME: tmp,
          GBRAIN_BIN_OVERRIDE: fakeBin,
          GBRAIN_CLAW_SCENARIOS_DIR: join(REPO_ROOT, 'test', 'fixtures', 'claw-test-scenarios'),
        },
        encoding: 'utf-8',
        timeout: 60_000,
      });
      expect(result.status).not.toBe(0);

      // The friction log should have an error-severity entry for the 'import' phase.
      const frictionDir = join(tmp, '.gbrain', 'friction');
      const files = readdirSync(frictionDir).filter(f => f.endsWith('.jsonl'));
      const lines = readFileSync(join(frictionDir, files[0]), 'utf-8').split('\n').filter(l => l.trim());
      const entries = lines.map(l => JSON.parse(l));
      const importErrors = entries.filter(e => e.phase === 'import' && e.severity === 'error');
      expect(importErrors.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('gbrain claw-test --list-agents', () => {
  test('reports all four built-in runners (available or not — both valid states)', () => {
    // *_BIN vars point at a nonexistent path so the output shape is
    // deterministic regardless of what's installed on the box (detect
    // rejects a non-stat-able absolute path with a specific reason).
    const result = spawnSync(BIN_PATH, ['claw-test', '--list-agents'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HERMES_BIN: '/nonexistent/hermes',
        OPENCLAW_BIN: '/nonexistent/openclaw',
        GROK_BIN: '/nonexistent/grok',
        OPENCODE_BIN: '/nonexistent/opencode',
      },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^grok: unavailable: /m);
    expect(result.stdout).toMatch(/^hermes: unavailable: /m);
    expect(result.stdout).toMatch(/^opencode: unavailable: /m);
    expect(result.stdout).toMatch(/^openclaw: unavailable: /m);
    // Alphabetical print order (the awaited-detection fix pins this).
    // NB: 'openclaw' sorts BEFORE 'opencode' ('l' < 'o' at position 5).
    expect(result.stdout.indexOf('grok:')).toBeLessThan(result.stdout.indexOf('hermes:'));
    expect(result.stdout.indexOf('hermes:')).toBeLessThan(result.stdout.indexOf('openclaw:'));
    expect(result.stdout.indexOf('openclaw:')).toBeLessThan(result.stdout.indexOf('opencode:'));
  }, 60_000);
});

describe('gbrain claw-test --live (shim agents; no real agent binary, no tokens)', () => {
  // The OpenClaw runner honors an absolute $OPENCLAW_BIN pointing at any
  // executable, so these tests drive live mode with tiny sh shims. That
  // exercises the REAL live path: staging, the PATH shim, the agent turn,
  // the success oracle, and the E0 friction merge.

  function runLiveWithShim(shimBody: string, scenario: string, extraEnv: Record<string, string> = {}) {
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-live-'));
    const shim = join(tmp, 'agent-shim');
    writeFileSync(shim, shimBody, 'utf-8');
    chmodSync(shim, 0o755);
    const result = spawnSync(BIN_PATH, ['claw-test', '--live', '--agent', 'openclaw', '--scenario', scenario], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GBRAIN_HOME: tmp,
        OPENCLAW_BIN: shim,
        GBRAIN_BIN_OVERRIDE: BIN_PATH,
        GBRAIN_CLAW_SCENARIOS_DIR: extraEnv.GBRAIN_CLAW_SCENARIOS_DIR ?? SCENARIOS_DIR,
        ...extraEnv,
      },
      encoding: 'utf-8',
      timeout: 180_000,
    });
    const frictionDirPath = join(tmp, '.gbrain', 'friction');
    const entries: any[] = [];
    if (existsSync(frictionDirPath)) {
      for (const f of readdirSync(frictionDirPath).filter(f => f.endsWith('.jsonl'))) {
        for (const line of readFileSync(join(frictionDirPath, f), 'utf-8').split('\n')) {
          if (line.trim()) entries.push(JSON.parse(line));
        }
      }
    }
    return { tmp, result, entries };
  }

  test('oracle break path: a do-nothing agent that exits 0 now FAILS the run', () => {
    const { tmp, result, entries } = runLiveWithShim('#!/bin/sh\nexit 0\n', 'fresh-install');
    try {
      expect(result.status).not.toBe(0);
      const verifyErrors = entries.filter(e => e.phase === 'verify' && e.severity === 'error');
      expect(verifyErrors.length).toBeGreaterThan(0);
      // The run-start meta record (agent-name resolution depends on it) is the
      // FIRST line and carries agent + scenario.
      expect(entries[0].kind).toBe('phase-marker');
      expect(entries[0].marker).toBe('start');
      expect(entries[0].agent).toBe('openclaw');
      expect(entries[0].scenario).toBe('fresh-install');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000);

  test('working agent passes the oracle AND its child-side friction survives tempdir cleanup (E0 merge)', () => {
    // The shim does the brief's work via BARE `gbrain` (proving the PATH shim
    // resolves to this checkout) and logs one agent-side friction entry, which
    // lands under the run's hermetic GBRAIN_HOME — the dir the harness deletes.
    const shim = [
      '#!/bin/sh',
      'set -e',
      'gbrain import ./brain --no-embed',
      'gbrain skillpack scaffold query --workspace "$PWD"',
      'gbrain friction log --phase agent-side --severity nit --message "child entry survives cleanup"',
      '',
    ].join('\n');
    const { tmp, result, entries } = runLiveWithShim(shim, 'fresh-install');
    try {
      if (result.status !== 0) {
        console.error('STDOUT:', result.stdout);
        console.error('STDERR:', result.stderr);
      }
      expect(result.status).toBe(0);
      const blockers = entries.filter(e => e.kind === 'friction' && (e.severity === 'error' || e.severity === 'blocker'));
      expect(blockers.length).toBe(0);
      // E0: the child-side entry was written under the (deleted) runRoot but
      // must appear in the parent's friction file.
      const childSide = entries.filter(e => e.phase === 'agent-side' && e.message.includes('child entry survives cleanup'));
      expect(childSide.length).toBe(1);
      // Completion marker paired with the start marker.
      const endMarkers = entries.filter(e => e.kind === 'phase-marker' && e.marker === 'end' && e.phase === 'harness');
      expect(endMarkers.length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000);

  test('REGRESSION (upgrade): staging seeds first and the schema-version oracle fails a do-nothing agent', () => {
    // Synthetic upgrade scenario: a minimal "old brain" dump that records
    // config.version = 1. The do-nothing agent never advances the migration
    // chain, so the non-mutating pre/post probe must fail the run. (A
    // doctor-based oracle would auto-migrate on connect and pass vacuously —
    // the exact bug class this oracle exists to prevent.)
    const scenRoot = mkdtempSync(join(tmpdir(), 'claw-test-e2e-upg-scen-'));
    const scenDir = join(scenRoot, 'upgrade-synthetic');
    mkdirSync(join(scenDir, 'seed'), { recursive: true });
    writeFileSync(join(scenDir, 'scenario.json'), JSON.stringify({
      kind: 'upgrade',
      from_version: '0.0.1',
      expected_phases: [],
      seed: 'seed',
    }), 'utf-8');
    writeFileSync(join(scenDir, 'BRIEF.md'), '# Upgrade brief\n\nRun `gbrain doctor --json` to walk the migration chain forward.\n', 'utf-8');
    writeFileSync(join(scenDir, 'seed', 'dump.sql'), [
      "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);",
      "INSERT INTO config (key, value) VALUES ('version', '1');",
      '',
    ].join('\n'), 'utf-8');

    const { tmp, result, entries } = runLiveWithShim('#!/bin/sh\nexit 0\n', 'upgrade-synthetic', {
      GBRAIN_CLAW_SCENARIOS_DIR: scenRoot,
    });
    try {
      expect(result.status).not.toBe(0);
      const verifyErrors = entries.filter(e => e.phase === 'verify' && e.severity === 'error');
      expect(verifyErrors.length).toBe(1);
      expect(verifyErrors[0].message).toContain('did not advance');
      // pre=1 proves the seeded PGLite existed BEFORE the agent turn.
      expect(verifyErrors[0].message).toContain('pre=1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(scenRoot, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('gbrain claw-test — adversarial-gate regression pins', () => {
  test('P1: without GBRAIN_BIN_OVERRIDE the harness synthesizes a bun launcher (children run gbrain, not bun)', () => {
    // Under `bun run src/cli.ts`, process.execPath is the Bun runtime; the
    // pre-fix fallback handed children `bun init …`, which scaffolds a Bun
    // project and fails the rest of the run. Exit 0 proves the synthesized
    // launcher resolved children to real gbrain.
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-noovr-'));
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        GBRAIN_HOME: tmp,
        GBRAIN_CLAW_SCENARIOS_DIR: SCENARIOS_DIR,
      };
      delete env.GBRAIN_BIN_OVERRIDE;
      const result = spawnSync(BIN_PATH, ['claw-test', '--scenario', 'fresh-install'], {
        cwd: REPO_ROOT,
        env: env as NodeJS.ProcessEnv,
        encoding: 'utf-8',
        timeout: 150_000,
      });
      if (result.status !== 0) {
        console.error('STDOUT:', result.stdout);
        console.error('STDERR:', result.stderr);
      }
      expect(result.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000);

  test('scripted upgrade with the shipped fixture fails LOUDLY (no false-green upgrade without a seed dump)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-upgloud-'));
    try {
      const result = spawnSync(BIN_PATH, ['claw-test', '--scenario', 'upgrade-from-v0.18'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GBRAIN_HOME: tmp,
          GBRAIN_BIN_OVERRIDE: BIN_PATH,
          GBRAIN_CLAW_SCENARIOS_DIR: SCENARIOS_DIR,
        },
        encoding: 'utf-8',
        timeout: 60_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no seed dump');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 90_000);

  test('charset guard: traversal-shaped scenario and agent values are usage errors, exit 2', () => {
    for (const argv of [
      ['claw-test', '--scenario', '../evil'],
      ['claw-test', '--agent', 'x/y', '--scenario', 'fresh-install'],
    ]) {
      const result = spawnSync(BIN_PATH, argv, {
        cwd: REPO_ROOT,
        env: { ...process.env, GBRAIN_CLAW_SCENARIOS_DIR: SCENARIOS_DIR },
        encoding: 'utf-8',
        timeout: 30_000,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('invalid');
    }
  }, 60_000);

  test('phase timeout: a hung gbrain child is killed at GBRAIN_CLAW_PHASE_TIMEOUT_MS instead of wedging the run', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-hang-'));
    const hangBin = join(tmp, 'hang-gbrain');
    try {
      writeFileSync(hangBin, `#!/bin/sh\nif [ "$1" = "init" ]; then sleep 45; fi\nexec "${BIN_PATH}" "$@"\n`, 'utf-8');
      chmodSync(hangBin, 0o755);
      const result = spawnSync(BIN_PATH, ['claw-test', '--scenario', 'fresh-install'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GBRAIN_HOME: tmp,
          GBRAIN_BIN_OVERRIDE: hangBin,
          GBRAIN_CLAW_SCENARIOS_DIR: SCENARIOS_DIR,
          GBRAIN_CLAW_PHASE_TIMEOUT_MS: '2000',
        },
        encoding: 'utf-8',
        timeout: 35_000,
      });
      // If the phase timeout were unwired, init would sleep past spawnSync's
      // own kill and status would be null with signal SIGTERM.
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('fail-closed doctor oracle: doctor exiting 0 with unparsable output FAILS the live run', () => {
    // A wrapper gbrain that answers `doctor` with a non-JSON banner and exit 0
    // — the pre-fix oracle only rejected literal "unhealthy" and passed this.
    const scratch = mkdtempSync(join(tmpdir(), 'claw-test-e2e-docgarb-'));
    const wrapper = join(scratch, 'doctor-garbage-gbrain');
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "doctor" ]; then echo "banner: everything is fine (not json)"; exit 0; fi\nexec "${BIN_PATH}" "$@"\n`, 'utf-8');
    chmodSync(wrapper, 0o755);
    const workShim = [
      '#!/bin/sh',
      'set -e',
      'gbrain import ./brain --no-embed',
      'gbrain skillpack scaffold query --workspace "$PWD"',
      '',
    ].join('\n');
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-live-docgarb-'));
    const shim = join(tmp, 'agent-shim');
    writeFileSync(shim, workShim, 'utf-8');
    chmodSync(shim, 0o755);
    try {
      const result = spawnSync(BIN_PATH, ['claw-test', '--live', '--agent', 'openclaw', '--scenario', 'fresh-install'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GBRAIN_HOME: tmp,
          OPENCLAW_BIN: shim,
          GBRAIN_BIN_OVERRIDE: wrapper,
          GBRAIN_CLAW_SCENARIOS_DIR: SCENARIOS_DIR,
        },
        encoding: 'utf-8',
        timeout: 180_000,
      });
      expect(result.status).not.toBe(0);
      const frictionDirPath = join(tmp, '.gbrain', 'friction');
      const entries: any[] = [];
      for (const f of readdirSync(frictionDirPath).filter(f => f.endsWith('.jsonl'))) {
        for (const line of readFileSync(join(frictionDirPath, f), 'utf-8').split('\n')) {
          if (line.trim()) entries.push(JSON.parse(line));
        }
      }
      const unparsable = entries.filter(e => e.phase === 'verify' && typeof e.message === 'string' && e.message.includes('unparsable'));
      expect(unparsable.length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('gbrain friction render integration', () => {
  test('render produces a markdown report with the redact placeholder', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claw-test-e2e-render-'));
    try {
      // Log a friction entry with $HOME embedded, then render --redact md
      const home = process.env.HOME ?? '/tmp';
      const env = { ...process.env, GBRAIN_HOME: tmp, GBRAIN_FRICTION_RUN_ID: 'render-e2e' };
      execFileSync(BIN_PATH, ['friction', 'log', '--phase', 'p', '--message', `error at ${home}/.gbrain/x`], { env, encoding: 'utf-8' });
      const out = execFileSync(BIN_PATH, ['friction', 'render', '--run-id', 'render-e2e'], { env, encoding: 'utf-8' });
      expect(out).toContain('# Friction report');
      expect(out).toContain('<HOME>');
      // --redact is the default for md, so home itself should not appear.
      expect(out).not.toContain(home + '/.gbrain');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
