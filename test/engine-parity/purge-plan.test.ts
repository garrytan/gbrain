/**
 * BrainEngine parity — the reads of a fact purge's plan, its dry run and `--match` that ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: purgeSubjectPageLive, listPurgePagesById, countPurgeVersionsCarryingClaim, listStagingsHoldingClaim,
 *    listStagingPartEdges, countPurgeReviewRows, listPurgeMatchCandidates, listRequestsCarryingClaim,
 *    listRequestsHoldingStagings, listDerivedRows, listSegmentedPageBodies, listSegmentedVersionBodies,
 *    countLegacyDerivedPages, listPageSourcePathsForPurge, listNearestFactsForPurge, setPurgeProbeTimeout,
 *    countPurgeProbe and listPurgeProbeItems return the
 *    same observable result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1), or the Rust arm stops on the typed engine_capability_missing refusal.
 *  - Regression: an engine that answers one of these differently changes what `forget --purge` plans to rewrite,
 *    what its dry run reports as still carrying the claim, and which facts `--match` offers; the Rust engine has no
 *    SQL, so each read has to exist as a typed method it can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines. Their SQL text is pinned by test/purge-plan-sql-pin.test.ts and
 *    test/fact-purge-sites-sql-pin.test.ts.
 *  - Seam: rows are seeded through the typed `putPage`, `createVersion`, `softDeletePage`, `insertFact`, `expireFact`,
 *    `addLink`, `addTimelineEntry`, `putRawData`, `insertWriteRequest` and the segmented-body members
 *    (test/helpers/page-body-fixtures.ts). Generated values (fact, page, link and request ids, revisions, staging ids)
 *    are compared by label or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { publishSegmentedPage, segmentText, stageGeneration } from '../helpers/page-body-fixtures.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const CLAIM = 'Acme "raised" a Seed';
const lower = (s: string) => s.toLowerCase();
const escaped = (s: string) => JSON.stringify(s).slice(1, -1).toLowerCase();
const NEEDLES = { sourceId: SRC, claimLower: lower(CLAIM), claimJson: escaped(CLAIM), reason: escaped(CLAIM) };
const carryingArgs = (sourceId: string, needle: string, json: string, reason: string) => [sourceId, needle, json, reason] as const;

const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}, type = 'note', source_path?: string) =>
  ({ type: type as 'note', title, compiled_truth: body, frontmatter, ...(source_path ? { source_path } : {}) });

type Fact = Partial<Parameters<BrainEngine['insertFact']>[0]> & { fact: string };

class Seed {
  readonly names = new Map<number, string>();
  constructor(readonly engine: BrainEngine) {}
  async fact(label: string, input: Fact, sourceId = SRC): Promise<number> {
    const r = await this.engine.insertFact({ entity_slug: null, source: 'chat', ...input }, { source_id: sourceId });
    expect(r.status).toBe('inserted');
    this.names.set(r.id, label);
    return r.id;
  }
  name = (id: number | string) => this.names.get(Number(id)) ?? '<unknown-id>';
}

function vec(...head: number[]): Float32Array {
  const v = new Float32Array(1536);
  head.forEach((x, i) => { v[i] = x; });
  return v;
}
const vecText = (...head: number[]) => `[${Array.from(vec(...head)).join(',')}]`;

describe('engine parity: fact purge plan, dry run and --match reads', () => {
  parityTest('purgeSubjectPageLive, listPurgePagesById and listPageSourcePathsForPurge read pages by slug and id', {
    methods: ['purgeSubjectPageLive', 'listPurgePagesById', 'listPageSourcePathsForPurge'],
  }, async (engine) => {
    const a = await engine.putPage('acme', note('Acme', 'body', {}, 'note', 'notes/acme.md'));
    const b = await engine.putPage('gone', note('Gone', 'body'));
    await engine.softDeletePage('gone');
    const live = await engine.purgeSubjectPageLive(SRC, 'acme');
    const deleted = await engine.purgeSubjectPageLive(SRC, 'gone');
    const missing = await engine.purgeSubjectPageLive(SRC, 'nobody');
    const elsewhere = await engine.purgeSubjectPageLive('elsewhere', 'acme');
    const pages = (await engine.listPurgePagesById(SRC, [a.id, b.id, a.id + b.id + 1000]))
      .map(p => ({ slug: p.slug, sameId: Number(p.page_id) === (p.slug === 'acme' ? a.id : b.id), revision: typeof p.revision }))
      .sort((x, y) => x.slug.localeCompare(y.slug));
    const otherSource = await engine.listPurgePagesById('elsewhere', [a.id]);
    const paths = (await engine.listPageSourcePathsForPurge([a.id, b.id])).map(r => r.source_path);
    const none = await engine.listPageSourcePathsForPurge([]);
    expect(live).toBe(true);
    expect(deleted).toBe(false);
    expect(pages.map(p => p.slug)).toEqual(['acme', 'gone']);
    return { live, deleted, missing, elsewhere, pages, otherSource, paths: [...paths].sort(), none };
  });

  parityTest('countPurgeVersionsCarryingClaim counts the source\'s versions that carry the claim in body, title, frontmatter or reason', {
    methods: ['countPurgeVersionsCarryingClaim'],
  }, async (engine) => {
    const before = await engine.countPurgeVersionsCarryingClaim(...carryingArgs(SRC, NEEDLES.claimLower, NEEDLES.claimJson, NEEDLES.reason));
    await engine.putPage('acme', note('Acme', `They said ${CLAIM} today`));
    await engine.createVersion('acme');
    await engine.putPage('acme', note('Acme', 'clean body'));
    await engine.createVersion('acme');
    await engine.putPage('titled', note(`Title: ${CLAIM.toUpperCase()}`, 'clean'));
    await engine.createVersion('titled');
    await engine.putPage('fm', note('FM', 'clean', { quote: CLAIM }));
    await engine.createVersion('fm');
    await engine.putPage('plain', note('Plain', 'nothing here'));
    await engine.createVersion('plain');
    const after = await engine.countPurgeVersionsCarryingClaim(...carryingArgs(SRC, NEEDLES.claimLower, NEEDLES.claimJson, NEEDLES.reason));
    const otherSource = await engine.countPurgeVersionsCarryingClaim(...carryingArgs('elsewhere', NEEDLES.claimLower, NEEDLES.claimJson, NEEDLES.reason));
    const empty = await engine.countPurgeVersionsCarryingClaim(...carryingArgs(SRC, 'no such text', 'no such text', 'no such text'));
    expect(before).toBe(0);
    expect(after).toBe(3);
    return { before, after, otherSource, empty };
  });

  parityTest('listPurgeMatchCandidates lists up to 25 facts of the source containing the text, by id, cut to 160 characters', {
    methods: ['listPurgeMatchCandidates', 'insertFact', 'expireFact'],
  }, async (engine) => {
    const seed = new Seed(engine);
    await seed.fact('exact', { fact: `Note: ${CLAIM}.`, entity_slug: 'companies/acme' });
    await seed.fact('upper', { fact: CLAIM.toUpperCase(), visibility: 'world' });
    const gone = await seed.fact('expired', { fact: `old ${CLAIM}` });
    await engine.expireFact(gone);
    await seed.fact('long', { fact: `${CLAIM} ${'x'.repeat(300)}` });
    await seed.fact('other', { fact: 'unrelated' });
    for (let i = 0; i < 25; i++) await seed.fact(`bulk-${i}`, { fact: `bulk ${i}: ${CLAIM}` });
    const rows = await engine.listPurgeMatchCandidates(SRC, lower(CLAIM));
    const none = await engine.listPurgeMatchCandidates(SRC, 'no such text');
    const elsewhere = await engine.listPurgeMatchCandidates('elsewhere', CLAIM);
    expect(rows.length).toBe(25);
    expect(rows.slice(0, 4).map(r => [seed.name(r.id), r.expired, r.fact.length])).toEqual([['exact', false, 27], ['upper', false, 20], ['expired', true, 24], ['long', false, 160]]);
    return {
      rows: rows.map(r => ({ id: seed.name(r.id), entity_slug: r.entity_slug, visibility: r.visibility, expired: r.expired, length: r.fact.length, head: r.fact.slice(0, 30) })),
      none, elsewhere,
    };
  });

  parityTest('listNearestFactsForPurge ranks the five nearest same-model facts and says which contain the claim', {
    methods: ['listNearestFactsForPurge', 'insertFact'],
  }, async (engine) => {
    const seed = new Seed(engine);
    await seed.fact('near', { fact: `${CLAIM}!`, embedding: vec(1, 0), embedding_model: 'm' });
    await seed.fact('mid', { fact: 'something else', embedding: vec(1, 1), embedding_model: 'm' });
    await seed.fact('far', { fact: 'acme  "RAISED" a seed, they said', embedding: vec(0, 1), embedding_model: 'm' });
    await seed.fact('opposite', { fact: 'x', embedding: vec(-1, 0), embedding_model: 'm' });
    await seed.fact('a', { fact: 'a', embedding: vec(1, 0.2), embedding_model: 'm' });
    await seed.fact('b', { fact: 'b', embedding: vec(1, 0.4), embedding_model: 'm' });
    await seed.fact('model', { fact: CLAIM, embedding: vec(1, 0), embedding_model: 'other' });
    await seed.fact('bare', { fact: CLAIM });
    const rows = await engine.listNearestFactsForPurge(vecText(1, 0), SRC, 'm', CLAIM);
    const none = await engine.listNearestFactsForPurge(vecText(1, 0), SRC, 'nobody', CLAIM);
    expect(rows.map(r => [seed.name(r.id), r.contains_claim])).toEqual([['near', true], ['a', false], ['b', false], ['mid', false], ['far', true]]);
    return { rows: rows.map(r => ({ id: seed.name(r.id), similarity: Math.round(Number(r.similarity) * 1000) / 1000, contains: r.contains_claim })), none };
  });

  parityTest('countLegacyDerivedPages counts live atom and dream-generated pages with no derivation edge', {
    methods: ['countLegacyDerivedPages'],
  }, async (engine) => {
    await engine.putPage('atoms/one', note('One', 'a', {}, 'atom'));
    await engine.putPage('dreams/flag', note('Flag', 'b', { dream_generated: true }));
    await engine.putPage('dreams/text', note('Text', 'c', { dream_generated: 'true' }));
    await engine.putPage('dreams/false', note('False', 'd', { dream_generated: false }));
    await engine.putPage('atoms/gone', note('Gone', 'e', {}, 'atom'));
    await engine.softDeletePage('atoms/gone');
    await engine.putPage('plain', note('Plain', 'f'));
    const n = await engine.countLegacyDerivedPages(SRC);
    const elsewhere = await engine.countLegacyDerivedPages('elsewhere');
    expect(n).toBe(3);
    return { n, elsewhere };
  });

  parityTest('countPurgeReviewRows counts nothing when no review row names the facts; part edges and derived rows are empty', {
    methods: ['countPurgeReviewRows', 'listStagingPartEdges', 'listDerivedRows', 'setPurgeProbeTimeout', 'transaction'],
  }, async (engine) => {
    const seed = new Seed(engine);
    const id = await seed.fact('f', { fact: CLAIM });
    const counts = await engine.countPurgeReviewRows(SRC, [String(id)], [id]);
    expect(counts).toEqual({ decide_review_queue: 0, decide_review_proposals: 0, decide_proposals: 0 });
    const empty = await engine.countPurgeReviewRows(SRC, [], []);
    const edges = await engine.listStagingPartEdges(SRC, 64, { id: '00000000-0000-0000-0000-000000000000', part: -1 });
    const derived = await engine.listDerivedRows([{ table: 'facts', id: String(id) }], 1001);
    await engine.transaction(async tx => { await tx.setPurgeProbeTimeout(2000); });
    return { counts, empty, edges, derived };
  });

  parityTest('segmented bodies: listSegmentedPageBodies, listSegmentedVersionBodies, the manifest arm of countPurgeVersionsCarryingClaim and listStagingsHoldingClaim', {
    methods: ['listSegmentedPageBodies', 'listSegmentedVersionBodies', 'countPurgeVersionsCarryingClaim', 'listStagingsHoldingClaim', 'createSegmentedPageShell'],
  }, async (engine) => {
    const texts = [segmentText(`intro ${CLAIM} here`), segmentText('second segment')];
    const { pageId } = await publishSegmentedPage(engine, 'big/acme', texts);
    await engine.putPage('inline', note('Inline', 'clean'));
    const pages = await engine.listSegmentedPageBodies(SRC, 1001);
    await engine.createVersion('big/acme');
    const versions = await engine.listSegmentedVersionBodies(SRC, 1001);
    const carrying = await engine.countPurgeVersionsCarryingClaim(...carryingArgs(SRC, NEEDLES.claimLower, NEEDLES.claimJson, NEEDLES.reason));
    const open = await stageGeneration(engine, { pageId, slug: 'big/acme', genFrom: 2, texts: [segmentText(`next ${CLAIM}`)] });
    const stagings = await engine.listStagingsHoldingClaim(SRC, CLAIM);
    const noClaim = await engine.listStagingsHoldingClaim(SRC, 'no such text');
    expect({ carrying, stagings: stagings.map(id => id === open.stagingId) }).toEqual({ carrying: 1, stagings: [true] });
    return {
      pages: pages.map(p => ({ slug: p.slug, samePage: Number(p.page_id) === pageId, generation: p.generation, version: p.version_id })),
      versions: versions.map(v => ({ slug: v.slug, generation: Number(v.generation), hasVersion: v.version_id != null })),
      carrying,
      stagings: stagings.map(id => id === open.stagingId ? 'open' : '<other>'),
      noClaim,
      limited: (await engine.listSegmentedPageBodies(SRC, 0)).length,
    };
  });

  parityTest('listRequestsCarryingClaim and listRequestsHoldingStagings read the source\'s requests by sequence', {
    methods: ['listRequestsCarryingClaim', 'listRequestsHoldingStagings', 'insertWriteRequest', 'lockPersistenceCounters', 'readSourceMembership'],
  }, async (engine) => {
    const KEYS = ['principal:local_cli:purge-plan', 'brain'];
    const source = await engine.readSourceMembership(SRC);
    const ids = new Map<string, string>();
    const admit = async (label: string, requestId: string, intent: Record<string, unknown>) => {
      await engine.lockPersistenceCounters(KEYS);
      const row = await engine.insertWriteRequest({
        principalKind: 'local_cli', principalId: 'purge-plan', requestId, operation: 'put_page', sourceId: SRC,
        sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/purge-plan', worktreeId: null, topologyGeneration: null,
        digest: 'd'.repeat(64), intent, authority: { scopes: ['write'] }, intentBytes: 100, terminalReservation: 4096,
        targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
        clientRequestId: null, state: 'queued', deferredRefreshId: null,
      });
      ids.set(row.id, label);
    };
    await admit('carries', 'b0000000-0000-4000-8000-0000000000b1', { kind: 'put_page', body: `say ${CLAIM}` });
    await admit('clean', 'b0000000-0000-4000-8000-0000000000b2', { kind: 'put_page', body_ref: { staging_id: 'staging-a' } });
    await admit('also', 'b0000000-0000-4000-8000-0000000000b3', { kind: 'put_page', text: CLAIM.toUpperCase() });
    const name = (rows: Array<{ id: string; principal_kind: string; principal_id: string }>) =>
      rows.map(r => `${ids.get(r.id) ?? '<unknown>'}:${r.principal_kind}:${r.principal_id}`);
    expect(name(await engine.listRequestsCarryingClaim({ ...NEEDLES, limit: 10_000 }))).toEqual(['carries:local_cli:purge-plan', 'also:local_cli:purge-plan']);
    return {
      carrying: name(await engine.listRequestsCarryingClaim({ ...NEEDLES, limit: 10_000 })),
      limited: name(await engine.listRequestsCarryingClaim({ ...NEEDLES, limit: 1 })),
      elsewhere: name(await engine.listRequestsCarryingClaim({ ...NEEDLES, sourceId: 'elsewhere', limit: 10 })),
      holding: name(await engine.listRequestsHoldingStagings(SRC, ['staging-a', 'staging-b'])),
      notHolding: name(await engine.listRequestsHoldingStagings(SRC, ['staging-b'])),
    };
  });

  parityTest('countPurgeProbe and listPurgeProbeItems find the links and timeline rows that still carry the claim', {
    methods: ['countPurgeProbe', 'listPurgeProbeItems', 'addLink', 'addTimelineEntry'],
  }, async (engine) => {
    await engine.putPage('acme', note('Acme', 'a'));
    await engine.putPage('beta', note('Beta', 'b'));
    await engine.addLink('acme', 'beta', `they said ${CLAIM}`, 'mentions');
    await engine.addLink('beta', 'acme', 'clean context', 'mentions');
    await engine.addTimelineEntry('acme', { date: '2026-01-02', summary: `Raised: ${CLAIM}`, detail: '' });
    await engine.addTimelineEntry('beta', { date: '2026-01-03', summary: 'clean', detail: `detail ${CLAIM.toUpperCase()}` });
    await engine.addTimelineEntry('beta', { date: '2026-01-04', summary: 'clean', detail: 'clean' });
    const needles = [CLAIM];
    const strip = (items: string[]) => items.map(item => item.replace(/^(\w+):\d+ /, '$1:<id> '));
    const named = (table: 'links' | 'timeline_entries') => ({ kind: 'named' as const, table, sourceId: SRC, needles });
    expect(await engine.countPurgeProbe(named('links'), 1000)).toBe(1);
    expect(strip(await engine.listPurgeProbeItems(named('timeline_entries'))).sort()).toEqual(['timeline:<id> acme 2026-01-02', 'timeline:<id> beta 2026-01-03']);
    return {
      links: await engine.countPurgeProbe(named('links'), 1000),
      linkItems: strip(await engine.listPurgeProbeItems(named('links'))),
      timeline: await engine.countPurgeProbe(named('timeline_entries'), 1000),
      timelineItems: strip(await engine.listPurgeProbeItems(named('timeline_entries'))).sort(),
      bounded: await engine.countPurgeProbe(named('timeline_entries'), 0),
      wanted: await engine.countPurgeProbe({ kind: 'table', table: 'wanted_links', sourceId: SRC, needles }, 1000),
      noNeedles: await engine.countPurgeProbe({ ...named('links'), needles: [] }, 1000),
      elsewhere: await engine.countPurgeProbe({ ...named('links'), sourceId: 'elsewhere' }, 1000),
    };
  });

  parityTest('countPurgeProbe counts raw_data rows carrying the claim, and a table the Rust store keeps no rows of counts 0', {
    methods: ['countPurgeProbe', 'putRawData'],
  }, async (engine) => {
    await engine.putPage('acme', note('Acme', 'a'));
    await engine.putRawData('acme', 'crawler', { text: `quote: ${CLAIM}` });
    await engine.putRawData('acme', 'other', { text: 'clean' });
    const needles = [CLAIM];
    expect(await engine.countPurgeProbe({ kind: 'named', table: 'raw_data', sourceId: SRC, needles }, 1000)).toBe(1);
    return {
      raw: await engine.countPurgeProbe({ kind: 'named', table: 'raw_data', sourceId: SRC, needles }, 1000),
      pinned: await engine.countPurgeProbe({ kind: 'table', table: 'pinned_questions', sourceId: SRC, needles }, 1000),
    };
  });

  parityTest('listPurgeProbeItems names raw_data rows by id on every engine', {
    methods: ['listPurgeProbeItems', 'putRawData'],
  }, async (engine) => {
    await engine.putPage('acme', note('Acme', 'a'));
    await engine.putRawData('acme', 'crawler', { text: `quote: ${CLAIM}` });
    const items = await engine.listPurgeProbeItems({ kind: 'named', table: 'raw_data', sourceId: SRC, needles: [CLAIM] });
    const named = items.map(item => item.replace(/^raw_data:\d+ /, 'raw_data:<id> '));
    expect(named).toEqual(['raw_data:<id> acme crawler']);
    return named;
  });

  parityTest('countPurgeProbe of a whole table the store keeps (minion_jobs, none carrying the claim) counts 0 on every engine', {
    methods: ['countPurgeProbe'],
  }, async (engine) => {
    const n = await engine.countPurgeProbe({ kind: 'table', table: 'minion_jobs', sourceId: SRC, needles: [CLAIM] }, 1000);
    expect(n).toBe(0);
    return n;
  });

  parityTest('countPurgeProbe refuses a table outside the inventory, a column the table does not have and a named probe of a table with no named-row probe', {
    methods: ['countPurgeProbe'],
  }, async (engine) => {
    // Each probe names a store the inventory does not vouch for; every engine must refuse it before it reads anything,
    // so no caller-supplied table or column text ever reaches a statement.
    const refusal = async (probe: Parameters<BrainEngine['countPurgeProbe']>[0]) => {
      try { return { counted: await engine.countPurgeProbe(probe, 1000) }; }
      catch (error) { return { refused: (error as Error).message }; }
    };
    const refusals = {
      catalogTable: await refusal({ kind: 'table', table: 'pg_class', sourceId: SRC, needles: [CLAIM] }),
      injectedColumn: await refusal({ kind: 'table', table: 'wanted_links', sourceId: SRC, needles: [CLAIM], probe: ['summary) OR (true'] }),
      unnamedTable: await refusal({ kind: 'named', table: 'wanted_links' as never, sourceId: SRC, needles: [CLAIM] }),
    };
    expect(refusals).toEqual({
      catalogTable: { refused: 'purge probe: pg_class is not an inventory table' },
      injectedColumn: { refused: 'purge probe: wanted_links has no column summary) OR (true' },
      unnamedTable: { refused: 'purge probe: wanted_links has no named-row probe' },
    });
    return refusals;
  });
});
