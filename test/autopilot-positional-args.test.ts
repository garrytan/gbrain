/**
 * #1525 — `gbrain autopilot status` must not START the daemon.
 *
 * Positional args were never validated: runAutopilot branched only on
 * --help/--install/--uninstall/--status flags, so the natural spellings
 * (`autopilot status`, `autopilot install`) — and any typo — fell through to
 * the daemon-start path. A status CHECK silently became a daemon LAUNCH.
 *
 * resolveAutopilotPositionals maps the subcommand spellings onto their
 * canonical flags, drops the redundant `start` (daemon start is the default
 * action), and refuses anything unrecognized with exit 2 — resolved in
 * cli.ts BEFORE connectEngine, so the refusal needs no brain and the
 * engine-free --status/--uninstall short-circuit sees the resolved flags.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAutopilotPositionals } from '../src/commands/autopilot.ts';

describe('resolveAutopilotPositionals (#1525)', () => {
  test('maps subcommand spellings onto their canonical flags', () => {
    expect(resolveAutopilotPositionals(['status'])).toEqual(['--status']);
    expect(resolveAutopilotPositionals(['status', '--json'])).toEqual(['--status', '--json']);
    expect(resolveAutopilotPositionals(['install', '--repo', '/x'])).toEqual(['--install', '--repo', '/x']);
    expect(resolveAutopilotPositionals(['uninstall'])).toEqual(['--uninstall']);
    expect(resolveAutopilotPositionals(['help'])).toEqual(['--help']);
  });

  test('`start` is dropped — daemon start is already the default action', () => {
    expect(resolveAutopilotPositionals(['start'])).toEqual([]);
    expect(resolveAutopilotPositionals(['start', '--interval', '60'])).toEqual(['--interval', '60']);
  });

  test('flag-only argv passes through unchanged', () => {
    expect(resolveAutopilotPositionals([])).toEqual([]);
    expect(resolveAutopilotPositionals(['--status', '--json'])).toEqual(['--status', '--json']);
    expect(resolveAutopilotPositionals(['--repo', '/some/path', '--interval', '600'])).toEqual([
      '--repo', '/some/path', '--interval', '600',
    ]);
  });

  test('a value-flag argument is a VALUE, never an aliased subcommand', () => {
    // `--repo status` names a directory called "status"; `--target uninstall`
    // is (bad) input to --target — neither may be rewritten or refused.
    expect(resolveAutopilotPositionals(['--repo', 'status'])).toEqual(['--repo', 'status']);
    expect(resolveAutopilotPositionals(['--target', 'uninstall'])).toEqual(['--target', 'uninstall']);
    expect(resolveAutopilotPositionals(['--interval', 'start'])).toEqual(['--interval', 'start']);
  });

  test('prototype-chain words are unknown positionals, not aliases', () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    try {
      // The thrown message pins the exit code: EXIT:2, not a daemon start.
      expect(() => resolveAutopilotPositionals(['constructor'])).toThrow('EXIT:2');
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test('an unknown positional refuses with a hint and exit 2', () => {
    const errs: string[] = [];
    const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    try {
      expect(() => resolveAutopilotPositionals(['bogus'])).toThrow('EXIT:2');
      const all = errs.join('\n');
      expect(all).toContain("Unknown autopilot argument 'bogus'");
      expect(all).toContain('status');
      expect(all).toContain('uninstall');
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

const REPO = new URL('..', import.meta.url).pathname;

async function runCli(cliArgs: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-pos-'));
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', 'autopilot', ...cliArgs], {
    cwd: REPO,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe('autopilot positional dispatch through the real CLI (#1525)', () => {
  test('an unknown positional exits 2 before any engine work', async () => {
    const { code, stderr } = await runCli(['bogus']);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown autopilot argument 'bogus'");
    // Pre-engine: the refusal must not be the engine-connect failure.
    expect(stderr).not.toContain('No brain configured');
  }, 90_000);

  test('`autopilot status` behaves exactly like `autopilot --status`', async () => {
    const flag = await runCli(['--status']);
    const word = await runCli(['status']);
    expect(word.code).toBe(flag.code);
    // Same engine-free status report, not a daemon launch.
    expect(word.stdout + word.stderr).not.toContain('Autopilot starting');
  }, 90_000);
});
