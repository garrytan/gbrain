import { describe, it, expect, setSystemTime } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createGBrainContextEngine } from '../src/core/context-engine.ts';

describe('live context clock cache stability', () => {
  it('emits an identical Live Context block for turns minutes apart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ce-clock-'));
    mkdirSync(join(dir, 'memory'), { recursive: true });
    mkdirSync(join(dir, 'ops'), { recursive: true });
    writeFileSync(join(dir, 'memory', 'heartbeat-state.json'), JSON.stringify({
      userAwake: true,
      currentLocation: { city: 'Toronto', timezone: 'America/Toronto', source: 'user-confirmed' },
      homeLocation: { city: 'San Francisco', timezone: 'America/Los_Angeles' },
    }));
    writeFileSync(join(dir, 'memory', 'upcoming-flights.json'), '{}');
    const outs: string[] = [];
    try {
      const engine = createGBrainContextEngine({ workspaceDir: dir });
      for (const t of ['2026-11-21T20:53:31Z', '2026-11-21T20:58:38Z']) {
        setSystemTime(new Date(t));
        const r = await engine.assemble({ sessionId: 's', messages: [], tokenBudget: 100000 });
        outs.push(r.systemPromptAddition ?? '');
      }
    } finally {
      setSystemTime();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(outs[0]).toContain('Live Context');
    expect(outs[1]).toBe(outs[0]);
  });
});
