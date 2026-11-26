/**
 * BrainEngine parity — the belief-ledger half of a purge (src/core/belief/purge.ts, belief/preimages.ts): the steps a
 * fact purge (facts/purge.ts) and a page purge (persistence/page-purge.ts) run on a source that records belief events.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres and Rust, each step answers the same and leaves the same ledger: redactPurgedKeys
 *    clears the recorded values of the purged claim's fact and take events and of the page lifetimes' events, once;
 *    redactCarryingFields writes the marker into each recorded field that quotes the claim and registers it;
 *    registerLiveCarriers registers the live fact, take and link fields that quote it; the page purge's inventory
 *    (pageLifetimesOf, pagePurgeClaims) lists the page's lifetimes, live claims, version fence claims and lifetime
 *    events; derivedStreamSlugs, the preimage check (missingPreimages) and registerVersionCarriers read the same rows.
 *  - Regression: these steps sent raw SQL, so a purge on a Rust ledger source stopped part way, and the page purge's
 *    list called them unreachable on Rust ("a Rust brain has no ledger").
 *  - Why existing coverage misses it: test/engine-parity/belief-purge-probes.test.ts pins the purge's typed ledger
 *    members one by one (epoch, presence, suppressions, the receipt read); fact-purge-receipt-e2e.test.ts runs a whole
 *    fact purge but no page purge, and on main its ledger case stopped before these steps.
 *  - Seam: none. Events are seeded through the typed insertBeliefEvents and lifetimes through mintBeliefLifetime; the
 *    steps run in the engine's transaction. Generated values (event and suppression ids, page and take ids, revisions)
 *    are compared by relation, never by value.
 */
import { afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BeliefEventInsertRow } from '../../src/core/engine-sql/belief-ledger.ts';
import { derivedStreamSlugs, pageLifetimesOf, pagePurgeClaims, redactCarryingFields, redactPurgedKeys, registerLiveCarriers,
  registerVersionCarriers } from '../../src/core/belief/purge.ts';
import { missingPreimages } from '../../src/core/belief/preimages.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { PURGE_OWNERS, purgePathStops } from '../../src/core/persistence/purge-path-members.ts';
import { createSource, enableBeliefCoverage, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const PURGE = 'a0000000-0000-4000-8000-0000000000b1';
const PUB = 'd0000000-0000-4000-8000-0000000000b1';
const LIFE = 'e0000000-0000-4000-8000-0000000000b1';
const LIFE2 = 'e0000000-0000-4000-8000-0000000000b2';
const CLAIM = 'Acme pays its suppliers in cash';

/** A recorded event of `sourceId` at `ord`; `value` is its recorded value (null: a value-less event). */
function event(sourceId: string, incarnation: string, ord: number, value: Record<string, unknown> | null, over: Partial<BeliefEventInsertRow> = {}): BeliefEventInsertRow {
  return {
    event_key: `eb${sourceId === SRC ? '00' : '01'}${ord.toString(16).padStart(2, '0')}`, source_id: sourceId, source_incarnation: incarnation, page_lifetime: LIFE,
    slug: 'companies/acme-example', subject_kind: 'fact', subject_key: `fact:${ord}`, event_type: 'fact.asserted', origin: 'live', trust_tier: 'owner',
    writer_tier: null, tier_basis: 'row', visibility: 'world', publication_id: PUB, ord, source_time: '2026-03-01T10:00:00.000Z', valid_from: null,
    valid_until: null, value: value === null ? null : JSON.stringify(value), value_hash: value === null ? null : `vh${ord}`, prior_hash: null,
    state_hash: `sh${ord}`, cause: JSON.stringify({ kind: 'test' }), claim_fp: `fp${ord}`, purged: false, redacted_fields: null, ...over,
  };
}

/** The source's events that keep a recorded value, as subject key and value, in id order. */
async function valued(engine: BrainEngine, sourceId = SRC) {
  return (await engine.listBeliefEventsForPurgeProbe(sourceId, 0))
    .map(r => ({ subject_key: r.subject_key, value: typeof r.value === 'string' ? JSON.parse(r.value) : r.value }));
}

/** A subject key with its page lifetimes (random uuids minted per brain) folded out. */
const keyShape = (key: string) => key.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<lifetime>');

/** The source's suppressions on the subjects, without their ids and with lifetimes folded, in a fixed order. */
async function suppressions(engine: BrainEngine, subjects: string[]) {
  const rows = await engine.readBeliefRedactions(SRC, subjects, []);
  return sorted(rows.map(({ id: _id, ...rest }) => ({ ...rest, subject_key: keyShape(rest.subject_key) })), r => `${r.subject_key}|${r.field}|${r.field_hash}`);
}

const page = (title: string, body = `${title} body.`) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });

const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
const row = (n: number, claim: string, context = '') => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat | ${context} |`;

describe('engine parity: the belief-ledger steps of a purge', () => {
  parityTest('redactPurgedKeys clears the recorded values of the claim\'s fact and take events and of the page lifetimes\' events, once', {
    methods: ['readLedgerSource', 'insertBeliefEvents', 'transaction', 'listBeliefEventsForPurgeProbe', 'redactPurgedBeliefKeys'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const inc = (await engine.readLedgerSource(SRC))!.incarnation;
    const otherInc = (await engine.readLedgerSource('other'))!.incarnation;
    await engine.insertBeliefEvents([
      event(SRC, inc, 1, { fact: CLAIM }, { claim_fp: 'fpX' }),
      event(SRC, inc, 2, { claim: CLAIM }, { claim_fp: 'fpX', subject_kind: 'take', subject_key: 'take:2' }),
      // A link event with the same fingerprint is not a fact or take: it keeps its value.
      event(SRC, inc, 3, { context: 'a link' }, { claim_fp: 'fpX', subject_kind: 'link', subject_key: 'link:3' }),
      // A page event of the purged page's lifetime loses its value whatever its fingerprint.
      event(SRC, inc, 4, { slug: 'companies/acme-example' }, { claim_fp: null, subject_kind: 'page', subject_key: 'page:4', page_lifetime: LIFE2 }),
      event(SRC, inc, 5, { fact: 'Acme has two offices' }, { claim_fp: 'fpY' }),
      // Already purged: no value, no prior hash. Not counted again.
      event(SRC, inc, 7, null, { claim_fp: 'fpX', purged: true }),
      event('other', otherInc, 6, { fact: CLAIM }, { claim_fp: 'fpX' }),
    ]);
    const first = await engine.transaction(tx => redactPurgedKeys(tx, { sourceId: SRC, claimFps: ['fpX'], lifetimes: [LIFE2] }));
    const again = await engine.transaction(tx => redactPurgedKeys(tx, { sourceId: SRC, claimFps: ['fpX'], lifetimes: [LIFE2] }));
    const answers = { first, again, left: await valued(engine), other: await valued(engine, 'other') };
    expect({ first, again }).toEqual({ first: 3, again: 0 });
    expect(answers.left.map(r => r.subject_key)).toEqual(['link:3', 'fact:5']);
    return answers;
  });

  parityTest('redactCarryingFields writes the marker into each recorded field that quotes the claim, registers it, and leaves the rest', {
    methods: ['readLedgerSource', 'insertBeliefEvents', 'transaction', 'listBeliefEventsForPurgeProbe', 'readBeliefRedactions',
      'listBeliefCarrierEvents', 'readBeliefEventValue', 'rewriteBeliefEventFields', 'rechainBeliefPriorHash', 'registerPurgeRedaction'],
  }, async (engine) => {
    const inc = (await engine.readLedgerSource(SRC))!.incarnation;
    await engine.insertBeliefEvents([
      event(SRC, inc, 1, { fact: 'Acme sells widgets', context: `memo: ${CLAIM}` }, { subject_key: 'fact:1' }),
      // A later event of the same subject chained to the first: its prior hash follows the rewrite.
      event(SRC, inc, 2, { fact: 'Acme sells widgets', context: 'board memo' }, { subject_key: 'fact:1', prior_hash: 'vh1' }),
      event(SRC, inc, 3, { claim: 'Acme will grow', resolved_source: `said ${CLAIM.toUpperCase()}` }, { subject_kind: 'take', subject_key: 'take:3' }),
      event(SRC, inc, 4, { context: `per ${CLAIM}` }, { subject_kind: 'link', subject_key: 'link:4' }),
      event(SRC, inc, 5, { fact: 'Acme has two offices', context: 'annual report' }),
      // A page event is no carrier, whatever it holds.
      event(SRC, inc, 6, { context: CLAIM }, { subject_kind: 'page', subject_key: 'page:6' }),
    ]);
    const redacted = await engine.transaction(tx => redactCarryingFields(tx, { sourceId: SRC, request: PURGE, claims: [CLAIM] }));
    const base = Math.min(...redacted.map(r => r.event_id));
    const answers = {
      redacted: redacted.map(r => ({ ...r, event_id: r.event_id - base })),
      left: await valued(engine),
      suppressions: await suppressions(engine, ['fact:1', 'take:3', 'link:4', 'fact:5', 'page:6']),
    };
    expect(redacted.map(r => `${r.field}@${r.subject_key}`)).toEqual(['context@fact:1', 'resolved_source@take:3', 'context@link:4']);
    expect(JSON.stringify(answers.left).toLowerCase().split(CLAIM.toLowerCase()).length - 1).toBe(1);
    return answers;
  });

  parityTest('registerLiveCarriers registers the live fact, take and link fields that quote the claim', {
    methods: ['putPage', 'insertFacts', 'addTakesBatch', 'resolveTake', 'addLink', 'transaction', 'readBeliefRedactions', 'listBeliefQuotingRows'],
    timeout: 60_000,
  }, async (engine, backend) => {
    await enableBeliefCoverage(engine, backend, SRC);
    const memo = await engine.putPage('notes/memo', page('Memo'));
    await engine.putPage('notes/other', page('Other'));
    const fact = (text: string, entity: string, rowNum: number, context: string | null) =>
      ({ fact: text, entity_slug: entity, kind: 'fact', visibility: 'world', source: 'chat', context, row_num: rowNum, source_markdown_slug: entity });
    await engine.insertFacts([fact('Acme sells widgets', 'notes/memo', 1, `memo: ${CLAIM}`), fact('Acme has two offices', 'notes/memo', 2, 'annual report'),
      fact(CLAIM, 'notes/memo', 3, null)] as never, { source_id: SRC });
    await engine.addTakesBatch([{ page_id: memo.id, row_num: 1, claim: 'Acme will grow', kind: 'bet', holder: 'brain', weight: 0.6 }]);
    await engine.resolveTake(memo.id, 1, { quality: 'correct', source: `said ${CLAIM}`, resolvedBy: 'notes/memo' });
    await engine.addLink('notes/memo', 'notes/other', `per ${CLAIM}`, 'mentions');
    const carriers = await engine.transaction(tx => registerLiveCarriers(tx, { sourceId: SRC, request: PURGE, claims: [CLAIM] }));
    const keys = [...new Set(carriers.map(c => c.subject_key))];
    const answers = { carriers: sorted(carriers.map(c => `${c.field}@${keyShape(c.subject_key)}`)), suppressions: await suppressions(engine, keys) };
    expect(answers.carriers.length).toBeGreaterThanOrEqual(2);
    return answers;
  });

  parityTest('pageLifetimesOf and pagePurgeClaims list a page\'s lifetimes, live claims, version fence claims and lifetime events', {
    methods: ['putPage', 'createVersion', 'insertFacts', 'addTakesBatch', 'readLedgerSource', 'mintBeliefLifetime', 'endBeliefLifetime',
      'insertBeliefEvents', 'transaction', 'listPageBeliefLifetimes', 'listPagePurgeLiveClaims', 'listPageVersionFenceBodies', 'listLifetimeClaimEvents'],
    timeout: 60_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const inc = (await engine.readLedgerSource(SRC))!.incarnation;
    const slug = 'people/alice-example';
    const alice = await engine.putPage(slug, page('Alice', `# Alice\n\n${fence([row(1, 'Alice likes oolong tea'), row(2, 'Alice walks to work')])}\n`));
    await engine.createVersion(slug);
    await engine.putPage(slug, page('Alice', '# Alice\n\nNo facts now.'));
    const bob = await engine.putPage('people/bob-example', page('Bob'));
    await engine.insertFacts([{ fact: 'Alice owns a boat', entity_slug: slug, kind: 'fact', visibility: 'world', source: 'chat', row_num: 1, source_markdown_slug: slug },
      { fact: 'Bob owns a car', entity_slug: 'people/bob-example', kind: 'fact', visibility: 'world', source: 'chat', row_num: 1, source_markdown_slug: 'people/bob-example' }] as never,
    { source_id: SRC });
    await engine.addTakesBatch([{ page_id: alice.id, row_num: 1, claim: 'Alice will move', kind: 'bet', holder: 'brain', weight: 0.6 },
      { page_id: bob.id, row_num: 1, claim: 'Bob will stay', kind: 'bet', holder: 'brain', weight: 0.6 }]);
    // The page's open lifetime, an ended lifetime with the page as its hint, and another page's lifetime.
    const open = await engine.mintBeliefLifetime({ lifetime: LIFE, sourceId: SRC, incarnation: inc, slug, pageId: alice.id });
    const ended = await engine.mintBeliefLifetime({ lifetime: LIFE2, sourceId: SRC, incarnation: inc, slug: 'people/alice-old', pageId: alice.id });
    await engine.endBeliefLifetime(ended);
    const elsewhere = await engine.mintBeliefLifetime({ lifetime: 'e0000000-0000-4000-8000-0000000000b3', sourceId: SRC, incarnation: inc, slug: 'people/bob-example', pageId: bob.id });
    await engine.insertBeliefEvents([
      event(SRC, inc, 1, { fact: 'Alice was in Lisbon' }, { page_lifetime: open, claim_fp: 'fpL1' }),
      event(SRC, inc, 2, { claim: 'Alice will retire' }, { page_lifetime: ended, subject_kind: 'take', subject_key: 'take:2', claim_fp: 'fpL2' }),
      event(SRC, inc, 3, { slug }, { page_lifetime: open, subject_kind: 'page', subject_key: 'page:3', claim_fp: null }),
      event(SRC, inc, 4, { fact: 'Bob was in Paris' }, { page_lifetime: elsewhere, claim_fp: 'fpB' }),
    ]);
    const lifetimes = await engine.transaction(tx => pageLifetimesOf(tx, SRC, slug, alice.id));
    const inventory = await engine.transaction(tx => pagePurgeClaims(tx, { sourceId: SRC, slug, pageId: alice.id, lifetimes }));
    const answers = { lifetimes: sorted(lifetimes), claims: sorted(inventory.claims), fps: sorted(inventory.fps).length };
    expect(answers.lifetimes).toEqual(sorted([open, ended]));
    expect(answers.claims).toEqual(sorted(['Alice likes oolong tea', 'Alice walks to work', 'Alice owns a boat', 'Alice will move', 'Alice was in Lisbon', 'Alice will retire']));
    return answers;
  });

  parityTest('derivedStreamSlugs, the preimage check and registerVersionCarriers read the same rows', {
    methods: ['putPage', 'createVersion', 'getVersions', 'insertFacts', 'addTakesBatch', 'listFactsSince', 'listTakes', 'transaction', 'readPageSnapshot',
      'listDerivedStreamSlugs', 'listMissingPreimages', 'listPurgeCarrierVersions'],
    timeout: 60_000,
  }, async (engine, backend) => {
    await enableBeliefCoverage(engine, backend, SRC);
    await createSource(engine, backend, 'other');
    const slug = 'people/carol-example';
    const carol = await engine.putPage(slug, page('Carol', `# Carol\n\n${fence([row(1, 'Carol likes jazz', `she told us ${CLAIM}`)])}\n`));
    await engine.createVersion(slug);
    const versions = await engine.getVersions(slug);
    await engine.putPage(slug, page('Carol', '# Carol\n\nRewritten.'));
    const dave = await engine.putPage('people/dave-example', page('Dave'));
    const elsewhere = await engine.putPage('people/dave-example', page('Dave'), { sourceId: 'other' } as never);
    await engine.insertFacts([{ fact: 'Dave sails', entity_slug: 'people/dave-example', kind: 'fact', visibility: 'world', source: 'chat', row_num: 1, source_markdown_slug: 'people/dave-example' },
      { fact: 'Nobody sails', entity_slug: null, kind: 'fact', visibility: 'world', source: 'chat', row_num: 2, source_markdown_slug: null }] as never, { source_id: SRC });
    await engine.addTakesBatch([{ page_id: dave.id, row_num: 1, claim: 'Dave will sail', kind: 'bet', holder: 'brain', weight: 0.6 }]);
    const facts = await engine.listFactsSince(SRC, new Date(0), { activeOnly: false, limit: 100 } as never);
    const sails = facts.find(f => f.fact === 'Dave sails')!.id;
    const nobody = facts.find(f => f.fact === 'Nobody sails')!.id;
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: SRC });
    const result = await engine.transaction(async tx => {
      const takeId = (await tx.listTakes({ page_id: dave.id }))[0]!.id;
      const streams = await derivedStreamSlugs(tx, SRC, [{ table: 'facts', id: String(sails), depth: 1 }, { table: 'facts', id: String(nobody), depth: 1 },
        { table: 'takes', id: String(takeId), depth: 1 }, { table: 'pages', id: String(dave.id), depth: 1 }, { table: 'pages', id: String(elsewhere.id), depth: 1 }]);
      const missing = await missingPreimages(tx, [{ pageId: carol.id, slug, revision: String(versions[0]!.knowledge_revision ?? '') },
        { pageId: carol.id, slug, revision: snapshot!.revision }]);
      const carriers = await registerVersionCarriers(tx, { sourceId: SRC, request: PURGE, claims: [CLAIM], versionIds: versions.map(v => Number(v.id)) });
      return { streams: [...streams.entries()].map(([ref, s]) => `${ref.split(':')[0]}->${s}`).sort(), missing: missing.map(m => m.revision === snapshot!.revision),
        carriers: carriers.map(c => c.field) };
    });
    expect(result.streams).toEqual(['facts->people/dave-example', 'pages->people/dave-example', 'takes->people/dave-example']);
    return result;
  });
});

const opened: BrainEngine[] = [];
afterEach(async () => {
  for (const engine of opened.splice(0)) await disposePersistenceConsumer(engine).catch(() => undefined);
});

const localCtx = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {}, debug() {} },
  dryRun: false, remote: false, sourceId: SRC }) as unknown as OperationContext;
const notePage = (title: string, body: string) => ['---', `title: ${title}`, 'type: note', '---', `# ${title}`, '', body].join('\n');

describe('engine parity: a page purge on a source that records belief events', () => {
  parityTest('delete_page --purge redacts the page\'s recorded history on the SQL engines; on Rust it stops only at the request-index read, never at a ledger step', {
    methods: ['readPageSnapshot', 'listBeliefEventsForPurgeProbe', 'readBeliefRedactions'],
    // On Rust the page purge still stops at its pre-write check on lane 14's request-index read (purge-path-members.ts).
    requires: 'raw_sql',
    timeout: 120_000,
  }, async (engine, backend) => {
    opened.push(engine);
    await enableBeliefCoverage(engine, backend, SRC);
    const put = (slug: string, content: string) => operationsByName.put_page.handler(localCtx(engine), { slug, content, request_id: randomUUID() });
    await put('notes/doomed', notePage('doomed', `Doomed notes.\n\n## Facts\n\n${fence([row(1, CLAIM)])}\n`));
    await put('notes/keeper', notePage('keeper', `Keeper notes.\n\n## Facts\n\n${fence([row(1, 'Keeper likes tea', `per ${CLAIM}`)])}\n`));
    const before = await valued(engine);
    const snapshot = await engine.readPageSnapshot('notes/doomed', { sourceId: SRC });
    const args = { slug: 'notes/doomed', purge: true, request_id: randomUUID(), expected_revision: snapshot?.revision };
    if (backend === 'rust') {
      const error = await operationsByName.delete_page.handler(localCtx(engine), args).then(() => null, (e: unknown) => e);
      // Every belief-ledger step is a served member: the only stop is lane 14's, and nothing was written.
      expect((await purgePathStops(engine)).map(stop => stop.name)).toEqual(['readRequestIndexStates (persistence/checkpoint-validation.ts)']);
      expect((error as { code?: string } | null)?.code).toBe('engine_capability_missing');
      expect({ page: (await engine.getPage('notes/doomed', { sourceId: SRC })) !== null, events: await valued(engine) }).toEqual({ page: true, events: before });
      throw error;
    }
    const done = await operationsByName.delete_page.handler(localCtx(engine), args) as Record<string, unknown>;
    const after = await valued(engine);
    const keys = [...new Set([...before, ...after].map(e => e.subject_key))];
    const answers = { status: done.status, before: before.length, after: after.map(e => JSON.parse(keyShape(JSON.stringify(e)))),
      suppressions: await suppressions(engine, keys) };
    expect(JSON.stringify(answers.after).toLowerCase().includes(CLAIM.toLowerCase())).toBe(false);
    return answers;
  });

  parityTest('no purge list calls a belief-ledger step unreachable on Rust: each one is a served member of the ledger owner', {
    methods: ['hasBeliefEvents'],
  }, async (engine) => {
    const { PURGE_PATH } = await import('../../src/core/persistence/purge-path-members.ts');
    const { FACT_PURGE_PATH } = await import('../../src/core/persistence/fact-purge-path-members.ts');
    const entries = [...PURGE_PATH, ...FACT_PURGE_PATH] as unknown as Array<Record<string, unknown>>;
    const answers = {
      falseGuards: entries.filter(e => typeof e.guarded === 'string' && /no ledger/.test(e.guarded)).map(e => e.site),
      ledgerStops: entries.filter(e => typeof e.site === 'string' && /belief\/(purge|preimages)\.ts/.test(e.site as string)).map(e => e.site),
      ledgerMembers: [...new Set(entries.filter(e => e.owner === (PURGE_OWNERS as Record<string, string>).beliefLedger).map(e => e.member as string))].sort(),
      present: await engine.hasBeliefEvents(SRC),
    };
    expect({ falseGuards: answers.falseGuards, ledgerStops: answers.ledgerStops }).toEqual({ falseGuards: [], ledgerStops: [] });
    expect(answers.ledgerMembers.length).toBe(14);
    return answers;
  });
});
