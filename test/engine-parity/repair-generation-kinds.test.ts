/**
 * BrainEngine parity: the generation repair kinds of batch 7 of the repair-on-Rust plan.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain seeded so each preview lists at least one item, the preview is equal on PGLite, Postgres
 *    (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1). lost-fence-rows lists a fact row a fence generation
 *    retired while the page lost its whole facts fence, restored from the page version that held it; the restore (a page
 *    write) is the same on every arm. The lost-fence-rows members answer the same rows on every arm.
 *    stale-atoms lists an atom whose origin is gone and an atom whose origin moved past it with a completed unmanaged
 *    extraction of its new content the same way on every arm. Its apply retires both atoms and keeps the new one on the
 *    SQL arms; the retirement publishes an atom generation (lane 7's writer), and the Rust engine refuses it by name
 *    ("repair stale-atoms retirement").
 *    generations previews a restore of an atom key's live generation to its predecessor (each item refused, as its ledger
 *    record holds no preimage) and the release of that key's held result the same way on every arm.
 *  - Regression: the kind read the generation ledger, page versions, facts and takes through executeRaw, so a Rust brain
 *    failed on a generic executeRaw refusal that named no step.
 *  - Why existing coverage misses it: test/repair-lost-fence-rows.test.ts and test/repair-stale-atoms*.test.ts run on
 *    PGLite and Postgres only; test/rust-generation-repair.test.ts calls the generations members directly, not the kind.
 *  - Seam: the ledger row is written through the typed activateGenerationRows (lane 7), pages and versions through
 *    putPage and createVersion, facts and takes through insertFacts and addTakesBatch.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { atomOwnerKey } from '../../src/core/generations/adapters/atoms.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  const text = JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    // Postgres sequences keep counting across cases (harness reset), so page and version ids are not comparable; nor
    // is a generation's creation time.
    .replace(/"page_id":\d+/g, '"page_id":"<id>"').replace(/"version_id":\d+/g, '"version_id":"<id>"').replace(/page version \d+/g, 'page version <id>')
    .replace(/"id":\d+/g, '"id":"<id>"').replace(/retired \d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00/g, 'retired <time>')
    .replace(/"retired_at":"[^"]*"/g, '"retired_at":"<time>"').replace(/unmanaged:\d+/g, 'unmanaged:<id>');
  return JSON.parse(text);
}

const runKind = async (engine: BrainEngine, kind: RepairKind, apply: boolean, opts: Record<string, unknown> = {}) =>
  (await repairRunner(engine, { apply, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(engine), { explicit: true, ...opts });

const refusalText = (err: unknown) => JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-b7-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ---- lost-fence-rows ----

const SLUG = 'people/alice-example';
const LOST = 'Alice Example prefers written agendas';

/**
 * A version of the page holds facts rows 1 and 2; the live page has no facts fence at all. A fact_fence generation of
 * the page retired row 2 (its preimage), and no stored fact holds that text.
 */
async function seedLostFact(engine: BrainEngine) {
  const fence = renderFactsTable([
    { rowNum: 1, claim: 'Alice Example runs the platform team', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    { rowNum: 2, claim: LOST, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
  ] as never);
  const page = (body: string) => ({ type: 'person' as const, title: 'Alice Example', compiled_truth: body, timeline: '' });
  await engine.putPage(SLUG, page(`# Alice Example\n\nProse.\n\n## Facts\n\n${fence}\n`), { sourceId: 'default' });
  await engine.createVersion(SLUG, { sourceId: 'default' });
  await engine.putPage(SLUG, page('# Alice Example\n\nProse, rewritten without the facts section.\n'), { sourceId: 'default' });
  await engine.activateGenerationRows({ sourceId: 'default', kind: 'fact_fence', ownerKey: `page:${SLUG}` }, null,
    { generation: 1, runId: null, operationId: 'op-lost-1', inputPin: null, inputSize: null, completeness: '{}', setHash: 'set-1', restoreOf: null,
      activationId: null, locator: null },
    [{ item_key: 'row:2', identity_hash: 'identity-2', action: 'retired',
      preimage: { id: 987_654, fact: LOST, visibility: 'world', row_num: 2, entity_slug: SLUG, expired_at: null }, preimage_bytes: null, pending: false }]);
}


// ---- stale-atoms ----

/**
 * atoms/gone names a gone origin. notes/origin's content hash moved past atoms/changed (its hash is `oldhash`), and the
 * unmanaged atoms/new already holds the origin's new hash (the completed re-extraction).
 */
async function seedStaleAtoms(engine: BrainEngine) {
  const put = (slug: string, type: string, frontmatter: Record<string, unknown>) =>
    engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter }, { sourceId: 'default' });
  const origin = await put('notes/origin', 'note', {});
  const hash = String((origin as { content_hash?: string }).content_hash ?? (await engine.getPage('notes/origin', { sourceId: 'default' }))!.content_hash);
  await put('atoms/gone', 'atom', { source_slug: 'notes/gone', source_hash: 'h-gone' });
  await put('atoms/changed', 'atom', { source_slug: 'notes/origin', source_hash: 'oldhash' });
  await put('atoms/new', 'atom', { source_slug: 'notes/origin', source_hash: hash.slice(0, 16) });
}

// ---- generations ----

const GEN_OWNER = atomOwnerKey({ kind: 'page', slug: 'notes/origin' });

/**
 * notes/origin's atom key has two generations: the first published atoms/a and atoms/b, the live second kept atoms/a
 * and retired atoms/b, with no preimages, so a restore revives nothing and refuses both items. The key also has a held
 * result of two items.
 */
async function seedGenerations(engine: BrainEngine) {
  await engine.putPage('notes/origin', { type: 'note' as never, title: 'origin', compiled_truth: 'Origin body.', timeline: '' }, { sourceId: 'default' });
  for (const slug of ['atoms/a', 'atoms/b']) {
    await engine.putPage(slug, { type: 'atom' as never, title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter: { source_slug: 'notes/origin' } },
      { sourceId: 'default' });
  }
  const key = { sourceId: 'default', kind: 'atom', ownerKey: GEN_OWNER };
  const activation = (generation: number) => ({ generation, runId: 'run-a', operationId: `op-gen-${generation}`, inputPin: `pin-${generation}`, inputSize: 1,
    completeness: JSON.stringify({ complete: true }), setHash: `set-${generation}`, restoreOf: null, activationId: null, locator: null });
  const ledger = (item_key: string, action: string) => ({ item_key, identity_hash: `id-${item_key}`, action, preimage: null, preimage_bytes: null, pending: false });
  await engine.transaction(async tx => {
    const prev = await tx.activateGenerationRows(key, null, activation(1), [ledger('atoms/a', 'published'), ledger('atoms/b', 'published')]);
    await tx.activateGenerationRows(key, prev, activation(2), [ledger('atoms/a', 'kept'), ledger('atoms/b', 'retired')]);
  });
  await engine.transaction(tx => tx.recordHeldGenerationRow(key, { holdId: 'hold-a', runId: 'run-a', inputPin: 'held-pin', inputSize: 2, setHash: 'held-set',
    reason: 'shrunk', context: JSON.stringify({ owner: GEN_OWNER }), proposal: JSON.stringify([{ slug: 'atoms/p1' }, { slug: 'atoms/p2' }]), proposalBytes: 40 }));
}

describe('engine parity: the generation repair kinds of batch 7', () => {
  parityTest('lost-fence-rows previews a lost fact row and restores it the same way on every arm', {
    methods: ['putPage', 'createVersion', 'activateGenerationRows', 'listRetiredFenceItems', 'listInlineVersionTexts', 'hasActiveFactText',
      'readFactTrustTier', 'listFenceFactRowNums'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await seedLostFact(engine);
    const previewed = await runKind(engine, 'lost-fence-rows', false);
    expect(previewed.affected).toBe(1);
    const applied = await runKind(engine, 'lost-fence-rows', true, { expect: previewed.preview_hash });
    expect((await engine.getPage(SLUG, { sourceId: 'default' }))?.compiled_truth).toContain(LOST);
    return { preview: shape(previewed), applied: shape(applied) };
  }));

  parityTest('the lost-fence-rows members answer the same rows on every arm', {
    methods: ['putPage', 'createVersion', 'activateGenerationRows', 'insertFacts', 'addTakesBatch', 'listRetiredFenceItems', 'listInlineVersionTexts',
      'hasActiveFactText', 'hasTakeClaim', 'readFactTrustTier', 'listFenceFactRowNums', 'listTakeRowNums', 'readLiveFactRowTier', 'readTakeRowTierByClaim'],
    timeout: 60_000,
  }, async (engine) => {
    await seedLostFact(engine);
    const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
    const pageId = Number(page.id);
    const ins = await engine.insertFacts([
      { fact: 'Stored fact', kind: 'fact', entity_slug: SLUG, visibility: 'world', source: 'fence', row_num: 3, source_markdown_slug: SLUG },
      { fact: 'Private fact', kind: 'fact', entity_slug: SLUG, visibility: 'private', source: 'fence', row_num: 5, source_markdown_slug: SLUG },
    ] as never, { source_id: 'default' });
    await engine.addTakesBatch([{ page_id: pageId, row_num: 4, claim: 'A take', kind: 'bet', holder: 'world', weight: 0.6, active: true, superseded_by: null }] as never);
    const strip = (rows: Array<{ id: number }>) => rows.map(({ id, ...rest }) => { void id; return rest; });
    const tier = (row: { id: number; trust_tier: string | null } | null) => row && { trust_tier: row.trust_tier };
    return {
      retired: (await engine.listRetiredFenceItems(['default'], null)).map(({ retired_at, ...rest }) => ({ ...rest, retired_at: typeof retired_at })),
      retiredOne: (await engine.listRetiredFenceItems(['default'], { source_id: 'default', slug: SLUG })).length,
      retiredOther: (await engine.listRetiredFenceItems(['default'], { source_id: 'default', slug: 'people/nobody' })).length,
      versions: strip(await engine.listInlineVersionTexts(pageId)),
      activeWorld: await engine.hasActiveFactText('default', SLUG, 'Stored fact', 'world'),
      activePrivate: await engine.hasActiveFactText('default', SLUG, 'Stored fact', 'private'),
      takeClaim: await engine.hasTakeClaim(pageId, 'A take'),
      noTakeClaim: await engine.hasTakeClaim(pageId, 'No take'),
      factTier: await engine.readFactTrustTier(Number(ins.ids[0])),
      noFactTier: await engine.readFactTrustTier(999_999),
      factRows: await engine.listFenceFactRowNums('default', SLUG),
      takeRows: await engine.listTakeRowNums(pageId),
      liveFact: tier(await engine.readLiveFactRowTier('default', SLUG, 3, 'Stored fact')),
      noLiveFact: await engine.readLiveFactRowTier('default', SLUG, 3, 'Other text'),
      liveTake: tier(await engine.readTakeRowTierByClaim(pageId, 4, 'A take')),
      noLiveTake: await engine.readTakeRowTierByClaim(pageId, 4, 'Other claim'),
    };
  });
  parityTest('stale-atoms previews a gone-origin and a moved-origin atom the same way on every arm', {
    methods: ['putPage', 'listStaleAtoms'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await seedStaleAtoms(engine);
    const listed = (await engine.listStaleAtoms(['default'], null)).map(({ id, origin_page_id, incarnation, revision, origin_hash, evidence, ...rest }) => {
      void id; void incarnation; void revision;
      return { ...rest, has_origin: origin_page_id !== null, has_hash: origin_hash !== null, evidence: evidence?.replace(/\d+$/, '<id>') ?? null };
    });
    expect(listed.map(row => [row.slug, row.class])).toEqual([['atoms/gone', 'origin_gone'], ['atoms/changed', 'origin_changed']]);
    const previewed = await runKind(engine, 'stale-atoms', false);
    expect(previewed.affected).toBe(2);
    return { listed, preview: shape(previewed) };
  }));

  parityTest('the atom generation ledger reads 0, bumps, and keeps the kept content at its generation', {
    methods: ['putPage', 'readAtomGeneration', 'recordAtomGenerationBump', 'listSourceIncarnations'], timeout: 60_000,
  }, async (engine) => {
    const page = await engine.putPage('notes/ledger', { type: 'note' as never, title: 'ledger', compiled_truth: 'Ledger body.', timeline: '' }, { sourceId: 'default' });
    const [source] = await engine.listSourceIncarnations(['default']);
    const read = async () => [await engine.readAtomGeneration(page.id, 'hash-a'), await engine.readAtomGeneration(page.id, 'hash-b')];
    const before = await read();
    await engine.recordAtomGenerationBump('default', source!.incarnation, page.id, null, null);
    const first = await read();
    await engine.recordAtomGenerationBump('default', source!.incarnation, page.id, 'hash-a', await engine.readAtomGeneration(page.id, 'hash-a'));
    const kept = await read();
    return { before, first, kept };
  });

  parityTest('stale-atoms retires the approved atoms the same way on every arm', {
    methods: ['putPage', 'listStaleAtoms', 'readAtomGeneration', 'recordAtomGenerationBump'],
    timeout: 60_000,
  }, async (engine, backend) => withHome(async () => {
    await seedStaleAtoms(engine);
    const previewed = await runKind(engine, 'stale-atoms', false);
    expect(previewed.affected).toBe(2);
    try {
      const applied = await runKind(engine, 'stale-atoms', true, { expect: previewed.preview_hash });
      const gone = await engine.getPage('atoms/gone', { sourceId: 'default' });
      const changed = await engine.getPage('atoms/changed', { sourceId: 'default' });
      const kept = await engine.getPage('atoms/new', { sourceId: 'default' });
      expect([applied.applied, gone, changed, kept?.slug]).toEqual([2, null, null, 'atoms/new']);
      // The retirement of the moved-origin atom bumps notes/origin's atom ledger: the kept content keeps generation 0,
      // any other content keys on generation 1.
      const origin = (await engine.getPage('notes/origin', { sourceId: 'default' }))!;
      const generations = { kept: await engine.readAtomGeneration(origin.id, origin.content_hash!), other: await engine.readAtomGeneration(origin.id, 'other') };
      return { applied: shape(applied), gone: gone === null, changed: changed === null, kept: kept?.slug ?? null, generations };
    } catch (err) {
      if (backend === 'rust') expect(refusalText(err)).toContain('repair stale-atoms retirement');
      throw err;
    }
  }));

  parityTest('generations previews a restore and a held release of an atom key the same way on every arm', {
    methods: ['putPage', 'activateGenerationRows', 'recordHeldGenerationRow', 'listRestorableGenerationRows', 'listHeldGenerationRows',
      'readGenerationItemsByIds', 'listSourceIncarnations'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await seedGenerations(engine);
    const restore = await runKind(engine, 'generations', false, { generations: { kind: 'atom', mode: 'restore', key: GEN_OWNER } });
    const release = await runKind(engine, 'generations', false, { generations: { kind: 'atom', mode: 'release-held', held: true } });
    expect([restore.affected, release.affected]).toEqual([1, 1]);
    return { restore: shape(restore), release: shape(release) };
  }));
});
