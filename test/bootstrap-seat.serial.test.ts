/**
 * #4618 `foresights bootstrap hooks --seat <label>` / `bootstrap harness --seat`:
 * the seat label is rendered as `GBRAIN_SEAT=<label>` into every foresights hook
 * command, survives a re-install that omits the flag, is cleared by
 * `--no-seat`, and an invalid label is refused with the fix spelled out.
 *
 * Authoring gate: protects the install-time seat contract (the only way an
 * operator names a seat for framework-spawned sessions). A regression that
 * drops the env assignment, loses the seat on `--repair`, or writes an
 * unvalidated label into a shell command fails here. No existing test renders
 * a seat; no production seam is added (the recording exec runner is the
 * dispatcher suite's).
 *
 * SERIAL: mutates GBRAIN_HOME.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBootstrap } from '../src/commands/bootstrap.ts';
import type { ExecRunner } from '../src/core/bootstrap/repo.ts';
import { parseHarnessArgs } from '../src/core/bootstrap/harness.ts';
import { writeClaudeHooksAt } from '../src/core/bootstrap/hooks.ts';
import { GBRAIN_HARNESS_MARKER_VALUE } from '../src/core/bootstrap/host-specs.ts';
import { confirm, initState, readBackHash, setAnswer } from '../src/core/bootstrap/interview.ts';

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const runner: ExecRunner = async (argv: string[]) =>
  argv[1] === 'mcp' && argv[2] === 'list' ? { code: 0, stdout: 'gbrain: stdio serve', stderr: '' } : { code: 0, stdout: '', stderr: '' };

async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; err: string }> {
  const [origLog, origErr] = [console.log, console.error];
  let err = '';
  console.log = () => {};
  console.error = (...args: unknown[]) => { err += args.map(String).join(' ') + '\n'; };
  try {
    return { result: await fn(), err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

async function withHome<T>(parent: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = parent;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = prev;
  }
}

function freshWorkspace(): { ws: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), 'gb-seat-home-'));
  mkdirSync(join(parent, '.gbrain'), { recursive: true });
  const ws = mkdtempSync(join(tmpdir(), 'gb-seat-ws-'));
  scratch.push(parent, ws);
  expect(initState(ws).ok).toBe(true);
  for (const [key, value] of Object.entries({
    AGENT_NAME: 'Dispatch', PRINCIPAL_NAME: 'Pat Example',
    AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
    AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
    PRINCIPAL_CONTEXT: 'Runs a small research group; values signal over noise.',
    VOICE_REGISTER: 'Direct: three options, the second one wins.', MCP_SCOPE: 'project',
  })) {
    const r = setAnswer(ws, key, value);
    if (!r.ok) throw new Error(r.message);
  }
  const h = readBackHash(ws);
  if (!h.ok) throw new Error(h.message);
  expect(confirm(ws, h.hash).ok).toBe(true);
  return { ws, parent };
}

/** Every foresights hook command in a settings file. */
function hookCommands(settingsPath: string): string[] {
  const hooks = JSON.parse(readFileSync(settingsPath, 'utf8')).hooks as Record<string, Array<{ hooks: Array<{ command: string; _gbrain?: string }> }>>;
  return Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.filter((h) => h._gbrain).map((h) => h.command)));
}

describe('bootstrap --seat (#4618)', () => {
  test('10. hooks --seat renders GBRAIN_SEAT into every hook command and survives a re-install; --no-seat clears it', async () => {
    const { ws, parent } = freshWorkspace();
    const settings = join(ws, '.claude', 'settings.local.json');
    const hooks = (...extra: string[]) =>
      capture(() => runBootstrap(['hooks', '--workspace', ws, '--harness', 'claude-code', '--gbrain-bin', process.execPath, ...extra], { runner }));
    await withHome(parent, async () => {
      expect((await capture(() => runBootstrap(['render', '--workspace', ws]))).result).toBe(0);
      expect((await hooks('--seat', 'Alice-Desk')).result).toBe(0);
      const installed = hookCommands(settings);
      expect(installed.length).toBeGreaterThan(0);
      for (const c of installed) expect(c).toContain(' GBRAIN_SEAT=alice-desk ');

      expect((await hooks('--repair')).result).toBe(0);
      expect(hookCommands(settings)).toEqual(installed);

      const refused = await hooks('--seat', 'Not A Seat');
      expect(refused.result).toBe(2);
      expect(refused.err).toContain("invalid --seat 'Not A Seat'");
      expect(refused.err).toContain('--seat alice-desk');
      expect(hookCommands(settings)).toEqual(installed);

      expect((await hooks('--no-seat')).result).toBe(0);
      for (const c of hookCommands(settings)) expect(c).not.toContain('GBRAIN_SEAT');
    });
  }, 60_000);

  test('harness lane: --seat parses into the flags and the harness-marker hooks keep it across a re-install', () => {
    expect(parseHarnessArgs(['--seat', 'Bob-Desk']).seat).toBe('bob-desk');
    expect(parseHarnessArgs(['--no-seat']).seat).toBe('');
    expect(parseHarnessArgs([]).seat).toBeUndefined();
    expect(parseHarnessArgs(['--seat', '-bad']).error).toContain("invalid --seat '-bad'");

    const dir = mkdtempSync(join(tmpdir(), 'gb-seat-harness-'));
    scratch.push(dir);
    const settings = join(dir, 'settings.json');
    const write = (env: { GBRAIN_SEAT?: string }) => writeClaudeHooksAt(settings, {
      gbrainBin: process.execPath, env: { GBRAIN_HOOK_LANE: 'harness', ...env }, marker: GBRAIN_HARNESS_MARKER_VALUE,
    });
    write({ GBRAIN_SEAT: 'bob-desk' });
    const installed = hookCommands(settings);
    for (const c of installed) expect(c).toContain('GBRAIN_HOOK_LANE=harness GBRAIN_SEAT=bob-desk ');
    write({});
    expect(hookCommands(settings)).toEqual(installed);
  });
});
