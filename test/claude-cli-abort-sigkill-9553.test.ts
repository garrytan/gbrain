/**
 * #9553: an aborted claude-cli call must not leave a child that ignores
 * SIGTERM running (it keeps the process, and the cycle lock, alive).
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { ClaudeCliLanguageModel } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { withEnv } from './helpers/with-env.ts';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('claude-cli abort escalates to SIGKILL (#9553)', () => {
  test('a child ignoring SIGTERM is dead shortly after the call is aborted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-abort-9553-'));
    const pidFile = join(dir, 'pid');
    const bin = join(dir, 'claude');
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.316 (Claude Code)"; exit 0; fi',
      "trap '' TERM",
      `echo $$ > "${pidFile}"`,
      'cat > /dev/null',
      'while :; do sleep 1; done',
    ].join('\n') + '\n');
    chmodSync(bin, 0o755);
    let pid = 0;
    let stillAlive = true;
    try {
      await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin }, async () => {
        const ac = new AbortController();
        const opts = {
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          abortSignal: ac.signal,
        } as LanguageModelV2CallOptions;
        const call = new ClaudeCliLanguageModel('claude-sonnet-4-6').doGenerate(opts).then(() => 'ok', () => 'rejected');
        for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50);
        pid = Number(readFileSync(pidFile, 'utf8').trim());
        ac.abort();
        expect(await call).toBe('rejected');
        for (let i = 0; i < 80 && alive(pid); i++) await sleep(100);
        stillAlive = alive(pid);
      });
    } finally {
      if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
    expect(stillAlive).toBe(false);
  }, 20_000);
});
