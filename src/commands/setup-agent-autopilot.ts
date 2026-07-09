/**
 * Autopilot schedule registration for `mbrain setup-agent`.
 *
 * Registers a daily candidate-only dream cycle (`mbrain autopilot run-once`)
 * with the OS scheduler: a launchd LaunchAgent on macOS, or a managed crontab
 * block elsewhere when `crontab` is available. The scheduled run never applies
 * auto-promote, never writes canonical pages, and never calls an LLM — it only
 * captures/refreshes Memory Inbox candidates and derived maintenance state
 * (see DreamCycleRunInput defaults in autopilot-service.ts).
 */
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { configPath, saveConfig, type MBrainConfig } from '../core/config.ts';

export const AUTOPILOT_LAUNCHD_LABEL = 'com.mbrain.autopilot';
export const AUTOPILOT_CRON_MARKER_START = '# >>> mbrain autopilot (managed by mbrain setup-agent) >>>';
export const AUTOPILOT_CRON_MARKER_END = '# <<< mbrain autopilot <<<';
// Daily at 03:00 local time — quiet hours, mirrors docs/guides/cron-schedule.md.
export const AUTOPILOT_CRON_SCHEDULE = '0 3 * * *';
export const AUTOPILOT_LOG_MAX_BYTES = 1024 * 1024;
const AUTOPILOT_LOG_ROTATE_KEEP = 3;
const SCHEDULE_DESCRIPTION = 'daily at 03:00 (candidate-only dream cycle; no canonical writes, no LLM)';

export type AutopilotScheduleMode = 'launchd' | 'cron';

export interface AutopilotScheduleDeps {
  platform?: NodeJS.Platform;
  home?: string;
  execPath?: string;
  exec?: (file: string, args: string[], options?: { input?: string }) => string;
}

export interface AutopilotSchedulePlan {
  supported: boolean;
  mode: AutopilotScheduleMode | null;
  reason?: string;
  target?: string;
  command?: string[];
  schedule_description: string;
}

export interface AutopilotScheduleResult {
  status: 'installed' | 'skipped' | 'failed' | 'removed' | 'not_installed';
  mode: AutopilotScheduleMode | null;
  target?: string;
  reason?: string;
  warnings?: string[];
}

function defaultExec(file: string, args: string[], options: { input?: string } = {}): string {
  return execFileSync(file, args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
}

function resolveMbrainCommand(deps: AutopilotScheduleDeps): string | null {
  const execPath = deps.execPath ?? process.execPath;
  if (execPath.split('/').pop()?.startsWith('mbrain')) {
    return execPath;
  }
  const exec = deps.exec ?? defaultExec;
  try {
    const resolved = exec('which', ['mbrain']).trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

function launchdPlistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${AUTOPILOT_LAUNCHD_LABEL}.plist`);
}

function autopilotRunScriptPath(home: string): string {
  return join(home, '.mbrain', 'bin', 'autopilot-run-once.sh');
}

function renderAutopilotRunScript(mbrainPath: string, home: string): string {
  const logDir = shellQuote(join(home, '.mbrain', 'logs'));
  const command = shellQuote(mbrainPath);
  const configFile = configPath();
  return [
    '#!/bin/sh',
    'set -eu',
    `AUTOPILOT_LOG_MAX_BYTES=${AUTOPILOT_LOG_MAX_BYTES}`,
    `AUTOPILOT_LOG_ROTATE_KEEP=${AUTOPILOT_LOG_ROTATE_KEEP}`,
    `LOG_DIR=${logDir}`,
    `export HOME=${shellQuote(home)}`,
    `export MBRAIN_CONFIG_DIR=${shellQuote(dirname(configFile))}`,
    `export MBRAIN_CONFIG_PATH=${shellQuote(configFile)}`,
    'OUT_LOG="$LOG_DIR/autopilot.out.log"',
    'ERR_LOG="$LOG_DIR/autopilot.err.log"',
    'mkdir -p "$LOG_DIR"',
    '',
    'rotate_log() {',
    '  file="$1"',
    '  [ -f "$file" ] || return 0',
    '  size=$(wc -c < "$file" | tr -d " ")',
    '  [ "${size:-0}" -le "$AUTOPILOT_LOG_MAX_BYTES" ] && return 0',
    '  rm -f "$file.$AUTOPILOT_LOG_ROTATE_KEEP"',
    '  i=$((AUTOPILOT_LOG_ROTATE_KEEP - 1))',
    '  while [ "$i" -ge 1 ]; do',
    '    if [ -f "$file.$i" ]; then',
    '      mv "$file.$i" "$file.$((i + 1))"',
    '    fi',
    '    i=$((i - 1))',
    '  done',
    '  mv "$file" "$file.1"',
    '}',
    '',
    'rotate_log "$OUT_LOG"',
    'rotate_log "$ERR_LOG"',
    'exec >> "$OUT_LOG" 2>> "$ERR_LOG"',
    `exec ${command} autopilot run-once`,
    '',
  ].join('\n');
}

function writeAutopilotRunScript(mbrainPath: string, home: string): string {
  const scriptPath = autopilotRunScriptPath(home);
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, renderAutopilotRunScript(mbrainPath, home));
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}

function renderLaunchdPlist(runScriptPath: string, home: string): string {
  const bootstrapOutLog = join(home, '.mbrain', 'logs', 'autopilot.bootstrap.out.log');
  const bootstrapErrLog = join(home, '.mbrain', 'logs', 'autopilot.bootstrap.err.log');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${AUTOPILOT_LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(runScriptPath)}</string>`,
    '  </array>',
    '  <key>StartCalendarInterval</key>',
    '  <dict>',
    '    <key>Hour</key><integer>3</integer>',
    '    <key>Minute</key><integer>0</integer>',
    '  </dict>',
    '  <key>RunAtLoad</key><false/>',
    `  <key>StandardOutPath</key><string>${xmlEscape(bootstrapOutLog)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(bootstrapErrLog)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function cronManagedBlock(runScriptPath: string, home: string): string {
  const bootstrapOutLog = join(home, '.mbrain', 'logs', 'autopilot.bootstrap.out.log');
  const bootstrapErrLog = join(home, '.mbrain', 'logs', 'autopilot.bootstrap.err.log');
  return [
    AUTOPILOT_CRON_MARKER_START,
    `${AUTOPILOT_CRON_SCHEDULE} ${cronShellQuote(runScriptPath)} >> ${cronShellQuote(bootstrapOutLog)} 2>> ${cronShellQuote(bootstrapErrLog)}`,
    AUTOPILOT_CRON_MARKER_END,
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cronShellQuote(value: string): string {
  return shellQuote(value).replace(/%/g, '\\%');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function removeAutopilotRunScript(home: string): void {
  rmSync(autopilotRunScriptPath(home), { force: true });
}

export function stripCronManagedBlock(crontab: string): string {
  const lines = crontab.split('\n');
  const result: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === AUTOPILOT_CRON_MARKER_START) {
      inBlock = true;
      continue;
    }
    if (line.trim() === AUTOPILOT_CRON_MARKER_END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) result.push(line);
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n');
}

function cronAvailable(deps: AutopilotScheduleDeps): boolean {
  const exec = deps.exec ?? defaultExec;
  try {
    exec('which', ['crontab']);
    return true;
  } catch {
    return false;
  }
}

function readCrontab(deps: AutopilotScheduleDeps): string {
  const exec = deps.exec ?? defaultExec;
  try {
    return exec('crontab', ['-l']);
  } catch {
    // `crontab -l` exits non-zero when no crontab exists yet.
    return '';
  }
}

export function planAutopilotSchedule(deps: AutopilotScheduleDeps = {}): AutopilotSchedulePlan {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const mbrainPath = resolveMbrainCommand(deps);

  if (!mbrainPath) {
    return {
      supported: false,
      mode: null,
      reason: 'mbrain binary not found on PATH; install the compiled binary first',
      schedule_description: SCHEDULE_DESCRIPTION,
    };
  }
  if (!existsSync(configPath())) {
    return {
      supported: false,
      mode: null,
      reason: 'no ~/.mbrain/config.json; run `mbrain init` first',
      schedule_description: SCHEDULE_DESCRIPTION,
    };
  }
  // launchd/cron run with a stripped environment: a connection that only
  // exists as an env var (DATABASE_URL in the shell profile) would make every
  // nightly run fail silently. Require the connection to live in config.json.
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf-8')) as {
      database_url?: string;
      database_path?: string;
    };
    if (!raw.database_url && !raw.database_path) {
      return {
        supported: false,
        mode: null,
        reason: 'database connection is not stored in ~/.mbrain/config.json (env-only DATABASE_URL); nightly runs would fail — persist it via `mbrain init` first',
        schedule_description: SCHEDULE_DESCRIPTION,
      };
    }
  } catch {
    return {
      supported: false,
      mode: null,
      reason: 'could not read ~/.mbrain/config.json',
      schedule_description: SCHEDULE_DESCRIPTION,
    };
  }

  if (platform === 'darwin') {
    return {
      supported: true,
      mode: 'launchd',
      target: launchdPlistPath(home),
      command: [mbrainPath, 'autopilot', 'run-once'],
      schedule_description: SCHEDULE_DESCRIPTION,
    };
  }
  if (cronAvailable(deps)) {
    return {
      supported: true,
      mode: 'cron',
      target: 'crontab',
      command: [mbrainPath, 'autopilot', 'run-once'],
      schedule_description: SCHEDULE_DESCRIPTION,
    };
  }
  return {
    supported: false,
    mode: null,
    reason: `no supported scheduler on ${platform} (crontab not found)`,
    schedule_description: SCHEDULE_DESCRIPTION,
  };
}

function enableAutopilotConfig(mode: AutopilotScheduleMode): void {
  const path = configPath();
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as MBrainConfig & {
    autopilot?: Record<string, unknown>;
  };
  const autopilot = {
    ...(raw.autopilot ?? {}),
    enabled: true,
    mode,
    schedule: AUTOPILOT_CRON_SCHEDULE,
  };
  saveConfig({ ...raw, autopilot } as MBrainConfig & { autopilot: Record<string, unknown> });
}

function disableAutopilotConfig(): void {
  const path = configPath();
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as MBrainConfig & {
      autopilot?: Record<string, unknown>;
    };
    if (!raw.autopilot) return;
    saveConfig({
      ...raw,
      autopilot: { ...raw.autopilot, enabled: false },
    } as MBrainConfig & { autopilot: Record<string, unknown> });
  } catch {
    // Leave a malformed config untouched.
  }
}

export function applyAutopilotSchedule(
  plan: AutopilotSchedulePlan,
  deps: AutopilotScheduleDeps = {},
): AutopilotScheduleResult {
  if (!plan.supported || !plan.mode || !plan.command) {
    return { status: 'skipped', mode: plan.mode, reason: plan.reason ?? 'unsupported' };
  }

  const home = deps.home ?? homedir();
  const exec = deps.exec ?? defaultExec;
  const warnings: string[] = [];
  const mbrainPath = plan.command[0];

  mkdirSync(join(home, '.mbrain', 'logs'), { recursive: true });
  const runScriptPath = writeAutopilotRunScript(mbrainPath, home);

  if (plan.mode === 'launchd') {
    const plistPath = launchdPlistPath(home);
    const content = renderLaunchdPlist(runScriptPath, home);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, content);
    enableAutopilotConfig('launchd');
    try {
      exec('launchctl', ['unload', plistPath]);
    } catch {
      // Not loaded yet — expected on first install.
    }
    try {
      exec('launchctl', ['load', plistPath]);
    } catch (error: unknown) {
      warnings.push(
        `launchctl load failed (${error instanceof Error ? error.message : String(error)}); the agent will load at next login`,
      );
    }
    return {
      status: 'installed',
      mode: 'launchd',
      target: plistPath,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  const existing = readCrontab(deps);
  const stripped = stripCronManagedBlock(existing).trimEnd();
  const next = `${stripped.length > 0 ? `${stripped}\n\n` : ''}${cronManagedBlock(runScriptPath, home)}\n`;
  try {
    exec('crontab', ['-'], { input: next });
  } catch (error: unknown) {
    return {
      status: 'failed',
      mode: 'cron',
      target: 'crontab',
      reason: `crontab write failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  enableAutopilotConfig('cron');
  return { status: 'installed', mode: 'cron', target: 'crontab' };
}

export function removeAutopilotSchedule(deps: AutopilotScheduleDeps = {}): AutopilotScheduleResult {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const exec = deps.exec ?? defaultExec;

  if (platform === 'darwin') {
    const plistPath = launchdPlistPath(home);
    if (!existsSync(plistPath)) {
      removeAutopilotRunScript(home);
      disableAutopilotConfig();
      return { status: 'not_installed', mode: 'launchd', target: plistPath };
    }
    try {
      exec('launchctl', ['unload', plistPath]);
    } catch {
      // Already unloaded.
    }
    rmSync(plistPath, { force: true });
    removeAutopilotRunScript(home);
    disableAutopilotConfig();
    return { status: 'removed', mode: 'launchd', target: plistPath };
  }

  if (!cronAvailable(deps)) {
    removeAutopilotRunScript(home);
    disableAutopilotConfig();
    return { status: 'not_installed', mode: null, reason: 'crontab not found' };
  }
  const existing = readCrontab(deps);
  if (!existing.includes(AUTOPILOT_CRON_MARKER_START)) {
    removeAutopilotRunScript(home);
    disableAutopilotConfig();
    return { status: 'not_installed', mode: 'cron', target: 'crontab' };
  }
  const stripped = stripCronManagedBlock(existing);
  try {
    exec('crontab', ['-'], { input: stripped });
  } catch (error: unknown) {
    return {
      status: 'failed',
      mode: 'cron',
      target: 'crontab',
      reason: `crontab write failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  removeAutopilotRunScript(home);
  disableAutopilotConfig();
  return { status: 'removed', mode: 'cron', target: 'crontab' };
}
