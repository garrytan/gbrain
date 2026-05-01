import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';

const repoRoot = new URL('..', import.meta.url).pathname;
const repoRootUrl = new URL('..', import.meta.url).href;
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');
const initSource = readFileSync(new URL('../src/commands/init.ts', import.meta.url), 'utf-8');
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

  test('setup-agent help mentions Claude stop hook installation', () => {
    expect(cliSource).toContain('Register MCP, inject rules, install Claude stop hook');
  });

  test('imports operations from operations.ts', () => {
    expect(cliSource).toContain("from './core/operations.ts'");
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
    expect(pkg.description).toContain('Local-first');
    expect(pkg.description).toContain('SQLite');
    expect(pkg.description).not.toContain('Postgres-native');
  });

  test('VERSION matches package.json', async () => {
    const { VERSION } = await import('../src/version.ts');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
  });

  test('VERSION is a valid semver string', async () => {
    const { VERSION } = await import('../src/version.ts');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('CLI dispatch integration', () => {
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
    expect(stdout).toContain('Recommended personal path: local SQLite');
    expect(stdout).toContain('Bare mbrain init remains local PGLite for compatibility');
    expect(stdout).toContain('--pglite');
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
    expect(stdout).toContain('doctor [--json]');
    expect(stdout).toContain('embed [<slug>|--all|--stale]');
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

  test('bootstrap rejects invalid engine/provider config before attempting a database connection', async () => {
    writeUserConfig({
      engine: 'postgres',
      database_url: 'postgresql://user:pass@localhost:5432/mbrain',
      embedding_provider: 'local',
    });

    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'stats'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stderr).toMatch(/embedding_provider.*requires sqlite/i);
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

      const earlyExit = await Promise.race([
        proc.exited.then(code => ({ exited: true as const, code })),
        Bun.sleep(400).then(() => ({ exited: false as const })),
      ]);
      expect(earlyExit.exited).toBe(false);

      proc.kill();
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
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

      const earlyExit = await Promise.race([
        proc.exited.then(code => ({ exited: true as const, code })),
        Bun.sleep(400).then(() => ({ exited: false as const })),
      ]);
      expect(earlyExit.exited).toBe(false);

      proc.kill();
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
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

      const earlyExit = await Promise.race([
        proc.exited.then(code => ({ exited: true as const, code })),
        Bun.sleep(400).then(() => ({ exited: false as const })),
      ]);
      expect(earlyExit.exited).toBe(false);

      proc.kill();
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
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
