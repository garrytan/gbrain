import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = new URL('..', import.meta.url).pathname;
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');
const initSource = readFileSync(new URL('../src/commands/init.ts', import.meta.url), 'utf-8');
const originalEnv = { ...process.env };
let tempHome: string;

function writeUserConfig(config: Record<string, unknown>) {
  const dir = join(tempHome, '.mbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
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
  rmSync(tempHome, { recursive: true, force: true });
});

describe('CLI source shape', () => {
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
});
