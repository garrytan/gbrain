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
 *  - Rust: case 3's event publication still runs the generations ledger through `executeRaw` (row L7-2), so on the
 *    Rust arm the phase judges the page through the reservation and then records the row `failed` (`publish_error`);
 *    `atGenerationsStop` pins that the first refusal is `raw_sql` at `orphanedDepthKeys`
 *    (generations/adapters/chronicle-events.ts). Delete the pin when generation-writes is on this branch.
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

/**
 * The named stop of case 3 on the Rust arm: the generations publication is typed there now (generation-writes, on
 * rust-engine/main), and the event publication's derivation edges (facts/derivation-inputs.ts, the
 * `recordDerivationEdges` member) are the first refusal, until rust-engine/derivation-inputs-rust-recut (lane 7, trunk
 * batch 11) reaches main. Delete the pin with that merge (chronicle step 6) and expect case 3 equal on Rust.
 */
const RUST_GENERATIONS_STOP = { capability: 'facts', member: 'recordDerivationEdges', frame: 'src/core/facts/derivation-inputs.ts',
  owner: 'lane 7, rust-engine/derivation-inputs-rust-recut (batch 11)', due: '5 PM PST Nov 28' };

/**
 * On the Rust arm, run `fn` and require its first capability refusal to be the pinned one: `recordDerivationEdges`
 * refused for `facts` from the pinned frame, inside a transaction of the publication (the phase catches it and retries
 * the row later, so the run itself returns). The refusal is rethrown so the harness counts the case as stopped. Any
 * other first refusal, or none, fails the case. Other arms run `fn` as is.
 */
async function atGenerationsStop<T>(engine: BrainEngine, backend: string, fn: () => Promise<T>): Promise<T> {
  if (backend !== 'rust') return fn();
  let first: { code?: unknown; stack?: unknown; message?: unknown } | undefined;
  const note = (error: unknown) => { if ((error as { code?: unknown })?.code === 'engine_capability_missing') first ??= error as never; };
  const target = engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originals = { executeRaw: target.executeRaw, transaction: target.transaction, recordDerivationEdges: target.recordDerivationEdges };
  const watch = (obj: Record<string, (...args: unknown[]) => Promise<unknown>>, name: string, self: unknown) => {
    const original = obj[name];
    if (typeof original !== 'function') return;
    obj[name] = async (...args: unknown[]) => { try { return await original.apply(self, args); } catch (error) { note(error); throw error; } };
  };
  watch(target, 'executeRaw', engine);
  watch(target, 'recordDerivationEdges', engine);
  target.transaction = (...args: unknown[]) => originals.transaction.call(engine, (tx: unknown) => (args[0] as (tx: unknown) => Promise<unknown>)(new Proxy(tx as object, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop, obj);
      if ((prop === 'recordDerivationEdges' || prop === 'executeRaw') && typeof value === 'function') {
        return async (...args: unknown[]) => { try { return await value.apply(obj, args); } catch (error) { note(error); throw error; } };
      }
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  })));
  try { await fn(); } catch (error) { note(error); first ??= error as never; } finally { Object.assign(target, originals); }
  const frame = String(first?.stack ?? '').split('\n').find(line => line.includes(RUST_GENERATIONS_STOP.frame));
  if (first?.code !== 'engine_capability_missing' || !String(first?.message ?? '').includes(RUST_GENERATIONS_STOP.member) || !frame) {
    throw new Error(`case 3 no longer stops at its pin (${JSON.stringify(RUST_GENERATIONS_STOP)}): first refusal ${String(first?.code)} ${String(first?.message ?? '').slice(0, 160)}`);
  }
  throw first;
}

  parityTest('a phase run extracts a meeting through the daily reservation', {
    methods: ['putPage', 'getPage', 'setConfig', 'readChronicleRow', 'countRecentChronicleReservations', 'reserveChronicleJudgeSlot'],
    timeout: 120_000,
  }, async (engine, backend) => atGenerationsStop(engine, backend, async () => {
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
      if (backend === 'rust') {
        // The judge ran through the reservation; the event publication then stopped, so the row retries later.
        expect({ calls, reserved: out.reserved, row: out.row?.state, reasons: (r.details as Record<string, unknown>).reasons })
          .toEqual({ calls: 1, reserved: 1, row: 'failed', reasons: { publish_error: 1 } });
        return out;
      }
      expect(out).toEqual({ calls: 1, status: 'ok', details: { extracted: 1, events_written: 1 }, row: { state: 'extracted', events: 1, hashes: 1 },
        reserved: 1, timeline: ['Alice agreed to ship the beta'] });
      return out;
    } finally { await disposePersistenceConsumer(engine); }
  }));
});
