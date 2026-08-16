/**
 * The hook lane's delivery logging — the SHIPPED wiring behind serve's
 * onTurnContextDelivered callback (logTurnContextDeliveryFireAndForget) plus
 * the isVolunteerChannel runtime guard. Hermetic: stub engine captures the
 * multi-row INSERT; the fire-and-forget sink is drained per test.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  isVolunteerChannel,
  logTurnContextDeliveryFireAndForget,
  awaitPendingVolunteerEventWrites,
  _resetPendingVolunteerEventWritesForTests,
} from '../src/core/context/volunteer-events.ts';
import { logDeliveredReflexPointers, type ReflexPointer } from '../src/core/context/retrieval-reflex.ts';
import type { VolunteeredPage } from '../src/core/context/volunteer.ts';
import type { BrainEngine } from '../src/core/engine.ts';

interface CapturedInsert { sql: string; params: unknown[] }

function stubEngine(captured: CapturedInsert[], fail = false): BrainEngine {
  return {
    executeRaw: async (sql: string, params: unknown[]) => {
      if (fail) throw new Error('insert exploded');
      captured.push({ sql, params });
      return [];
    },
  } as unknown as BrainEngine;
}

const PAGE: VolunteeredPage = {
  slug: 'companies/acme', source_id: 'default', display: 'Acme', confidence: 0.85,
  arm: 'title', rationale: 'exact title match "Acme"', synopsis: 'a company',
};
const POINTER: ReflexPointer = {
  display: 'Alice', slug: 'people/alice', source_id: 'default', synopsis: 'x', arm: 'alias', confidence: 0.9,
};

beforeEach(() => {
  _resetPendingVolunteerEventWritesForTests();
});

describe('isVolunteerChannel', () => {
  test('accepts exactly the six known channels; rejects everything else', () => {
    for (const ok of ['op', 'reflex', 'watch', 'claude-code', 'codex', 'opencode']) {
      expect(isVolunteerChannel(ok)).toBe(true);
    }
    for (const bad of ['vim', '', null, undefined, 42, {}, 'CLAUDE-CODE', 'hook']) {
      expect(isVolunteerChannel(bad)).toBe(false);
    }
  });
});

describe('logTurnContextDeliveryFireAndForget — the shipped serve wiring', () => {
  test('volunteered pages land under the request channel with the clamped sessionId', async () => {
    const captured: CapturedInsert[] = [];
    const engine = stubEngine(captured);
    logTurnContextDeliveryFireAndForget(
      engine,
      { volunteered: [PAGE], pointers: [] },
      { channel: 'codex', sessionId: 's'.repeat(400) },
    );
    await awaitPendingVolunteerEventWrites(2000);
    expect(captured).toHaveLength(1);
    const { params } = captured[0];
    expect(params).toContain('codex');
    expect(params).toContain('companies/acme');
    // Trust-boundary clamp: 400-char sessionId stored at 256.
    const session = (params as string[]).find((p) => typeof p === 'string' && p.startsWith('sss'));
    expect(session!.length).toBe(256);
  });

  test('absent/unknown channel falls back to claude-code (the only registered harness today)', async () => {
    const captured: CapturedInsert[] = [];
    logTurnContextDeliveryFireAndForget(stubEngine(captured), { volunteered: [PAGE] }, {});
    await awaitPendingVolunteerEventWrites(2000);
    expect(captured[0].params).toContain('claude-code');

    captured.length = 0;
    _resetPendingVolunteerEventWritesForTests();
    logTurnContextDeliveryFireAndForget(stubEngine(captured), { volunteered: [PAGE] }, { channel: 'not-a-channel' });
    await awaitPendingVolunteerEventWrites(2000);
    expect(captured[0].params).toContain('claude-code');
  });

  test('pointers log through the reflex-pointer path under the SAME channel', async () => {
    const captured: CapturedInsert[] = [];
    logTurnContextDeliveryFireAndForget(stubEngine(captured), { volunteered: [], pointers: [POINTER] }, { channel: 'claude-code' });
    await awaitPendingVolunteerEventWrites(2000);
    expect(captured).toHaveLength(1);
    expect(captured[0].params).toContain('claude-code');
    expect(captured[0].params).toContain('people/alice');
  });

  test('empty delivery logs nothing; a failing insert never throws into the caller', async () => {
    const captured: CapturedInsert[] = [];
    logTurnContextDeliveryFireAndForget(stubEngine(captured), { volunteered: [], pointers: [] }, { channel: 'claude-code' });
    await awaitPendingVolunteerEventWrites(2000);
    expect(captured).toHaveLength(0);

    // Fire-and-forget: the sink swallows the insert failure.
    expect(() =>
      logTurnContextDeliveryFireAndForget(stubEngine([], true), { volunteered: [PAGE] }, { channel: 'op' }),
    ).not.toThrow();
    await awaitPendingVolunteerEventWrites(2000);
  });
});

describe('logDeliveredReflexPointers — ambient reflex channel', () => {
  test('logs under the reflex channel with the shared rationale template', async () => {
    const captured: CapturedInsert[] = [];
    logDeliveredReflexPointers(stubEngine(captured), [POINTER]);
    await awaitPendingVolunteerEventWrites(2000);
    expect(captured).toHaveLength(1);
    expect(captured[0].params).toContain('reflex');
    expect(captured[0].params).toContain('alias match "Alice"'); // reflexPointerRationale parity
  });
});

describe('channel guards', () => {
  test('isHarnessChannel accepts only harness channels — internal channels are refused from the wire', async () => {
    const { isHarnessChannel } = await import('../src/core/context/volunteer-events.ts');
    expect(isHarnessChannel('claude-code')).toBe(true);
    expect(isHarnessChannel('codex')).toBe(true);
    // opencode widening (v0.45.x): without this membership a hook delivery
    // attributed `--harness opencode` silently rebadges as claude-code.
    expect(isHarnessChannel('opencode')).toBe(true);
    for (const internal of ['op', 'reflex', 'watch']) expect(isHarnessChannel(internal)).toBe(false);
  });

  test('wire delivery claiming an INTERNAL channel falls back to the harness default (stat-pollution guard)', async () => {
    const captured: CapturedInsert[] = [];
    logTurnContextDeliveryFireAndForget(stubEngine(captured), { volunteered: [PAGE] }, { channel: 'reflex' });
    await awaitPendingVolunteerEventWrites(2000);
    expect(captured[0].params).toContain('claude-code');
    expect(captured[0].params).not.toContain('reflex');
  });
});
