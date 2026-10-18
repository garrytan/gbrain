/**
 * Cold start: src/cli.ts answers `--version` and top-level help without
 * loading the dispatcher, and the dispatcher keeps three heavy graphs off
 * every command (the ~220 schema migrations, the version-upgrade orchestrator
 * registry and the MCP HTTP client SDK).
 *
 * Fails when a static import drags src/cli/main.ts (and with it every
 * operation and command module) back into the entry point's graph, when the
 * fast path stops matching the dispatcher's own branches, or when one of the
 * lazy graphs becomes a static import of the dispatcher again.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { cliFastPath } from '../src/cli.ts';
import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');

/** Every module a fresh Bun process holds after importing `file` (import.meta.main stays false). */
function loadedModules(file: string): string[] {
  const script = `await import(${JSON.stringify(join(REPO, file))}); console.log(JSON.stringify(Object.keys(require.cache)));`;
  const r = spawnSync(process.execPath, ['--no-env-file', '-e', script], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as string[];
}

describe('cliFastPath mirrors main()\'s first branches', () => {
  test('version and help forms take the fast path, global flags included', () => {
    expect(cliFastPath(['--version'])).toBe('version');
    expect(cliFastPath(['version'])).toBe('version');
    expect(cliFastPath(['--quiet', '--version'])).toBe('version');
    expect(cliFastPath([])).toBe('help');
    expect(cliFastPath(['--help'])).toBe('help');
    expect(cliFastPath(['-h'])).toBe('help');
    expect(cliFastPath(['--quiet'])).toBe('help');
  });

  test('commands, per-command help and global-flag errors go to the dispatcher', () => {
    expect(cliFastPath(['get', 'some/page'])).toBeNull();
    expect(cliFastPath(['get', '--help'])).toBeNull();
    expect(cliFastPath(['--tools-json'])).toBeNull();
    expect(cliFastPath(['--brain'])).toBeNull();
  });
});

describe('import graphs', () => {
  test('the entry point does not load the dispatcher or the operation table', () => {
    const mods = loadedModules('src/cli.ts');
    expect(mods.some((m) => m.endsWith('/src/cli/main.ts'))).toBe(false);
    expect(mods.some((m) => m.endsWith('/src/core/operations.ts'))).toBe(false);
    expect(mods.length).toBeLessThan(150);
  });

  test('the dispatcher does not statically load migrations, the upgrade registry or the MCP HTTP client', () => {
    const mods = loadedModules('src/cli/main.ts');
    expect(mods.filter((m) => /\/src\/core\/schema-migrations\/v\d+-/.test(m))).toEqual([]);
    expect(mods.some((m) => m.endsWith('/src/core/migrate.ts'))).toBe(false);
    expect(mods.some((m) => m.endsWith('/src/commands/migrations/index.ts'))).toBe(false);
    expect(mods.filter((m) => m.includes('/@modelcontextprotocol/sdk/dist/esm/client/'))).toEqual([]);
  });
});

describe('fast-path output', () => {
  test('--version and help print what the dispatcher printed, exit 0', () => {
    const version = spawnSync(process.execPath, ['--no-env-file', join(REPO, 'src/cli.ts'), '--version'], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
    expect(version.status).toBe(0);
    expect(version.stdout).toBe(`gbrain ${VERSION}\n`);
    const help = spawnSync(process.execPath, ['--no-env-file', join(REPO, 'src/cli.ts'), '--help'], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
    expect(help.status).toBe(0);
    expect(help.stdout.startsWith(`gbrain ${VERSION} -- personal knowledge brain\n`)).toBe(true);
    expect(help.stdout).toContain('Run gbrain <command> --help for command-specific help.');
  });
});
