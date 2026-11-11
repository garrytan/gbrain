import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { runHook } from '../src/commands/hook.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

async function run(prompt: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-turn-rule-9163-'));
  roots.push(root);
  mkdirSync(join(root, '.gbrain'), { recursive: true });
  writeFileSync(join(root, '.gbrain', 'agent-instructions.json'), JSON.stringify({ version: 1, entries: [{
    path: join(root, 'file.md'), block_version: 2, access: { kind: 'mcp', server: 'gbrain' }, writer: 'test', created_file: false,
    updated_at: new Date(Date.UTC(2026, 9, 25)).toISOString(), harness: 'claude-code', status: 'installed',
  }] }));
  let out = '';
  await withEnv({ GBRAIN_HOME: root, GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_HOOKS: undefined }, async () => {
    await runHook(['user-prompt'], {
      stdin: JSON.stringify({ prompt, session_id: 's1' }),
      write: (s) => { out += s; }, cwd: root, configOverride: null, disablePushBanner: true, disableTelemetry: true,
    });
  });
  return out;
}

describe('brain-first nudge on turns no person typed (#9163)', () => {
  test('typed turn keeps the nudge', async () => {
    expect(await run('what did alice-example decide?')).toContain('check GBrain first');
  });
  test('task-notification and teammate-message turns skip it', async () => {
    expect(await run('<task-notification>\n<task-id>t1</task-id> done</task-notification>')).toBe('');
    expect(await run('<teammate-message from="lead">rebase now</teammate-message>')).toBe('');
  });
});
