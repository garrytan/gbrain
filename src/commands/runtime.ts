import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir, platform } from 'os';
import { loadConfig, type GBrainConfig } from '../core/config.ts';

type RuntimeInstallTarget = 'cursor' | 'claude_desktop' | 'claude_code' | 'chatgpt' | 'perplexity';

type RuntimeManifestShape = {
  schema?: unknown;
  endpoints?: {
    mcp_url?: unknown;
  };
};

interface InstallResult {
  status: 'success';
  runtime: RuntimeInstallTarget;
  mcp_url: string;
  target_path?: string;
  command?: string;
  connector?: Record<string, unknown>;
  dry_run?: boolean;
}

const RUNTIME_ALIASES: Record<string, RuntimeInstallTarget> = {
  cursor: 'cursor',
  'claude-desktop': 'claude_desktop',
  claude_desktop: 'claude_desktop',
  'claude-code': 'claude_code',
  claude_code: 'claude_code',
  chatgpt: 'chatgpt',
  perplexity: 'perplexity',
};

export async function runRuntime(args: string[]) {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printRuntimeHelp();
    return;
  }

  const [subcommand, ...rest] = args;
  if (subcommand !== 'install') {
    fail(false, 'invalid_subcommand', `Unknown runtime subcommand: ${subcommand || '(missing)'}`);
  }

  const jsonOutput = rest.includes('--json');
  const dryRun = rest.includes('--dry-run');
  const force = rest.includes('--force');
  const runtimeArg = firstPositional(rest);
  const runtime = runtimeArg ? RUNTIME_ALIASES[runtimeArg] : null;
  if (!runtime) {
    fail(jsonOutput, 'invalid_runtime', 'Usage: cortex runtime install <cursor|claude-desktop|claude-code|chatgpt|perplexity>');
  }

  const mcpUrl = await resolveMcpUrl({
    explicit: flagValue(rest, '--mcp-url', '--server-url'),
    manifestUrl: flagValue(rest, '--manifest-url', '--runtime-manifest'),
    config: loadConfig(),
    jsonOutput,
  });
  const configDir = flagValue(rest, '--config-dir', '--out-dir');
  let result: InstallResult;
  try {
    result = installRuntime(runtime, {
      mcpUrl,
      configDir,
      force,
      dryRun,
    });
  } catch (e) {
    fail(jsonOutput, 'install_failed', e instanceof Error ? e.message : String(e));
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result));
    return;
  }

  if (result.target_path) {
    const verb = result.dry_run ? 'Would write' : 'Wrote';
    console.log(`${verb} ${runtimeLabel(runtime)} config: ${result.target_path}`);
  } else if (result.command) {
    console.log(result.command);
  } else if (result.connector) {
    console.log(JSON.stringify(result.connector, null, 2));
  }
}

export function installRuntime(
  runtime: RuntimeInstallTarget,
  opts: { mcpUrl: string; configDir?: string | null; force?: boolean; dryRun?: boolean },
): InstallResult {
  switch (runtime) {
    case 'cursor':
      return writeConfigRuntime(runtime, cursorTargetPath(opts.configDir), remoteMcpConfig(opts.mcpUrl), opts);
    case 'claude_desktop':
      return writeConfigRuntime(runtime, claudeDesktopTargetPath(opts.configDir), remoteMcpConfig(opts.mcpUrl), opts);
    case 'claude_code':
      return {
        status: 'success',
        runtime,
        mcp_url: opts.mcpUrl,
        command: `claude mcp add --transport http cortex ${opts.mcpUrl}`,
      };
    case 'chatgpt':
    case 'perplexity':
      return {
        status: 'success',
        runtime,
        mcp_url: opts.mcpUrl,
        connector: {
          server_url: opts.mcpUrl,
          auth_type: 'oauth2_client_credentials',
          note: 'Use the OAuth client id and one-time secret from the Cortex invite or signup response.',
        },
      };
  }
}

function writeConfigRuntime(
  runtime: RuntimeInstallTarget,
  targetPath: string,
  serverConfig: Record<string, unknown>,
  opts: { mcpUrl: string; force?: boolean; dryRun?: boolean },
): InstallResult {
  const existing = readJsonObject(targetPath);
  const existingServers = objectField(existing, 'mcpServers');
  const existingCortex = existingServers.cortex;
  if (existingCortex && JSON.stringify(existingCortex) !== JSON.stringify(serverConfig) && !opts.force) {
    throw new Error(`${targetPath} already has mcpServers.cortex. Re-run with --force to overwrite it.`);
  }

  const next = {
    ...existing,
    mcpServers: {
      ...existingServers,
      cortex: serverConfig,
    },
  };

  if (!opts.dryRun) {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  }

  return {
    status: 'success',
    runtime,
    mcp_url: opts.mcpUrl,
    target_path: targetPath,
    dry_run: opts.dryRun || undefined,
  };
}

function remoteMcpConfig(mcpUrl: string): Record<string, unknown> {
  return {
    url: mcpUrl,
    transport: 'sse',
  };
}

function cursorTargetPath(configDir?: string | null): string {
  const root = configDir ? resolve(configDir) : process.cwd();
  return join(root, '.cursor', 'mcp.json');
}

function claudeDesktopTargetPath(configDir?: string | null): string {
  if (configDir) return join(resolve(configDir), 'claude_desktop_config.json');
  if (platform() === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

async function resolveMcpUrl(input: {
  explicit: string | null;
  manifestUrl: string | null;
  config: GBrainConfig | null;
  jsonOutput: boolean;
}): Promise<string> {
  const raw = input.explicit?.trim()
    || await mcpUrlFromManifest(input.manifestUrl, input.jsonOutput)
    || input.config?.remote_mcp?.mcp_url?.trim()
    || '';
  if (!raw) {
    fail(
      input.jsonOutput,
      'missing_mcp_url',
      'No hosted MCP URL found. Run `cortex connect <onboarding-url> --client-secret <secret>` first, or pass --mcp-url or --manifest-url.',
    );
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('URL must start with http:// or https://');
    }
    return raw.replace(/\/+$/, '');
  } catch (e) {
    fail(input.jsonOutput, 'invalid_mcp_url', `Invalid MCP URL: ${raw}`, { detail: e instanceof Error ? e.message : String(e) });
  }
}

async function mcpUrlFromManifest(manifestUrl: string | null, jsonOutput: boolean): Promise<string | null> {
  const raw = manifestUrl?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must start with http:// or https://');
  } catch (e) {
    fail(jsonOutput, 'invalid_manifest_url', `Invalid runtime manifest URL: ${raw}`, { detail: e instanceof Error ? e.message : String(e) });
  }

  try {
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) {
      fail(jsonOutput, 'manifest_fetch_failed', `Runtime manifest fetch failed: HTTP ${res.status}`, { body: text.slice(0, 300) });
    }
    const parsed = JSON.parse(text) as RuntimeManifestShape;
    if (parsed.schema !== 'cortex.runtime-manifest.v1') {
      fail(jsonOutput, 'invalid_manifest_schema', 'Runtime manifest must have schema "cortex.runtime-manifest.v1".');
    }
    const mcpUrl = typeof parsed.endpoints?.mcp_url === 'string' ? parsed.endpoints.mcp_url.trim() : '';
    if (!mcpUrl) {
      fail(jsonOutput, 'manifest_missing_mcp_url', 'Runtime manifest is missing endpoints.mcp_url.');
    }
    return mcpUrl;
  } catch (e) {
    if (e instanceof SyntaxError) {
      fail(jsonOutput, 'manifest_parse_failed', `Runtime manifest is not valid JSON: ${e.message}`);
    }
    throw e;
  }
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  return field && typeof field === 'object' && !Array.isArray(field)
    ? field as Record<string, unknown>
    : {};
}

function firstPositional(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (!value) continue;
    if (value === '--config-dir' || value === '--out-dir' || value === '--mcp-url' || value === '--server-url' || value === '--manifest-url' || value === '--runtime-manifest') {
      i += 1;
      continue;
    }
    if (!value.startsWith('-')) return value;
  }
  return null;
}

function flagValue(args: string[], ...names: string[]): string | null {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  }
  return null;
}

function runtimeLabel(runtime: RuntimeInstallTarget): string {
  return runtime.replace(/_/g, ' ');
}

function fail(jsonOutput: boolean, reason: string, message: string, extra: Record<string, unknown> = {}): never {
  if (jsonOutput) {
    console.log(JSON.stringify({ status: 'error', reason, message, ...extra }));
  } else {
    console.error(message);
  }
  process.exit(1);
}

function printRuntimeHelp() {
  console.log(`cortex runtime — install hosted Cortex runtime configs

USAGE
  cortex runtime install <runtime> [options]

RUNTIMES
  cursor
  claude-desktop
  claude-code
  chatgpt
  perplexity

OPTIONS
  --mcp-url <url>        Hosted MCP URL. Defaults to the profile from cortex connect.
  --manifest-url <url>   Fetch hosted /runtime-manifest.json and use endpoints.mcp_url.
  --config-dir <dir>     Write config under this directory instead of the runtime default.
  --force                Overwrite an existing mcpServers.cortex entry.
  --dry-run              Print/write nothing, but return the target path.
  --json                 Print machine-readable output.

EXAMPLES
  cortex connect '<onboarding-url>' --client-secret '<secret>'
  cortex runtime install cursor --manifest-url https://tenant.example.com/runtime-manifest.json
  cortex runtime install cursor
  cortex runtime install claude-desktop --json`);
}
