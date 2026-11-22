/**
 * BrainEngine parity — the labelled-only page policy (GBRA-108 design 1: CallerAccess.labelledOnly, labelledOnlySql and
 * labelledOnlyFactSql in src/core/search/private-visibility.ts): a member that carries the labelled-only grant reads only
 * the pages that name it, by readable_by or a folder rule that lists it, and no fact except its own member page's.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    a labelled-only member reads the page that names it and the pages under a folder rule that lists it, never an
 *    unlabelled page or a page kept to someone else, and a member without the grant still reads the open page. Facts:
 *    the labelled-only member reads the facts of its own member page only.
 *  - Regression: the Rust store's page policy did not serve a labelled-only caller, so every read such a caller made
 *    refused with engine_capability_missing (docs/designs/RUST_ENGINE.md row 32e).
 *  - Known losses on Rust (rows 32e-2 to 32e-5): a labelled-only caller's remote read floor, a labelled-only caller
 *    with lineage or an audience, a folder-rule caller's world-only fact list, and a page a moved rule's stale stamp
 *    still labels. The last describe pins each: Rust refuses or hides while PGLite serves, so a pin fails when Rust
 *    stops refusing or starts showing, and its row must leave the table.
 *  - Why existing coverage misses it: access-members.test.ts reads one core-page list and pins the Rust refusal;
 *    test/access-labelled-only.test.ts runs on the SQL engines only.
 *  - Seam: none. Members through addMember and setMemberLabelledOnly, rules through proposeRevision, pages through
 *    putPage, facts through insertFacts; each caller is the stdio server bound to the member (mcp.stdio_member).
 */
import { describe, expect, test } from 'bun:test';
import { createSource, parityArms, resetArm, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { addMember } from '../../src/core/access/members.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { audienceCallerAccess, remoteCallerAccess } from '../../src/core/access/caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest, arms } = parityArms(testBackends());

const core = (title: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: `body ${title}`, timeline: '', frontmatter: { always_load: true, ...frontmatter } });

/** alice (labelled-only, group team-a), bob; an open page, pages kept to each, a team page, and a folder rule. */
async function seed(engine: BrainEngine): Promise<void> {
  await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
  await addMember(engine, 'alice-example', { groups: ['team-a'] });
  await addMember(engine, 'bob-example');
  await setMemberLabelledOnly(engine, 'alice-example', true, { remote: false });
  await engine.putPage('core/open', core('Open'), { sourceId: 'default' });
  await engine.putPage('core/for-alice', core('For alice', { readable_by: ['alice-example'] }), { sourceId: 'default' });
  await engine.putPage('core/for-bob', core('For bob', { readable_by: ['bob-example'] }), { sourceId: 'default' });
  await engine.putPage('core/for-team', core('For team', { readable_by: ['group:team-a'] }), { sourceId: 'default' });
  await engine.putPage('deals/q4', core('Q4'), { sourceId: 'default' });
  await proposeRevision(engine, 'default', [{ id: 'deals', prefix: 'deals/', readable_by: ['member:alice-example', 'member:bob-example'] }], { origin: 'cli', store: 'database' });
}

/** Runs `read` as the stdio server bound to `member`. */
async function as<T>(engine: BrainEngine, member: string, read: () => Promise<T>): Promise<T> {
  await engine.setConfig('mcp.stdio_member', member);
  return withCallerAccess(await remoteCallerAccess(engine, undefined, [], 'stdio'), read);
}

const corePages = async (engine: BrainEngine) =>
  (await engine.listCorePageRows({ excludePrivate: true, forCaller: true, limit: 50 })).map(r => r.slug).sort();

const VERSIONED = ['core/open', 'core/for-alice', 'core/was-open', 'deals/q4'] as const;

/**
 * A labelled-only caller captured before the deals rule moves from deals/ to core/, read after the move and before
 * any restamp: every core page list and each page's version snapshots (getVersions). core/was-open names alice now, but
 * its one snapshot names no reader, so only a rule its last stamp kept could label that snapshot.
 */
async function ruleMoveReads(engine: BrainEngine) {
  await seed(engine);
  await engine.putPage('core/was-open', core('Was open'), { sourceId: 'default' });
  for (const slug of VERSIONED) await engine.createVersion(slug, { sourceId: 'default' });
  await engine.putPage('core/was-open', core('Was open', { readable_by: ['alice-example'] }), { sourceId: 'default' });
  await engine.setConfig('mcp.stdio_member', 'alice-example');
  const captured = await remoteCallerAccess(engine, undefined, [], 'stdio');
  await engine.applyAccessRuleChanges('default', {
    remove: ['deals'], insert: [{ rule_id: 'deals', prefix: 'core/', readable_by: ['member:alice-example'], covers_derived: true }],
    pending: ['core/'], revision: 2, actor: 'test',
  });
  return withCallerAccess(captured, async () => {
    const versions: Record<string, number> = {};
    for (const slug of VERSIONED) versions[slug] = (await engine.getVersions(slug, { sourceId: 'default', excludePrivate: true, includeBody: false })).length;
    return { pages: await corePages(engine), versions };
  });
}

/** The pending part of ruleMoveReads: core/, the prefix the move left pending. deals/ is the stale-stamp loss (row 32e-5). */
async function pendingRuleMove(engine: BrainEngine) {
  const { pages, versions } = await ruleMoveReads(engine);
  const alice = {
    pages: pages.filter(slug => slug.startsWith('core/')),
    versions: Object.fromEntries(Object.entries(versions).filter(([slug]) => slug.startsWith('core/'))),
  };
  expect(alice).toEqual({ pages: ['core/for-alice', 'core/for-team', 'core/was-open'], versions: { 'core/open': 0, 'core/for-alice': 1, 'core/was-open': 0 } });
  return alice;
}

/** A world-only fact list (what remote recall sends) for a labelled-only member and for a member without the grant or a folder rule. */
async function worldOnlyFactList(engine: BrainEngine) {
  await seed(engine);
  await engine.putPage('memory/members/alice-example', core('Alice memory', { readable_by: ['member:alice-example'] }), { sourceId: 'default' });
  const fact = (text: string, page: string, visibility: string, row: number) =>
    ({ fact: text, entity_slug: 'people/carol-example', kind: 'fact', visibility, source: 'fence', row_num: row, source_markdown_slug: page });
  await engine.insertFacts([
    fact('Carol likes tea', 'core/open', 'world', 1),
    fact('Carol joined in May', 'core/for-alice', 'private', 2),
    fact('Carol is a mentor', 'memory/members/alice-example', 'private', 3),
  ] as never, { source_id: 'default' });
  const read = async () => (await engine.listFactsSince('default', new Date(Date.UTC(2000, 0, 1)), { activeOnly: true, limit: 50, visibility: ['world'], excludePrivate: true } as never)).map(f => f.fact).sort();
  // dan names no folder rule, so the store serves his world-only list as the no-grant caller's.
  await addMember(engine, 'dan-example');
  const alice = await as(engine, 'alice-example', read);
  const dan = await as(engine, 'dan-example', read);
  expect({ alice, dan }).toEqual({ alice: ['Carol is a mentor'], dan: ['Carol likes tea'] });
  return { alice, dan };
}

/** The valid-time pick (get_page as_of) for a labelled-only member over a page that names it and one that does not. */
async function pageInForceOnADate(engine: BrainEngine) {
  await seed(engine);
  const write = (validFrom: string) => engine.putPage('core/for-alice', core('For alice', { readable_by: ['alice-example'], valid_from: validFrom }), { sourceId: 'default' });
  await write('2026-01-01');
  await engine.createVersion('core/for-alice', { sourceId: 'default' });
  await write('2026-06-01');
  const pick = async (slug: string, asOf: string) => {
    const pageId = (await engine.getPage(slug, { sourceId: 'default' }))!.id;
    const row = await engine.pickValidTimeEdition({ pageId, asOf, excludePrivate: true, pinOrd: null, inlineMaxBytes: 1_000_000 });
    return row && { visible: row.visible, chosen: row.chosen, valid_from: row.valid_from };
  };
  const alice = await as(engine, 'alice-example', async () => ({ named: await pick('core/for-alice', '2026-03-01'), open: await pick('core/open', '2026-03-01') }));
  expect(alice.named).toMatchObject({ visible: true });
  return alice;
}

const since = new Date(Date.UTC(2000, 0, 1));
const factRow = (text: string, entity: string, page: string, row: number, visibility = 'private') =>
  ({ fact: text, entity_slug: entity, kind: 'fact', visibility, source: 'fence', row_num: row, source_markdown_slug: page });
const factsIn = async (engine: BrainEngine, sourceId: string) =>
  (await engine.listFactsSince(sourceId, since, { activeOnly: true, limit: 50, excludePrivate: true } as never)).map(f => f.fact).sort();
const aliceMemory = (engine: BrainEngine, sourceId = 'default') =>
  engine.putPage('memory/members/alice-example', core('Alice memory', { readable_by: ['member:alice-example'] }), { sourceId });

/** C10: a fact on alice's own member page still needs its entity page to pass the page policy, judged without the grant. */
async function ownFactsKeepEntityAccess(engine: BrainEngine) {
  await seed(engine);
  await aliceMemory(engine);
  await engine.putPage('people/open-example', core('Open person'), { sourceId: 'default' });
  await engine.putPage('people/bob-only-example', core('Bob only', { readable_by: ['bob-example'] }), { sourceId: 'default' });
  await engine.putPage('people/alice-named-example', core('Alice named', { readable_by: ['alice-example'] }), { sourceId: 'default' });
  await engine.insertFacts([
    factRow('about an open person', 'people/open-example', 'memory/members/alice-example', 1),
    factRow('about a page kept to bob', 'people/bob-only-example', 'memory/members/alice-example', 2),
    factRow('about a page naming alice', 'people/alice-named-example', 'memory/members/alice-example', 3),
    factRow('about a person with no page', 'people/no-page-example', 'memory/members/alice-example', 4),
  ] as never, { source_id: 'default' });
  const alice = await as(engine, 'alice-example', () => factsIn(engine, 'default'));
  expect(alice).toEqual(['about a page naming alice', 'about a person with no page', 'about an open person']);
  return alice;
}

/** C11: alice's member page must sit in the fact's own source; one in another source admits nothing. */
async function ownMemberPageInTheFactsSource(engine: BrainEngine, backend: ParityBackend) {
  await seed(engine);
  await createSource(engine, backend, 'team');
  await aliceMemory(engine);
  await engine.insertFacts([factRow('kept in team', 'people/carol-example', 'memory/members/alice-example', 1)] as never, { source_id: 'team' });
  await engine.insertFacts([factRow('kept in default', 'people/carol-example', 'memory/members/alice-example', 1)] as never, { source_id: 'default' });
  const read = async () => ({ default: await factsIn(engine, 'default'), team: await factsIn(engine, 'team') });
  const before = await as(engine, 'alice-example', read);
  await aliceMemory(engine, 'team');
  const after = await as(engine, 'alice-example', read);
  expect({ before, after }).toEqual({
    before: { default: ['kept in default'], team: [] },
    after: { default: ['kept in default'], team: ['kept in team'] },
  });
  return { before, after };
}

/**
 * C12: a held fact (on memory/unattributed) reads as its entity's page would under a folder rule: only for a caller
 * that satisfies every covering rule, and for nobody while a pending prefix covers the entity. bob satisfies deals;
 * dan satisfies no rule; a second rule over deals/acme/ names only alice.
 */
async function heldFactsUnderRealRules(engine: BrainEngine) {
  await seed(engine);
  await addMember(engine, 'dan-example');
  await engine.putPage('deals/acme/main', core('Acme'), { sourceId: 'default' });
  await engine.putPage('memory/unattributed', core('Unattributed'), { sourceId: 'default' });
  // deals/acme/spinout has no page, so only the held-fact rule test (not the entity page's own policy) can hide it.
  await engine.insertFacts([
    factRow('Acme closed', 'deals/acme/main', 'memory/unattributed', 1, 'world'),
    factRow('Acme spun out', 'deals/acme/spinout', 'memory/unattributed', 2, 'world'),
  ] as never, { source_id: 'default' });
  const read = async () => ({
    bob: await as(engine, 'bob-example', () => factsIn(engine, 'default')),
    dan: await as(engine, 'dan-example', () => factsIn(engine, 'default')),
  });
  const allSatisfied = await read();
  await proposeRevision(engine, 'default', [
    { id: 'deals', prefix: 'deals/', readable_by: ['member:alice-example', 'member:bob-example'] },
    { id: 'acme', prefix: 'deals/acme/', readable_by: ['member:alice-example'] },
  ], { origin: 'cli', store: 'database' });
  const ruleMissing = await read();
  await engine.applyAccessRuleChanges('default', { remove: ['acme'], insert: [], pending: ['deals/'], revision: 3, actor: 'test' });
  const pending = await read();
  expect({ allSatisfied, ruleMissing, pending }).toEqual({
    allSatisfied: { bob: ['Acme closed', 'Acme spun out'], dan: [] },
    ruleMissing: { bob: [], dan: [] },
    pending: { bob: [], dan: [] },
  });
  return { allSatisfied, ruleMissing, pending };
}

/** The pick's policy-facing fields: what it shows and why. Counts and version ids are raw engine values (bigint on Postgres). */
const PICK_FIELDS = ['visible', 'chosen', 'valid_from', 'valid_until', 'reason', 'introduced_because', 'successor_pruned', 'tier', 'successor_tier'] as const;
const pickFields = (row: Record<string, unknown> | null) => row && Object.fromEntries(PICK_FIELDS.map(k => [k, row[k]]));

/** C18: a page the caller reads by a live rule (deals/q4) shows its versions and its edition in force. */
async function versionsByLiveRule(engine: BrainEngine) {
  await seed(engine);
  const write = (validFrom: string) => engine.putPage('deals/q4', core('Q4', { valid_from: validFrom }), { sourceId: 'default' });
  await write('2026-01-01');
  await engine.createVersion('deals/q4', { sourceId: 'default' });
  await write('2026-06-01');
  const read = async () => {
    const pageId = (await engine.getPage('deals/q4', { sourceId: 'default' }))!.id;
    const pick = (asOf: string) => engine.pickValidTimeEdition({ pageId, asOf, excludePrivate: true, pinOrd: null, inlineMaxBytes: 1_000_000 });
    return {
      versions: (await engine.getVersions('deals/q4', { sourceId: 'default', excludePrivate: true, includeBody: false })).length,
      march: pickFields(await pick('2026-03-01')),
      july: pickFields(await pick('2026-07-01')),
    };
  };
  const alice = await as(engine, 'alice-example', read);
  expect([alice.versions, alice.march?.visible, alice.march?.valid_from, alice.july?.visible, alice.july?.valid_from]).toEqual([1, true, '2026-01-01', true, '2026-06-01']);
  return alice;
}

/** C19: a dated edition that named no reader stays hidden from the labelled-only caller once the page names it. */
async function datedUnlabelledEdition(engine: BrainEngine) {
  await seed(engine);
  await engine.putPage('core/was-open', core('Was open', { valid_from: '2026-01-01' }), { sourceId: 'default' });
  await engine.createVersion('core/was-open', { sourceId: 'default', reason: 'kept to alice from June' });
  await engine.putPage('core/was-open', core('Was open', { valid_from: '2026-06-01', readable_by: ['alice-example'] }), { sourceId: 'default' });
  const alice = await as(engine, 'alice-example', async () => {
    const pageId = (await engine.getPage('core/was-open', { sourceId: 'default' }))!.id;
    const pick = (asOf: string) => engine.pickValidTimeEdition({ pageId, asOf, excludePrivate: true, pinOrd: null, inlineMaxBytes: 1_000_000 });
    return {
      versions: (await engine.getVersions('core/was-open', { sourceId: 'default', excludePrivate: true, includeBody: false })).length,
      march: pickFields(await pick('2026-03-01')),
      july: pickFields(await pick('2026-07-01')),
    };
  });
  // The snapshot named no reader and core/ carries no rule, so it stays hidden; the current page names alice.
  expect([alice.versions, alice.march?.visible, alice.march?.valid_from, alice.july?.visible, alice.july?.valid_from]).toEqual([0, false, '2026-01-01', true, '2026-06-01']);
  // The hidden edition's own reason names the write that made the page alice reads, so it stays (its successor is the
  // live page); the current page's introduced_because comes from an edition she cannot see, so it is withheld.
  expect([alice.march?.reason, alice.july?.introduced_because]).toEqual(['kept to alice from June', null]);
  return alice;
}

/** The `replaced_because` of each version a caller reads from getVersions, oldest first, by its snapshot's title. */
const versionReasons = async (engine: BrainEngine, slug: string) =>
  (await engine.getVersions(slug, { sourceId: 'default', excludePrivate: true, includeBody: false }))
    .map(v => ({ title: (v as { title?: string }).title, replaced_because: (v as { replaced_because?: string | null }).replaced_because ?? null }))
    .reverse();

/**
 * A version's reason describes the write that replaced it, so it is withheld when the next snapshot (over every version,
 * before any filter) is hidden from the caller (`replacedBecauseSql`). Labelled-only: V1 names alice, V2 names no one,
 * the live page names alice again. alice reads V1 but not V2, so V1's reason (the write that introduced V2) is withheld.
 */
async function hiddenSuccessorReasonLabelled(engine: BrainEngine) {
  await seed(engine);
  await engine.putPage('core/history', core('V1', { readable_by: ['alice-example'], valid_from: '2026-01-01' }), { sourceId: 'default' });
  await engine.createVersion('core/history', { sourceId: 'default', reason: 'opened to everyone: secret plan B' });
  await engine.putPage('core/history', core('V2', { valid_from: '2026-04-01' }), { sourceId: 'default' });
  await engine.createVersion('core/history', { sourceId: 'default', reason: 'kept to alice again' });
  await engine.putPage('core/history', core('Live', { readable_by: ['alice-example'], valid_from: '2026-06-01' }), { sourceId: 'default' });
  const alice = await as(engine, 'alice-example', async () => {
    const pageId = (await engine.getPage('core/history', { sourceId: 'default' }))!.id;
    const pick = async (asOf: string) => pickFields(await engine.pickValidTimeEdition({ pageId, asOf, excludePrivate: true, pinOrd: null, inlineMaxBytes: 1_000_000 }));
    return { versions: await versionReasons(engine, 'core/history'), february: await pick('2026-02-01'), july: await pick('2026-07-01') };
  });
  expect(alice.versions).toEqual([{ title: 'V1', replaced_because: null }]);
  expect([alice.february?.visible, alice.february?.reason, alice.july?.visible, alice.july?.introduced_because]).toEqual([true, null, true, null]);
  return alice;
}

/** The same for an ordinary caller: V2 is private, so bob reads V1 without the reason for the write that made V2. */
async function hiddenSuccessorReasonPrivate(engine: BrainEngine) {
  await seed(engine);
  await engine.putPage('notes/history', core('V1'), { sourceId: 'default' });
  await engine.createVersion('notes/history', { sourceId: 'default', reason: 'made private: secret plan B' });
  await engine.putPage('notes/history', core('V2', { visibility: 'private' }), { sourceId: 'default' });
  await engine.createVersion('notes/history', { sourceId: 'default', reason: 'opened again' });
  await engine.putPage('notes/history', core('Live'), { sourceId: 'default' });
  await engine.createVersion('notes/history', { sourceId: 'default', reason: 'retitled' });
  await engine.putPage('notes/history', core('Live 2'), { sourceId: 'default' });
  const bob = await as(engine, 'bob-example', () => versionReasons(engine, 'notes/history'));
  // V1's successor V2 is private: its reason is withheld. The third version's successor is the live page: kept.
  expect(bob).toEqual([{ title: 'V1', replaced_because: null }, { title: 'Live', replaced_because: 'retitled' }]);
  return bob;
}

/**
 * A private-readable grant opens a private version for reading but never a successor's reason: replacedBecauseSql checks
 * the next snapshot's own fields with no grant. alice is labelled-only and holds a grant on default; V1 and the live page
 * name her and are world, V2 names her and is private. She reads V2 through the grant, yet V1's reason (the write that
 * made V2 private) is withheld, in getVersions and in the as-of pick.
 */
async function grantDoesNotOpenSuccessorReason(engine: BrainEngine) {
  await seed(engine);
  await engine.putPage('core/granted', core('V1', { readable_by: ['alice-example'], valid_from: '2026-01-01' }), { sourceId: 'default' });
  await engine.createVersion('core/granted', { sourceId: 'default', reason: 'made private: secret plan B' });
  await engine.putPage('core/granted', core('V2', { readable_by: ['alice-example'], visibility: 'private', valid_from: '2026-04-01' }), { sourceId: 'default' });
  await engine.createVersion('core/granted', { sourceId: 'default', reason: 'opened again' });
  await engine.putPage('core/granted', core('Live', { readable_by: ['alice-example'], valid_from: '2026-06-01' }), { sourceId: 'default' });
  await engine.setConfig('mcp.stdio_member', 'alice-example');
  const access = await remoteCallerAccess(engine, undefined, ['default'], 'stdio');
  expect([access.labelledOnly, access.privateReadableSources]).toEqual([true, ['default']]);
  const alice = await withCallerAccess(access, async () => {
    const pageId = (await engine.getPage('core/granted', { sourceId: 'default' }))!.id;
    const pick = async (asOf: string) => pickFields(await engine.pickValidTimeEdition({ pageId, asOf, excludePrivate: true, pinOrd: null, inlineMaxBytes: 1_000_000 }));
    return { versions: await versionReasons(engine, 'core/granted'), february: await pick('2026-02-01'), may: await pick('2026-05-01') };
  });
  expect(alice.versions).toEqual([{ title: 'V1', replaced_because: null }, { title: 'V2', replaced_because: 'opened again' }]);
  expect([alice.february?.visible, alice.february?.reason, alice.may?.visible, alice.may?.reason, alice.may?.introduced_because]).toEqual([true, null, true, 'opened again', null]);
  return alice;
}

/**
 * C20 (Grant H): a pruned successor alone withholds a reason. Every snapshot is world and names no reader; S1 (small)
 * is followed by six large snapshots, so the large-version prune deletes the oldest large one and marks S1
 * successor_pruned. bob reads S1 without its reason, while each retained large snapshot keeps its own.
 */
async function prunedSuccessorReason(engine: BrainEngine) {
  await seed(engine);
  const large = (n: number) => `${'x'.repeat(1024 * 1024 + 16)} edition ${n}`;
  await engine.putPage('notes/pruned', core('S1'), { sourceId: 'default' });
  await engine.createVersion('notes/pruned', { sourceId: 'default', reason: 'grew past the inline limit' });
  for (let n = 1; n <= 6; n++) {
    await engine.putPage('notes/pruned', { ...core(`L${n}`), compiled_truth: large(n) }, { sourceId: 'default' });
    await engine.createVersion('notes/pruned', { sourceId: 'default', reason: `large edit ${n}` });
  }
  await engine.putPage('notes/pruned', core('Live'), { sourceId: 'default' });
  const bob = await as(engine, 'bob-example', () => versionReasons(engine, 'notes/pruned'));
  expect(bob).toEqual([
    { title: 'S1', replaced_because: null },
    ...[2, 3, 4, 5, 6].map(n => ({ title: `L${n}`, replaced_because: `large edit ${n}` })),
  ]);
  return bob;
}

/**
 * C21 (Grant H): a successor only another member can read withholds the reason. V1 is world, V2 names only alice, the
 * live page is world. bob reads V1 without the reason for the write that kept V2 to alice; the pick shows V2 as not
 * visible to him and never as what introduced the live page.
 */
async function otherMemberSuccessorReason(engine: BrainEngine) {
  await seed(engine);
  await engine.putPage('notes/kept', core('V1', { valid_from: '2026-01-01' }), { sourceId: 'default' });
  await engine.createVersion('notes/kept', { sourceId: 'default', reason: 'kept to alice: secret plan B' });
  await engine.putPage('notes/kept', core('V2', { readable_by: ['alice-example'], valid_from: '2026-04-01' }), { sourceId: 'default' });
  await engine.createVersion('notes/kept', { sourceId: 'default', reason: 'opened again' });
  await engine.putPage('notes/kept', core('Live', { valid_from: '2026-06-01' }), { sourceId: 'default' });
  const bob = await as(engine, 'bob-example', async () => {
    const pageId = (await engine.getPage('notes/kept', { sourceId: 'default' }))!.id;
    const pick = async (asOf: string) => pickFields(await engine.pickValidTimeEdition({ pageId, asOf, excludePrivate: true, pinOrd: null, inlineMaxBytes: 1_000_000 }));
    return { versions: await versionReasons(engine, 'notes/kept'), february: await pick('2026-02-01'), may: await pick('2026-05-01'), july: await pick('2026-07-01') };
  });
  expect(bob.versions).toEqual([{ title: 'V1', replaced_because: null }]);
  expect([bob.february?.visible, bob.february?.reason, bob.may?.visible, bob.july?.visible, bob.july?.introduced_because]).toEqual([true, null, false, true, null]);
  return bob;
}

describe('engine parity: the labelled-only page policy', () => {
  // The read-side leak, first: a labelled-only member never reads an unlabelled page or a page kept to someone else.
  parityTest('a labelled-only member reads only the pages that name it, by readers or by a folder rule', {
    methods: ['listCorePageRows'],
  }, async (engine) => {
    await seed(engine);
    const alice = await as(engine, 'alice-example', () => corePages(engine));
    const bob = await as(engine, 'bob-example', () => corePages(engine));
    expect(alice).toEqual(['core/for-alice', 'core/for-team', 'deals/q4']);
    expect(bob).toEqual(['core/for-bob', 'core/open', 'deals/q4']);
    return { alice, bob };
  });

  // A caller record captured before a rule move keeps reading by the stamps its pages carry: the moved rule has not
  // restamped core/ yet (its pages' folder_rule_ids are still empty), so core/open and the snapshot of core/was-open
  // are still unlabelled for the caller. The exact core/ page list and per-page version counts are compared.
  parityTest('a pending rule move does not label an unstamped page for a labelled-only caller captured before it', {
    methods: ['listCorePageRows', 'applyAccessRuleChanges', 'createVersion', 'getVersions'],
  }, pendingRuleMove);

  parityTest('a labelled-only member reads the facts of its own member page only', {
    methods: ['insertFacts', 'listFactsByEntity'],
  }, async (engine) => {
    await seed(engine);
    await engine.putPage('memory/members/alice-example', core('Alice memory', { readable_by: ['member:alice-example'] }), { sourceId: 'default' });
    const fact = (text: string, page: string, row: number) =>
      ({ fact: text, entity_slug: 'people/carol-example', kind: 'fact', visibility: 'world', source: 'fence', row_num: row, source_markdown_slug: page });
    await engine.insertFacts([
      fact('Carol likes tea', 'core/open', 1),
      fact('Carol joined in May', 'core/for-alice', 2),
      fact('Carol is a mentor', 'memory/members/alice-example', 3),
    ] as never, { source_id: 'default' });
    const read = async () => (await engine.listFactsByEntity('default', 'people/carol-example', { excludePrivate: true } as never)).map(f => f.fact).sort();
    const alice = await as(engine, 'alice-example', read);
    const bob = await as(engine, 'bob-example', read);
    // alice: only her own member page's fact; bob: the open page's (core/for-alice and the member page name others).
    expect({ alice, bob }).toEqual({ alice: ['Carol is a mentor'], bob: ['Carol likes tea'] });
    return { alice, bob };
  });

  // The two reads that put a snapshot or a visibility list in front of the store's labelled-only test: the Rust adapter
  // compares each with a reference text, so a reference that omits the labelled-only record refuses a caller PGLite serves.
  parityTest('a world-only fact list admits a labelled-only member\'s own member-page facts and no other', {
    methods: ['insertFacts', 'listFactsSince'],
  }, worldOnlyFactList);

  parityTest('a labelled-only member reads the page in force on a date, over the page and its versions', {
    methods: ['createVersion', 'getPage', 'pickValidTimeEdition'],
  }, pageInForceOnADate);

  // Coverage of the store policy's other branches: entity access on own facts, the fact's own source, held facts under
  // real rules, and versions and as-of editions by live rule or by the snapshot's own readers.
  parityTest('a version\'s reason is withheld from a labelled-only member when the next snapshot is hidden from it', {
    methods: ['createVersion', 'getVersions', 'pickValidTimeEdition'],
  }, hiddenSuccessorReasonLabelled);

  parityTest('a pruned successor alone withholds a version\'s reason', {
    methods: ['createVersion', 'getVersions'],
  }, prunedSuccessorReason);

  parityTest('a successor only another member can read withholds a version\'s reason', {
    methods: ['createVersion', 'getVersions', 'pickValidTimeEdition'],
  }, otherMemberSuccessorReason);

  parityTest('a private-readable grant does not open a successor\'s reason for a labelled-only member', {
    methods: ['createVersion', 'getVersions', 'pickValidTimeEdition'],
  }, grantDoesNotOpenSuccessorReason);

  parityTest('a version\'s reason is withheld from an ordinary caller when the next snapshot is private', {
    methods: ['createVersion', 'getVersions'],
  }, hiddenSuccessorReasonPrivate);

  parityTest('a labelled-only member\'s own member-page facts still need their entity page', {
    methods: ['insertFacts', 'listFactsSince'],
  }, ownFactsKeepEntityAccess);

  parityTest('a labelled-only member\'s own member page counts only in the fact\'s own source', {
    methods: ['insertFacts', 'listFactsSince'],
  }, ownMemberPageInTheFactsSource);

  parityTest('a held fact reads only for a caller that satisfies every covering rule, and for nobody while pending', {
    methods: ['insertFacts', 'listFactsSince', 'applyAccessRuleChanges'],
  }, heldFactsUnderRealRules);

  parityTest('a labelled-only member reads the versions and editions of a page a live rule labels', {
    methods: ['createVersion', 'getVersions', 'pickValidTimeEdition'],
  }, versionsByLiveRule);

  parityTest('a dated edition that named no reader stays hidden from a labelled-only member', {
    methods: ['createVersion', 'getVersions', 'pickValidTimeEdition'],
  }, datedUnlabelledEdition);
});

describe('the Rust arm serves the labelled-only page policy', () => {
  // A parity case counts a typed refusal as a pass, so this reads the Rust arm's own engine: it is red while the store
  // page policy refuses a labelled-only caller.
  test('a labelled-only member reads only its labelled pages on Rust', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    await seed(rust.engine);
    expect(await as(rust.engine, 'alice-example', () => corePages(rust.engine))).toEqual(['core/for-alice', 'core/for-team', 'deals/q4']);
  });

  // The same three scenarios as parity cases, run on the Rust arm alone so a typed refusal cannot pass for a read.
  for (const [name, scenario] of [
    ['a rule move that has not restamped a page does not label it for a caller captured before', pendingRuleMove],
    ['a world-only fact list reads the labelled-only member\'s own member-page facts', worldOnlyFactList],
    ['the valid-time pick reads a labelled-only member\'s page', pageInForceOnADate],
    ['a version reason is withheld when the next snapshot is hidden (labelled-only)', hiddenSuccessorReasonLabelled],
    ['a version reason is withheld when the next snapshot is private', hiddenSuccessorReasonPrivate],
    ['a private-readable grant does not open a successor reason', grantDoesNotOpenSuccessorReason],
    ['a pruned successor alone withholds a reason', prunedSuccessorReason],
    ['a successor only another member can read withholds a reason', otherMemberSuccessorReason],
    ['own member-page facts still need their entity page', ownFactsKeepEntityAccess],
    ['the own member page counts only in the fact\'s own source', ownMemberPageInTheFactsSource],
    ['a held fact reads only under every satisfied rule', heldFactsUnderRealRules],
    ['versions and editions of a page a live rule labels', versionsByLiveRule],
    ['a dated edition that named no reader stays hidden', datedUnlabelledEdition],
  ] as const) {
    test(`${name} on Rust`, async () => {
      const rust = arms().find((arm) => arm.backend === 'rust');
      if (!rust) return;
      await resetArm(rust);
      await scenario(rust.engine, 'rust');
    });
  }
});

describe('the Rust arm refuses or hides what it does not serve yet (rows 32e-2 to 32e-5), and shows nothing more', () => {
  const refusal = async (run: () => Promise<unknown>) => {
    try {
      return { served: await run() };
    } catch (error) {
      return { code: (error as { code?: string }).code };
    }
  };
  const armOf = async (backend: string) => {
    const arm = arms().find((a) => a.backend === backend);
    if (arm) await resetArm(arm);
    return arm?.engine;
  };
  const STOP = { code: 'engine_capability_missing' };

  test('loss (32e-2): a labelled-only caller\'s remote read floor refuses on Rust', async () => {
    const rust = await armOf('rust');
    if (!rust) return;
    const results: Record<string, unknown> = {};
    const pages = ['core/open', 'core/for-alice', 'deals/q4', 'memory/members/alice-example'];
    for (const backend of ['pglite', 'rust']) {
      const engine = (await armOf(backend))!;
      await seed(engine);
      await engine.putPage('memory/members/alice-example', core('Alice memory', { readable_by: ['member:alice-example'] }), { sourceId: 'default' });
      const { ids } = await engine.insertFacts(pages.map((page, i) => ({ fact: `Carol fact ${i}`, entity_slug: 'people/carol-example', kind: 'fact', visibility: 'world', source: 'fence', row_num: i + 1, source_markdown_slug: page })) as never, { source_id: 'default' });
      const floor = (who = 'alice-example') => as(engine, who, async () => Promise.all(pages.map(async (_, i) => [
        (await engine.findActiveSingleFact({ sourceId: 'default', entitySlug: 'people/carol-example', visibility: 'world', fact: `Carol fact ${i}`, attributedTo: null, pageSlug: null, remoteFloor: true }))?.id ?? null,
        await engine.readRemoteForgetTier({ factId: ids[i]!, sourceId: 'default', remoteFloor: true }),
      ])));
      results[backend] = { alice: await refusal(() => floor()), bob: await refusal(() => floor('bob-example')) };
    }
    // bob, who is not labelled-only, reads the open page's fact under the floor on both. On PGLite the labelled-only
    // floor hides every one of alice's (the plain page fragment hides named pages, her conjunct every unnamed one);
    // Rust refuses before the read instead.
    const bob = { served: [[expect.any(Number), 'unknown'], [null, null], [null, null], [null, null]] };
    expect(results.pglite).toEqual({ alice: { served: pages.map(() => [null, null]) }, bob });
    expect(results.rust).toEqual({ alice: STOP, bob });
  });

  test('loss (32e-3): a labelled-only caller with lineage or an audience refuses on Rust', async () => {
    const rust = await armOf('rust');
    if (!rust) return;
    const results: Record<string, Record<string, unknown>> = {};
    for (const backend of ['pglite', 'rust']) {
      const engine = (await armOf(backend))!;
      await seed(engine);
      await engine.setConfig('mcp.stdio_member', 'alice-example');
      const audience = await audienceCallerAccess(engine, undefined, [], 'stdio', ['member:alice-example', 'member:bob-example'], [['member:alice-example', 'group:team-a'], ['member:bob-example']]);
      await engine.setConfig('access.members_read_lineage', '1');
      const lineage = await remoteCallerAccess(engine, undefined, [], 'stdio', null, undefined, true);
      expect([backend, lineage.labelledOnly, lineage.lineage, audience.labelledOnly]).toEqual([backend, true, true, true]);
      results[backend] = {
        lineage: await refusal(() => withCallerAccess(lineage, () => corePages(engine))),
        audience: await refusal(() => withCallerAccess(audience, () => corePages(engine))),
      };
    }
    // PGLite: with lineage alice reads her labelled pages; the audience of alice and bob reads only the page both are
    // named on (the folder rule). Rust refuses both before the read.
    expect(results.pglite).toEqual({ lineage: { served: ['core/for-alice', 'core/for-team', 'deals/q4'] }, audience: { served: ['deals/q4'] } });
    expect(results.rust).toEqual({ lineage: STOP, audience: STOP });
  });

  test('loss (32e-4): a folder-rule caller\'s world-only fact list refuses on Rust', async () => {
    const rust = await armOf('rust');
    if (!rust) return;
    const results: Record<string, unknown> = {};
    for (const backend of ['pglite', 'rust']) {
      const engine = (await armOf(backend))!;
      await seed(engine);
      await engine.putPage('memory/members/bob-example', core('Bob memory', { readable_by: ['member:bob-example'] }), { sourceId: 'default' });
      const fact = (text: string, page: string, visibility: string, row: number) =>
        ({ fact: text, entity_slug: 'people/carol-example', kind: 'fact', visibility, source: 'fence', row_num: row, source_markdown_slug: page });
      await engine.insertFacts([fact('tea', 'core/open', 'world', 1), fact('q4', 'deals/q4', 'world', 2), fact('mine', 'memory/members/bob-example', 'private', 3)] as never, { source_id: 'default' });
      // bob is not labelled-only; the deals rule names him, so his record carries a satisfied folder rule.
      const read = async () => (await engine.listFactsSince('default', new Date(Date.UTC(2000, 0, 1)), { activeOnly: true, limit: 50, visibility: ['world'], excludePrivate: true } as never)).map(f => f.fact).sort();
      await engine.setConfig('mcp.stdio_member', 'bob-example');
      const bob = await remoteCallerAccess(engine, undefined, [], 'stdio');
      expect([backend, bob.satisfiedRuleIds, bob.labelledOnly]).toEqual([backend, ['default:deals'], false]);
      results[backend] = await refusal(() => withCallerAccess(bob, read));
    }
    expect(results.pglite).toEqual({ served: ['mine', 'tea'] });
    expect(results.rust).toEqual(STOP);
  });

  // Fails closed: Rust hides what PGLite still shows from the stale stamp, never the other way round.
  test('loss (32e-5): a page a moved rule left stamped stays labelled on PGLite and is hidden on Rust', async () => {
    const rust = await armOf('rust');
    if (!rust) return;
    const results: Record<string, unknown> = {};
    for (const backend of ['pglite', 'rust']) results[backend] = await ruleMoveReads((await armOf(backend))!);
    const core = { 'core/open': 0, 'core/for-alice': 1, 'core/was-open': 0 };
    const pages = ['core/for-alice', 'core/for-team', 'core/was-open'];
    expect(results.pglite).toEqual({ pages: [...pages, 'deals/q4'], versions: { ...core, 'deals/q4': 1 } });
    expect(results.rust).toEqual({ pages, versions: { ...core, 'deals/q4': 0 } });
  });
});

