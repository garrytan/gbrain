/**
 * PR 3 of "nightly learning you can see": the owner-contact enrich order, its
 * default for the enrich_thin phase, and the phase's daily caps. Repo-less
 * brains on PGLite, and on Postgres when DATABASE_URL is set.
 *
 * 1. Protects: listEnrichCandidates' owner-contact ranking (recent meetings,
 *    conversations, email and chronicle events that link to or mention the
 *    page, open loops, one hop from the owner's page, divided by fullness),
 *    the phase's default order (owner-contact only when the owner resolves),
 *    the keyless run (ranks, spends nothing), the daily cost and page caps
 *    across every run in the owner's day, and the Rust store's refusal.
 * 2. Fails when: a page with many old links outranks a page the owner met
 *    this week, an owner conflict or a missing owner page still picks
 *    owner-contact, an explicit order is overridden, a keyless run calls the
 *    enrich core or writes spend, a day of hourly runs spends past either
 *    daily cap, or the Rust store answers owner-contact with another order.
 * 3. Existing coverage: test/salience-enrich-parity.test.ts pins the other
 *    three orders; test/enrich-cycle-phase.test.ts pins the per-tick caps.
 * 4. Real seams: the engines' listEnrichCandidates, runPhaseEnrichThin with
 *    its enrichCore and clock seams, runEnrich's dry-run output, the Rust
 *    store member.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { EnrichCandidatesOpts } from '../src/core/types.ts';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';
import { resolveOwnerContactAnchor } from '../src/core/enrich/owner-contact.ts';
import { ENRICH_THIN_DAILY_SPEND_KEY, readEnrichThinDailySpend, runPhaseEnrichThin } from '../src/core/cycle/enrich-thin.ts';
import { runEnrich, type EnrichCoreOpts, type EnrichResult } from '../src/commands/enrich.ts';
import { listEnrichCandidates as rustListEnrichCandidates } from '../src/core/rust-engine/store-members/stats.ts';
import type { StoreBrain } from '../src/core/rust-engine/store.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const OWNER_MAIL = 'owner@example.com';

function emptyResult(over: Partial<EnrichResult> = {}): EnrichResult {
  return {
    candidates_considered: 0, pages_enriched: 0, pages_skipped_insufficient: 0,
    pages_skipped_lock: 0, pages_skipped_disappeared: 0, pages_failed: 0, ...over,
  };
}

for (const kind of testBackends()) {
  describe(`owner-contact enrich order (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const raw = (sql: string, params?: unknown[]) => engine.executeRaw<Record<string, unknown>>(sql, params);

    /** A page whose evidence date is daysAgo days back (effective_date). */
    const page = async (slug: string, type: string, body = 'Stub.', daysAgo?: number, frontmatter: Record<string, unknown> = {}) => {
      await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: body, timeline: '', frontmatter } as never);
      if (daysAgo !== undefined) {
        await raw(`UPDATE pages SET effective_date = now() - ($1::text || ' days')::interval WHERE slug = $2`, [String(daysAgo), slug]);
      }
    };
    const link = (from: string, to: string, linkSource?: string) => engine.addLink(from, to, '', '', linkSource);
    const ranked = async (opts: Partial<EnrichCandidatesOpts>) => (await engine.listEnrichCandidates({
      types: ['person'], thinThreshold: 500, order: 'owner-contact', limit: 50, ...opts,
    })).map((c) => c.slug);

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1, { collation: 'C' }));
      else { const pg = new PGLiteEngine(); await pg.connect({ engine: 'pglite' } as never); await pg.initSchema(); engine = pg; close = () => pg.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    beforeEach(async () => {
      for (const sql of [
        'DELETE FROM open_loops', 'DELETE FROM links',
        'DELETE FROM access_member_links', 'DELETE FROM access_member_sources', 'DELETE FROM access_group_members', 'DELETE FROM access_members',
        'DELETE FROM pages', "DELETE FROM sources WHERE id <> 'default'",
        "DELETE FROM config WHERE key LIKE 'cycle.enrich_thin.%' OR key IN ('access.owner_member', 'brain.timezone', 'enrich_thin.daily_spend')",
      ]) await raw(sql);
    });
    afterEach(() => { resetGateway(); });

    /** alice-example: three meetings this week. bob-example: 200 inbound links from meetings two years old. */
    const seedAliceAndBob = async () => {
      await page('people/alice-example', 'person');
      await page('people/bob-example', 'person');
      for (const d of [1, 3, 6]) {
        await page(`meetings/standup-${d}`, 'meeting', 'Met alice-example.', d);
        await link(`meetings/standup-${d}`, 'people/alice-example');
      }
      await raw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, effective_date)
        SELECT 'default', 'meetings/old-' || g, 'meeting', 'Old ' || g, 'x', now() - interval '730 days' FROM generate_series(1, 200) g`);
      await raw(`INSERT INTO links (from_page_id, to_page_id, link_type)
        SELECT o.id, b.id, '' FROM pages o, pages b WHERE o.slug LIKE 'meetings/old-%' AND b.slug = 'people/bob-example'`);
    };

    test('a thin page with three meetings this week beats one with 200 old inbound links', async () => {
      await seedAliceAndBob();
      expect(await ranked({})).toEqual(['people/alice-example', 'people/bob-example']);
      expect(await ranked({ order: 'inbound-links' })).toEqual(['people/bob-example', 'people/alice-example']);
      const [bob] = (await engine.listEnrichCandidates({ types: ['person'], thinThreshold: 500, order: 'owner-contact', limit: 50 }))
        .filter((c) => c.slug === 'people/bob-example');
      expect(bob!.inbound_count).toBe(200);
    });

    test('evidence types, the 90-day window, mentions, open loops, the owner hop and fullness each move the rank', async () => {
      await page('memory/owner', 'person', 'The owner.');
      for (const slug of ['carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy']) await page(`people/${slug}-example`, 'person');
      await raw(`UPDATE pages SET compiled_truth = repeat('y', 400) WHERE slug = 'people/grace-example'`);
      // carol: an open loop with her. dave: linked from the owner's page.
      await raw(`INSERT INTO open_loops (source_id, dedup_key, loop_type, counterparty_slug, summary, detector)
        VALUES ('default', 'k1', 'commitment_owed_to_me', 'people/carol-example', 'Send the deck', 'manual')`);
      await link('memory/owner', 'people/dave-example');
      // frank and grace: one meeting today each; grace's page is fuller.
      await page('meetings/today', 'meeting', 'x', 0);
      await link('meetings/today', 'people/frank-example');
      await link('meetings/today', 'people/grace-example');
      // heidi: an auto-linked mention from a conversation. ivan: a chronicle event and an email thread.
      await page('conversations/chat', 'conversation', 'x', 10);
      await link('conversations/chat', 'people/heidi-example', 'mentions');
      await page('life/events/dinner', 'event', 'x', 20);
      await page('email/thread-1', 'email', 'x', 30);
      await link('life/events/dinner', 'people/ivan-example');
      await link('email/thread-1', 'people/ivan-example');
      // judy: only a 100-day-old meeting and a recent non-interaction note, so nothing counts.
      await page('meetings/long-ago', 'meeting', 'x', 100);
      await page('notes/recent', 'note', 'x', 1);
      await link('meetings/long-ago', 'people/judy-example');
      await link('notes/recent', 'people/judy-example');

      const withOwner = await ranked({ ownerSlug: 'memory/owner', ownerSourceId: 'default' });
      const idx = (slug: string) => withOwner.indexOf(`people/${slug}-example`);
      expect(idx('ivan')).toBeLessThan(idx('frank'));
      expect(idx('frank')).toBeLessThan(idx('grace'));
      for (const close of ['carol', 'dave', 'frank', 'grace', 'heidi', 'ivan']) expect(idx(close)).toBeLessThan(idx('erin'));
      // judy has two inbound links and no counted evidence: she leads the zero-score tail on inbound links,
      // then the tail sorts by source and slug.
      expect(withOwner.slice(-3)).toEqual(['people/judy-example', 'memory/owner', 'people/erin-example']);

      // Without the owner page, dave's hop point is gone and he ties erin on score 0.
      const noOwner = await ranked({});
      expect(noOwner.indexOf('people/dave-example')).toBeGreaterThan(noOwner.indexOf('people/heidi-example'));
      expect(noOwner.indexOf('people/carol-example')).toBeLessThan(noOwner.indexOf('people/dave-example'));
    });

    test('the owner resolves only without a conflict and with a live page; the phase default follows it', async () => {
      await seedAliceAndBob();
      await engine.setConfig('cycle.enrich_thin.enabled', 'true');
      const phaseOrder = async () => {
        const r = await runPhaseEnrichThin(engine, { dryRun: true });
        return { order: r.details.order, reason: r.details.order_reason };
      };

      expect(await resolveOwnerContactAnchor(engine)).toEqual({ owner: null, reason: 'no_owner_page' });
      expect(await phaseOrder()).toEqual({ order: 'inbound-links', reason: 'no_owner_page' });

      await page('memory/owner', 'person', 'The owner.');
      expect(await resolveOwnerContactAnchor(engine)).toEqual({ owner: { slug: 'memory/owner', source_id: 'default' } });
      expect(await phaseOrder()).toEqual({ order: 'owner-contact', reason: 'owner_resolved' });
      const run = await runPhaseEnrichThin(engine, { dryRun: true });
      const perSource = run.details.per_source as Record<string, EnrichResult>;
      expect(perSource.default!.candidate_slugs!.slice(0, 2)).toEqual(['people/alice-example', 'people/bob-example']);

      // An explicit order wins over the default.
      await engine.setConfig('cycle.enrich_thin.order', 'updated');
      expect(await phaseOrder()).toEqual({ order: 'updated', reason: 'configured' });
      await engine.unsetConfig('cycle.enrich_thin.order');

      // Two person pages carrying the owner's mailbox address: a conflict, so inbound-links.
      await raw("INSERT INTO sources (id, name, config) VALUES ('mail-a', 'mail-a', jsonb_build_object('kind', 'google', 'g_account', $1::text))", [OWNER_MAIL]);
      for (const slug of ['people/owner-example', 'people/owner-example-work']) await page(slug, 'person', 'A person.', undefined, { email: OWNER_MAIL });
      expect(await resolveOwnerContactAnchor(engine)).toEqual({ owner: null, reason: 'owner_conflict' });
      expect(await phaseOrder()).toEqual({ order: 'inbound-links', reason: 'owner_conflict' });

      // An engine with no raw SQL (the Rust engine) cannot list candidates in any order, so the phase skips before any SQL.
      await engine.unsetConfig('cycle.enrich_thin.order');
      await raw("DELETE FROM pages WHERE slug LIKE 'people/owner-example%'");
      expect(await resolveOwnerContactAnchor(engine)).toEqual({ owner: { slug: 'memory/owner', source_id: 'default' } });
      const noSql = new Proxy(engine, { get: (t, p) => p === 'capabilities' ? new Set([...t.capabilities].filter(c => c !== 'raw_sql'))
        : p === 'executeRaw' ? () => { throw new Error('no raw SQL on this engine'); }
        : (v => typeof v === 'function' ? v.bind(t) : v)(Reflect.get(t, p)) }) as typeof engine;
      for (const set of [null, 'owner-contact']) {
        if (set) await engine.setConfig('cycle.enrich_thin.order', set); else await engine.unsetConfig('cycle.enrich_thin.order');
        const noSqlRun = await runPhaseEnrichThin(noSql, { dryRun: true });
        expect({ status: noSqlRun.status, reason: noSqlRun.details.reason }).toEqual({ status: 'skipped', reason: 'engine_capability_missing' });
      }

      // Explicit owner-contact still wins when the owner does not resolve.
      await engine.setConfig('cycle.enrich_thin.order', 'owner-contact');
      expect(await phaseOrder()).toEqual({ order: 'owner-contact', reason: 'configured' });
    });

    test('keyless: the run calls no enrich core and records no spend; dry-run still ranks', async () => {
      await seedAliceAndBob();
      await page('memory/owner', 'person', 'The owner.');
      await engine.setConfig('cycle.enrich_thin.enabled', 'true');
      resetGateway();
      let calls = 0;
      const enrichCore = async () => { calls++; return emptyResult({ spent_usd: 1 }); };

      const live = await runPhaseEnrichThin(engine, { enrichCore });
      expect(live.status).toBe('skipped');
      expect(live.details).toMatchObject({ reason: 'no_chat_gateway', order: 'owner-contact', spent_usd: 0 });
      expect(calls).toBe(0);
      expect(await engine.getConfig(ENRICH_THIN_DAILY_SPEND_KEY)).toBeNull();

      const dry = await runPhaseEnrichThin(engine, { dryRun: true });
      expect(dry.status).toBe('ok');
      expect(dry.details.spent_usd).toBe(0);
      expect((dry.details.per_source as Record<string, EnrichResult>).default!.candidate_slugs![0]).toBe('people/alice-example');
      expect(await engine.getConfig(ENRICH_THIN_DAILY_SPEND_KEY)).toBeNull();
    });

    test('gbrain enrich --thin --dry-run prints the order and the ranked candidates', async () => {
      await seedAliceAndBob();
      resetGateway();
      const lines: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
      try {
        await runEnrich(engine, ['--thin', '--dry-run', '--order', 'owner-contact', '--source', 'default']);
      } finally {
        console.log = log;
      }
      const out = lines.join('\n');
      expect(out).toContain('(dry run) order: owner-contact');
      expect(out).toContain('default: people/alice-example, people/bob-example');
    });

    test('24 hourly runs in one owner day stay at or under both daily caps, and the next day starts fresh', async () => {
      await raw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a')");
      for (const [k, v] of Object.entries({
        'cycle.enrich_thin.enabled': 'true', 'cycle.enrich_thin.max_daily_cost_usd': '0.50', 'cycle.enrich_thin.max_daily_pages': '5',
        'cycle.enrich_thin.max_cost_usd': '0.30', 'cycle.enrich_thin.max_pages_per_tick': '3', 'brain.timezone': 'America/Los_Angeles',
      })) await engine.setConfig(k, v);
      __setChatTransportForTests(async () => { throw new Error('the enrich core is stubbed; no chat call expected'); });
      const calls: EnrichCoreOpts[] = [];
      // Spends every cent and every page it is allowed, the worst case for the caps.
      const enrichCore = async (_e: BrainEngine, o: EnrichCoreOpts) => {
        calls.push(o);
        return emptyResult({ pages_enriched: o.limit ?? 0, spent_usd: o.maxCostUsd ?? 0 });
      };
      // 00:10 PDT on 2026-03-10, then every 55 minutes: 24 runs to 21:15 PDT, across two UTC dates.
      const start = Date.parse('2026-03-10T07:10:00Z');
      const statuses: string[] = [];
      for (let i = 0; i < 24; i++) {
        const r = await runPhaseEnrichThin(engine, { enrichCore, now: () => new Date(start + i * 55 * 60_000) });
        statuses.push(r.status === 'skipped' ? String(r.details.reason) : r.status);
      }
      const spent = calls.reduce((s, c) => s + (c.maxCostUsd ?? 0), 0);
      const pages = calls.reduce((s, c) => s + (c.limit ?? 0), 0);
      expect(spent).toBeGreaterThan(0);
      expect(spent).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(pages).toBeLessThanOrEqual(5);
      expect(calls.map((c) => c.sourceId)).toEqual(['default', 'source-a']);
      expect(statuses[0]).toBe('ok');
      expect(statuses.slice(1).every((s) => s === 'daily_cap_reached')).toBe(true);
      expect(await readEnrichThinDailySpend(engine, '2026-03-10')).toEqual({ day: '2026-03-10', spent_usd: 0.5, pages: 5 });

      // 01:00 PDT on 2026-03-11: a new owner day.
      const next = await runPhaseEnrichThin(engine, { enrichCore, now: () => new Date('2026-03-11T08:00:00Z') });
      expect(next.status).toBe('ok');
      expect(calls.length).toBe(4);
      expect((next.details.daily as { day: string }).day).toBe('2026-03-11');
    });

    test('a daily cap set to something that is not a number spends nothing', async () => {
      for (const [k, v] of Object.entries({ 'cycle.enrich_thin.enabled': 'true', 'cycle.enrich_thin.max_daily_cost_usd': '$5' })) await engine.setConfig(k, v);
      __setChatTransportForTests(async () => { throw new Error('unused'); });
      let calls = 0;
      const enrichCore = async () => { calls++; return emptyResult({ spent_usd: 1 }); };
      const r = await runPhaseEnrichThin(engine, { enrichCore, now: () => new Date('2026-03-10T12:00:00Z') });
      expect({ status: r.status, reason: r.details.reason, keys: r.details.keys }).toEqual({ status: 'skipped', reason: 'daily_cap_invalid', keys: ['cycle.enrich_thin.max_daily_cost_usd'] });
      expect(calls).toBe(0);
    });

    test('a source that dies mid-run stays charged its full cap for the day', async () => {
      for (const [k, v] of Object.entries({
        'cycle.enrich_thin.enabled': 'true', 'cycle.enrich_thin.max_daily_cost_usd': '0.50', 'cycle.enrich_thin.max_cost_usd': '0.20',
      })) await engine.setConfig(k, v);
      __setChatTransportForTests(async () => { throw new Error('unused'); });
      const now = () => new Date('2026-03-10T12:00:00Z');
      const dies = async (): Promise<EnrichResult> => { throw new Error('worker lost'); };
      const r = await runPhaseEnrichThin(engine, { enrichCore: dies, now });
      expect(r.status).toBe('warn');
      expect(await readEnrichThinDailySpend(engine, '2026-03-10')).toEqual({ day: '2026-03-10', spent_usd: 0.2, pages: 3 });
    });
  });
}

describe('Rust engine store', () => {
  test('refuses owner-contact with engine_capability_missing and never asks the store', async () => {
    let asked = false;
    const brain = { listEnrichCandidates: async () => { asked = true; return []; } } as unknown as StoreBrain;
    const err = await rustListEnrichCandidates(brain, { types: ['person'], thinThreshold: 500, order: 'owner-contact', limit: 5, ownerSlug: 'memory/owner', ownerSourceId: 'default' })
      .then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err?.code).toBe('engine_capability_missing');
    expect(err?.message).toContain('owner-contact');
    expect(asked).toBe(false);
  });
});
