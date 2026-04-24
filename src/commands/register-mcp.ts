import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { GBrainConfig } from '../core/config.ts';
import { loadConfig } from '../core/config.ts';

type JsonObject = Record<string, unknown>;

export type RegisterMcpStatus =
  | 'registered'
  | 'already_registered'
  | 'missing_openclaw_config'
  | 'missing_gbrain_config';

export interface RegisterMcpResult {
  status: RegisterMcpStatus;
  openclawConfigPath: string;
}

interface RegisterMcpOptions {
  openclawConfigPath?: string;
  gbrainInstallPath?: string;
  gbrainConfig?: GBrainConfig | null;
}

function resolveOpenClawConfigPath(): string {
  return process.env.OPENCLAW_CONFIG_PATH
    || join(homedir(), '.openclaw', 'openclaw.json');
}

function getInstallPath(): string {
  return dirname(dirname(__dirname));
}

function readJsonObject(path: string): JsonObject {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`OpenClaw config must be a JSON object: ${path}`);
  }
  return parsed as JsonObject;
}

function toObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonObject;
}

function atomicWriteJson(path: string, data: JsonObject): void {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

function buildGbrainServer(installPath: string, config: GBrainConfig): JsonObject {
  const env: JsonObject = {};
  if (config.database_url) {
    env.GBRAIN_DATABASE_URL = config.database_url;
  }

  return {
    command: 'bun',
    args: ['run', join(installPath, 'src', 'cli.ts'), 'serve'],
    env,
  };
}

export function registerMcpServerInOpenClaw(opts: RegisterMcpOptions = {}): RegisterMcpResult {
  const openclawConfigPath = opts.openclawConfigPath || resolveOpenClawConfigPath();
  if (!existsSync(openclawConfigPath)) {
    return { status: 'missing_openclaw_config', openclawConfigPath };
  }

  const gbrainConfig = opts.gbrainConfig ?? loadConfig();
  if (!gbrainConfig) {
    return { status: 'missing_gbrain_config', openclawConfigPath };
  }

  const config = readJsonObject(openclawConfigPath);
  const mcp = toObject(config.mcp);
  const servers = toObject(mcp.servers);
  if (servers.gbrain !== undefined) {
    return { status: 'already_registered', openclawConfigPath };
  }

  const installPath = opts.gbrainInstallPath || getInstallPath();
  const next: JsonObject = {
    ...config,
    mcp: {
      ...mcp,
      servers: {
        ...servers,
        gbrain: buildGbrainServer(installPath, gbrainConfig),
      },
    },
  };

  atomicWriteJson(openclawConfigPath, next);
  return { status: 'registered', openclawConfigPath };
}

function printHelp() {
  console.log(`Usage: gbrain register-mcp

Add gbrain's MCP stdio server to your OpenClaw config (idempotent).

OpenClaw config path:
  $OPENCLAW_CONFIG_PATH
  ~/.openclaw/openclaw.json (default)
`);
}

export async function runRegisterMcp(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const result = registerMcpServerInOpenClaw();
  if (result.status === 'registered') {
    console.log(`Registered gbrain MCP server in ${result.openclawConfigPath}.`);
    console.log('Restart your OpenClaw gateway so gbrain tools are discoverable.');
    return;
  }
  if (result.status === 'already_registered') {
    console.log(`OpenClaw config already has mcp.servers.gbrain (${result.openclawConfigPath}).`);
    console.log('Restart your OpenClaw gateway if it is already running.');
    return;
  }
  if (result.status === 'missing_openclaw_config') {
    console.log(`OpenClaw config not found at ${result.openclawConfigPath}. Skipping MCP registration.`);
    console.log('Create/open OpenClaw once, then run: gbrain register-mcp');
    return;
  }

  console.log('No gbrain config found. Run `gbrain init` first, then `gbrain register-mcp`.');
}
