#!/usr/bin/env bun
/**
 * Smoke test: verify an installed mbrain command can serve MCP over stdio.
 *
 * Usage:
 *   MBRAIN_SMOKE_COMMAND=mbrain bun run scripts/smoke-test-installed-mcp.ts
 *   MBRAIN_SMOKE_COMMAND="bun run src/cli.ts" bun run scripts/smoke-test-installed-mcp.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const decoder = new TextDecoder();

function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function runCli(parts: string[], args: string[], env: Record<string, string>): void {
  const result = Bun.spawnSync({
    cmd: [...parts, ...args],
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    throw new Error([
      `Command failed: ${[...parts, ...args].join(' ')}`,
      `exit=${result.exitCode}`,
      `stdout=${decoder.decode(result.stdout)}`,
      `stderr=${decoder.decode(result.stderr)}`,
    ].join('\n'));
  }
}

function parseMcpText<T = any>(result: any): T {
  if (result.isError) {
    const text = result.content?.find((entry: any) => entry.type === 'text')?.text;
    throw new Error(text || 'MCP tool call failed');
  }

  const text = result.content?.find((entry: any) => entry.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error('MCP result did not include text content');
  }
  return JSON.parse(text) as T;
}

const commandText = process.env.MBRAIN_SMOKE_COMMAND || 'mbrain';
const commandParts = splitCommand(commandText);
if (commandParts.length === 0) {
  console.error('MBRAIN_SMOKE_COMMAND cannot be empty.');
  process.exit(1);
}

const rootDir = mkdtempSync(join(tmpdir(), 'mbrain-installed-mcp-smoke-'));
const homeDir = join(rootDir, 'home');
const configDir = join(homeDir, '.mbrain');
const dbPath = join(configDir, 'brain.db');
const env: Record<string, string> = {
  ...process.env,
  HOME: homeDir,
  MBRAIN_CONFIG_DIR: configDir,
  MBRAIN_DATABASE_PATH: dbPath,
  DATABASE_URL: 'postgresql://mbrain:ignored@127.0.0.1:9/not_used',
  MBRAIN_DATABASE_URL: 'postgresql://mbrain:ignored@127.0.0.1:9/not_used',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
};

let client: Client | null = null;

try {
  console.log(`Using command: ${commandText}`);
  runCli(commandParts, ['init', '--local', '--json'], env);

  const transport = new StdioClientTransport({
    command: commandParts[0],
    args: [...commandParts.slice(1), 'serve'],
    env,
    stderr: 'pipe',
  });

  client = new Client(
    { name: 'mbrain-installed-smoke', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map(tool => tool.name));
  for (const name of ['get_health', 'put_page', 'get_page', 'search', 'delete_page']) {
    if (!toolNames.has(name)) {
      throw new Error(`tools/list did not include ${name}`);
    }
  }
  console.log(`tools/list: ${tools.tools.length} tools`);

  const health = parseMcpText<any>(await client.callTool({ name: 'get_health', arguments: {} }));
  if (!health || typeof health !== 'object') {
    throw new Error('get_health did not return an object');
  }
  console.log('get_health: ok');

  const slug = 'smoke/install-check';
  const content = [
    '---',
    'title: Install Check',
    'type: note',
    '---',
    '',
    'Install smoke check. [Source: installed MCP smoke test, direct tool call, 2026-04-30 00:00 KST]',
  ].join('\n');

  parseMcpText(await client.callTool({
    name: 'put_page',
    arguments: { slug, content },
  }));

  const page = parseMcpText<any>(await client.callTool({
    name: 'get_page',
    arguments: { slug },
  }));
  if (page.slug !== slug || page.title !== 'Install Check') {
    throw new Error(`get_page returned unexpected page: ${JSON.stringify(page)}`);
  }
  console.log('page lifecycle: write/read ok');

  const searchResults = parseMcpText<any[]>(await client.callTool({
    name: 'search',
    arguments: { query: 'Install smoke check' },
  }));
  if (!Array.isArray(searchResults)) {
    throw new Error('search did not return an array');
  }
  const foundSmokePage = searchResults.some((entry: any) =>
    entry?.slug === slug ||
    entry?.page?.slug === slug ||
    entry?.title === 'Install Check'
  );
  if (!foundSmokePage) {
    throw new Error(`search did not return ${slug}`);
  }
  console.log(`search: ${searchResults.length} result(s)`);

  parseMcpText(await client.callTool({
    name: 'delete_page',
    arguments: { slug },
  }));
  console.log('cleanup: deleted smoke page');

  await client.close();
  client = null;
  console.log('Installed MCP smoke test passed.');
} catch (e) {
  try {
    await client?.close();
  } catch {
    // Ignore cleanup failures so the root error remains visible.
  }
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  if (!process.env.MBRAIN_SMOKE_KEEP_TEMP) {
    rmSync(rootDir, { recursive: true, force: true });
  } else {
    console.error(`Keeping temp directory: ${rootDir}`);
  }
}
