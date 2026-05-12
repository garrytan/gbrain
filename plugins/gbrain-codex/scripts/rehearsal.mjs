import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { resolveGbrainExecutable } from './launch-gbrain-serve.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');

function textContent(result) {
  const first = Array.isArray(result?.content) ? result.content[0] : null;
  return first && first.type === 'text' ? first.text : '';
}

function runAndCapture(command, args, env) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\n` +
      `${result.stderr || result.stdout || '(no output)'}`,
    );
  }
  return result.stdout.trim();
}

function ensureTempBrain(command, env) {
  runAndCapture(command, ['init', '--pglite', '--non-interactive', '--json'], env);
}

function expectedToolNames(command, env) {
  const raw = runAndCapture(command, ['--tools-json'], env);
  return JSON.parse(raw).map(tool => tool.name);
}

function createSourceTreeWrapper() {
  const wrapperDir = mkdtempSync(join(tmpdir(), 'gbrain-codex-wrapper-'));
  const wrapperPath = join(wrapperDir, 'gbrain');
  writeFileSync(
    wrapperPath,
    `#!/bin/sh
cd ${JSON.stringify(REPO_ROOT)}
exec bun run src/cli.ts "$@"
`,
  );
  chmodSync(wrapperPath, 0o755);
  return { wrapperDir, wrapperPath };
}

export async function runRehearsal({ env = process.env } = {}) {
  const wrapper = !env.GBRAIN_CODEX_BIN ? createSourceTreeWrapper() : null;
  const resolvedEnv = wrapper
    ? { ...env, GBRAIN_CODEX_BIN: wrapper.wrapperPath }
    : env;
  const resolvedBin = resolveGbrainExecutable({ pluginRoot: PLUGIN_ROOT, env: resolvedEnv });
  const rehearsalHome = mkdtempSync(join(tmpdir(), 'gbrain-codex-home-'));
  const runtimeEnv = {
    ...resolvedEnv,
    PATH: resolvedBin.envPath,
    GBRAIN_HOME: rehearsalHome,
  };

  try {
    ensureTempBrain(resolvedBin.command, runtimeEnv);
    const expectedNames = expectedToolNames(resolvedBin.command, runtimeEnv);

    const transport = new StdioClientTransport({
      command: 'node',
      args: ['./scripts/launch-gbrain-serve.mjs'],
      cwd: PLUGIN_ROOT,
      env: runtimeEnv,
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'gbrain-codex-rehearsal', version: '1.0.0' },
      { capabilities: {} },
    );

    const stderrLines = [];
    if (transport.stderr) {
      transport.stderr.on('data', chunk => stderrLines.push(String(chunk)));
    }

    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const actualNames = listed.tools.map(tool => tool.name);
      if (actualNames.length !== expectedNames.length) {
        throw new Error(`tools/list count mismatch: expected ${expectedNames.length}, got ${actualNames.length}`);
      }
      if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
        throw new Error('tools/list names do not match gbrain --tools-json exactly');
      }

      const put = await client.callTool({
        name: 'put_page',
        arguments: {
          slug: 'notes/codex-plugin-rehearsal',
          content: [
            '---',
            'title: Codex Plugin Rehearsal',
            'type: note',
            '---',
            '',
            'Codex plugin rehearsal page.',
          ].join('\n'),
        },
      });
      if (put.isError) throw new Error(`put_page failed: ${textContent(put)}`);

      const get = await client.callTool({
        name: 'get_page',
        arguments: { slug: 'notes/codex-plugin-rehearsal' },
      });
      if (get.isError || !textContent(get).includes('codex-plugin-rehearsal')) {
        throw new Error(`get_page failed: ${textContent(get)}`);
      }

      const search = await client.callTool({
        name: 'search',
        arguments: { query: 'Codex plugin rehearsal page' },
      });
      if (search.isError) throw new Error(`search failed: ${textContent(search)}`);

      const query = await client.callTool({
        name: 'query',
        arguments: { query: 'What page mentions Codex plugin rehearsal?' },
      });
      if (query.isError) throw new Error(`query failed: ${textContent(query)}`);

      const sync = await client.callTool({
        name: 'sync_brain',
        arguments: {
          repo: REPO_ROOT,
          dry_run: true,
          no_pull: true,
          no_embed: true,
        },
      });
      if (sync.isError) throw new Error(`sync_brain dry-run failed: ${textContent(sync)}`);

      const whoami = await client.callTool({
        name: 'whoami',
        arguments: {},
      });
      if (!whoami.isError || !textContent(whoami).includes('unknown_transport')) {
        throw new Error(`whoami should fail closed over stdio MCP, got: ${textContent(whoami)}`);
      }

      return {
        ok: true,
        toolCount: actualNames.length,
        sampleTools: ['put_page', 'get_page', 'search', 'query', 'sync_brain', 'whoami'],
        stderr: stderrLines.join('').trim(),
      };
    } finally {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    }
  } finally {
    rmSync(rehearsalHome, { recursive: true, force: true });
    if (wrapper) rmSync(wrapper.wrapperDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  runRehearsal().then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch(err => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
