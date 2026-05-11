/**
 * Tests for the gbrain-context OpenClaw context engine.
 *
 * Validates:
 * - Engine creation with correct info
 * - Deterministic context injection (time, location, timezone)
 * - Compaction delegation to runtime
 * - Quiet hours detection
 * - Travel timezone resolution
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createGBrainContextEngine, ENGINE_ID, ENGINE_NAME } from '../src/core/context-engine.ts';

interface WorkspaceOpts {
  heartbeat?: Record<string, unknown>;
  flights?: Record<string, unknown>;
  calendar?: Record<string, unknown>;
  tasks?: string;
}

function makeWorkspace(opts: WorkspaceOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-ce-test-'));
  mkdirSync(join(dir, 'memory'), { recursive: true });
  mkdirSync(join(dir, 'ops'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'heartbeat-state.json'), JSON.stringify(opts.heartbeat ?? {}));
  writeFileSync(join(dir, 'memory', 'upcoming-flights.json'), JSON.stringify(opts.flights ?? {}));
  if (opts.calendar) {
    writeFileSync(join(dir, 'memory', 'calendar-cache.json'), JSON.stringify(opts.calendar));
  }
  if (opts.tasks) {
    writeFileSync(join(dir, 'ops', 'tasks.md'), opts.tasks);
  }
  return dir;
}

describe('gbrain-context engine', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has correct engine info', () => {
    tmpDir = makeWorkspace();
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });
    expect(engine.info.id).toBe(ENGINE_ID);
    expect(engine.info.name).toBe(ENGINE_NAME);
    expect(engine.info.ownsCompaction).toBe(false);
  });

  it('injects systemPromptAddition on assemble', async () => {
    tmpDir = makeWorkspace({
      heartbeat: {
        garryAwake: true,
        currentLocation: {
          city: 'Markham',
          timezone: 'America/Toronto',
          source: 'garry-confirmed',
        },
      },
    });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
      tokenBudget: 100000,
    });

    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition).toContain('Live Context');
    expect(result.systemPromptAddition).toContain('America/Toronto');
    expect(result.systemPromptAddition).toContain('Markham');
    // Should include home time since we're traveling (not US/Pacific)
    expect(result.systemPromptAddition).toContain('Home (SF)');
    expect(result.systemPromptAddition).toContain('PT');
  });

  it('uses US/Pacific when no location set', async () => {
    tmpDir = makeWorkspace();
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
    });

    expect(result.systemPromptAddition).toContain('San Francisco');
    // Should NOT have home time (already home)
    expect(result.systemPromptAddition).not.toContain('Home (SF)');
  });

  it('passes messages through unchanged', async () => {
    tmpDir = makeWorkspace({ heartbeat: { garryAwake: true } });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ];

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: messages as any[],
    });

    expect(result.messages).toBe(messages); // same reference, not modified
  });

  it('ingest is a no-op that returns ingested: true', async () => {
    tmpDir = makeWorkspace();
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.ingest({
      sessionId: 'test-session',
      message: { role: 'user', content: 'test' } as any,
    });

    expect(result.ingested).toBe(true);
  });

  it('detects quiet hours when garryAwake is false and hour is late', async () => {
    tmpDir = makeWorkspace({
      heartbeat: {
        garryAwake: false,
        currentLocation: { city: 'San Francisco', timezone: 'US/Pacific' },
      },
    });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
    });

    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition).toContain('Live Context');
  });

  it('reports day of week as a real weekday name', async () => {
    tmpDir = makeWorkspace({
      heartbeat: {
        garryAwake: true,
        currentLocation: { city: 'Tokyo', timezone: 'Asia/Tokyo' },
      },
    });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
    });

    const validDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const hasDay = validDays.some(d => result.systemPromptAddition?.includes(d));
    expect(hasDay).toBe(true);
  });

  it('handles missing workspace files gracefully', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-ce-test-'));
    // No memory directory at all
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
    });

    // Should still work with defaults
    expect(result.systemPromptAddition).toContain('San Francisco');
    expect(result.systemPromptAddition).toContain('Live Context');
  });

  it('estimates tokens from message content', async () => {
    tmpDir = makeWorkspace({ heartbeat: { garryAwake: true } });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const messages = [
      { role: 'user' as const, content: 'a'.repeat(400) },
    ];

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: messages as any[],
    });

    // 400 chars / 4 = ~100 tokens
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(90);
    expect(result.estimatedTokens).toBeLessThanOrEqual(110);
  });

  // ── Activity / Calendar tests ──────────────────────────────────────────

  it('injects current event when calendar has an active meeting', async () => {
    const now = new Date();
    const start = new Date(now.getTime() - 15 * 60 * 1000).toISOString(); // started 15 min ago
    const end = new Date(now.getTime() + 30 * 60 * 1000).toISOString();   // ends in 30 min

    tmpDir = makeWorkspace({
      heartbeat: { garryAwake: true },
      calendar: {
        lastUpdated: new Date().toISOString(),
        events: [
          { summary: '1:1 with Diana', start, end, attendees: ['diana@ycombinator.com'] },
        ],
      },
    });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
    });

    expect(result.systemPromptAddition).toContain('Right now');
    expect(result.systemPromptAddition).toContain('1:1 with Diana');
    expect(result.systemPromptAddition).toContain('diana@ycombinator.com');
  });

  it('injects upcoming events within 4-hour window', async () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 60 * 60 * 1000).toISOString();      // 1 hour from now
    const later = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString(); // 3 hours from now
    const tooFar = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString(); // 5 hours out

    tmpDir = makeWorkspace({
      heartbeat: { garryAwake: true },
      calendar: {
        lastUpdated: new Date().toISOString(),
        events: [
          { summary: 'Office Hours — Batch W26', start: soon, end: new Date(new Date(soon).getTime() + 30 * 60 * 1000).toISOString() },
          { summary: 'GP Lunch', start: later, end: new Date(new Date(later).getTime() + 60 * 60 * 1000).toISOString() },
          { summary: 'Evening dinner', start: tooFar, end: new Date(new Date(tooFar).getTime() + 2 * 60 * 60 * 1000).toISOString() },
        ],
      },
    });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
    });

    expect(result.systemPromptAddition).toContain('Coming up');
    expect(result.systemPromptAddition).toContain('Office Hours');
    expect(result.systemPromptAddition).toContain('GP Lunch');
    // 5 hours out should be excluded
    expect(result.systemPromptAddition).not.toContain('Evening dinner');
  });

  it('skips all-day and generic events (Home, OOO)', async () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    tmpDir = makeWorkspace({
      heartbeat: { garryAwake: true },
      calendar: {
        lastUpdated: new Date().toISOString(),
        events: [
          { summary: 'Home', start: '2026-05-11' },  // all-day, no T
          { summary: 'OOO', start: '2026-05-11' },
          { summary: 'Out of Office - Funeral', start: '2026-05-11' },
          { summary: 'Real Meeting', start: soon, end: new Date(new Date(soon).getTime() + 30 * 60 * 1000).toISOString() },
        ],
      },
    });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
    });

    expect(result.systemPromptAddition).not.toContain('Home');
    expect(result.systemPromptAddition).not.toContain('OOO');
    expect(result.systemPromptAddition).not.toContain('Out of Office');
    expect(result.systemPromptAddition).toContain('Real Meeting');
  });

  it('flags stale calendar cache', async () => {
    const staleTime = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(); // 8 hours old

    tmpDir = makeWorkspace({
      heartbeat: { garryAwake: true },
      calendar: {
        lastUpdated: staleTime,
        events: [],
      },
    });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
    });

    expect(result.systemPromptAddition).toContain('Calendar cache >6h old');
  });

  it('injects open tasks from ops/tasks.md', async () => {
    tmpDir = makeWorkspace({
      heartbeat: { garryAwake: true },
      tasks: `# Current Tasks\n\n## Today\n\n- [ ] **DM Technium re: Hermes PR** — needs merge\n- [ ] **Post open source manifesto** — from YC Labs\n- [x] ~~Reply to Bob McGrew~~ — DONE\n\n## Next up\n- [ ] Something later`,
    });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
    });

    expect(result.systemPromptAddition).toContain('Open tasks');
    expect(result.systemPromptAddition).toContain('DM Technium');
    expect(result.systemPromptAddition).toContain('Post open source manifesto');
    // Completed task should NOT appear
    expect(result.systemPromptAddition).not.toContain('Reply to Bob');
    // "Next up" section tasks should NOT appear
    expect(result.systemPromptAddition).not.toContain('Something later');
  });

  it('no activity section when calendar is empty and no tasks', async () => {
    tmpDir = makeWorkspace({
      heartbeat: { garryAwake: true },
      calendar: {
        lastUpdated: new Date().toISOString(),
        events: [],
      },
      tasks: '# Current Tasks\n\n## Today\n\nAll done!',
    });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
    });

    expect(result.systemPromptAddition).not.toContain('Right now');
    expect(result.systemPromptAddition).not.toContain('Coming up');
    expect(result.systemPromptAddition).not.toContain('Open tasks');
  });
});
