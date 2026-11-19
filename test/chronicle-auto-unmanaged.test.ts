/**
 * #5876 (E6) — the `chronicle` phase on an unmanaged brain (trusted local
 * writers, no write-time decision): it scans pages changed since the
 * activation stamp and extracts them; pages written before activation stay
 * history for `foresights chronicle-backfill`.
 * Fails when: an unmanaged brain never extracts automatically, or the first
 * run after upgrade sweeps pre-activation history.
 * Seams: injected judge; in-memory PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';

let engine: PGLiteEngine;
const today = new Date().toISOString().slice(0, 10);
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('the phase scans pages changed since activation; earlier pages stay with backfill', async () => {
  await engine.setConfig('chronicle.auto_settle_seconds', '0');
  await engine.putPage('meetings/before', { type: 'meeting', title: 'Before', compiled_truth: BODY, frontmatter: { date: today } });
  await Bun.sleep(20);
  await engine.setConfig('chronicle.activated_at', new Date().toISOString());
  await Bun.sleep(20);
  await engine.putPage('meetings/after', { type: 'meeting', title: 'After', compiled_truth: BODY, frontmatter: { date: today } });
  let calls = 0;
  const r = await runPhaseChronicle(engine, { judge: async () => {
    calls++;
    return { events: [{ when: today, who: ['people/alice-example'], what: 'Alice agreed to ship the beta', kind: 'commitment' }] };
  } });
  expect(calls).toBe(1);
  expect(r.details).toMatchObject({ extracted: 1, events_written: 1 });
  expect(await engine.executeRaw('SELECT slug, state FROM chronicle_page_state ORDER BY slug')).toEqual([{ slug: 'meetings/after', state: 'extracted' }]);
  expect((await engine.getTimelineForDate(today, {})).map((r) => r.summary)).toEqual(['Alice agreed to ship the beta']);
});
