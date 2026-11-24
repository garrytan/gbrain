/**
 * BrainEngine parity: the doctor facts, fence and trust reads of engine-sql/doctor-facts-trust.ts, which doctor checks and
 * the readers they share used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), seeded through the engine's own writers.
 *  - Regression: an engine whose read drifts (or does not serve it) makes the check report a different status or message
 *    per backend: the conversation-pipeline note, the writer-contention warning.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobSpec, ClaimJobSpec, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { BACKSTOP_RESCUE_SLUG_PREFIXES, CONVERSATION_PIPELINE_TYPES } from '../../src/core/facts/eligibility.ts';
import { createSource, parityArms } from './harness.ts';
import { readTrustBackfillState, TRUST_BACKFILL_COMPLETED_KEY } from '../../src/core/trust/backfill.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

async function absorb(engine: BrainEngine, source_id: string, slug: string, summary: string): Promise<void> {
  await engine.logIngest({ source_id, source_type: 'facts:absorb', source_ref: slug, pages_updated: [], summary });
}

const jobValues = (data: Record<string, unknown>): JobInsertValues => ({
  name: 'facts-absorb', queue: 'default', status: 'waiting', priority: 0, data, max_attempts: 3, backoff_type: 'exponential',
  backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null, parent_job_id: null, on_child_fail: 'fail_parent',
  max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
  idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null,
  private_queue_owner_token: null, private_queue_lease_until: null, submission_authority: APPLICATION_AUTHORITY,
  spend_authorization: null, max_stalled: null,
});

/** A facts-absorb job for `data` that a worker claimed and completed. */
async function completedAbsorb(engine: BrainEngine, data: Record<string, unknown>): Promise<void> {
  const policy = { decide: async (_tx: unknown, row: never) => coalesceDecision(row, APPLICATION_AUTHORITY), parentAuthorityKind: (raw: unknown) => parseSubmissionAuthority(raw as never)?.kind ?? null };
  const spec: Partial<AdmitJobSpec> & { insert: JobInsertValues } = { insert: jobValues(data) };
  const out = await engine.admitJob({ maxSpawnDepth: 5, ...spec } as AdmitJobSpec, policy as never);
  const claim: ClaimJobSpec = { lockToken: 'tok', lockDurationMs: 30_000, queue: 'default', names: ['facts-absorb'], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 } };
  const row = await engine.claimNextJob(claim);
  expect(Number(row?.id)).toBe(Number(out.row.id));
  await engine.completeJob(Number(out.row.id), 'tok');
  await Bun.sleep(2);
}

/** Run `fn` in a transaction whose write trust settings declare `tier` and the write origin; `null` writes with none. */
function stamped<T>(engine: BrainEngine, tier: string | null, origin: Record<string, unknown> | null, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  if (tier === null) return fn(engine);
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'], [tier, tier, origin ? JSON.stringify(origin) : '']);
    return fn(tx);
  });
}

const patterns = BACKSTOP_RESCUE_SLUG_PREFIXES.map(p => `${p}%`);
const conversationType = CONVERSATION_PIPELINE_TYPES[0]!;

describe('doctor facts, fence and trust reads', () => {
  parityTest(
    'the conversation-pipeline page count skips deleted pages, other types and the rescued slug prefixes',
    { methods: ['putPage', 'softDeletePage', 'countConversationPipelinePages'] },
    async (engine) => {
      const none = await engine.countConversationPipelinePages(CONVERSATION_PIPELINE_TYPES, patterns);
      const put = (slug: string, type: string) => engine.putPage(slug, { type: type as never, title: slug, compiled_truth: 'body' });
      await put('convos/a', conversationType);
      await put('convos/b', conversationType);
      await put(`${BACKSTOP_RESCUE_SLUG_PREFIXES[0]}rescued`, conversationType);
      await put('notes/plain', 'note');
      await put('convos/gone', conversationType);
      await engine.softDeletePage('convos/gone');
      const counted = await engine.countConversationPipelinePages(CONVERSATION_PIPELINE_TYPES, patterns);
      const unrescued = await engine.countConversationPipelinePages([conversationType], []);
      const wildcard = await engine.countConversationPipelinePages([conversationType], ['convos/_']);
      expect({ none, counted, unrescued, wildcard }).toEqual({ none: 0, counted: 2, unrescued: 3, wildcard: 1 });
      return { none, counted, unrescued, wildcard };
    },
  );

  parityTest(
    'persistent writer contention lists the sources whose deferred writes no completed job covers and that persist',
    { methods: ['logIngest', 'admitJob', 'claimNextJob', 'completeJob', 'listPersistentWriterContention'] },
    async (engine) => {
      const reason = 'write_deferred_unadmitted';
      const none = await engine.listPersistentWriterContention(reason);
      // Ten fresh deferrals do not persist; eleven do. A completed job of the same page after a row covers that row.
      for (let i = 0; i < 10; i++) await absorb(engine, 'ten', `p${i}`, `${reason}: busy`);
      for (let i = 0; i < 11; i++) await absorb(engine, 'busy', `p${i}`, `${reason}: busy`);
      for (let i = 0; i < 11; i++) await absorb(engine, 'other-reason', `p${i}`, 'timeout: x');
      for (let i = 0; i < 13; i++) await absorb(engine, 'covered', `p${i}`, `${reason}: busy`);
      await Bun.sleep(5);
      for (let i = 0; i < 2; i++) await completedAbsorb(engine, { slug: `p${i}`, sourceId: 'covered' });
      for (let i = 0; i < 12; i++) await absorb(engine, 'default', `p${i}`, `${reason}: busy`);
      await Bun.sleep(5);
      // A job with no `sourceId` covers the `default` source.
      await completedAbsorb(engine, { slug: 'p0' });
      const rows = await engine.listPersistentWriterContention(reason);
      const shaped = rows.map(r => ({ source_id: r.source_id, n: Number(r.n) }));
      for (const row of rows) expect(Math.abs(Date.now() - new Date(row.oldest).getTime())).toBeLessThan(60_000);
      expect({ none, shaped }).toEqual({ none: [], shaped: [
        { source_id: 'busy', n: 11 }, { source_id: 'covered', n: 11 }, { source_id: 'default', n: 11 },
      ] });
      return { none, shaped };
    },
  );

  parityTest(
    'countRowTrustTiers, countDerivedRowTaint and countClaimLiftedRows count the stamped tiers and write origins of every table',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'addTakesBatch', 'addTimelineEntry',
      'countRowTrustTiers', 'countDerivedRowTaint', 'countDerivedFactTaint', 'countClaimLiftedRows'] },
    async (engine) => {
      const holder = await stamped(engine, 'operator_curated', { channel: 'import' }, tx => tx.putPage('trust/holder', { type: 'note', title: 'Holder', compiled_truth: 'h', timeline: '' }));
      const origins: Array<[string | null, Record<string, unknown> | null]> = [
        ['agent_written', { channel: 'agent', taint_inputs: [{ table: 'pages', id: 1 }] }],
        ['external_untrusted', { channel: 'agent', taint_inputs: [{ table: 'pages', id: 2 }] }],
        ['external_untrusted', { channel: 'web' }],
        ['operator_curated', { channel: 'trust_claim' }],
        [null, null],
      ];
      for (const [i, [tier, origin]] of origins.entries()) {
        await stamped(engine, tier, origin, async (tx) => {
          await tx.putPage(`trust/page-${i}`, { type: 'note', title: `P${i}`, compiled_truth: `p${i}`, timeline: '' });
          await tx.insertFacts([{ fact: `fact ${i}`, entity_slug: 'people/a-example', kind: 'fact', visibility: 'world', source: 'cli', context: `ctx ${i}`,
            valid_from: new Date(Date.UTC(2026, 0, 1)), row_num: i + 1, source_markdown_slug: 'trust/holder' }] as never, { source_id: 'default' });
          await tx.addTakesBatch([{ page_id: holder.id, row_num: i + 1, claim: `take ${i}`, kind: 'take', holder: 'h', weight: 0.5 }]);
          await tx.addTimelineEntry('trust/holder', { date: `2026-07-0${i + 1}`, summary: `entry ${i}` });
        });
      }
      const tiers = async (table: 'facts' | 'takes' | 'timeline_entries') => (await engine.countRowTrustTiers(table))
        .map((r) => ({ tier: r.tier, n: Number(r.n) })).sort((a, b) => String(a.tier).localeCompare(String(b.tier)));
      const out = {
        facts: await tiers('facts'), takes: await tiers('takes'), timeline: await tiers('timeline_entries'),
        taint: {
          facts: await engine.countDerivedFactTaint(), pages: await engine.countDerivedRowTaint('pages'),
          takes: await engine.countDerivedRowTaint('takes'), timeline: await engine.countDerivedRowTaint('timeline_entries'),
        },
        lifted: {
          pages: await engine.countClaimLiftedRows('pages'), facts: await engine.countClaimLiftedRows('facts'),
          takes: await engine.countClaimLiftedRows('takes'), timeline: await engine.countClaimLiftedRows('timeline_entries'),
        },
      };
      const byTier = [{ tier: 'agent_written', n: 1 }, { tier: 'external_untrusted', n: 2 }, { tier: 'operator_curated', n: 1 }, { tier: 'unknown', n: 1 }];
      expect(out.facts).toEqual(byTier);
      expect(out.takes).toEqual(byTier);
      expect(out.timeline).toEqual(byTier);
      expect(out.taint.facts).toEqual({ derived: 2, external: 1 });
      expect(out.taint.takes).toEqual({ derived: 2, external: 1 });
      expect(out.taint.timeline).toEqual({ derived: 2, external: 1 });
      expect(out.taint.pages).toEqual({ derived: 2, external: 1 });
      expect(out.lifted).toEqual({ pages: 1, facts: 1, takes: 1, timeline: 1 });
      return out;
    },
  );

  parityTest(
    'countLegacyUnknownBySource counts live unknown rows per source at or below the ceilings, within the named sources',
    { methods: ['putPage', 'softDeletePage', 'insertFacts', 'addTakesBatch', 'addTimelineEntry', 'listTakes', 'getTimeline', 'getPage', 'countLegacyUnknownBySource'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const pages = new Map<string, number>();
      let row = 0;
      const seed = async (tag: string, source: string, curated = false) => {
        const slug = `legacy/${tag}`;
        const write = (tx: BrainEngine) => tx.putPage(slug, { type: 'note', title: tag, compiled_truth: tag, timeline: '' }, { sourceId: source });
        await (curated ? stamped(engine, 'operator_curated', { channel: 'import' }, write) : write(engine));
        pages.set(slug, (await engine.getPage(slug, { sourceId: source }))!.id);
        const factIds = (await engine.insertFacts([{ fact: `fact ${tag}`, entity_slug: 'people/a-example', kind: 'fact', visibility: 'world', source: 'cli',
          context: tag, valid_from: new Date(Date.UTC(2026, 0, 1)), row_num: ++row, source_markdown_slug: slug }] as never, { source_id: source })).ids;
        await engine.addTakesBatch([{ page_id: pages.get(slug)!, row_num: 1, claim: `take ${tag}`, kind: 'take', holder: 'h', weight: 0.5 }]);
        await engine.addTimelineEntry(slug, { date: '2026-07-01', summary: `entry ${tag}` }, { sourceId: source });
        return { pageId: pages.get(slug)!, factId: Number(factIds[0]) };
      };
      const maxTakeId = async (): Promise<number> => Math.max(0, ...(await Promise.all([...pages.values()].map((page_id) => engine.listTakes({ page_id })))).flat().map((t) => Number(t.id)));
      const maxEntryId = async (): Promise<number> => {
        let max = 0;
        for (const [slug] of pages) for (const sourceId of ['default', 'other']) for (const e of await engine.getTimeline(slug, { sourceId }).catch(() => [])) max = Math.max(max, Number(e.id));
        return max;
      };
      const early = [await seed('a', 'default'), await seed('b', 'other'), await seed('c', 'other'), await seed('curated', 'default', true)];
      await engine.softDeletePage('legacy/c', { sourceId: 'other' });
      const ceilings = {
        pages: Math.max(...early.map((e) => e.pageId)), facts: Math.max(...early.map((e) => e.factId)),
        takes: await maxTakeId(), timeline_entries: await maxEntryId(),
      };
      await seed('d', 'default');
      await seed('e', 'other');
      const shape = async (c: typeof ceilings | null, ids?: string[]) => (await engine.countLegacyUnknownBySource(c, ids)).map((r) => ({ source_id: r.source_id, n: Number(r.n) }))
        .sort((a, b) => a.source_id.localeCompare(b.source_id));
      const out = {
        all: await shape(null), early: await shape(ceilings), named: await shape(null, ['other']), earlyNamed: await shape(ceilings, ['default']),
        none: await shape(null, ['missing']), empty: await shape(null, []),
      };
      // Deleted pages drop out of the page count only; their facts, takes and entries still count (the take and entry joins read the page row).
      expect(out.all).toEqual([{ source_id: 'default', n: 11 }, { source_id: 'other', n: 11 }]);
      expect(out.early).toEqual([{ source_id: 'default', n: 7 }, { source_id: 'other', n: 7 }]);
      expect(out.named).toEqual([{ source_id: 'other', n: 11 }]);
      expect(out.earlyNamed).toEqual([{ source_id: 'default', n: 7 }]);
      expect(out.none).toEqual([]);
      expect(out.empty).toEqual([]);
      return out;
    },
  );

  parityTest(
    'listTrustClaimTargets lists the non-connector sources, the named ones and the claimed ones with their claim state',
    { methods: ['listTrustClaimTargets'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'docs');
      await createSource(engine, backend, 'gmail', { kind: 'google' });
      await createSource(engine, backend, 'claimed', { trust_claimed_at: '2026-01-01T00:00:00Z', trust_tier: 'operator_curated' });
      await createSource(engine, backend, 'claimed-gmail', { kind: 'github', trust_claimed_at: '2026-01-01T00:00:00Z', trust_tier: 'operator_curated' });
      await createSource(engine, backend, 'ended', { trust_claimed_at: '2026-01-01T00:00:00Z', trust_tier: 'agent_written' });
      const by = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
      const out = {
        owned: by(await engine.listTrustClaimTargets('owned')),
        named: await engine.listTrustClaimTargets('named', ['ended', 'gmail', 'claimed', 'missing']),
        claimed: await engine.listTrustClaimTargets('claimed'),
      };
      expect(out.owned).toEqual([{ id: 'claimed', claimed: true }, { id: 'default', claimed: false }, { id: 'docs', claimed: false }, { id: 'ended', claimed: false }]);
      expect(out.named).toEqual([{ id: 'claimed', claimed: true }, { id: 'ended', claimed: false }]);
      expect(out.claimed).toEqual([{ id: 'claimed', claimed: true }]);
      return out;
    },
  );

  parityTest(
    'listTrustColumns reports the trust columns, and the trust backfill state reads no interrupted run on a fresh brain',
    { methods: ['listTrustColumns', 'readOpCheckpointKeys', 'getConfig', 'setConfig'] },
    async (engine) => {
      // The store keeps the trust columns only: the other columns the probe lists are a PGLite/Postgres schema detail.
      const columns = (await engine.listTrustColumns()).map((c) => `${c.table_name}.${c.column_name}`)
        .filter((c) => /\.(trust_tier|write_origin)$|^sources\.config$/.test(c)).sort();
      // A fresh Rust brain starts with the completion marker v226 writes on an empty brain (the seed, lib.rs); the test
      // brain of the other arms may not hold it, so the fresh read compares the interrupted flag only.
      const fresh = (({ interrupted }) => ({ interrupted }))(await readTrustBackfillState(engine));
      await engine.setConfig(TRUST_BACKFILL_COMPLETED_KEY, '2026-07-01T00:00:00Z');
      const done = await readTrustBackfillState(engine);
      expect(columns).toEqual(['facts.trust_tier', 'facts.write_origin', 'pages.trust_tier', 'pages.write_origin', 'sources.config',
        'takes.trust_tier', 'takes.write_origin', 'timeline_entries.trust_tier', 'timeline_entries.write_origin']);
      expect(fresh).toEqual({ interrupted: false });
      expect(done.completedAt).toBe('2026-07-01T00:00:00Z');
      return { columns, fresh, done };
    },
  );
});
