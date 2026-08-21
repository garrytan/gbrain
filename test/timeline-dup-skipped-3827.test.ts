/**
 * #3827 — silent MCP write drops: add_timeline_entry returned {status:'ok'}
 * even when the (page_id, date, summary, source) unique index deduplicated
 * the row via ON CONFLICT DO NOTHING. The caller had no way to distinguish
 * "inserted" from "silently dropped".
 *
 * Fix: engine.addTimelineEntry returns a boolean (true = row inserted,
 * false = conflict-dropped / JOIN-dropped), and the add_timeline_entry op
 * maps false to {status:'skipped', reason:'duplicate'}.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); // in-memory
  await engine.initSchema();
}, 120_000); // full PGLite schema init can exceed the default hook timeout under suite load

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  for (const t of ['timeline_entries', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await engine.putPage('people/dup-target', {
    type: 'person',
    title: 'Dup Target',
    compiled_truth: 'A page for duplicate timeline-entry testing.',
    timeline: '',
  });
}, 30_000);

function makeCtx(): OperationContext {
  return {
    engine,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false,
    remote: false,
  } as unknown as OperationContext;
}

const ENTRY = { date: '2026-02-01', summary: 'Signed the term sheet', source: 'meetings/2026-02-01' };

describe('engine.addTimelineEntry insert signal (#3827)', () => {
  test('returns true on a fresh insert, false on the duplicate', async () => {
    const first = await engine.addTimelineEntry('people/dup-target', ENTRY);
    expect(first).toBe(true);
    const second = await engine.addTimelineEntry('people/dup-target', ENTRY);
    expect(second).toBe(false);
    const entries = await engine.getTimeline('people/dup-target');
    expect(entries.length).toBe(1);
  });

  test('returns false when skipExistenceCheck drops the row on a missing page', async () => {
    const inserted = await engine.addTimelineEntry(
      'does/not-exist',
      ENTRY,
      { skipExistenceCheck: true },
    );
    expect(inserted).toBe(false);
  });

  test('distinct summaries on the same date both return true', async () => {
    expect(await engine.addTimelineEntry('people/dup-target', { date: '2026-02-01', summary: 'Morning' })).toBe(true);
    expect(await engine.addTimelineEntry('people/dup-target', { date: '2026-02-01', summary: 'Evening' })).toBe(true);
  });
});

describe('add_timeline_entry op duplicate honesty (#3827)', () => {
  const op = operationsByName['add_timeline_entry'];

  test('first call ok, identical second call reports skipped/duplicate with 1 row', async () => {
    const params = { slug: 'people/dup-target', ...ENTRY };
    const first = await op.handler(makeCtx(), params);
    expect(first).toMatchObject({ status: 'ok' });

    const second = await op.handler(makeCtx(), params);
    expect(second).toMatchObject({ status: 'skipped', reason: 'duplicate' });

    const entries = await engine.getTimeline('people/dup-target');
    expect(entries.length).toBe(1);
  });
});
