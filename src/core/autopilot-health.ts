import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { gbrainPath } from './config.ts';

export type AutopilotInstallTarget = 'macos' | 'linux-systemd' | 'ephemeral-container' | 'linux-cron';

export interface AutopilotHealth {
  install_target: AutopilotInstallTarget;
  installed: boolean;
  artifact_present: boolean | null;
  manager_registered: boolean | null;
  manager_loaded: boolean | null;
  lockfile_present: boolean;
  pid: number | null;
  running: boolean;
  last_log: string | null;
}

export interface AutopilotHealthDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  gbrainHome?: string;
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  execSync?: typeof execSync;
  kill?: typeof process.kill;
}

export function autopilotPlistPath(home = process.env.HOME || ''): string {
  return join(home, 'Library', 'LaunchAgents', 'com.gbrain.autopilot.plist');
}

export function autopilotSystemdUnitPath(home = process.env.HOME || ''): string {
  return join(home, '.config', 'systemd', 'user', 'gbrain-autopilot.service');
}

export function autopilotEphemeralStartScriptPath(home = process.env.HOME || ''): string {
  return join(home, '.gbrain', 'start-autopilot.sh');
}

export function autopilotLogPath(home = process.env.HOME || ''): string {
  return join(home, '.gbrain', 'autopilot.log');
}

export function autopilotLockPath(gbrainHome = gbrainPath()): string {
  return join(gbrainHome, 'autopilot.lock');
}

export function detectAutopilotInstallTarget(
  deps: Pick<AutopilotHealthDeps, 'platform' | 'env' | 'existsSync' | 'execSync'> = {},
): AutopilotInstallTarget {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const hasPath = deps.existsSync ?? existsSync;
  const run = deps.execSync ?? execSync;

  if (platform === 'darwin') return 'macos';

  const ephemeral = !!(
    env.RENDER
    || env.RAILWAY_ENVIRONMENT
    || env.FLY_APP_NAME
    || hasPath('/.dockerenv')
  );
  if (ephemeral) return 'ephemeral-container';

  if (hasPath('/run/systemd/system')) {
    try {
      run('systemctl --user is-system-running', { stdio: 'pipe', timeout: 3000 });
      return 'linux-systemd';
    } catch {
      // fall through to cron
    }
  }

  return 'linux-cron';
}

function readLastLogLine(filePath: string, read: typeof readFileSync): string | null {
  try {
    const content = read(filePath, 'utf-8').trim();
    if (!content) return null;
    const lines = content.split('\n');
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
}

function commandSucceeded(
  run: typeof execSync,
  command: string,
  timeout = 3000,
): boolean {
  try {
    run(command, { stdio: 'pipe', timeout });
    return true;
  } catch {
    return false;
  }
}

function commandOutput(
  run: typeof execSync,
  command: string,
  timeout = 3000,
): string | null {
  try {
    const out = run(command, { encoding: 'utf-8', stdio: 'pipe', timeout });
    return typeof out === 'string' ? out : out.toString('utf-8');
  } catch {
    return null;
  }
}

function resolvePidState(
  lockPath: string,
  hasPath: typeof existsSync,
  read: typeof readFileSync,
  kill: typeof process.kill,
): { lockfile_present: boolean; pid: number | null; running: boolean } {
  const lockfile_present = hasPath(lockPath);
  let pid: number | null = null;
  let running = false;

  if (!lockfile_present) {
    return { lockfile_present, pid, running };
  }

  try {
    const raw = read(lockPath, 'utf-8').trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      pid = parsed;
      try {
        kill(parsed, 0);
        running = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        running = code === 'EPERM';
      }
    }
  } catch {
    // leave pid/running at null/false
  }

  return { lockfile_present, pid, running };
}

export function buildAutopilotHealth(deps: AutopilotHealthDeps = {}): AutopilotHealth {
  const hasPath = deps.existsSync ?? existsSync;
  const read = deps.readFileSync ?? readFileSync;
  const run = deps.execSync ?? execSync;
  const kill = deps.kill ?? process.kill.bind(process);
  const env = deps.env ?? process.env;
  const home = deps.home ?? env.HOME ?? process.env.HOME ?? '';
  const gbrainHome = deps.gbrainHome ?? gbrainPath();
  const installTarget = detectAutopilotInstallTarget({
    platform: deps.platform,
    env,
    existsSync: hasPath,
    execSync: run,
  });

  const last_log = readLastLogLine(autopilotLogPath(home), read);
  const pidState = resolvePidState(autopilotLockPath(gbrainHome), hasPath, read, kill);

  let artifact_present: boolean | null = null;
  let manager_registered: boolean | null = null;
  let manager_loaded: boolean | null = null;

  switch (installTarget) {
    case 'macos':
      artifact_present = hasPath(autopilotPlistPath(home));
      manager_registered = commandSucceeded(run, 'launchctl list com.gbrain.autopilot');
      manager_loaded = manager_registered;
      break;
    case 'linux-systemd':
      artifact_present = hasPath(autopilotSystemdUnitPath(home));
      manager_registered = commandSucceeded(run, 'systemctl --user is-enabled gbrain-autopilot.service');
      manager_loaded = commandSucceeded(run, 'systemctl --user is-active gbrain-autopilot.service');
      break;
    case 'ephemeral-container':
      artifact_present = hasPath(autopilotEphemeralStartScriptPath(home));
      break;
    case 'linux-cron': {
      const crontab = commandOutput(run, 'crontab -l 2>/dev/null || true');
      manager_registered = Boolean(
        crontab && (crontab.includes('gbrain autopilot') || crontab.includes('autopilot-run.sh')),
      );
      break;
    }
  }

  return {
    install_target: installTarget,
    installed: artifact_present === true || manager_registered === true,
    artifact_present,
    manager_registered,
    manager_loaded,
    lockfile_present: pidState.lockfile_present,
    pid: pidState.pid,
    running: pidState.running,
    last_log,
  };
}
