/**
 * BrainEngine parity — the entity card's timeline part (src/core/verbs/entity-card.ts `assembleCard`): the card's
 * `recent_event` open threads and `last_touched.last_timeline_date` come from one `getTimeline` read under the card's
 * eligibility policy.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the card shows the same timeline rows, in the same order, with the same trust tier and origin, on
 *    every engine arm, with and without a trust floor or flagged-row suppression.
 *  - Regression: the card reads the timeline fail-open. An engine that refuses the read (an eligibility option it
 *    does not serve) must refuse the whole card; a card that swallows the refusal shows no timeline, which reads as
 *    "nothing happened" and hides the gap. An engine that ignores the policy shows rows the floor hides.
 *  - Why existing coverage misses it: test/entity-card-capability-refusal.test.ts swaps one PGLite member for a
 *    refusal and never runs a real engine arm; timeline.test.ts pins getTimeline but not the card built on it.
 *  - Seam: none. Real engines, typed methods only. Row ids are written into receipts, never returned.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ReadEligibility } from '../../src/core/eligibility/policy.ts';
import { buildEntityCard } from '../../src/core/verbs/entity-card.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'people/alice-example';
/** The clock, read once so a run across midnight agrees with itself. */
const NOW = Date.now();
/** A date `days` before the run's start (UTC), so every row sits inside the card's 90-day recent-event window. */
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString().slice(0, 10);
/** The card's ISO form of that date (UTC midnight). */
const shown = (days: number) => `${daysAgo(days)}T00:00:00.000Z`;

/** Alice with one timeline row per tier (newest first: undeclared, external, agent, curated), each in its own write. */
async function seed(engine: BrainEngine) {
  await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example, a founder.', timeline: '' });
  for (const [tier, days] of [['operator_curated', 4], ['agent_written', 3], ['external_untrusted', 2]] as const) {
    await engine.transaction(async (tx) => {
      await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify({ channel: tier })]);
      await tx.addTimelineEntry(SLUG, { date: daysAgo(days), summary: tier });
    });
  }
  await engine.addTimelineEntry(SLUG, { date: daysAgo(1), summary: 'undeclared' });
}

/** The card's timeline part: its recent-event threads and the newest timeline date it shows. */
async function cardTimeline(engine: BrainEngine, eligibility?: ReadEligibility) {
  const result = await buildEntityCard(engine, 'default', 'Alice Example', { remote: false, ...(eligibility ? { eligibility } : {}) });
  if (!result.found || !result.card) throw new Error('the card did not find Alice Example');
  return {
    recent: result.card.open_threads.filter((t) => t.kind === 'recent_event'),
    last_timeline_date: result.card.last_touched.last_timeline_date,
  };
}

const summaries = (part: Awaited<ReturnType<typeof cardTimeline>>) => part.recent.map((t) => t.text);

describe('engine parity: entity card timeline', () => {
  parityTest(
    "the entity card shows the page's recent timeline rows with their trust, and a trust floor hides the rows below it",
    { methods: ['transaction', 'applyTransactionSettings', 'addTimelineEntry', 'getTimeline', 'putPage'] },
    async (engine) => {
      await seed(engine);
      const out = {
        all: await cardTimeline(engine),
        agent: await cardTimeline(engine, { floor: 'agent_written' }),
        curated: await cardTimeline(engine, { floor: 'operator_curated' }),
      };
      // The card keeps three open threads; the newest rows come first.
      expect(summaries(out.all)).toEqual(['undeclared', 'external_untrusted', 'agent_written']);
      expect(out.all.last_timeline_date).toBe(shown(1));
      expect(out.all.recent.map((t) => t.trust_tier)).toEqual(['unknown', 'external_untrusted', 'agent_written']);
      expect(summaries(out.agent)).toEqual(['agent_written', 'operator_curated']);
      expect(out.agent.last_timeline_date).toBe(shown(3));
      expect(summaries(out.curated)).toEqual(['operator_curated']);
      expect(out.curated.last_timeline_date).toBe(shown(4));
      return out;
    },
  );

  parityTest(
    'the entity card under flagged-row suppression hides a flagged agent row and keeps a flagged curated row',
    { methods: ['transaction', 'applyTransactionSettings', 'addTimelineEntry', 'getTimeline', 'putPage', 'upsertWriteGateReceipt'] },
    async (engine) => {
      await seed(engine);
      // Receipt targets need the row ids; they are written, never returned or compared.
      for (const row of await engine.getTimeline(SLUG)) {
        if (row.summary !== 'agent_written' && row.summary !== 'operator_curated') continue;
        await engine.upsertWriteGateReceipt({
          target_table: 'timeline_entries', target_id: String(row.id), source_id: 'default',
          content_hash: 'h1', tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: ['override'],
          reasons: ['override'], detector_error: false, request_id: null,
        });
      }
      const out = {
        suppressed: await cardTimeline(engine, { suppressFlagged: true }),
        flooredSuppressed: await cardTimeline(engine, { floor: 'agent_written', suppressFlagged: true }),
      };
      expect(summaries(out.suppressed)).toEqual(['undeclared', 'external_untrusted', 'operator_curated']);
      expect(summaries(out.flooredSuppressed)).toEqual(['operator_curated']);
      expect(out.flooredSuppressed.last_timeline_date).toBe(shown(4));
      return out;
    },
  );
});
