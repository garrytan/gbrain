/**
 * #9998: the Live Context block rides in the system prompt ahead of the whole conversation, and its clock carried
 * seconds, so every new user message changed the prompt there and the host (OpenClaw) wrote most of it to its prompt
 * cache again: on average 169k of a 220k-token prompt. The clock now shows the local hour, so two turns minutes
 * apart in the same hour produce a byte-identical block, and the next hour still changes it.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGBrainContextEngine } from '../src/core/context-engine.ts';

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-clock-9998-'));
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'heartbeat-state.json'), JSON.stringify({
    userAwake: true,
    currentLocation: { city: 'Toronto', timezone: 'America/Toronto', source: 'user-confirmed' },
    homeLocation: { city: 'San Francisco', timezone: 'America/Los_Angeles' },
  }));
  return dir;
}

async function liveContextAt(dir: string, iso: string): Promise<string> {
  setSystemTime(new Date(iso));
  const result = await createGBrainContextEngine({ workspaceDir: dir }).assemble({ sessionId: 'clock-9998', messages: [], tokenBudget: 100_000 });
  const block = (result.systemPromptAddition ?? '').split('\n\n')[0]!;
  expect(block).toContain('## Live Context');
  return block;
}

describe('Live Context clock (#9998)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    setSystemTime();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('two turns minutes apart in the same hour emit a byte-identical block', async () => {
    const dir = workspace();
    dirs.push(dir);
    const first = await liveContextAt(dir, '2026-11-21T20:53:31Z');
    const second = await liveContextAt(dir, '2026-11-21T20:58:38Z');
    expect(second).toBe(first);
    expect(first).toContain('- **Time:** 2026-11-21, between 15:00 and 15:59 UTC-05:00 (America/Toronto)');
    expect(first).toContain('- **Home (San Francisco):** Sat, 12 PM PST');
  });

  test('the next hour changes the block', async () => {
    const dir = workspace();
    dirs.push(dir);
    const before = await liveContextAt(dir, '2026-11-21T20:59:59Z');
    const after = await liveContextAt(dir, '2026-11-21T21:00:01Z');
    expect(after).not.toBe(before);
    expect(after).toContain('between 16:00 and 16:59');
  });
});
