/**
 * `gbrain upgrade`'s one-time "Enable skill publishing now? (recommended)
 * [Y/n]" prompt (#4318 residual). The inline readline confirm used to call
 * `rl.close()` before resolving while an unguarded close listener settled the
 * promise `false` first, so pressing Enter on this default-YES prompt always
 * declined. The prompt now reads through interaction.ts `readLine` (one
 * settle, EOF/timeout = decline) behind `promptEnableSkillPublishing`, so the
 * contract is pinned by executing it against a real stream.
 */
import { describe, test, expect } from 'bun:test';
import { PassThrough } from 'node:stream';
import { promptEnableSkillPublishing } from '../src/commands/upgrade.ts';

const TTY = { env: {}, stdinIsTTY: true, stdoutIsTTY: true };

async function answer(text: string | null, probe = TTY): Promise<{ enabled: boolean; prompt: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let prompt = '';
  output.on('data', (c) => { prompt += String(c); });
  const pending = promptEnableSkillPublishing({ input, output, probe, timeoutMs: 2_000 });
  if (text === null) input.end(); else input.write(text);
  return { enabled: await pending, prompt };
}

describe('gbrain upgrade — skill-publish prompt (#4318 residual)', () => {
  test('Enter alone accepts the [Y/n] default (the race used to decline it)', async () => {
    const r = await answer('\n');
    expect(r.enabled).toBe(true);
    expect(r.prompt).toContain('Enable skill publishing now? (recommended) [Y/n]');
  });

  test('y / yes accept; n and anything else decline', async () => {
    expect((await answer('y\n')).enabled).toBe(true);
    expect((await answer('YES\n')).enabled).toBe(true);
    expect((await answer('n\n')).enabled).toBe(false);
    expect((await answer('maybe\n')).enabled).toBe(false);
  });

  test('EOF declines instead of hanging', async () => {
    expect((await answer(null)).enabled).toBe(false);
  });

  test('a non-interactive caller (agent marker) declines without reading', async () => {
    const r = await answer('y\n', { env: { CLAUDECODE: '1' }, stdinIsTTY: true, stdoutIsTTY: true });
    expect(r.enabled).toBe(false);
    expect(r.prompt).toBe('');
  });
});
