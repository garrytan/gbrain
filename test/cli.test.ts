import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

// Read cli.ts source for structural checks
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');

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
      cwd: new URL('..', import.meta.url).pathname,
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
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain upgrade');
    expect(exitCode).toBe(0);
  });

  test('--help prints global help', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
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
      cwd: new URL('..', import.meta.url).pathname,
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

describe('strict flag parsing (v0.18.3+)', () => {
  test('unknown --flag on a command prints error + recognized flags, exits 1', async () => {
    // Prior to v0.18.3 the parser silently absorbed --file into a ghost key;
    // now it rejects any flag not declared on the op. `put --bogus-flag foo`
    // is mutating, but dispatch fails at parse time before any DB connect.
    const proc = Bun.spawn(
      ['bun', 'run', 'src/cli.ts', 'put', 'concepts/x', '--bogus-flag', 'foo'],
      {
        cwd: new URL('..', import.meta.url).pathname,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
    expect(stderr).toContain('unknown flag --bogus-flag');
    expect(stderr).toContain('Recognized flags:');
    // put_page now lists --content and --file (plus slug, which isn't a --flag).
    expect(stderr).toContain('--content');
    expect(stderr).toContain('--file');
  });

  test('unknown --flag typo caught (regression guard for --cotent etc.)', async () => {
    // Typo-class silent-absorb bug: before v0.18.3, `--cotent foo` sent foo
    // into a ghost key and stdin-fallback filled content with an empty read.
    const proc = Bun.spawn(
      ['bun', 'run', 'src/cli.ts', 'put', 'concepts/x', '--cotent', 'hi'],
      {
        cwd: new URL('..', import.meta.url).pathname,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
    expect(stderr).toContain('unknown flag --cotent');
  });

  test('help hint shows --file / --content, not `[< file.md]`', () => {
    // The top-level `gbrain --help` used to say `put <slug> [< file.md]`,
    // which read flag-shaped and misled agents into guessing --file.
    expect(cliSource).not.toMatch(/put <slug> \[< file\.md\]/);
    expect(cliSource).toContain('--file PATH');
  });
});
