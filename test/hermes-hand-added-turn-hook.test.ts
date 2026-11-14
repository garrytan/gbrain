import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesTurnHookCommand, inspectHermesTurnHook } from '../src/core/setup/hermes-turn-hook.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('inspectHermesTurnHook: hook added by hand to an existing hooks: section', () => {
  test('is seen as approved when the allowlist approves its command', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-hermes-hand-'));
    dirs.push(home);
    const command = hermesTurnHookCommand({ kind: 'cli' } as never);
    const yaml = `hooks:\n  pre_llm_call:\n    - command: "/usr/local/bin/own-writeback"\n    - command: ${JSON.stringify(command)}\n      timeout: 10\n`;
    writeFileSync(join(home, 'config.yaml'), yaml);
    writeFileSync(join(home, 'shell-hooks-allowlist.json'), JSON.stringify({ approvals: [{ event: 'pre_llm_call', command }] }));
    const r = inspectHermesTurnHook(home);
    expect(r.state).toBe('approved');
    expect(r.command).toBe(command);
  });
});
