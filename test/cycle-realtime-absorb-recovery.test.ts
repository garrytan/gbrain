/**
 * Tests for the `realtime_absorb_recovery` cycle phase — durable recovery
 * of pages whose real-time facts extraction was dropped (fire-and-forget
 * queue aborted on process exit), recorded as a `facts:absorb` failure row
 * in ingest_log.
 *
 * Hermetic via the gateway chat/embed stubs. One PGLite engine per file.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { runPhaseRealtimeAbsorbRecovery } from '../src/core/cycle/realtime-absorb-recovery.ts';

const SLUG = 'meetings/2026-05-09-team-sync';
// Generic narrative-summary body (no speaker/timestamp segments) — the case
// the chat-shaped backfill can't parse, so the real-time recovery path is the
// correct fix. Content is placeholder; the chat transport is stubbed.
const BODY =
  '# Team sync\n\nApproved the Q3 budget for the widget-co integration. ' +
  'Postpone the redesign until after the pilot. Vendor scale-up is gated on the pilot results.';

async function countTombstones(engine: PGLiteEngine, slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ingest_log WHERE source_type = 'facts:absorb-recovered' AND source_ref = $1`,
    [slug],
  );
  return Number(rows[0]?.count ?? 0);
}

async function countFacts(engine: PGLiteEngine): Promise<number> {
  const rows = await engine.executeRaw<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM facts`,
  );
  return Number(rows[0]?.count ?? 0);
}

describe('realtime_absorb_recovery phase', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    let callIndex = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      callIndex++;
      return {
        text: JSON.stringify({
          facts: [{
            fact: `synthetic recovered fact #${callIndex}`,
            kind: 'event',
            entity: 'companies/acme-corp',
            confidence: 1.0,
            notability: 'high',
          }],
        }),
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'stub:stub',
        providerId: 'stub',
      };
    });
    __setEmbedTransportForTests(
      (async () => ({ embeddings: [Array.from({ length: 1536 }, () => 0.1)] })) as never,
    );
  });

  afterAll(async () => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    resetGateway();
    await engine.disconnect();
  });

  beforeEach(async () => {
    await engine.executeRaw(`DELETE FROM facts`);
    await engine.executeRaw(`DELETE FROM ingest_log`);
    await engine.executeRaw(`DELETE FROM pages`);
    await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'cycle.realtime_absorb_recovery%'`);
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.putPage(SLUG, {
      type: 'meeting',
      title: 'Team sync',
      compiled_truth: BODY,
      timeline: '',
      frontmatter: {},
    });
  });

  test('recovers a page with an unresolved facts:absorb failure + tombstones it', async () => {
    // Simulate a dropped real-time extraction.
    await engine.logIngest({
      source_id: 'default',
      source_type: 'facts:absorb',
      source_ref: SLUG,
      pages_updated: [],
      summary: 'pipeline_error: [chat(...)] The operation was aborted.',
    });

    const result = await runPhaseRealtimeAbsorbRecovery(engine, {});
    expect(result.status).toBe('ok');
    expect(result.details.recovered).toBe(1);
    expect(await countFacts(engine)).toBeGreaterThan(0);
    expect(await countTombstones(engine, SLUG)).toBe(1);
  });

  test('a tombstoned failure is not re-processed on the next run (cursor-only-on-confirmed-write)', async () => {
    await engine.logIngest({
      source_id: 'default', source_type: 'facts:absorb', source_ref: SLUG,
      pages_updated: [], summary: 'aborted',
    });

    const first = await runPhaseRealtimeAbsorbRecovery(engine, {});
    expect(first.details.recovered).toBe(1);

    // Second run: the failure is tombstoned → backlog empty → nothing attempted.
    const second = await runPhaseRealtimeAbsorbRecovery(engine, {});
    expect(second.details.attempted).toBe(0);
    expect(second.details.recovered).toBe(0);
  });

  test('a per-page failure leaves the row un-tombstoned (retried next cycle)', async () => {
    await engine.logIngest({
      source_id: 'default', source_type: 'facts:absorb', source_ref: SLUG,
      pages_updated: [], summary: 'aborted',
    });

    // Force the inline backstop to fail by making insertFact throw. The page
    // is eligible + extracts facts, but the write fails → no tombstone.
    type IF = PGLiteEngine['insertFact'];
    const realInsertFact: IF = engine.insertFact.bind(engine);
    let failing = true;
    engine.insertFact = (async (...args: Parameters<IF>) => {
      if (failing) throw new Error('synthetic insertFact failure');
      return realInsertFact(...args);
    }) as IF;

    try {
      const result = await runPhaseRealtimeAbsorbRecovery(engine, {});
      // The failure is recorded per-page; the row is NOT tombstoned.
      expect(result.details.recovered).toBe(0);
      expect(await countTombstones(engine, SLUG)).toBe(0);
    } finally {
      failing = false;
      engine.insertFact = realInsertFact;
    }

    // Next cycle (writes work again) recovers it.
    const retry = await runPhaseRealtimeAbsorbRecovery(engine, {});
    expect(retry.details.recovered).toBe(1);
    expect(await countTombstones(engine, SLUG)).toBe(1);
  });

  test('page deleted since the failure → tombstoned without retrying forever', async () => {
    await engine.logIngest({
      source_id: 'default', source_type: 'facts:absorb', source_ref: 'meetings/gone',
      pages_updated: [], summary: 'aborted',
    });

    const result = await runPhaseRealtimeAbsorbRecovery(engine, {});
    expect(result.details.pages_gone).toBe(1);
    expect(await countTombstones(engine, 'meetings/gone')).toBe(1);
  });

  test('explicit kill switch (enabled=false) skips the phase', async () => {
    await engine.setConfig('cycle.realtime_absorb_recovery.enabled', 'false');
    const result = await runPhaseRealtimeAbsorbRecovery(engine, {});
    expect(result.status).toBe('skipped');
  });

  test('default (config unset) is ON', async () => {
    await engine.logIngest({
      source_id: 'default', source_type: 'facts:absorb', source_ref: SLUG,
      pages_updated: [], summary: 'aborted',
    });
    // No config set → default ON → it processes the backlog.
    const result = await runPhaseRealtimeAbsorbRecovery(engine, {});
    expect(result.status).toBe('ok');
    expect(result.details.recovered).toBe(1);
  });
});
