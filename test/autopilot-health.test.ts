import { describe, expect, test } from 'bun:test';
import {
  autopilotLockPath,
  autopilotLogPath,
  autopilotPlistPath,
  autopilotSystemdUnitPath,
  buildAutopilotHealth,
} from '../src/core/autopilot-health.ts';

function makeExec(responses: Record<string, string | Error>) {
  return ((command: string) => {
    const response = responses[command];
    if (response instanceof Error) throw response;
    return response ?? '';
  }) as typeof import('node:child_process').execSync;
}

function makeRead(files: Record<string, string>) {
  return ((filePath: string) => {
    if (!(filePath in files)) throw new Error(`ENOENT: ${filePath}`);
    return files[filePath]!;
  }) as typeof import('node:fs').readFileSync;
}

function makeExists(existing: string[]) {
  const set = new Set(existing);
  return ((filePath: string) => set.has(filePath)) as typeof import('node:fs').existsSync;
}

describe('buildAutopilotHealth', () => {
  test('macOS artifact present but launchd not loaded → installed yes, loaded no', () => {
    const home = '/tmp/home-macos';
    const gbrainHome = '/tmp/gbrain-macos';
    const plist = autopilotPlistPath(home);
    const log = autopilotLogPath(home);
    const health = buildAutopilotHealth({
      platform: 'darwin',
      home,
      gbrainHome,
      existsSync: makeExists([plist, log]),
      readFileSync: makeRead({ [log]: 'first line\nsecond line\n' }),
      execSync: makeExec({
        'launchctl list com.gbrain.autopilot': new Error('not loaded'),
      }),
      kill: (() => {
        const err = new Error('missing pid') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }) as typeof process.kill,
    });
    expect(health.install_target).toBe('macos');
    expect(health.installed).toBe(true);
    expect(health.artifact_present).toBe(true);
    expect(health.manager_registered).toBe(false);
    expect(health.manager_loaded).toBe(false);
    expect(health.running).toBe(false);
    expect(health.last_log).toBe('second line');
  });

  test('stale lockfile with dead pid surfaces pid but not running', () => {
    const home = '/tmp/home-lock';
    const gbrainHome = '/tmp/gbrain-lock';
    const lock = autopilotLockPath(gbrainHome);
    const health = buildAutopilotHealth({
      platform: 'linux',
      home,
      gbrainHome,
      existsSync: makeExists([lock]),
      readFileSync: makeRead({ [lock]: '4242' }),
      execSync: makeExec({
        'crontab -l 2>/dev/null || true': '',
      }),
      kill: ((_pid: number, _signal?: number) => {
        const err = new Error('gone') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }) as typeof process.kill,
    });
    expect(health.lockfile_present).toBe(true);
    expect(health.pid).toBe(4242);
    expect(health.running).toBe(false);
  });

  test('cron registration with live pid reports installed and running', () => {
    const home = '/tmp/home-cron';
    const gbrainHome = '/tmp/gbrain-cron';
    const lock = autopilotLockPath(gbrainHome);
    const health = buildAutopilotHealth({
      platform: 'linux',
      home,
      gbrainHome,
      existsSync: makeExists([lock]),
      readFileSync: makeRead({ [lock]: '7777' }),
      execSync: makeExec({
        'crontab -l 2>/dev/null || true': "*/5 * * * * '/tmp/.gbrain/autopilot-run.sh' >> ~/.gbrain/autopilot.log 2>&1\n",
      }),
      kill: (() => {}) as typeof process.kill,
    });
    expect(health.install_target).toBe('linux-cron');
    expect(health.installed).toBe(true);
    expect(health.artifact_present).toBeNull();
    expect(health.manager_registered).toBe(true);
    expect(health.manager_loaded).toBeNull();
    expect(health.pid).toBe(7777);
    expect(health.running).toBe(true);
  });

  test('systemd unit can separate artifact, registration, and active manager state', () => {
    const home = '/tmp/home-systemd';
    const gbrainHome = '/tmp/gbrain-systemd';
    const unit = autopilotSystemdUnitPath(home);
    const health = buildAutopilotHealth({
      platform: 'linux',
      home,
      gbrainHome,
      existsSync: makeExists(['/run/systemd/system', unit]),
      execSync: makeExec({
        'systemctl --user is-system-running': 'running\n',
        'systemctl --user is-enabled gbrain-autopilot.service': 'enabled\n',
        'systemctl --user is-active gbrain-autopilot.service': 'active\n',
      }),
    });
    expect(health.install_target).toBe('linux-systemd');
    expect(health.installed).toBe(true);
    expect(health.artifact_present).toBe(true);
    expect(health.manager_registered).toBe(true);
    expect(health.manager_loaded).toBe(true);
    expect(health.running).toBe(false);
  });

  test('unreadable log and malformed lockfile fail open', () => {
    const home = '/tmp/home-bad';
    const gbrainHome = '/tmp/gbrain-bad';
    const lock = autopilotLockPath(gbrainHome);
    const health = buildAutopilotHealth({
      platform: 'linux',
      home,
      gbrainHome,
      existsSync: makeExists([lock]),
      readFileSync: makeRead({ [lock]: 'not-a-pid' }),
      execSync: makeExec({
        'crontab -l 2>/dev/null || true': '',
      }),
    });
    expect(health.lockfile_present).toBe(true);
    expect(health.pid).toBeNull();
    expect(health.running).toBe(false);
    expect(health.last_log).toBeNull();
  });
});
