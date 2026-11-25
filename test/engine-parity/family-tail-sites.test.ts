/**
 * BrainEngine parity: the contradiction-cycle and admin statements the edge-contradictions phase
 * (src/core/cycle/edge-contradictions.ts), the scoped contradiction reader (src/core/eval-contradictions), the two eval
 * reads and the admin operations (src/core/ops/admin.ts) ran through `executeRaw` before they were members (src/core/engine-sql/contradictions-cycle.ts,
 * admin-reads.ts). The re-key and `repair ontology-facts` statements moved to ontology-repair-sites.test.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listEdgeContradictionCandidates answers the subjects with two live works_at employers (a person-like target
 *    is not an employer; a pack without the subject's type, or a cutoff after the subject's last extraction, admits none)
 *    and listLinkContexts their stored contexts; recordEdgeProposal stores a proposal once and answers its id, null for the
 *    same evidence; readEdgeProposal, readEdgeProposalEvidence, readEdgeProposalHash, listKnownEdgeProposals and
 *    edgeClosureLanded read it back; setEdgeProposalStatus, markEdgeProposalStale, rejectOpenEdgeProposal (only while it
 *    is open), markEdgeProposalUndone and markRevertedEdgeProposals move its status; listLiveChunksByIds and
 *    listLiveTakesByIds re-read the judged rows a caller's policy still admits (private pages, a holder allow-list);
 *    readLastContradictionsPromptVersion answers the newest run's prompt version and listEvalCandidateQueries the newest
 *    captured queries; listVisiblePageSlugs
 *    keeps the slugs a caller may see under each page-policy part and readPagesForVersionHistory reads the pages a version
 *    history belongs to. runPhaseEdgeContradictions, end to end with a stub judge: propose mode records one dated closure
 *    and a rejected pair is not judged again; apply mode writes the closure line, undo reopens it, and a closure line the
 *    user deletes makes the proposal reverted_by_user. The doctor edge_validity check counts the stored proposals by
 *    status within the source scope it is given and warns on open ones.
 *  - Regression: an engine that drops a clause hands the contradiction judge a private page's text, closes a stranger's
 *    relationship or names a private page to a remote caller in `most_connected`.
 *  - Why existing coverage misses it: the statements ran through `executeRaw`, which the parity cases cannot call (D18),
 *    so no case compared them across engines.
 *  - Seam: none. Pages come from putPage (or put_page, which derives the links and dated evidence; its link
 *    preparation reads the live slug aliases through the typed readLiveSlugAliases on every engine), links from addLink or
 *    replaceDerivedLinks, takes from
 *    addTakesBatch, runs and queries from their typed writers. Ids differ between arms, so every case maps them to slugs or
 *    to the name of the row it seeded.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { applyEdgeProposal, rejectEdgeProposal, runPhaseEdgeContradictions, undoEdgeProposal, type EdgeJudgeFn } from '../../src/core/cycle/edge-contradictions.ts';
import { edgeValidityStats, edgeValidityVerdict } from '../../src/commands/doctor/checks/edge-validity.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const ALICE = 'people/alice-example';
const BOB = 'people/bob-example';
const ACME = 'companies/acme-example';
const WIDGET = 'companies/widget-co';

const page = (title: string, type: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: type as never, title, compiled_truth: `About ${title}.`, timeline: '', frontmatter });

async function idOf(engine: BrainEngine, slug: string, sourceId = 'default'): Promise<number> {
  const id = await engine.readPageIdInSource(slug, sourceId);
  expect(id).not.toBeNull();
  return Number(id);
}

/** A caller who reads as alice-example, as the private-page parity files do. */
const MEMBER = { identity: ['member:alice-example'], hidePrivate: true } as const;
const asMember = <T>(read: () => Promise<T>) => withCallerAccess({ ...MEMBER, identity: [...MEMBER.identity] }, read);

describe('engine parity: edge-contradictions phase statements', () => {
  parityTest('the candidate query lists the live works_at employers of a person, and a pack, a cutoff or a person target narrows it', {
    methods: ['putPage', 'addLink', 'readPageIdInSource', 'listEdgeContradictionCandidates', 'listLinkContexts'],
  }, async (engine) => {
    await engine.putPage(ALICE, page('Alice', 'person'));
    await engine.putPage(BOB, page('Bob', 'person'));
    await engine.putPage(ACME, page('Acme', 'company'));
    await engine.putPage(WIDGET, page('Widget', 'company'));
    await engine.addLink(ALICE, ACME, 'works at Acme', 'works_at', 'manual');
    await engine.addLink(ALICE, WIDGET, 'works at Widget', 'works_at', 'manual');
    await engine.addLink(ALICE, BOB, 'works with Bob', 'works_at', 'manual');
    const today = new Date().toISOString().slice(0, 10);
    const personFilter = { types: ['person'], per_source: [] as Array<{ source_id: string; types: string[] }> };
    const view = (rows: Awaited<ReturnType<BrainEngine['listEdgeContradictionCandidates']>>) =>
      rows.map(r => `${r.subject_slug}>${r.target_slug}:${r.link_type}`);
    const out = {
      employers: view(await engine.listEdgeContradictionCandidates({ today, maxSubjects: 10, pendingCutoff: null, personFilter })),
      shapes: (await engine.listEdgeContradictionCandidates({ today, maxSubjects: 10, pendingCutoff: null, personFilter }))
        .map(r => [typeof r.evidence_hash, r.subject_title, r.target_title, r.source_id]),
      otherPack: view(await engine.listEdgeContradictionCandidates({ today, maxSubjects: 10, pendingCutoff: null, personFilter: { types: ['founder'], per_source: [] } })),
      perSourcePack: view(await engine.listEdgeContradictionCandidates({ today, maxSubjects: 10, pendingCutoff: null,
        personFilter: { types: ['founder'], per_source: [{ source_id: 'default', types: ['person'] }] } })),
      afterCutoff: view(await engine.listEdgeContradictionCandidates({ today, maxSubjects: 10, pendingCutoff: '2999-01-01T00:00:00Z', personFilter })),
      contexts: await engine.listLinkContexts(await idOf(engine, ALICE), await idOf(engine, ACME), 'works_at'),
      noContext: await engine.listLinkContexts(await idOf(engine, ACME), await idOf(engine, ALICE), 'works_at'),
    };
    expect(out.employers).toEqual([`${ALICE}>${ACME}:works_at`, `${ALICE}>${WIDGET}:works_at`]);
    expect(out).toMatchObject({ otherPack: [], afterCutoff: [], contexts: ['works at Acme'], noContext: [] });
    expect(out.perSourcePack).toEqual(out.employers);
    return out;
  });

  parityTest('listLinkContexts answers the distinct non-empty contexts of one link type between two pages', {
    methods: ['putPage', 'addLink', 'readPageIdInSource', 'listLinkContexts'],
  }, async (engine) => {
    await engine.putPage(ALICE, page('Alice', 'person'));
    await engine.putPage(ACME, page('Acme', 'company'));
    await engine.putPage(WIDGET, page('Widget', 'company'));
    // Two distinct contexts over four rows (a repeat and an empty one), so LIMIT 3 keeps both on every engine.
    await engine.addLink(ALICE, ACME, 'works at Acme', 'works_at', 'manual');
    await engine.addLink(ALICE, ACME, 'Acme engineer', 'works_at', 'markdown');
    await engine.addLink(ALICE, ACME, 'works at Acme', 'works_at', 'frontmatter');
    await engine.addLink(ALICE, ACME, '', 'works_at', 'mcp');
    await engine.addLink(ALICE, ACME, 'advises Acme', 'advises', 'manual');
    await engine.addLink(ALICE, WIDGET, 'works at Widget', 'works_at', 'manual');
    const [alice, acme] = [await idOf(engine, ALICE), await idOf(engine, ACME)];
    // The SQL names no order, so the case compares the contexts sorted.
    const out = {
      worksAt: sorted(await engine.listLinkContexts(alice, acme, 'works_at')),
      advises: await engine.listLinkContexts(alice, acme, 'advises'),
      reverse: await engine.listLinkContexts(acme, alice, 'works_at'),
      otherType: await engine.listLinkContexts(alice, acme, 'invested_in'),
    };
    expect(out).toEqual({ worksAt: ['Acme engineer', 'works at Acme'], advises: ['advises Acme'], reverse: [], otherType: [] });
    return out;
  });

  parityTest('a proposal is recorded once, read back with its slugs and evidence, and moves through its statuses', {
    methods: ['putPage', 'addLink', 'readPageIdInSource', 'recordEdgeProposal', 'readEdgeProposal', 'readEdgeProposalEvidence',
      'readEdgeProposalHash', 'listKnownEdgeProposals', 'edgeClosureLanded', 'setEdgeProposalStatus', 'markEdgeProposalStale',
      'rejectOpenEdgeProposal', 'markEdgeProposalUndone', 'markRevertedEdgeProposals'],
  }, async (engine) => {
    await engine.putPage(ALICE, page('Alice', 'person'));
    await engine.putPage(ACME, page('Acme', 'company'));
    await engine.putPage(WIDGET, page('Widget', 'company'));
    await engine.addLink(ALICE, ACME, 'works at Acme', 'works_at', 'manual');
    await engine.addLink(ALICE, WIDGET, 'works at Widget', 'works_at', 'manual');
    const [alice, acme, widget] = [await idOf(engine, ALICE), await idOf(engine, ACME), await idOf(engine, WIDGET)];
    const input = { sourceId: 'default', fromPageId: alice, aToPageId: acme, bToPageId: widget, linkType: 'works_at', evidenceHash: 'evidence-1',
      status: 'proposed', endingToPageId: acme, closeDate: '2024-05-01', bornClosed: false, model: 'judge-m1', confidence: 0.9,
      generatedLine: '- **2024-05-01** | gbrain-dream — Ended works_at Acme', detail: null };
    const first = await engine.recordEdgeProposal(input);
    const repeat = await engine.recordEdgeProposal(input);
    // An error row is replaced by the next record of the same evidence; any other status stands.
    const errored = await engine.recordEdgeProposal({ ...input, evidenceHash: 'evidence-2', status: 'error', endingToPageId: null, closeDate: null, generatedLine: null, detail: 'attempt 1' });
    const replaced = await engine.recordEdgeProposal({ ...input, evidenceHash: 'evidence-2', status: 'compatible', endingToPageId: null, closeDate: null, generatedLine: null });
    expect(first).not.toBeNull();
    expect(repeat).toBeNull();
    expect(errored).not.toBeNull();
    expect(replaced).toBe(errored);
    const id = first!;
    const read = async (n: number) => {
      const p = await engine.readEdgeProposal(n);
      return p === null ? null : { status: p.status, subject: p.subject_slug, ending: p.ending_slug, link_type: p.link_type, close_date: p.close_date, line: p.generated_line };
    };
    const out: Record<string, unknown> = {
      first: await read(id), missing: await read(987654), compatible: await read(errored!),
      hash: await engine.readEdgeProposalHash(id), noHash: await engine.readEdgeProposalHash(987654),
      noEvidence: await engine.readEdgeProposalEvidence(987654),
      evidence: await (async () => { const e = await engine.readEdgeProposalEvidence(id); return e === null ? null : [typeof e.a, typeof e.b, e.a !== e.b]; })(),
      known: (await engine.listKnownEdgeProposals(alice, 'works_at', ['evidence-1', 'evidence-2', 'nothing']))
        .map(r => [r.a === acme ? ACME : r.a, r.b === widget ? WIDGET : r.b, r.status, r.recent]).sort(),
      landed: await engine.edgeClosureLanded(alice, acme, 'works_at', '2024-05-01'),
    };
    expect(out.hash).toEqual({ evidence_hash: 'evidence-1' });
    await engine.markEdgeProposalStale(id);
    out.stale = (await read(id))?.status;
    await engine.setEdgeProposalStatus(id, 'proposed');
    out.reopened = (await read(id))?.status;
    out.rejected = await engine.rejectOpenEdgeProposal(id);
    out.rejectedAgain = await engine.rejectOpenEdgeProposal(id);
    out.afterReject = (await read(id))?.status;
    await engine.setEdgeProposalStatus(id, 'applied');
    out.rejectApplied = await engine.rejectOpenEdgeProposal(id);
    // An applied proposal whose closure transition is not there became reverted_by_user.
    // The statement only takes proposals whose updated_at is before now(); let the clock tick past the status write.
    await new Promise(r => setTimeout(r, 25));
    out.reverted = await engine.markRevertedEdgeProposals();
    out.afterRevert = (await read(id))?.status;
    out.revertedAgain = await engine.markRevertedEdgeProposals();
    await engine.setEdgeProposalStatus(id, 'applied');
    await engine.markEdgeProposalUndone(id);
    out.undone = (await read(id))?.status;
    expect(out).toMatchObject({ stale: 'stale', reopened: 'proposed', rejected: true, rejectedAgain: false, afterReject: 'rejected',
      rejectApplied: false, reverted: 1, afterRevert: 'reverted_by_user', revertedAgain: 0, undone: 'undone', landed: false, noHash: null, noEvidence: null });
    return out;
  });
});

/** put_page through the operation, as the phase's own unit test seeds pages: the write derives the page's links and dated evidence. */
async function putThroughOp(engine: BrainEngine, slug: string, fm: string, body: string): Promise<void> {
  const ctx = { engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false,
    sourceId: 'default' } as unknown as OperationContext;
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug, ...(snapshot ? { expected_revision: snapshot.revision } : {}),
    content: `---\n${fm}\n---\n\n${body}` });
}

const TWO_EMPLOYERS = [
  'Alice works at [Acme](../companies/acme-example) and at [Widget](../companies/widget-co).', '', '## Timeline', '',
  '- **2019-02-01** | test — joined [Acme](../companies/acme-example)',
  '- **2024-05-01** | test — joined [Widget](../companies/widget-co)',
].join('\n');

/** Alice with two dated works_at employers (Acme from 2019, Widget from 2024), written through put_page. */
async function seedThroughOp(engine: BrainEngine): Promise<void> {
  await putThroughOp(engine, ACME, 'type: company\ntitle: Acme', 'A company.');
  await putThroughOp(engine, WIDGET, 'type: company\ntitle: Widget', 'A company.');
  await putThroughOp(engine, ALICE, 'type: person\ntitle: Alice', TWO_EMPLOYERS);
}

/** The same graph, published as derived links with the page's own dated evidence (no put_page link preparation). */
async function seedThroughDerivedLinks(engine: BrainEngine): Promise<void> {
  await engine.putPage(ACME, page('Acme', 'company'));
  await engine.putPage(WIDGET, page('Widget', 'company'));
  await engine.putPage(ALICE, { ...page('Alice', 'person'), compiled_truth: TWO_EMPLOYERS });
  const snapshot = (await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!;
  const link = (to: string, context: string) => ({ from_slug: ALICE, to_slug: to, link_type: 'works_at', context, link_source: 'markdown',
    from_source_id: 'default', to_source_id: 'default' });
  await engine.replaceDerivedLinks({ slug: ALICE, sourceId: 'default', expectedRevision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation },
    [link(ACME, 'works at Acme'), link(WIDGET, 'works at Widget')]);
}

const conflictJudge: EdgeJudgeFn = async () => [{ a: 1, b: 2, conflict: true, confidence: 0.9 }];

/** The phase outcome without its wall-clock duration. */
const phaseView = (r: Awaited<ReturnType<typeof runPhaseEdgeContradictions>>) => ({ status: r.status, detail: r.detail, totals: r.totals });

async function liveEmployers(engine: BrainEngine): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await engine.listEdgeContradictionCandidates({ today, maxSubjects: 10, pendingCutoff: null,
    personFilter: { types: ['person'], per_source: [] } });
  return rows.map(r => r.target_slug);
}

/**
 * The engine the phase gets: it keeps the ids recordEdgeProposal answers (the phase does not return them) and the
 * last typed capability refusal the engine threw.
 */
function watched(engine: BrainEngine) {
  const ids: number[] = [];
  let refusal: unknown = null;
  let refusalSite = '';
  const wrapped = new Proxy(engine, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        // The caller's stack, taken before the call: an async refusal no longer names who made the call.
        const site = new Error().stack ?? '';
        const out = value.apply(target, args);
        if (!(out instanceof Promise)) return out;
        return out.then((r: unknown) => {
          if (key === 'recordEdgeProposal' && typeof r === 'number') ids.push(r);
          return r;
        }, (e: unknown) => {
          if ((e as { code?: unknown })?.code === 'engine_capability_missing') { refusal = e; refusalSite = site; }
          throw e;
        });
      };
    },
  });
  return { engine: wrapped, ids, refusal: () => refusal, refusalSite: () => refusalSite };
}

/**
 * Run a write that a missing capability can queue instead of refuse: put_page answers `write_pending` with
 * blocked_reason engine_capability_missing when a step of its link preparation is refused. The Rust engine serves the
 * live slug alias read of that preparation now (readLiveSlugAliases, caller-links-federate-rust), so the apply-mode
 * cases run to the end on every arm; a refusal on any arm is a failure and reaches the harness as thrown.
 */
async function orTheQueuedRefusal<T>(w: ReturnType<typeof watched>, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const request = (error as { writeRequest?: { blocked_reason?: unknown; write_error?: unknown } })?.writeRequest;
    // A refused preparation step parks the request as blocked, or ends it failed with the typed refusal as its write error.
    const blocked = request?.blocked_reason ?? request?.write_error;
    if (blocked === 'engine_capability_missing' && w.refusal() !== null) throw w.refusal();
    throw error;
  }
}

describe('engine parity: the edge-contradictions phase end to end', () => {
  parityTest('propose mode records one dated closure, reject keeps both employers, and the next run skips the known pair', {
    methods: ['getConfig', 'setConfig', 'markRevertedEdgeProposals', 'listEdgeContradictionCandidates', 'listKnownEdgeProposals',
      'listLinkContexts', 'recordEdgeProposal', 'readEdgeProposal', 'putPage',
      'replaceDerivedLinks', 'rejectOpenEdgeProposal'],
  }, async (base) => {
    const w = watched(base);
    const engine = w.engine;
    await seedThroughDerivedLinks(engine);
    await engine.setConfig('dream.edge_contradictions.mode', 'propose');
    const before = await liveEmployers(engine);
    const proposed = phaseView(await runPhaseEdgeContradictions(engine, { judge: conflictJudge }));
    expect(w.ids.length).toBe(1);
    const id = w.ids[0]!;
    const proposal = async () => {
      const p = await engine.readEdgeProposal(id);
      return p && { status: p.status, subject: p.subject_slug, ending: p.ending_slug, link_type: p.link_type, close_date: String(p.close_date).slice(0, 10),
        line: p.generated_line };
    };
    const out = {
      before, proposed, proposal: await proposal(),
      afterPropose: await liveEmployers(engine),
      reject: await rejectEdgeProposal(engine, id),
      rejectAgain: await rejectEdgeProposal(engine, id),
      applyRejected: await applyEdgeProposal(engine, id),
      rejected: (await proposal())?.status,
      rerun: phaseView(await runPhaseEdgeContradictions(engine, { judge: conflictJudge })),
      afterRerun: await liveEmployers(engine),
    };
    expect(out).toMatchObject({ before: [ACME, WIDGET], afterPropose: [ACME, WIDGET], afterRerun: [ACME, WIDGET], rejected: 'rejected',
      reject: { status: 'rejected' }, rejectAgain: { status: 'refused' }, applyRejected: { status: 'refused', reason: 'proposal is rejected' },
      proposal: { status: 'proposed', subject: ALICE, ending: ACME, close_date: '2024-05-01' } });
    expect(out.proposed.totals).toMatchObject({ judged: 1, proposed: 1, applied: 0 });
    expect(out.rerun.totals).toMatchObject({ skipped_known: 1, judged: 0 });
    return out;
  });

  parityTest('apply mode closes the older employer through a timeline line, undo reopens it, and the next run skips the known pair', {
    methods: ['getConfig', 'setConfig', 'markRevertedEdgeProposals', 'listEdgeContradictionCandidates', 'listKnownEdgeProposals',
      'listLinkContexts', 'recordEdgeProposal', 'readEdgeProposal',
      'readEdgeProposalEvidence', 'readEdgeProposalHash', 'edgeClosureLanded', 'setEdgeProposalStatus', 'markEdgeProposalUndone'],
  }, async (base) => {
    const w = watched(base);
    const engine = w.engine;
    return orTheQueuedRefusal(w, async () => {
      await seedThroughOp(engine);
      await engine.setConfig('dream.edge_contradictions.mode', 'apply');
      const before = await liveEmployers(engine);
      const applied = phaseView(await runPhaseEdgeContradictions(engine, { judge: conflictJudge }));
      expect(w.ids.length).toBe(1);
      const id = w.ids[0]!;
      const out = {
        before, applied, afterApply: await liveEmployers(engine),
        timeline: (await engine.getPage(ALICE, { sourceId: 'default' }))?.timeline?.includes('gbrain-dream (inferred) — Ended works_at [[companies/acme-example]]'),
        replay: await applyEdgeProposal(engine, id),
        undo: await undoEdgeProposal(engine, id),
        afterUndo: await liveEmployers(engine),
        undone: (await engine.readEdgeProposal(id))?.status,
        rerun: phaseView(await runPhaseEdgeContradictions(engine, { judge: conflictJudge })),
      };
      // One live employer is no longer a candidate group (it needs two targets).
      expect(out).toMatchObject({ before: [ACME, WIDGET], afterApply: [], timeline: true, replay: { status: 'applied', reason: 'already applied' },
        undo: { status: 'undone' }, afterUndo: [ACME, WIDGET], undone: 'undone' });
      expect(out.applied.totals).toMatchObject({ judged: 1, proposed: 1, applied: 1 });
      expect(out.rerun.totals).toMatchObject({ skipped_known: 1, judged: 0 });
      return out;
    });
  });

  parityTest('an applied closure line the user deletes makes the proposal reverted_by_user, and the judge is not asked again', {
    methods: ['getConfig', 'setConfig', 'markRevertedEdgeProposals', 'listEdgeContradictionCandidates', 'listKnownEdgeProposals',
      'listLinkContexts', 'recordEdgeProposal', 'readEdgeProposal',
      'readEdgeProposalEvidence', 'readEdgeProposalHash', 'edgeClosureLanded', 'setEdgeProposalStatus'],
  }, async (base) => {
    const w = watched(base);
    const engine = w.engine;
    return orTheQueuedRefusal(w, async () => {
      await seedThroughOp(engine);
      await engine.setConfig('dream.edge_contradictions.mode', 'apply');
      const applied = phaseView(await runPhaseEdgeContradictions(engine, { judge: conflictJudge }));
      // The user rewrites the page without the closure line.
      await seedThroughOp(engine);
      let calls = 0;
      // The revert statement takes proposals updated before now(); let the clock tick past the apply.
      await new Promise(r => setTimeout(r, 25));
      const again = phaseView(await runPhaseEdgeContradictions(engine, { judge: async (input) => { calls++; return conflictJudge(input); } }));
      const out = { applied, afterRewrite: await liveEmployers(engine), again, calls };
      expect(out.applied.totals).toMatchObject({ proposed: 1, applied: 1 });
      expect(out).toMatchObject({ afterRewrite: [ACME, WIDGET], calls: 0 });
      expect(out.again.totals).toMatchObject({ reverted: 1 });
      return out;
    });
  });

  parityTest('doctor edge_validity counts the stored proposals by status, within the source scope it is given', {
    methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'readPageIdInSource', 'recordEdgeProposal', 'edgeValidityCounts', 'getConfig'],
  }, async (engine, backend) => {
    await seedThroughDerivedLinks(engine);
    await createSource(engine, backend, 'other');
    for (const slug of [ALICE, ACME, WIDGET]) await engine.putPage(slug, page(slug, slug === ALICE ? 'person' : 'company'), { sourceId: 'other' });
    const record = async (sourceId: string, evidenceHash: string, status: string) => {
      const [from, a, b] = [await idOf(engine, ALICE, sourceId), await idOf(engine, ACME, sourceId), await idOf(engine, WIDGET, sourceId)];
      await engine.recordEdgeProposal({ sourceId, fromPageId: from, aToPageId: a, bToPageId: b, linkType: 'works_at', evidenceHash, status,
        endingToPageId: status === 'undated_unresolved' ? null : a, closeDate: status === 'undated_unresolved' ? null : '2024-05-01',
        bornClosed: false, model: 'judge-m1', confidence: 0.9, generatedLine: null, detail: null });
    };
    await record('default', 'e1', 'proposed');
    await record('default', 'e2', 'proposed');
    await record('default', 'e3', 'undated_unresolved');
    await record('default', 'e4', 'applied');
    await record('default', 'e5', 'rejected');
    await record('other', 'e6', 'proposed');
    await record('other', 'e7', 'applied');
    const all = await edgeValidityStats(engine);
    const scoped = await edgeValidityStats(engine, ['default']);
    const verdict = edgeValidityVerdict(scoped);
    const out = { all: all?.proposals, scoped: scoped?.proposals, none: (await edgeValidityStats(engine, ['missing']))?.proposals,
      status: verdict.status, message: verdict.message };
    expect(out).toMatchObject({ all: { proposed: 3, undated: 1, applied: 2 }, scoped: { proposed: 2, undated: 1, applied: 1 },
      none: { proposed: 0, undated: 0, applied: 0 }, status: 'warn' });
    expect(out.message).toContain('2 contradiction proposal(s) open, 1 waiting for a date');
    return out;
  });
});

describe('engine parity: scoped contradiction reader statements', () => {
  parityTest('the live chunk re-read keeps the chunks a caller\'s policy admits, and the take re-read adds the holder allow-list', {
    methods: ['putPage', 'sealChunks', 'getChunks', 'addTakesBatch', 'listTakes', 'readPageIdInSource', 'listLiveChunksByIds', 'listLiveTakesByIds'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/open', page('Open', 'note'));
    await engine.putPage('notes/private', page('Private', 'note', { visibility: 'private' }));
    await engine.putPage('notes/open', page('Other open', 'note'), { sourceId: 'other' });
    await installChunks(engine, 'notes/open', [chunk(0, 'Open text.')]);
    await installChunks(engine, 'notes/private', [chunk(0, 'Private text.')]);
    await installChunks(engine, 'notes/open', [chunk(0, 'Other open text.')], { sourceId: 'other' });
    const open = await idOf(engine, 'notes/open');
    const priv = await idOf(engine, 'notes/private');
    const otherOpen = await idOf(engine, 'notes/open', 'other');
    await engine.addTakesBatch([
      { page_id: open, row_num: 1, claim: 'Open world take', kind: 'take', holder: 'world', weight: 0.5 },
      { page_id: open, row_num: 2, claim: 'Open garry take', kind: 'take', holder: 'garry', weight: 0.5 },
      { page_id: priv, row_num: 1, claim: 'Private world take', kind: 'take', holder: 'world', weight: 0.5 },
      { page_id: otherOpen, row_num: 1, claim: 'Other world take', kind: 'take', holder: 'world', weight: 0.5 },
    ]);
    const chunkIds = [
      ...(await engine.getChunks('notes/open', { sourceId: 'default' })), ...(await engine.getChunks('notes/private', { sourceId: 'default' })),
      ...(await engine.getChunks('notes/open', { sourceId: 'other' })),
    ].map(c => Number(c.id));
    const takeIds = (await engine.listTakes({ limit: 100 })).map(t => Number(t.id));
    expect(chunkIds).toHaveLength(3);
    expect(takeIds).toHaveLength(4);
    const chunkView = async (policy: Parameters<BrainEngine['listLiveChunksByIds']>[1], floor?: Parameters<BrainEngine['listLiveChunksByIds']>[2]) =>
      sorted((await engine.listLiveChunksByIds(chunkIds, policy, floor)).map(r => `${r.source_id}:${r.slug}:${r.chunk_text}`));
    const takeView = async (policy: Parameters<BrainEngine['listLiveTakesByIds']>[1], floor?: Parameters<BrainEngine['listLiveTakesByIds']>[2]) =>
      sorted((await engine.listLiveTakesByIds(takeIds, policy, floor)).map(r => `${r.source_id}:${r.slug}:${r.holder}:${r.claim}`));
    const out = {
      chunksAll: await chunkView({}),
      chunksOneSource: await chunkView({ sourceId: 'other' }),
      chunksNoIds: (await engine.listLiveChunksByIds([], {}, undefined)).length,
      chunksFloor: await chunkView({}, 'user_confirmed'),
      chunksPrivateHidden: await asMember(() => chunkView({ excludePrivate: true })),
      chunksSafe: await asMember(() => chunkView({ excludePrivate: true, requireSafeChunks: true })),
      takesAll: await takeView({}),
      takesOneSource: await takeView({ sourceIds: ['default'] }),
      takesHolder: await takeView({ takesHoldersAllowList: ['world'] }),
      takesNoHolder: await takeView({ takesHoldersAllowList: [] }),
      takesPrivateHidden: await asMember(() => takeView({ excludePrivate: true, takesHoldersAllowList: ['world', 'garry'] })),
      takesFloor: await takeView({}, 'user_confirmed'),
    };
    expect(out.chunksAll).toHaveLength(3);
    expect(out.chunksOneSource).toEqual(['other:notes/open:Other open text.']);
    expect(out.chunksPrivateHidden).not.toContain('default:notes/private:Private text.');
    expect(out.takesAll).toHaveLength(4);
    expect(out.takesHolder).toHaveLength(3);
    expect(out.takesNoHolder).toEqual([]);
    expect(out.takesPrivateHidden.some(t => t.includes('Private world take'))).toBe(false);
    return out;
  });

  parityTest('the last contradiction prompt version is the newest run\'s, null before any run', {
    methods: ['writeContradictionsRun', 'readLastContradictionsPromptVersion'],
  }, async (engine) => {
    const run = (id: string, prompt_version: string) => ({
      run_id: id, judge_model: 'judge-m1', prompt_version, queries_evaluated: 20, queries_with_contradiction: 4, total_contradictions_flagged: 6,
      wilson_ci_lower: 0.08, wilson_ci_upper: 0.42, judge_errors_total: 1, cost_usd_total: 0.37, duration_ms: 1234,
      source_tier_breakdown: {}, report_json: {},
    });
    const pause = () => new Promise(resolve => setTimeout(resolve, 15));
    const out: Record<string, unknown> = { noneYet: await engine.readLastContradictionsPromptVersion() };
    await engine.writeContradictionsRun(run('run-b', 'v1'));
    out.one = await engine.readLastContradictionsPromptVersion();
    await pause();
    // A later run with a smaller run_id: the newest ran_at wins, not the run_id order.
    await engine.writeContradictionsRun(run('run-a', 'v2'));
    out.newest = await engine.readLastContradictionsPromptVersion();
    // A repeated run_id is not stored again, so the answer stays.
    await pause();
    await engine.writeContradictionsRun(run('run-b', 'v3'));
    out.afterRepeat = await engine.readLastContradictionsPromptVersion();
    expect(out).toEqual({ noneYet: null, one: 'v1', newest: 'v2', afterRepeat: 'v2' });
    return out;
  });

  parityTest('the captured queries come newest first up to the limit', {
    methods: ['logEvalCandidate', 'listEvalCandidateQueries'],
  }, async (engine) => {
    const candidate = (query: string) => ({
      tool_name: 'query' as const, query, retrieved_slugs: [], retrieved_chunk_ids: [], source_ids: ['default'], expand_enabled: null, detail: null,
      detail_resolved: null, vector_enabled: false, expansion_applied: false, latency_ms: 1, remote: false, job_id: null, subagent_id: null,
    });
    const out: Record<string, unknown> = { noQueries: await engine.listEvalCandidateQueries(5) };
    for (const q of ['first query', 'second query', 'third query']) await engine.logEvalCandidate(candidate(q));
    out.queries = await engine.listEvalCandidateQueries(100);
    out.limited = await engine.listEvalCandidateQueries(2);
    expect(out).toEqual({ noQueries: [], queries: ['third query', 'second query', 'first query'], limited: ['third query', 'second query'] });
    return out;
  });
});

describe('engine parity: admin read statements', () => {
  parityTest('listVisiblePageSlugs keeps the live pages a caller may see within the scope, under each page-policy part', {
    methods: ['putPage', 'deletePage', 'listVisiblePageSlugs'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/open', page('Open', 'note'));
    await engine.putPage('notes/private', page('Private', 'note', { visibility: 'private' }));
    await engine.putPage('notes/readers', page('Readers', 'note', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/gone', page('Gone', 'note'));
    await engine.putPage('notes/elsewhere', page('Elsewhere', 'note'), { sourceId: 'other' });
    await engine.deletePage('notes/gone');
    const slugs = ['notes/open', 'notes/private', 'notes/readers', 'notes/gone', 'notes/elsewhere', 'notes/never-written'];
    const read = (sourceIds: string[] | null, policy: 'read' | 'access') => asMember(async () => sorted(await engine.listVisiblePageSlugs(slugs, sourceIds, policy)));
    const out = {
      readEverySource: await read(null, 'read'),
      readDefault: await read(['default'], 'read'),
      readOther: await read(['other'], 'read'),
      accessEverySource: await read(null, 'access'),
      accessDefault: await read(['default'], 'access'),
      none: await asMember(() => engine.listVisiblePageSlugs([], null, 'read')),
    };
    expect(out.readEverySource).not.toContain('notes/private');
    expect(out.readEverySource).toEqual(expect.arrayContaining(['notes/open', 'notes/readers', 'notes/elsewhere']));
    expect(out.readEverySource).not.toContain('notes/gone');
    expect(out.readOther).toEqual(['notes/elsewhere']);
    expect(out.none).toEqual([]);
    return out;
  });

  parityTest('readPagesForVersionHistory reads the slug, source and frontmatter of the pages a history belongs to', {
    methods: ['putPage', 'readPageIdInSource', 'readPagesForVersionHistory'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/one', page('One', 'note', { tier: 'a' }));
    await engine.putPage('notes/two', page('Two', 'note'), { sourceId: 'other' });
    const [one, two] = [await idOf(engine, 'notes/one'), await idOf(engine, 'notes/two', 'other')];
    const rows = await engine.readPagesForVersionHistory([one, two, 987654]);
    const out = {
      rows: sorted(rows.map(r => `${r.slug}:${r.source_id}:${JSON.stringify(r.frontmatter)}`)),
      ids: rows.map(r => Number(r.id) === one ? 'one' : Number(r.id) === two ? 'two' : 'other').sort(),
      none: await engine.readPagesForVersionHistory([]),
    };
    expect(out.ids).toEqual(['one', 'two']);
    expect(out.none).toEqual([]);
    expect(out.rows[0]).toContain('"tier":"a"');
    return out;
  });
});
