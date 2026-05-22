/**
 * Tests for IngestionTestHarness — the publisher-facing test utility
 * exported at gbrain/ingestion/test-harness.
 *
 * The harness IS the publisher contract. These tests pin its behavior so
 * skillpack authors can rely on it across gbrain minor versions.
 */

import { describe, expect, test } from 'bun:test';
import {
  IngestionTestHarness,
  expectEvent,
} from '../../src/core/ingestion/test-harness.ts';
import {
  computeContentHash,
  type IngestionEvent,
  type IngestionSource,
} from '../../src/core/ingestion/types.ts';

function makeMockSource(opts: {
  id?: string;
  kind?: string;
  emitOnStart?: IngestionEvent[];
  startThrows?: string;
  stopThrows?: string;
  stopDelayMs?: number;
} = {}): IngestionSource {
  return {
    id: opts.id ?? 'mock-1',
    kind: opts.kind ?? 'mock',
    async start(ctx) {
      if (opts.startThrows) throw new Error(opts.startThrows);
      for (const ev of opts.emitOnStart ?? []) ctx.emit(ev);
    },
    async stop() {
      if (opts.stopDelayMs) {
        await new Promise((r) => setTimeout(r, opts.stopDelayMs));
      }
      if (opts.stopThrows) throw new Error(opts.stopThrows);
    },
  };
}

function makeEvent(overrides: Partial<IngestionEvent> = {}): IngestionEvent {
  return {
    source_id: 'mock-1',
    source_kind: 'mock',
    source_uri: '/tmp/event.md',
    received_at: new Date('2026-05-20T12:00:00Z').toISOString(),
    content_type: 'text/markdown',
    content: '# test',
    content_hash: computeContentHash('# test'),
    ...overrides,
  };
}

describe('IngestionTestHarness lifecycle', () => {
  test('run() starts the source and captures emitted events', async () => {
    const harness = new IngestionTestHarness();
    const source = makeMockSource({ emitOnStart: [makeEvent()] });
    await harness.run(source);
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]?.source_kind).toBe('mock');
    await harness.stop();
  });

  test('events are captured in emit order', async () => {
    const harness = new IngestionTestHarness();
    const e1 = makeEvent({ content: 'one', content_hash: computeContentHash('one') });
    const e2 = makeEvent({ content: 'two', content_hash: computeContentHash('two') });
    const source = makeMockSource({ emitOnStart: [e1, e2] });
    await harness.run(source);
    expect(harness.events[0]?.content).toBe('one');
    expect(harness.events[1]?.content).toBe('two');
    await harness.stop();
  });

  test('source startup error propagates from run()', async () => {
    const harness = new IngestionTestHarness();
    const source = makeMockSource({ startThrows: 'boom' });
    await expect(harness.run(source)).rejects.toThrow('boom');
  });

  test('double run() rejects without leaking state', async () => {
    const harness = new IngestionTestHarness();
    await harness.run(makeMockSource());
    await expect(harness.run(makeMockSource())).rejects.toThrow(/already running/);
    await harness.stop();
  });

  test('stop() calls source.stop()', async () => {
    let stopped = false;
    const source: IngestionSource = {
      id: 'mock', kind: 'mock',
      async start() {},
      async stop() { stopped = true; },
    };
    const harness = new IngestionTestHarness();
    await harness.run(source);
    await harness.stop();
    expect(stopped).toBe(true);
  });

  test('stop() honors grace window when source hangs', async () => {
    const harness = new IngestionTestHarness();
    const source = makeMockSource({ stopDelayMs: 200 });
    await harness.run(source);
    await expect(harness.stop(50)).rejects.toThrow(/did not stop within 50ms/);
  });

  test('stop() before run() is a no-op', async () => {
    const harness = new IngestionTestHarness();
    await harness.stop();
  });
});

describe('IngestionTestHarness validation', () => {
  test('invalid events are routed to validationErrors, not events', async () => {
    const harness = new IngestionTestHarness();
    const bad = { ...makeEvent(), content_type: 'totally-invalid' as never };
    const source = makeMockSource({ emitOnStart: [bad] });
    await harness.run(source);
    expect(harness.events).toHaveLength(0);
    expect(harness.validationErrors).toHaveLength(1);
    expect(harness.validationErrors[0]).toContain('content_type');
    await harness.stop();
  });

  test('mix of valid and invalid events: valid land, invalid surface as errors', async () => {
    const good = makeEvent({ content: 'good', content_hash: computeContentHash('good') });
    const bad = { ...makeEvent(), source_id: '' }; // empty source_id
    const harness = new IngestionTestHarness();
    const source = makeMockSource({ emitOnStart: [good, bad] });
    await harness.run(source);
    expect(harness.events).toHaveLength(1);
    expect(harness.validationErrors).toHaveLength(1);
    await harness.stop();
  });
});

describe('IngestionTestHarness clock', () => {
  test('default clock starts at the deterministic seed', () => {
    const harness = new IngestionTestHarness();
    expect(harness.now()).toBe(1747742400000); // 2026-05-20T12:00:00Z
  });

  test('explicit startTime is honored', () => {
    const harness = new IngestionTestHarness({ startTime: 5000 });
    expect(harness.now()).toBe(5000);
  });

  test('advance(ms) bumps the clock', () => {
    const harness = new IngestionTestHarness({ startTime: 1000 });
    harness.advance(500);
    expect(harness.now()).toBe(1500);
  });

  test('advance rejects negative deltas', () => {
    const harness = new IngestionTestHarness();
    expect(() => harness.advance(-1)).toThrow(/must be >= 0/);
  });
});

describe('IngestionTestHarness engine proxy', () => {
  test('source touching the engine without an injected one throws with helpful message', async () => {
    let caught: string | null = null;
    const source: IngestionSource = {
      id: 'mock', kind: 'mock',
      async start(ctx) {
        try {
          // Accessing ANY engine property fires the proxy.
          (ctx.engine as { getStats: () => unknown }).getStats();
        } catch (e) {
          caught = e instanceof Error ? e.message : String(e);
        }
      },
      async stop() {},
    };
    const harness = new IngestionTestHarness();
    await harness.run(source);
    expect(caught).not.toBeNull();
    expect(caught!).toContain('IngestionTestHarness');
    expect(caught!).toContain('BrainEngine');
    expect(caught!).toContain('getStats');
    await harness.stop();
  });
});

describe('IngestionTestHarness healthCheck', () => {
  test('returns ok when source has no healthCheck implementation', async () => {
    const harness = new IngestionTestHarness();
    await harness.run(makeMockSource());
    const h = await harness.healthCheck();
    expect(h.status).toBe('ok');
    await harness.stop();
  });

  test('returns the source\'s healthCheck result', async () => {
    const source: IngestionSource = {
      id: 'mock', kind: 'mock',
      async start() {},
      async stop() {},
      async healthCheck() {
        return { status: 'warn', message: 'API rate limit close' };
      },
    };
    const harness = new IngestionTestHarness();
    await harness.run(source);
    const h = await harness.healthCheck();
    expect(h.status).toBe('warn');
    expect(h.message).toBe('API rate limit close');
    await harness.stop();
  });

  test('healthCheck before run throws', async () => {
    const harness = new IngestionTestHarness();
    await expect(harness.healthCheck()).rejects.toThrow(/no source started/);
  });
});

describe('IngestionTestHarness clearRecorded', () => {
  test('clears events + logs + validationErrors but keeps running state', async () => {
    const harness = new IngestionTestHarness();
    const source = makeMockSource({ emitOnStart: [makeEvent()] });
    await harness.run(source);
    expect(harness.events).toHaveLength(1);
    expect(harness.running).toBe(true);
    harness.clearRecorded();
    expect(harness.events).toHaveLength(0);
    expect(harness.running).toBe(true);
    await harness.stop();
  });
});

describe('expectEvent matchers', () => {
  test('toExist returns the event on success', () => {
    const ev = makeEvent();
    expect(expectEvent(ev).toExist()).toBe(ev);
  });

  test('toExist throws on undefined', () => {
    expect(() => expectEvent(undefined).toExist()).toThrow(/was undefined/);
  });

  test('toHaveKind passes on match', () => {
    expect(() => expectEvent(makeEvent()).toHaveKind('mock')).not.toThrow();
  });

  test('toHaveKind throws on mismatch', () => {
    expect(() => expectEvent(makeEvent()).toHaveKind('wrong')).toThrow(/expected source_kind/);
  });

  test('toHaveSourceUri accepts a regex matcher', () => {
    const ev = makeEvent({ source_uri: '/tmp/foo.granola' });
    expect(() => expectEvent(ev).toHaveSourceUri(/\.granola$/)).not.toThrow();
    expect(() => expectEvent(ev).toHaveSourceUri(/\.mp3$/)).toThrow();
  });

  test('toHaveSourceUri accepts a literal string', () => {
    const ev = makeEvent({ source_uri: '/exact' });
    expect(() => expectEvent(ev).toHaveSourceUri('/exact')).not.toThrow();
    expect(() => expectEvent(ev).toHaveSourceUri('/other')).toThrow();
  });

  test('toHaveContentHash with no arg validates shape only', () => {
    expect(() => expectEvent(makeEvent()).toHaveContentHash()).not.toThrow();
    const bad = { ...makeEvent(), content_hash: 'not-hex' };
    expect(() => expectEvent(bad).toHaveContentHash()).toThrow(/not a valid SHA-256/);
  });

  test('toHaveContentHash with arg validates exact match', () => {
    const ev = makeEvent({ content_hash: 'a'.repeat(64) });
    expect(() => expectEvent(ev).toHaveContentHash('a'.repeat(64))).not.toThrow();
    expect(() => expectEvent(ev).toHaveContentHash('b'.repeat(64))).toThrow(/expected content_hash/);
  });

  test('toBeUntrusted / toBeTrusted', () => {
    const trusted = makeEvent({ untrusted_payload: false });
    const untrusted = makeEvent({ untrusted_payload: true });
    expect(() => expectEvent(trusted).toBeTrusted()).not.toThrow();
    expect(() => expectEvent(untrusted).toBeUntrusted()).not.toThrow();
    expect(() => expectEvent(trusted).toBeUntrusted()).toThrow();
    expect(() => expectEvent(untrusted).toBeTrusted()).toThrow();
  });

  test('toHaveMetadata matches a subset', () => {
    const ev = makeEvent({ metadata: { format: 'png', width: 1024 } });
    expect(() => expectEvent(ev).toHaveMetadata({ format: 'png' })).not.toThrow();
    expect(() => expectEvent(ev).toHaveMetadata({ width: 1024 })).not.toThrow();
    expect(() => expectEvent(ev).toHaveMetadata({ format: 'jpg' })).toThrow();
  });
});
