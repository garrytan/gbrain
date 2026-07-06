import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gbrainPath } from './config.ts';

export const CHATGPT_TUNNEL_PROFILE_NAME = 'pmbrain-chatgpt';
export const CHATGPT_TUNNEL_HEALTH_URL = 'http://127.0.0.1:8080';
export const CHATGPT_TUNNEL_TOKEN_NAME = 'chatgpt-secure-tunnel';

export interface ChatGptTunnelPaths {
  integrationDir: string;
  runtimeKeyFile: string;
  authorizationHeaderFile: string;
  pidFile: string;
  stdoutLog: string;
  stderrLog: string;
  profileFile: string;
}

export interface ChatGptTunnelStatus {
  binaryPath: string;
  binaryFound: boolean;
  binaryVersion?: string;
  profileFile: string;
  profileExists: boolean;
  runtimeKeyConfigured: boolean;
  authorizationConfigured: boolean;
  tunnelId?: string;
  suggestedTunnelId?: string;
  pid?: number;
  processRunning: boolean;
  healthUrl: string;
}

export function normalizeTunnelHttpProxy(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const entries = trimmed.includes('=')
    ? Object.fromEntries(trimmed.split(';').map(entry => entry.split('=', 2)).filter(parts => parts.length === 2))
    : null;
  const candidate = entries?.https || entries?.http || trimmed;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
}

export function detectTunnelHttpProxy(): string | undefined {
  const configured = normalizeTunnelHttpProxy(
    process.env.PMBRAIN_TUNNEL_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY,
  );
  if (configured || process.platform !== 'win32') return configured;

  const registryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const enabled = spawnSync('reg.exe', ['query', registryKey, '/v', 'ProxyEnable'], {
    encoding: 'utf8', windowsHide: true,
  });
  if (enabled.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled.stdout)) return undefined;
  const server = spawnSync('reg.exe', ['query', registryKey, '/v', 'ProxyServer'], {
    encoding: 'utf8', windowsHide: true,
  });
  if (server.status !== 0) return undefined;
  return normalizeTunnelHttpProxy(server.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)$/im)?.[1]);
}

function slashPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function defaultTunnelClientBinary(): string {
  const explicit = process.env.PMBRAIN_TUNNEL_CLIENT_PATH?.trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') return 'D:\\tools\\tunnel-client\\tunnel-client.exe';
  return 'tunnel-client';
}

export function chatGptTunnelPaths(): ChatGptTunnelPaths {
  const integrationDir = gbrainPath('integrations', 'openai-tunnel');
  const profileDir = process.env.APPDATA
    ? join(process.env.APPDATA, 'tunnel-client')
    : join(homedir(), '.config', 'tunnel-client');
  return {
    integrationDir,
    runtimeKeyFile: join(integrationDir, 'control-plane-api-key'),
    authorizationHeaderFile: join(integrationDir, 'pmbrain-authorization-header'),
    pidFile: join(integrationDir, 'tunnel-client.pid'),
    stdoutLog: join(integrationDir, 'tunnel-client.out.log'),
    stderrLog: join(integrationDir, 'tunnel-client.err.log'),
    profileFile: join(profileDir, `${CHATGPT_TUNNEL_PROFILE_NAME}.yaml`),
  };
}

export function buildChatGptTunnelProfile(input: {
  tunnelId: string;
  mcpUrl: string;
  runtimeKeyFile: string;
  authorizationHeaderFile: string;
  httpProxy?: string;
}): string {
  const keyRef = `file:${slashPath(input.runtimeKeyFile)}`;
  const headerValueRef = `file:${slashPath(input.authorizationHeaderFile)}`;
  return [
    'config_version: 1',
    'control_plane:',
    '  base_url: "https://api.openai.com"',
    ...(input.httpProxy ? [`  http_proxy: ${yamlString(input.httpProxy)}`] : []),
    `  tunnel_id: ${yamlString(input.tunnelId)}`,
    `  api_key: ${yamlString(keyRef)}`,
    'health:',
    '  listen_addr: "127.0.0.1:8080"',
    'admin_ui:',
    '  open_browser: false',
    'log:',
    '  level: info',
    '  format: json',
    'mcp:',
    '  server_urls:',
    '    - channel: main',
    `      url: ${yamlString(input.mcpUrl)}`,
    '  extra_headers:',
    `    Authorization: ${yamlString(headerValueRef)}`,
    '  discovery_extra_headers:',
    `    Authorization: ${yamlString(headerValueRef)}`,
    '',
  ].join('\n');
}

function lockDownPrivateFile(path: string): void {
  if (process.platform !== 'win32') return;
  const identity = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  if (!identity) throw new Error('Unable to determine the current Windows user for private-file ACLs');
  const result = spawnSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${identity}:F`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to restrict private file permissions: ${result.stderr || result.stdout}`);
  }
}

export function writePrivateFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${value.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
  lockDownPrivateFile(path);
}

export function writeChatGptTunnelProfile(path: string, profile: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, profile, { encoding: 'utf8' });
}

export function parseTunnelId(profile: string): string | undefined {
  return profile.match(/^\s*tunnel_id:\s*["']?(tunnel_[A-Za-z0-9_-]+)["']?\s*$/m)?.[1];
}

function findSuggestedTunnelId(paths: ChatGptTunnelPaths): string | undefined {
  const candidates = [
    paths.profileFile,
    join(dirname(paths.profileFile), 'pmbrain.yaml'),
    join(dirname(paths.profileFile), 'pmbrain-noauth.yaml'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const id = parseTunnelId(readFileSync(path, 'utf8'));
      if (id) return id;
    } catch {
      // A malformed legacy profile should not prevent the setup screen loading.
    }
  }
  return undefined;
}

export function readPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function isProcessRunning(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getChatGptTunnelStatus(binaryPath = defaultTunnelClientBinary()): ChatGptTunnelStatus {
  const paths = chatGptTunnelPaths();
  const binaryFound = binaryPath === 'tunnel-client' || existsSync(binaryPath);
  let binaryVersion: string | undefined;
  if (binaryFound) {
    const version = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (version.status === 0) binaryVersion = (version.stdout || version.stderr).trim();
  }
  const pid = readPid(paths.pidFile);
  const profile = existsSync(paths.profileFile) ? readFileSync(paths.profileFile, 'utf8') : '';
  return {
    binaryPath,
    binaryFound,
    binaryVersion,
    profileFile: paths.profileFile,
    profileExists: !!profile,
    runtimeKeyConfigured: existsSync(paths.runtimeKeyFile),
    authorizationConfigured: existsSync(paths.authorizationHeaderFile),
    tunnelId: profile ? parseTunnelId(profile) : undefined,
    suggestedTunnelId: findSuggestedTunnelId(paths),
    pid,
    processRunning: isProcessRunning(pid),
    healthUrl: CHATGPT_TUNNEL_HEALTH_URL,
  };
}

export function runTunnelDoctor(binaryPath = defaultTunnelClientBinary()): Promise<{
  ok: boolean;
  exitCode: number | null;
  output: string;
}> {
  const { profileFile } = chatGptTunnelPaths();
  return new Promise(resolve => {
    execFile(binaryPath, ['doctor', '--profile-file', profileFile, '--explain'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      const rawCode = (error as (Error & { code?: string | number }) | null)?.code;
      const errorCode = typeof rawCode === 'number' ? rawCode : null;
      resolve({
        ok: !error,
        exitCode: error ? errorCode : 0,
        output: `${stdout || ''}${stderr || ''}`.trim(),
      });
    });
  });
}

export function startTunnelClient(binaryPath = defaultTunnelClientBinary()): number {
  const paths = chatGptTunnelPaths();
  const existingPid = readPid(paths.pidFile);
  if (isProcessRunning(existingPid)) return existingPid!;
  if (!existsSync(paths.profileFile)) throw new Error('ChatGPT tunnel profile has not been configured');
  mkdirSync(paths.integrationDir, { recursive: true });
  const outFd = openSync(paths.stdoutLog, 'a');
  const errFd = openSync(paths.stderrLog, 'a');
  try {
    const child = spawn(binaryPath, ['run', '--profile-file', paths.profileFile], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
    if (!child.pid) throw new Error('tunnel-client did not return a process id');
    writeFileSync(paths.pidFile, `${child.pid}\n`, 'utf8');
    child.unref();
    return child.pid;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

export function stopTunnelClient(): boolean {
  const paths = chatGptTunnelPaths();
  const pid = readPid(paths.pidFile);
  if (!isProcessRunning(pid)) return false;
  process.kill(pid!);
  return true;
}
