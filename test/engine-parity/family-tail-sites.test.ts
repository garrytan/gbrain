/**
 * BrainEngine parity: the contradiction-cycle, ontology-repair and admin statements the edge-contradictions phase
 * (src/core/cycle/edge-contradictions.ts), the scoped contradiction reader (src/core/eval-contradictions), the two eval
 * reads, the re-key duplicate drop (src/core/facts/ontology-rekey.ts), `repair ontology-facts` and the admin operations
 * (src/core/ops/admin.ts) ran through `executeRaw` before they were members (src/core/engine-sql/contradictions-cycle.ts,
 * ontology-repair.ts, admin-reads.ts).
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
 *    captured queries; listRekeyLosers names the fact a re-key would duplicate (a conversation slot always loses to an
 *    ontology observation), repointSupersededToKept, clearOntologySlots and deleteRekeyLosers drop it (a conversation
 *    fact keeps its row); listOntologyFactCandidates lists the fenced and retired ontology rows with whether each would
 *    duplicate another and restoreOntologyFact restores one only while it is as the preview saw it; listVisiblePageSlugs
 *    keeps the slugs a caller may see under each page-policy part and readPagesForVersionHistory reads the pages a version
 *    history belongs to.
 *  - Regression: an engine that drops a clause hands the contradiction judge a private page's text, closes a stranger's
 *    relationship, deletes an ontology fact a re-key should have kept, restores a row that changed since the preview or
 *    names a private page to a remote caller in `most_connected`.
 *  - Why existing coverage misses it: the statements ran through `executeRaw`, which the parity cases cannot call (D18),
 *    so no case compared them across engines.
 *  - Seam: none. Pages come from putPage, links from addLink, facts from insertFacts and mergeOntologyFact, takes from
 *    addTakesBatch, runs and queries from their typed writers. Ids differ between arms, so every case maps them to slugs or
 *    to the name of the row it seeded.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
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

const at = (iso: string) => new Date(iso);

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

  parityTest('the last contradiction prompt version is the newest run\'s, and the captured queries come newest first up to the limit', {
    methods: ['writeContradictionsRun', 'logEvalCandidate', 'readLastContradictionsPromptVersion', 'listEvalCandidateQueries'],
  }, async (engine) => {
    const run = (id: string, prompt_version: string) => ({
      run_id: id, judge_model: 'judge-m1', prompt_version, queries_evaluated: 20, queries_with_contradiction: 4, total_contradictions_flagged: 6,
      wilson_ci_lower: 0.08, wilson_ci_upper: 0.42, judge_errors_total: 1, cost_usd_total: 0.37, duration_ms: 1234,
      source_tier_breakdown: {}, report_json: {},
    });
    const pause = () => new Promise(resolve => setTimeout(resolve, 15));
    const candidate = (query: string) => ({
      tool_name: 'query' as const, query, retrieved_slugs: [], retrieved_chunk_ids: [], source_ids: ['default'], expand_enabled: null, detail: null,
      detail_resolved: null, vector_enabled: false, expansion_applied: false, latency_ms: 1, remote: false, job_id: null, subagent_id: null,
    });
    const out: Record<string, unknown> = { noneYet: await engine.readLastContradictionsPromptVersion(), noQueries: await engine.listEvalCandidateQueries(5) };
    await engine.writeContradictionsRun(run('run-a', 'v1'));
    await pause();
    await engine.writeContradictionsRun(run('run-b', 'v2'));
    out.newest = await engine.readLastContradictionsPromptVersion();
    for (const q of ['first query', 'second query', 'third query']) await engine.logEvalCandidate(candidate(q));
    out.queries = await engine.listEvalCandidateQueries(100);
    out.limited = await engine.listEvalCandidateQueries(2);
    expect(out).toEqual({ noneYet: null, noQueries: [], newest: 'v2', queries: ['third query', 'second query', 'first query'], limited: ['third query', 'second query'] });
    return out;
  });
});

describe('engine parity: ontology re-key and repair statements', () => {
  const VALID_FROM = '2026-01-01T00:00:00Z';
  const obs = (entitySlug: string, dimension: string, value: string, source: string, validFrom = VALID_FROM) =>
    ({ entitySlug, dimension, value, source, validFrom, sourceId: 'default' });
  const factsOf = async (engine: BrainEngine, slug: string) => (await engine.listFactsByEntity('default', slug)).map(f => f.fact);

  parityTest('a re-key drops the observation the move would duplicate; a conversation slot loses and keeps its row', {
    methods: ['mergeOntologyFact', 'insertFacts', 'listFactsByEntity', 'listRekeyLosers', 'repointSupersededToKept', 'clearOntologySlots', 'deleteRekeyLosers'],
  }, async (engine) => {
    // An ontology observation on the old entity, and a conversation fact on the new one holding the same key.
    const old = await engine.mergeOntologyFact(obs('people/dan-old-example', 'location', 'Lisbon', 'meetings/chat-a'));
    await engine.insertFacts([{ fact: 'Dan lives in Lisbon.', entity_slug: 'people/dan-example', kind: 'fact', visibility: 'private',
      source: 'cli:extract-conversation-facts', source_markdown_slug: 'meetings/chat-a', row_num: 1, valid_from: at(VALID_FROM), dimension: 'location', value: 'Lisbon' } as never], { source_id: 'default' });
    const conversation = (await engine.listFactsByEntity('default', 'people/dan-example'))[0]!;
    const move = { where: 'f.entity_slug = $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: ['people/dan-old-example', 'people/dan-example'] as [unknown, unknown] };
    const losers = await engine.listRekeyLosers('default', move);
    const named = losers.map(l => [Number(l.id) === Number(conversation.id) ? 'conversation fact' : 'ontology fact', Number(l.keep) === Number(old.factId) ? 'ontology fact' : 'other']);
    await engine.clearOntologySlots(losers.map(l => Number(l.id)));
    await engine.deleteRekeyLosers(losers.map(l => Number(l.id)));
    const out: Record<string, unknown> = { named, oldAfter: await factsOf(engine, 'people/dan-old-example'), newAfter: await factsOf(engine, 'people/dan-example') };

    // Two ontology observations: the move's own row loses to the one already at the target, and supersession follows the survivor.
    const first = await engine.mergeOntologyFact(obs('people/eve-old-example', 'location', 'Lisbon', 'meetings/chat-b', '2026-01-01T00:00:00Z'));
    const second = await engine.mergeOntologyFact(obs('people/eve-old-example', 'location', 'Porto', 'meetings/chat-b', '2026-02-01T00:00:00Z'));
    const target = await engine.mergeOntologyFact(obs('people/eve-example', 'location', 'Porto', 'meetings/chat-b', '2026-02-01T00:00:00Z'));
    const eveMove = { where: 'f.entity_slug = $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: ['people/eve-old-example', 'people/eve-example'] as [unknown, unknown] };
    const eveLosers = await engine.listRekeyLosers('default', eveMove);
    out.eveLosers = eveLosers.map(l => [Number(l.id) === Number(second.factId) ? 'moving Porto' : 'other', Number(l.keep) === Number(target.factId) ? 'target Porto' : 'other']);
    await engine.repointSupersededToKept(eveLosers.map(l => Number(l.id)), eveLosers.map(l => Number(l.keep)));
    await engine.clearOntologySlots(eveLosers.map(l => Number(l.id)));
    await engine.deleteRekeyLosers(eveLosers.map(l => Number(l.id)));
    const left = await engine.listFactsByEntity('default', 'people/eve-old-example');
    out.eveOld = left.map(f => [f.fact, f.superseded_by === null ? null : Number(f.superseded_by) === Number(target.factId) ? 'target Porto' : 'other']);
    out.eveTarget = await factsOf(engine, 'people/eve-example');
    out.nothingToDrop = (await engine.listRekeyLosers('default', { ...eveMove, params: ['people/nobody', 'people/eve-example'] })).length;
    expect(first.factId).not.toBeNull();
    expect(out).toMatchObject({
      named: [['conversation fact', 'ontology fact']],
      oldAfter: ['location: Lisbon'], newAfter: ['Dan lives in Lisbon.'],
      eveLosers: [['moving Porto', 'target Porto']], nothingToDrop: 0,
    });
    return out;
  });

  parityTest('the ontology candidates list the fenced and retired rows with their class, and a restore applies only to a row as previewed', {
    methods: ['insertFacts', 'listOntologyFactCandidates', 'restoreOntologyFact'],
  }, async (engine) => {
    const row = (fact: string, over: Record<string, unknown>) => ({
      fact, entity_slug: 'people/fay-example', kind: 'fact', visibility: 'world', source: 'manual', source_markdown_slug: 'people/fay-example', row_num: null,
      valid_from: at(VALID_FROM), dimension: 'location', value: fact, ...over,
    });
    await engine.insertFacts([
      row('Lisbon', { row_num: 1 }),
      row('Porto', { row_num: 2, expired_at: at('2026-03-01T12:34:56.789Z') }),
      // Holds the key `Faro` would have once restored: the fenced Faro is a duplicate.
      row('Faro', { row_num: 3 }),
      row('Faro', { source_markdown_slug: 'manual', row_num: null }),
      // Conversation slots are never candidates.
      row('Braga', { source: 'cli:extract-conversation-facts', row_num: 4 }),
      // A plain fact has no ontology slot.
      row('plain fact', { dimension: null, value: null, row_num: 5 }),
    ] as never, { source_id: 'default' });
    const candidates = await engine.listOntologyFactCandidates(['default']);
    const name = (id: number | string) => candidates.find(c => Number(c.id) === Number(id));
    const view = candidates.map(c => ({ entity: c.entity_slug, dimension: c.dimension, row_num: c.row_num === null ? null : Number(c.row_num), page: c.page,
      expired: c.expired_at, withdrawn: c.withdrawn, consolidated: c.consolidated, duplicate: c.duplicate }));
    const byRow = (n: number) => candidates.find(c => Number(c.row_num) === n)!;
    const restore = (c: (typeof candidates)[number], over: Record<string, unknown> = {}) => engine.restoreOntologyFact({ id: Number(c.id), source_id: c.source_id,
      row_num: c.row_num === null ? null : Number(c.row_num), page: c.page, expired_at: c.expired_at, ...over });
    const out = {
      candidates: view,
      restoreChangedRow: (await restore(byRow(1), { row_num: 99 })).length,
      restoreChangedPage: (await restore(byRow(1), { page: 'people/other' })).length,
      restoreChangedExpiry: (await restore(byRow(1), { expired_at: '2026-03-01T00:00:00.000000Z' })).length,
      restoreDuplicate: (await restore(byRow(3))).length,
      restoreFenced: (await restore(byRow(1))).map(r => r.expired),
      restoreRetired: (await restore(byRow(2))).map(r => r.expired),
      restoreAgain: (await restore(byRow(1))).length,
      after: (await engine.listOntologyFactCandidates(['default'])).map(c => Number(c.row_num)),
      otherSource: (await engine.listOntologyFactCandidates(['nowhere'])).length,
    };
    expect(name(byRow(1).id)).toBeDefined();
    expect(candidates).toHaveLength(3);
    expect(out).toMatchObject({ restoreChangedRow: 0, restoreChangedPage: 0, restoreChangedExpiry: 0, restoreDuplicate: 0,
      restoreFenced: [false], restoreRetired: [false], restoreAgain: 0, after: [3], otherSource: 0 });
    expect(view.find(c => c.row_num === 3)?.duplicate).toBe(true);
    expect(view.find(c => c.row_num === 2)?.expired).toMatch(/^2026-03-01T12:34:56\.789000Z$/);
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
