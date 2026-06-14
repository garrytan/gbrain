import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AUTOPILOT_CRON_MARKER_END,
  AUTOPILOT_CRON_MARKER_START,
  AUTOPILOT_LOG_MAX_BYTES,
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

function writeFakeMbrain(path: string): void {
  writeFileSync(path, [
    '#!/bin/sh',
    'echo "stdout:$1:$2"',
    'echo "stderr:$1:$2" >&2',
    '',
  ].join('\n'));
  chmodSync(path, 0o700);
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
    const scriptPath = join(tempHome, '.mbrain', 'bin', 'autopilot-run-once.sh');
    expect(plist).toContain(`<string>${scriptPath}</string>`);
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain('autopilot.bootstrap.out.log');
    expect(plist).toContain('<key>StandardErrorPath</key>');
    expect(plist).toContain('autopilot.bootstrap.err.log');
    expect(plist).toContain('<key>Hour</key><integer>3</integer>');
    expect(plist).toContain('<key>RunAtLoad</key><false/>');
    const script = readFileSync(scriptPath, 'utf-8');
    expect(script).toContain('AUTOPILOT_LOG_MAX_BYTES=1048576');
    expect(script).toContain('rotate_log "$OUT_LOG"');
    expect(script).toContain('rotate_log "$ERR_LOG"');
    expect(script).toContain('exec >> "$OUT_LOG" 2>> "$ERR_LOG"');
    expect(script).toContain("exec '/usr/local/bin/mbrain' autopilot run-once");

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
    expect(written).toContain(`0 3 * * * '${join(tempHome, '.mbrain', 'bin', 'autopilot-run-once.sh')}'`);
    expect(written).toContain('autopilot.bootstrap.out.log');
    expect(written).toContain('autopilot.bootstrap.err.log');
    expect(written).not.toContain('autopilot.out.log');
    expect(written).not.toContain('autopilot run-once >>');
    expect(written).not.toContain('2>&1');
    expect(written).toContain(AUTOPILOT_CRON_MARKER_END);
    const script = readFileSync(join(tempHome, '.mbrain', 'bin', 'autopilot-run-once.sh'), 'utf-8');
    expect(script).toContain('AUTOPILOT_LOG_MAX_BYTES=1048576');
    expect(script).toContain("exec '/usr/local/bin/mbrain' autopilot run-once");

    const config = readBrainConfig();
    expect(config.autopilot).toMatchObject({ enabled: true, mode: 'cron' });
  });

  test('quotes wrapper path safely for cron shells and escapes cron percent characters', () => {
    writeBrainConfig();
    const fakeMbrain = join(tempHome, 'mbrain fake');
    writeFakeMbrain(fakeMbrain);
    const marker = join(tempHome, 'marker');
    const shellHostileHome = join(tempHome, "cron $(touch marker) ' $HOME `echo nope`");
    let written = '';
    const { exec } = createExecRecorder({
      which: () => '/usr/bin/crontab',
      crontab: (call) => {
        if (call.args[0] === '-l') return '';
        if (call.args[0] === '-' && call.input !== undefined) written = call.input;
        return '';
      },
    });
    const plan = planAutopilotSchedule({
      platform: 'linux',
      home: shellHostileHome,
      execPath: fakeMbrain,
      exec,
    });
    applyAutopilotSchedule(plan, { platform: 'linux', home: shellHostileHome, exec });

    const command = written.split('\n').find((line) => line.startsWith('0 3 * * * '))!.slice('0 3 * * * '.length);
    execFileSync('/bin/sh', ['-c', command], { cwd: tempHome });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(shellHostileHome, '.mbrain', 'logs', 'autopilot.out.log'), 'utf-8'))
      .toContain('stdout:autopilot:run-once');
  });

  test('escapes percent characters before installing the cron block', () => {
    writeBrainConfig();
    const percentHome = join(tempHome, 'cron 100% safe');
    let written = '';
    const { exec } = createExecRecorder({
      which: () => '/usr/bin/crontab',
      crontab: (call) => {
        if (call.args[0] === '-l') return '';
        if (call.args[0] === '-' && call.input !== undefined) written = call.input;
        return '';
      },
    });
    const plan = planAutopilotSchedule({
      platform: 'linux',
      home: percentHome,
      execPath: '/usr/local/bin/mbrain',
      exec,
    });
    applyAutopilotSchedule(plan, { platform: 'linux', home: percentHome, exec });

    expect(written).toContain('100\\% safe');
    expect(written).not.toContain('100% safe');
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

describe('autopilot scheduler wrapper', () => {
  test('rotates logs, keeps three generations, and appends command stdout and stderr', () => {
    writeBrainConfig();
    const fakeMbrain = join(tempHome, 'mbrain-fake');
    writeFakeMbrain(fakeMbrain);
    const { exec } = createExecRecorder();
    const plan = planAutopilotSchedule({
      platform: 'darwin',
      home: tempHome,
      execPath: fakeMbrain,
    });
    applyAutopilotSchedule(plan, { home: tempHome, exec });

    const scriptPath = join(tempHome, '.mbrain', 'bin', 'autopilot-run-once.sh');
    const logDir = join(tempHome, '.mbrain', 'logs');
    const outLog = join(logDir, 'autopilot.out.log');
    const errLog = join(logDir, 'autopilot.err.log');
    writeFileSync(outLog, 'x'.repeat(AUTOPILOT_LOG_MAX_BYTES + 1));
    writeFileSync(`${outLog}.1`, 'old-out-1');
    writeFileSync(`${outLog}.2`, 'old-out-2');
    writeFileSync(`${outLog}.3`, 'old-out-3');
    writeFileSync(errLog, 'e'.repeat(AUTOPILOT_LOG_MAX_BYTES + 1));
    writeFileSync(`${errLog}.1`, 'old-err-1');
    writeFileSync(`${errLog}.2`, 'old-err-2');
    writeFileSync(`${errLog}.3`, 'old-err-3');

    execFileSync(scriptPath);

    expect((statSync(scriptPath).mode & 0o777)).toBe(0o700);
    expect(readFileSync(outLog, 'utf-8')).toContain('stdout:autopilot:run-once');
    expect(readFileSync(errLog, 'utf-8')).toContain('stderr:autopilot:run-once');
    expect(readFileSync(`${outLog}.1`, 'utf-8').length).toBe(AUTOPILOT_LOG_MAX_BYTES + 1);
    expect(readFileSync(`${outLog}.2`, 'utf-8')).toBe('old-out-1');
    expect(readFileSync(`${outLog}.3`, 'utf-8')).toBe('old-out-2');
    expect(readFileSync(`${errLog}.1`, 'utf-8').length).toBe(AUTOPILOT_LOG_MAX_BYTES + 1);
    expect(readFileSync(`${errLog}.2`, 'utf-8')).toBe('old-err-1');
    expect(readFileSync(`${errLog}.3`, 'utf-8')).toBe('old-err-2');

    execFileSync(scriptPath);
    expect(readFileSync(`${outLog}.1`, 'utf-8').length).toBe(AUTOPILOT_LOG_MAX_BYTES + 1);
    expect(readFileSync(outLog, 'utf-8').match(/stdout:autopilot:run-once/g)?.length).toBe(2);
  });

  test('records missing command failures in the advertised stderr log', () => {
    writeBrainConfig();
    const { exec } = createExecRecorder();
    const plan = planAutopilotSchedule({
      platform: 'darwin',
      home: tempHome,
      execPath: join(tempHome, 'mbrain-missing'),
    });
    applyAutopilotSchedule(plan, { home: tempHome, exec });

    const scriptPath = join(tempHome, '.mbrain', 'bin', 'autopilot-run-once.sh');
    expect(() => execFileSync(scriptPath)).toThrow();
    expect(readFileSync(join(tempHome, '.mbrain', 'logs', 'autopilot.err.log'), 'utf-8'))
      .toMatch(/mbrain-missing|not found|No such file/i);
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
    expect(existsSync(join(tempHome, '.mbrain', 'bin', 'autopilot-run-once.sh'))).toBe(false);
    expect(readBrainConfig().autopilot).toMatchObject({ enabled: false });
  });

  test('removes the managed cron wrapper during uninstall', () => {
    writeBrainConfig();
    let crontab = '';
    const { exec } = createExecRecorder({
      which: () => '/usr/bin/crontab',
      crontab: (call) => {
        if (call.args[0] === '-l') return crontab;
        if (call.args[0] === '-' && call.input !== undefined) crontab = call.input;
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
    expect(existsSync(join(tempHome, '.mbrain', 'bin', 'autopilot-run-once.sh'))).toBe(true);

    const result = removeAutopilotSchedule({ platform: 'linux', home: tempHome, exec });

    expect(result.status).toBe('removed');
    expect(existsSync(join(tempHome, '.mbrain', 'bin', 'autopilot-run-once.sh'))).toBe(false);
    expect(crontab).not.toContain('autopilot-run-once.sh');
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
