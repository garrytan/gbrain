import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { integrationConfigPath, writeCodexIntegration, writeJsonIntegration } from '../src/main/integration-manager.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-desktop-mcp-'));
  roots.push(root);
  return join(root, name);
}

describe('desktop integration config merging', () => {
  test('uses Workbuddy mcp.json path', () => {
    const path = integrationConfigPath('workbuddy');
    expect(path).toEndWith(join('.workbuddy', 'mcp.json'));
    expect(path).not.toEndWith(join('.workbuddy', '.mcp.json'));
  });

  test('preserves unrelated JSON MCP servers', () => {
    const path = tempFile('mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } }, theme: 'dark' }));
    writeJsonIntegration(path, 'http://127.0.0.1:3131/mcp', 'secret', dirname(path));
    const result = JSON.parse(readFileSync(path, 'utf8'));
    expect(result.theme).toBe('dark');
    expect(result.mcpServers.existing.command).toBe('keep-me');
    expect(result.mcpServers.pmbrain.headers.Authorization).toBe('Bearer secret');
  });

  test('preserves Workbuddy connector proxy config', () => {
    const path = tempFile('.mcp.json');
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        'connector-proxy': {
          command: 'workbuddy-connector-proxy',
          args: ['--profile', 'default'],
        },
      },
    }));
    writeJsonIntegration(path, 'http://127.0.0.1:3131/mcp', 'secret', dirname(path));
    const result = JSON.parse(readFileSync(path, 'utf8'));
    expect(result.mcpServers['connector-proxy'].command).toBe('workbuddy-connector-proxy');
    expect(result.mcpServers['connector-proxy'].args).toEqual(['--profile', 'default']);
    expect(result.mcpServers.pmbrain.url).toBe('http://127.0.0.1:3131/mcp');
  });

  test('replaces only the managed Codex block', () => {
    const path = tempFile('config.toml');
    writeFileSync(path, 'model = "gpt-test"\n');
    writeCodexIntegration(path, 'http://127.0.0.1:3131/mcp', 'first', dirname(path));
    writeCodexIntegration(path, 'http://127.0.0.1:3132/mcp', 'second', dirname(path));
    const result = readFileSync(path, 'utf8');
    expect(result).toContain('model = "gpt-test"');
    expect(result).toContain('http://127.0.0.1:3132/mcp');
    expect(result).not.toContain('Bearer first');
    expect(result.match(/\[mcp_servers\.pmbrain\]/g)?.length).toBe(1);
  });
});
