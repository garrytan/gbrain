import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { surfaceFileSource } from './helpers/source-surface.ts';

// test-reads-source-ok[structural]: two kept pins need the dispatcher's text: the handleCliOnly case-label census (switch labels cannot be enumerated at runtime) and the local-op normalize call site (bigints only reach it from Postgres, never PGLite).
const cliSource = surfaceFileSource('cli', 'src/cli.ts');
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
  // #1451 regression class: a command with a live handleCliOnly case but no
  // CLI_ONLY entry is rejected as "Unknown command" before its handler runs
  // (reindex shipped that way). Spawned so dispatch, not the set, is judged.
  test('CLI-only commands reach their handlers instead of "Unknown command"', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-only-'));
    try {
      const results = await Promise.all(['reindex', 'import', 'export', 'embed', 'files'].map(async (command) => {
        const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', command, '--help'], {
          cwd: repoRoot,
          stdout: 'pipe',
          stderr: 'pipe',
          env: isolatedEnv(home),
        });
        const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        await proc.exited;
        return { command, output: stdout + stderr };
      }));
      for (const { command, output } of results) {
        expect(output, command).not.toContain('Unknown command');
      }
      expect(results.find(r => r.command === 'reindex')!.output).toContain('gbrain reindex');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // #2035-class dispatch-gap guard: every handleCliOnly handler must be a
  // member of CLI_ONLY, else the command is registered but unreachable —
  // 'calibration' shipped exactly this way. Refactor wave 1 (W4 cli) moved each
  // top-level `case '...'` body into its own module under src/cli/commands/
  // and derives CLI_ONLY from the command table, so the census is the module
  // files (a handler module with no record is the same dead-handler class).
  // Structural, self-updating: a new handler module without a CLI_ONLY entry
  // fails here at PR time.
  test('every handleCliOnly top-level case label is reachable via CLI_ONLY', async () => {
    const { CLI_ONLY } = await import('../src/cli.ts');
    const members = new Set<string>(CLI_ONLY);

    const caseLabels = readdirSync(join(repoRoot, 'src', 'cli', 'commands'))
      .filter(f => f.endsWith('.ts'))
      .map(f => f.slice(0, -'.ts'.length));
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

// #5433: `gbrain list` (formatResult('list_pages', ...) at src/cli.ts) joined
// raw fields with \t and rows with \n. Titles are free text; a title with a
// newline turns one page into two output lines, a tab adds a column. Anything
// that pipes `gbrain list` into `cut`/`awk`/`while read` miscounts or
// misattributes pages. The fix escapes \n/\r/\t/\\ in every cell so the row
// boundary is always the single \n the caller asked for. --json output is
// untouched (the JSON path carries the raw characters).
describe("list_pages TSV escaping (#5433)", () => {
  async function render(pages: unknown[]): Promise<string> {
    const { formatResult } = await import('../src/cli.ts');
    return formatResult('list_pages', pages, {});
  }

  test('a title with a newline stays on one output line', async () => {
    const out = await render([
      { slug: 'notes/example-one', type: 'note', updated_at: '2026-01-05T10:00:00Z', title: 'first line\nsecond\tpart' },
    ]);
    // Exactly one row (plus the trailing newline) — the embedded \n /\t are
    // escaped as two-character sequences, not emitted as record separators.
    expect(out.split('\n').length).toBe(2);
    expect(out).toContain('first line\\nsecond\\tpart');
  });

  test('a title with a tab does not add a column', async () => {
    const out = await render([
      { slug: 'notes/example-one', type: 'note', updated_at: '2026-01-05T10:00:00Z', title: 'a\tb' },
    ]);
    // The escaped title sits in column 4; column counts stay at 4 per row.
    const rows = out.trim().split('\n');
    for (const r of rows) expect(r.split('\t').length).toBe(4);
  });

  test('a title with a literal backslash is escaped first so later escapes do not double-escape', async () => {
    const out = await render([
      { slug: 'notes/example-one', type: 'note', updated_at: '2026-01-05T10:00:00Z', title: 'a\\b\nc' },
    ]);
    // \\ escapes to \\\\, then \n escapes to \\n. Final: a\\\\b\\nc.
    expect(out).toContain('a\\\\b\\nc');
  });

  test('multiple rows with adversarial titles all stay on their own lines', async () => {
    const out = await render([
      { slug: 'a', type: 'note', updated_at: '2026-01-05T10:00:00Z', title: 'plain' },
      { slug: 'b', type: 'note', updated_at: '2026-01-05T10:00:00Z', title: 'has\nnewline' },
      { slug: 'c', type: 'note', updated_at: '2026-01-05T10:00:00Z', title: 'has\ttab' },
      { slug: 'd', type: 'note', updated_at: '2026-01-05T10:00:00Z', title: 'has\r\nwindows-end' },
    ]);
    const rows = out.trim().split('\n');
    expect(rows.length).toBe(4);
    // 4 columns per row.
    for (const r of rows) expect(r.split('\t').length).toBe(4);
  });

  test('empty list still prints the "No pages found." sentinel', async () => {
    const out = await render([]);
    expect(out).toBe('No pages found.\n');
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
  test('ask dispatches to the query op', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'ask', '--help'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain query');
    expect(exitCode).toBe(0);
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

  test('unknown command prints error and exits 2 (usage)', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'notacommand'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(stderr).toContain('Unknown command: notacommand');
    expect(exitCode).toBe(2);
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
      // #5800: the thin-client example must name the flags initRemoteMcp
      // actually reads (--issuer-url/--mcp-url/oauth), not `--url`, which it
      // ignores while requiring --issuer-url.
      expect(stdout).toContain('--mcp-only --issuer-url');
      expect(stdout).not.toContain('--mcp-only --url');
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

  test("--tools-json carries each op's access contract after the legacy keys (#5953)", async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-tools-json-'));
    try {
      const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--tools-json'], {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
        env: isolatedEnv(home),
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const tools = JSON.parse(stdout) as Array<Record<string, unknown>>;
      const byName = new Map(tools.map(t => [t.name as string, t]));

      expect(Object.keys(byName.get('get_page')!)).toEqual([
        'name', 'description', 'parameters', 'schema', 'scope', 'required_scopes', 'mutating', 'idempotent', 'local_only',
      ]);
      expect(byName.get('get_page')).toMatchObject({ scope: 'read', required_scopes: [], mutating: false, idempotent: true, local_only: false });
      expect(byName.get('put_page')).toMatchObject({ scope: 'write', mutating: true, local_only: false });
      expect(byName.get('think')).toMatchObject({ scope: 'read', mutating: true });
      expect(byName.get('join_brain')).toMatchObject({ scope: 'read', required_scopes: ['skills_member_self'] });
      expect(byName.get('sync_brain')).toMatchObject({ scope: 'admin', local_only: true });

      const { operations } = await import('../src/core/operations.ts');
      for (const op of operations) {
        const t = byName.get(op.name)!;
        expect([t.scope, t.required_scopes, t.mutating, t.idempotent, t.local_only], op.name).toEqual([
          op.scope ?? 'read', op.requiredScopes ?? [], op.mutating === true, op.idempotent === true, op.localOnly === true,
        ]);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
