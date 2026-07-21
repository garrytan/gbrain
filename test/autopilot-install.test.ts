/**
 * Tests for env-aware `gbrain autopilot --install`.
 *
 * Covers:
 *   - detectInstallTarget picks the right target based on env vars +
 *     filesystem sentinels.
 *   - --target flag overrides detection.
 *   - Ephemeral-container path writes the start script + executable bit.
 *   - OpenClaw bootstrap injection is idempotent + creates .bak.
 *   - Uninstall mirrors all four targets and is a no-op when nothing is
 *     installed.
 *
 * Regression guards:
 *   - macOS launchd plist still writes the same shape it always did.
 *   - Linux crontab still writes the same every-5-min line.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { detectInstallTarget, generateWrapperScript, shutdownExitCode } from '../src/commands/autopilot.ts';

let tmp: string;
const envSnapshot: Record<string, string | undefined> = {};

function envKeys() {
  return ['HOME', 'RENDER', 'RAILWAY_ENVIRONMENT', 'FLY_APP_NAME', 'OPENCLAW_HOME'] as const;
}

beforeEach(() => {
  for (const k of envKeys()) envSnapshot[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-install-test-'));
  process.env.HOME = tmp;
  // Start each test with a clean slate for ephemeral env vars.
  delete process.env.RENDER;
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.FLY_APP_NAME;
  delete process.env.OPENCLAW_HOME;
});

afterEach(() => {
  for (const k of envKeys()) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('detectInstallTarget', () => {
  test('returns "macos" on darwin regardless of env', () => {
    if (process.platform !== 'darwin') return; // Skip on non-mac CI
    // Even if RENDER is set, darwin wins (user is probably dev-testing).
    process.env.RENDER = 'true';
    expect(detectInstallTarget()).toBe('macos');
  });

  test('returns "ephemeral-container" when RENDER is set', () => {
    if (process.platform === 'darwin') return; // darwin shortcircuits first
    process.env.RENDER = 'true';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  test('returns "ephemeral-container" when RAILWAY_ENVIRONMENT is set', () => {
    if (process.platform === 'darwin') return;
    process.env.RAILWAY_ENVIRONMENT = 'production';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  test('returns "ephemeral-container" when FLY_APP_NAME is set', () => {
    if (process.platform === 'darwin') return;
    process.env.FLY_APP_NAME = 'myapp';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  // Note: direct testing of linux-systemd / linux-cron requires mocking
  // existsSync + execSync which is awkward in-process. Those branches are
  // exercised by the E2E test (Task 14) against a stubbed host.
});

// v0.36.1.x (cherry-pick #966): the autopilot wrapper script must source
// ~/.zshenv BEFORE ~/.zshrc. zshenv is the canonical place for env vars in
// non-interactive zsh; zshrc only fires for interactive shells, so vars
// exported in zshrc never reach the LaunchAgent subprocess. Operators who
// exported GBRAIN_DATABASE_URL or {OPENAI,ANTHROPIC}_API_KEY in zshrc and
// expected autopilot to inherit them hit silent missing-secret failures.
// issue #1868: the wrapper runs under systemd/cron with a minimal PATH and the
// zsh profiles it sources are a macOS convention that often doesn't exist on a
// Linux server. A bun-shebang gbrain shim then dies with "bun: not found" and
// the service crash-loops. The generator must bake the install-time runtime
// dirs (gbrain's dir, the running runtime's dir, ~/.bun/bin) onto PATH, AFTER
// profile sourcing so they win even if a profile reset PATH.
describe('generateWrapperScript — runtime PATH baked in (#1868)', () => {
  const script = generateWrapperScript('/usr/local/bin/gbrain', '/srv/brain', {
    home: '/home/u',
    execPath: '/home/u/.bun/bin/bun',
  });

  test('prepends gbrain dir, runtime dir, and ~/.bun/bin to PATH', () => {
    expect(script).toContain(`export PATH='/usr/local/bin:/home/u/.bun/bin':"$PATH"`);
  });

  test('PATH export comes AFTER profile sourcing (profiles must not clobber it)', () => {
    const pathIdx = script.indexOf('export PATH=');
    const zshrcIdx = script.indexOf('~/.zshrc');
    const bashrcIdx = script.indexOf('~/.bashrc');
    expect(pathIdx).toBeGreaterThan(zshrcIdx);
    expect(pathIdx).toBeGreaterThan(bashrcIdx);
  });

  test('PATH export comes BEFORE the exec line', () => {
    expect(script.indexOf('export PATH=')).toBeLessThan(script.indexOf('exec '));
  });

  test('exec line uses the resolved gbrain path + repo', () => {
    expect(script).toContain(`exec '/usr/local/bin/gbrain' autopilot --repo '/srv/brain'`);
  });

  test('deduplicates identical dirs', () => {
    const s = generateWrapperScript('/opt/bin/gbrain', '/repo', { home: '', execPath: '/opt/bin/bun' });
    expect(s).toContain(`export PATH='/opt/bin':"$PATH"`);
  });

  test('never emits an empty PATH entry (cwd injection) when nothing resolves', () => {
    const s = generateWrapperScript('gbrain', '/repo', { home: '', execPath: '' });
    expect(s).not.toContain(`PATH='':`);
    expect(s).not.toMatch(/export PATH=''/);
  });

  test('single-quote-escapes hostile dirs', () => {
    const s = generateWrapperScript("/tmp/o'brien/gbrain", '/repo', { home: '', execPath: '' });
    expect(s).toContain(`'/tmp/o'\\''brien'`);
  });
});

// issue #2234 (part 2): a daemon that GIVES UP (max_crashes /
// cycle-failure-cap) must exit non-zero so systemd Restart=on-failure
// restarts it; pre-fix it exited 0 and stayed silently dead for days.
// Operator-initiated stops stay 0.
describe('shutdownExitCode (#2234)', () => {
  test('give-up paths exit non-zero', () => {
    expect(shutdownExitCode('max_crashes')).toBe(1);
    expect(shutdownExitCode('cycle-failure-cap')).toBe(1);
  });

  test('signal-driven stops exit 0', () => {
    expect(shutdownExitCode('SIGTERM')).toBe(0);
    expect(shutdownExitCode('SIGINT')).toBe(0);
  });
});

describe('autopilot wrapper script — env source order (v0.36.1.x #966)', () => {
  test('wrapper sources ~/.zshenv before ~/.zshrc', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/autopilot.ts', 'utf8');
    const zshenvIdx = src.indexOf('~/.zshenv');
    const zshrcIdx = src.indexOf('~/.zshrc');
    expect(zshenvIdx).toBeGreaterThan(0);
    expect(zshrcIdx).toBeGreaterThan(0);
    expect(zshenvIdx).toBeLessThan(zshrcIdx);
    // Both should appear inside writeWrapperScript's heredoc as `source ~/.foo`
    expect(src).toMatch(/source\s+~\/\.zshenv/);
    expect(src).toMatch(/source\s+~\/\.zshrc/);
  });
});
