/**
 * #7234: a malformed_proposal refusal carries bounded, value-free diagnostics.
 *
 * The parse barrier rejects a judge batch with an invalid event and records
 * only "malformed_proposal". The refusal now also names which check failed: a
 * fixed reason code, the schema field it concerns, the JSON type found there
 * and counts, on the cycle outcome, the direct extractor result and the
 * phase's warning line. Never a value, a key the judge invented, the prompt or
 * the raw response. Inspection is bounded by proposal count, who entries and
 * string length, and never walks nested values. Refusal, ledger state,
 * retry/backoff and writes stay exactly as they were.
 *
 * Reported by @Masashi-Ono0611. The phase cases run on PGLite, and on Postgres
 * when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
import { isValidProposal, runChronicleExtract, type ChronicleJudge } from '../src/core/chronicle/extract-events.ts';
import {
  diagnoseMalformedProposals,
  MAX_INSPECTED_CHARS,
  MAX_INSPECTED_PROPOSALS,
  MAX_INSPECTED_WHO_ITEMS,
} from '../src/core/chronicle/proposal-diagnostics.ts';
import { testBackends } from './helpers/test-backends.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';

const today = new Date().toISOString().slice(0, 10);
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);
const ok = { when: today, who: ['people/alice-example'], what: 'Alice agreed to ship the beta', kind: 'commitment' };
const SECRET = 'sk-live-7234' + 'Q9x'.repeat(12);
const SECRET_KEY = 'ghp_7234' + 'Zt4'.repeat(10);

describe('diagnoseMalformedProposals: fixed codes', () => {
  test.each([
    ['what missing', { when: today, who: [], kind: 'x' }, { code: 'missing_field', field: 'what' }],
    ['when a number', { ...ok, when: 20260618 }, { code: 'wrong_type', field: 'when', shape: 'number' }],
    ['when too short', { ...ok, when: '26' }, { code: 'when_too_short', field: 'when' }],
    ['when not a date', { ...ok, when: 'not-a-date' }, { code: 'when_unparseable', field: 'when' }],
    ['what blank', { ...ok, what: '   ' }, { code: 'what_blank', field: 'what' }],
    ['who a string', { ...ok, who: 'people/alice-example' }, { code: 'wrong_type', field: 'who', shape: 'string' }],
    ['who entry an object', { ...ok, who: ['people/alice-example', { slug: 'x' }] }, { code: 'who_item_not_string', field: 'who', shape: 'object' }],
    ['kind missing', { when: today, who: [], what: 'x' }, { code: 'missing_field', field: 'kind' }],
    ['kind null', { ...ok, kind: null }, { code: 'wrong_type', field: 'kind', shape: 'null' }],
    ['a string proposal', 'Alice agreed', { code: 'not_object', shape: 'string' }],
    ['a null proposal', null, { code: 'not_object', shape: 'null' }],
    ['an array proposal', [ok], { code: 'not_object', shape: 'array' }],
  ])('%s', (_name, proposal, expected) => {
    expect(isValidProposal(proposal)).toBe(false);
    expect<unknown>(diagnoseMalformedProposals([proposal])).toEqual({ ...expected, index: 0, events: 1, inspected: 1, invalid: 1, codes: { [expected.code]: 1 } });
  });

  test('the first defect leads; every defect is counted', () => {
    expect(diagnoseMalformedProposals([ok, { ...ok, what: undefined }, ok, { ...ok, when: 1 }, { ...ok, when: 2 }])).toEqual({
      code: 'missing_field', field: 'what', index: 1, events: 5, inspected: 5, invalid: 3, codes: { missing_field: 1, wrong_type: 2 },
    });
  });
});

describe('diagnoseMalformedProposals: no values, bounded inspection', () => {
  const poisoned = { [SECRET_KEY]: SECRET, when: SECRET, who: [SECRET], what: SECRET, where: SECRET, kind: SECRET };

  test('a secret-looking value or key never reaches the diagnostics', () => {
    const d = diagnoseMalformedProposals([poisoned]);
    expect(d).toMatchObject({ code: 'when_unparseable', field: 'when' });
    const text = JSON.stringify(d);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SECRET_KEY);
  });

  test('event count: at most MAX_INSPECTED_PROPOSALS are read', () => {
    const many = Array.from({ length: 10_000 }, () => ({ ...ok, kind: 7 }));
    expect(diagnoseMalformedProposals(many)).toMatchObject({ code: 'wrong_type', events: 10_000, inspected: MAX_INSPECTED_PROPOSALS, invalid: MAX_INSPECTED_PROPOSALS });
    // The barrier rejects a defect past the bound; the diagnostics say they did not reach it instead of guessing.
    const late = [...Array.from({ length: 10_000 }, () => ok), { ...ok, kind: 7 }];
    expect(late.every(isValidProposal)).toBe(false);
    expect(diagnoseMalformedProposals(late)).toEqual({ code: 'beyond_bounds', events: 10_001, inspected: MAX_INSPECTED_PROPOSALS, invalid: 0, codes: {} });
  });

  test('who entries: at most MAX_INSPECTED_WHO_ITEMS are read', () => {
    const who = (bad: number) => Array.from({ length: 100_000 }, (_, i) => (i === bad ? 7 : 'people/alice-example'));
    expect(diagnoseMalformedProposals([{ ...ok, who: who(MAX_INSPECTED_WHO_ITEMS - 1) }])).toMatchObject({ code: 'who_item_not_string', shape: 'number' });
    expect(diagnoseMalformedProposals([{ ...ok, who: who(MAX_INSPECTED_WHO_ITEMS) }])).toMatchObject({ code: 'beyond_bounds', invalid: 0 });
  });

  test('field size: a string past MAX_INSPECTED_CHARS is never parsed or trimmed', () => {
    const huge = 'x'.repeat(1_000_000);
    expect(isValidProposal({ ...ok, when: huge })).toBe(false);
    expect(diagnoseMalformedProposals([{ ...ok, when: huge }])).toMatchObject({ code: 'beyond_bounds' });
    expect(diagnoseMalformedProposals([{ ...ok, when: 'x'.repeat(MAX_INSPECTED_CHARS) }])).toMatchObject({ code: 'when_unparseable' });
    expect(diagnoseMalformedProposals([{ ...ok, what: ' '.repeat(MAX_INSPECTED_CHARS + 1) }])).toMatchObject({ code: 'beyond_bounds' });
  });

  test('deep input is typed, never walked', () => {
    let deep: unknown = SECRET;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    // Deep enough that any recursive walk (JSON.stringify included) overflows the stack.
    expect(() => JSON.stringify(deep)).toThrow(RangeError);
    const d = diagnoseMalformedProposals([{ ...ok, who: [deep] }, { ...ok, what: { nested: deep } }]);
    expect(d).toMatchObject({ code: 'who_item_not_string', field: 'who', shape: 'array', invalid: 2, codes: { who_item_not_string: 1, wrong_type: 1 } });
    expect(JSON.stringify(d).length).toBeLessThan(400);
  });
});

describe('runChronicleExtract (direct callers)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('the refusal is unchanged and carries the diagnostics, never the values', async () => {
    await engine.putPage('meetings/direct', { type: 'meeting', title: 'Direct', compiled_truth: BODY, frontmatter: { date: today } });
    const r = await runChronicleExtract(engine, { slug: 'meetings/direct', judge: async () => ({ events: [ok, poisonedEvent()] as never }) });
    expect(r).toEqual({
      slug: 'meetings/direct', status: 'skipped', events_written: 0, reason: 'malformed_proposal',
      malformed: { code: 'when_unparseable', field: 'when', index: 1, events: 2, inspected: 2, invalid: 1, codes: { when_unparseable: 1 } },
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE type='event'"))[0].n).toBe(0);
  });
});

function poisonedEvent() {
  return { [SECRET_KEY]: SECRET, when: SECRET, who: [SECRET], what: SECRET, kind: 'meeting' };
}

describe('the chronicle phase', () => {
  const backends = testBackends();
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
  beforeAll(async () => {
    if (backends.includes('postgres')) template = await persistencePostgresTemplate(process.env.DATABASE_URL!);
  }, 120_000);
  afterAll(async () => { await template?.dispose(); });

  async function fresh(backend: string): Promise<{ engine: BrainEngine; close: () => Promise<void> }> {
    if (backend === 'postgres') return template!.clone();
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    return { engine, close: () => engine.disconnect() };
  }

  async function capture<T>(run: () => Promise<T>): Promise<{ value: T; logged: string }> {
    const lines: string[] = [];
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const m of ['log', 'info', 'warn', 'error'] as const) console[m] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try { return { value: await run(), logged: lines.join('\n') }; }
    finally { Object.assign(console, saved); }
  }

  const row = (engine: BrainEngine) => engine.executeRaw<{ state: string; reason: string | null; attempts: number; next_attempt_at: Date | string | null }>(
    'SELECT state, reason, attempts, next_attempt_at FROM chronicle_page_state');
  const minutesUntil = (at: Date | string | null) => (new Date(at as string).getTime() - Date.now()) / 60_000;

  test('refusal, ledger, backoff and writes are unchanged; the outcome and log say which check failed', async () => {
    for (const backend of backends) {
      const { engine, close } = await fresh(backend);
      try {
        await engine.setConfig('chronicle.auto_settle_seconds', '0');
        await engine.setConfig('chronicle.activated_at', new Date(Date.now() - 1000).toISOString());
        await engine.putPage('meetings/sync', { type: 'meeting', title: 'Sync', compiled_truth: BODY, frontmatter: { date: today } });
        let calls = 0;
        const malformed: ChronicleJudge = async () => { calls++; return { events: [ok, poisonedEvent()] as never }; };

        const first = await capture(() => runPhaseChronicle(engine, { judge: malformed }));
        expect([backend, calls]).toEqual([backend, 1]);
        expect(first.value.details).toMatchObject({ judged: 1, failed: 1, extracted: 0, events_written: 0, reasons: { malformed_proposal: 1 } });
        const [r1] = await row(engine);
        expect([backend, r1.state, r1.reason, r1.attempts]).toEqual([backend, 'failed', 'malformed_proposal', 1]);
        expect(minutesUntil(r1.next_attempt_at)).toBeGreaterThan(4);
        expect(minutesUntil(r1.next_attempt_at)).toBeLessThanOrEqual(5);
        expect(first.logged).toContain('meetings/sync: the judge\'s events failed validation (malformed_proposal: code=when_unparseable field=when; proposal 2 of 2; 1 of 2 inspected invalid); nothing was written and the row retries with backoff.');
        for (const text of [first.logged, JSON.stringify(first.value), JSON.stringify(await row(engine))]) {
          expect(text).not.toContain(SECRET);
          expect(text).not.toContain(SECRET_KEY);
        }
        expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE type='event'"))[0].n).toBe(0);

        // Not due yet: no call. Due again: the second attempt backs off twice as long.
        await runPhaseChronicle(engine, { judge: malformed });
        expect([backend, calls]).toEqual([backend, 1]);
        await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second'");
        await capture(() => runPhaseChronicle(engine, { judge: malformed }));
        const [r2] = await row(engine);
        expect([backend, calls, r2.state, r2.reason, r2.attempts]).toEqual([backend, 2, 'failed', 'malformed_proposal', 2]);
        expect(minutesUntil(r2.next_attempt_at)).toBeGreaterThan(9);
        expect(minutesUntil(r2.next_attempt_at)).toBeLessThanOrEqual(10);

        // A valid answer on the next attempt writes as before.
        await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second'");
        const last = await runPhaseChronicle(engine, { judge: async () => ({ events: [ok] }) });
        expect(last.details).toMatchObject({ extracted: 1, events_written: 1 });
        expect((await row(engine)).map((r) => [r.state, r.reason, r.attempts])).toEqual([['extracted', null, 3]]);
      } finally { await close(); }
    }
  }, 120_000);
});
