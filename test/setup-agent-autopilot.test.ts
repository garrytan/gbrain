import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AUTOPILOT_CRON_MARKER_END,
  AUTOPILOT_CRON_MARKER_START,
  applyAutopilotSchedule,
  planAutopilotSchedule,
  removeAutopilotSchedule,
  stripCronManagedBlock,
} from '../src/commands/setup-agent-autopilot.ts';

let tempHome = '';
const originalConfigDir = process.env.MBRAIN_CONFIG_DIR;
const originalConfigPath = process.env.MBRAIN_CONFIG_PATH;

interface ExecCall {
  file: string;
  args: string[];
  input?: string;
}

function createExecRecorder(handlers: Record<string, (call: ExecCall) => string> = {}) {
  const calls: ExecCall[] = [];
  const exec = (file: string, args: string[], options: { input?: string } = {}): string => {
    const call: ExecCall = { file, args, ...(options.input !== undefined ? { input: options.input } : {}) };
    calls.push(call);
    const handler = handlers[`${file} ${args[0] ?? ''}`] ?? handlers[file];
    if (handler) return handler(call);
    return '';
  };
  return { calls, exec };
}

function writeBrainConfig() {
  const configDir = join(tempHome, '.mbrain');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ engine: 'sqlite', database_path: join(tempHome, 'brain.db') }, null, 2),
  );
}

function readBrainConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tempHome, '.mbrain', 'config.json'), 'utf-8'));
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'mbrain-autopilot-setup-'));
  process.env.MBRAIN_CONFIG_DIR = join(tempHome, '.mbrain');
  delete process.env.MBRAIN_CONFIG_PATH;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MBRAIN_CONFIG_DIR;
  else process.env.MBRAIN_CONFIG_DIR = originalConfigDir;
  if (originalConfigPath === undefined) delete process.env.MBRAIN_CONFIG_PATH;
  else process.env.MBRAIN_CONFIG_PATH = originalConfigPath;
  rmSync(tempHome, { recursive: true, force: true });
});

describe('planAutopilotSchedule', () => {
  test('plans launchd on macOS when mbrain and config exist', () => {
    writeBrainConfig();
    const plan = planAutopilotSchedule({
      platform: 'darwin',
      home: tempHome,
      execPath: '/usr/local/bin/mbrain',
    });

    expect(plan.supported).toBe(true);
    expect(plan.mode).toBe('launchd');
    expect(plan.target).toBe(join(tempHome, 'Library', 'LaunchAgents', 'com.mbrain.autopilot.plist'));
    expect(plan.command).toEqual(['/usr/local/bin/mbrain', 'autopilot', 'run-once']);
  });

  test('plans cron on linux when crontab is available', () => {
    writeBrainConfig();
    const { exec } = createExecRecorder({ which: () => '/usr/bin/crontab' });
    const plan = planAutopilotSchedule({
      platform: 'linux',
      home: tempHome,
      execPath: '/usr/local/bin/mbrain',
      exec,
    });

    expect(plan.supported).toBe(true);
    expect(plan.mode).toBe('cron');
  });

  test('declines when mbrain is not resolvable', () => {
    writeBrainConfig();
    const { exec } = createExecRecorder({
      which: () => {
        throw new Error('not found');
      },
    });
    const plan = planAutopilotSchedule({
      platform: 'darwin',
      home: tempHome,
      execPath: '/usr/local/bin/bun',
      exec,
    });

    expect(plan.supported).toBe(false);
    expect(plan.reason).toContain('mbrain binary not found');
  });

  test('declines when the database connection only lives in the environment', () => {
    const configDir = join(tempHome, '.mbrain');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ engine: 'postgres' }));

    const plan = planAutopilotSchedule({
      platform: 'darwin',
      home: tempHome,
      execPath: '/usr/local/bin/mbrain',
    });

    expect(plan.supported).toBe(false);
    expect(plan.reason).toContain('env-only DATABASE_URL');
  });

  test('declines when the brain is not initialized', () => {
    const plan = planAutopilotSchedule({
      platform: 'darwin',
      home: tempHome,
      execPath: '/usr/local/bin/mbrain',
    });

    expect(plan.supported).toBe(false);
    expect(plan.reason).toContain('mbrain init');
  });
});

describe('applyAutopilotSchedule (launchd)', () => {
  test('writes the plist, loads it, and enables autopilot config', () => {
    writeBrainConfig();
    const { calls, exec } = createExecRecorder();
    const plan = planAutopilotSchedule({
      platform: 'darwin',
      home: tempHome,
      execPath: '/usr/local/bin/mbrain',
    });
    const result = applyAutopilotSchedule(plan, { home: tempHome, exec });

    expect(result.status).toBe('installed');
    expect(result.mode).toBe('launchd');

    const plistPath = join(tempHome, 'Library', 'LaunchAgents', 'com.mbrain.autopilot.plist');
    const plist = readFileSync(plistPath, 'utf-8');
    expect(plist).toContain('<string>/usr/local/bin/mbrain</string>');
    expect(plist).toContain('<string>autopilot</string>');
    expect(plist).toContain('<string>run-once</string>');
    expect(plist).toContain('<key>Hour</key><integer>3</integer>');
    expect(plist).toContain('<key>RunAtLoad</key><false/>');

    expect(calls.some((call) => call.file === 'launchctl' && call.args[0] === 'load')).toBe(true);

    const config = readBrainConfig();
    expect(config.autopilot).toMatchObject({ enabled: true, mode: 'launchd', schedule: '0 3 * * *' });
  });

  test('reports a warning but still installs when launchctl load fails', () => {
    writeBrainConfig();
    const { exec } = createExecRecorder({
      launchctl: (call) => {
        if (call.args[0] === 'load') throw new Error('Load failed: 5: Input/output error');
        return '';
      },
    });
    const plan = planAutopilotSchedule({
      platform: 'darwin',
      home: tempHome,
      execPath: '/usr/local/bin/mbrain',
    });
    const result = applyAutopilotSchedule(plan, { home: tempHome, exec });

    expect(result.status).toBe('installed');
    expect(result.warnings?.[0]).toContain('next login');
  });

  test('skips when the plan is unsupported and runs no commands', () => {
    const { calls, exec } = createExecRecorder();
    const result = applyAutopilotSchedule(
      { supported: false, mode: null, reason: 'nope', schedule_description: 'n/a' },
      { home: tempHome, exec },
    );

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('nope');
    expect(calls).toEqual([]);
  });
});

describe('applyAutopilotSchedule (cron)', () => {
  test('appends a managed crontab block preserving existing entries', () => {
    writeBrainConfig();
    let written = '';
    const { exec } = createExecRecorder({
      which: () => '/usr/bin/crontab',
      crontab: (call) => {
        if (call.args[0] === '-l') return '0 9 * * * /usr/bin/existing-job\n';
        if (call.args[0] === '-' && call.input !== undefined) {
          written = call.input;
          return '';
        }
        return '';
      },
    });
    const plan = planAutopilotSchedule({
      platform: 'linux',
      home: tempHome,
      execPath: '/usr/local/bin/mbrain',
      exec,
    });
    const result = applyAutopilotSchedule(plan, { platform: 'linux', home: tempHome, exec });

    expect(result.status).toBe('installed');
    expect(result.mode).toBe('cron');
    expect(written).toContain('0 9 * * * /usr/bin/existing-job');
    expect(written).toContain(AUTOPILOT_CRON_MARKER_START);
    expect(written).toContain('0 3 * * * "/usr/local/bin/mbrain" autopilot run-once');
    expect(written).toContain(AUTOPILOT_CRON_MARKER_END);

    const config = readBrainConfig();
    expect(config.autopilot).toMatchObject({ enabled: true, mode: 'cron' });
  });

  test('replaces a previous managed block instead of duplicating it', () => {
    writeBrainConfig();
    const previous = [
      '0 9 * * * /usr/bin/existing-job',
      '',
      AUTOPILOT_CRON_MARKER_START,
      '0 3 * * * /old/mbrain autopilot run-once >> /old/log 2>&1',
      AUTOPILOT_CRON_MARKER_END,
      '',
    ].join('\n');
    let written = '';
    const { exec } = createExecRecorder({
      which: () => '/usr/bin/crontab',
      crontab: (call) => {
        if (call.args[0] === '-l') return previous;
        if (call.args[0] === '-' && call.input !== undefined) {
          written = call.input;
        }
        return '';
      },
    });
    const plan = planAutopilotSchedule({
      platform: 'linux',
      home: tempHome,
      execPath: '/usr/local/bin/mbrain',
      exec,
    });
    applyAutopilotSchedule(plan, { platform: 'linux', home: tempHome, exec });

    expect(written).not.toContain('/old/mbrain');
    expect(written.split(AUTOPILOT_CRON_MARKER_START).length).toBe(2);
  });
});

describe('removeAutopilotSchedule', () => {
  test('removes the launchd plist and disables autopilot config', () => {
    writeBrainConfig();
    const { exec } = createExecRecorder();
    const plan = planAutopilotSchedule({
      platform: 'darwin',
      home: tempHome,
      execPath: '/usr/local/bin/mbrain',
    });
    applyAutopilotSchedule(plan, { home: tempHome, exec });

    const result = removeAutopilotSchedule({ platform: 'darwin', home: tempHome, exec });

    expect(result.status).toBe('removed');
    expect(existsSync(join(tempHome, 'Library', 'LaunchAgents', 'com.mbrain.autopilot.plist'))).toBe(false);
    expect(readBrainConfig().autopilot).toMatchObject({ enabled: false });
  });

  test('reports not_installed when nothing is registered', () => {
    const { calls, exec } = createExecRecorder();
    const result = removeAutopilotSchedule({ platform: 'darwin', home: tempHome, exec });

    expect(result.status).toBe('not_installed');
    expect(calls).toEqual([]);
  });

  test('strips only the managed cron block', () => {
    const crontab = [
      '0 9 * * * /usr/bin/existing-job',
      AUTOPILOT_CRON_MARKER_START,
      '0 3 * * * /usr/local/bin/mbrain autopilot run-once >> /tmp/log 2>&1',
      AUTOPILOT_CRON_MARKER_END,
      '30 12 * * * /usr/bin/other-job',
    ].join('\n');

    const stripped = stripCronManagedBlock(crontab);
    expect(stripped).toContain('existing-job');
    expect(stripped).toContain('other-job');
    expect(stripped).not.toContain('mbrain autopilot');
    expect(stripped).not.toContain(AUTOPILOT_CRON_MARKER_START);
  });
});
