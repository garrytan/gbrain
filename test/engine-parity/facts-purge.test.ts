/**
 * BrainEngine parity — the facts statements of purge, withdrawal, relink and fence repair that ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: countFactFingerprintLeftovers, loadPurgeTarget, planFactPurgeIds, listFactsReconcileBacklog,
 *    settleFactsReconcile, lockReconcileRevision, selectFactsReconcileDrain, listRelinkCandidateRows, countRelinkCandidates, listSimilarActiveFacts, findActiveSingleFact,
 *    listSingleFactMetadata, listUnfencedFactRows, countUnfencedFactGroups, listHeldFenceFactRows, listWithdrawalSlugs,
 *    expireFactsByWithdrawal and listDerivedRows (one hop of the derivation walk) return the same observable result
 *    on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes which rows `forget --purge` removes and counts
 *    as left, which pages a withdrawal rewrites, which facts relink and fence repair touch, and which fact a save treats
 *    as already stored; the Rust engine has no SQL, so each read has to exist as a typed method it can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: the watermark is written through the typed settleFactsReconcile and selectFactsReconcileDrain, and read back
 *    through listFactsReconcileBacklog. A reconciled revision older than the page comes from an edit after the settle.
 *    No product path writes an attempt older than the reconciled revision (a complete settles both at the page's
 *    revision, and every later attempt is at the revision the page then has), so no case seeds one. The extract_facts
 *    commit step (lockReconcileRevision, then the settle, in one transaction) runs through typed members. Every other row is seeded through the typed `insertFact`, `insertFacts`, `putPage`, `softDeletePage`, `expireFact` and
 *    `createSegmentedPageShell`. Generated values (fact ids, timestamps, fingerprints) are compared by relation or
 *    shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, sorted } from './harness.ts';
import { pageMeta } from '../helpers/page-body-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { CALLER_ENTITIES, callerFactRows, putCallerPages, readAsCallers } from './fact-callers.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { lockReconcileRevision } from '../../src/core/facts/reconcile-watermark.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const TERMINAL = 'cli:extract-conversation-facts:terminal:v2';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

type Fact = Partial<Parameters<BrainEngine['insertFact']>[0]> & { fact: string };

/** Insert facts one by one and name each id by `label` (ids are not comparable across arms). */
class Seed {
  readonly names = new Map<number, string>();
  constructor(readonly engine: BrainEngine) {}

  async one(label: string, input: Fact, sourceId = SRC): Promise<number> {
    const r = await this.engine.insertFact({ entity_slug: null, source: 'chat', ...input }, { source_id: sourceId });
    expect(r.status).toBe('inserted');
    this.names.set(r.id, label);
    return r.id;
  }

  /** Fence rows: `label` names each row, in order. */
  async fence(rows: Array<Fact & { label: string; row_num: number; source_markdown_slug: string }>): Promise<number[]> {
    const out = await this.engine.insertFacts(
      rows.map(({ label: _label, ...row }) => ({ entity_slug: null, source: 'fence', ...row })) as never,
      { source_id: SRC });
    out.ids.forEach((id, i) => this.names.set(id, rows[i]!.label));
    return out.ids;
  }

  name = (id: number | string) => this.names.get(Number(id)) ?? '<unknown-id>';
  label = (rows: Array<{ id: number | string }>) => rows.map((r) => this.name(r.id));
}

/** A 1536-wide vector with `head` in the first slots. */
function vec(...head: number[]): Float32Array {
  const v = new Float32Array(1536);
  head.forEach((x, i) => { v[i] = x; });
  return v;
}

const hashOf = async (engine: BrainEngine, id: number) => (await engine.loadPurgeTarget(id, SRC))!.fact_hash;
const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: body, frontmatter });

describe('engine parity: purge, withdrawal, relink and fence repair statements', () => {
  parityTest('loadPurgeTarget reads a fact with its fingerprint and vector text, and no checkpoint row, other source or unknown id', { methods: ['loadPurgeTarget'] }, async (engine) => {
    const seed = new Seed(engine);
    const target = await seed.one('target', { fact: 'Alice  likes TEA', entity_slug: 'people/alice', embedding: vec(1, 0.5, 0.1), embedding_model: 'm1' });
    const same = await seed.one('same', { fact: 'alice likes tea.', entity_slug: 'people/bob' });
    const plain = await seed.one('plain', { fact: 'plain' });
    const marker = await seed.one('marker', { fact: 'EXTRACTION_COMPLETE', source: TERMINAL, entity_slug: 'people/alice' });
    const row = await engine.loadPurgeTarget(target, SRC);
    expect(row).not.toBeNull();
    expect(Number(row!.id)).toBe(target);
    expect(row).toMatchObject({ source_id: SRC, visibility: 'private', fact: 'Alice  likes TEA', entity_slug: 'people/alice', source_markdown_slug: null, embedding_model: 'm1' });
    expect(row!.embedding!.startsWith('[1,0.5,0.0999')).toBe(true);
    expect(row!.embedding!.endsWith(',0]')).toBe(true);
    expect(row!.fact_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.fact_hash).toBe(await hashOf(engine, same));
    const none = await engine.loadPurgeTarget(plain, SRC);
    expect(none).toMatchObject({ embedding: null, embedding_model: null });
    expect(await engine.loadPurgeTarget(marker, SRC)).toBeNull();
    expect(await engine.loadPurgeTarget(target, 'elsewhere')).toBeNull();
    expect(await engine.loadPurgeTarget(target + 100_000, SRC)).toBeNull();
    return {
      row: { ...row!, id: seed.name(row!.id), fact_hash: row!.fact_hash.length, embedding: row!.embedding!.split(',').length },
      none: { ...none!, id: seed.name(none!.id), fact_hash: none!.fact_hash.length },
    };
  });

  parityTest('planFactPurgeIds lists the claim\'s rows of one visibility in id order, by subject, and never a checkpoint row', { methods: ['planFactPurgeIds', 'loadPurgeTarget'] }, async (engine) => {
    const seed = new Seed(engine);
    await engine.putPage('people/alice', note('Alice', 'a'));
    const a = await seed.one('alice', { fact: 'Shared claim', entity_slug: 'people/alice' });
    await seed.one('bob', { fact: 'shared  claim.', entity_slug: 'people/bob' });
    await seed.one('loose', { fact: 'SHARED CLAIM' });
    await seed.one('name-key', { fact: 'Shared claim', entity_slug: 'alice' });
    await seed.one('backed-key', { fact: 'Shared claim', entity_slug: 'people' });
    await engine.putPage('people', note('People', 'p'));
    await seed.one('world', { fact: 'Shared claim', entity_slug: 'people/alice', visibility: 'world' });
    await seed.one('other', { fact: 'Other claim', entity_slug: 'people/alice' });
    const hash = await hashOf(engine, a);
    const plan = async (visibility: string, subject: string, h = hash) => seed.label(await engine.planFactPurgeIds(SRC, visibility, h, subject));
    const byAlice = await plan('private', 'people/alice');
    const byBob = await plan('private', 'people/bob');
    const everyone = await plan('private', '*');
    const missing = await plan('private', 'people/missing');
    const world = await plan('world', '*');
    const noHash = await plan('private', '*', 'no-such-hash');
    expect(byAlice).toEqual(['alice', 'name-key']);
    expect(byBob).toEqual(['bob', 'name-key']);
    expect(everyone).toEqual(['alice', 'bob', 'loose', 'name-key', 'backed-key']);
    expect(missing).toEqual(['name-key']);
    expect(world).toEqual(['world']);
    expect(noHash).toEqual([]);
    // A checkpoint row of the same text is no part of a plan; a chat row of it is.
    const text = await seed.one('chat-text', { fact: 'EXTRACTION_COMPLETE', entity_slug: 'people/alice' });
    await seed.one('marker-alice', { fact: 'EXTRACTION_COMPLETE', source: TERMINAL, entity_slug: 'people/alice' });
    await seed.one('marker-bob', { fact: 'EXTRACTION_COMPLETE', source: TERMINAL, entity_slug: 'people/bob' });
    const marker = await plan('private', '*', await hashOf(engine, text));
    expect(marker).toEqual(['chat-text']);
    return { byAlice, byBob, everyone, missing, world, noHash, marker };
  });

  parityTest('countFactFingerprintLeftovers counts the claim\'s rows the purge scope leaves, a checkpoint row apart', { methods: ['countFactFingerprintLeftovers', 'loadPurgeTarget'] }, async (engine) => {
    const seed = new Seed(engine);
    const a = await seed.one('alice', { fact: 'Shared claim', entity_slug: 'people/alice' });
    await seed.one('bob', { fact: 'shared  claim.', entity_slug: 'people/bob' });
    await seed.one('loose', { fact: 'SHARED CLAIM' });
    await seed.one('world', { fact: 'Shared claim', entity_slug: 'people/alice', visibility: 'world' });
    await seed.one('other', { fact: 'Other claim', entity_slug: 'people/alice' });
    const hash = await hashOf(engine, a);
    const left = (visibility: string, subject: string, h = hash) => engine.countFactFingerprintLeftovers(SRC, h, visibility, subject);
    const counts = {
      privateAll: await left('private', '*'),
      worldAll: await left('world', '*'),
      privateAlice: await left('private', 'people/alice'),
      worldAlice: await left('world', 'people/alice'),
      privateZed: await left('private', 'people/zed'),
      noHash: await left('private', '*', 'no-such-hash'),
    };
    expect(counts).toEqual({ privateAll: 1, worldAll: 3, privateAlice: 2, worldAlice: 3, privateZed: 3, noHash: 0 });
    // A row with no entity is left only by a purge of another visibility (its entity is unknown, so no subject covers it).
    // A checkpoint row of the same text is never counted.
    const text = await seed.one('chat-text', { fact: 'EXTRACTION_COMPLETE', entity_slug: 'people/alice', visibility: 'world' });
    await seed.one('marker', { fact: 'EXTRACTION_COMPLETE', source: TERMINAL, entity_slug: 'people/alice' });
    const markerHash = await hashOf(engine, text);
    const marker = { elsewhere: await left('private', '*', markerHash), same: await left('world', '*', markerHash) };
    expect(marker).toEqual({ elsewhere: 1, same: 0 });
    return { counts, marker };
  });

  parityTest('listFactsReconcileBacklog lists the due pages that hold a fence or fence rows, with whether the last attempt marked them invalid', { methods: ['listFactsReconcileBacklog'] }, async (engine) => {
    await engine.putPage('notes/fenced', note('Fenced', `body\n\n${FACTS_FENCE_BEGIN}\n| # | fact |\n${FACTS_FENCE_END}\n`));
    await engine.putPage('notes/plain', note('Plain', 'no fence here'));
    await engine.putPage('notes/rows', note('Rows', 'rows only'));
    await engine.insertFacts([{ fact: 'a row', source: 'fence', entity_slug: 'notes/rows', source_markdown_slug: 'notes/rows', row_num: 1 }] as never, { source_id: SRC });
    await engine.putPage('notes/gone', note('Gone', `${FACTS_FENCE_BEGIN}\n${FACTS_FENCE_END}`));
    await engine.softDeletePage('notes/gone');
    const backlog = await engine.listFactsReconcileBacklog();
    expect(backlog.rows.map((r) => r.slug)).toEqual(['notes/fenced', 'notes/rows']);
    expect(backlog.rows.every((r) => r.source_id === SRC && r.invalid === false)).toBe(true);
    expect(backlog.segmented).toBe(0);
    return backlog;
  });

  parityTest('listFactsReconcileBacklog finds a fence in the body or timeline or owned rows, per source in C order, and counts due segmented pages', {
    methods: ['putPage', 'insertFacts', 'softDeletePage', 'createSegmentedPageShell', 'listFactsReconcileBacklog'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const fence = `${FACTS_FENCE_BEGIN}\n| # | fact |\n${FACTS_FENCE_END}`;
    await engine.putPage('notes/alpha', note('Alpha', `intro ${fence}`));
    await engine.putPage('notes/b-c', note('B c', fence));
    await engine.putPage('notes/bb', note('Bb', fence));
    await engine.putPage('notes/_under', note('Under', fence));
    await engine.putPage('notes/timeline', { ...note('Timeline', 'body'), timeline: `- entry\n${fence}` });
    await engine.putPage('notes/half', note('Half', `<!--- gbrain:facts:begi -->`));
    await engine.putPage('notes/upper', note('Upper', FACTS_FENCE_BEGIN.toUpperCase()));
    await engine.putPage('notes/other', note('Other', fence), { sourceId: 'other' });
    await engine.putPage('notes/rows-elsewhere', note('Rows elsewhere', 'no fence'));
    await engine.insertFacts([{ fact: 'a row', source: 'fence', entity_slug: 'notes/rows-elsewhere', source_markdown_slug: 'notes/rows-elsewhere', row_num: 1 }] as never, { source_id: 'other' });
    await engine.putPage('notes/expired-row', note('Expired row', 'no fence'));
    const [expired] = (await engine.insertFacts([{ fact: 'old row', source: 'fence', entity_slug: 'notes/expired-row', source_markdown_slug: 'notes/expired-row', row_num: 1 }] as never, { source_id: SRC })).ids;
    await engine.expireFact(expired!);
    await engine.putPage('notes/unnumbered', note('Unnumbered', 'no fence'));
    await engine.insertFacts([{ fact: 'filed, no row', source: 'fence', entity_slug: 'notes/unnumbered', source_markdown_slug: 'notes/unnumbered' }] as never, { source_id: SRC });
    await engine.createSegmentedPageShell('notes/seg', pageMeta('Seg'), { sourceId: SRC });
    await engine.createSegmentedPageShell('notes/seg-other', pageMeta('Seg other'), { sourceId: 'other' });
    await engine.createSegmentedPageShell('notes/seg-rows', pageMeta('Seg rows'), { sourceId: SRC });
    await engine.insertFacts([{ fact: 'seg row', source: 'fence', entity_slug: 'notes/seg-rows', source_markdown_slug: 'notes/seg-rows', row_num: 1 }] as never, { source_id: SRC });
    await engine.createSegmentedPageShell('notes/seg-gone', pageMeta('Seg gone'), { sourceId: SRC });
    await engine.softDeletePage('notes/seg-gone');
    const backlog = await engine.listFactsReconcileBacklog();
    expect(backlog.rows.map((r) => `${r.source_id}:${r.slug}`)).toEqual([
      'default:notes/_under', 'default:notes/alpha', 'default:notes/b-c', 'default:notes/bb', 'default:notes/expired-row', 'default:notes/seg-rows',
      'default:notes/timeline', 'other:notes/other',
    ]);
    expect(backlog.rows.every((r) => r.invalid === false)).toBe(true);
    expect(backlog.segmented).toBe(2);
    return backlog;
  });

  parityTest('listFactsReconcileBacklog leaves out a page reconciled at its revision and marks an invalid attempt at it', {
    methods: ['putPage', 'createSegmentedPageShell', 'settleFactsReconcile', 'listFactsReconcileBacklog'],
  }, async (engine) => {
    const fence = `${FACTS_FENCE_BEGIN}\n| # | fact |\n${FACTS_FENCE_END}`;
    for (const slug of ['done', 'stale', 'invalid-now', 'invalid-before', 'deferred', 'cancelled']) await engine.putPage(`notes/${slug}`, note(slug, fence));
    await engine.createSegmentedPageShell('notes/seg-done', pageMeta('Seg done'), { sourceId: SRC });
    await engine.createSegmentedPageShell('notes/seg-stale', pageMeta('Seg stale'), { sourceId: SRC });
    const settle = (slug: string, outcome: 'complete' | 'deferred' | 'invalid' | 'cancelled') => engine.settleFactsReconcile(SRC, `notes/${slug}`, outcome);
    // An edit moves the page past the revision its watermark holds.
    const edit = (slug: string) => engine.putPage(`notes/${slug}`, note(slug, `${fence}\nedited`));
    await settle('done', 'complete');
    await settle('stale', 'complete');
    await edit('stale');
    await settle('invalid-now', 'invalid');
    await settle('invalid-before', 'invalid');
    await edit('invalid-before');
    await settle('deferred', 'deferred');
    // A later attempt that does not complete keeps the reconciled revision.
    await settle('cancelled', 'complete');
    await settle('cancelled', 'cancelled');
    await settle('seg-done', 'complete');
    await settle('seg-stale', 'deferred');
    const backlog = await engine.listFactsReconcileBacklog();
    expect(backlog.rows.map((r) => [r.slug, r.invalid])).toEqual([
      ['notes/deferred', false], ['notes/invalid-before', false], ['notes/invalid-now', true], ['notes/stale', false],
    ]);
    expect(backlog.segmented).toBe(1);
    return backlog;
  });

  parityTest('settleFactsReconcile records an outcome only at the revision the reconcile read, keeps the reconciled one, and skips a gone page', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'settleFactsReconcile', 'listFactsReconcileBacklog'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const fence = `${FACTS_FENCE_BEGIN}\n| # | fact |\n${FACTS_FENCE_END}`;
    const slugs = ['done', 'stale', 'invalid-now', 'kept', 'any', 'gone', 'edited', 'cancelled'];
    for (const slug of slugs) await engine.putPage(`notes/${slug}`, note(slug, fence));
    await engine.putPage('notes/done', note('done', fence), { sourceId: 'other' });
    const rev = async (slug: string) => (await engine.getPage(`notes/${slug}`))!.knowledge_revision!;
    const settle = (slug: string, outcome: 'complete' | 'deferred' | 'invalid' | 'cancelled', revision?: string | null) =>
      engine.settleFactsReconcile(SRC, `notes/${slug}`, outcome, revision);
    await settle('done', 'complete', await rev('done'));
    await settle('stale', 'complete', '00000000-0000-4000-8000-000000000000');
    await settle('stale', 'complete', null);
    await settle('invalid-now', 'invalid', await rev('invalid-now'));
    await settle('kept', 'complete', await rev('kept'));
    await settle('kept', 'deferred');
    await settle('any', 'complete');
    await engine.softDeletePage('notes/gone');
    await settle('gone', 'complete');
    await settle('edited', 'complete', await rev('edited'));
    await engine.putPage('notes/edited', note('edited', `${fence}\nmore`));
    await settle('cancelled', 'cancelled');
    await settle('missing', 'complete');
    const backlog = await engine.listFactsReconcileBacklog();
    expect(backlog.rows.map((r) => [`${r.source_id}:${r.slug}`, r.invalid])).toEqual([
      ['default:notes/cancelled', false], ['default:notes/edited', false], ['default:notes/invalid-now', true],
      ['default:notes/stale', false], ['other:notes/done', false],
    ]);
    return backlog;
  });

  parityTest('selectFactsReconcileDrain settles the fenceless pages and lists the rest never-attempted first, then by oldest attempt, at most the limit', {
    methods: ['putPage', 'insertFacts', 'softDeletePage', 'createSegmentedPageShell', 'settleFactsReconcile', 'selectFactsReconcileDrain', 'listFactsReconcileBacklog'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const fence = `${FACTS_FENCE_BEGIN}\n| # | fact |\n${FACTS_FENCE_END}`;
    // Created in id order; tried-early has a later id than tried-late but is attempted first, so attempt order differs from id order.
    for (const slug of ['new-a', 'tried-late', 'tried-early', 'new-b', 'invalid-now', 'invalid-before', 'gone']) {
      await engine.putPage(`notes/${slug}`, note(slug, fence));
    }
    await engine.putPage('notes/plain', note('Plain', 'no fence'));
    await engine.putPage('notes/rows', note('Rows', 'rows only'));
    await engine.insertFacts([{ fact: 'a row', source: 'fence', entity_slug: 'notes/rows', source_markdown_slug: 'notes/rows', row_num: 1 }] as never, { source_id: SRC });
    await engine.createSegmentedPageShell('notes/seg', pageMeta('Seg'), { sourceId: SRC });
    await engine.putPage('notes/elsewhere', note('Elsewhere', fence), { sourceId: 'other' });
    await engine.putPage('notes/plain-elsewhere', note('Plain elsewhere', 'no fence'), { sourceId: 'other' });
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await engine.settleFactsReconcile(SRC, 'notes/invalid-before', 'invalid');
    await engine.putPage('notes/invalid-before', note('invalid-before', `${fence}\nedited`));
    await tick();
    await engine.settleFactsReconcile(SRC, 'notes/tried-early', 'deferred');
    await tick();
    await engine.settleFactsReconcile(SRC, 'notes/tried-late', 'deferred');
    await engine.settleFactsReconcile(SRC, 'notes/invalid-now', 'invalid');
    await engine.softDeletePage('notes/gone');
    const limited = await engine.selectFactsReconcileDrain(SRC, 2);
    const drain = await engine.selectFactsReconcileDrain(SRC, 50);
    // A settled page stays out of the backlog after it gains a fence row; an unsettled one comes back.
    await engine.insertFacts([{ fact: 'late row', source: 'fence', entity_slug: 'notes/plain', source_markdown_slug: 'notes/plain', row_num: 1 }] as never, { source_id: SRC });
    await engine.insertFacts([{ fact: 'late row', source: 'fence', entity_slug: 'notes/plain-elsewhere', source_markdown_slug: 'notes/plain-elsewhere', row_num: 1 }] as never, { source_id: 'other' });
    const backlog = await engine.listFactsReconcileBacklog();
    expect(limited).toEqual(['notes/new-a', 'notes/new-b']);
    expect(drain).toEqual(['notes/new-a', 'notes/new-b', 'notes/rows', 'notes/seg', 'notes/invalid-before', 'notes/tried-early', 'notes/tried-late']);
    expect(backlog.rows.map((r) => `${r.source_id}:${r.slug}`)).not.toContain('default:notes/plain');
    expect(backlog.rows.map((r) => `${r.source_id}:${r.slug}`)).toContain('other:notes/plain-elsewhere');
    return { limited, drain, backlog };
  });

  parityTest('settleFactsReconcile inside a transaction settles the page when the transaction commits', {
    methods: ['putPage', 'getPage', 'transaction', 'settleFactsReconcile', 'listFactsReconcileBacklog'],
  }, async (engine) => {
    const fence = `${FACTS_FENCE_BEGIN}\n| # | fact |\n${FACTS_FENCE_END}`;
    await engine.putPage('notes/fenced', note('Fenced', fence));
    await engine.putPage('notes/other', note('Other', fence));
    const rev = (await engine.getPage('notes/fenced'))!.knowledge_revision!;
    await engine.transaction((tx) => tx.settleFactsReconcile(SRC, 'notes/fenced', 'complete', rev));
    const backlog = await engine.listFactsReconcileBacklog();
    expect(backlog.rows.map((r) => r.slug)).toEqual(['notes/other']);
    return backlog;
  });

  parityTest('lockReconcileRevision answers whether the live page is still at the revision the reconcile read, inside a transaction too', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'transaction', 'lockReconcileRevision'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/live', note('live', 'x'));
    await engine.putPage('notes/gone', note('gone', 'x'));
    await engine.putPage('notes/elsewhere', note('elsewhere', 'x'), { sourceId: 'other' });
    const live = (await engine.getPage('notes/live'))!.knowledge_revision!;
    const gone = (await engine.getPage('notes/gone'))!.knowledge_revision!;
    const elsewhere = (await engine.getPage('notes/elsewhere', { sourceId: 'other' }))!.knowledge_revision!;
    await engine.softDeletePage('notes/gone');
    const lock = (db: BrainEngine, sourceId: string, slug: string, revision: string | null) => db.lockReconcileRevision(sourceId, `notes/${slug}`, revision);
    const outside = {
      current: await lock(engine, SRC, 'live', live),
      otherRevision: await lock(engine, SRC, 'live', '00000000-0000-4000-8000-000000000000'),
      noRevision: await lock(engine, SRC, 'live', null),
      softDeleted: await lock(engine, SRC, 'gone', gone),
      wrongSource: await lock(engine, SRC, 'elsewhere', elsewhere),
      ownSource: await lock(engine, 'other', 'elsewhere', elsewhere),
      missing: await lock(engine, SRC, 'missing', null),
    };
    const inside = await engine.transaction(async (tx) => {
      const before = await lock(tx, SRC, 'live', live);
      await tx.putPage('notes/live', note('live', 'edited'));
      const edited = (await tx.getPage('notes/live'))!.knowledge_revision!;
      return { before, stale: await lock(tx, SRC, 'live', live), fresh: await lock(tx, SRC, 'live', edited) };
    });
    expect(outside).toEqual({ current: true, otherRevision: false, noRevision: false, softDeleted: false, wrongSource: false, ownSource: true, missing: false });
    expect(inside).toEqual({ before: true, stale: false, fresh: true });
    return { outside, inside };
  });

  parityTest('the extract_facts commit step locks the page revision, then settles complete, in one transaction', {
    methods: ['putPage', 'getPage', 'transaction', 'lockReconcileRevision', 'settleFactsReconcile', 'listFactsReconcileBacklog'],
  }, async (engine) => {
    const fence = `${FACTS_FENCE_BEGIN}\n| # | fact |\n${FACTS_FENCE_END}`;
    await engine.putPage('notes/fenced', note('Fenced', fence));
    await engine.putPage('notes/other', note('Other', fence));
    const rev = (await engine.getPage('notes/fenced'))!.knowledge_revision!;
    const locked = await engine.transaction(async (tx) => {
      if (!await lockReconcileRevision(tx, SRC, 'notes/fenced', rev)) return false;
      await tx.settleFactsReconcile(SRC, 'notes/fenced', 'complete', rev);
      return true;
    });
    const backlog = await engine.listFactsReconcileBacklog();
    expect(locked).toBe(true);
    expect(backlog.rows.map((r) => r.slug)).toEqual(['notes/other']);
    return { locked, backlog };
  });

  parityTest('listRelinkCandidateRows lists the loose active facts after an id, from a time, at most the limit', { methods: ['listRelinkCandidateRows'] }, async (engine, backend) => {
    const seed = new Seed(engine);
    const old = await seed.one('old', { fact: 'old loose' });
    await seed.one('one', { fact: 'loose one', visibility: 'world' });
    await seed.one('two', { fact: 'loose two', source: 's', context: 'ctx', attributed_to: 'user' } as Fact);
    await seed.one('entity', { fact: 'has entity', entity_slug: 'people/alice' });
    const expired = await seed.one('expired', { fact: 'expired loose' });
    await engine.expireFact(expired);
    await seed.one('lapsed', { fact: 'lapsed', valid_until: new Date('2020-01-01T00:00:00Z') });
    await seed.fence([
      { label: 'fenced', fact: 'fenced', row_num: 1, source_markdown_slug: 'notes/a' },
      { label: 'paged', fact: 'paged', row_num: 2, source_markdown_slug: 'notes/b' },
    ]);
    await createSource(engine, backend, 'other');
    await seed.one('other-source', { fact: 'other source' }, 'other');
    const list = async (afterId: number, since: Date | null, limit: number) =>
      engine.listRelinkCandidateRows({ sourceId: SRC, afterId, since, limit });
    const all = await list(0, null, 100);
    const afterOld = await list(old, null, 100);
    const limited = await list(0, null, 2);
    const future = await list(0, new Date(Date.now() + 3_600_000), 100);
    const fromEpoch = await list(0, new Date(0), 100);
    expect(seed.label(all)).toEqual(['old', 'one', 'two']);
    expect(seed.label(afterOld)).toEqual(['one', 'two']);
    expect(seed.label(limited)).toEqual(['old', 'one']);
    expect(future).toEqual([]);
    expect(seed.label(fromEpoch)).toEqual(['old', 'one', 'two']);
    expect(all[2]).toMatchObject({ fact: 'loose two', visibility: 'private', context: 'ctx', source: 's', attributed_to: 'user' });
    expect(all[0]).toMatchObject({ context: null, attributed_to: null });
    const view = (rows: typeof all) => rows.map(({ id, ...row }) => ({ ...row, id: seed.name(id) }));
    return { all: view(all), afterOld: view(afterOld), limited: view(limited), future, fromEpoch: view(fromEpoch) };
  });

  parityTest('countRelinkCandidates counts the entity-less active facts a fence or page owns, in one source', { methods: ['countRelinkCandidates'] }, async (engine, backend) => {
    const seed = new Seed(engine);
    await seed.one('loose', { fact: 'loose' });
    await seed.one('entity', { fact: 'has entity', entity_slug: 'people/alice' });
    await seed.fence([
      { label: 'fenced', fact: 'fenced', row_num: 1, source_markdown_slug: 'notes/a' },
      { label: 'paged', fact: 'paged', row_num: 2, source_markdown_slug: 'notes/b' },
      { label: 'gone', fact: 'gone', row_num: 3, source_markdown_slug: 'notes/c' },
      { label: 'owned entity', fact: 'owned entity', row_num: 4, source_markdown_slug: 'notes/d', entity_slug: 'people/alice' },
    ]);
    const gone = [...seed.names].find(([, label]) => label === 'gone')![0];
    await engine.expireFact(gone);
    await createSource(engine, backend, 'other');
    await seed.one('other-loose', { fact: 'other' }, 'other');
    const counts = { here: await engine.countRelinkCandidates(SRC), elsewhere: await engine.countRelinkCandidates('other') };
    expect(counts).toEqual({ here: 2, elsewhere: 0 });
    return counts;
  });

  parityTest('listSimilarActiveFacts ranks the same-model active neighbours of the fact\'s entity and visibility, nearest first', { methods: ['listSimilarActiveFacts'] }, async (engine) => {
    const seed = new Seed(engine);
    const withVec = (label: string, head: number[], model: string, entity: string | null, visibility: 'private' | 'world' = 'private') =>
      seed.one(label, { fact: label, entity_slug: entity, visibility, embedding: vec(...head), embedding_model: model });
    const anchor = await withVec('anchor', [1, 0], 'm1', 'people/a');
    await withVec('near', [1, 0.1], 'm1', 'people/a');
    await withVec('nearer', [1, 0.01], 'm1', 'people/a');
    await withVec('far', [0, 1], 'm1', 'people/a');
    await withVec('model', [1, 0], 'm2', 'people/a');
    await withVec('entity', [1, 0], 'm1', 'people/b');
    await withVec('world', [1, 0], 'm1', 'people/a', 'world');
    const gone = await withVec('gone', [1, 0], 'm1', 'people/a');
    await engine.expireFact(gone);
    const plain = await seed.one('plain', { fact: 'no vector', entity_slug: 'people/a' });
    const q = (factId: number, over: Partial<Parameters<BrainEngine['listSimilarActiveFacts']>[0]> = {}) =>
      engine.listSimilarActiveFacts({ sourceId: SRC, factId, remote: false, excludePrivate: false, minCosine: 0.9, limit: 10, ...over });
    const view = (out: Awaited<ReturnType<typeof q>>) => ({
      anchor: out.anchor,
      rows: out.rows.map((r) => ({ id: seed.name(r.id), similarity: Math.round(Number(r.similarity) * 1000) / 1000 })),
    });
    const ranked = await q(anchor);
    expect(ranked.anchor).toEqual({ has_embedding: true, entity_slug: 'people/a' });
    expect(ranked.rows.map((r) => seed.name(r.id))).toEqual(['nearer', 'near']);
    expect(Number(ranked.rows[0]!.similarity)).toBeGreaterThan(0.999);
    const limited = await q(anchor, { limit: 1 });
    const strict = await q(anchor, { minCosine: 1.5 });
    const remote = await q(anchor, { remote: true, minCosine: 0 });
    const noVector = await q(plain, { minCosine: 0 });
    const unknown = await q(anchor + 100_000, { minCosine: 0 });
    expect(seed.label(limited.rows)).toEqual(['nearer']);
    expect(strict.rows).toEqual([]);
    expect(remote.rows).toEqual([]);
    expect(noVector).toEqual({ anchor: { has_embedding: false, entity_slug: 'people/a' }, rows: [] });
    expect(unknown).toEqual({ anchor: null, rows: [] });
    return { ranked: view(ranked), limited: view(limited), strict, remote, noVector, unknown };
  });

  parityTest('listSimilarActiveFacts under excludePrivate drops neighbours held on private pages', { methods: ['listSimilarActiveFacts'] }, async (engine) => {
    const seed = new Seed(engine);
    await engine.putPage('notes/open', note('Open', 'open'));
    await engine.putPage('notes/private', note('Private', 'private', { visibility: 'private' }));
    const anchor = await seed.one('anchor', { fact: 'anchor', entity_slug: 'people/a', embedding: vec(1, 0), embedding_model: 'm1' });
    await seed.fence([
      { label: 'on-open', fact: 'on open', row_num: 1, source_markdown_slug: 'notes/open', entity_slug: 'people/a', visibility: 'private', embedding: vec(1, 0.01), embedding_model: 'm1' },
      { label: 'on-private', fact: 'on private', row_num: 2, source_markdown_slug: 'notes/private', entity_slug: 'people/a', visibility: 'private', embedding: vec(1, 0.02), embedding_model: 'm1' },
    ]);
    const read = async (excludePrivate: boolean) =>
      seed.label((await engine.listSimilarActiveFacts({ sourceId: SRC, factId: anchor, remote: false, excludePrivate, minCosine: 0.9, limit: 10 })).rows);
    const all = await read(false);
    const open = await read(true);
    expect(all).toEqual(['on-open', 'on-private']);
    expect(open).toEqual(['on-open']);
    return { all, open };
  });

  parityTest('listSimilarActiveFacts under excludePrivate applies a caller\'s reader identity, own member page and private-readable grant', { methods: ['listSimilarActiveFacts'] }, async (engine) => {
    const seed = new Seed(engine);
    await putCallerPages(engine);
    // A neighbour shares the anchor's entity and visibility: one anchor per entity, each fence row on its entity.
    const anchors: number[] = [];
    for (const [slug] of CALLER_ENTITIES) {
      anchors.push(await seed.one(`anchor:${slug}`, { fact: `anchor ${slug}`, entity_slug: slug, visibility: 'world', embedding: vec(1, 0), embedding_model: 'm1' }));
    }
    await seed.fence(callerFactRows().map((r, i) => ({
      ...r, label: r.fact, visibility: 'world' as const, embedding: vec(1, 0.01 * (i + 1)), embedding_model: 'm1',
    })));
    const kept = await readAsCallers(async () => {
      const out: string[] = [];
      for (const factId of anchors) {
        out.push(...seed.label((await engine.listSimilarActiveFacts({ sourceId: SRC, factId, remote: false, excludePrivate: true, minCosine: 0.9, limit: 50 })).rows));
      }
      return sorted(out);
    });
    const open = ['entity:people/open-example', 'prov:notes/open'];
    const member = 'prov:memory/members/alice-example';
    expect(kept.none).toEqual(open);
    expect(kept.stranger).toEqual(open);
    expect(kept.member).toEqual(sorted([...open, member, 'entity:people/readers-example', 'entity:people/team-example']));
    expect(kept.granted).toEqual(sorted([...open, member, 'entity:people/readers-example', 'entity:people/private-example']));
    return kept;
  });

  parityTest('findActiveSingleFact answers the lowest-id active fact of the claim, entity, visibility, speaker slot and page', { methods: ['findActiveSingleFact'] }, async (engine) => {
    const seed = new Seed(engine);
    const plain = await seed.one('plain', { fact: 'Likes tea', entity_slug: 'people/a' });
    const byUser = await seed.one('by-user', { fact: 'likes  TEA.', entity_slug: 'people/a', attributed_to: 'user', embedding: vec(0.5), embedding_model: 'm1' });
    await seed.fence([
      { label: 'on-member', fact: 'Likes tea', row_num: 1, source_markdown_slug: 'memory/members/alice', entity_slug: 'people/a' },
      { label: 'on-page', fact: 'Likes tea', row_num: 2, source_markdown_slug: 'notes/a', entity_slug: 'people/a' },
    ]);
    await seed.one('loose', { fact: 'Likes tea' });
    const find = async (entitySlug: string | null, attributedTo: string | null, pageSlug: string | null) => {
      const row = await engine.findActiveSingleFact({ sourceId: SRC, entitySlug, visibility: 'private', fact: 'likes tea', attributedTo, pageSlug, remoteFloor: false });
      return row === null ? null : seed.name(row.id);
    };
    const found = {
      plain: await find('people/a', null, null),
      user: await find('people/a', 'user', null),
      page: await find('people/a', null, 'notes/a'),
      member: await find('people/a', null, 'memory/members/alice'),
      loose: await find(null, null, null),
      emptyPage: await find('people/a', null, ''),
      noPage: await find('people/a', null, 'notes/none'),
      noEntity: await find('people/zed', null, null),
    };
    expect(found).toEqual({ plain: 'plain', user: 'plain', page: 'on-page', member: 'on-member', loose: 'loose', emptyPage: null, noPage: null, noEntity: null });
    await engine.expireFact(plain);
    const row = (await engine.findActiveSingleFact({ sourceId: SRC, entitySlug: 'people/a', visibility: 'private', fact: 'likes tea', attributedTo: 'user', pageSlug: null, remoteFloor: false }))!;
    expect(Number(row.id)).toBe(byUser);
    expect(row).toMatchObject({ source_id: SRC, entity_slug: 'people/a', fact: 'likes  TEA.', visibility: 'private', attributed_to: 'user', embedding_model: 'm1', row_num: null, source_markdown_slug: null, expired_at: null, valid_until: null, confidence: 1 });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.valid_from).toBeInstanceOf(Date);
    expect(typeof row.embedding).toBe('string');
    // A row of another speaker is no match; the row of no speaker still is.
    const other = await find('people/a', 'assistant', null);
    expect(other).toBe('on-page');
    return { found, other, row: { fact: row.fact, attributed_to: row.attributed_to, kind: row.kind, visibility: row.visibility, confidence: row.confidence, embedding_model: row.embedding_model, created: row.created_at instanceof Date, row_num: row.row_num, trust_tier: row.trust_tier, write_origin: row.write_origin } };
  });

  parityTest('findActiveSingleFact with newest answers the highest-id active copy, as remember links the unlinked copy of a claim', { methods: ['findActiveSingleFact'] }, async (engine) => {
    const seed = new Seed(engine);
    await engine.putPage('notes/private', note('Private', 'private', { visibility: 'private' }));
    await seed.one('old', { fact: 'Likes tea' });
    await seed.one('new', { fact: 'likes  TEA.', attributed_to: 'user' });
    const expired = await seed.one('expired', { fact: 'Likes tea' });
    await engine.expireFact(expired);
    await seed.one('linked', { fact: 'Likes tea', entity_slug: 'people/a' });
    await seed.one('world', { fact: 'Likes tea', visibility: 'world' });
    await seed.fence([
      { label: 'member-old', fact: 'Likes tea', row_num: 1, source_markdown_slug: 'memory/members/alice' },
      { label: 'member-new', fact: 'Likes tea', row_num: 2, source_markdown_slug: 'memory/members/alice' },
    ]);
    await seed.fence([{ label: 'on-private', fact: 'Likes tea', row_num: 1, source_markdown_slug: 'notes/private' }]);
    const find = async (pageSlug: string | null, newest: boolean | undefined, remoteFloor = false) => {
      const row = await engine.findActiveSingleFact({ sourceId: SRC, entitySlug: null, visibility: 'private', fact: 'likes tea', attributedTo: null, pageSlug, remoteFloor, ...(newest === undefined ? {} : { newest }) });
      return row === null ? null : seed.name(row.id);
    };
    const found = {
      lowest: await find(null, undefined), lowestFalse: await find(null, false), newest: await find(null, true),
      member: await find('memory/members/alice', true), memberLowest: await find('memory/members/alice', undefined),
      emptyPage: await find('', true), privatePage: await find('notes/private', true),
      privateFloor: await find('notes/private', true, true), noPageFloor: await find(null, true, true),
    };
    // The private page's fence row is the highest id, so the floor is not vacuous: it hides that row and keeps 'new'.
    expect(found).toEqual({ lowest: 'old', lowestFalse: 'old', newest: 'on-private', member: 'member-new', memberLowest: 'member-old',
      emptyPage: null, privatePage: 'on-private', privateFloor: null, noPageFloor: 'new' });
    return found;
  });

  parityTest('findActiveSingleFact under the remote provenance floor drops facts on private pages', { methods: ['findActiveSingleFact'] }, async (engine) => {
    const seed = new Seed(engine);
    await engine.putPage('notes/private', note('Private', 'private', { visibility: 'private' }));
    await seed.fence([{ label: 'on-private', fact: 'Likes tea', row_num: 1, source_markdown_slug: 'notes/private', entity_slug: 'people/a' }]);
    const find = async (remoteFloor: boolean) => {
      const row = await engine.findActiveSingleFact({ sourceId: SRC, entitySlug: 'people/a', visibility: 'private', fact: 'likes tea', attributedTo: null, pageSlug: 'notes/private', remoteFloor });
      return row === null ? null : seed.name(row.id);
    };
    const open = await find(false);
    expect(open).toBe('on-private');
    const floored = await find(true);
    expect(floored).toBeNull();
    return { open, floored };
  });

  parityTest('findActiveSingleFact under the remote provenance floor judges only the provenance page, not the entity page', { methods: ['findActiveSingleFact'] }, async (engine) => {
    const seed = new Seed(engine);
    await engine.putPage('people/secret', note('Secret', 'private person', { visibility: 'private' }));
    await engine.putPage('notes/open', note('Open', 'open'));
    await engine.putPage('notes/readers', note('Readers', 'kept to one member', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/aliased', note('Aliased', 'aliased', { access: 'private' }));
    // The lowest id is on the readers page, so a scan with no page names it only without the floor.
    await seed.fence([{ label: 'readers-page', fact: 'Likes tea', row_num: 1, source_markdown_slug: 'notes/readers', entity_slug: 'people/secret' }]);
    await seed.fence([{ label: 'open-page', fact: 'Likes tea', row_num: 1, source_markdown_slug: 'notes/open', entity_slug: 'people/secret' }]);
    await seed.fence([{ label: 'aliased-page', fact: 'Likes tea', row_num: 1, source_markdown_slug: 'notes/aliased', entity_slug: 'people/secret' }]);
    const find = async (pageSlug: string | null, remoteFloor: boolean) => {
      const row = await engine.findActiveSingleFact({ sourceId: SRC, entitySlug: 'people/secret', visibility: 'private', fact: 'likes tea', attributedTo: null, pageSlug, remoteFloor });
      return row === null ? null : seed.name(row.id);
    };
    const found: Record<string, string | null> = {};
    for (const page of ['notes/open', 'notes/readers', 'notes/aliased', null] as const) {
      found[`${page ?? 'none'}:open`] = await find(page, false);
      found[`${page ?? 'none'}:floor`] = await find(page, true);
    }
    // The entity page is private, yet the floor keeps the fact on an open page: it has no entity gate.
    expect(found).toEqual({
      'notes/open:open': 'open-page', 'notes/open:floor': 'open-page',
      'notes/readers:open': 'readers-page', 'notes/readers:floor': null,
      'notes/aliased:open': 'aliased-page', 'notes/aliased:floor': null,
      'none:open': 'readers-page', 'none:floor': 'open-page',
    });
    return found;
  });

  parityTest('findActiveSingleFact under the remote provenance floor hides a fact of an owner-only source, closed with no schema version and per source with one', { methods: ['findActiveSingleFact'] }, async (engine, backend) => {
    const seed = new Seed(engine);
    const find = async (sourceId: string, remoteFloor: boolean) => {
      const row = await engine.findActiveSingleFact({ sourceId, entitySlug: 'people/a', visibility: 'private', fact: 'likes tea', attributedTo: null, pageSlug: null, remoteFloor });
      return row === null ? null : seed.name(row.id);
    };
    const read = async () => ({
      open: await find(SRC, false), openFloor: await find(SRC, true),
      chat: await find('fact-chat', false), chatFloor: await find('fact-chat', true),
    });
    await seed.one('default-row', { fact: 'Likes tea', entity_slug: 'people/a' });
    // Before any owner-only source exists the floor keeps the default-source fact, so the case is not vacuous.
    const before = { openFloor: await find(SRC, true) };
    await createSource(engine, backend, 'fact-chat', { kind: 'imessage' });
    await seed.one('chat-row', { fact: 'Likes tea', entity_slug: 'people/a' }, 'fact-chat');
    // The harness brain records no schema version: the closed form hides every fact while any source is owner-only.
    const closed = await read();
    noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
    // Schema version 320 or later: only a fact of the owner-only source is hidden.
    const fn = await withEngineScope(engine, read);
    expect(before).toEqual({ openFloor: 'default-row' });
    expect(closed).toEqual({ open: 'default-row', openFloor: null, chat: 'chat-row', chatFloor: null });
    expect(fn).toEqual({ open: 'default-row', openFloor: 'default-row', chat: 'chat-row', chatFloor: null });
    return { before, closed, fn };
  });

  // A remote caller always reads inside a caller record, which renders the floor without the live pending-coverage test
  // and, for the owner, without the owner-only test; `restricted: false` renders the short member-access form. Each of
  // these is a floor the store models, so the Rust member must answer them rather than stop.
  parityTest('findActiveSingleFact under the remote provenance floor answers inside a caller record: a member, the owner, and a brain with no member-access restrictions', { methods: ['findActiveSingleFact'] }, async (engine, backend) => {
    const seed = new Seed(engine);
    await putCallerPages(engine);
    // A page derived from a page that names readers: the full form's origin walk hides it, and the short form a brain
    // with no member-access restrictions renders does not, even when the store's restriction flag is set (here by
    // notes/readers), as for a caller whose flag read is stale.
    await engine.putPage('notes/lineage', note('Lineage', '', { derived_from: ['notes/readers'] }));
    const pages = ['notes/open', 'notes/private', 'notes/readers', 'notes/lineage', 'memory/members/alice-example'];
    for (const page of pages) await seed.fence([{ label: page, fact: 'Likes tea', row_num: 1, source_markdown_slug: page, entity_slug: 'people/a' }]);
    const records = {
      member: { identity: ['member:alice-example'] },
      owner: { owner: true, identity: ['member:alice-example'] },
      open: { restricted: false, identity: ['member:alice-example'] },
      ownerOpen: { owner: true, restricted: false, identity: ['member:alice-example'] },
    } as const;
    const find = async (sourceId: string, pageSlug: string | null) => {
      const row = await engine.findActiveSingleFact({ sourceId, entitySlug: 'people/a', visibility: 'private', fact: 'likes tea', attributedTo: null, pageSlug, remoteFloor: true });
      return row === null ? null : seed.name(row.id);
    };
    const readPages = async () => {
      const out: Record<string, string | null> = {};
      for (const p of [...pages, null]) out[p ?? 'none'] = await find(SRC, p);
      return out;
    };
    const asRecords = async (read: () => Promise<unknown>) => {
      const out: Record<string, unknown> = { none: await read() };
      for (const [name, record] of Object.entries(records)) out[name] = await withCallerAccess({ ...record, identity: [...record.identity] }, read);
      return out;
    };
    const byPage = await asRecords(readPages);
    // The floor judges every provenance page by the empty identity, so the caller's own member page stays hidden too.
    const floor = { 'notes/open': 'notes/open', 'notes/private': null, 'notes/readers': null, 'notes/lineage': null, 'memory/members/alice-example': null, none: 'notes/open' };
    const short = { ...floor, 'notes/lineage': 'notes/lineage' };
    expect(byPage).toEqual({ none: floor, member: floor, owner: floor, open: short, ownerOpen: short });
    // An owner-only source: with no schema version the closed form hides every fact for any caller but the owner.
    await createSource(engine, backend, 'fact-chat', { kind: 'imessage' });
    await seed.one('chat-row', { fact: 'Likes tea', entity_slug: 'people/a' }, 'fact-chat');
    const ownerOnly = await asRecords(async () => ({ open: await find(SRC, 'notes/open'), chat: await find('fact-chat', null) }));
    const hidden = { open: null, chat: null };
    const shown = { open: 'notes/open', chat: 'chat-row' };
    expect(ownerOnly).toEqual({ none: hidden, member: hidden, owner: shown, open: hidden, ownerOpen: shown });
    return { byPage, ownerOnly };
  });

  parityTest('listSingleFactMetadata reads the fence position, trust tier and claim slot of the named facts', { methods: ['listSingleFactMetadata'] }, async (engine) => {
    const seed = new Seed(engine);
    await engine.putPage('notes/private', note('Private', 'private', { visibility: 'private' }));
    await engine.putPage('notes/readers', note('Readers', 'kept to one member', { readable_by: ['alice-example'] }));
    const plain = await seed.one('plain', { fact: 'plain', entity_slug: 'people/a', claim_metric: 'arr', claim_value: 3, claim_unit: 'usd', claim_period: 'q3' });
    const [fenced, hidden] = await seed.fence([
      { label: 'fenced', fact: 'fenced', row_num: 1, source_markdown_slug: 'notes/open', entity_slug: 'people/a' },
      { label: 'hidden', fact: 'hidden', row_num: 2, source_markdown_slug: 'notes/private', entity_slug: 'people/a' },
    ]) as [number, number];
    const [readers] = await seed.fence([
      { label: 'readers', fact: 'readers', row_num: 1, source_markdown_slug: 'notes/readers', entity_slug: 'people/a' },
    ]) as [number];
    const read = async (ids: number[], remoteFloor: boolean) => {
      const rows = await engine.listSingleFactMetadata({ sourceId: SRC, ids, remoteFloor });
      return sorted(rows.map(({ id, ...row }) => ({ ...row, id: seed.name(id) })), (r) => r.id);
    };
    const all = await read([plain, fenced, hidden, plain + 100_000], false);
    const floored = await read([plain, fenced, hidden, readers], true);
    expect(all.map((r) => r.id)).toEqual(['fenced', 'hidden', 'plain']);
    expect(all.find((r) => r.id === 'plain')).toMatchObject({ source_markdown_slug: null, row_num: null, claim_metric: 'arr', claim_unit: 'usd', claim_period: 'q3' });
    expect(all.find((r) => r.id === 'fenced')).toMatchObject({ source_markdown_slug: 'notes/open', row_num: 1 });
    expect(floored.map((r) => r.id)).toEqual(['fenced', 'plain']);
    return { all, floored };
  });

  parityTest('listUnfencedFactRows lists the active unfenced rows in source, entity, id order with whether the entity has a live page', { methods: ['listUnfencedFactRows'] }, async (engine) => {
    const seed = new Seed(engine);
    await engine.putPage('people/alice', note('Alice', 'a'));
    await engine.putPage('people/gone', note('Gone', 'g'));
    await engine.softDeletePage('people/gone');
    // Inserted out of the order they are listed in, so an order by id alone answers differently.
    await seed.one('loose', { fact: 'loose' });
    await seed.one('bob', { fact: 'bob fact', entity_slug: 'people/bob', visibility: 'world' });
    await seed.one('on-gone', { fact: 'gone page fact', entity_slug: 'people/gone' });
    await seed.one('alice', { fact: 'alice fact', entity_slug: 'people/alice', claim_metric: 'arr', claim_value: 1.5, attributed_to: 'user' });
    await seed.one('upper', { fact: 'upper', entity_slug: 'People/zed' });
    const expired = await seed.one('expired', { fact: 'expired', entity_slug: 'people/bob' });
    await engine.expireFact(expired);
    await seed.fence([
      { label: 'fenced-2', fact: 'fenced 2', row_num: 2, source_markdown_slug: 'people/alice', entity_slug: 'people/alice' },
      { label: 'fenced-3', fact: 'fenced 3', row_num: 3, source_markdown_slug: 'people/alice', entity_slug: 'people/alice' },
    ]);
    const everywhere = await engine.listUnfencedFactRows({});
    const one = await engine.listUnfencedFactRows({ sourceId: SRC });
    const none = await engine.listUnfencedFactRows({ sourceId: 'elsewhere' });
    // Bytewise order: an upper-case entity before a lower-case one, an entity-less row last.
    expect(seed.label(everywhere).filter((n) => !n.startsWith('fenced-'))).toEqual(['upper', 'alice', 'bob', 'on-gone', 'loose']);
    expect(seed.label(one)).toEqual(seed.label(everywhere));
    expect(none).toEqual([]);
    const byName = (name: string) => everywhere.find((r) => seed.name(r.id) === name)!;
    expect(byName('alice')).toMatchObject({ page_exists: true, claim_metric: 'arr', attributed_to: 'user', confidence: 1, valid_until: null, visibility: 'private', source: 'chat' });
    expect(Number(byName('alice').claim_value)).toBe(1.5);
    expect(byName('on-gone').page_exists).toBe(false);
    expect(byName('loose').page_exists).toBe(false);
    expect(byName('alice').valid_from).toBeInstanceOf(Date);
    const view = (rows: typeof everywhere) => rows.map(({ id, valid_from, ...row }) => ({ ...row, id: seed.name(id), valid_from: valid_from instanceof Date }));
    return { everywhere: view(everywhere), one: seed.label(one), none };
  });

  parityTest('countUnfencedFactGroups counts the unfenced rows per source, entity and live page, and listUnfencedFactRows narrows to the fenceable ones', { methods: ['countUnfencedFactGroups', 'listUnfencedFactRows'] }, async (engine) => {
    const seed = new Seed(engine);
    await engine.putPage('people/alice', note('Alice', 'a'));
    await engine.putPage('people/gone', note('Gone', 'g'));
    await engine.softDeletePage('people/gone');
    await seed.one('loose-1', { fact: 'loose 1' });
    await seed.one('loose-2', { fact: 'loose 2' });
    await seed.one('on-gone', { fact: 'gone page fact', entity_slug: 'people/gone' });
    await seed.one('alice-1', { fact: 'alice 1', entity_slug: 'people/alice' });
    await seed.one('alice-2', { fact: 'alice 2', entity_slug: 'people/alice' });
    await seed.one('nobody', { fact: 'no page', entity_slug: 'people/nobody' });
    const expired = await seed.one('expired', { fact: 'expired', entity_slug: 'people/alice' });
    await engine.expireFact(expired);
    await seed.fence([{ label: 'fenced-2', fact: 'fenced 2', row_num: 2, source_markdown_slug: 'people/alice', entity_slug: 'people/alice' }]);
    const sorted = (groups: Awaited<ReturnType<typeof engine.countUnfencedFactGroups>>) =>
      groups.map(({ source_id, has_entity, page_exists, n }) => ({ source_id, has_entity, page_exists, n: Number(n) }))
        .sort((a, b) => `${a.has_entity}${a.page_exists}`.localeCompare(`${b.has_entity}${b.page_exists}`));
    const everywhere = sorted(await engine.countUnfencedFactGroups({}));
    const one = sorted(await engine.countUnfencedFactGroups({ sourceId: SRC }));
    const none = await engine.countUnfencedFactGroups({ sourceId: 'elsewhere' });
    expect(everywhere).toEqual([
      { source_id: SRC, has_entity: false, page_exists: false, n: 2 },
      { source_id: SRC, has_entity: true, page_exists: false, n: 2 },
      { source_id: SRC, has_entity: true, page_exists: true, n: 2 },
    ]);
    expect(one).toEqual(everywhere);
    expect(none).toEqual([]);
    const fenceable = await engine.listUnfencedFactRows({ fenceableSourceIds: [SRC] });
    const narrowedOne = await engine.listUnfencedFactRows({ sourceId: SRC, fenceableSourceIds: [SRC] });
    const otherSource = await engine.listUnfencedFactRows({ fenceableSourceIds: ['elsewhere'] });
    const noSource = await engine.listUnfencedFactRows({ fenceableSourceIds: [] });
    expect(seed.label(fenceable)).toEqual(['alice-1', 'alice-2']);
    expect(fenceable.every((r) => r.page_exists === true)).toBe(true);
    expect(seed.label(narrowedOne)).toEqual(seed.label(fenceable));
    expect(otherSource).toEqual([]);
    expect(noSource).toEqual([]);
    return { everywhere, one, none, fenceable: seed.label(fenceable), otherSource, noSource };
  });

  parityTest('listHeldFenceFactRows lists a page\'s live fence rows by position, a conversation extractor\'s rows and expired rows apart', { methods: ['listHeldFenceFactRows'] }, async (engine) => {
    const seed = new Seed(engine);
    const ids = await seed.fence([
      { label: 'fenced-2', fact: 'fenced 2', row_num: 2, source_markdown_slug: 'people/alice', entity_slug: 'people/alice' },
      { label: 'fenced-1', fact: 'fenced 1', row_num: 1, source_markdown_slug: 'people/alice', entity_slug: 'people/alice', claim_metric: 'arr', claim_value: 2, attributed_to: 'user' } as never,
      { label: 'conversation', fact: 'conversation', row_num: 3, source_markdown_slug: 'people/alice', entity_slug: 'people/alice', source: 'cli:extract-conversation-facts:segment' },
      { label: 'expired', fact: 'expired', row_num: 4, source_markdown_slug: 'people/alice', entity_slug: 'people/alice' },
      { label: 'elsewhere', fact: 'elsewhere', row_num: 1, source_markdown_slug: 'people/bob', entity_slug: 'people/bob' },
    ]);
    await engine.expireFact(ids[3]!);
    const held = await engine.listHeldFenceFactRows(SRC, 'people/alice');
    const elsewhere = await engine.listHeldFenceFactRows(SRC, 'people/none');
    const otherSource = await engine.listHeldFenceFactRows('elsewhere', 'people/alice');
    expect(seed.label(held)).toEqual(['fenced-1', 'fenced-2']);
    expect(held[0]).toMatchObject({ row_num: 1, fact: 'fenced 1', claim_metric: 'arr', entity_slug: 'people/alice', source: 'fence', confidence: 1, attributed_to: 'user', visibility: 'private' });
    expect(Number(held[0]!.claim_value)).toBe(2);
    expect(held[0]!.valid_from).toBeInstanceOf(Date);
    expect(elsewhere).toEqual([]);
    expect(otherSource).toEqual([]);
    return { held: held.map(({ id, valid_from, ...row }) => ({ ...row, id: seed.name(id), valid_from: valid_from instanceof Date })), elsewhere, otherSource };
  });

  /** The withdrawal fixture: one claim on an entity, a name key, a loose row, a fenced row, a member-page row and a world copy. */
  async function withdrawalFixture(engine: BrainEngine) {
    const seed = new Seed(engine);
    await engine.putPage('people/alice', note('Alice', 'a'));
    const a = await seed.one('alice', { fact: 'Withdraw me', entity_slug: 'people/alice' });
    await seed.one('bob', { fact: 'withdraw me', entity_slug: 'people/bob' });
    await seed.one('name-key', { fact: 'Withdraw me.', entity_slug: 'alice' });
    await seed.one('loose', { fact: 'Withdraw  me' });
    await seed.fence([
      { label: 'fenced', fact: 'Withdraw me', row_num: 1, source_markdown_slug: 'notes/page', entity_slug: 'people/bob' },
      { label: 'member', fact: 'Withdraw me', row_num: 1, source_markdown_slug: 'memory/members/carol', entity_slug: 'people/carol' },
    ]);
    await seed.one('world', { fact: 'Withdraw me', entity_slug: 'people/alice', visibility: 'world' });
    return { seed, hash: await hashOf(engine, a) };
  }

  parityTest('listWithdrawalSlugs names the pages of the claim\'s live facts under a subject: the fence page, else the entity', { methods: ['listWithdrawalSlugs', 'loadPurgeTarget'] }, async (engine) => {
    const { seed, hash } = await withdrawalFixture(engine);
    const slugs = async (subject: string) => sorted((await engine.listWithdrawalSlugs(SRC, 'private', hash, subject)).map((r) => r.slug), (s) => s);
    const bySubject = {
      alice: await slugs('people/alice'),
      bob: await slugs('people/bob'),
      member: await slugs('memory/members/carol'),
      everyone: await slugs('*'),
      zed: await slugs('people/zed'),
    };
    expect(bySubject.alice).toEqual(['alice', 'people/alice']);
    expect(bySubject.bob).toEqual(['alice', 'notes/page', 'people/bob']);
    expect(bySubject.member).toEqual(['memory/members/carol']);
    expect(bySubject.everyone).toEqual(['alice', 'memory/members/carol', 'notes/page', 'people/alice', 'people/bob']);
    expect(bySubject.zed).toEqual(['alice']);
    const none = (await engine.listWithdrawalSlugs(SRC, 'private', 'no-such-hash', '*')).length;
    expect(none).toBe(0);
    // An expired row names no page.
    await engine.expireFact([...seed.names].find(([, label]) => label === 'bob')![0]);
    const afterExpiry = await slugs('people/bob');
    expect(afterExpiry).toEqual(['alice', 'notes/page']);
    return { bySubject, none, afterExpiry };
  });

  parityTest('expireFactsByWithdrawal expires the claim\'s live facts under a subject now and answers their ids', { methods: ['expireFactsByWithdrawal', 'listWithdrawalSlugs', 'listFactsByEntity'] }, async (engine) => {
    const { seed, hash } = await withdrawalFixture(engine);
    const expire = async (visibility: string, subject: string) =>
      seed.label(await engine.expireFactsByWithdrawal(SRC, visibility, 'WITHDRAW ME', subject)).sort();
    const slugs = async (subject: string) => sorted((await engine.listWithdrawalSlugs(SRC, 'private', hash, subject)).map((r) => r.slug), (s) => s);
    const first = await expire('private', 'people/alice');
    expect(first).toEqual(['alice', 'name-key']);
    const again = await expire('private', 'people/alice');
    expect(again).toEqual([]);
    const afterFirst = await slugs('*');
    expect(afterFirst).toEqual(['memory/members/carol', 'notes/page', 'people/bob']);
    const member = await expire('private', 'memory/members/carol');
    expect(member).toEqual(['member']);
    const everyone = await expire('private', '*');
    expect(everyone).toEqual(['bob', 'fenced', 'loose']);
    const world = await expire('world', '*');
    expect(world).toEqual(['world']);
    const left = await slugs('*');
    expect(left).toEqual([]);
    const history = await engine.listFactsByEntity(SRC, 'people/alice', { activeOnly: false });
    const row = history.find((r) => r.fact === 'Withdraw me' && r.visibility === 'private')!;
    expect(row.expired_at).toBeInstanceOf(Date);
    expect(row.valid_until).toBeInstanceOf(Date);
    expect(row.valid_until!.getTime()).toBeLessThanOrEqual(row.expired_at!.getTime());
    return { first, again, afterFirst, member, everyone, world, left, expired: history.map((r) => ({ visibility: r.visibility, expired: r.expired_at instanceof Date, closed: r.valid_until instanceof Date })) };
  });

  // recordDerivationEdges keeps each edge once (ON CONFLICT DO NOTHING) and listDerivedRows reads one hop back: the
  // distinct rows derived from any frontier row, by table then id, at most `limit`. Ids share one width, so byte order
  // and the Postgres collation agree.
  parityTest('recordDerivationEdges records each input edge once and listDerivedRows reads one hop back', {
    methods: ['recordDerivationEdges', 'listDerivedRows'],
  }, async (engine) => {
    const ref = (table: string, id: string) => ({ table, id });
    await engine.recordDerivationEdges(ref('pages', '201'), SRC, [ref('pages', '101'), ref('facts', '301')]);
    await engine.recordDerivationEdges(ref('pages', '201'), SRC, [ref('pages', '101')]);
    await engine.recordDerivationEdges(ref('facts', '302'), SRC, [ref('pages', '101'), ref('pages', '201')]);
    await engine.recordDerivationEdges(ref('takes', '401'), null, [ref('facts', '302')]);
    await engine.recordDerivationEdges(ref('pages', '202'), SRC, []);
    const hop = async (frontier: Array<{ table: string; id: string }>, limit = 10) =>
      (await engine.listDerivedRows(frontier, limit)).map((r) => `${r.derived_table}:${r.derived_id}`);
    const fromInput = await hop([ref('pages', '101')]);
    expect(fromInput).toEqual(['facts:302', 'pages:201']);
    const fromTwo = await hop([ref('pages', '101'), ref('pages', '201')]);
    expect(fromTwo).toEqual(['facts:302', 'pages:201']);
    const limited = await hop([ref('pages', '101'), ref('facts', '302')], 2);
    expect(limited).toEqual(['facts:302', 'pages:201']);
    const sourceless = await hop([ref('facts', '302')]);
    expect(sourceless).toEqual(['takes:401']);
    const leaf = await hop([ref('takes', '401')]);
    expect(leaf).toEqual([]);
    const empty = await hop([]);
    expect(empty).toEqual([]);
    return { fromInput, fromTwo, limited, sourceless, leaf, empty };
  });
});
