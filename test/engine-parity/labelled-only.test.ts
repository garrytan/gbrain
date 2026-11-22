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
 *  - Known losses on Rust (rows 32e-2 and 32e-3): a labelled-only caller's remote read floor, and a labelled-only
 *    caller with lineage or an audience. The last describe pins each: Rust refuses and shows nothing while PGLite
 *    serves, so a pin fails when Rust stops refusing and its row must leave the table.
 *  - Why existing coverage misses it: access-members.test.ts reads one core-page list and pins the Rust refusal;
 *    test/access-labelled-only.test.ts runs on the SQL engines only.
 *  - Seam: none. Members through addMember and setMemberLabelledOnly, rules through proposeRevision, pages through
 *    putPage, facts through insertFacts; each caller is the stdio server bound to the member (mcp.stdio_member).
 */
import { describe, expect, test } from 'bun:test';
import { parityArms, resetArm } from './harness.ts';
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

/** A labelled-only caller captured before a rule moves, read after the move and before the restamp. */
async function pendingRuleMove(engine: BrainEngine) {
  await seed(engine);
  await engine.setConfig('mcp.stdio_member', 'alice-example');
  const captured = await remoteCallerAccess(engine, undefined, [], 'stdio');
  await engine.applyAccessRuleChanges('default', {
    remove: ['deals'], insert: [{ rule_id: 'deals', prefix: 'core/', readable_by: ['member:alice-example'], covers_derived: true }],
    pending: ['core/'], revision: 2, actor: 'test',
  });
  // Only core/ is the case: the moved rule's old pages are not under a pending prefix, and no restamp has run.
  const alice = (await withCallerAccess(captured, () => corePages(engine))).filter(slug => slug.startsWith('core/'));
  expect(alice).toEqual(['core/for-alice', 'core/for-team']);
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
  // restamped core/open yet (its folder_rule_ids is still empty), so the page is still unlabelled for the caller.
  parityTest('a pending rule move does not label an unstamped page for a labelled-only caller captured before it', {
    methods: ['listCorePageRows', 'applyAccessRuleChanges'],
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
  ] as const) {
    test(`${name} on Rust`, async () => {
      const rust = arms().find((arm) => arm.backend === 'rust');
      if (!rust) return;
      await resetArm(rust);
      await scenario(rust.engine);
    });
  }
});

describe('the Rust arm refuses what it does not serve yet (rows 32e-2 and 32e-3), and shows nothing', () => {
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
});
