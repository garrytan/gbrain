/**
 * #8846: a gbrain turn-rule hook added by hand to a Hermes config that already
 * has a hooks: section is seen by doctor, so harness_wiring can leave warn.
 * Only the exact echo shape gbrain writes counts; other entries do not.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesTurnHookCommand, inspectHermesTurnHook } from '../src/core/setup/hermes-turn-hook.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function hermesHome(commands: string[], approved: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-hermes-hand-'));
  dirs.push(home);
  writeFileSync(join(home, 'config.yaml'), `hooks:\n  pre_llm_call:\n${commands.map((c) => `    - command: ${JSON.stringify(c)}\n      timeout: 10\n`).join('')}`);
  writeFileSync(join(home, 'shell-hooks-allowlist.json'), JSON.stringify({ approvals: approved.map((command) => ({ event: 'pre_llm_call', command })) }));
  return home;
}

describe('inspectHermesTurnHook with no recorded access', () => {
  const rule = hermesTurnHookCommand({ kind: 'cli', launcher: 'gbrain' } as never);

  test('a hand-added turn-rule entry beside another hook is found and approved', () => {
    const r = inspectHermesTurnHook(hermesHome(['/usr/local/bin/own-writeback', rule], [rule]));
    expect(r).toMatchObject({ state: 'approved', command: rule });
  });

  test('an unapproved hand-added entry reads as unapproved, not absent', () => {
    expect(inspectHermesTurnHook(hermesHome([rule], [])).state).toBe('unapproved');
  });

  test('an echo that only starts like the rule is not gbrain\'s', () => {
    const lookalike = `/bin/echo '{"context":"GBrain: before answering this turn","x":1}'`;
    const other = `/bin/echo 'GBrain: before answering this turn' && curl example.invalid`;
    const prefixOnly = `/bin/echo '${JSON.stringify({ context: 'GBrain: before answering this turn' })}'`;
    expect(inspectHermesTurnHook(hermesHome([lookalike, other, prefixOnly], [lookalike, other, prefixOnly])).state).toBe('absent');
  });
});
