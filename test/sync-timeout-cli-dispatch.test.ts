import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveReadOnlyDispatchTimeoutMs } from '../src/cli.ts';
import { parseGlobalFlags } from '../src/core/cli-options.ts';

// #3013 — `gbrain sync --timeout <s>` was unreachable: the global option
// parser claimed --timeout before dispatch, and the read-only timeout path
// gated on "a timeout is present" rather than "the command is read-only".
// Any command carrying a user --timeout was rerouted into
// dispatchReadOnlyCommand, which throws on everything but search/sources.

describe('read-only dispatch gate is per-command (#3013)', () => {
  test('sync with a user --timeout never enters the read-only path', () => {
    expect(resolveReadOnlyDispatchTimeoutMs('sync', ['--source', 'x'], 60_000)).toBe(null);
  });

  test('other write commands with a user --timeout never enter the read-only path', () => {
    for (const command of ['embed', 'import', 'doctor', 'extract']) {
      expect(resolveReadOnlyDispatchTimeoutMs(command, [], 5_000)).toBe(null);
    }
  });

  test('search keeps its 30s default and user override', () => {
    expect(resolveReadOnlyDispatchTimeoutMs('search', ['hello'], null)).toBe(30_000);
    expect(resolveReadOnlyDispatchTimeoutMs('search', ['hello'], 5_000)).toBe(5_000);
  });

  test('sources list keeps its 10s default; other subcommands only bound on user --timeout', () => {
    expect(resolveReadOnlyDispatchTimeoutMs('sources', ['list'], null)).toBe(10_000);
    expect(resolveReadOnlyDispatchTimeoutMs('sources', [], null)).toBe(10_000);
    expect(resolveReadOnlyDispatchTimeoutMs('sources', ['add', 'x'], null)).toBe(null);
    expect(resolveReadOnlyDispatchTimeoutMs('sources', ['add', 'x'], 5_000)).toBe(5_000);
  });
});

describe('CLI integration: sync --timeout reaches the sync handler (#3013)', () => {
  const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

  // No configured brain needed: the sync hard-deadline watchdog arms from
  // argv BEFORE connectEngine, so its stderr banner proves (a) dispatch fell
  // through to the sync branch instead of dispatchReadOnlyCommand, (b) the
  // handed-back --timeout was parsed with sync's SECONDS semantics (60s, not
  // the 60ms the global parser used to produce for a bare "60").
  const run = (args: string[]) =>
    spawnSync('bun', [CLI, ...args], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-3013-')),
      },
    });

  test('space form: `sync --source x --dry-run --timeout 60`', () => {
    const res = run(['sync', '--source', 'x', '--dry-run', '--timeout', '60']);
    const all = `${res.stdout}\n${res.stderr}`;
    expect(all).not.toContain('dispatchReadOnlyCommand');
    expect(all).not.toContain('connect timed out');
    expect(res.stderr).toContain('hard deadline armed: 60s');
    expect(res.stderr).toContain('(flag:--timeout)');
  });

  test('equals form: `sync --source x --dry-run --timeout=60s`', () => {
    const res = run(['sync', '--source', 'x', '--dry-run', '--timeout=60s']);
    const all = `${res.stdout}\n${res.stderr}`;
    expect(all).not.toContain('dispatchReadOnlyCommand');
    expect(all).not.toContain('connect timed out');
    expect(res.stderr).toContain('hard deadline armed: 60s');
    expect(res.stderr).toContain('(flag:--timeout)');
  });
});

describe('parseGlobalFlags hands --timeout back to owning commands (#3013)', () => {
  test('sync, space form: flag returned to rest, global timeoutMs stays null', () => {
    const r = parseGlobalFlags(['sync', '--source', 'x', '--dry-run', '--timeout', '60']);
    expect(r.cliOpts.timeoutMs).toBe(null);
    expect(r.rest).toEqual(['sync', '--source', 'x', '--dry-run', '--timeout', '60']);
  });

  test('sync, equals form: normalized to the space form sync parses', () => {
    const r = parseGlobalFlags(['sync', '--source', 'x', '--timeout=60s']);
    expect(r.cliOpts.timeoutMs).toBe(null);
    expect(r.rest).toEqual(['sync', '--source', 'x', '--timeout', '60s']);
  });

  test('flag before the command still hands back (appended after the args)', () => {
    const r = parseGlobalFlags(['--timeout', '60', 'sync', '--source', 'x']);
    expect(r.cliOpts.timeoutMs).toBe(null);
    expect(r.rest).toEqual(['sync', '--source', 'x', '--timeout', '60']);
  });

  // codex review round-2 W3: handback must not shadow positional
  // subcommands — both owning commands read args[0] as a subcommand
  // (`remote ping`, `sync trigger`) and find --timeout by scanning, so the
  // handed-back flag always lands after every other token.
  test('handback never lands in front of a positional subcommand', () => {
    const r1 = parseGlobalFlags(['remote', '--timeout', '5m', 'ping']);
    expect(r1.rest).toEqual(['remote', 'ping', '--timeout', '5m']);
    const r2 = parseGlobalFlags(['--timeout=5m', 'remote', 'ping']);
    expect(r2.rest).toEqual(['remote', 'ping', '--timeout', '5m']);
    const r3 = parseGlobalFlags(['--timeout', '60', 'sync', 'trigger']);
    expect(r3.rest).toEqual(['sync', 'trigger', '--timeout', '60']);
  });

  test('remote owns --timeout too (ms-based budget in commands/remote.ts)', () => {
    const r = parseGlobalFlags(['remote', 'doctor', '--timeout=5m']);
    expect(r.cliOpts.timeoutMs).toBe(null);
    expect(r.rest).toEqual(['remote', 'doctor', '--timeout', '5m']);
  });

  test('non-owning commands keep the global claim (thin-client / read-only budgets)', () => {
    const r = parseGlobalFlags(['search', '--timeout=30s', 'X']);
    expect(r.cliOpts.timeoutMs).toBe(30_000);
    expect(r.rest).toEqual(['search', 'X']);
  });

  // codex review W1: values outside the GLOBAL grammar (no `h` unit) must
  // still be handed back — the owning command's grammar decides validity.
  test('values the global grammar rejects still hand back (--timeout=2h)', () => {
    const r = parseGlobalFlags(['sync', '--source', 'x', '--timeout=2h']);
    expect(r.cliOpts.timeoutMs).toBe(null);
    expect(r.rest).toEqual(['sync', '--source', 'x', '--timeout', '2h']);
  });

  // codex review W2: duplicate flags keep their relative argv order, so the
  // owning command's first-occurrence-wins precedence matches what the
  // user typed.
  test('duplicate --timeout flags keep argv order', () => {
    const r = parseGlobalFlags(['sync', '--timeout', '60', '--timeout', '2h', '--source', 'x']);
    expect(r.cliOpts.timeoutMs).toBe(null);
    expect(r.rest).toEqual(['sync', '--source', 'x', '--timeout', '60', '--timeout', '2h']);
  });

  test('a flag token after bare --timeout is not consumed as its value', () => {
    const r = parseGlobalFlags(['sync', '--timeout', '--source', 'x']);
    expect(r.cliOpts.timeoutMs).toBe(null);
    expect(r.rest).toEqual(['sync', '--timeout', '--source', 'x']);
  });
});
