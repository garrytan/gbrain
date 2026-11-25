/**
 * BrainEngine parity: the pinned-question records (src/core/engine-sql/question-store.ts; the Rust `~q` family,
 * rust/docs/store/questions.md) at the call sites in src/core/questions/store.ts and questions/refresh.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a pin is inserted once per (source, slug); reads and listings, state changes, the refresh lease (a live
 *    lease refuses a second taker, an expired one is taken over), spend, the blocked record, a publication inside
 *    engine.transaction (lock, answer, evidence rewrite; rolled back as a whole) and the two reads of the records
 *    (the evidence join and the published answers) read the same on PGLite, Postgres and Rust.
 *  - Regression: the pin store ran through executeRaw, so a Rust brain refused every `gbrain questions` command with a
 *    named stop (rust-engine/question-stops.ts, PIN_STORE_STOP).
 *  - Why existing coverage misses it: test/pinned-questions-*.test.ts run on PGLite only.
 *  - Seam: real engines; pages, facts, timeline entries and takes through typed writes; the pin records through the
 *    typed members. Timestamps and ids are normalized (each arm stamps and numbers its own); everything else is compared.
 *
 * One value is a PLACEHOLDER: the Rust store keeps no page generation yet (the helper `page_generation` of
 * rust/crates/gbrain-store/src/questions/join.rs reads 1), so the join's `p_generation` is compared by value only for the
 * first page written (generation 1 on every arm) and by type for the others.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  acquireLease, addSpend, getPin, insertPin, listPins, releaseLease, updatePinState, type PinInsert, type PinRow,
} from '../../src/core/questions/store.ts';

const { parityTest } = parityArms(testBackends());

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const pin = (slug: string, over: Partial<PinInsert> = {}): PinInsert => ({
  sourceId: over.sourceId ?? 'default', slug, question: `Question of ${slug}?`, scope: { source: over.sourceId ?? 'default', slug_prefix: 'projects/' }, state: 'active', inactiveReason: null,
  publishMode: 'publish', createdBy: 'cli', ...over,
});

/** A pin row with its clock columns reduced to present or absent: each arm stamps its own. */
function view(row: PinRow | null) {
  if (row === null) return null;
  const when = (d: Date | null) => (d === null ? null : d instanceof Date && Number.isFinite(d.getTime()) ? 'time' : 'not a date');
  return {
    ...row, id: typeof row.id, created_at: when(row.created_at), last_refresh_at: when(row.last_refresh_at), last_attempt_at: when(row.last_attempt_at),
    watermark_at: when(row.watermark_at), lease_expires_at: when(row.lease_expires_at), archived_at: when(row.archived_at),
    lease_token: row.lease_token, spend_usd: row.spend_usd,
  };
}

const page = (title: string, over: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: `body of ${title}`, timeline: '', frontmatter: {}, ...over });

describe('the pinned-question records on every engine', () => {
  parityTest('a pin is inserted once per (source, slug); the duplicate returns the first row; both reads of one pin agree', {
    methods: ['insertPinRow', 'readPinRow'],
  }, async (engine) => {
    const first = await insertPin(engine, pin('questions/a', { scope: { source: 'default', slug_prefix: 'projects/', entity: 'people/alice-example' } }));
    const again = await insertPin(engine, pin('questions/a', { question: 'A different question?', state: 'inactive', inactiveReason: 'awaiting_consent' }));
    const otherSource = await insertPin(engine, pin('questions/a', { sourceId: 'work', question: 'Same slug, other source?' }));
    const plain = await getPin(engine, 'default', 'questions/a');
    const locked = await getPin(engine, 'default', 'questions/a', { forUpdate: true });
    const none = await getPin(engine, 'default', 'questions/never');
    const rowId = (r: PinRow) => r.id;
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.row.question).toBe(first.row.question);
    expect(rowId(otherSource.row)).not.toBe(rowId(first.row));
    expect(locked).toEqual(plain);
    return {
      first: { created: first.created, row: view(first.row) }, again: { created: again.created, row: view(again.row) },
      otherSource: { created: otherSource.created, row: view(otherSource.row) }, plain: view(plain), locked: view(locked), none,
      sameRow: [rowId(first.row) === rowId(again.row), rowId(first.row) === rowId(plain!)],
    };
  });

  parityTest('every listing filter: all, archived, sources, states, both; byte order of the source id, then creation, then id', {
    methods: ['insertPinRow', 'listPinRows', 'updatePinRowState'],
  }, async (engine) => {
    // 'Zed' sorts before 'alpha' in byte order and after it in most locales: the listing is byte order.
    const a = await insertPin(engine, pin('questions/b', { sourceId: 'alpha' }));
    await insertPin(engine, pin('questions/z', { sourceId: 'Zed' }));
    await insertPin(engine, pin('questions/a', { sourceId: 'alpha', state: 'inactive', inactiveReason: 'awaiting_consent' }));
    await insertPin(engine, pin('questions/c', { sourceId: 'beta' }));
    await updatePinState(engine, a.row.id, { state: 'archived' });
    const names = (rows: PinRow[]) => rows.map(r => `${r.source_id}:${r.slug}:${r.state}`);
    const out = {
      all: names(await listPins(engine)),
      withArchived: names(await listPins(engine, { includeArchived: true })),
      sources: names(await listPins(engine, { sourceIds: ['alpha', 'beta'] })),
      sourcesArchived: names(await listPins(engine, { sourceIds: ['alpha'], includeArchived: true })),
      states: names(await listPins(engine, { states: ['inactive', 'archived'] })),
      sourcesStates: names(await listPins(engine, { sourceIds: ['alpha'], states: ['archived'] })),
      statesBeatTheFlag: names(await listPins(engine, { states: ['active'], includeArchived: true })),
      noSources: names(await listPins(engine, { sourceIds: [] })),
      noStates: names(await listPins(engine, { states: [] })),
      unknownSource: names(await listPins(engine, { sourceIds: ['nowhere'] })),
    };
    expect(out.all).toEqual(['Zed:questions/z:active', 'alpha:questions/a:inactive', 'beta:questions/c:active']);
    return out;
  });

  parityTest('a state change bumps the revision; archiving drops the lease and stamps archived_at once; unarchiving clears it', {
    methods: ['insertPinRow', 'updatePinRowState', 'acquirePinLease', 'readPinRow'],
  }, async (engine) => {
    const { row } = await insertPin(engine, pin('questions/s', { state: 'inactive', inactiveReason: 'awaiting_consent', publishMode: 'draft' }));
    const trail: unknown[] = [view(row)];
    const step = async (patch: Parameters<typeof updatePinState>[2]) => { trail.push(view(await updatePinState(engine, row.id, patch))); };
    await step({ state: 'active', inactiveReason: null });
    await acquireLease(engine, row.id, 'tok-1', 'worker', 600_000);
    trail.push(view(await getPin(engine, 'default', 'questions/s')));
    await step({ publishMode: 'publish' });
    const archived = await updatePinState(engine, row.id, { state: 'archived' });
    trail.push(view(archived));
    await sleep(15);
    const stillArchived = await updatePinState(engine, row.id, { state: 'archived', inactiveReason: 'migrated_disabled' });
    expect(stillArchived.archived_at!.getTime()).toBe(archived.archived_at!.getTime());
    trail.push(view(stillArchived));
    await step({ state: 'active', inactiveReason: null });
    await step({});
    return trail;
  });

  parityTest('the refresh lease: a live lease refuses a second taker, the wrong token releases nothing, an expired lease is taken over', {
    methods: ['insertPinRow', 'acquirePinLease', 'releasePinLease', 'readPinRow', 'updatePinRowState'],
  }, async (engine) => {
    const { row } = await insertPin(engine, pin('questions/l'));
    const read = async () => view(await getPin(engine, 'default', 'questions/l'));
    const first = await acquireLease(engine, row.id, 'tok-1', 'worker-1', 600_000);
    const ttl = first!.lease_expires_at!.getTime() - first!.last_attempt_at!.getTime();
    const second = await acquireLease(engine, row.id, 'tok-2', 'worker-2', 600_000);
    await releaseLease(engine, row.id, 'wrong-token', { error: 'ignored', spendUsd: 5 });
    const afterWrong = await read();
    await releaseLease(engine, row.id, 'tok-1', { error: 'refresh_failed:parse', spendUsd: 0.25 });
    const released = await read();
    const third = await acquireLease(engine, row.id, 'tok-3', 'worker-3', 20);
    await sleep(80);
    const takeover = await acquireLease(engine, row.id, 'tok-4', 'worker-4', 600_000);
    const afterTakeover = await read();
    await updatePinState(engine, row.id, { state: 'archived' });
    const onArchived = await acquireLease(engine, row.id, 'tok-5', 'worker-5', 600_000);
    const unknown = await acquireLease(engine, row.id + 1000, 'tok-6', 'worker-6', 600_000);
    expect(second).toBeNull();
    return {
      first: view(first), ttl, second, afterWrong, released, third: view(third), takeover: view(takeover), afterTakeover,
      onArchived, unknown,
    };
  });

  parityTest('spend adds as doubles, from a lease release and on its own; a zero spend is not sent', {
    methods: ['insertPinRow', 'addPinSpend', 'acquirePinLease', 'releasePinLease', 'readPinRow'],
  }, async (engine) => {
    const { row } = await insertPin(engine, pin('questions/m'));
    await addSpend(engine, row.id, 0.1);
    await addSpend(engine, row.id, 0.2);
    await addSpend(engine, row.id, 0);
    await addSpend(engine, row.id, -1);
    const afterAdds = (await getPin(engine, 'default', 'questions/m'))!.spend_usd;
    await acquireLease(engine, row.id, 'tok', 'worker', 600_000);
    await releaseLease(engine, row.id, 'tok', { error: null, spendUsd: 1e-7 });
    const afterRelease = await getPin(engine, 'default', 'questions/m');
    expect(afterAdds).toBe(0.1 + 0.2);
    expect(afterRelease!.spend_usd).toBe(0.1 + 0.2 + 1e-7);
    return { afterAdds, afterRelease: view(afterRelease) };
  });

  parityTest('the blocked record stamps the attempt and the cause unless a live lease holds the pin; an expired lease does not hold it', {
    methods: ['insertPinRow', 'recordPinBlocked', 'acquirePinLease', 'readPinRow'],
  }, async (engine) => {
    const { row } = await insertPin(engine, pin('questions/k'));
    const read = async () => view(await getPin(engine, 'default', 'questions/k'));
    await engine.recordPinBlocked(row.id, 'budget_exhausted');
    const free = await read();
    await acquireLease(engine, row.id, 'tok', 'worker', 600_000);
    await engine.recordPinBlocked(row.id, 'never_written');
    const held = await read();
    await acquireLease(engine, row.id + 1000, 'tok', 'worker', 600_000);
    await engine.recordPinBlocked(row.id + 1000, 'unknown_pin');
    const expiring = await insertPin(engine, pin('questions/k2'));
    await acquireLease(engine, expiring.row.id, 'tok', 'worker', 15);
    await sleep(80);
    await engine.recordPinBlocked(expiring.row.id, 'after_expiry');
    const expired = view(await getPin(engine, 'default', 'questions/k2'));
    expect([free!.last_error, held!.last_error, expired!.last_error]).toEqual(['budget_exhausted', 'budget_exhausted', 'after_expiry']);
    return { free, held, expired };
  });

  const answer = JSON.stringify([{ id: 's1', text: 'Alice leads acme-example.', origin: 'model' }]);
  const ev = (questionId: number, answerRevision: number, sentenceId: string, over: Record<string, unknown> = {}) => ({
    questionId, answerRevision, sentenceId, kind: 'page', sourceId: 'default', pageId: null, pageSlug: null, pageGeneration: null,
    pageRevision: null, itemId: null, contentHash: null, ...over,
  }) as never;

  parityTest('a publication inside engine.transaction: lock, answer, then the evidence rewrite; the second one replaces the first', {
    methods: ['insertPinRow', 'acquirePinLease', 'lockPinRowForPublish', 'publishPinAnswer', 'deleteQuestionEvidence', 'insertQuestionEvidence',
      'listQuestionEvidenceJoin', 'readPinRow'],
  }, async (engine) => {
    const { row } = await insertPin(engine, pin('questions/p'));
    const leased = await acquireLease(engine, row.id, 'tok-1', 'worker', 600_000);
    const publish = (token: string, revision: number, spend: number) => engine.transaction(async (tx) => {
      const locked = await tx.lockPinRowForPublish(row.id);
      await tx.publishPinAnswer(row.id, { answer, answerModel: 'test-model', watermarkGeneration: 12, watermarkFactId: 99, spendUsd: spend });
      await tx.deleteQuestionEvidence(row.id);
      await tx.insertQuestionEvidence([ev(row.id, revision, 's1', { kind: 'owner', pageSlug: 'questions/p' }), ev(row.id, revision, 's1', { kind: 'fact', itemId: 5, contentHash: 'h5' })]);
      return { locked, token };
    });
    const first = await publish('tok-1', 1, 0.125);
    const afterFirst = await getPin(engine, 'default', 'questions/p');
    const joinFirst = (await engine.listQuestionEvidenceJoin(row.id, 1)).map(r => ({ sentence_id: r.sentence_id, kind: r.kind, item: r.f_id === null ? null : 'fact' }));
    await acquireLease(engine, row.id, 'tok-2', 'worker', 600_000);
    const second = await publish('tok-2', 2, 0.25);
    const afterSecond = await getPin(engine, 'default', 'questions/p');
    const stale = await engine.listQuestionEvidenceJoin(row.id, 1);
    const current = (await engine.listQuestionEvidenceJoin(row.id, 2)).map(r => r.kind).sort();
    const missing = await engine.transaction(tx => tx.lockPinRowForPublish(row.id + 1000));
    expect(leased!.revision).toBe(1);
    expect(afterFirst!.answer_revision).toBe(1);
    expect(afterFirst!.lease_token).toBeNull();
    expect(afterSecond!.answer_revision).toBe(2);
    return { first, afterFirst: view(afterFirst), joinFirst, second, afterSecond: view(afterSecond), stale, current, missing };
  });

  parityTest('a publication that fails after its answer write rolls back the answer and the evidence together', {
    methods: ['insertPinRow', 'acquirePinLease', 'lockPinRowForPublish', 'publishPinAnswer', 'deleteQuestionEvidence', 'insertQuestionEvidence',
      'listQuestionEvidenceJoin', 'readPinRow'],
  }, async (engine) => {
    const { row } = await insertPin(engine, pin('questions/r'));
    await acquireLease(engine, row.id, 'tok-1', 'worker', 600_000);
    await engine.transaction(async (tx) => {
      await tx.publishPinAnswer(row.id, { answer, answerModel: 'm', watermarkGeneration: 1, watermarkFactId: 1, spendUsd: 0 });
      await tx.insertQuestionEvidence([ev(row.id, 1, 's1', { kind: 'owner' })]);
    });
    await acquireLease(engine, row.id, 'tok-2', 'worker', 600_000).catch(() => null);
    const failed = await engine.transaction(async (tx) => {
      await tx.lockPinRowForPublish(row.id);
      await tx.publishPinAnswer(row.id, { answer: '[]', answerModel: 'other', watermarkGeneration: 2, watermarkFactId: 2, spendUsd: 3 });
      await tx.deleteQuestionEvidence(row.id);
      await tx.insertQuestionEvidence([ev(row.id, 2, 's2', { kind: 'owner' })]);
      throw new Error('the publication failed after the answer write');
    }).then(() => 'committed', (e: Error) => e.message);
    const after = await getPin(engine, 'default', 'questions/r');
    const evidence = (await engine.listQuestionEvidenceJoin(row.id, 1)).map(r => r.sentence_id);
    const lost = await engine.listQuestionEvidenceJoin(row.id, 2);
    expect(failed).toBe('the publication failed after the answer write');
    expect(after!.answer.map(s => s.id)).toEqual(['s1']);
    expect(after!.answer_revision).toBe(1);
    return { failed, after: view(after), evidence, lost };
  });

  parityTest('the evidence join resolves each pointer to its page, fact, timeline entry or take; the published answers cite the current revision', {
    methods: ['insertPinRow', 'acquirePinLease', 'lockPinRowForPublish', 'publishPinAnswer', 'deleteQuestionEvidence', 'insertQuestionEvidence',
      'listQuestionEvidenceJoin', 'listPublishedQuestionAnswers'],
  }, async (engine, backend) => {
    const live = await engine.putPage('projects/live', page('live'));
    const gone = await engine.putPage('projects/gone', page('gone'));
    const owner = await engine.putPage('questions/j', page('j', { type: 'question' }));
    await engine.putPage('notes/quarantined', page('quarantined', { frontmatter: { quarantine: { reason: 'parity' } } }));
    await createSource(engine, backend, 'arch');
    const filed = await engine.putPage('projects/filed', page('filed'), { sourceId: 'arch' });
    await archiveSource(engine, backend, 'arch');
    await engine.softDeletePage('projects/gone');
    await engine.addTimelineEntry('projects/live', { date: '2026-01-02', summary: 'founded', detail: 'in a garage' });
    await engine.addTakesBatch([
      { page_id: live.id, row_num: 1, claim: 'live will win.', kind: 'take', holder: 'people/b-example', weight: 0.7 },
      { page_id: live.id, row_num: 2, claim: 'live will stall.', kind: 'hunch', holder: 'people/c-example', weight: 1 },
      { page_id: live.id, row_num: 3, claim: 'live was right.', kind: 'take', holder: 'people/d-example', weight: 0.25 },
    ] as never);
    await engine.resolveTake(live.id, 3, { quality: 'correct', resolvedBy: 'people/d-example' });
    const day = new Date(Date.UTC(2026, 0, 3));
    const fact = (row_num: number, text: string, over: Record<string, unknown> = {}) =>
      ({ fact: text, kind: 'fact', visibility: 'world', notability: 'medium', source: 'test', entity_slug: 'people/alice-example', row_num,
        source_markdown_slug: 'projects/live', valid_from: day, ...over });
    const inserted = await engine.insertFacts([
      fact(1, 'alice leads live'), fact(2, 'alice joined live'), fact(3, 'alice left live', { valid_until: new Date(Date.UTC(2026, 0, 4)) }),
      fact(4, 'alice quoted a quarantined note', { source_markdown_slug: 'notes/quarantined' }), fact(5, 'alice was replaced'),
    ] as never, { source_id: 'default' });
    const [f1, f2, f3, f4, f5] = inserted.ids as [number, number, number, number, number];
    await engine.expireFact(f2);
    await engine.expireFact(f5, { supersededBy: f1 });
    const hashes = new Map((await engine.listQuestionEvidenceFacts('default', ['people/alice-example'])).map(r => [r.id, r.hash]));
    const entry = (await engine.getTimeline('projects/live'))[0]!;
    const takes = await engine.listTakes({ page_id: live.id } as never);
    const takeId = (n: number) => takes.find(t => t.row_num === n)!.id;
    const sources = new Map<number, string>([[live.id, 'live'], [gone.id, 'gone'], [owner.id, 'owner'], [filed.id, 'filed']]);
    const { row } = await insertPin(engine, pin('questions/j'));
    const other = await insertPin(engine, pin('questions/o', { sourceId: 'work' }));
    const unanswered = await insertPin(engine, pin('questions/u'));
    await acquireLease(engine, row.id, 'tok', 'worker', 600_000);
    await acquireLease(engine, other.row.id, 'tok', 'worker', 600_000);
    const e = (sentenceId: string, kind: string, over: Record<string, unknown>) => ev(row.id, 1, sentenceId, { kind, ...over });
    const bodyHash = (await import('node:crypto')).createHash('md5').update('body of j', 'utf8').digest('hex');
    await engine.transaction(async (tx) => {
      await tx.lockPinRowForPublish(row.id);
      await tx.publishPinAnswer(row.id, { answer, answerModel: 'test-model', watermarkGeneration: 3, watermarkFactId: f5, spendUsd: 0 });
      await tx.deleteQuestionEvidence(row.id);
      await tx.insertQuestionEvidence([
        e('s1', 'page', { pageId: live.id, pageSlug: 'projects/live', pageGeneration: 1, pageRevision: null }),
        e('s1', 'owner', { pageId: owner.id, pageSlug: 'questions/j', contentHash: bodyHash }),
        e('s2', 'page', { pageId: gone.id, pageSlug: 'projects/gone', pageGeneration: 1 }),
        e('s2', 'page', { pageId: filed.id, pageSlug: 'projects/filed', pageGeneration: 1, sourceId: 'arch' }),
        e('s2', 'page', { pageId: 99999, pageSlug: 'projects/missing', pageGeneration: 1 }),
        e('s3', 'fact', { itemId: f1, contentHash: hashes.get(f1) ?? 'x' }),
        e('s3', 'fact', { itemId: f2, contentHash: 'x' }),
        e('s3', 'fact', { itemId: f3, contentHash: 'x' }),
        e('s3', 'fact', { itemId: f4, contentHash: 'x' }),
        e('s3', 'fact', { itemId: f5, contentHash: 'x' }),
        e('s3', 'fact', { itemId: 98765, contentHash: 'x' }),
        e('s3', 'fact', { itemId: f1, sourceId: 'other-source', contentHash: 'x' }),
        e('s4', 'timeline', { pageId: live.id, itemId: entry.id, contentHash: 'x' }),
        e('s4', 'timeline', { pageId: live.id, itemId: 424242, contentHash: 'x' }),
        e('s5', 'take', { pageId: live.id, itemId: takeId(1), contentHash: 'x' }),
        e('s5', 'take', { pageId: live.id, itemId: takeId(3), contentHash: 'x' }),
        e('s5', 'take', { pageId: live.id, itemId: 515151, contentHash: 'x' }),
      ]);
    });
    // A row of an older answer revision stays out of both reads.
    await engine.transaction(async (tx) => { await tx.insertQuestionEvidence([ev(row.id, 0, 'old', { kind: 'page', pageId: gone.id })]); });
    await engine.transaction(async (tx) => {
      await tx.lockPinRowForPublish(other.row.id);
      await tx.publishPinAnswer(other.row.id, { answer, answerModel: 'm', watermarkGeneration: 1, watermarkFactId: 1, spendUsd: 0 });
      await tx.insertQuestionEvidence([ev(other.row.id, 1, 's1', { kind: 'page', pageId: live.id })]);
    });
    const label = (id: unknown) => (id === null || id === undefined ? null : sources.get(Number(id)) ?? `page ${id}`);
    const facts = new Map<number, string>([[f1, 'f1'], [f2, 'f2'], [f3, 'f3'], [f4, 'f4'], [f5, 'f5']]);
    const itemLabel = (m: Map<number, string>) => (id: unknown) => (id === null || id === undefined ? null : m.get(Number(id)) ?? `no row ${id}`);
    const takeLabels = new Map<number, string>(takes.map(t => [t.id, `take ${t.row_num}`]));
    const timelineLabels = new Map<number, string>([[entry.id, 'entry']]);
    const joined = (await engine.listQuestionEvidenceJoin(row.id, 1)).map((r) => {
      const gen = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      return {
        sentence: r.sentence_id, kind: r.kind, source_id: r.source_id, page: label(r.page_id), page_generation: gen(r.page_generation), page_revision: r.page_revision,
        content_hash: r.content_hash === hashes.get(f1) ? 'hash of f1' : r.content_hash,
        p: label(r.p_id), p_revision: typeof r.p_revision, p_deleted: r.p_deleted === null ? null : 'time', p_source_archived: r.p_source_archived,
        p_body_hash: r.p_body_hash === bodyHash ? 'hash of the body' : r.p_body_hash === null ? null : typeof r.p_body_hash,
        f: itemLabel(facts)(r.f_id), f_expired: r.f_expired === null ? null : 'time', f_valid_until_passed: r.f_valid_until_passed,
        f_superseded: itemLabel(facts)(r.f_superseded), f_hash: r.f_hash === hashes.get(f1) ? 'hash of f1' : r.f_hash,
        f_source_quarantined: r.f_source_quarantined,
        t: itemLabel(timelineLabels)(r.t_id), t_hash: r.t_hash,
        k: itemLabel(takeLabels)(r.k_id), k_active: r.k_active, k_superseded: r.k_superseded, k_hash: r.k_hash,
        // PLACEHOLDER (lane 15 merge): pages.generation is a clock over every page write on the SQL engines (the first page written
        // is 1, the fifth is 5), and the Rust store reads every page as 1 until the counter lands (`page_generation` in
        // questions/join.rs). Only the first page written is compared by value; the others by type. Compare every one once it lands.
        p_generation: label(r.p_id) === 'live' ? gen(r.p_generation) : typeof gen(r.p_generation),
      };
    }).sort((a, b) => `${a.sentence}|${a.kind}|${a.page}|${a.f}|${a.t}|${a.k}`.localeCompare(`${b.sentence}|${b.kind}|${b.page}|${b.f}|${b.t}|${b.k}`));
    const published = (await engine.listPublishedQuestionAnswers('default')).map(r => ({
      answer: r.answer, published_at: r.published_at instanceof Date ? 'time' : typeof r.published_at, cited: r.cited.map(id => label(id)).sort(),
    }));
    const publishedWork = (await engine.listPublishedQuestionAnswers('work')).map(r => ({ answer: r.answer, cited: r.cited.map(id => label(id)).sort() }));
    expect(unanswered.row.id).toBeGreaterThan(0);
    expect(joined.length).toBe(17);
    return { joined, published, publishedWork };
  });
});
