/**
 * BrainEngine parity: the dream-cycle statements that became typed members (src/core/engine-sql/dream-cycle.ts): the
 * retriage queue and lock reads, the config map the dream breaker and the write deferrals share, the provenance stamp
 * and its counts, the consolidate phase's fact, page and take statements, and the synthesize family's job, page and
 * journal reads.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): which jobs the retriage reads select and in which state,
 *    which cycle locks count as live, how the config map is created, locked, written and merged on a reset, what the
 *    provenance stamp keeps and what it refuses to touch, what each count and list returns for a page, fact or take,
 *    and which jobs a synthesis key, a coalesce check and a daily cap see.
 *  - Regression: an engine that answers one of these differently changes which queued dream jobs retriage cancels, when
 *    the dream breaker trips and resets, whether a rewritten page keeps its first cycle date, which facts consolidate
 *    into a take and whether a take is created or refreshed, and which transcripts synthesis skips as already done or
 *    counts against the daily cap. The Rust engine has no SQL, so each read has to exist as a typed method it can
 *    implement or refuse by name (rust/docs/store/dream.md lists what its store would need).
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: none for the jobs, locks, pages, facts, takes and config, which are seeded through the typed members
 *    (admitJob, claimNextJob, completeJob, cancelJobs, acquireCycleLock, putPage, createVersion, insertFacts,
 *    addTakesBatch, getConfig). The three journal reads (readDreamDeferralReceipt, listLaterPersistenceRequests,
 *    listCommittedOutputRequests) read `persistence_requests`, which is seeded through the typed journal members
 *    (readSourceMembership, lockPersistenceCounters, insertWriteRequest, stampWriteClaim, completeWriteRow): one case
 *    compares them on queued, failed and committed requests of two slugs, and one asserts the empty answer; the
 *    statements' text is also pinned byte for byte by test/dream-cycle-sites-sql-pin.test.ts. Job ids are compared relative to the case's first job and
 *    clock readings only as present or absent.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, ClaimJobSpec, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const KEY = 'dream:synth-v2:s1:filename:a.txt:h1';
const TOKEN_A = '11111111-1111-4111-8111-111111111111';
const TOKEN_B = '22222222-2222-4222-8222-222222222222';
const UUID = '00000000-0000-4000-8000-000000000001';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
const DREAMER = { kind: 'local_cli', id: 'parity-dreamer' };
const DREAM_KEYS = ['principal:local_cli:parity-dreamer', 'brain'];
const CLAIM = 'c0000000-0000-4000-8000-0000000000c1';
const req = (n: number) => `b0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function values(name: string, extra: Partial<JobInsertValues> = {}): JobInsertValues {
  return {
    name, queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3, backoff_type: 'exponential',
    backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null, parent_job_id: null, on_child_fail: 'fail_parent',
    max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
    idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null,
    private_queue_owner_token: null, private_queue_lease_until: null, submission_authority: APPLICATION_AUTHORITY,
    spend_authorization: null, max_stalled: null, ...extra,
  };
}

const policy: AdmitJobPolicy = {
  decide: async (_tx, row) => coalesceDecision(row, APPLICATION_AUTHORITY),
  parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
};

/** One submission; the claim order breaks priority ties on created_at, which two quick submissions can share on PGLite. */
async function add(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await engine.admitJob({ maxSpawnDepth: 5, insert: values(name, extra) }, policy);
  expect(out.coalesced).toBe(false);
  await Bun.sleep(2);
  return Number(out.row.id);
}

function claimSpec(token: string): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: ['subagent'], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: UUID, capUsd: 5 },
  };
}

/** Claims the next waiting subagent job and completes it. */
async function finishNext(engine: BrainEngine, token: string): Promise<number> {
  const row = await engine.claimNextJob(claimSpec(token));
  expect(row).not.toBeNull();
  await engine.completeJob(Number(row!.id), token);
  return Number(row!.id);
}

const lease = (pid: number, token: string, ttlMinutes = 30) =>
  ({ holderPid: pid, holderHost: `host-${pid}`, acquisitionToken: token, ttlMinutes, stealGraceSeconds: 0 });

const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: body, timeline: '', frontmatter, ...extra });

/** Frontmatter as an observable: keys sorted, since jsonb reorders keys and the Rust store keeps them as written. */
const fm = (frontmatter: unknown) =>
  JSON.stringify(Object.fromEntries(Object.entries((frontmatter ?? {}) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));

/** One request of the dream's journal, queued; returns its journal id. */
async function admitRequest(engine: BrainEngine, requestId: string, over: { operation?: string; slug?: string } = {}): Promise<string> {
  const source = await engine.readSourceMembership('default');
  const slug = over.slug ?? 'notes/a';
  return engine.transaction(async tx => {
    await tx.lockPersistenceCounters(DREAM_KEYS);
    return (await tx.insertWriteRequest({
      principalKind: DREAMER.kind, principalId: DREAMER.id, requestId, operation: over.operation ?? 'put_page', sourceId: 'default',
      sourceIncarnation: source!.incarnation, pageId: null, slug, worktreeId: null, topologyGeneration: null,
      digest: 'd'.repeat(64), intent: { kind: over.operation ?? 'put_page', slug }, authority: { scopes: ['write'] }, intentBytes: 100,
      terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: DREAM_KEYS,
      clientRequestId: null, state: 'queued', deferredRefreshId: null,
    })).id;
  });
}

/** Claim a queued request and finish it in `state`. */
async function settleRequest(engine: BrainEngine, id: string, state: 'committed' | 'failed', errorCode: string | null): Promise<void> {
  await engine.transaction(async tx => {
    await tx.lockPersistenceCounters(DREAM_KEYS);
    await tx.stampWriteClaim(id, CLAIM, 60_000, JSON.stringify({ phase: 'parity' }));
    await tx.completeWriteRow({
      id, state, outcome: state === 'committed' ? { written: true } : null, errorCode, errorMessage: errorCode === null ? null : 'the write was deferred',
      consumerVersion: 'parity', consumerHostId: null, errorDetail: null, resultBytes: 1200, counterKeys: DREAM_KEYS, intentBytes: 100,
      retainedBytes: 1500, terminalReservation: 4096, probePurges: false,
    });
  });
}

describe('engine parity: dream-cycle statements', () => {
  parityTest('retriage reads the queued dream jobs, their status, and the waiting jobs of one private queue', {
    methods: ['admitJob', 'listDreamQueueCandidates', 'readDreamJobStatus', 'listWaitingChildJobIds'],
  }, async (engine) => {
    const synth = await add(engine, 'subagent', { idempotency_key: KEY, data: { source_id: 's1' } });
    const inline = await add(engine, 'subagent', { queue: 'dream-inline-123' });
    const delayed = await add(engine, 'subagent', { idempotency_key: 'dream:synth-v2:s2:filename:b.txt:h2', status: 'delayed', delay_until: FUTURE, data: { source_id: '' } });
    const notSubagent = await add(engine, 'work', { idempotency_key: 'dream:synth-v2:x' });
    const otherKey = await add(engine, 'subagent', { idempotency_key: 'something-else' });
    const rel = (id: number) => id - synth;
    const candidates = (await engine.listDreamQueueCandidates())
      .map(row => ({ id: rel(Number(row.id)), queue: row.queue, status: row.status, key: row.idempotency_key, source_id: row.source_id }))
      .sort((a, b) => a.id - b.id);
    expect(candidates.map(c => c.id)).toEqual([rel(synth), rel(inline), rel(delayed)]);
    const status = await engine.readDreamJobStatus(synth);
    const delayedStatus = await engine.readDreamJobStatus(delayed);
    const missing = await engine.readDreamJobStatus(otherKey + 1000);
    expect({ status, delayedStatus, missing }).toEqual({ status: { status: 'waiting' }, delayedStatus: { status: 'delayed' }, missing: null });
    const waitingInline = (await engine.listWaitingChildJobIds('dream-inline-123')).map(row => rel(Number(row.id)));
    const waitingNone = await engine.listWaitingChildJobIds('dream-inline-none');
    expect(waitingInline).toEqual([rel(inline)]);
    expect(waitingNone).toEqual([]);
    return { candidates, status, delayedStatus, missing, waitingInline, waitingNone, ignored: rel(notSubagent) - rel(synth) };
  });

  parityTest('retriage counts a cycle lock as live while it is unexpired or refreshed within the grace', {
    methods: ['acquireCycleLock', 'listLiveDreamCycleLocks'],
  }, async (engine) => {
    await engine.acquireCycleLock('gbrain-cycle:s1', lease(701, TOKEN_A));
    await engine.acquireCycleLock('gbrain-cycle', lease(702, TOKEN_B, -1));
    await engine.acquireCycleLock('gbrain-fs:x', lease(703, TOKEN_A));
    const view = (rows: Array<{ id: string; acquired_epoch_ms: string | number | null }>) =>
      rows.map(row => ({ id: row.id, acquired: Number.isFinite(Number(row.acquired_epoch_ms)) && Number(row.acquired_epoch_ms) > 0 }))
        .sort((a, b) => a.id.localeCompare(b.id));
    const withGrace = view(await engine.listLiveDreamCycleLocks(300));
    const noGrace = view(await engine.listLiveDreamCycleLocks(-1));
    expect(withGrace.map(l => l.id)).toEqual(['gbrain-cycle', 'gbrain-cycle:s1']);
    expect(noGrace.map(l => l.id)).toEqual(['gbrain-cycle:s1']);
    return { withGrace, noGrace };
  });

  parityTest('synthesis reads the completed jobs of a key, the keys that still count, the daily submissions, and the child timings', {
    methods: [
      'admitJob', 'claimNextJob', 'completeJob', 'cancelJobs', 'listCompletedSynthJobs', 'countCoalescibleSynthJobs',
      'countRecentDreamSynthSubmissions', 'listDreamChildJobTimings', 'listDreamJobCreatedAt',
    ],
  }, async (engine) => {
    const first = await add(engine, 'subagent', { idempotency_key: KEY, data: { source_id: 's1' } });
    const c0 = await add(engine, 'subagent', { idempotency_key: `${KEY}:c0of2`, data: { source_id: 's1' } });
    const c1 = await add(engine, 'subagent', { idempotency_key: `${KEY}:c1of2`, data: { source_id: 's1' } });
    const sibling = await add(engine, 'subagent', { idempotency_key: `${KEY}x` });
    const cancelled = await add(engine, 'subagent', { idempotency_key: `${KEY}y`, data: { source_id: 's1' } });
    const released = await add(engine, 'subagent', { data: { source_id: 's1', __released_idempotency_key: 'dream:synth-v2:s1:filename:z.txt:h9' } });
    const rel = (id: number) => id - first;
    expect(await engine.cancelJobs([cancelled])).toHaveLength(1);
    const done = [await finishNext(engine, TOKEN_A), await finishNext(engine, TOKEN_B), await finishNext(engine, TOKEN_A)];
    expect(done).toEqual([first, c0, c1]);
    const completed = (await engine.listCompletedSynthJobs(KEY)).map(row => ({ id: rel(Number(row.id)), key: row.idempotency_key }));
    expect(completed.map(row => row.id)).toEqual([rel(first), rel(c0), rel(c1)]);
    const none = await engine.listCompletedSynthJobs('dream:synth-v2:nobody');
    const keys = [KEY, `${KEY}:c0of2`, `${KEY}:c1of2`, `${KEY}x`, `${KEY}y`, 'dream:synth-v2:nobody'];
    const counting = await engine.countCoalescibleSynthJobs(keys);
    const noKeys = await engine.countCoalescibleSynthJobs([]);
    expect({ counting, noKeys }).toEqual({ counting: 4, noKeys: 0 });
    const recent = { s1: await engine.countRecentDreamSynthSubmissions('s1'), default: await engine.countRecentDreamSynthSubmissions('default'),
      nobody: await engine.countRecentDreamSynthSubmissions('nobody') };
    expect(recent).toEqual({ s1: 4, default: 1, nobody: 0 });
    const timings = (await engine.listDreamChildJobTimings([c0, sibling])).map(row => ({
      created: row.created_at != null, started: row.started_at != null, finished: row.finished_at != null,
      input: Number(row.tokens_input ?? 0), output: Number(row.tokens_output ?? 0), cacheRead: Number(row.tokens_cache_read ?? 0),
    })).sort((a, b) => Number(b.started) - Number(a.started));
    expect(timings).toEqual([
      { created: true, started: true, finished: true, input: 0, output: 0, cacheRead: 0 },
      { created: true, started: false, finished: false, input: 0, output: 0, cacheRead: 0 },
    ]);
    const createdAt = (await engine.listDreamJobCreatedAt([c0, c1, released + 1000])).map(row => ({ id: rel(Number(row.id)), present: row.created_at != null }))
      .sort((a, b) => a.id - b.id);
    expect(createdAt).toEqual([{ id: rel(c0), present: true }, { id: rel(c1), present: true }]);
    return { completed: completed.map(row => ({ id: row.id, key: row.key.slice(KEY.length) })), none, counting, noKeys, recent, timings, createdAt };
  });

  parityTest('the config map is created, locked, written back and merged with a breaker reset', {
    methods: ['getConfig', 'transaction', 'ensureDreamMapConfigRow', 'lockDreamMapConfigRow', 'writeDreamMapConfigRow', 'recordDreamBreakerReset'],
  }, async (engine) => {
    const key = 'dream.test.map';
    const clock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const missing = await engine.transaction(tx => tx.lockDreamMapConfigRow(key));
    const fresh = await engine.transaction(async tx => {
      await tx.ensureDreamMapConfigRow(key);
      const row = await tx.lockDreamMapConfigRow(key);
      return { value: row?.value, now: clock.test(row?.now ?? '') };
    });
    await engine.transaction(async tx => {
      await tx.ensureDreamMapConfigRow(key);
      await tx.writeDreamMapConfigRow(key, '{"a":["x"]}');
    });
    // `ensure` leaves a written row alone.
    const kept = await engine.transaction(async tx => {
      await tx.ensureDreamMapConfigRow(key);
      return (await tx.lockDreamMapConfigRow(key))?.value;
    });
    const stored = await engine.getConfig(key);
    expect({ missing, fresh, kept, stored }).toEqual({ missing: null, fresh: { value: '{}', now: true }, kept: '{"a":["x"]}', stored: '{"a":["x"]}' });
    const resets = 'dream.test.resets';
    await engine.recordDreamBreakerReset(resets, 'dream:phase:synthesize:default');
    await engine.recordDreamBreakerReset(resets, 'dream:phase:patterns:default');
    await engine.recordDreamBreakerReset(resets, 'dream:phase:synthesize:default');
    const merged = JSON.parse((await engine.getConfig(resets)) ?? '{}') as Record<string, string>;
    expect(Object.keys(merged).sort()).toEqual(['dream:phase:patterns:default', 'dream:phase:synthesize:default']);
    expect(Object.values(merged).every(at => clock.test(at))).toBe(true);
    return { missing, fresh, kept, stored, resetKeys: Object.keys(merged).sort() };
  });

  parityTest('the provenance stamp keeps the first cycle date, honors the first-write guard, and the counts read it', {
    methods: [
      'putPage', 'getPage', 'stampDreamPageProvenance', 'listDreamPageIds', 'countDreamProvenancePages', 'listRetainedDreamOutputSources',
      'findConsolidationPageIds', 'softDeletePage',
    ],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('dream/a', note('A', 'A body', {}));
    await engine.putPage('dream/b', note('B', 'B body', { dream_generated: true, dream_cycle_date: '2026-01-01', raw_source: '/tx/b.txt', seat: 'old' }));
    await engine.putPage('dream/summary', note('Summary', 'S body', { dream_generated: true, dream_cycle_date: '2026-01-02' }));
    await engine.putPage('dream/old', note('Old', 'Old body', {}));
    await engine.putPage('dream/gone', note('Gone', 'Gone body', { dream_generated: true, raw_source: '/tx/gone.txt' }));
    await engine.putPage('dream/a', note('A elsewhere', 'Other body', {}), { sourceId: 'other' });
    await engine.softDeletePage('dream/gone');
    const stamp = { sourceId: 'default', cycleDate: '2026-01-02', firstWriteAt: null as Date | null, clearSeat: false };
    await engine.stampDreamPageProvenance({ ...stamp, slug: 'dream/a', frontmatter: { dream_generated: true, raw_source: '/tx/a.txt' } });
    await engine.stampDreamPageProvenance({ ...stamp, slug: 'dream/b', cycleDate: '2026-01-03', clearSeat: true, frontmatter: { dream_generated: true } });
    // A page that existed before the child's first write is not dream output.
    await engine.stampDreamPageProvenance({ ...stamp, slug: 'dream/old', firstWriteAt: new Date(FUTURE), frontmatter: { dream_generated: true } });
    const stamped = {
      a: fm((await engine.getPage('dream/a'))?.frontmatter),
      b: fm((await engine.getPage('dream/b'))?.frontmatter),
      old: fm((await engine.getPage('dream/old'))?.frontmatter),
      elsewhere: fm((await engine.getPage('dream/a', { sourceId: 'other' }))?.frontmatter),
    };
    expect(JSON.parse(stamped.a)).toMatchObject({ dream_generated: true, raw_source: '/tx/a.txt', dream_cycle_date: '2026-01-02', dream_created_cycle_date: '2026-01-02' });
    expect(JSON.parse(stamped.b)).toMatchObject({ dream_generated: true, dream_cycle_date: '2026-01-01', dream_created_cycle_date: '2026-01-01' });
    expect(JSON.parse(stamped.b)).not.toHaveProperty('seat');
    expect(JSON.parse(stamped.old)).toEqual({});
    expect(JSON.parse(stamped.elsewhere)).toEqual({});
    const ids = {
      a: (await engine.listDreamPageIds('dream/a', 'default')).length,
      missing: (await engine.listDreamPageIds('dream/missing', 'default')).length,
      gone: (await engine.listDreamPageIds('dream/gone', 'default')).length,
      other: (await engine.listDreamPageIds('dream/a', 'other')).length,
      consolidation: (await engine.findConsolidationPageIds('default', 'dream/a')).length,
      consolidationMissing: (await engine.findConsolidationPageIds('default', 'dream/missing')).length,
      consolidationOther: (await engine.findConsolidationPageIds('other', 'dream/a')).length,
    };
    expect(ids).toEqual({ a: 1, missing: 0, gone: 0, other: 1, consolidation: 1, consolidationMissing: 0, consolidationOther: 1 });
    const found = await engine.countDreamProvenancePages('default', '2026-01-02', 'dream/summary', ['dream/a', 'dream/b']);
    const empty = await engine.countDreamProvenancePages('other', '2026-01-02', 'dream/summary', ['dream/a']);
    expect({ found, empty }).toEqual({ found: { found: 1, earlier: 1 }, empty: { found: 0, earlier: 0 } });
    const retained = (await engine.listRetainedDreamOutputSources('default')).map(row => row.raw_source).sort();
    const retainedOther = await engine.listRetainedDreamOutputSources('other');
    expect({ retained, retainedOther }).toEqual({ retained: ['/tx/a.txt', '/tx/b.txt'], retainedOther: [] });
    return { stamped, ids, found, empty, retained, retainedOther };
  });

  parityTest('synthesis reads the atom pages, the page bodies, the pre-run revision and the database clock', {
    methods: ['putPage', 'createVersion', 'listDreamAtomPages', 'listSynthesisPageBodies', 'readDreamPreRunRevision', 'readDreamVerifyEpoch'],
  }, async (engine) => {
    const atom = (title: string, frontmatter: Record<string, unknown>) => ({ type: 'atom' as never, title, compiled_truth: `${title} text`, timeline: '', frontmatter });
    await engine.putPage('atoms/one', atom('One', { concepts: ['x'] }));
    await engine.putPage('atoms/priv', atom('Priv', { concepts: ['y'], visibility: 'private' }));
    await engine.putPage('atoms/imported', atom('Imported', { concepts: ['z'], imported_from: 'elsewhere' }));
    await engine.putPage('atoms/note', note('Note', 'Not an atom', { concepts: ['n'] }));
    const atoms = (await engine.listDreamAtomPages('default'))
      .map(row => ({ slug: row.slug, title: row.title, body: row.compiled_truth, revision: /^\d+$/.test(row.revision), frontmatter: fm(row.frontmatter), private: row.private }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    expect(atoms.map(a => a.slug)).toEqual(['atoms/one', 'atoms/priv']);
    // An atom is a derived page: the privacy filter reads it as private whatever its frontmatter says.
    expect(atoms.map(a => a.private)).toEqual([true, true]);
    const none = await engine.listDreamAtomPages('nowhere');

    await engine.putPage('synth/b', { ...note('B', 'B body'), timeline: 'B timeline' });
    await engine.putPage('synth/a', { ...note('A', 'A body'), timeline: 'A timeline' });
    const bodies = await engine.listSynthesisPageBodies('default', ['synth/b', 'synth/a', 'synth/missing']);
    expect(bodies.map(row => row.slug)).toEqual(['synth/a', 'synth/b']);
    expect(bodies.map(row => row.title)).toEqual(['A', 'B']);
    expect(bodies[0]!.body!.startsWith('A body')).toBe(true);
    expect(bodies[0]!.body!.endsWith('A timeline')).toBe(true);
    const bodiesOther = await engine.listSynthesisPageBodies('nowhere', ['synth/a']);

    await engine.createVersion('synth/a');
    const revision = await engine.readDreamPreRunRevision('synth/a', 'default', PAST);
    const after = await engine.readDreamPreRunRevision('synth/a', 'default', FUTURE);
    const unversioned = await engine.readDreamPreRunRevision('synth/b', 'default', PAST);
    expect(revision).toMatchObject({ compiled_truth: 'A body', timeline: 'A timeline' });
    expect({ after, unversioned }).toEqual({ after: null, unversioned: null });
    const epoch = new Date(await engine.readDreamVerifyEpoch() as string);
    expect(Number.isNaN(epoch.getTime())).toBe(false);
    return {
      atoms, none, bodies: bodies.map(row => ({ slug: row.slug, title: row.title, body: row.body })), bodiesOther,
      revision: revision && { compiled_truth: revision.compiled_truth, timeline: revision.timeline, frontmatter: fm(typeof revision.frontmatter === 'string' ? JSON.parse(revision.frontmatter) : revision.frontmatter) },
      after, unversioned, epoch: true,
    };
  });

  parityTest('consolidation reads the claim values and shapes, writes valid_until, and finds the readers-sourced facts', {
    methods: ['putPage', 'insertFact', 'insertFacts', 'listFactsByEntity', 'listConsolidationClaimValues', 'listConsolidationClaimShapes', 'setConsolidatedFactValidUntil', 'listReadersSourcedFactIds'],
  }, async (engine) => {
    await engine.putPage('people/a', note('A', 'a person'));
    await engine.putPage('notes/readers', note('Readers', 'a member page', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/open', note('Open', 'an open page'));
    const typed = async (text: string, extra: Record<string, unknown>) => {
      const out = await engine.insertFact({ fact: text, entity_slug: 'people/a', kind: 'fact', visibility: 'world', source: 'test', embedding: null, ...extra } as never, { source_id: 'default' });
      expect(out.status).toBe('inserted');
      return Number(out.id);
    };
    const mrr = await typed('MRR is 42k', { claim_metric: 'mrr', claim_value: 42, claim_unit: 'usd', claim_period: 'month' });
    const plain = await typed('Likes tea', {});
    const fenced = async (text: string, slug: string, row: number) =>
      Number((await engine.insertFacts([{ fact: text, entity_slug: 'people/a', kind: 'fact', visibility: 'world', source: 'fence', row_num: row, source_markdown_slug: slug }] as never, { source_id: 'default' })).ids[0]);
    const restricted = await fenced('Told in confidence', 'notes/readers', 1);
    const open = await fenced('Said in the open', 'notes/open', 1);

    const ids = [mrr, plain];
    const values = (await engine.listConsolidationClaimValues(ids)).map(row => ({ at: ids.indexOf(Number(row.id)), value: row.claim_value == null ? null : Number(row.claim_value) }))
      .sort((a, b) => a.at - b.at);
    const shapes = (await engine.listConsolidationClaimShapes(ids)).map(row => ({ at: ids.indexOf(Number(row.id)), metric: row.claim_metric, unit: row.claim_unit, period: row.claim_period }))
      .sort((a, b) => a.at - b.at);
    expect(values).toEqual([{ at: 0, value: 42 }, { at: 1, value: null }]);
    expect(shapes).toEqual([{ at: 0, metric: 'mrr', unit: 'usd', period: 'month' }, { at: 1, metric: null, unit: null, period: null }]);
    const noIds = { values: await engine.listConsolidationClaimValues([]), shapes: await engine.listConsolidationClaimShapes([]) };

    const all = [mrr, plain, restricted, open];
    const readers = (await engine.listReadersSourcedFactIds(all)).map(row => all.indexOf(Number(row.id)));
    expect(readers).toEqual([2]);
    const readersNone = await engine.listReadersSourcedFactIds([]);

    const until = new Date('2026-03-04T05:06:07.000Z');
    await engine.setConsolidatedFactValidUntil(until, mrr);
    await engine.setConsolidatedFactValidUntil(until, mrr);
    const validUntil = async () => (await engine.listFactsByEntity('default', 'people/a', { activeOnly: false }))
      .filter(fact => Number(fact.id) === mrr || Number(fact.id) === plain)
      .map(fact => ({ at: ids.indexOf(Number(fact.id)), until: fact.valid_until ? new Date(fact.valid_until).toISOString() : null }))
      .sort((a, b) => a.at - b.at);
    const written = await validUntil();
    expect(written).toEqual([{ at: 0, until: until.toISOString() }, { at: 1, until: null }]);
    return { values, shapes, noIds, readers, readersNone, written };
  });

  parityTest('consolidation finds, numbers and refreshes the takes of a page', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'resolveTake', 'readConsolidationTakesMaxRowNum', 'findConsolidatedTakes', 'refreshConsolidatedTakeSource', 'findConsolidatedTakeIds'],
  }, async (engine) => {
    const page = await engine.putPage('people/a', note('A', 'a person'));
    const pageId = Number(page.id);
    const emptyMax = await engine.readConsolidationTakesMaxRowNum(pageId);
    const take = (row_num: number, claim: string, extra: Record<string, unknown> = {}) =>
      ({ page_id: pageId, row_num, claim, kind: 'fact', holder: 'self', weight: 0.5, since_date: '2026-01-01', source: 'first', ...extra }) as never;
    await engine.addTakesBatch([
      take(1, 'Prefers email'),
      take(3, 'Likes tea'),
      take(4, 'Prefers email', { holder: 'someone-else' }),
      take(5, 'Prefers phone', { kind: 'take' }),
    ]);
    const max = await engine.readConsolidationTakesMaxRowNum(pageId);
    const otherPage = await engine.readConsolidationTakesMaxRowNum(pageId + 1000);
    expect({ emptyMax, max, otherPage }).toEqual({ emptyMax: 0, max: 5, otherPage: 0 });

    const found = await engine.findConsolidatedTakes(pageId, 'Prefers email');
    const wrongHolder = await engine.findConsolidatedTakes(pageId, 'Prefers phone');
    const unknown = await engine.findConsolidatedTakes(pageId, 'No such claim');
    expect(found).toHaveLength(1);
    expect(found[0]!.resolved_at).toBeNull();
    expect({ wrongHolder, unknown }).toEqual({ wrongHolder: [], unknown: [] });
    const byRow = await engine.findConsolidatedTakeIds(pageId, 1);
    const byMissingRow = await engine.findConsolidatedTakeIds(pageId, 9);
    expect(byRow.map(row => Number(row.id))).toEqual([Number(found[0]!.id)]);
    expect(byMissingRow).toEqual([]);

    await engine.refreshConsolidatedTakeSource('a, b', Number(found[0]!.id));
    const sources = (await engine.listTakes({ page_id: pageId })).map(t => ({ row: t.row_num, source: t.source })).sort((a, b) => a.row - b.row);
    expect(sources.find(s => s.row === 1)?.source).toBe('a, b');
    expect(sources.find(s => s.row === 3)?.source).toBe('first');

    await engine.resolveTake(pageId, 1, { quality: 'correct', resolvedBy: 'garry' });
    const resolved = await engine.findConsolidatedTakes(pageId, 'Prefers email');
    expect(resolved[0]!.resolved_at).not.toBeNull();
    return { emptyMax, max, otherPage, found: found.length, wrongHolder, unknown, byMissingRow, sources, resolved: resolved[0]!.resolved_at != null };
  });

  parityTest('the journal reads see seeded requests: a deferral receipt, the live requests after a sequence, and the committed outputs, newest first', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transaction',
      'readDreamSourceIncarnation', 'readDreamDeferralReceipt', 'listLaterPersistenceRequests', 'listCommittedOutputRequests'],
  }, async (engine) => {
    const first = await admitRequest(engine, req(1));
    const queued = await admitRequest(engine, req(2));
    const failed = await admitRequest(engine, req(3));
    const newest = await admitRequest(engine, req(4));
    const other = await admitRequest(engine, req(5), { slug: 'notes/other' });
    const deletion = await admitRequest(engine, req(6), { operation: 'delete_page' });
    await settleRequest(engine, first, 'committed', null);
    await settleRequest(engine, failed, 'failed', 'dream_write_deferred');
    await settleRequest(engine, newest, 'committed', null);
    await settleRequest(engine, other, 'committed', null);
    await settleRequest(engine, deletion, 'committed', null);
    const incarnation = (await engine.readDreamSourceIncarnation('default'))!.incarnation!;
    const names = new Map([[first, 'first'], [queued, 'queued'], [failed, 'failed'], [newest, 'newest'], [other, 'other'], [deletion, 'deletion']]);
    const nameOf = (id: string) => names.get(id) ?? `unknown:${id}`;
    const sequences = (await engine.listLaterPersistenceRequests('default', incarnation, 'notes/a', 0)).map(r => r.sequence);
    const view = (r: Record<string, unknown>) => ({
      keys: Object.keys(r).sort(), id: nameOf(String(r.id)), request_id: r.request_id, operation: r.operation, slug: r.slug, state: r.state,
      error_code: r.error_code, principal_kind: r.principal_kind, source_id: r.source_id, compacted: r.compacted,
    });
    const later = async (slug: string, sequence: number | string, inc = incarnation) => (await engine.listLaterPersistenceRequests('default', inc, slug, sequence)).map(r => view({ ...r }));
    const committedOf = async (ids: string[], inc = incarnation) => (await engine.listCommittedOutputRequests(ids, 'default', inc)).map(r => ({ request: view(r.request as never) }));
    const receipt = async (id: string) => engine.readDreamDeferralReceipt(id);
    const out = {
      receipts: { queued: await receipt(queued), failed: await receipt(failed), committed: await receipt(first), unknown: await receipt(req(77)) },
      // Every live request of the slug, in journal order (the failed one is not live); the first one's sequence excludes itself.
      all: await later('notes/a', 0), afterFirst: await later('notes/a', sequences[0]!), afterLast: await later('notes/a', sequences[sequences.length - 1]!),
      other: await later('notes/other', 0), none: await later('notes/none', 0), wrongIncarnation: await later('notes/a', 0, UUID),
      committed: await committedOf([req(1), req(2), req(3), req(4), req(5), req(6)]),
      committedSome: await committedOf([req(1), req(2)]), committedFailedOnly: await committedOf([req(3)]), committedNone: await committedOf([]),
      committedWrongIncarnation: await committedOf([req(1)], UUID),
    };
    expect(out.receipts.queued).toMatchObject({ state: 'queued', error_code: null });
    expect(out.receipts.failed).toMatchObject({ state: 'failed', error_code: 'dream_write_deferred', error_message: 'the write was deferred' });
    expect(out.receipts.committed).toMatchObject({ state: 'committed' });
    expect(out.receipts.unknown).toBeNull();
    expect(out.all.map(r => [r.id, r.state])).toEqual([['first', 'committed'], ['queued', 'queued'], ['newest', 'committed'], ['deletion', 'committed']]);
    expect(out.afterFirst.map(r => r.id)).toEqual(['queued', 'newest', 'deletion']);
    expect(out.afterLast).toEqual([]);
    expect(out.other.map(r => r.id)).toEqual(['other']);
    expect(out.committed.map(r => r.request.id)).toEqual(['other', 'newest', 'first']);
    expect(out.committedSome.map(r => r.request.id)).toEqual(['first']);
    expect({ failed: out.committedFailedOnly, none: out.committedNone, wrong: out.committedWrongIncarnation, wrongLater: out.wrongIncarnation }).toEqual({ failed: [], none: [], wrong: [], wrongLater: [] });
    return out;
  });

  parityTest('the journal reads answer empty for a brain with no persisted requests, and the source incarnation for a source', {
    methods: ['readDreamDeferralReceipt', 'listLaterPersistenceRequests', 'listCommittedOutputRequests', 'readDreamSourceIncarnation'],
  }, async (engine) => {
    const receipt = await engine.readDreamDeferralReceipt(UUID);
    const later = await engine.listLaterPersistenceRequests('default', UUID, 'notes/a', 0);
    const committed = await engine.listCommittedOutputRequests([UUID], 'default', UUID);
    const committedNone = await engine.listCommittedOutputRequests([], 'default', UUID);
    expect({ receipt, later, committed, committedNone }).toEqual({ receipt: null, later: [], committed: [], committedNone: [] });
    const known = await engine.readDreamSourceIncarnation('default');
    const unknown = await engine.readDreamSourceIncarnation('no-such-source');
    expect(known).not.toBeNull();
    expect(unknown).toBeNull();
    return { receipt, later, committed, committedNone, known: known !== null, unknown };
  });
});
