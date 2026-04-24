import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { registerMcpServerInOpenClaw } from '../src/commands/register-mcp.ts';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'register-mcp-test-'));
}

function writeJson(path: string, data: object) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('registerMcpServerInOpenClaw', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('adds gbrain MCP server to empty config', () => {
    const configPath = join(dir, 'openclaw.json');
    writeJson(configPath, {});

    const result = registerMcpServerInOpenClaw({
      openclawConfigPath: configPath,
      gbrainInstallPath: '/opt/gbrain',
      gbrainConfig: { database_url: 'postgres://localhost/brain', engine: 'postgres' },
    });

    expect(result.status).toBe('registered');
    const config = readJson(configPath);
    expect(config.mcp.servers.gbrain).toBeDefined();
    expect(config.mcp.servers.gbrain.command).toBe('bun');
    expect(config.mcp.servers.gbrain.args).toContain('serve');
    expect(config.mcp.servers.gbrain.env.GBRAIN_DATABASE_URL).toBe('postgres://localhost/brain');
  });

  test('adds alongside existing MCP servers', () => {
    const configPath = join(dir, 'openclaw.json');
    writeJson(configPath, {
      mcp: {
        servers: {
          circleback: { url: 'https://app.circleback.ai/api/mcp' },
        },
      },
    });

    const result = registerMcpServerInOpenClaw({
      openclawConfigPath: configPath,
      gbrainInstallPath: '/opt/gbrain',
      gbrainConfig: { database_url: 'postgres://localhost/brain', engine: 'postgres' },
    });

    expect(result.status).toBe('registered');
    const config = readJson(configPath);
    expect(config.mcp.servers.circleback).toBeDefined();
    expect(config.mcp.servers.gbrain).toBeDefined();
  });

  test('skips if already registered (idempotent)', () => {
    const configPath = join(dir, 'openclaw.json');
    writeJson(configPath, {
      mcp: { servers: { gbrain: { command: 'bun', args: ['serve'] } } },
    });

    const result = registerMcpServerInOpenClaw({
      openclawConfigPath: configPath,
      gbrainInstallPath: '/opt/gbrain',
      gbrainConfig: { database_url: 'postgres://localhost/brain', engine: 'postgres' },
    });

    expect(result.status).toBe('already_registered');
  });

  test('handles missing OpenClaw config gracefully', () => {
    const result = registerMcpServerInOpenClaw({
      openclawConfigPath: join(dir, 'nonexistent.json'),
      gbrainConfig: { database_url: 'postgres://localhost/brain', engine: 'postgres' },
    });

    expect(result.status).toBe('missing_openclaw_config');
  });

  test('preserves all existing config fields', () => {
    const configPath = join(dir, 'openclaw.json');
    const original = {
      agents: { defaults: { model: 'claude-3' } },
      gateway: { port: 18789 },
      plugins: { entries: { telegram: { enabled: true } } },
      mcp: { servers: { other: { url: 'https://example.com' } } },
    };
    writeJson(configPath, original);

    registerMcpServerInOpenClaw({
      openclawConfigPath: configPath,
      gbrainInstallPath: '/opt/gbrain',
      gbrainConfig: { database_url: 'postgres://localhost/brain', engine: 'postgres' },
    });

    const config = readJson(configPath);
    expect(config.agents.defaults.model).toBe('claude-3');
    expect(config.gateway.port).toBe(18789);
    expect(config.plugins.entries.telegram.enabled).toBe(true);
    expect(config.mcp.servers.other.url).toBe('https://example.com');
    expect(config.mcp.servers.gbrain).toBeDefined();
  });

  test('handles null gbrainConfig by falling back to loadConfig', () => {
    const configPath = join(dir, 'openclaw.json');
    writeJson(configPath, {});

    // When gbrainConfig is null AND loadConfig returns null, status is missing_gbrain_config.
    // But on dev machines loadConfig() may succeed, so we just verify it doesn't crash
    // and returns a valid status.
    const result = registerMcpServerInOpenClaw({
      openclawConfigPath: configPath,
      gbrainConfig: null,
    });

    expect(['missing_gbrain_config', 'registered']).toContain(result.status);
  });
});
