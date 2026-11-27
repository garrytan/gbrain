/**
 * BrainEngine parity: the fact purge's transaction members (src/core/engine-sql/facts-purge.ts, `submitPurgeFactMutation`
 * and the body rewrites of src/core/facts/purge.ts), each in a case that seeds and reads through typed members only, so
 * the Rust arm compares every case instead of stopping at a raw fixture.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listPurgeStreamSlugs, deletePurgedFacts, listPurgedPageRevisions, listPagesForPurgeRewrite,
 *    deletePurgedTakes, deletePurgeTrustProposals, deletePurgeOpenLoops, deletePurgeWriteGateHolds,
 *    deletePurgeWriteGateReceipts, updatePageBodyForPurge, setPurgeVersionBody, redactVersionChangeReasons,
 *    deletePurgedChunks, expireDerivedFacts, deactivateDerivedTakes, softDeleteDerivedPages, findPurgeBlockedPublication, insertPurgeEffects, deletePurgedStagingParts,
 *    deletePageViewDigests, deletePurgeTakeProposals, markNeedsRederive, pageAwaitsRederive,
 *    listSegmentedVersionsForPurge, abortPurgedStagings and deleteUnreferencedPurgedTexts return the same observable result on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes which belief streams a purge rebuilds, which
 *    facts, takes and page bodies it deletes or rewrites, and what its receipt counts. On the Rust engine these members
 *    refused, so a fact purge stopped in its transaction.
 *  - Why existing coverage misses it: fact-purge-sites.test.ts compares these members next to the purge members of the
 *    page purge lane and four raw fixtures, so on Rust every case there stops at the first one the store does not serve.
 *  - Seam: the raw-only case reads the repository's source files to pin the writers of two tables; the last case calls
 *    executeRaw (requires raw_sql), which the Rust arm must refuse. Otherwise none. Facts, takes, pages and tags are seeded through typed members (insertFact, insertFacts, putPage, addTag,
 *    softDeletePage, addTakesBatch, insertTrustProposal, upsertOpenLoop, upsertWriteGateHold, upsertWriteGateReceipt) and read
 *    back through typed members (listFactsSince, listTakes, listTrustProposals, listOpenLoops, listWriteGateHoldRows,
 *    listWriteGateReceiptsFor). Generated ids and
 *    revisions are compared by name or by relation, never by value.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { hexOf, pageMeta, publishSegmentedPage, segmentText, stageGeneration, stagingInput } from '../helpers/page-body-fixtures.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { derivedRowsFrom, hideDerivedRows, recordDerivationInputs } from '../../src/core/facts/derivation-inputs.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: body, timeline: '', frontmatter });

const REQ = 'b0000000-0000-4000-8000-0000000000b1';
const REQ2 = 'b0000000-0000-4000-8000-0000000000b2';
const REQ3 = 'b0000000-0000-4000-8000-0000000000b3';
const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];

/** One write request of the default source in `state`; returns its journal id. */
async function admit(engine: BrainEngine, requestId: string, over: { operation?: string; slug?: string; state?: string } = {}): Promise<string> {
  const source = await engine.readSourceMembership(SRC);
  await engine.lockPersistenceCounters(KEYS);
  const slug = over.slug ?? 'notes/a';
  return (await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation: over.operation ?? 'put_page', sourceId: SRC,
    sourceIncarnation: source!.incarnation, pageId: null, slug, worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: { kind: 'put_page', slug }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: over.state ?? 'queued', deferredRefreshId: null,
  } as never)).id;
}

/** The two tables the purge clears that only an `executeRaw` insert writes, and the files of those inserts. */
const RAW_ONLY_WRITERS: Record<string, string[]> = {
  page_body_staging_parts: ['src/core/persistence/page-upload.ts'],
  page_view_digests: ['src/core/engine-sql/page-view-digests.ts'],
};

/** Every file under `dir` with one of `exts`, repo-relative. */
function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, exts));
    else if (exts.some(ext => name.endsWith(ext))) out.push(path);
  }
  return out;
}

/** Each raw-only table's writers in src/ and the Rust crates: the files that insert into it, and whether each sends it through executeRaw. */
function rawOnlyWriters(): Record<string, Array<{ file: string; executeRaw: boolean }>> {
  const files = [...filesUnder('src', ['.ts']), ...filesUnder('rust/crates', ['.rs'])];
  const out: Record<string, Array<{ file: string; executeRaw: boolean }>> = {};
  for (const table of Object.keys(RAW_ONLY_WRITERS)) {
    out[table] = files.filter(f => readFileSync(f, 'utf8').includes(`INSERT INTO ${table}`)).sort()
      .map(file => ({ file, executeRaw: /executeRaw/.test(readFileSync(file, 'utf8')) }));
  }
  return out;
}

async function fact(engine: BrainEngine, text: string, extra: Record<string, unknown> = {}, sourceId = SRC): Promise<number> {
  const out = await engine.insertFact({ fact: text, entity_slug: null, visibility: 'private', source: 'hook:agent-session', embedding: null, ...extra } as NewFact,
    { source_id: sourceId });
  expect(out.status).toBe('inserted');
  return Number(out.id);
}

/** What each fact says and whether it is still stored and live, by its text. */
async function factsLeft(engine: BrainEngine, sourceId = SRC): Promise<Record<string, boolean>> {
  const all = await engine.listFactsSince(sourceId, new Date(0), { activeOnly: false, limit: 1000 } as never);
  return Object.fromEntries(all.map(f => [f.fact, f.expired_at == null]).sort(([a], [b]) => String(a).localeCompare(String(b))));
}

describe('engine parity: the fact purge transaction members', () => {
  parityTest('listPurgeStreamSlugs names the holding page, else the entity, of each fact; deletePurgedFacts deletes the named facts of one source', {
    methods: ['insertFact', 'insertFacts', 'expireFact', 'listFactsSince', 'transaction', 'listPurgeStreamSlugs', 'deletePurgedFacts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const [held] = (await engine.insertFacts([{ fact: 'Alice likes tea', entity_slug: 'people/alice', kind: 'fact', visibility: 'private', source: 'fence',
      row_num: 1, source_markdown_slug: 'notes/holding' }] as never, { source_id: SRC })).ids.map(Number);
    const aboutBob = await fact(engine, 'Bob likes tea', { entity_slug: 'people/bob' });
    const unnamed = await fact(engine, 'tea with no subject');
    const expired = await fact(engine, 'old tea habit', { entity_slug: 'people/alice' });
    await engine.expireFact(expired);
    const elsewhere = await fact(engine, 'Carol likes tea', { entity_slug: 'people/carol' }, 'other');
    const answers = {
      slugs: await engine.transaction(tx => tx.listPurgeStreamSlugs([held!, aboutBob, unnamed, expired, elsewhere, 987_654_321])),
      unnamedOnly: await engine.transaction(tx => tx.listPurgeStreamSlugs([unnamed])),
      noIds: await engine.transaction(tx => tx.listPurgeStreamSlugs([])),
      deleted: await engine.transaction(tx => tx.deletePurgedFacts([held!, aboutBob, expired, elsewhere, 987_654_321], SRC)),
      wrongSource: await engine.transaction(tx => tx.deletePurgedFacts([unnamed], 'other')),
      none: await engine.transaction(tx => tx.deletePurgedFacts([], SRC)),
      left: await factsLeft(engine),
      leftOther: await factsLeft(engine, 'other'),
    };
    answers.slugs = [...answers.slugs].sort();
    expect(answers).toEqual({
      slugs: ['notes/holding', 'people/alice', 'people/bob', 'people/carol'], unnamedOnly: [], noIds: [],
      deleted: 3, wrongSource: 0, none: 0, left: { 'tea with no subject': true }, leftOther: { 'Carol likes tea': true },
    });
    return answers;
  });

  parityTest('listPurgedPageRevisions and listPagesForPurgeRewrite read the named pages of one source, deleted ones too, by slug', {
    methods: ['putPage', 'addTag', 'softDeletePage', 'getPage', 'listPurgedPageRevisions', 'listPagesForPurgeRewrite'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const b = await engine.putPage('notes/b', note('B', 'nothing here'));
    const a = await engine.putPage('notes/a', note('A', 'Tea and milk', { topic: 'drinks' }));
    const gone = await engine.putPage('notes/gone', note('Gone', 'deleted body'));
    await engine.softDeletePage('notes/gone');
    const elsewhere = await engine.putPage('notes/c', note('C', 'in another source'), { sourceId: 'other' } as never);
    await engine.addTag('notes/a', 'zeta');
    await engine.addTag('notes/a', 'alpha');
    const name = new Map([[Number(a.id), 'a'], [Number(b.id), 'b'], [Number(gone.id), 'gone'], [Number(elsewhere.id), 'c']]);
    const ids = [Number(b.id), Number(a.id), Number(gone.id), Number(elsewhere.id), 987_654];
    const revisions = await engine.listPurgedPageRevisions(SRC, ids);
    const rewrite = await engine.listPagesForPurgeRewrite(SRC, ids);
    const current = (await engine.getPage('notes/a'))!;
    const answers = {
      revisions: revisions.map(r => ({ name: name.get(Number(r.id)), slug: r.slug, uuid: UUID.test(String(r.knowledge_revision)) })),
      aRevisionIsCurrent: revisions.find(r => r.slug === 'notes/a')?.knowledge_revision === (current as { knowledge_revision?: string }).knowledge_revision,
      rewrite: rewrite.map(r => ({ name: name.get(Number(r.id)), slug: r.slug, type: r.type, title: r.title, compiled: r.compiled_truth, timeline: r.timeline,
        frontmatter: r.frontmatter, tags: r.purge_tags, deleted: r.deleted_at instanceof Date, created: r.created_at instanceof Date })),
      none: [await engine.listPurgedPageRevisions(SRC, []), await engine.listPagesForPurgeRewrite(SRC, []),
        await engine.listPurgedPageRevisions(SRC, [Number(elsewhere.id)]), await engine.listPagesForPurgeRewrite(SRC, [Number(elsewhere.id)])],
    };
    expect(answers.revisions.map(r => r.slug)).toEqual(['notes/a', 'notes/b', 'notes/gone']);
    expect(answers.revisions.every(r => r.uuid)).toBe(true);
    expect(answers.rewrite.map(r => r.tags)).toEqual([['alpha', 'zeta'], [], []]);
    expect(answers.rewrite.map(r => r.deleted)).toEqual([false, false, true]);
    expect(answers.none).toEqual([[], [], [], []]);
    return answers;
  });

  parityTest('deletePurgedTakes deletes the named takes and leaves the rest', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'transaction', 'deletePurgedTakes'],
  }, async (engine) => {
    const page = Number((await engine.putPage('people/a', note('A', 'a person'))).id);
    const take = (row_num: number, claim: string) => ({ page_id: page, row_num, claim, kind: 'take', holder: 'self', weight: 0.5, since_date: '2026-01-01', source: 'parity' }) as never;
    await engine.addTakesBatch([take(1, 'Alice likes tea'), take(2, 'Alice likes coffee'), take(3, 'Alice likes jam')]);
    const byClaim = new Map((await engine.listTakes({ page_id: page } as never)).map(t => [t.claim, Number(t.id)]));
    const answers = {
      deleted: await engine.transaction(tx => tx.deletePurgedTakes([byClaim.get('Alice likes tea')!, byClaim.get('Alice likes jam')!, 987_654_321])),
      again: await engine.transaction(tx => tx.deletePurgedTakes([byClaim.get('Alice likes tea')!])),
      none: await engine.transaction(tx => tx.deletePurgedTakes([])),
      left: (await engine.listTakes({ page_id: page } as never)).map(t => ({ claim: t.claim, row: t.row_num })),
    };
    expect(answers).toEqual({ deleted: 2, again: 0, none: 0, left: [{ claim: 'Alice likes coffee', row: 2 }] });
    return answers;
  });
  parityTest('the trust proposal, open loop and write gate deletes remove the rows that name the purged facts and takes, and leave the rest', {
    methods: ['insertFact', 'putPage', 'addTakesBatch', 'listTakes', 'loadPurgeTarget', 'insertTrustProposal', 'upsertOpenLoop', 'upsertWriteGateHold',
      'upsertWriteGateReceipt', 'listTrustProposals', 'listOpenLoops', 'listWriteGateHoldRows', 'listWriteGateReceiptsFor', 'transaction', 'deletePurgedTakes',
      'deletePurgeTrustProposals', 'deletePurgeOpenLoops', 'deletePurgeWriteGateHolds', 'deletePurgeWriteGateReceipts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const purged = await fact(engine, 'Alice likes tea', { entity_slug: 'people/a' });
    const coffee = await fact(engine, 'Alice likes coffee', { entity_slug: 'people/a' });
    const other = await fact(engine, 'Bob likes jam', { entity_slug: 'people/b' });
    const page = Number((await engine.putPage('people/a', note('A', 'a person'))).id);
    const take = (row_num: number, claim: string) => ({ page_id: page, row_num, claim, kind: 'take', holder: 'self', weight: 0.5, since_date: '2026-01-01', source: 'parity' }) as never;
    await engine.addTakesBatch([take(1, 'Alice likes tea'), take(2, 'Alice likes coffee')]);
    const takes = await engine.listTakes({ page_id: page } as never);
    const tea = Number(takes.find(t => t.claim === 'Alice likes tea')!.id);
    const keep = Number(takes.find(t => t.claim === 'Alice likes coffee')!.id);
    const hash = (await engine.loadPurgeTarget(purged, SRC))!.fact_hash;
    const factName = new Map([[purged, 'purged'], [coffee, 'coffee'], [other, 'other']]);
    const takeName = new Map([[tea, 'tea'], [keep, 'keep']]);
    const fname = (id: number | string | null) => factName.get(Number(id)) ?? `unknown:${id}`;
    const tname = (id: number | string | null) => takeName.get(Number(id)) ?? `unknown:${id}`;
    // Trust proposals name facts and takes as target or related row; one names a purged fact in another source.
    await engine.insertTrustProposal({ action: 'supersede_fact', sourceId: SRC, target: { table: 'facts', id: purged }, related: { table: 'facts', id: other }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'confirm', sourceId: SRC, target: { table: 'facts', id: other }, related: { table: 'facts', id: purged }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'takes', id: tea }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'takes', id: keep }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'facts', id: coffee }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'forget', sourceId: 'other', target: { table: 'facts', id: purged }, before: {}, proposer: 'parity' });
    const at = '2026-03-01T10:00:00.000Z';
    for (const [key, id, sourceId] of [['loop-purged', purged, SRC], ['loop-coffee', coffee, SRC], ['loop-elsewhere', purged, 'other']] as const) {
      await engine.upsertOpenLoop({ sourceId, dedupKey: key, loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com', summary: key, evidence: [],
        detector: 'manual', factId: id, lastActivityAt: at, openedAt: at });
    }
    // Held writes match by the fingerprint of their fact, else their claim, text (case and spacing folded).
    const hold = (fingerprint: string, payload: Record<string, unknown>, kind: 'fact' | 'take' = 'fact', sourceId = SRC) => engine.upsertWriteGateHold({ kind, source_id: sourceId,
      slug: 'people/a', fingerprint, detector_version: 1, tier: 'agent_written', reason_families: ['prompt_injection'], reasons: ['ignore previous instructions'],
      detector_error: false, payload, write_origin: null, request_id: null });
    const heldFact = await hold('fp-fact', { fact: 'alice  LIKES tea' });
    const heldClaim = await hold('fp-claim', { claim: 'Alice likes tea' }, 'take');
    const heldOther = await hold('fp-other', { fact: 'Alice likes coffee' });
    const heldElsewhere = await hold('fp-elsewhere', { fact: 'Alice likes tea' }, 'fact', 'other');
    const heldEmpty = await hold('fp-empty', {});
    const holdName = new Map([[heldFact, 'heldFact'], [heldClaim, 'heldClaim'], [heldOther, 'heldOther'], [heldElsewhere, 'heldElsewhere'], [heldEmpty, 'heldEmpty']]);
    const receipt = (table: 'facts' | 'takes' | 'write_gate_holds', id: number) => engine.upsertWriteGateReceipt({ target_table: table, target_id: String(id), source_id: SRC,
      content_hash: `h-${table}-${id}`, tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: ['standing_instruction'], reasons: ['r'], detector_error: false, request_id: null });
    for (const id of [purged, coffee]) await receipt('facts', id);
    for (const id of [tea, keep]) await receipt('takes', id);
    for (const id of [heldFact, heldClaim, heldOther]) await receipt('write_gate_holds', id);

    const state = async () => {
      const receiptCount = async (table: string, id: number, name: (id: number) => string) => [`${table}:${name(id)}`, (await engine.listWriteGateReceiptsFor(table, String(id), 10)).length];
      return {
        trust: (await engine.listTrustProposals({ status: 'all' })).map(r => [r.source_id, r.action, r.target_table, r.target_table === 'facts' ? fname(r.target_id) : tname(r.target_id),
          r.related_table, r.related_id === null ? null : fname(r.related_id)].join(' ')).sort(),
        loops: (await engine.listOpenLoops({ sourceIds: [SRC, 'other'] })).map(l => String(l.dedup_key)).sort(),
        holds: (await engine.listWriteGateHoldRows({ status: 'all', limit: 100 })).map(h => holdName.get(h.id) ?? `unknown:${h.id}`).sort(),
        receipts: [
          ...await Promise.all([purged, coffee].map(id => receiptCount('facts', id, fname))), ...await Promise.all([tea, keep].map(id => receiptCount('takes', id, tname))),
          ...await Promise.all([heldFact, heldClaim, heldOther].map(id => receiptCount('write_gate_holds', id, id2 => holdName.get(id2)!))),
        ],
        takes: (await engine.listTakes({ page_id: page } as never)).map(t => t.claim).sort(),
      };
    };
    const before = await state();
    const deleted = await engine.transaction(async tx => {
      const takesGone = await tx.deletePurgedTakes([tea]);
      const holds = await tx.deletePurgeWriteGateHolds(SRC, hash);
      return {
        takes: takesGone, trustProposals: await tx.deletePurgeTrustProposals(SRC, [purged], [tea]), openLoops: await tx.deletePurgeOpenLoops(SRC, [purged]),
        holds: holds.map(id => holdName.get(Number(id)) ?? `unknown:${id}`).sort(), receipts: await tx.deletePurgeWriteGateReceipts([String(purged)], [String(tea)], holds),
        none: [await tx.deletePurgeTrustProposals(SRC, [], []), await tx.deletePurgeOpenLoops(SRC, []), await tx.deletePurgeWriteGateHolds(SRC, 'no-such-hash'),
          await tx.deletePurgeWriteGateReceipts([], [], [])],
      };
    });
    const after = await state();
    expect(deleted).toEqual({ takes: 1, trustProposals: 3, openLoops: 1, holds: ['heldClaim', 'heldFact'], receipts: 4, none: [0, 0, [], 0] });
    expect(after.loops).toEqual(['loop-coffee', 'loop-elsewhere']);
    expect(after.holds).toEqual(['heldElsewhere', 'heldEmpty', 'heldOther']);
    expect(after.takes).toEqual(['Alice likes coffee']);
    return { before, deleted, after };
  });
  parityTest('updatePageBodyForPurge, setPurgeVersionBody and redactVersionChangeReasons rewrite a page body, a saved version body and the change reasons that quote a claim', {
    methods: ['putPage', 'getPage', 'createVersion', 'getVersions', 'listPageChangeReasons', 'transaction', 'updatePageBodyForPurge', 'setPurgeVersionBody',
      'redactVersionChangeReasons'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/a', note('A', 'Alice likes tea'));
    await engine.createVersion('notes/a', { sourceId: SRC, reason: 'noted ALICE likes tea' });
    await engine.createVersion('notes/a', { sourceId: SRC, reason: 'plain edit' });
    await engine.createVersion('notes/a', { sourceId: SRC, reason: 'folded alice-likes-tea' });
    await engine.putPage('notes/c', note('C', 'Alice likes tea'), { sourceId: 'other' } as never);
    await engine.createVersion('notes/c', { sourceId: 'other', reason: 'noted Alice likes tea' });
    const page = (await engine.getPage('notes/a'))!;
    const other = (await engine.getPage('notes/c', { sourceId: 'other' } as never))!;
    const versions = await engine.getVersions('notes/a', { sourceId: SRC });
    const target = versions.reduce((newest, v) => (v.id > newest.id ? v : newest));
    const reasons = async (slug: string, sourceId: string, pageId: number) =>
      (await engine.listPageChangeReasons(sourceId, slug, pageId)).map(r => r.reason).sort((x, y) => String(x).localeCompare(String(y)));
    const revision = (p: unknown) => (p as { knowledge_revision?: string } | null)?.knowledge_revision ?? null;
    const reasonsBefore = await reasons('notes/a', SRC, page.id);
    const redacted = await engine.transaction(async tx => {
      await tx.updatePageBodyForPurge(SRC, page.id, 'rewritten', 'a timeline', 'hash-after');
      await tx.updatePageBodyForPurge(SRC, other.id, 'not this source', '', 'hash-x');
      await tx.setPurgeVersionBody(target.id, 'version rewritten', null);
      await tx.setPurgeVersionBody(987_654_321, 'no such version', 'x');
      return tx.redactVersionChangeReasons(SRC, 'alice likes tea', 'alice-likes-tea');
    });
    const none = await engine.transaction(tx => tx.redactVersionChangeReasons(SRC, 'no such claim', 'no such reason'));
    const after = (await engine.getPage('notes/a'))!;
    const otherAfter = (await engine.getPage('notes/c', { sourceId: 'other' } as never))!;
    const answers = {
      redacted: redacted.length, redactedAreVersions: redacted.every(id => versions.some(v => Number(v.id) === Number(id))), none,
      page: { compiled: after.compiled_truth, timeline: after.timeline, hash: after.content_hash, revisionMoved: revision(after) !== revision(page) },
      other: { compiled: otherAfter.compiled_truth, revisionKept: revision(otherAfter) === revision(other) },
      reasonsBefore, reasons: await reasons('notes/a', SRC, page.id),
      bodies: (await engine.getVersions('notes/a', { sourceId: SRC })).map(v => [v.compiled_truth, v.timeline ?? null]).sort(),
      elsewhere: await reasons('notes/c', 'other', other.id),
    };
    expect(answers.redacted).toBe(2);
    expect(answers.none).toEqual([]);
    expect(answers.page).toEqual({ compiled: 'rewritten', timeline: 'a timeline', hash: 'hash-after', revisionMoved: true });
    expect(answers.other).toEqual({ compiled: 'Alice likes tea', revisionKept: true });
    expect(answers.reasons).toEqual(['[purged]', 'plain edit']);
    expect(answers.elsewhere).toEqual(['noted Alice likes tea']);
    return answers;
  });

  parityTest('deletePurgedChunks removes the chunks of the named pages and counts the chunks it deleted', {
    methods: ['putPage', 'upsertChunks', 'getChunks', 'transaction', 'deletePurgedChunks'],
  }, async (engine) => {
    const a = await engine.putPage('notes/a', note('A', 'body a'));
    const b = await engine.putPage('notes/b', note('B', 'body b'));
    const c = await engine.putPage('notes/c', note('C', 'body c'));
    await engine.upsertChunks('notes/a', [{ chunk_index: 0, chunk_text: 'a chunk', chunk_source: 'compiled_truth' }, { chunk_index: 1, chunk_text: 'a second', chunk_source: 'compiled_truth' }]);
    await engine.upsertChunks('notes/c', [{ chunk_index: 0, chunk_text: 'c chunk', chunk_source: 'compiled_truth' }]);
    const count = async (slug: string) => (await engine.getChunks(slug, { includeUnsealed: true })).length;
    const before = { a: await count('notes/a'), b: await count('notes/b'), c: await count('notes/c') };
    const chunks = await engine.transaction(async tx => ({ withChunks: await tx.deletePurgedChunks([Number(a.id), Number(b.id), 987_654]), again: await tx.deletePurgedChunks([Number(a.id)]),
      none: await tx.deletePurgedChunks([]) }));
    const answers = { before, chunks, after: { a: await count('notes/a'), b: await count('notes/b'), c: await count('notes/c') } };
    expect(answers.chunks).toEqual({ withChunks: 2, again: 0, none: 0 });
    expect(answers.after).toEqual({ a: 0, b: 0, c: before.c });
    return answers;
  });
  parityTest('expireDerivedFacts, deactivateDerivedTakes and softDeleteDerivedPages hide the named rows of one source and count what they touched', {
    methods: ['insertFact', 'expireFact', 'putPage', 'softDeletePage', 'addTakesBatch', 'listTakes', 'getPage', 'listFactsSince', 'transaction',
      'expireDerivedFacts', 'deactivateDerivedTakes', 'softDeleteDerivedPages'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const live = await fact(engine, 'derived live', { entity_slug: 'people/a' });
    const expired = await fact(engine, 'derived expired', { entity_slug: 'people/a' });
    await engine.expireFact(expired);
    const kept = await fact(engine, 'not derived', { entity_slug: 'people/a' });
    const elsewhere = await fact(engine, 'derived elsewhere', { entity_slug: 'people/a' }, 'other');
    const page = Number((await engine.putPage('notes/derived', note('Derived', 'body'))).id);
    const gone = Number((await engine.putPage('notes/gone', note('Gone', 'body'))).id);
    await engine.softDeletePage('notes/gone');
    const otherPage = Number((await engine.putPage('notes/other', note('Other', 'body'), { sourceId: 'other' } as never)).id);
    await engine.addTakesBatch([{ page_id: page, row_num: 1, claim: 'derived take', kind: 'fact', holder: 'self' } as never,
      { page_id: page, row_num: 2, claim: 'kept take', kind: 'fact', holder: 'self' } as never]);
    await engine.addTakesBatch([{ page_id: otherPage, row_num: 1, claim: 'other take', kind: 'fact', holder: 'self' } as never]);
    const takeId = async (pageId: number, claim: string) => Number((await engine.listTakes({ page_id: pageId } as never)).find(t => t.claim === claim)!.id);
    const derivedTake = await takeId(page, 'derived take');
    const otherTake = await takeId(otherPage, 'other take');
    const pageName = new Map([[page, 'derived'], [gone, 'gone'], [otherPage, 'other']]);
    const touched = await engine.transaction(async tx => ({
      facts: await tx.expireDerivedFacts([live, expired, elsewhere, 987_654_321], SRC),
      takes: await tx.deactivateDerivedTakes([derivedTake, otherTake, 987_654_321], SRC),
      pages: (await tx.softDeleteDerivedPages([page, gone, otherPage, 987_654], SRC)).map(r => ({ page: pageName.get(Number(r.id)), now: r.now })),
      none: [await tx.expireDerivedFacts([], SRC), await tx.deactivateDerivedTakes([], SRC), await tx.softDeleteDerivedPages([], SRC)],
    }));
    const again = await engine.transaction(async tx => ({
      facts: await tx.expireDerivedFacts([live], SRC), takes: await tx.deactivateDerivedTakes([derivedTake], SRC),
      pages: (await tx.softDeleteDerivedPages([page], SRC)).map(r => ({ page: pageName.get(Number(r.id)), now: r.now })),
    }));
    const all = await engine.listFactsSince(SRC, new Date(0), { activeOnly: false, limit: 100 } as never);
    const answers = {
      touched, again,
      facts: Object.fromEntries(all.map(f => [f.fact, f.expired_at != null]).sort(([x], [y]) => String(x).localeCompare(String(y)))),
      otherFacts: (await engine.listFactsSince('other', new Date(0), { activeOnly: false, limit: 100 } as never)).map(f => [f.fact, f.expired_at != null]),
      takes: (await engine.listTakes({ page_id: page } as never)).map(t => [t.claim, t.active]).sort(),
      otherTakes: (await engine.listTakes({ page_id: otherPage } as never)).map(t => [t.claim, t.active]),
      pages: { derived: (await engine.getPage('notes/derived')) === null, other: (await engine.getPage('notes/other', { sourceId: 'other' } as never)) === null },
    };
    expect(touched).toEqual({ facts: 2, takes: 1, pages: [{ page: 'derived', now: true }, { page: 'gone', now: false }], none: [0, 0, []] });
    expect(again).toEqual({ facts: 1, takes: 1, pages: [{ page: 'derived', now: false }] });
    expect(answers.facts).toEqual({ 'derived expired': true, 'derived live': true, 'not derived': false });
    expect(answers.otherFacts).toEqual([['derived elsewhere', false]]);
    expect(answers.pages).toEqual({ derived: true, other: false });
    void kept;
    return answers;
  });
  parityTest('findPurgeBlockedPublication finds an unfinished write or withdrawal mirror on a page that is not the purge\'s own request', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'insertWithdrawalEffects', 'transaction', 'findPurgeBlockedPublication'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await admit(engine, REQ, { slug: 'notes/a' });
    const own = await admit(engine, REQ2, { slug: 'notes/b', operation: 'purge_fact' });
    const mirror = await admit(engine, REQ3, { slug: 'notes/c', operation: 'forget_fact', state: 'committed' });
    await engine.insertWithdrawalEffects({ requestId: mirror, sourceId: SRC, targets: [{ slug: 'notes/d' } as never] });
    const answers = await engine.transaction(async tx => ({
      blocked: await tx.findPurgeBlockedPublication(SRC, ['notes/a', 'notes/b'], own),
      ownOnly: await tx.findPurgeBlockedPublication(SRC, ['notes/b'], own),
      committedRequest: await tx.findPurgeBlockedPublication(SRC, ['notes/c'], own),
      mirrorTarget: await tx.findPurgeBlockedPublication(SRC, ['notes/d'], own),
      mirrorOwn: await tx.findPurgeBlockedPublication(SRC, ['notes/d'], mirror),
      otherPage: await tx.findPurgeBlockedPublication(SRC, ['notes/none'], own),
      otherSource: await tx.findPurgeBlockedPublication('other', ['notes/a'], own),
      noSlugs: await tx.findPurgeBlockedPublication(SRC, [], own),
    }));
    expect(answers).toEqual({ blocked: { request_id: REQ, slug: 'notes/a', state: 'queued' }, ownOnly: null, committedRequest: null,
      mirrorTarget: { request_id: REQ3, slug: 'notes/d', state: 'queued' }, mirrorOwn: null, otherPage: null, otherSource: null, noSlugs: null });
    return answers;
  });

  parityTest('insertPurgeEffects queues a purge request\'s withdrawal-mirror, git and embedding effects once, and nothing for an unknown source', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transaction', 'listPurgeEffects', 'insertPurgeEffects'],
  }, async (engine) => {
    const journal = await admit(engine, REQ, { operation: 'purge_fact' });
    const effects = async () => (await engine.listPurgeEffects(journal)).map(e => [e.kind, e.state, e.error_code, e.parked]).sort();
    const before = await effects();
    await engine.transaction(tx => tx.insertPurgeEffects(journal, 'no-such-source', { version: 2 }));
    const unknownSource = await effects();
    await engine.transaction(tx => tx.insertPurgeEffects(journal, SRC, { version: 2, mode: 'purge' }));
    await engine.transaction(tx => tx.insertPurgeEffects(journal, SRC, { version: 3, mode: 'again' }));
    const answers = { before, unknownSource, queued: await effects() };
    expect(answers).toEqual({ before: [], unknownSource: [],
      queued: [['embedding', 'queued', null, false], ['git', 'queued', null, false], ['withdrawal-mirror', 'queued', null, false]] });
    return answers;
  });
  parityTest('deletePurgedStagingParts and deletePageViewDigests find no rows, and each table keeps its raw-only writer', {
    methods: ['transaction', 'deletePurgedStagingParts', 'deletePageViewDigests'],
  }, async (engine) => {
    // A Rust brain refuses every executeRaw (raw-sql.test.ts), so these tables stay empty there and the Rust members
    // answer without a store call. A typed writer of one of them (an engine-sql module or a Rust store module) fails
    // this pin: the Rust member must then read the store. The core edit notices had the same pin until the store kept
    // them (core-edit-notices.test.ts covers `blankPurgeCoreEditNotices` against seeded rows).
    const answers = await engine.transaction(async tx => ({
      parts: await tx.deletePurgedStagingParts(['a0000000-0000-4000-8000-0000000000a1']),
      digests: (await tx.deletePageViewDigests([1, 2])) ?? null,
      none: [await tx.deletePurgedStagingParts([]), (await tx.deletePageViewDigests([])) ?? null],
    }));
    const writers = rawOnlyWriters();
    expect(answers).toEqual({ parts: 0, digests: null, none: [0, null] });
    expect(writers).toEqual(Object.fromEntries(Object.entries(RAW_ONLY_WRITERS).map(([table, files]) => [table, files.map(file => ({ file, executeRaw: true }))])));
    return { answers, writers };
  });

  // take_proposals has a typed writer (engine-sql/take-proposals.ts insertTakeProposal; on Rust the store's
  // takes/proposals.rs), so a Rust brain holds proposals and a fact purge must delete the ones that state the claim.
  parityTest('deletePurgeTakeProposals deletes the source\'s take proposals whose claim has the purged fingerprint, and no other', {
    methods: ['insertFact', 'loadPurgeTarget', 'insertTakeProposal', 'transaction', 'deletePurgeTakeProposals', 'listPendingTakeProposals'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const claim = 'The harbor will reopen in spring';
    const seeded = await engine.insertFact({ fact: claim, entity_slug: null, source: 'chat' } as NewFact, { source_id: SRC });
    const hash = (await engine.loadPurgeTarget(seeded.id, SRC))!.fact_hash;
    const proposal = (sourceId: string, pageSlug: string, claimText: string) => engine.insertTakeProposal({ sourceId, pageSlug,
      contentHash: 'hash-1', promptVersion: 'parity-v1', proposalRunId: 'run-1', claimText, kind: 'bet', holder: 'brain', weight: 0.6,
      domain: null, dedupAgainst: [], modelId: 'parity-model' });
    await proposal(SRC, 'notes/a', claim);
    await proposal(SRC, 'notes/b', 'The  Harbor will reopen in   SPRING');
    await proposal(SRC, 'notes/b', 'Something else');
    await proposal('other', 'notes/a', claim);
    const left = async (sourceId: string) => (await engine.listPendingTakeProposals({ sourceId, limit: 50 })).map(p => `${p.page_slug}|${p.claim_text}`).sort();
    const deleted = await engine.transaction(tx => tx.deletePurgeTakeProposals(SRC, hash));
    const again = await engine.transaction(tx => tx.deletePurgeTakeProposals(SRC, hash));
    const out = { deleted, again, left: await left(SRC), other: await left('other') };
    expect(out).toEqual({ deleted: 2, again: 0, left: ['notes/b|Something else'], other: [`notes/a|${claim}`] });
    return out;
  });

  parityTest('the raw-only purge tables are reachable only through executeRaw, which the Rust arm refuses', {
    methods: ['executeRaw'], requires: 'raw_sql',
  }, async (engine) => {
    // Named permanent loss (docs/designs/RUST_ENGINE.md#named-permanent-losses): these tables have no typed writer, and
    // the Rust store keeps none of them.
    const counts: Record<string, number> = {};
    for (const table of Object.keys(RAW_ONLY_WRITERS)) {
      counts[table] = Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n);
    }
    expect(counts).toEqual({ page_body_staging_parts: 0, page_view_digests: 0 });
    return counts;
  });
  parityTest('hideDerivedRows marks each derived row of a purged input in needs_rederive, and the reads that apply rederiveHiddenSql hide a marked row', {
    methods: ['insertFact', 'putPage', 'createVersion', 'getVersions', 'addTakesBatch', 'listTakes', 'listFactsByEntity', 'transaction',
      'recordDerivationEdges', 'listDerivedRows', 'expireDerivedFacts', 'deactivateDerivedTakes', 'softDeleteDerivedPages', 'markNeedsRederive',
      'pageAwaitsRederive'],
  }, async (engine) => {
    // The derived rows of one purged input: a fact, a take on a live page, and a page with a saved version.
    const input = await fact(engine, 'purged input', { entity_slug: 'people/a' });
    const derivedFact = await fact(engine, 'derived fact', { entity_slug: 'people/a' });
    const keptFact = await fact(engine, 'kept fact', { entity_slug: 'people/a' });
    const holder = Number((await engine.putPage('notes/holder', note('Holder', 'holds takes'))).id);
    await engine.addTakesBatch([{ page_id: holder, row_num: 1, claim: 'derived take', kind: 'fact', holder: 'self' } as never,
      { page_id: holder, row_num: 2, claim: 'kept take', kind: 'fact', holder: 'self' } as never]);
    const takeId = Number((await engine.listTakes({ page_id: holder } as never)).find(t => t.claim === 'derived take')!.id);
    const derivedPage = Number((await engine.putPage('notes/derived', note('Derived', 'derived body'))).id);
    await engine.createVersion('notes/derived', { sourceId: SRC, reason: 'a saved version' });
    const keptPage = Number((await engine.putPage('notes/kept', note('Kept', 'kept body'))).id);
    const from = { table: 'facts', id: String(input) };
    await engine.transaction(async tx => {
      for (const derived of [{ table: 'facts', id: derivedFact }, { table: 'takes', id: takeId }, { table: 'pages', id: derivedPage }]) {
        await recordDerivationInputs(tx, { ...derived, sourceId: SRC }, [from]);
      }
    });
    const reads = async () => ({
      facts: (await engine.listFactsByEntity(SRC, 'people/a', { activeOnly: false, eligibility: {} } as never)).map(f => f.fact).sort(),
      factsNoPolicy: (await engine.listFactsByEntity(SRC, 'people/a', { activeOnly: false } as never)).map(f => f.fact).sort(),
      inactiveTakes: (await engine.listTakes({ page_id: holder, active: false, eligibility: {} } as never)).map(t => t.claim).sort(),
      inactiveTakesNoPolicy: (await engine.listTakes({ page_id: holder, active: false } as never)).map(t => t.claim).sort(),
      versions: (await engine.getVersions('notes/derived', { sourceId: SRC })).length,
      awaits: { derived: await engine.pageAwaitsRederive(derivedPage), kept: await engine.pageAwaitsRederive(keptPage), missing: await engine.pageAwaitsRederive(987_654) },
    });
    const before = await reads();
    const walk = await derivedRowsFrom(engine, [from]);
    const hide = await engine.transaction(tx => hideDerivedRows(tx, walk.rows, { sourceId: SRC, requestId: 'c0000000-0000-4000-8000-0000000000c1', reason: 'purged' }));
    const again = await engine.transaction(tx => hideDerivedRows(tx, walk.rows, { sourceId: SRC, requestId: null, reason: 'purged again' }));
    const none = await engine.transaction(async tx => { await tx.markNeedsRederive('facts', [], SRC, null, 'nothing', []); return 'no-op'; });
    const after = await reads();
    const answers = { walked: walk.rows.length, before, hide, again, none, after };
    expect(before.awaits).toEqual({ derived: false, kept: false, missing: false });
    expect(before.versions).toBe(1);
    expect(after.facts).toEqual(['kept fact', 'purged input']);
    expect(after.factsNoPolicy).toEqual(['derived fact', 'kept fact', 'purged input']);
    expect(after.inactiveTakes).toEqual([]);
    expect(after.inactiveTakesNoPolicy).toEqual(['derived take']);
    expect(after.versions).toBe(0);
    expect(after.awaits).toEqual({ derived: true, kept: false, missing: false });
    void keptFact;
    return answers;
  });
  parityTest('listSegmentedVersionsForPurge finds the saved versions of segmented pages that are named or hold a claim, in id order after a cursor', {
    methods: ['putPage', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration',
      'setBodyStagingState', 'transaction', 'createVersion', 'listSegmentedVersionsForPurge'],
  }, async (engine) => {
    const claim = segmentText('Today Alice likes tea at noon\n');
    const clean = segmentText('Nothing about her here\n');
    const holds = await publishSegmentedPage(engine, 'notes/holds', [claim]);
    const named = await publishSegmentedPage(engine, 'notes/named', [clean]);
    const innocent = await publishSegmentedPage(engine, 'notes/innocent', [clean]);
    await engine.putPage('notes/inline', note('Inline', 'Alice likes tea, inline'));
    const v1 = (await engine.createVersion('notes/holds')).id;
    const v2 = (await engine.createVersion('notes/named')).id;
    const v3 = (await engine.createVersion('notes/innocent')).id;
    const v4 = (await engine.createVersion('notes/inline')).id;
    const v5 = (await engine.createVersion('notes/holds')).id;
    const labels = new Map<number, string>([[Number(v1), 'holds-1'], [Number(v2), 'named'], [Number(v3), 'innocent'], [Number(v4), 'inline'], [Number(v5), 'holds-2']]);
    const pages = new Map<number, string>([[holds.pageId, 'holds'], [named.pageId, 'named'], [innocent.pageId, 'innocent']]);
    const found = async (needle: string, pageIds: number[], after = 0) => (await engine.listSegmentedVersionsForPurge(SRC, needle, pageIds, after)).map(v => ({
      id: labels.get(Number(v.id)) ?? `unknown:${v.id}`, page: pages.get(Number(v.page_id)) ?? `unknown:${v.page_id}`, generation: Number(v.generation), slug: v.slug,
      title: v.title, type: v.type, frontmatter: v.frontmatter, tags: v.tags,
    }));
    const out = {
      byClaim: await found('alice likes tea', []),
      byName: await found('a claim nobody stored', [named.pageId]),
      both: await found('alice likes tea', [named.pageId]),
      afterFirst: await found('alice likes tea', [named.pageId], Number(v1)),
      afterAll: await found('alice likes tea', [named.pageId], Number(v5)),
      nothing: await found('a claim nobody stored', []),
      otherSource: (await engine.listSegmentedVersionsForPurge('other', 'alice likes tea', [named.pageId], 0)).length,
    };
    const seen = (id: string, page: string) => ({ id, page, generation: 1, slug: `notes/${page}`, title: 'Segmented probe', type: 'note', frontmatter: { status: 'probe', nested: { a: 1 } }, tags: [] });
    const holds1 = seen('holds-1', 'holds'), holds2 = seen('holds-2', 'holds'), namedSeen = seen('named', 'named');
    expect(out).toEqual({
      // The inline page's version and the innocent page's version are never listed; a page holds the claim by its live generation, even when not named.
      byClaim: [holds1, holds2], byName: [namedSeen], both: [holds1, namedSeen, holds2], afterFirst: [namedSeen, holds2], afterAll: [], nothing: [], otherSource: 0,
    });
    return out;
  });

  parityTest('abortPurgedStagings aborts the named stagings that are not committed, and deleteUnreferencedPurgedTexts deletes the unreferenced texts that were replaced or hold the claim', {
    methods: [
      'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'setBodyStagingState',
      'flipBodyGeneration', 'readSegmentTexts', 'readManifest', 'transaction', 'abortPurgedStagings', 'deleteUnreferencedPurgedTexts',
    ],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const claim = segmentText('Today Alice likes tea at noon\n');
    const shouting = segmentText('ALICE LIKES TEA, shouted\n');
    const fenced = segmentText('| a row | Alice \\| tea |\n');
    const orphanFence = segmentText('An orphan row: Alice \\| tea\n');
    const clean = segmentText('Nothing about her here\n');
    const orphanClaim = segmentText('An orphan that says alice likes tea\n');
    const orphanClean = segmentText('An orphan that says nothing\n');
    const orphanReplaced = segmentText('An orphan that was replaced\n');
    const stagedClaim = segmentText('A staged text with Alice likes tea in it\n');
    const published = await publishSegmentedPage(engine, 'notes/published', [claim, clean]);
    const shellOf = async (slug: string, sourceId = SRC) => (await engine.createSegmentedPageShell(slug, pageMeta(slug), { sourceId })).id;
    const holdsClaim = await shellOf('notes/holds-claim');
    const holdsShout = await shellOf('notes/holds-shout');
    const holdsNothing = await shellOf('notes/holds-nothing');
    const elsewhere = await shellOf('notes/elsewhere', 'other');
    const s1 = await stageGeneration(engine, { pageId: holdsClaim, slug: 'notes/holds-claim', genFrom: 1, texts: [claim, clean] });
    const s2 = await stageGeneration(engine, { pageId: holdsShout, slug: 'notes/holds-shout', genFrom: 1, texts: [shouting] });
    const s3 = await stageGeneration(engine, { pageId: holdsNothing, slug: 'notes/holds-nothing', genFrom: 1, texts: [clean] });
    await stageGeneration(engine, { pageId: elsewhere, slug: 'notes/elsewhere', genFrom: 1, texts: [claim], sourceId: 'other' });
    const recorded = async (id: string, state: 'open' | 'committed', text = stagedClaim) => {
      await engine.transaction(async tx => {
        await tx.openBodyStaging(stagingInput({ id, slug: 'notes/recorded' }));
        await tx.stageSegmentTexts(SRC, [text], { stagingId: id });
        if (state === 'committed') await tx.setBodyStagingState(id, 'committed');
      });
      return id;
    };
    const s5 = await recorded('c0000000-0000-4000-8000-0000000000c5', 'open');
    const s6 = await recorded('c0000000-0000-4000-8000-0000000000c6', 'committed');
    const s7 = await recorded('c0000000-0000-4000-8000-0000000000c7', 'open', fenced);
    await engine.setBodyStagingState(s3.stagingId, 'sealed');
    await engine.stageSegmentTexts(SRC, [orphanClaim, orphanClean, orphanReplaced, orphanFence]);
    await engine.stageSegmentTexts('other', [orphanClaim]);
    const pages = new Map<number, string>([[published.pageId, 'published'], [holdsClaim, 'holdsClaim'], [holdsShout, 'holdsShout'], [holdsNothing, 'holdsNothing'], [elsewhere, 'elsewhere']]);
    const texts = new Map<string, string>(([[claim, 'claim'], [shouting, 'shouting'], [clean, 'clean'], [orphanClaim, 'orphanClaim'], [orphanClean, 'orphanClean'],
      [orphanReplaced, 'orphanReplaced'], [stagedClaim, 'stagedClaim'], [fenced, 'fenced'], [orphanFence, 'orphanFence']] as const).map(([t, n]) => [hexOf(t.sha256), n]));
    const stored = async (sourceId: string) => {
      const found = await engine.readSegmentTexts(sourceId, [...texts.keys()].map(h => Uint8Array.from(Buffer.from(h, 'hex'))));
      return [...found.keys()].map(h => texts.get(h) ?? `unknown:${h}`).sort();
    };
    const out = {
      textsBefore: await stored(SRC),
      ...(await engine.transaction(async tx => ({
        aborted: (await tx.abortPurgedStagings([s1.stagingId, s2.stagingId, s3.stagingId, s7, s5, s6, published.stagingId, 'a0000000-0000-4000-8000-0000000000a1']))
          .map(id => pages.get(id) ?? `unknown:${id}`).sort(),
        abortedAgain: (await tx.abortPurgedStagings([s1.stagingId])).map(id => pages.get(id) ?? `unknown:${id}`),
        abortedNothing: await tx.abortPurgedStagings([]),
        deletedTexts: await tx.deleteUnreferencedPurgedTexts(SRC, [orphanReplaced.sha256], 'Alice likes tea'),
        deletedAgain: await tx.deleteUnreferencedPurgedTexts(SRC, [orphanReplaced.sha256], 'Alice likes tea'),
        deletedNothing: await tx.deleteUnreferencedPurgedTexts(SRC, [], 'a claim nobody staged'),
        deletedFence: await tx.deleteUnreferencedPurgedTexts(SRC, [], 'Alice | tea'),
      }))),
      textsAfter: await stored(SRC),
      textsAfterOther: await stored('other'),
      manifestKept: (await engine.readManifest(holdsClaim, { stagingId: s1.stagingId })).length,
    };
    expect(out).toEqual({
      textsBefore: ['claim', 'clean', 'fenced', 'orphanClaim', 'orphanClean', 'orphanFence', 'orphanReplaced', 'shouting', 'stagedClaim'],
      aborted: ['holdsClaim', 'holdsNothing', 'holdsShout'], abortedAgain: ['holdsClaim'], abortedNothing: [],
      deletedTexts: 3, deletedAgain: 0, deletedNothing: 0, deletedFence: 2,
      textsAfter: ['claim', 'clean', 'orphanClean', 'shouting'], textsAfterOther: ['claim', 'orphanClaim'], manifestKept: 2,
    });
    return out;
  });
});
