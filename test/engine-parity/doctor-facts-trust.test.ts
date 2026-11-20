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
import { parityArms } from './harness.ts';
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
});
