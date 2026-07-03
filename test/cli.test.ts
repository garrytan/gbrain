import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations, parseOpArgs } from '../src/core/operations.ts';

const repoRoot = new URL('..', import.meta.url).pathname;
const repoRootUrl = new URL('..', import.meta.url).href;
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');
const initSource = readFileSync(new URL('../src/commands/init.ts', import.meta.url), 'utf-8');
const serveSource = readFileSync(new URL('../src/commands/serve.ts', import.meta.url), 'utf-8');
const agentSessionSource = readFileSync(new URL('../src/commands/agent-session.ts', import.meta.url), 'utf-8');
const edgeIndexSource = readFileSync(new URL('../supabase/functions/mbrain-mcp/index.ts', import.meta.url), 'utf-8');
const readmeSource = readFileSync(new URL('../README.md', import.meta.url), 'utf-8');
const originalEnv = { ...process.env };
let tempHome: string;

function writeUserConfig(config: Record<string, unknown>) {
  const dir = join(tempHome, '.mbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

function runGit(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr) || `git ${args.join(' ')} failed`);
  }
}

function signCompiledBinaryForLocalMacos(binPath: string) {
  if (process.platform !== 'darwin') return;

  Bun.spawnSync({
    cmd: ['codesign', '--remove-signature', binPath],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const result = Bun.spawnSync({
    cmd: ['codesign', '--sign', '-', '--force', binPath],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr) || `codesign ${binPath} failed`);
  }
}

async function readStreamUntil(
  stream: ReadableStream<Uint8Array> | null,
  expected: string,
  timeoutMs = 5000,
): Promise<{ text: string; readRest: () => Promise<string> }> {
  if (!stream) throw new Error('expected a readable process stream');

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;

  while (!text.includes(expected)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`timed out waiting for process output: ${expected}\n${text}`);
    }

    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(remainingMs).then(() => ({ timeout: true as const })),
    ]);
    if ('timeout' in chunk) {
      throw new Error(`timed out waiting for process output: ${expected}\n${text}`);
    }
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }

  return {
    text,
    readRest: async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return text;
    },
  };
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'mbrain-cli-'));
  process.env.HOME = tempHome;
  delete process.env.MBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env = { ...originalEnv };
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

describe('CLI source shape', () => {
  test('operations contract still includes sync_brain', () => {
    expect(operations.some(op => op.name === 'sync_brain')).toBe(true);
  });

  test('lifecycle forgetting operations are exposed through MCP and CLI contract', () => {
    const lifecycleOps = operations.filter(op => op.name.includes('lifecycle'));
    expect(lifecycleOps.map(op => [op.name, op.cliHints?.name, op.mutating])).toEqual(
      expect.arrayContaining([
        ['get_lifecycle_forgetting_report', 'lifecycle-report', false],
        ['plan_lifecycle_purge', 'lifecycle-plan-purge', true],
        ['restore_lifecycle_memory', 'lifecycle-restore', true],
        ['review_lifecycle_purge_plan', 'lifecycle-review-purge-plan', true],
        ['purge_lifecycle_memory', 'lifecycle-purge', true],
      ]),
    );
    expect(cliSource).toContain('lifecycle-report [--scope-id S]');
    expect(cliSource).toContain('lifecycle-plan-purge [--scope-id S]');
    expect(cliSource).toContain('lifecycle-restore --entity-type T --entity-id ID');
    expect(cliSource).toContain('lifecycle-review-purge-plan --purge-plan-id P --decision approve');
    expect(cliSource).toContain('lifecycle-purge --entity-type T --entity-id ID --purge-plan-id P');
  });

  test('assertion retrieval operation is exposed through MCP and CLI contract', () => {
    const operation = operations.find(op => op.name === 'list_retrievable_assertions');

    expect(operation?.cliHints?.name).toBe('assertion-retrieval');
    expect(operation?.mutating).toBeUndefined();
    expect(cliSource).toContain('assertion-retrieval [--target-slug S]');
  });

  test('setup-agent help mentions Claude hook installation', () => {
    expect(cliSource).toContain('Register MCP, inject rules, install Claude prompt/stop hooks');
    expect(cliSource).toContain('setup-agent [--preview|--diff|--apply|--uninstall]');
    expect(cliSource).toContain('Preview managed setup actions without writing files');
    expect(cliSource).toContain('Show redacted managed setup diffs without writing files');
    expect(cliSource).toContain('Remove managed setup actions without touching user content');
    expect(cliSource).not.toContain('planned, not yet implemented');
  });

  test('connectors command is exposed as an engine-backed registry sync command', () => {
    expect(cliSource).toContain("connectors: async () => (await import('./commands/connectors.ts')).runConnectors");
    expect(cliSource).toContain('connectors [list|show|sync]');

    const noEngineBlock = cliSource.match(/const DIRECT_NO_ENGINE_COMMANDS:.*?= \{(.*?)\};/s)?.[1] ?? '';
    const engineBlock = cliSource.match(/const DIRECT_ENGINE_COMMANDS:.*?= \{(.*?)\};/s)?.[1] ?? '';
    expect(noEngineBlock).not.toContain('connectors');
    expect(engineBlock).toContain('connectors');
    expect(cliSource).toContain("command === 'connectors' && args[0] !== 'sync'");
  });

  test('memory-report command is exposed as the review report surface', () => {
    expect(cliSource).toContain("'memory-report': async () => (await import('./commands/memory-report.ts')).runMemoryReport");
    expect(cliSource).toContain('memory-report [--json] [--save]');
    expect(cliSource).toContain('Save the formatted report under brain/reports/memory-review-report');

    const noEngineBlock = cliSource.match(/const DIRECT_NO_ENGINE_COMMANDS:.*?= \{(.*?)\};/s)?.[1] ?? '';
    const engineBlock = cliSource.match(/const DIRECT_ENGINE_COMMANDS:.*?= \{(.*?)\};/s)?.[1] ?? '';
    expect(noEngineBlock).not.toContain("'memory-report'");
    expect(engineBlock).toContain("'memory-report'");
  });

  test('canonicalize commands are path-first preview-only commands that do not require a configured DB', () => {
    const operation = operations.find(op => op.name === 'preview_canonicalize_path');
    expect(operation).toBeUndefined();

    const noEngineBlock = cliSource.match(/const DIRECT_NO_ENGINE_COMMANDS:.*?= \{(.*?)\};/s)?.[1] ?? '';
    const engineBlock = cliSource.match(/const DIRECT_ENGINE_COMMANDS:.*?= \{(.*?)\};/s)?.[1] ?? '';
    expect(noEngineBlock).toContain('canonicalize');
    expect(noEngineBlock).toContain("'canonicalize-code'");
    expect(engineBlock).not.toContain('canonicalize');
    expect(cliSource).toContain('canonicalize <path>');
    expect(cliSource).toContain('Preview draft from a PDF, Markdown/text file, or source tree');
    expect(cliSource).toContain('PDFs are metadata-only in this MVP');
    expect(cliSource).toContain('Preview source-code project draft from a repository path');
    expect(readmeSource).toContain('PDFs are metadata-only in this MVP');
    expect(readmeSource).toContain('mbrain canonicalize-code ~/src/acme-api');
    expect(readmeSource).not.toContain('mbrain canonicalize-code ~/src/acme-api --json');
  });

  test('imports operations from operations.ts', () => {
    expect(cliSource).toContain("from './core/operations.ts'");
  });

  test('generic CLI dispatch validates operation params before handler execution', () => {
    expect(cliSource).toContain('dispatchOperation');
    expect(cliSource).toContain('const result = await dispatchOperation(ctx, op, params)');
  });

  test('edge and agent-session dispatch through shared operation validation', () => {
    expect(agentSessionSource).toContain('dispatchOperation');
    expect(agentSessionSource).toContain('const result = await dispatchOperation(ctx, op, input)');
    expect(agentSessionSource).not.toContain('op.handler(ctx, input)');
    expect(edgeIndexSource).toContain('dispatchOperation');
    expect(edgeIndexSource).toContain('const result = await dispatchOperation(ctx, op, prepareRemoteToolParams(name, params))');
    expect(edgeIndexSource).not.toContain('op.handler(ctx, params || {})');
  });

  test('builds cliOps map from operations', () => {
    expect(cliSource).toContain('cliOps');
  });

  test('has formatResult function for CLI output', () => {
    expect(cliSource).toContain('function formatResult');
  });

  test('CLI uses shared command loader registries for CLI-only commands', () => {
    expect(cliSource).toContain('CLI_NO_ENGINE_COMMANDS');
    expect(cliSource).toContain('CLI_ENGINE_COMMANDS');
  });

  test('CLI_ONLY is limited to the small shell/process-bound command set', () => {
    const cliOnlyBlock = cliSource.match(/const CLI_ONLY = new Set\(\[(.*?)\]\);/s)?.[1] ?? '';
    expect(cliOnlyBlock).toContain("'serve'");
    expect(cliOnlyBlock).toContain("'setup-agent'");
    expect(cliOnlyBlock).toContain("'upgrade'");
    expect(cliOnlyBlock).toContain("'post-upgrade'");
    expect(cliOnlyBlock).toContain("'check-update'");

    expect(cliOnlyBlock).not.toContain("'init'");
    expect(cliOnlyBlock).not.toContain("'import'");
    expect(cliOnlyBlock).not.toContain("'doctor'");
    expect(cliOnlyBlock).not.toContain("'embed'");
    expect(cliOnlyBlock).not.toContain("'files'");
  });

  test('every remaining CLI_ONLY command has an explanatory comment', () => {
    expect(cliSource).toContain('`setup-agent` edits user tooling config and installs hooks outside the shared contract.');
    expect(cliSource).toContain('`upgrade` replaces the installed package/binary and is process-management only.');
    expect(cliSource).toContain('`post-upgrade` finalizes shell/package-manager side effects after self-update.');
    expect(cliSource).toContain('`check-update` queries release metadata without depending on brain state.');
    expect(cliSource).toContain('`serve` owns the current stdio process and cannot run through the shared request/response contract.');
  });

  test('serve CLI-only dispatch normalizes HTTP flags before starting the server', () => {
    expect(cliSource).toContain('await runServe(enginePromise, normalizeCliOnlyArgs(command, args));');
  });

  test('serve exposes OAuth scope allowlist through the top-level CLI spec', () => {
    expect(cliSource).toContain('oauth_allowed_scopes');
    expect(cliSource).toContain('--oauth-allowed-scopes');
  });

  test('serve refuses OAuth startup without both dedicated secrets', async () => {
    const { getHttpOAuthServeStartupErrors } = await import('../src/commands/serve.ts');

    expect(serveSource).toContain('OAuth requires both MBRAIN_OAUTH_APPROVAL_TOKEN and MBRAIN_OAUTH_SIGNING_SECRET');
    expect(serveSource).toContain('The previous fallback (signing refresh tokens with the approval token) was removed');
    expect(serveSource).toContain('process.exit(1)');
    expect(getHttpOAuthServeStartupErrors({
      oauth: true,
      publicBaseUrl: 'https://brain.example.com',
      oauthApprovalToken: 'owner-secret',
      oauthSigningSecret: undefined,
    })).toEqual([
      'OAuth requires both MBRAIN_OAUTH_APPROVAL_TOKEN and MBRAIN_OAUTH_SIGNING_SECRET to be set.',
      'The previous fallback (signing refresh tokens with the approval token) was removed for security.',
      'Generate a dedicated secret, e.g.: openssl rand -hex 32',
    ]);
  });

  test('serve refuses OAuth startup without an explicit public URL', async () => {
    const { getHttpOAuthServeStartupErrors } = await import('../src/commands/serve.ts');

    expect(getHttpOAuthServeStartupErrors({
      oauth: true,
      publicBaseUrl: undefined,
      oauthApprovalToken: 'owner-secret-long',
      oauthSigningSecret: 'test-signing-secret',
    })).toEqual([
      'OAuth requires --public-url or MBRAIN_HTTP_PUBLIC_URL when OAuth is enabled.',
    ]);

    expect(getHttpOAuthServeStartupErrors({
      oauth: true,
      publicBaseUrl: 'https://brain.example.com',
      oauthApprovalToken: 'owner-secret-long',
      oauthSigningSecret: 'test-signing-secret',
    })).toEqual([]);
  });

  test('serve refuses OAuth startup when approval token is too short', async () => {
    const { getHttpOAuthServeStartupErrors } = await import('../src/commands/serve.ts');

    expect(getHttpOAuthServeStartupErrors({
      oauth: true,
      publicBaseUrl: 'https://brain.example.com',
      oauthApprovalToken: 'short',
      oauthSigningSecret: 'test-signing-secret',
    })).toEqual([
      'OAuth approval token must be at least 16 characters.',
    ]);

    expect(getHttpOAuthServeStartupErrors({
      oauth: true,
      publicBaseUrl: 'https://brain.example.com',
      oauthApprovalToken: 'sixteen-chars-ok',
      oauthSigningSecret: 'test-signing-secret',
    })).toEqual([]);
  });

  test('auth command is exposed as an installed CLI verb', () => {
    expect(cliSource).toContain("'auth': async () => (await import('./commands/auth.ts')).runAuth");
    expect(cliSource).toContain('auth <create|list|revoke|test>');

    const noEngineBlock = cliSource.match(/const DIRECT_NO_ENGINE_COMMANDS:.*?= \{(.*?)\};/s)?.[1] ?? '';
    expect(noEngineBlock).toContain('auth');
  });

  test('init guidance keeps pgvector troubleshooting backend-neutral', () => {
    expect(initSource).toContain('Run this on your Postgres database');
    expect(initSource).not.toContain('Run in Supabase SQL Editor');
  });

  test('init guidance treats Supabase as an optional example, not the only setup path', () => {
    expect(initSource).toContain('optional managed Postgres helper');
    expect(initSource).toContain('Any working postgres:// or postgresql:// connection string is acceptable');
  });
});

describe('CLI version', () => {
  test('package identity uses mbrain for package and bin names', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    expect(pkg.name).toBe('mbrain');
    expect(pkg.bin).toMatchObject({ mbrain: 'src/cli.ts' });
    expect(pkg.description).toContain('Postgres + pgvector');
    expect(pkg.description).toContain('SQLite/offline compatibility');
    expect(pkg.description).not.toContain('Local-first');
  });

  test('VERSION matches package.json', async () => {
    const { VERSION } = await import('../src/version.ts');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
  });

  test('release metadata is aligned across package, manifests, VERSION, and changelog', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    const skillsManifest = JSON.parse(readFileSync(new URL('../skills/manifest.json', import.meta.url), 'utf-8'));
    const openclawManifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf-8'));
    const versionFile = readFileSync(new URL('../VERSION', import.meta.url), 'utf-8').trim();
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf-8');

    expect(versionFile).toBe(pkg.version);
    expect(skillsManifest.version).toBe(pkg.version);
    expect(openclawManifest.version).toBe(pkg.version);
    expect(changelog).toContain(`## [${pkg.version}] - `);
  });

  test('package exposes the focused agent trust verification script', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    expect(pkg.scripts['test:agent-trust']).toBe(
      'bun test ./test/setup-agent-trust-ux.test.ts ./test/setup-agent.test.ts ./test/doctor-agent-explain.test.ts ./test/doctor.test.ts ./test/installed-agent-readiness-service.test.ts ./test/proof-agent-command.test.ts ./test/authority-first-integrated-acceptance.test.ts ./test/cli.test.ts',
    );
  });

  test('verification docs cover agent trust explain and integrated acceptance', () => {
    const verify = readFileSync(new URL('../docs/MBRAIN_VERIFY.md', import.meta.url), 'utf-8');
    expect(verify).toContain('Agent trust UX and integrated acceptance');
    expect(verify).toContain('bun run test:agent-trust');
    expect(verify).toContain('mbrain doctor --agent --explain --json');
    expect(verify).toContain('read-only');
    expect(verify).toContain('answer-authority boundaries');
    expect(verify).toContain('read_context');
    expect(verify).toContain('proof status');
    expect(verify).toContain('zero authority-first safety counters');
  });

  test('VERSION is a valid semver string', async () => {
    const { VERSION } = await import('../src/version.ts');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('CLI dispatch integration', () => {
  test('HTTP OAuth serve prepares schema before exposing OAuth-backed routes', async () => {
    const { prepareHttpServeEngine } = await import('../src/commands/serve.ts');
    const calls: string[] = [];
    const engine = {
      initSchema: async () => {
        calls.push('initSchema');
      },
    };

    const prepared = await prepareHttpServeEngine(Promise.resolve(engine as any), true);

    expect(prepared).toBe(engine as any);
    expect(calls).toEqual(['initSchema']);
  });

  test('HTTP serve without OAuth prepares only the MCP HTTP surface schema', async () => {
    const { prepareHttpServeEngine } = await import('../src/commands/serve.ts');
    const calls: string[] = [];
    const engine = {
      initSchema: async () => {
        calls.push('initSchema');
      },
      prepareMcpHttpSurfaceSchema: async () => {
        calls.push('prepareMcpHttpSurfaceSchema');
      },
    };

    const prepared = await prepareHttpServeEngine(engine as any, false);

    expect(prepared).toBe(engine as any);
    expect(calls).toEqual(['prepareMcpHttpSurfaceSchema']);
  });

  test('runInit postgres bootstrap uses createConnectedEngine so db.getConnection remains available', async () => {
    const scriptPath = join(tempHome, 'postgres-init-child.ts');
    writeFileSync(scriptPath, `
      import { readFileSync } from 'fs';
      import { join } from 'path';
      import { mock } from 'bun:test';

      const repoRootUrl = ${JSON.stringify(repoRootUrl)};
      const engineFactoryPath = new URL('src/core/engine-factory.ts', repoRootUrl).pathname;
      const dbPath = new URL('src/core/db.ts', repoRootUrl).pathname;
      const fakeSql = async (strings) => {
        const text = Array.from(strings).join('');
        if (text.includes("SELECT extname FROM pg_extension")) return [{ extname: 'vector' }];
        return [];
      };

      let createConnectedEngineCalls = 0;
      const fakeEngine = {
        connect: async () => undefined,
        initSchema: async () => undefined,
        getStats: async () => ({ page_count: 0 }),
        disconnect: async () => undefined,
      };

      mock.module(engineFactoryPath, () => ({
        createEngine: async () => {
          throw new Error('unexpected createEngine');
        },
        createEngineFromConfig: () => {
          throw new Error('createEngineFromConfig should not be used for postgres init');
        },
        createConnectedEngine: async (config) => {
          if (config.engine !== 'postgres') {
            throw new Error('expected postgres engine config');
          }
          createConnectedEngineCalls += 1;
          return fakeEngine;
        },
        toEngineConfig: (config) => config,
      }));

      mock.module(dbPath, () => ({
        getConnection: () => fakeSql,
        disconnect: async () => undefined,
      }));

      const logs = [];
      const originalLog = console.log;
      console.log = (...args) => {
        logs.push(args.map(arg => String(arg)).join(' '));
      };

      try {
        const { runInit } = await import(new URL(\`src/commands/init.ts?postgres-init=\${Date.now()}\`, repoRootUrl).href);
        await runInit(['--url', 'postgresql://user:pass@localhost:5432/mbrain', '--json']);
      } finally {
        console.log = originalLog;
      }

      if (createConnectedEngineCalls !== 1) {
        throw new Error(\`expected createConnectedEngine once, got \${createConnectedEngineCalls}\`);
      }

      const config = JSON.parse(readFileSync(join(process.env.HOME, '.mbrain', 'config.json'), 'utf-8'));
      if (config.engine !== 'postgres') {
        throw new Error(\`expected postgres engine in config, got \${config.engine}\`);
      }
      if (config.database_url !== 'postgresql://user:pass@localhost:5432/mbrain') {
        throw new Error('unexpected database_url in saved config');
      }
      if (!logs.some(line => line.includes('"engine":"postgres"'))) {
        throw new Error('expected json init output to mention postgres engine');
      }
    `);

    const proc = Bun.spawn(['bun', 'run', scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe('');
  });

  test('--version outputs version', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--version'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout.trim()).toMatch(/^mbrain \d+\.\d+\.\d+/);
  });

  test('unknown command prints error and exits 1', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'notacommand'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(stderr).toContain('Unknown command: notacommand');
    expect(exitCode).toBe(1);
  });

  test('config show does not require a live database connection', async () => {
    writeUserConfig({
      engine: 'postgres',
      database_url: 'postgresql://user:pass@127.0.0.1:1/mbrain',
      offline: false,
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
    });

    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'config', 'show'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('MBrain config:');
    expect(stdout).toContain('database_url: postgresql://user:***@127.0.0.1:1/mbrain');
  });

  test('per-command --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'get', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain get');
    expect(exitCode).toBe(0);
  });

  test('put --help prints governed route-first guidance without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'put', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: mbrain put <slug>');
    expect(stdout).toContain('--write-session-id');
    expect(stdout).toContain('write_session_id');
    expect(stdout).toContain('--expected-content-hash');
    expect(stdout).toContain('expected_content_hash');
    expect(stdout).toContain('route-first');
    expect(stdout).toContain('route-memory-writeback');
    expect(stdout).toContain('direct canonical write path');
    expect(stdout).toContain('router-issued write session');
    expect(stdout).toContain('with a real content hash when updating a page');
    expect(stdout).toContain('literal value null');
    expect(stdout).toContain('is not a write grant');
  });

  test('put CLI parses literal null as an absent-page expected content hash', () => {
    const put = operations.find(operation => operation.name === 'put_page');
    if (!put) throw new Error('put_page operation is missing');

    const params = parseOpArgs(put, [
      'concepts/new-cli-page',
      '--expected-content-hash',
      'null',
    ], {
      stdin: {
        isTTY: true,
        read: () => '',
      },
      warn: () => {},
    });

    expect(params).toMatchObject({
      slug: 'concepts/new-cli-page',
      expected_content_hash: null,
    });
  });

  test('CLI literal null coercion is limited to hash and snapshot preconditions', () => {
    const registerSource = operations.find(operation => operation.name === 'register_source');
    if (!registerSource) throw new Error('register_source operation is missing');

    const params = parseOpArgs(registerSource, [
      '--source-kind',
      'connector',
      '--display-name',
      'Literal Null Source',
      '--consent-state',
      'granted',
      '--connector-id',
      'null',
    ], {
      stdin: {
        isTTY: true,
        read: () => '',
      },
      warn: () => {},
    });

    expect(params.connector_id).toBe('null');
  });

  test('connectors --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'connectors', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain connectors');
    expect(stdout).toContain('--path');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('canonicalize previews a local document without DB connection', async () => {
    const docPath = join(tempHome, 'meeting-notes.md');
    writeFileSync(docPath, '# Meeting Notes\n\nThe launch review moved to Monday.\n');

    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'canonicalize', docPath], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Preview only: no canonical memory was written.');
    expect(stdout).toContain('Kind: markdown_file');
    expect(stdout).toContain('The document states: "The launch review moved to Monday."');
  });

  test('canonicalize rejects invalid type and timestamp before previewing', async () => {
    const docPath = join(tempHome, 'meeting-notes.md');
    writeFileSync(docPath, '# Meeting Notes\n\nThe launch review moved to Monday.\n');

    const invalidType = Bun.spawn(['bun', 'run', 'src/cli.ts', 'canonicalize', docPath, '--type', 'nonsense'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const invalidTypeStderr = await new Response(invalidType.stderr).text();
    expect(await invalidType.exited).toBe(1);
    expect(invalidTypeStderr).toContain('--type must be one of:');

    const invalidNow = Bun.spawn(['bun', 'run', 'src/cli.ts', 'canonicalize', docPath, '--now', 'not-a-date'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const invalidNowStderr = await new Response(invalidNow.stderr).text();
    expect(await invalidNow.exited).toBe(1);
    expect(invalidNowStderr).toContain('--now must be a valid ISO timestamp');
  });

  test('connectors list prints registry definitions without DB connection', async () => {
    writeUserConfig({
      engine: 'postgres',
      database_url: 'postgresql://user:pass@127.0.0.1:1/mbrain',
      offline: false,
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
    });

    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'connectors', 'list'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stdout).toContain('"id": "meeting_transcripts"');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('connectors show prints one connector definition without DB connection', async () => {
    writeUserConfig({
      engine: 'postgres',
      database_url: 'postgresql://user:pass@127.0.0.1:1/mbrain',
      offline: false,
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
    });

    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'connectors', 'show', 'meeting_transcripts'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stdout).toContain('"id": "meeting_transcripts"');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('serve --help documents stdio and HTTP modes without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'serve', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain serve');
    expect(stdout).toContain('--http');
    expect(stdout).toContain('--host');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--oauth');
    expect(stdout).toContain('--public-url');
    expect(stdout).toContain('--tier');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('memory-report --json does not fabricate a healthy report without a configured brain', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'memory-report', '--json'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tempHome,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).not.toContain('No reportable memory exceptions');
    expect(stdout).not.toContain('"status":"ok"');
    expect(stderr).toContain('No brain configured');
  });

  test('memory-report --save preserves --now through the top-level CLI path', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'mbrain-memory-report-cli-db-'));
    const reportDir = mkdtempSync(join(tmpdir(), 'mbrain-memory-report-cli-brain-'));
    const databasePath = join(dbDir, 'brain.sqlite');
    writeUserConfig({
      engine: 'sqlite',
      database_path: databasePath,
      offline: true,
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
    });

    try {
      const { SQLiteEngine } = await import('../src/core/sqlite-engine.ts');
      const engine = new SQLiteEngine();
      await engine.connect({ database_path: databasePath });
      await engine.initSchema();
      await engine.disconnect();

      const proc = Bun.spawn([
        'bun',
        'run',
        'src/cli.ts',
        'memory-report',
        '--save',
        '--report-dir',
        reportDir,
        '--now',
        '2026-06-15T03:04:00.000Z',
      ], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('Saved report:');
      expect(stdout).toContain('Generated: 2026-06-15T03:04:00.000Z');
      const savedDir = join(reportDir, 'reports', 'memory-review-report');
      const savedFiles = readdirSync(savedDir);
      expect(savedFiles).toHaveLength(1);
      const saved = readFileSync(join(savedDir, savedFiles[0]), 'utf-8');
      expect(saved).toContain('Generated: 2026-06-15T03:04:00.000Z');
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  test('compiled CLI embeds sync implementation for sync_brain dispatch', async () => {
    const buildDir = mkdtempSync(join(tmpdir(), 'mbrain-compiled-sync-cli-'));
    const binPath = join(buildDir, 'mbrain');
    const repoDir = join(buildDir, 'repo');
    mkdirSync(repoDir, { recursive: true });

    try {
      runGit(repoDir, 'init', '-q');
      runGit(repoDir, 'config', 'user.email', 'test@example.com');
      runGit(repoDir, 'config', 'user.name', 'Test User');
      writeFileSync(join(repoDir, 'note.md'), '# Note\n\nCompiled sync smoke.');
      runGit(repoDir, 'add', 'note.md');
      runGit(repoDir, 'commit', '-q', '-m', 'init');

      const build = Bun.spawn(['bun', 'build', '--compile', '--outfile', binPath, 'src/cli.ts'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const buildStdout = await new Response(build.stdout).text();
      const buildStderr = await new Response(build.stderr).text();
      const buildExitCode = await build.exited;
      expect(buildExitCode, `${buildStdout}\n${buildStderr}`).toBe(0);
      signCompiledBinaryForLocalMacos(binPath);

      const configDir = join(tempHome, '.mbrain');
      const env = {
        ...process.env,
        HOME: tempHome,
        MBRAIN_CONFIG_DIR: configDir,
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      };

      const init = Bun.spawn([binPath, 'init', '--local', '--json'], {
        cwd: repoRoot,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const initStdout = await new Response(init.stdout).text();
      const initStderr = await new Response(init.stderr).text();
      const initExitCode = await init.exited;
      expect(initExitCode, `${initStdout}\n${initStderr}`).toBe(0);

      const sync = Bun.spawn([binPath, 'sync', '--repo', repoDir, '--no-pull', '--dry-run'], {
        cwd: repoRoot,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(sync.stdout).text();
      const stderr = await new Response(sync.stderr).text();
      const exitCode = await sync.exited;

      expect(exitCode, stderr).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('Sync dry run: full import');
      expect(stdout).toContain('Added: note');

      const call = Bun.spawn([
        binPath,
        'call',
        'sync_brain',
        JSON.stringify({ repo: repoDir, no_pull: true, dry_run: true }),
      ], {
        cwd: repoRoot,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const callStdout = await new Response(call.stdout).text();
      const callStderr = await new Response(call.stderr).text();
      const callExitCode = await call.exited;

      expect(callExitCode, callStderr).toBe(0);
      expect(callStderr).toBe('');
      expect(callStdout).toContain('"status": "dry_run"');
      expect(callStdout).toContain('"pagesAffected"');
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
    }
  });

  test('dream --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'dream', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stdout).toContain('Usage: mbrain dream');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('auto-promote --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'auto-promote', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stdout).toContain('Usage: mbrain auto-promote');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('autopilot dream --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'autopilot', 'dream', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stdout).toContain('mbrain autopilot dream');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('task-list --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'task-list', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain task-list');
    expect(exitCode).toBe(0);
  });

  test('task-update --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'task-update', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain task-update <task_id>');
    expect(exitCode).toBe(0);
  });

  test('task-trace --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'task-trace', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain task-trace <task_id>');
    expect(exitCode).toBe(0);
  });

  test('task-traces --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'task-traces', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain task-traces <task_id>');
    expect(exitCode).toBe(0);
  });

  test('task-attempts --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'task-attempts', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain task-attempts <task_id>');
    expect(exitCode).toBe(0);
  });

  test('task-decisions --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'task-decisions', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain task-decisions <task_id>');
    expect(exitCode).toBe(0);
  });

  test('task-show --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'task-show', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain task-show <task_id>');
    expect(exitCode).toBe(0);
  });

  test('manifest-get --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'manifest-get', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain manifest-get <slug>');
    expect(exitCode).toBe(0);
  });

  test('manifest-list --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'manifest-list', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain manifest-list');
    expect(exitCode).toBe(0);
  });

  test('manifest-rebuild --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'manifest-rebuild', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain manifest-rebuild');
    expect(exitCode).toBe(0);
  });

  test('section-list --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'section-list', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain section-list <page_slug>');
    expect(exitCode).toBe(0);
  });

  test('section-neighbors --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'section-neighbors', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain section-neighbors <node_id>');
    expect(exitCode).toBe(0);
  });

  test('map-build --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'map-build', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain map-build');
    expect(exitCode).toBe(0);
  });

  test('map-get --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'map-get', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain map-get <id>');
    expect(exitCode).toBe(0);
  });

  test('map-list --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'map-list', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain map-list');
    expect(exitCode).toBe(0);
  });

  test('atlas-build --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'atlas-build', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain atlas-build');
    expect(exitCode).toBe(0);
  });

  test('atlas-get --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'atlas-get', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain atlas-get <id>');
    expect(exitCode).toBe(0);
  });

  test('atlas-list --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'atlas-list', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain atlas-list');
    expect(exitCode).toBe(0);
  });

  test('atlas-select --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'atlas-select', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain atlas-select');
    expect(exitCode).toBe(0);
  });

  test('atlas-overview --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'atlas-overview', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain atlas-overview');
    expect(exitCode).toBe(0);
  });

  test('atlas-report --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'atlas-report', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain atlas-report');
    expect(exitCode).toBe(0);
  });

  test('atlas-orientation-card --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'atlas-orientation-card', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain atlas-orientation-card');
    expect(exitCode).toBe(0);
  });

  test('atlas-orientation-bundle --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'atlas-orientation-bundle', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain atlas-orientation-bundle');
    expect(exitCode).toBe(0);
  });

  test('map-report --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'map-report', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain map-report');
    expect(exitCode).toBe(0);
  });

  test('map-explain --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'map-explain', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain map-explain');
    expect(exitCode).toBe(0);
  });

  test('map-query --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'map-query', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain map-query');
    expect(exitCode).toBe(0);
  });

  test('map-path --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'map-path', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain map-path');
    expect(exitCode).toBe(0);
  });

  test('broad-synthesis-route --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'broad-synthesis-route', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain broad-synthesis-route');
    expect(exitCode).toBe(0);
  });

  test('precision-lookup-route --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'precision-lookup-route', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain precision-lookup-route');
    expect(exitCode).toBe(0);
  });

  test('retrieval-route --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'retrieval-route', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain retrieval-route');
    expect(exitCode).toBe(0);
  });

  test('workspace-system-card --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'workspace-system-card', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain workspace-system-card');
    expect(exitCode).toBe(0);
  });

  test('workspace-project-card --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'workspace-project-card', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain workspace-project-card');
    expect(exitCode).toBe(0);
  });

  test('workspace-orientation --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'workspace-orientation', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain workspace-orientation');
    expect(exitCode).toBe(0);
  });

  test('workspace-corpus-card --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'workspace-corpus-card', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain workspace-corpus-card');
    expect(exitCode).toBe(0);
  });

  test('task-attempts and task-decisions execute against the shared task-memory contract', async () => {
    const initProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--local', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await initProc.exited).toBe(0);

    const startProc = Bun.spawn([
      'bun', 'run', 'src/cli.ts', 'task-start',
      '--title', 'Phase 1 MVP',
      '--goal', 'Ship operational memory',
      '--scope', 'work',
    ], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const startStdout = await new Response(startProc.stdout).text();
    expect(await startProc.exited).toBe(0);
    const task = JSON.parse(startStdout);
    const taskId = task.id as string;

    const attemptProc = Bun.spawn([
      'bun', 'run', 'src/cli.ts', 'task-attempt',
      '--task-id', taskId,
      '--summary', 'Tried raw-source-only reconstruction',
      '--outcome', 'failed',
    ], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await attemptProc.exited).toBe(0);

    const decisionProc = Bun.spawn([
      'bun', 'run', 'src/cli.ts', 'task-decision',
      '--task-id', taskId,
      '--summary', 'Keep task memory canonical in DB',
      '--rationale', 'Resume should not reconstruct from raw notes',
    ], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await decisionProc.exited).toBe(0);

    const attemptsProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'task-attempts', taskId], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const attemptsStdout = await new Response(attemptsProc.stdout).text();
    expect(await attemptsProc.exited).toBe(0);
    expect(attemptsStdout).toContain('failed');
    expect(attemptsStdout).toContain('Tried raw-source-only reconstruction');

    const decisionsProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'task-decisions', taskId], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const decisionsStdout = await new Response(decisionsProc.stdout).text();
    expect(await decisionsProc.exited).toBe(0);
    expect(decisionsStdout).toContain('Keep task memory canonical in DB');
    expect(decisionsStdout).toContain('Resume should not reconstruct from raw notes');
  });

  test('sync --help surfaces watch-mode CLI extension flags', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'sync', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain sync');
    expect(stdout).toContain('--watch');
    expect(stdout).toContain('--interval');
    expect(exitCode).toBe(0);
  });

  test('upgrade --help prints usage without running upgrade', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'upgrade', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain upgrade');
    expect(exitCode).toBe(0);
  });

  test('init --help prints usage without creating a brain', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain init');
    expect(stdout).toContain('--local');
    expect(stdout).toContain('Bare mbrain init now targets Postgres');
    expect(stdout).toContain('Legacy local SQLite profile');
    expect(stdout).toContain('--pglite');
    expect(stdout).toContain('--dsn');
    expect(stdout).toContain('--profile');
    expect(stdout).toContain('--supabase');
    expect(exitCode).toBe(0);
    // Must not have created any brain artifacts under $HOME/.mbrain
    const { existsSync } = await import('fs');
    expect(existsSync(join(tempHome, '.mbrain', 'config.json'))).toBe(false);
    expect(existsSync(join(tempHome, '.mbrain', 'brain.db'))).toBe(false);
    expect(existsSync(join(tempHome, '.mbrain', 'brain.pglite'))).toBe(false);
  });

  test('init -h prints usage without creating a brain', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '-h'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: mbrain init');
    expect(exitCode).toBe(0);
    const { existsSync } = await import('fs');
    expect(existsSync(join(tempHome, '.mbrain', 'config.json'))).toBe(false);
  });

  test('--help prints global help', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('USAGE');
    expect(stdout).toContain('mbrain <command>');
    expect(stdout).toContain('doctor [--json] [--agent] [--explain]');
    expect(stdout).toContain('AGENT MEMORY LOOP');
    expect(stdout).toContain('retrieve-context <query>');
    expect(stdout).toContain('read-context --selectors <json>');
    expect(stdout).toContain('route-memory-writeback');
    expect(stdout).toContain('memory-report [--json] [--save]');
    expect(stdout).toContain('put <slug> [< file.md]             Governed/direct canonical write; use expected content hash');
    expect(stdout).toContain('embed [<slug>|--all|--stale]');
    expect(stdout).toContain('serve [--http] [--host H] [--port P] [--oauth]');
    expect(stdout).toContain('[--oauth-allowed-scopes S]');
    expect(stdout).toContain('import <dir> [--no-embed]');
    expect(stdout).toContain('Health check (engine, schema, embeddings, local/managed capabilities)');
    expect(stdout).toContain('Keyword search (engine-native)');
    expect(stdout).not.toContain('Health check (pgvector, RLS, schema, embeddings)');
    expect(stdout).not.toContain('Keyword search (tsvector)');
    expect(exitCode).toBe(0);
  });

  test('--tools-json outputs valid JSON with operations', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--tools-json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const tools = JSON.parse(stdout);
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(30);
    expect(tools[0]).toHaveProperty('name');
    expect(tools[0]).toHaveProperty('description');
    expect(tools[0]).toHaveProperty('parameters');
  });

  test('get_skillpack can load technical knowledge section by number from the current skillpack index', async () => {
    const initProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--local', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await initProc.exited;

    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'call', 'get_skillpack', '{"section":"19"}'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    const result = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.section).toBe(19);
    expect(result.content).toContain('Technical Knowledge Maps');
    expect(result.content).toContain('System Pages');
  });

  test('bootstrap rejects unsupported provider config before attempting a database connection', async () => {
    writeUserConfig({
      engine: 'postgres',
      database_url: 'postgresql://user:pass@localhost:5432/mbrain',
      embedding_provider: 'remote',
    });

    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'stats'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stderr).toMatch(/unsupported embedding_provider: remote/i);
    expect(stderr).not.toMatch(/cannot connect to database/i);
    expect(exitCode).toBe(1);
  });

  test('bootstrap rejects invalid engine config before attempting a database connection', async () => {
    writeUserConfig({
      engine: 'mysql',
      database_url: 'postgresql://user:pass@localhost:5432/mbrain',
    });

    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'stats'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stderr).toMatch(/unsupported engine: mysql/i);
    expect(stderr).not.toMatch(/cannot connect to database/i);
    expect(exitCode).toBe(1);
  });

  test('doctor --json=true uses the same boolean normalization as shared contract commands', async () => {
    const initProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--local', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await initProc.exited).toBe(0);

    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'doctor', '--json=true'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(JSON.parse(stdout)).toHaveProperty('status');
  });

  test('sync stays operation-backed while preserving CLI status output for up-to-date runs', async () => {
    const initProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--local', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await initProc.exited).toBe(0);

    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-sync-repo-'));
    try {
      mkdirSync(join(repoDir, 'people'), { recursive: true });
      writeFileSync(join(repoDir, 'people', 'alice.md'), `---
type: person
title: Alice
---
Engineer.
`);

      runGit(repoDir, 'init');
      runGit(repoDir, 'config', 'user.email', 'test@example.com');
      runGit(repoDir, 'config', 'user.name', 'Test User');
      runGit(repoDir, 'add', '.');
      runGit(repoDir, 'commit', '-m', 'initial import');

      const firstSync = Bun.spawn(['bun', 'run', 'src/cli.ts', 'sync', '--repo', repoDir, '--no-pull'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await firstSync.exited).toBe(0);

      const secondSync = Bun.spawn(['bun', 'run', 'src/cli.ts', 'sync', '--repo', repoDir, '--no-pull'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(secondSync.stdout).text();
      const exitCode = await secondSync.exited;

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Already up to date.');
      expect(stdout).not.toContain('"status": "up_to_date"');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('sync --interval without watch fails fast with a clear CLI error', async () => {
    const initProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--local', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await initProc.exited).toBe(0);

    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-sync-interval-repo-'));
    try {
      mkdirSync(join(repoDir, 'people'), { recursive: true });
      writeFileSync(join(repoDir, 'people', 'alice.md'), `---
type: person
title: Alice
---
Engineer.
`);

      runGit(repoDir, 'init');
      runGit(repoDir, 'config', 'user.email', 'test@example.com');
      runGit(repoDir, 'config', 'user.name', 'Test User');
      runGit(repoDir, 'add', '.');
      runGit(repoDir, 'commit', '-m', 'initial import');

      const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'sync', '--repo', repoDir, '--no-pull', '--interval', '1'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(1);
      expect(stderr).toContain('--interval requires --watch');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('sync --watch=false stays on the one-shot operation-backed path', async () => {
    const initProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--local', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await initProc.exited).toBe(0);

    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-sync-watch-false-repo-'));
    try {
      mkdirSync(join(repoDir, 'people'), { recursive: true });
      writeFileSync(join(repoDir, 'people', 'alice.md'), `---
type: person
title: Alice
---
Engineer.
`);

      runGit(repoDir, 'init');
      runGit(repoDir, 'config', 'user.email', 'test@example.com');
      runGit(repoDir, 'config', 'user.name', 'Test User');
      runGit(repoDir, 'add', '.');
      runGit(repoDir, 'commit', '-m', 'initial import');

      const firstSync = Bun.spawn(['bun', 'run', 'src/cli.ts', 'sync', '--repo', repoDir, '--no-pull'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await firstSync.exited).toBe(0);

      const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'sync', '--repo', repoDir, '--no-pull', '--watch=false'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Already up to date.');
      expect(stdout).not.toContain('Watching for changes');
      expect(stderr).not.toContain('--interval requires --watch');
      expect(stderr).not.toContain('unknown flag --watch');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('sync --watch enters watch mode and stays alive until terminated', async () => {
    const initProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--local', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await initProc.exited).toBe(0);

    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-sync-watch-repo-'));
    try {
      mkdirSync(join(repoDir, 'people'), { recursive: true });
      writeFileSync(join(repoDir, 'people', 'alice.md'), `---
type: person
title: Alice
---
Engineer.
`);

      runGit(repoDir, 'init');
      runGit(repoDir, 'config', 'user.email', 'test@example.com');
      runGit(repoDir, 'config', 'user.name', 'Test User');
      runGit(repoDir, 'add', '.');
      runGit(repoDir, 'commit', '-m', 'initial import');

      const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'sync', '--repo', repoDir, '--no-pull', '--watch', '--interval', '1'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stdoutStream = await readStreamUntil(proc.stdout, 'Watching for changes every 1s');
      const earlyExit = await Promise.race([
        proc.exited.then(code => ({ exited: true as const, code })),
        Bun.sleep(100).then(() => ({ exited: false as const })),
      ]);
      expect(earlyExit.exited).toBe(false);

      proc.kill();
      const [stdout, stderr] = await Promise.all([
        stdoutStream.readRest(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(stdout).toContain('Watching for changes every 1s');
      expect(stderr).not.toContain('unknown flag --watch');
      expect(stderr).not.toContain('unknown flag --interval');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('sync --watch surfaces unknown flag warnings instead of silently dropping them', async () => {
    const initProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--local', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await initProc.exited).toBe(0);

    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-sync-watch-warning-repo-'));
    try {
      mkdirSync(join(repoDir, 'people'), { recursive: true });
      writeFileSync(join(repoDir, 'people', 'alice.md'), `---
type: person
title: Alice
---
Engineer.
`);

      runGit(repoDir, 'init');
      runGit(repoDir, 'config', 'user.email', 'test@example.com');
      runGit(repoDir, 'config', 'user.name', 'Test User');
      runGit(repoDir, 'add', '.');
      runGit(repoDir, 'commit', '-m', 'initial import');

      const proc = Bun.spawn(
        ['bun', 'run', 'src/cli.ts', 'sync', '--repo', repoDir, '--no-pull', '--watch', '--interval', '1', '--bogus', 'value'],
        {
          cwd: repoRoot,
          env: { ...process.env, HOME: tempHome },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );

      const stdoutStream = await readStreamUntil(proc.stdout, 'Watching for changes every 1s');
      const earlyExit = await Promise.race([
        proc.exited.then(code => ({ exited: true as const, code })),
        Bun.sleep(100).then(() => ({ exited: false as const })),
      ]);
      expect(earlyExit.exited).toBe(false);

      proc.kill();
      const [stdout, stderr] = await Promise.all([
        stdoutStream.readRest(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(stdout).toContain('Watching for changes every 1s');
      expect(stderr).toContain('Warning: unknown flag --bogus (ignored)');
      expect(stderr).not.toContain('unknown flag --watch');
      expect(stderr).not.toContain('unknown flag --interval');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('sync --watch=true --interval=1 enters watch mode and stays alive until terminated', async () => {
    const initProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--local', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await initProc.exited).toBe(0);

    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-sync-watch-equals-repo-'));
    try {
      mkdirSync(join(repoDir, 'people'), { recursive: true });
      writeFileSync(join(repoDir, 'people', 'alice.md'), `---
type: person
title: Alice
---
Engineer.
`);

      runGit(repoDir, 'init');
      runGit(repoDir, 'config', 'user.email', 'test@example.com');
      runGit(repoDir, 'config', 'user.name', 'Test User');
      runGit(repoDir, 'add', '.');
      runGit(repoDir, 'commit', '-m', 'initial import');

      const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'sync', '--repo', repoDir, '--no-pull', '--watch=true', '--interval=1'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stdoutStream = await readStreamUntil(proc.stdout, 'Watching for changes every 1s');
      const earlyExit = await Promise.race([
        proc.exited.then(code => ({ exited: true as const, code })),
        Bun.sleep(100).then(() => ({ exited: false as const })),
      ]);
      expect(earlyExit.exited).toBe(false);

      proc.kill();
      const [stdout, stderr] = await Promise.all([
        stdoutStream.readRest(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(stdout).toContain('Watching for changes every 1s');
      expect(stderr).not.toContain('unknown flag --watch');
      expect(stderr).not.toContain('unknown flag --interval');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
