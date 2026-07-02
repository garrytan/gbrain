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

  // v0.41.11 #1451 regression — `reindex` had a `case 'reindex':` handler
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

// #2450 — the local-engine output normalizer (cli.ts:445) used a bare
// JSON.stringify with no replacer. A bigint anywhere in an op's return value
// (e.g. a BIGSERIAL primary key read back by the Postgres engine) made
// JSON.stringify THROW "Do not know how to serialize a BigInt", crashing the
// command before any renderer ran. normalizeLocalResult now stringifies via
// bigintReplacer (bigint → string, postgres.js wire shape).
describe('BigInt-safe output normalization (#2450)', () => {
  test('bare JSON.stringify throws on a bigint (the pre-fix crash)', () => {
    // Pins the exact failure the fix removes: without a replacer this throws.
    // (Bun: "JSON.stringify cannot serialize BigInt."; Node: "Do not know how
    // to serialize a BigInt" — match the shared word either way.)
    expect(() => JSON.stringify({ id: 9999999999999999999n })).toThrow(
      /serialize BigInt|serialize a BigInt/i,
    );
  });

  test('normalizeLocalResult does NOT throw on a bigint result', async () => {
    const { normalizeLocalResult } = await import('../src/cli.ts');
    // BIGSERIAL primary key shape that crashed get_calibration_profile.
    const rawResult = { id: 42n, holder: 'h', nested: { count: 7n } };
    expect(() => normalizeLocalResult(rawResult)).not.toThrow();
  });

  test('normalizeLocalResult serializes bigint → string (postgres.js shape)', async () => {
    const { normalizeLocalResult } = await import('../src/cli.ts');
    const out = normalizeLocalResult({
      id: 42n,
      nested: { count: 7n },
      arr: [1n, 2n],
      str: 'unchanged',
      num: 3,
    }) as Record<string, unknown>;
    expect(out.id).toBe('42');
    expect((out.nested as Record<string, unknown>).count).toBe('7');
    expect(out.arr).toEqual(['1', '2']);
    // Non-bigint values pass through untouched.
    expect(out.str).toBe('unchanged');
    expect(out.num).toBe(3);
  });

  test('bigint past Number.MAX_SAFE_INTEGER keeps full precision as a string', async () => {
    const { normalizeLocalResult } = await import('../src/cli.ts');
    // A BIGSERIAL beyond 2^53 would lose precision via Number(); the string
    // form preserves every digit and matches the routed-path wire shape.
    const big = 9007199254740993n; // MAX_SAFE_INTEGER + 2
    const out = normalizeLocalResult({ id: big }) as Record<string, unknown>;
    expect(out.id).toBe('9007199254740993');
  });

  test("formatResult's default renderer is bigint-safe", async () => {
    const { formatResult } = await import('../src/cli.ts');
    // An op with no custom case falls through to the JSON.stringify default.
    expect(() => formatResult('__no_such_op__', { id: 5n })).not.toThrow();
    expect(formatResult('__no_such_op__', { id: 5n })).toContain('"5"');
  });

  test('cli.ts no longer uses a replacer-less stringify on the normalize path', () => {
    // Structural guard: the bare `JSON.parse(JSON.stringify(rawResult))` that
    // threw must be gone, replaced by the bigint-safe normalizeLocalResult.
    expect(cliSource).toContain('normalizeLocalResult(rawResult)');
    expect(cliSource).not.toContain('JSON.parse(JSON.stringify(rawResult))');
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

  test('sync --help prints sync-specific usage block without running sync (v0.37 D.4)', async () => {
    // v0.37 fix wave (Lane D.4 + CDX2-12): sync was added to
    // CLI_ONLY_SELF_HELP so `gbrain sync --help` reaches runSync's own
    // usage block (which lists --no-embed, the flag that didn't surface
    // anywhere pre-fix). Pre-fix the generic CLI-only short-circuit
    // printed a header but never mentioned --no-embed.
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
      // D.4 regression: the user-visible flag that the bug report wanted
      // surfaced. Pre-v0.37 this string was unreachable.
      expect(stdout).toContain('--no-embed');
      // Sync must NOT actually run (no engine bind, no init).
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
