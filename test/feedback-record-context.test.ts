/**
 * The feedback write-behind queue serves many callers from one drain loop. Each queued event must be written under
 * the context its own caller had when it was enqueued, never under the context of whichever caller happened to
 * start the drain loop. Pins the interleave: caller A starts the drain and its write is in flight; caller B enqueues
 * meanwhile; B's write must run as B.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { isRemoteCaller, withRemoteCaller } from '../src/core/remote-caller.ts';
import { callerAccessRecord, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { _resetFeedbackRecordingForTests, drainFeedbackQueue, recordAnswer } from '../src/core/feedback/record.ts';
import { _resetFeedbackSettingsCacheForTests } from '../src/core/feedback/settings.ts';

interface Seen { clientIds: string[]; remote: boolean; identity: readonly string[] | null }

function proxyEngine(seen: Seen[], gate: Promise<void>): BrainEngine {
  let first = true;
  return {
    getConfig: async (key: string) => (key === 'feedback.enabled' ? 'true' : null),
    insertRetrievalEvents: async (events: Array<{ client_id: string }>) => {
      seen.push({ clientIds: events.map(e => e.client_id), remote: isRemoteCaller(), identity: callerAccessRecord()?.identity ?? null });
      if (first) { first = false; await gate; }
    },
  } as unknown as BrainEngine;
}

function ctxOf(engine: BrainEngine, clientId: string): OperationContext {
  return {
    engine, config: {}, remote: true, transport: 'http', sourceId: 'default', logger: console,
    auth: { token: `t-${clientId}`, clientId, scopes: ['read', 'write'], sourceId: 'default' },
  } as unknown as OperationContext;
}

const answer = (ctx: OperationContext) => recordAnswer(ctx, { op: 'search', pages: [{ source_id: 'default', slug: 'notes/a' }] });

beforeEach(() => {
  _resetFeedbackSettingsCacheForTests();
  _resetFeedbackRecordingForTests();
});

describe('feedback queue context', () => {
  test('two callers whose events share the drain loop are each written under their own access context', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: Seen[] = [];
    const engine = proxyEngine(seen, gate);
    await withRemoteCaller(true, () => withCallerAccess({ identity: ['member:alice'], privateReadableSources: ['default'] }, () => answer(ctxOf(engine, 'client-a'))));
    // A's write is now in flight and blocked; B enqueues while it is.
    await withRemoteCaller(true, () => withCallerAccess({ identity: ['member:bob'] }, () => answer(ctxOf(engine, 'client-b'))));
    release();
    expect((await drainFeedbackQueue(10_000)).unfinished).toBe(0);
    expect(seen.map(s => ({ clients: s.clientIds, remote: s.remote, identity: s.identity }))).toEqual([
      { clients: ['client-a'], remote: true, identity: ['member:alice'] },
      { clients: ['client-b'], remote: true, identity: ['member:bob'] },
    ]);
  });
});
