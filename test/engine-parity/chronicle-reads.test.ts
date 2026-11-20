/**
 * Engine parity for the chronicle reads that `chronicle_backfill` and the advisor reach: the backfill page batch, the
 * `--max-usd` campaign queue and its spend, the advisor's coverage-gap scan, and the ledger rollup behind
 * `auto_chronicle_default_on` (engine-sql/chronicle-reads.ts, engine-sql/doctor-acc.ts).
 *
 * Fail-first: on rust-engine/chronicle-decision-rust 3ac6224f3b every case fails on the Rust arm. The backfill batch,
 * the campaign queue, the campaign spend and the coverage-gap scan were `executeRaw` calls, which the Rust engine
 * refuses (`engine_capability_missing`, detail `member=executeRaw capability=raw_sql outcome=none written=nothing`),
 * and the ledger rollup refused the same way inside the advisor's try/catch, so the advisor dropped every chronicle
 * finding. Cases 4 and 5 also fail on every arm there (the members did not exist). Lane 14's 67d1bc5b3e answered the
 * rollup on Rust with a constant (an empty ledger, available); case 5 fails on that constant, since its ledger is not
 * empty.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) chronicle_backfill --dry-run over seeded meeting, conversation, calendar, rescue-slug and note pages
 *    reports the same counts, skips and estimate, and queues nothing; (2) --yes queues the eligible pages as backfill
 *    rows, and a second dry run reports them already done; the source-scoped, unscoped and `since` scans agree; (3)
 *    --max-usd with a priced model queues what fits, stamps each row with the campaign, and reports spend 0; (4) the
 *    campaign queue member: a fresh key queues, a queued key refuses, an automatic pending row is taken over, current
 *    extracted content refuses; (5) the ledger rollup over seeded automatic rows (pending, extracted, skipped and failed
 *    with reasons); (6) the advisor's chronicle findings: auto_chronicle_default_on with the rollup's activity line,
 *    and the coverage gap of recent undated or recently dated pages, without the old dated meeting.
 *  - Regression: each statement above ran raw SQL; the Rust engine refuses raw SQL, so chronicle_backfill refused on
 *    Rust and the advisor's chronicle findings disappeared.
 *  - Why existing coverage misses it: test/chronicle-*.test.ts and test/advisor-*.test.ts run on PGLite and Postgres
 *    only; the MCP census compared the tools on an empty ledger.
 *  - Seam: none. Real engines and the chronicle_backfill/advisor operation handlers; ledger rows are seeded through
 *    lane 7's upsertChronicleRow member.
 */
import { describe, expect, test } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { CHRONICLE_DEFAULTS, CHRONICLE_EXTRACTOR_VERSION } from '../../src/core/chronicle/contract.ts';
import { CHRONICLE_BACKFILL_BATCH, CHRONICLE_BACKFILL_BATCH_SQL, readChronicleBackfillBatch } from '../../src/core/engine-sql/chronicle-reads.ts';
import { runChronicleBackfill } from '../../src/core/chronicle/backfill.ts';
import { readChronicleLedgerStats } from '../../src/core/chronicle/ledger-stats.ts';
import { operations } from '../../src/core/operations.ts';

const { parityTest } = parityArms(testBackends());

const MODEL = 'anthropic:claude-sonnet-4-6';
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta release. '.repeat(3);
const today = new Date().toISOString().slice(0, 10);

const ctxFor = (engine: BrainEngine) => ({ engine, sourceId: 'default', remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } });
const op = (engine: BrainEngine, name: string, params: Record<string, unknown>) =>
  operations.find(o => o.name === name)!.handler(ctxFor(engine) as never, params) as Promise<Record<string, unknown>>;

/** Pages of every shape the backfill scan sees: typed chronicle pages, a rescue slug, a note, an old meeting. */
async function seedPages(engine: BrainEngine): Promise<void> {
  const page = (slug: string, type: string, frontmatter: Record<string, unknown> = {}) =>
    engine.putPage(slug, { type: type as never, title: slug, compiled_truth: BODY, frontmatter });
  await page('meetings/sync-example', 'meeting', { date: today });
  await page('meetings/old-example', 'meeting', { date: '2020-01-02' });
  await page('conversations/conv-example', 'conversation');
  await page('cal/standup-example', 'calendar-event', { start: `${today}T09:00:00Z` });
  await page('meetings/rescued-note', 'note', { date: today });
  await page('notes/plain-example', 'note');
}

const pageId = async (engine: BrainEngine, slug: string) => Number((await engine.getPage(slug))!.id);
const contentHash = async (engine: BrainEngine, slug: string) => String((await engine.getPage(slug))!.content_hash);

/** A backfill result without its campaign id (a fresh uuid per run). */
const stable = (r: Record<string, unknown>) => ({ ...r, campaign_id: r.campaign_id == null ? null : 'campaign' });

/** The row's state and stamp, the amounts as numbers (numeric text differs only in spelling across drivers). */
async function stampOf(engine: BrainEngine, slug: string) {
  const row = await engine.readChronicleRow({ sourceId: 'default', pageId: await pageId(engine, slug),
    contentHash: await contentHash(engine, slug), extractorVersion: CHRONICLE_EXTRACTOR_VERSION });
  if (!row) return null;
  return { state: row.state, trigger: row.trigger, attempts: Number(row.attempts), campaign: row.campaign_id != null,
    attempt_cap_usd: row.attempt_cap_usd == null ? null : Number(row.attempt_cap_usd), max_attempts: row.max_attempts,
    pricing_policy: row.pricing_policy, campaign_max_usd: row.campaign_max_usd == null ? null : Number(row.campaign_max_usd) };
}

describe('chronicle reads on every engine', () => {
  parityTest('chronicle_backfill --dry-run over seeded pages reports the same candidates and queues nothing', { methods: ['readChronicleBackfillBatch', 'readChronicleRow', 'getPage'] }, async (engine) => {
    await seedPages(engine);
    const dry = await op(engine, 'chronicle_backfill', { dry_run: true });
    expect(dry).toMatchObject({ dry_run: true, scanned: 5, eligible: 5, queued: 5, already_done: 0, ask_user: true });
    return { dry, row: await stampOf(engine, 'meetings/sync-example') };
  });

  parityTest('chronicle_backfill --yes queues the eligible pages, then a dry run reports them done; every scope agrees', { methods: ['readChronicleBackfillBatch', 'upsertChronicleRow', 'readChronicleRow', 'getPage'] }, async (engine) => {
    await seedPages(engine);
    const queued = await op(engine, 'chronicle_backfill', { yes: true });
    const again = await op(engine, 'chronicle_backfill', { dry_run: true });
    const unscoped = await runChronicleBackfill(engine, { dryRun: true });
    const listed = await runChronicleBackfill(engine, { dryRun: true, sourceIds: ['default'] });
    const since = await runChronicleBackfill(engine, { dryRun: true, since: '2999-01-01' });
    const recent = await runChronicleBackfill(engine, { dryRun: true, since: today, recent: true });
    expect(queued).toMatchObject({ queued: 5, ask_user: false });
    expect(again).toMatchObject({ queued: 0, already_done: 5 });
    expect(since).toMatchObject({ scanned: 0 });
    return { queued, again, unscoped, listed, since, recent,
      rows: { sync: await stampOf(engine, 'meetings/sync-example'), note: await stampOf(engine, 'notes/plain-example') } };
  });

  parityTest('chronicle_backfill --max-usd with a priced model queues what fits and stamps the campaign', { methods: ['readChronicleBackfillBatch', 'queueChronicleCampaignRow', 'readChronicleCampaignSpentUsd', 'readChronicleRow', 'getPage'] }, async (engine) => {
    await seedPages(engine);
    const unit = (await runChronicleBackfill(engine, { dryRun: true, model: MODEL, maxUsd: 1000 })).per_page_worst_case_usd!;
    const run = await runChronicleBackfill(engine, { yes: true, model: MODEL, maxUsd: unit * 2.5 });
    expect(run).toMatchObject({ queued: 2, cap_reached: true, spent_usd: 0 });
    expect(run.campaign_id).toEqual(expect.any(String));
    const spent = await engine.readChronicleCampaignSpentUsd(run.campaign_id!);
    const other = await engine.readChronicleCampaignSpentUsd('00000000-0000-4000-8000-000000000000');
    return { unit, run: stable(run as never), spent, other,
      rows: await Promise.all(['cal/standup-example', 'conversations/conv-example', 'meetings/sync-example'].map(s => stampOf(engine, s))) };
  });

  parityTest('the campaign queue member: a fresh key queues, a queued key refuses, an automatic row is taken over, extracted content refuses', { methods: ['queueChronicleCampaignRow', 'upsertChronicleRow', 'readChronicleRow', 'getPage'] }, async (engine) => {
    await seedPages(engine);
    const key = async (slug: string) => ({ sourceId: 'default', pageId: await pageId(engine, slug), contentHash: await contentHash(engine, slug),
      extractorVersion: CHRONICLE_EXTRACTOR_VERSION, slug });
    const stamp = { campaignId: '11111111-1111-4111-8111-111111111111', attemptCapUsd: 0.25, maxAttempts: 3, pricingPolicy: 'enforced',
      maxUsd: 12.5, defaultMaxAttempts: 5 };
    const decision = (k: Awaited<ReturnType<typeof key>>, state: string, trigger: string) => engine.upsertChronicleRow({ ...k, state, reason: null,
      trigger, principalKind: null, principalId: null, requestId: null, noExtract: false, nextAttemptAt: null });
    const fresh = await engine.queueChronicleCampaignRow({ ...await key('meetings/sync-example'), ...stamp });
    const twice = await engine.queueChronicleCampaignRow({ ...await key('meetings/sync-example'), ...stamp });
    const conv = await key('conversations/conv-example');
    await decision(conv, 'pending', 'auto');
    const takeover = await engine.queueChronicleCampaignRow({ ...conv, ...stamp });
    const cal = await key('cal/standup-example');
    await decision(cal, 'extracted', 'auto');
    const extracted = await engine.queueChronicleCampaignRow({ ...cal, ...stamp });
    expect({ fresh, twice, takeover, extracted }).toEqual({ fresh: true, twice: false, takeover: true, extracted: false });
    // A page that does not exist fails as the foreign key fails on Postgres, and writes nothing.
    const missing = await engine.queueChronicleCampaignRow({ ...conv, pageId: conv.pageId + 1000, ...stamp })
      .then(() => null, (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }));
    expect(missing).toEqual({ code: '23503', message: expect.stringContaining('"chronicle_page_state_page_id_fkey"') });
    return { fresh, twice, takeover, extracted, missing,
      rows: await Promise.all(['meetings/sync-example', 'conversations/conv-example', 'cal/standup-example'].map(s => stampOf(engine, s))) };
  });

  parityTest('the ledger rollup over seeded automatic rows: pending, extracted, skipped and failed with their reasons', { methods: ['readChronicleLedgerStats', 'upsertChronicleRow', 'getPage'] }, async (engine) => {
    await seedPages(engine);
    const seed = async (slug: string, state: string, reason: string | null, trigger = 'auto') => engine.upsertChronicleRow({ sourceId: 'default',
      pageId: await pageId(engine, slug), contentHash: await contentHash(engine, slug), extractorVersion: CHRONICLE_EXTRACTOR_VERSION, slug,
      state, reason, trigger, principalKind: 'cli', principalId: null, requestId: null, noExtract: false, nextAttemptAt: null });
    await seed('meetings/sync-example', 'pending', null);
    await seed('conversations/conv-example', 'extracted', null);
    await seed('cal/standup-example', 'skipped', 'too_short');
    await seed('meetings/rescued-note', 'skipped', 'too_short');
    await seed('meetings/old-example', 'failed', 'judge_llm_unavailable');
    await seed('notes/plain-example', 'pending', null, 'backfill');
    const stats = await readChronicleLedgerStats(engine);
    expect(stats).toMatchObject({ available: true, pending: 1, last7d: { extracted: 1, failed: 1, skipped: 2,
      reasons: { too_short: 2, judge_llm_unavailable: 1 }, failedReasons: { judge_llm_unavailable: 1 } } });
    return stats;
  });

  parityTest('the advisor answers auto_chronicle_default_on with the ledger activity and the coverage gap of recent pages', { methods: ['readChronicleLedgerStats', 'listChronicleCoverageGapPages', 'upsertChronicleRow', 'getConfig', 'getPage'] }, async (engine) => {
    await seedPages(engine);
    await engine.upsertChronicleRow({ sourceId: 'default', pageId: await pageId(engine, 'meetings/sync-example'),
      contentHash: await contentHash(engine, 'meetings/sync-example'), extractorVersion: CHRONICLE_EXTRACTOR_VERSION, slug: 'meetings/sync-example',
      state: 'skipped', reason: 'too_short', trigger: 'auto', principalKind: 'cli', principalId: null, requestId: null, noExtract: false, nextAttemptAt: null });
    const gap = await engine.listChronicleCoverageGapPages();
    const out = await op(engine, 'advisor', {});
    const chronicle = (out.findings as Array<Record<string, unknown>>).filter(f => f.collector === 'chronicle');
    expect(chronicle.map(f => f.id)).toEqual(['chronicle_coverage_gap', 'auto_chronicle_default_on']);
    expect(String(chronicle[1].detail)).toContain('Last 7 days: 0 extracted, 0 failed, 1 skipped');
    return { gap: gap.map(r => r.type).sort(), chronicle };
  });
});

/**
 * The backfill batch text as backfill.ts composed it before the member, per scope and `since` shape. The member keeps
 * one static text per shape (engine-sql/** splices no `$n`); this pins each to the old builder, byte for byte, and the
 * parameters the member binds to the old order.
 */
function oldBatch(scopeKind: 'all' | 'sources' | 'source', since: boolean): string {
  const params: unknown[] = [1, 2, 3];
  let scope = '';
  if (scopeKind === 'sources') { params.push(0); scope += ` AND p.source_id = ANY($${params.length}::text[])`; }
  else if (scopeKind === 'source') { params.push(0); scope += ` AND p.source_id = $${params.length}`; }
  if (since) { params.push(0); scope += ` AND p.updated_at >= $${params.length}::date`; }
  params.push(0);
  const cursor = params.length;
  return `SELECT p.id, p.source_id, p.slug, p.type, coalesce(p.compiled_truth, p.truth_lead) AS compiled_truth, p.frontmatter, p.effective_date, p.effective_date_source, p.content_hash,
              EXISTS (SELECT 1 FROM chronicle_page_state c WHERE c.page_id=p.id AND c.content_hash=p.content_hash
                AND c.extractor_version=$3 AND (c.state='extracted' OR (c.state IN ('pending','failed') AND c.trigger='backfill' AND c.attempts < ${CHRONICLE_DEFAULTS.maxAttempts}))) AS done
         FROM pages p
        WHERE p.deleted_at IS NULL AND (p.type = ANY($1::text[]) OR p.slug LIKE ANY($2::text[]))${scope} AND p.id > $${cursor}
        ORDER BY p.id LIMIT 500`;
}

test('the backfill batch texts are the old builder text, byte for byte, with the old parameter order', async () => {
  expect(CHRONICLE_BACKFILL_BATCH.maxAttempts).toBe(CHRONICLE_DEFAULTS.maxAttempts);
  for (const scope of ['all', 'sources', 'source'] as const) {
    expect(CHRONICLE_BACKFILL_BATCH_SQL[scope] as string).toBe(oldBatch(scope, false));
    expect(CHRONICLE_BACKFILL_BATCH_SQL[`${scope}Since`] as string).toBe(oldBatch(scope, true));
  }
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const tx = { executeRaw: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return []; } } as never;
  const base = { types: ['meeting'], slugPatterns: ['meetings/%'], extractorVersion: 7, afterId: 9 };
  await readChronicleBackfillBatch(tx, base);
  await readChronicleBackfillBatch(tx, { ...base, sourceIds: ['a', 'b'], sourceId: 'x', since: '2026-01-01' });
  await readChronicleBackfillBatch(tx, { ...base, sourceIds: [], sourceId: 'x' });
  expect(calls).toEqual([
    { sql: oldBatch('all', false), params: [['meeting'], ['meetings/%'], 7, 9] },
    { sql: oldBatch('sources', true), params: [['meeting'], ['meetings/%'], 7, ['a', 'b'], '2026-01-01', 9] },
    { sql: oldBatch('source', false), params: [['meeting'], ['meetings/%'], 7, 'x', 9] },
  ]);
});
