/**
 * #5329 (e): a proposal-count cap per page extraction.
 *
 * Protects: a judge that returns an unbounded array (an event-dense transcript, a model that lists every sentence)
 * publishes at most `chronicle.max_events_per_page` events (default 25). The cap is applied after the date screen,
 * so a proposal without a day or dated after the page never occupies a slot; the kept proposals are the first in the
 * judge's order (deterministic) and the rest are counted `events_dropped.over_cap`, never written. Counting costs no
 * provider call: the judge runs once.
 * Fails when: more than the cap reaches life/events/, the drop is uncounted, or the knob is unregistered or unvalidated.
 * Seams: injected judge (`runPhaseChronicle({ judge })`, `runChronicleExtract({ judge })`), `engine.setConfig`.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { CHRONICLE_CONFIG_KEYS, chronicleSettings, validateChronicleConfigValue } from '../src/core/chronicle/config.ts';
import {
  chronicleJudgeContext, runChronicleExtract, screenChronicleProposals, type ChronicleEventProposal,
} from '../src/core/chronicle/extract-events.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

/** PGLite in the unit lane; the e2e wrapper reruns every case on an isolated Postgres database. */
const databaseUrl = process.env.GBRAIN_TEST_BACKEND === 'postgres' ? requirePostgresTestDatabase() : undefined;
const brain = (run: (b: ManagedBrain) => Promise<void>) => managedBrain(run, { databaseUrl });

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const PAGE_DAY = day(-3);
const BODY = 'Alice and Bob walked the whole quarter: every launch, every hire, every decision, one after another. '.repeat(3);
const meeting = () => `---\ntype: meeting\ntitle: Quarter review\ndate: ${PAGE_DAY}\n---\n\n${BODY}`;
const ev = (when: string, what: string, kind = 'decision'): ChronicleEventProposal => ({ when, who: ['people/alice-example'], what, kind });
const proposals = (n: number, when = PAGE_DAY) => Array.from({ length: n }, (_, i) => ev(when, `Decision ${String(i + 1).padStart(2, '0')}`));

async function put(ctx: OperationContext, slug: string, content: string) {
  return operationsByName.put_page.handler(ctx, { slug, content });
}
async function settle(engine: BrainEngine) {
  await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second', decided_at=now()-interval '1 hour' WHERE state='pending'");
}
async function written(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ what: string }>(
    "SELECT frontmatter->'event'->>'what' AS what FROM pages WHERE type='event' AND deleted_at IS NULL ORDER BY what");
  return rows.map((r) => r.what);
}

describe('#5329 chronicle.max_events_per_page', () => {
  test('the knob is registered, validated and read with its default', async () => {
    expect(KNOWN_CONFIG_KEYS).toContain('chronicle.max_events_per_page');
    expect(CHRONICLE_CONFIG_KEYS).toContain('chronicle.max_events_per_page');
    expect(validateChronicleConfigValue('chronicle.max_events_per_page', '25')).toBeNull();
    expect(validateChronicleConfigValue('chronicle.max_events_per_page', '0')).toContain('Nothing was written');
    expect(validateChronicleConfigValue('chronicle.max_events_per_page', '2.5')).toContain('Nothing was written');
  });

  test('40 proposals under the default cap: 25 kept in judge order, 15 counted over_cap; undated proposals take no slot', () => {
    const ctx = chronicleJudgeContext({ slug: 'meetings/q', type: 'meeting', title: 'Q', compiled_truth: BODY, frontmatter: { date: '2026-04-18' } });
    const now = new Date('2026-10-04T12:00:00Z');
    const { kept, dropped } = screenChronicleProposals(proposals(40, '2026-04-18'), ctx, 'UTC', now, { maxEvents: 25 });
    expect(kept.map((k) => k.what)).toEqual(proposals(25).map((p) => p.what));
    expect(dropped).toEqual({ over_cap: 15 });

    // Two imprecise and one future proposal in front: dropped for their own reasons, and the 25 slots still go to dated proposals.
    const mixed = [ev('2024', 'Pilot', 'work'), ev('2026-04-19', 'Offsite', 'travel'), ev('2026-03', 'Closing', 'milestone'), ...proposals(30, '2026-04-18')];
    const screened = screenChronicleProposals(mixed, ctx, 'UTC', now, { maxEvents: 25 });
    expect(screened.kept.map((k) => k.what)).toEqual(proposals(25).map((p) => p.what));
    expect(screened.dropped).toEqual({ date_imprecise: 2, future_dated: 1, over_cap: 5 });

    // At or under the cap nothing is counted.
    expect(screenChronicleProposals(proposals(25, '2026-04-18'), ctx, 'UTC', now, { maxEvents: 25 }).dropped).toEqual({});
  });

  test('the phase writes the cap and reports the rest; one judge call', () => brain(async ({ engine, ctx }) => {
    expect((await chronicleSettings(engine)).maxEventsPerPage).toBe(25);
    await put(ctx, 'meetings/quarter', meeting());
    await settle(engine);
    let calls = 0;
    const r = await runPhaseChronicle(engine, { judge: async () => { calls++; return { events: proposals(40) }; } });
    expect(calls).toBe(1);
    expect(r.details).toMatchObject({ judged: 1, extracted: 1, events_written: 25, events_dropped: { over_cap: 15 } });
    expect(await written(engine)).toEqual(proposals(25).map((p) => p.what));
    const ledger = await engine.executeRaw<{ state: string; reason: string | null }>('SELECT state, reason FROM chronicle_page_state WHERE attempts > 0');
    expect(ledger).toEqual([{ state: 'extracted', reason: null }]);
  }), 120_000);

  test('the operator lowers the cap; the direct extractor honors it too', () => brain(async ({ engine, ctx }) => {
    await engine.setConfig('chronicle.max_events_per_page', '3');
    expect((await chronicleSettings(engine)).maxEventsPerPage).toBe(3);
    await put(ctx, 'meetings/quarter', meeting());
    const r = await runChronicleExtract(engine, { slug: 'meetings/quarter', judge: async () => ({ events: proposals(8) }) });
    expect(r).toMatchObject({ status: 'extracted', events_written: 3, events_dropped: { over_cap: 5 } });
    expect(await written(engine)).toEqual(proposals(3).map((p) => p.what));

    // A malformed stored value falls back to the default and is listed, like every other chronicle.* knob.
    await engine.setConfig('chronicle.max_events_per_page', 'many');
    const s = await chronicleSettings(engine);
    expect(s.maxEventsPerPage).toBe(25);
    expect(s.invalid).toEqual([{ key: 'chronicle.max_events_per_page', raw: 'many', fallback: 25 }]);
  }), 120_000);
});
