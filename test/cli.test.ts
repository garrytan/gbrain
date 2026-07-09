import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Read cli.ts source for structural checks
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const result = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env,
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

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

  // v0.41.11 #1451 regression 鈥?`reindex` had a `case 'reindex':` handler
  // at src/cli.ts:1334 but was missing from CLI_ONLY, so the dispatcher
  // rejected `gbrain reindex` with "Unknown command: reindex" before the
  // handler ever ran. Cherry-picked from kylma-code-adjacent PR #1354.
  test('reindex is in CLI_ONLY (does not get "Unknown command")', () => {
    const onlyMatch = cliSource.match(/const CLI_ONLY = new Set\(\[([\s\S]*?)\]\)/);
    expect(onlyMatch).not.toBeNull();
    expect(onlyMatch![1]).toContain(`'reindex'`);
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
    const result = runCli(['--tools-json']);
    const tools = JSON.parse(result.stdout);
    const names = tools.map((t: any) => t.name);
    expect(names).not.toContain('ask');
  });
});
describe('CLI dispatch integration', () => {
  test('--version outputs version', async () => {
    const result = runCli(['--version']);
    expect(result.stdout.trim()).toMatch(/^pmbrain \d+\.\d+\.\d+/);
  });

  test('unknown command prints error and exits 1', async () => {
    const result = runCli(['notacommand']);
    expect(result.stderr).toContain('未知命令：notacommand');
    expect(result.exitCode).toBe(1);
  });

  test('per-command --help prints usage without DB connection', async () => {
    const result = runCli(['get', '--help']);
    expect(result.stdout).toContain('用法：pmbrain get');
    expect(result.exitCode).toBe(0);
  });

  test('upgrade --help prints usage without running upgrade', async () => {
    const result = runCli(['upgrade', '--help']);
    expect(result.stdout).toContain('用法：pmbrain upgrade');
    expect(result.exitCode).toBe(0);
  });

  test('sync --help prints sync-specific usage block without running sync (v0.37 D.4)', async () => {
    // v0.37 fix wave (Lane D.4 + CDX2-12): sync was added to
    // CLI_ONLY_SELF_HELP so `pmbrain sync --help` reaches runSync's own
    // usage block (which lists --no-embed, the flag that didn't surface
    // anywhere pre-fix). Pre-fix the generic CLI-only short-circuit
    // printed a header but never mentioned --no-embed.
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-help-'));
    try {
      const result = runCli(['sync', '--help'], { env: isolatedEnv(home) });
      expect(result.stdout).toContain('用法：pmbrain sync');
      // D.4 regression: the user-visible flag that the bug report wanted
      // surfaced. Pre-v0.37 this string was unreachable.
      expect(result.stdout).toContain('--no-embed');
      // Sync must NOT actually run (no engine bind, no init).
      expect(result.stdout).not.toContain('Already up to date.');
      expect(result.stderr).not.toContain('Already up to date.');
      expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('doctor --help short-circuits CLI-only dispatch without diagnostics', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-help-'));
    try {
      const result = runCli(['doctor', '--help'], { env: isolatedEnv(home) });
      expect(result.stdout).toContain('用法：pmbrain doctor');
      expect(result.stdout).not.toContain('resolver_health');
      expect(result.stderr).not.toContain('No brain configured');
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('init --help short-circuits CLI-only dispatch without writing config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-help-'));
    try {
      const result = runCli(['init', '--help'], { env: isolatedEnv(home) });
      expect(result.stdout).toContain('用法');
      expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--help prints global help', async () => {
    const result = runCli(['--help']);
    expect(result.stdout).toContain('用法');
    expect(result.stdout).toContain('pmbrain <命令>');
    expect(result.exitCode).toBe(0);
  });

  test('--tools-json outputs valid JSON with operations', async () => {
    const result = runCli(['--tools-json']);
    const tools = JSON.parse(result.stdout);
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(30);
    expect(tools[0]).toHaveProperty('name');
    expect(tools[0]).toHaveProperty('description');
    expect(tools[0]).toHaveProperty('parameters');
  });
});
