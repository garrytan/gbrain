// v0.41 T2 — IngestionSource.mode discriminator + daemon supervisor branch.
//
// Codex outside-voice challenge: bulk migration semantics differ from trickle
// ingestion. The 24h DedupWindow is wrong for one-shot bulk importers (24K
// pages, retries days apart, content_hash collisions across the window are
// expected). Migration-mode sources bypass DedupWindow entirely and own
// permanent slug-keyed idempotency themselves.
//
// This test pins:
//   - IngestionSource.mode type accepts 'trickle' | 'migration'
//   - Defaults to 'trickle' when unset (back-compat with v0.38 sources)
//   - Daemon's handleEmit() bypasses DedupWindow.mark() in migration mode
//   - Validation + rate limit + dispatch still apply uniformly
//   - Two emits of identical content_hash from migration-mode source BOTH
//     dispatch (no silent dedup drop)
//   - Same two emits from trickle-mode source: second is dedup hit (silent)

import { describe, test, expect, beforeEach } from 'bun:test';
import { IngestionDaemon } from '../../src/core/ingestion/daemon.ts';
import type {
  IngestionSource,
  IngestionSourceContext,
  IngestionEvent,
  IngestionSourceMode,
} from '../../src/core/ingestion/types.ts';
import { computeContentHash } from '../../src/core/ingestion/types.ts';

// Stub source that emits whatever we tell it to. Captures the context so
// tests can drive emit() directly from outside.
class StubSource implements IngestionSource {
  ctx: IngestionSourceContext | null = null;
  constructor(
    readonly id: string,
    readonly kind: string,
    readonly mode?: IngestionSourceMode,
  ) {}
  async start(ctx: IngestionSourceContext): Promise<void> {
    this.ctx = ctx;
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
}

function makeEvent(overrides: Partial<IngestionEvent> = {}): IngestionEvent {
  const content = overrides.content ?? 'hello world';
  return {
    source_id: 'stub-1',
    source_kind: 'test-source',
    source_uri: 'test://event-1',
    received_at: new Date().toISOString(),
    content_type: 'text/markdown',
    content,
    content_hash: overrides.content_hash ?? computeContentHash(content),
    ...overrides,
  };
}

// Async barrier — daemon dispatches via microtask, so we await one tick.
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('v0.41 T2: IngestionSource.mode discriminator', () => {
  test('mode is optional in interface (back-compat with v0.38 sources)', () => {
    // Compile-time test: a source without `mode` field is valid.
    const trickle: IngestionSource = {
      id: 'no-mode',
      kind: 'test-source',
      async start() {},
      async stop() {},
    };
    expect(trickle.mode).toBeUndefined();
  });

  test('mode accepts trickle | migration string literals', () => {
    const trickle: IngestionSource = {
      id: 's1',
      kind: 'test',
      mode: 'trickle',
      async start() {},
      async stop() {},
    };
    const migration: IngestionSource = {
      id: 's2',
      kind: 'test',
      mode: 'migration',
      async start() {},
      async stop() {},
    };
    expect(trickle.mode).toBe('trickle');
    expect(migration.mode).toBe('migration');
  });
});

describe('v0.41 T2: daemon handleEmit branches on source.mode', () => {
  let dispatched: IngestionEvent[];
  let dispatch: (event: IngestionEvent) => Promise<{ kind: 'queued' } | { kind: 'failed'; error: string }>;

  beforeEach(() => {
    dispatched = [];
    dispatch = async (event) => {
      dispatched.push(event);
      return { kind: 'queued' as const };
    };
  });

  test('trickle-mode source: duplicate content_hash within 24h window → second silent-dropped', async () => {
    const source = new StubSource('trickle-1', 'test-source', 'trickle');
    const daemon = new IngestionDaemon({
      engine: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dispatch,
    });
    daemon.register({ source });
    await daemon.start();

    const event = makeEvent({ content: 'shared content' });
    source.ctx!.emit(event);
    await tick();
    source.ctx!.emit(event); // identical content_hash
    await tick();

    expect(dispatched.length).toBe(1);
    await daemon.stop();
  });

  test('migration-mode source: duplicate content_hash within 24h window → BOTH dispatch', async () => {
    const source = new StubSource('migration-1', 'test-source', 'migration');
    const daemon = new IngestionDaemon({
      engine: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dispatch,
    });
    daemon.register({ source });
    await daemon.start();

    const event = makeEvent({ content: 'shared content' });
    source.ctx!.emit(event);
    await tick();
    source.ctx!.emit(event); // identical content_hash — should still dispatch
    await tick();

    expect(dispatched.length).toBe(2);
    await daemon.stop();
  });

  test('source without mode field defaults to trickle (v0.38 back-compat)', async () => {
    const source: IngestionSource = {
      id: 'no-mode-1',
      kind: 'test-source',
      async start(ctx) {
        (source as { _ctx?: IngestionSourceContext })._ctx = ctx;
      },
      async stop() {},
    };
    const daemon = new IngestionDaemon({
      engine: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dispatch,
    });
    daemon.register({ source });
    await daemon.start();

    const ctx = (source as { _ctx?: IngestionSourceContext })._ctx!;
    const event = makeEvent({ content: 'default-mode test' });
    ctx.emit(event);
    await tick();
    ctx.emit(event); // identical content_hash — trickle defaults dedup it
    await tick();

    expect(dispatched.length).toBe(1);
    await daemon.stop();
  });

  test('migration-mode source: validation still runs (malformed event still dropped)', async () => {
    const source = new StubSource('migration-2', 'test-source', 'migration');
    const daemon = new IngestionDaemon({
      engine: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dispatch,
    });
    daemon.register({ source });
    await daemon.start();

    // Malformed: content_hash isn't 64 hex chars
    source.ctx!.emit(makeEvent({ content_hash: 'not-a-real-sha256' }));
    await tick();

    expect(dispatched.length).toBe(0);
    await daemon.stop();
  });

  test('mixed dual source: trickle dedups own stream, migration does not', async () => {
    const trickle = new StubSource('trickle-mixed', 'test-source', 'trickle');
    const migration = new StubSource('migration-mixed', 'test-source-2', 'migration');
    const daemon = new IngestionDaemon({
      engine: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dispatch,
    });
    daemon.register({ source: trickle });
    daemon.register({ source: migration });
    await daemon.start();

    const e1 = makeEvent({ content: 'mixed-1' });
    const e2 = makeEvent({ content: 'mixed-2' });

    // Trickle: same hash twice → 1 dispatched
    trickle.ctx!.emit(e1);
    await tick();
    trickle.ctx!.emit(e1);
    await tick();

    // Migration: same hash twice → 2 dispatched
    migration.ctx!.emit(e2);
    await tick();
    migration.ctx!.emit(e2);
    await tick();

    expect(dispatched.length).toBe(3);
    await daemon.stop();
  });
});
