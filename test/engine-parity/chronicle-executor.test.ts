/**
 * Engine parity for the chronicle executor (chronicle/execute.ts, chronicle/campaign.ts, cycle/chronicle.ts): the
 * ledger claim, the exhausted-campaign sweep and a judged phase run answer the same on every engine.
 *
 * Fail-first: on rust-engine/chronicle-decision-rust 2d1ee9e0d2 every case fails: no engine has `chronicleStore()`
 * (cases 1 and 2 call it; case 3's phase housekeeping stopped on the Rust arm on the raw_sql refusal of `executeRaw`
 * in campaign.ts before it reached any generations frame).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) a claim leases a pending row once: the first claim answers the row with a lease in the future and
 *    no attempt consumed, a second claim answers null. (2) a campaign row with one attempt: the claim consumes it, a
 *    second claim answers null, the exhausted sweep leaves the row alone while its lease runs, and once the lease ends
 *    (the executor died) the sweep fails it as `campaign_exhausted`. (3) a chronicle phase run on an unmanaged brain with an
 *    injected judge extracts a meeting changed since activation: one judge call through the daily reservation, one
 *    event written, the ledger row extracted with one event slug and hash, the reservation counted, and the event on
 *    the timeline of its day.
 *  - Regression: each step ran raw SQL, so on Rust the phase failed on its housekeeping and no chronicle event was ever
 *    extracted.
 *  - Why existing coverage misses it: test/chronicle-*.test.ts run on PGLite and Postgres only.
 *  - Rust: all three cases run to the end on the Rust arm and compare equal: the generations ledger and the derivation
 *    edges of an event publication are typed members there (generation-writes and derivation-inputs-rust-recut).
 *  - Seam: an injected judge (no provider call). Real engines otherwise.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { CHRONICLE_EXTRACTOR_VERSION } from '../../src/core/chronicle/contract.ts';
import { claimChronicleRow } from '../../src/core/chronicle/execute.ts';
import { failExhaustedCampaignRows, queueCampaignRow } from '../../src/core/chronicle/campaign.ts';
import { runPhaseChronicle } from '../../src/core/cycle/chronicle.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());
const today = new Date().toISOString().slice(0, 10);
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);

async function meeting(engine: BrainEngine, slug: string) {
  await engine.putPage(slug, { type: 'meeting', title: 'Launch review', compiled_truth: BODY, frontmatter: { date: today } } as never);
  const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
  return { sourceId: 'default', pageId: Number(page.id), contentHash: String(page.content_hash), slug };
}

describe('engine parity: the chronicle executor', () => {
  parityTest('a claim leases a pending row once', {
    methods: ['putPage', 'getPage', 'upsertChronicleRow', 'readChronicleRow', 'chronicleStore'],
  }, async (engine) => {
    const w = await meeting(engine, 'meetings/claim-example');
    await engine.upsertChronicleRow({ ...w, extractorVersion: CHRONICLE_EXTRACTOR_VERSION, state: 'pending', reason: null, trigger: 'auto',
      principalKind: null, principalId: null, requestId: null, noExtract: false, nextAttemptAt: null });
    const row = (await engine.readChronicleRow({ ...w, extractorVersion: CHRONICLE_EXTRACTOR_VERSION }))!;
    const first = await claimChronicleRow(engine, row);
    const second = await claimChronicleRow(engine, row);
    const out = { claimed: first !== null, attempts: first?.attempts ?? null, leased: first?.next_attempt_at != null
      && new Date(first.next_attempt_at).getTime() > Date.now(), second };
    expect(out).toEqual({ claimed: true, attempts: 0, leased: true, second: null });
    return out;
  });

  parityTest('a campaign row whose attempts a crashed executor used fails as campaign_exhausted once its lease ends', {
    methods: ['putPage', 'getPage', 'readChronicleRow', 'chronicleStore'],
  }, async (engine) => {
    const w = await meeting(engine, 'meetings/campaign-example');
    const key = { ...w, extractorVersion: CHRONICLE_EXTRACTOR_VERSION };
    const queued = await queueCampaignRow(engine, w, { campaignId: randomUUID(), attemptCapUsd: 0.5, maxAttempts: 1, maxUsd: 5 } as never);
    const row = (await engine.readChronicleRow(key))!;
    // The claim consumes the campaign's only attempt; the executor then dies before it records an outcome.
    const claim = await claimChronicleRow(engine, row);
    const again = await claimChronicleRow(engine, { ...row, next_attempt_at: null } as never);
    await failExhaustedCampaignRows(engine);
    const leased = (await engine.readChronicleRow(key))!;
    // The lease ends: the executor that claimed the row died, so its next attempt is due now.
    await (await engine.chronicleStore()).setNextAttempt([w.sourceId, w.pageId, w.contentHash, CHRONICLE_EXTRACTOR_VERSION], new Date(Date.now() - 1000).toISOString());
    await failExhaustedCampaignRows(engine);
    const after = (await engine.readChronicleRow(key))!;
    const out = { queued, before: { state: row.state, trigger: row.trigger, campaign: row.campaign_id != null, attempts: row.attempts },
      claimedAttempts: claim?.attempts ?? null, again, whileLeased: leased.state,
      after: { state: after.state, reason: after.reason, next: after.next_attempt_at } };
    expect(out).toEqual({ queued: true, before: { state: 'pending', trigger: 'backfill', campaign: true, attempts: 0 },
      claimedAttempts: 1, again: null, whileLeased: 'pending', after: { state: 'failed', reason: 'campaign_exhausted', next: null } });
    return out;
  });

  parityTest('a phase run extracts a meeting through the daily reservation', {
    methods: ['putPage', 'getPage', 'setConfig', 'readChronicleRow', 'countRecentChronicleReservations', 'reserveChronicleJudgeSlot'],
    timeout: 120_000,
  }, async (engine) => {
    try {
      await engine.setConfig('chronicle.auto_settle_seconds', '0');
      await engine.setConfig('chronicle.activated_at', new Date(Date.now() - 60_000).toISOString());
      const w = await meeting(engine, 'meetings/phase-example');
      let calls = 0;
      const r = await runPhaseChronicle(engine, { judge: async () => {
        calls++;
        return { events: [{ when: today, who: ['people/alice-example'], what: 'Alice agreed to ship the beta', kind: 'commitment' }] } as never;
      } });
      const row = await engine.readChronicleRow({ ...w, extractorVersion: CHRONICLE_EXTRACTOR_VERSION });
      const out = {
        calls, status: r.status,
        details: { extracted: (r.details as Record<string, unknown>).extracted, events_written: (r.details as Record<string, unknown>).events_written },
        row: row && { state: row.state, events: row.event_slugs?.length ?? 0, hashes: row.event_hashes?.length ?? 0 },
        reserved: await engine.countRecentChronicleReservations(),
        timeline: (await engine.getTimelineForDate(today, {})).map((t) => t.summary),
      };
      expect(out).toEqual({ calls: 1, status: 'ok', details: { extracted: 1, events_written: 1 }, row: { state: 'extracted', events: 1, hashes: 1 },
        reserved: 1, timeline: ['Alice agreed to ship the beta'] });
      return out;
    } finally { await disposePersistenceConsumer(engine); }
  });
});
