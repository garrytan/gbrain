/**
 * Protects the stdin prompt contract for task notifications and teammate
 * messages. Without the guard, these payloads enter the user-turn context
 * path; existing hook coverage does not classify these stdin-only tags.
 * The in-process hook and heartbeat need no production-only test seam.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook, readHeartbeatTail } from '../src/commands/hook.ts';
import { withEnv } from './helpers/with-env.ts';

describe('user-prompt harness notifications (#8028)', () => {
  test('skips turn context for task and teammate messages but keeps human prompts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-hook-prompt-'));

    try {
      await withEnv({
        GBRAIN_HOME: root,
        GBRAIN_SOURCE: undefined,
        GBRAIN_HOOKS: undefined,
        GBRAIN_HOOK_LANE: undefined,
      }, async () => {
        for (const prompt of [
          '  <task-notification><summary>background result</summary></task-notification>',
          '\n\t<teammate-message>agent update</teammate-message>',
        ]) {
          let output = '';
          expect(await runHook(['user-prompt'], {
            stdin: JSON.stringify({ prompt }),
            write: (chunk) => { output += chunk; },
            turnRule: null,
            disablePushBanner: true,
          })).toBe(0);
          expect(output).toBe('');
          expect(await readHeartbeatTail(1)).toMatchObject([
            { event: 'user-prompt', outcome: 'ok', reason: 'harness_prompt' },
          ]);
        }

        let output = '';
        expect(await runHook(['user-prompt'], {
          stdin: JSON.stringify({ prompt: 'What do we know about the project?' }),
          write: (chunk) => { output += chunk; },
          turnRule: null,
          disablePushBanner: true,
        })).toBe(0);
        expect((await readHeartbeatTail(1))[0]).toMatchObject({
          event: 'user-prompt', outcome: 'degraded', reason: 'no_pglite_path',
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
