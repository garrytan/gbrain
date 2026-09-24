import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const guard = join(root, 'test/helpers/real-home-guard-preload.ts');
const artifacts = [
  '.gbrain/autopilot-run.sh',
  '.gbrain/env',
  '.gbrain/start-autopilot.sh',
  'Library/LaunchAgents/com.gbrain.autopilot.plist',
  '.config/systemd/user/gbrain-autopilot.service',
];

function fixture(run: (home: string, env: Record<string, string>) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-home-sentinel-'));
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    GBRAIN_HOME: join(home, 'isolated'),
    GBRAIN_TEST_EXPECTED_HOME: home,
    GBRAIN_NO_AUTOPILOT_INSTALL: '1',
  };
  for (const path of artifacts) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), 'fake-live-sentinel\n');
  }
  try {
    const canary = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(require("node:os").homedir())'], {
      cwd: home, env, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    expect(canary.exitCode).toBe(0);
    expect(canary.stdout.toString()).toBe(home);
    run(home, env);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function probe(body: string, options: { disarmed?: boolean; seed?: boolean } = {}) {
  let result!: { exitCode: number; output: string };
  fixture((home, env) => {
    if (options.disarmed) env.GBRAIN_TEST_ALLOW_REAL_HOME_WRITES = '1';
    if (options.seed === false) rmSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, 'probe.test.ts'), `
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
const home = homedir();
if (home !== process.env.GBRAIN_TEST_EXPECTED_HOME) throw new Error('probe containment failed');
function touch(path) {
  const target = join(home, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'probe mutation');
}
${body}
`);
    const child = Bun.spawnSync([process.execPath, 'test', '--preload', guard, './probe.test.ts'], {
      cwd: home, env, stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
    });
    result = { exitCode: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
  });
  return result;
}

describe('real-home guard', () => {
  test('the complete autopilot install suite leaves fake-live sentinels untouched', () => {
    fixture((home, env) => {
      const child = Bun.spawnSync([process.execPath, 'test', './test/autopilot-install.test.ts'], {
        cwd: root, env, stdout: 'pipe', stderr: 'pipe', timeout: 45_000,
      });
      for (const path of artifacts) expect(readFileSync(join(home, path), 'utf8')).toBe('fake-live-sentinel\n');
      expect(child.exitCode).toBe(0);
    });
  });

  for (const path of artifacts) {
    test(`detects writes to ${path} without blaming subsequent tests`, () => {
      const result = probe(`
test('mutating probe', () => touch(${JSON.stringify(path)}));
test('innocent probe', () => expect(true).toBe(true));
`);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('[real-home-guard-preload]');
      expect(result.output).toContain(`~/${path}`);
      expect(result.output).toContain('(fail) mutating probe');
      expect(result.output).toContain('(pass) innocent probe');
    });
  }

  test('detects creation and deletion, including a last afterAll write', () => {
    const created = probe(`test('create', () => touch('.gbrain/env'));`, { seed: false });
    expect(created.exitCode).not.toBe(0);
    expect(created.output).toContain('absent ->');
    const deleted = probe(`test('delete', () => rmSync(join(home, '.gbrain/env')));`);
    expect(deleted.exitCode).not.toBe(0);
    expect(deleted.output).toContain('-> absent');
    const after = probe(`test('clean', () => {}); afterAll(() => touch('.gbrain/env'));`);
    expect(after.exitCode).not.toBe(0);
    expect(after.output).toContain('after the last test');
  });

  test('distinguishes beforeAll writes from a test body leak', () => {
    const result = probe(`beforeAll(() => touch('.gbrain/env')); test('clean', () => {});`);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('BEFORE this test');
    expect(result.output).toContain('never rewrites an existing env file');
  });

  test('allows isolated writes and announces explicit disarming', () => {
    const isolated = probe(`test('isolated', () => touch('isolated/.gbrain/env'));`);
    expect(isolated.exitCode).toBe(0);
    expect(isolated.output).not.toContain('[real-home-guard-preload]');
    const disarmed = probe(`test('deliberate', () => touch('.gbrain/env'));`, { disarmed: true });
    expect(disarmed.exitCode).toBe(0);
    expect(disarmed.output).toContain('DISARMED');
  });
});
