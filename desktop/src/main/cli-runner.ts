import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { release as osRelease } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { getDesktopRuntimeContract, type DesktopRuntimeContract } from './runtime-contract.js';

export interface CliRuntime {
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
}

export interface CliResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RuntimePreflightResult {
  arch: string;
  flavor: string;
  bunRevision: string;
  windowsRelease: string;
}

export interface WindowsExitStatus {
  code: number;
  hex: string;
  name: string;
  message: string;
}

const PREFLIGHT_TIMEOUT_MS = 30_000;
const PREFLIGHT_TERMINATION_GRACE_MS = 5_000;
const WINDOWS_EXIT_STATUSES = new Map<number, Omit<WindowsExitStatus, 'code' | 'hex'>>([
  [0xC000001D, {
    name: 'STATUS_ILLEGAL_INSTRUCTION',
    message: 'PMBrain 内置运行时无法在这台 CPU 上执行。请确认电脑运行 64 位 Windows，且处理器支持 SSE4.2；这不是 API Key 或数据库配置错误。',
  }],
  [0xC000007B, {
    name: 'STATUS_INVALID_IMAGE_FORMAT',
    message: 'PMBrain 运行时或原生组件的架构不一致，或者安装文件已损坏。请重新安装与系统架构匹配的 PMBrain。',
  }],
  [0xC0000135, {
    name: 'STATUS_DLL_NOT_FOUND',
    message: 'PMBrain 运行时依赖缺失，可能是安装不完整或文件被安全软件隔离。请检查安全软件记录后重新安装。',
  }],
  [0xC0000005, {
    name: 'STATUS_ACCESS_VIOLATION',
    message: 'PMBrain 内置运行时发生访问冲突。请保留日志并重新安装；若仍失败，请将日志交给维护人员。',
  }],
]);

export function cleanDatabaseEnvironment(env = process.env): NodeJS.ProcessEnv {
  const {
    DATABASE_URL: _databaseUrl,
    PMBRAIN_DATABASE_URL: _pmbrainDatabaseUrl,
    GBRAIN_DATABASE_URL: _gbrainDatabaseUrl,
    ...clean
  } = env;
  return clean;
}

export function projectRoot(runtime: CliRuntime): string {
  return resolve(runtime.appPath, '..');
}

export function packagedRuntimeRoot(runtime: CliRuntime): string {
  return join(runtime.resourcesPath, 'pmbrain-runtime');
}

function unsignedExitCode(code: number): number {
  return Math.trunc(code) >>> 0;
}

export function describeWindowsExitCode(code: number): WindowsExitStatus | null {
  const normalized = unsignedExitCode(code);
  const status = WINDOWS_EXIT_STATUSES.get(normalized);
  if (!status) return null;
  return {
    code: normalized,
    hex: `0x${normalized.toString(16).padStart(8, '0').toUpperCase()}`,
    ...status,
  };
}

export function formatProcessExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code === null) return `signal ${signal ?? 'unknown'}`;
  const status = describeWindowsExitCode(code);
  return status
    ? `code ${code} (${status.hex} ${status.name})`
    : `code ${code}${signal ? `, signal ${signal}` : ''}`;
}

export function formatCliFailure(result: CliResult): string {
  const status = describeWindowsExitCode(result.code);
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  if (status) {
    return [
      status.message,
      `Windows 退出码：${result.code}（${status.hex} ${status.name}）`,
      output,
    ].filter(Boolean).join('\n');
  }
  return output || `PMBrain command exited with ${formatProcessExit(result.code, result.signal)}`;
}

function spawnCaptured(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let terminationTimeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let settled = false;
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (terminationTimeout) clearTimeout(terminationTimeout);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
    child.stdout?.on('data', (value) => { stdout += value.toString(); });
    child.stderr?.on('data', (value) => { stderr += value.toString(); });
    child.once('error', rejectOnce);
    child.once('close', (code, signal) => {
      if (timedOut) {
        rejectOnce(new Error(`PMBrain runtime check timed out after ${options.timeoutMs}ms and was terminated.`));
        return;
      }
      if (settled) return;
      settled = true;
      clearTimers();
      resolveResult({ code: code ?? 1, signal, stdout, stderr });
    });
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        const killAccepted = child.kill('SIGKILL');
        terminationTimeout = setTimeout(() => {
          rejectOnce(new Error(
            `PMBrain runtime check timed out after ${options.timeoutMs}ms and `
            + (killAccepted ? 'did not exit after termination.' : 'could not be terminated.'),
          ));
        }, PREFLIGHT_TERMINATION_GRACE_MS);
      }, options.timeoutMs);
    }
  });
}

export function runCli(
  runtime: CliRuntime,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const root = projectRoot(runtime);
  const workingDirectory = runtime.packaged ? packagedRuntimeRoot(runtime) : root;
  const runtimeContract = runtime.packaged ? getDesktopRuntimeContract() : null;
  const command = runtime.packaged
    ? join(workingDirectory, runtimeContract!.runtimeExecutableName)
    : process.env.PMBRAIN_DESKTOP_BUN || 'bun';
  const commandArgs = runtime.packaged
    ? [join(workingDirectory, 'pmbrain-sidecar.js'), ...args]
    : ['run', join(root, 'src', 'cli.ts'), ...args];

  return spawnCaptured(command, commandArgs, {
    cwd: workingDirectory,
    env: { ...cleanDatabaseEnvironment(), ...extraEnv },
  });
}

export async function runCliChecked(
  runtime: CliRuntime,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const result = await runCli(runtime, args, extraEnv);
  if (result.code !== 0) throw new Error(formatCliFailure(result));
  return result;
}

function parseRelease(value: string): number[] | null {
  const parts = value.split('.').slice(0, 3).map(part => Number.parseInt(part, 10));
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : null;
}

export function isWindowsReleaseAtLeast(current: string, minimum: string): boolean {
  const currentParts = parseRelease(current);
  const minimumParts = parseRelease(minimum);
  if (!currentParts || !minimumParts) return false;
  for (let index = 0; index < minimumParts.length; index += 1) {
    if (currentParts[index]! > minimumParts[index]!) return true;
    if (currentParts[index]! < minimumParts[index]!) return false;
  }
  return true;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function assertPackagedManifest(value: unknown, runtimeContract: DesktopRuntimeContract): asserts value is DesktopRuntimeContract {
  if (!value || typeof value !== 'object') throw new Error('运行时清单不是有效对象。');
  const actual = value as Record<string, unknown>;
  for (const [key, expected] of Object.entries(runtimeContract)) {
    if (actual[key] !== expected) {
      throw new Error(`运行时清单字段 ${key} 不匹配。`);
    }
  }
}

export async function preflightCliRuntime(runtime: CliRuntime): Promise<RuntimePreflightResult | null> {
  if (!runtime.packaged) return null;
  const runtimeContract = getDesktopRuntimeContract();
  const windowsRelease = osRelease();
  if (runtimeContract.platform === 'win32' && runtimeContract.minimumWindowsRelease
    && !isWindowsReleaseAtLeast(windowsRelease, runtimeContract.minimumWindowsRelease)) {
    throw new Error(
      `PMBrain 需要 Windows 10 1809 或更高版本（最低 ${runtimeContract.minimumWindowsRelease}，当前 ${windowsRelease}）。`,
    );
  }

  const workingDirectory = packagedRuntimeRoot(runtime);
  const bunPath = join(workingDirectory, runtimeContract.runtimeExecutableName);
  const sidecarPath = join(workingDirectory, 'pmbrain-sidecar.js');
  const manifestPath = join(workingDirectory, 'runtime-manifest.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`PMBrain 运行时清单缺失或损坏：${error instanceof Error ? error.message : String(error)}`);
  }
  assertPackagedManifest(manifest, runtimeContract);

  let executableSha256: string;
  try {
    executableSha256 = await sha256File(bunPath);
  } catch (error) {
    throw new Error(`PMBrain 内置运行时缺失或无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  if (executableSha256 !== runtimeContract.executableSha256) {
    throw new Error('PMBrain 内置运行时校验失败，文件可能损坏或被安全软件替换。请重新安装。');
  }

  const env = cleanDatabaseEnvironment();
  const bunIdentity = await spawnCaptured(bunPath, ['--revision'], {
    cwd: workingDirectory,
    env,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });
  if (bunIdentity.code !== 0) throw new Error(formatCliFailure(bunIdentity));
  const bunRevision = bunIdentity.stdout.trim();
  if (bunRevision !== runtimeContract.bunRevision) {
    throw new Error(`PMBrain 内置运行时版本不匹配：需要 ${runtimeContract.bunRevision}，当前 ${bunRevision || '未知'}。`);
  }

  const sidecarIdentity = await spawnCaptured(bunPath, [sidecarPath, '--version'], {
    cwd: workingDirectory,
    env,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });
  if (sidecarIdentity.code !== 0) throw new Error(formatCliFailure(sidecarIdentity));
  if (!/^pmbrain\s+v?\d+\.\d+\.\d+/im.test(`${sidecarIdentity.stdout}\n${sidecarIdentity.stderr}`)) {
    throw new Error('PMBrain sidecar 自检没有返回有效版本。');
  }

  return {
    arch: runtimeContract.arch,
    flavor: runtimeContract.flavor,
    bunRevision,
    windowsRelease,
  };
}
