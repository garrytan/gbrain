/**
 * Pins the `recall` op's event-time WIRING, not just the engine capability.
 *
 * `test/facts-engine.test.ts` proves `listFactsSince({ eventTime: true })`
 * behaves correctly at the engine layer, but every one of those tests stays
 * green if the op stops passing the flag — so they cannot detect the wiring
 * regressing. These tests drive the real op through `dispatchToolCall` and
 * assert on the observable ordering/filtering, which only holds when the op
 * actually opts in.
 *
 * Scenario mirrors the reported bug: a batch backfill writes many facts at
 * one `created_at`, so creation-time ordering surfaces extraction order
 * rather than the day the event happened.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

const ENTITY = 'evt-op-test';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Two facts inserted in one "batch": identical created_at, but their
  // valid_from (event time) runs opposite to insertion order. Under
  // creation-time semantics the tie is broken by id DESC, so the LAST
  // inserted row leads; under event-time semantics the NEWER event leads.
  await engine.insertFact(
    { fact: 'newer-event', kind: 'fact', entity_slug: ENTITY, source: 'test', visibility: 'world' },
    { source_id: 'default' },
  );
  await engine.insertFact(
    { fact: 'older-event', kind: 'fact', entity_slug: ENTITY, source: 'test', visibility: 'world' },
    { source_id: 'default' },
  );

  // Force the batch shape: one shared created_at, divergent valid_from.
  // 'older-event' is backdated well outside a 48h window; 'newer-event'
  // sits inside it.
  await engine.executeRaw(
    `UPDATE facts SET created_at = now(), valid_from = now() - interval '1 hour'
       WHERE entity_slug = $1 AND fact = 'newer-event'`,
    [ENTITY],
  );
  await engine.executeRaw(
    `UPDATE facts SET created_at = now(), valid_from = now() - interval '30 days'
       WHERE entity_slug = $1 AND fact = 'older-event'`,
    [ENTITY],
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('recall op passes eventTime through to the engine', () => {
  test('since-window filters on event time, not creation time', async () => {
    const result = await dispatchToolCall(engine, 'recall', { since: '48 hours ago' }, {
      remote: false,
      sourceId: 'default',
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    const facts = payload.facts.filter(
      (f: { entity_slug?: string }) => f.entity_slug === ENTITY,
    ).map((f: { fact: string }) => f.fact);

    // Both rows were CREATED just now, so a created_at-based window would
    // return both. Only the event-time window drops the backdated one.
    expect(facts).toContain('newer-event');
    expect(facts).not.toContain('older-event');
  });

  test('ordering follows event time when created_at ties', async () => {
    const result = await dispatchToolCall(engine, 'recall', {}, {
      remote: false,
      sourceId: 'default',
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    const ours = payload.facts.filter(
      (f: { entity_slug?: string }) => f.entity_slug === ENTITY,
    ).map((f: { fact: string }) => f.fact);

    // Insertion order was newer-event then older-event, so `created_at DESC,
    // id DESC` puts 'older-event' first. Event time reverses that.
    expect(ours.indexOf('newer-event')).toBeGreaterThanOrEqual(0);
    expect(ours.indexOf('older-event')).toBeGreaterThanOrEqual(0);
    expect(ours.indexOf('newer-event')).toBeLessThan(ours.indexOf('older-event'));
  });
});
