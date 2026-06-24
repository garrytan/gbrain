#!/usr/bin/env node
/**
 * Node-backed installed MCP smoke test.
 *
 * The MCP SDK stdio client transport is Node-oriented. Running that transport
 * directly inside Bun can hang in sandboxed environments where Bun child-stdin
 * writes are blocked, so the Bun entrypoint delegates here for the actual MCP
 * stdio exchange.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const WRITEBACK_SMOKE_ARGUMENTS = {
  content: 'Installed MCP smoke confirms route_memory_writeback availability.',
  evidence_kind: 'direct_user_statement',
  source_refs: ['Source: installed MCP smoke test, direct tool call, 2026-05-10 00:00 KST'],
  dry_run: true,
  apply: true,
};

function splitAgentCommand(command) {
  const parts = [];
  let current = '';
  let quote = null;

  for (const char of command.trim()) {
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

function runCli(parts, args, env) {
  const result = spawnSync(parts[0], [...parts.slice(1), ...args], {
    env,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${[...parts, ...args].join(' ')}`,
      `exit=${result.status}`,
      `stdout=${result.stdout ?? ''}`,
      `stderr=${result.stderr ?? ''}`,
    ].join('\n'));
  }
}

function parseMcpText(result) {
  if (result.isError) {
    const text = result.content?.find(entry => entry.type === 'text')?.text;
    throw new Error(text || 'MCP tool call failed');
  }

  const text = result.content?.find(entry => entry.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error('MCP result did not include text content');
  }
  return JSON.parse(text);
}

function assertWritebackSmokeResult(writeback) {
  if (writeback?.dry_run !== true) {
    throw new Error(`route_memory_writeback did not return dry_run true: ${JSON.stringify(writeback)}`);
  }
  if (writeback.decision !== 'create_candidate') {
    throw new Error(`route_memory_writeback decision was not create_candidate: ${JSON.stringify(writeback)}`);
  }
  if (writeback.intended_operation !== 'create_memory_candidate_entry') {
    throw new Error(`route_memory_writeback intended_operation was not create_memory_candidate_entry: ${JSON.stringify(writeback)}`);
  }
  if (writeback.applied !== false) {
    throw new Error(`route_memory_writeback did not suppress apply during dry-run: ${JSON.stringify(writeback)}`);
  }
  if (writeback.candidate_input?.proposed_content !== WRITEBACK_SMOKE_ARGUMENTS.content) {
    throw new Error(`route_memory_writeback candidate content did not match smoke input: ${JSON.stringify(writeback)}`);
  }
  if (!hasExactItems(writeback.candidate_input?.source_refs, WRITEBACK_SMOKE_ARGUMENTS.source_refs)) {
    throw new Error(`route_memory_writeback candidate source_refs did not match smoke input: ${JSON.stringify(writeback)}`);
  }
}

function hasExactItems(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((entry, index) => actual[index] === entry);
}

async function main() {
  const commandText = process.env.MBRAIN_SMOKE_COMMAND || 'mbrain';
  const commandParts = splitAgentCommand(commandText);
  if (commandParts.length === 0) {
    console.error('MBRAIN_SMOKE_COMMAND cannot be empty.');
    process.exit(1);
  }

  const rootDir = mkdtempSync(join(tmpdir(), 'mbrain-installed-mcp-smoke-'));
  const homeDir = join(rootDir, 'home');
  const configDir = join(homeDir, '.mbrain');
  const dbPath = join(configDir, 'brain.db');
  const env = {
    ...process.env,
    HOME: homeDir,
    MBRAIN_CONFIG_DIR: configDir,
    MBRAIN_DATABASE_PATH: dbPath,
    DATABASE_URL: 'postgresql://mbrain:ignored@127.0.0.1:9/not_used',
    MBRAIN_DATABASE_URL: 'postgresql://mbrain:ignored@127.0.0.1:9/not_used',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
  };

  let client = null;

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
    for (const name of [
      'get_health',
      'put_page',
      'get_page',
      'search',
      'delete_page',
      'retrieve_context',
      'read_context',
      'record_retrieval_trace',
      'route_memory_writeback',
    ]) {
      if (!toolNames.has(name)) {
        throw new Error(`tools/list did not include ${name}`);
      }
    }
    console.log(`tools/list: ${tools.tools.length} tools`);

    const health = parseMcpText(await client.callTool({ name: 'get_health', arguments: {} }));
    if (!health || typeof health !== 'object') {
      throw new Error('get_health did not return an object');
    }
    console.log('get_health: ok');

    const writeback = parseMcpText(await client.callTool({
      name: 'route_memory_writeback',
      arguments: WRITEBACK_SMOKE_ARGUMENTS,
    }));
    assertWritebackSmokeResult(writeback);
    console.log('route_memory_writeback: dry-run ok');

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
      // The MCP put_page surface rejects a blind create (no session, no content hash); a fresh
      // smoke write uses admin_put_page, the CLI/admin repair escape. It is dispatchable by name
      // even though it is hidden from the default tool catalog.
      name: 'admin_put_page',
      arguments: { slug, content },
    }));

    const page = parseMcpText(await client.callTool({
      name: 'get_page',
      arguments: { slug },
    }));
    if (page.slug !== slug || page.title !== 'Install Check') {
      throw new Error(`get_page returned unexpected page: ${JSON.stringify(page)}`);
    }
    console.log('page lifecycle: write/read ok');

    const searchResults = parseMcpText(await client.callTool({
      name: 'search',
      arguments: { query: 'Install smoke check' },
    }));
    if (!Array.isArray(searchResults)) {
      throw new Error('search did not return an array');
    }
    const foundSmokePage = searchResults.some(entry =>
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
      // Keep the root error visible.
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
}

await main();
