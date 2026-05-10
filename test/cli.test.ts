import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Read cli.ts source for structural checks
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');
const repoRoot = new URL('..', import.meta.url).pathname;

function isolatedEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  env.GBRAIN_HOME = home;
  return env;
}

describe('CLI structure', () => {
  test('imports operations from operations.ts', () => {
    expect(cliSource).toContain("from './core/operations.ts'");
  });

  test('builds cliOps map from operations', () => {
    expect(cliSource).toContain('cliOps');
  });

  test('CLI_ONLY set contains expected commands', () => {
    expect(cliSource).toContain("'init'");
    expect(cliSource).toContain("'upgrade'");
    expect(cliSource).toContain("'import'");
    expect(cliSource).toContain("'export'");
    expect(cliSource).toContain("'embed'");
    expect(cliSource).toContain("'files'");
  });

  test('has formatResult function for CLI output', () => {
    expect(cliSource).toContain('function formatResult');
  });
});

describe('CLI version', () => {
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

describe('ask alias', () => {
  test('ask alias maps to query in source', () => {
    expect(cliSource).toContain("if (command === 'ask')");
    expect(cliSource).toContain("command = 'query'");
  });

  test('ask does NOT appear in --tools-json output', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--tools-json'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const tools = JSON.parse(stdout);
    const names = tools.map((t: any) => t.name);
    expect(names).not.toContain('ask');
  });
});

describe('CLI dispatch integration', () => {
  test('--version outputs version', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--version'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout.trim()).toMatch(/^gbrain \d+\.\d+\.\d+/);
  });

  test('unknown command prints error and exits 1', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'notacommand'], {
      cwd: new URL('..', import.meta.url).pathname,
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
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain get');
    expect(exitCode).toBe(0);
  });

  test('upgrade --help prints usage without running upgrade', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'upgrade', '--help'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain upgrade');
    expect(exitCode).toBe(0);
  });

  test('sync --help short-circuits CLI-only dispatch without running sync', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-help-'));
    try {
      const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'sync', '--help'], {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
        env: isolatedEnv(home),
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      expect(stdout).toContain('Usage: gbrain sync');
      expect(stdout).toContain('run gbrain --help for the full command list');
      expect(stdout).not.toContain('Already up to date.');
      expect(stderr).not.toContain('Already up to date.');
      expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('doctor --help short-circuits CLI-only dispatch without diagnostics', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-help-'));
    try {
      const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'doctor', '--help'], {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
        env: isolatedEnv(home),
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      expect(stdout).toContain('Usage: gbrain doctor');
      expect(stdout).not.toContain('resolver_health');
      expect(stderr).not.toContain('No brain configured');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('init --help short-circuits CLI-only dispatch without writing config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-help-'));
    try {
      const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--help'], {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
        env: isolatedEnv(home),
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      expect(stdout).toContain('Usage: gbrain init');
      expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--help prints global help', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--help'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('USAGE');
    expect(stdout).toContain('gbrain <command>');
    expect(exitCode).toBe(0);
  });

  test('--tools-json outputs valid JSON with operations', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--tools-json'], {
      cwd: repoRoot,
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
});
