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

  // #2035-class dispatch-gap guard: every `case '...'` label inside
  // handleCliOnly's top-level dispatch must be a member of CLI_ONLY, else the
  // command is registered but unreachable — 'calibration' shipped exactly this
  // way. Structural, self-updating: a new case without a CLI_ONLY entry fails
  // here at PR time.
  test('every handleCliOnly top-level case label is reachable via CLI_ONLY', () => {
    const onlyMatch = cliSource.match(/const CLI_ONLY = new Set(?:<string>)?\(\[([\s\S]*?)\]\)/);
    expect(onlyMatch).not.toBeNull();
    // Strip line comments before member extraction — the set literal carries
    // commentary whose quoted words must not count as members.
    const onlyBody = onlyMatch![1].replace(/\/\/[^\n]*/g, '');
    const members = new Set([...onlyBody.matchAll(/'([^']+)'/g)].map(m => m[1]));

    const fnStart = cliSource.indexOf('async function handleCliOnly');
    expect(fnStart).toBeGreaterThan(0);
    const fnSrc = cliSource.slice(fnStart);
    // Top-level dispatch labels sit at a fixed indent (6 spaces); nested
    // sub-switches are indented deeper and stay out of this scan.
    const caseLabels = [...fnSrc.matchAll(/^      case '([a-z0-9-]+)':/gm)].map(m => m[1]);
    expect(caseLabels.length).toBeGreaterThan(20);
    // Reachable outside CLI_ONLY, each with a documented route:
    //  - 'search': pre-dispatch subcommand gate (modes|stats|tune) in main();
    //    the bare command must keep routing to the `search` op for queries.
    //  - 'whoknows': currently routes via the find_experts op alias; its
    //    handleCliOnly case is dead (adding it to CLI_ONLY would trip the
    //    alias-collision guard and silently change output). Tracked follow-up
    //    alongside PR #2509 (whoknows --explain).
    const REACHABLE_VIA_OTHER_ROUTE = new Set(['search', 'whoknows']);
    const missing = caseLabels.filter(
      label => !members.has(label) && !REACHABLE_VIA_OTHER_ROUTE.has(label),
    );
    expect(missing).toEqual([]);
    // The search gate itself must exist — losing it re-deadens the dashboards.
    // (master's gate is a superset: modes|stats|tune|diagnose.)
    expect(cliSource).toMatch(/\['modes', 'stats', 'tune'(?:, 'diagnose')?\]\.includes\(subArgs\[0\] \?\? ''\)/);
  });
});

// #2450 — the local-engine output normalizer used a bare JSON.stringify with
// no replacer. A bigint anywhere in an op's return value (e.g. a BIGSERIAL
// primary key read back by the Postgres engine) made JSON.stringify THROW
// "Do not know how to serialize a BigInt", crashing the command before any
// renderer ran. normalizeLocalResult stringifies via bigintToStringReplacer
// (bigint → string, postgres.js wire shape).
describe('BigInt-safe output normalization (#2450)', () => {
  test('bare JSON.stringify throws on a bigint (the pre-fix crash)', () => {
    expect(() => JSON.stringify({ id: 9999999999999999999n })).toThrow(
      /serialize BigInt|serialize a BigInt/i,
    );
  });

  test('normalizeLocalResult serializes bigint → string without throwing', async () => {
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
    expect(out.str).toBe('unchanged');
    expect(out.num).toBe(3);
  });

  test('bigint past Number.MAX_SAFE_INTEGER keeps full precision as a string', async () => {
    const { normalizeLocalResult } = await import('../src/cli.ts');
    const big = 9007199254740993n; // MAX_SAFE_INTEGER + 2
    const out = normalizeLocalResult({ id: big }) as Record<string, unknown>;
    expect(out.id).toBe('9007199254740993');
  });

  test("formatResult's default renderer is bigint-safe", async () => {
    const { formatResult } = await import('../src/cli.ts');
    expect(() => formatResult('__no_such_op__', { id: 5n })).not.toThrow();
    expect(formatResult('__no_such_op__', { id: 5n })).toContain('"5"');
  });

  test('cli.ts no longer uses a replacer-less stringify on the normalize path', () => {
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
      // init prints its OWN detailed help (printInitHelp), not the generic
      // CLI-only one-line stub. Assert on markers unique to the real help...
      expect(stdout).toContain('gbrain init [flags]');
      expect(stdout).toContain('ENGINE SELECTION');
      // ...and confirm the generic stub (printCliOnlyHelp) did NOT fire.
      expect(stdout).not.toContain('run gbrain --help for the full command list');
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
