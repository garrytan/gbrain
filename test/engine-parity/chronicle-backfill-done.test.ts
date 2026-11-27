/**
 * BrainEngine parity — the chronicle ledger on the two paths outside a page save: `chronicle-backfill --yes` and its
 * next dry run (chronicle/backfill.ts, whose page batch reads the ledger's done flag), and the cycle chronicle phase's
 * decisions (cycle/chronicle.ts, with its daily-remaining count and its reservation prune).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) chronicle_backfill --yes over two meetings, a rescue-slug note and a plain note queues the three
 *    chronicle-shaped pages as pending backfill rows (the plain note is skipped) and a second dry run reports them
 *    already done; (2) a cycle chronicle phase with a daily limit of 2 and one slot already reserved prunes the
 *    reservations (the recent one stays), extracts one meeting through the last slot, leaves no slot for the day,
 *    and defers the other meeting as pending. Every engine arm writes the same ledger rows and answers the same
 *    counts (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: on a Rust brain the backfill's page batch (store chronicle_reads.rs) answered done=false for every
 *    page, even one with an extracted or queued ledger row, so a second backfill run queued the same pages again
 *    (and paid again). The batch now reads the row at the page's content hash and extractor version.
 *  - Why existing coverage misses it: chronicle-backfill.test.ts checks dry runs only, chronicle-decision.test.ts
 *    drives page saves, and chronicle-executor.test.ts runs the phase without a prior reservation or a deferral.
 *  - Seam: a stub judge (no model call). Real engines, the backfill and phase entry points, typed reads back.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { CHRONICLE_EXTRACTOR_VERSION } from '../../src/core/chronicle/contract.ts';
import { runChronicleBackfill } from '../../src/core/chronicle/backfill.ts';
import { reserveChronicleSlot } from '../../src/core/chronicle/ledger.ts';
import { runPhaseChronicle } from '../../src/core/cycle/chronicle.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());
const today = new Date().toISOString().slice(0, 10);
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);

async function page(engine: BrainEngine, slug: string, type: string, frontmatter: Record<string, unknown> = { date: today }) {
  await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: BODY, timeline: '', frontmatter });
  const p = (await engine.getPage(slug, { sourceId: 'default' }))!;
  return { sourceId: 'default', pageId: Number(p.id), contentHash: String(p.content_hash), slug };
}

/** The ledger row of a page at its current content, without ids and times. */
async function row(engine: BrainEngine, w: { sourceId: string; pageId: number; contentHash: string }) {
  const r = await engine.readChronicleRow({ ...w, extractorVersion: CHRONICLE_EXTRACTOR_VERSION });
  return r && { state: r.state, trigger: r.trigger, reason: r.reason ?? null, events: r.event_slugs?.length ?? 0 };
}

/** A backfill result without its campaign id. */
const stable = (r: object): Record<string, unknown> => ({ ...(r as Record<string, unknown>), campaign_id: null });

describe('engine parity: the chronicle ledger outside a page save', () => {
  parityTest('chronicle-backfill --yes queues the chronicle-shaped pages as pending backfill rows, then reports them done',
    { methods: ['upsertChronicleRow', 'readChronicleRow', 'putPage', 'getPage'], timeout: 120_000 }, async (engine) => {
      try {
        const pages = [await page(engine, 'meetings/a-example', 'meeting'), await page(engine, 'meetings/b-example', 'meeting'),
          await page(engine, 'meetings/rescued-note', 'note'), await page(engine, 'notes/plain-example', 'note', {})];
        const queued = stable(await runChronicleBackfill(engine, { yes: true }));
        const again = stable(await runChronicleBackfill(engine, { dryRun: true }));
        const rows = await Promise.all(pages.map(p => row(engine, p)));
        expect({ queued: queued.queued, again: { queued: again.queued, already_done: again.already_done }, rows }).toEqual({
          queued: 3, again: { queued: 0, already_done: 3 },
          rows: [...Array(3).fill({ state: 'pending', trigger: 'backfill', reason: null, events: 0 }), null],
        });
        return { queued, again, rows };
      } finally { await disposePersistenceConsumer(engine); }
    });

  parityTest('a cycle chronicle phase prunes, counts the daily slots left, extracts one meeting and defers the other',
    { methods: ['upsertChronicleRow', 'readChronicleRow', 'pruneChronicleReservations', 'reserveChronicleJudgeSlot',
      'countRecentChronicleReservations', 'setConfig', 'putPage', 'getPage'], timeout: 120_000 }, async (engine) => {
      try {
        await engine.setConfig('chronicle.auto_settle_seconds', '0');
        await engine.setConfig('chronicle.auto_daily_limit', '2');
        await engine.setConfig('chronicle.activated_at', new Date(Date.now() - 60_000).toISOString());
        // One slot of today's two is already taken (a recent reservation the prune keeps).
        await reserveChronicleSlot(engine, 2, { sourceId: 'default', pageId: 999_999, contentHash: 'hash-earlier' });
        const a = await page(engine, 'meetings/phase-a-example', 'meeting');
        const b = await page(engine, 'meetings/phase-b-example', 'meeting');
        let calls = 0;
        const r = await runPhaseChronicle(engine, { judge: async () => {
          calls++;
          return { events: [{ when: today, who: ['people/alice-example'], what: 'Alice agreed to ship the beta', kind: 'commitment' }] } as never;
        } });
        const d = r.details as Record<string, unknown>;
        const out = {
          calls, status: r.status,
          details: { daily_limit: d.daily_limit, daily_remaining: d.daily_remaining, judged: d.judged, extracted: d.extracted,
            deferred_daily_limit: d.deferred_daily_limit, events_written: d.events_written },
          rows: [await row(engine, a), await row(engine, b)].sort((x, y) => String(x?.state).localeCompare(String(y?.state))),
          reserved: await engine.countRecentChronicleReservations(),
        };
        expect(out).toEqual({
          calls: 1, status: 'ok',
          details: { daily_limit: 2, daily_remaining: 0, judged: 1, extracted: 1, deferred_daily_limit: 1, events_written: 1 },
          rows: [{ state: 'extracted', trigger: 'auto', reason: null, events: 1 }, { state: 'pending', trigger: 'auto', reason: null, events: 0 }],
          reserved: 2,
        });
        return out;
      } finally { await disposePersistenceConsumer(engine); }
    });
});
