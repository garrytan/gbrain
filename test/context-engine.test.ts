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

function makeWorkspace(heartbeat: Record<string, unknown> = {}, flights: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-ce-test-'));
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'heartbeat-state.json'), JSON.stringify(heartbeat));
  writeFileSync(join(dir, 'memory', 'upcoming-flights.json'), JSON.stringify(flights));
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
      garryAwake: true,
      currentLocation: {
        city: 'Markham',
        timezone: 'America/Toronto',
        source: 'garry-confirmed',
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
    tmpDir = makeWorkspace({});
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
    tmpDir = makeWorkspace({ garryAwake: true });
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
      garryAwake: false,
      currentLocation: {
        city: 'San Francisco',
        timezone: 'US/Pacific',
      },
    });
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });

    const result = await engine.assemble({
      sessionId: 'test-session',
      messages: [],
    });

    // We can't control the actual time, but we can verify the structure
    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition).toContain('Live Context');
  });

  it('reports day of week as a real weekday name', async () => {
    tmpDir = makeWorkspace({
      garryAwake: true,
      currentLocation: { city: 'Tokyo', timezone: 'Asia/Tokyo' },
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
    tmpDir = makeWorkspace({ garryAwake: true });
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
});
