/**
 * BrainEngine parity — the held fence cells of a world-only fact read (engine-sql/cli-reads-ops.ts `listHeldFenceCells`,
 * eligibility/stamp.ts `heldFenceLines` and `dropHeldFenceRows`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for a caller whose fact reads are world-only, a facts-fence row line of a page's text is held when the
 *    live fact at its row number is stored narrower than world, or when a live narrower fact of the page states its
 *    claim (contains it, for a line cut by a chunk boundary) and no live world fact of the page states it. Every engine
 *    arm names the same held cells, and `dropHeldFenceRows` leaves the same text, for a caller with no member identity
 *    and no private-facts grant.
 *  - Regression: the lookup ran through `executeRaw`, which the Rust engine refuses. The lookup's `catch` then held
 *    every fence row line, so get_page, get_chunks, think and search_exact on a Rust brain dropped every fence row,
 *    held or not, while the SQL engines dropped only the held ones.
 *  - Why existing coverage misses it: test/held-row-*-2891.test.ts run the SQL engines only, and no parity case read
 *    the held lookup.
 *  - Seam: none. Real engines, typed methods only; the caller context is the default one (no member, no grant), and a
 *    member caller (`withCallerAccess` with a `member:` identity), whose own member page's private facts are not held.
 *  - Member regression: the Rust member refused a member caller, so heldFenceLines held every fence row line of the
 *    member's own page, while the SQL engines showed the member the rows of its own private facts.
 *  - Grant regression: the Rust member refused a caller with a private-facts grant (GBRA-575), so heldFenceLines held
 *    every fence row line of a granted source, while the SQL engines showed that caller the rows of the private facts
 *    its grant admits (an open, live holding page; never an unpaged or transcript-lane fact).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dropHeldFenceRows } from '../../src/core/eligibility/stamp.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'people/held-example';
const OTHER = 'people/other-example';

const line = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium |  |  |  |  |`;

/**
 * Fixture: the page's stored facts. Row 2 is stored private at its own number; `sings opera` is a private restatement
 * at row 5 that no world fact states; `paints` is private at row 6 but row 4 states it at world; row 8 is private but
 * expired; `walks dogs daily` is private at row 7, so a claim cut to `Ana walks` is held only where it is partial.
 * The other page holds one private fact, at row 3; this page's private row 2 must not hold the other page's row 2.
 */
async function seed(engine: BrainEngine): Promise<void> {
  const fact = (slug: string, row_num: number, text: string, visibility: 'world' | 'private') =>
    ({ fact: text, entity_slug: slug, source_markdown_slug: slug, row_num, kind: 'fact' as const, visibility, source: 'fence' });
  const { ids } = await engine.insertFacts([
    fact(SLUG, 1, 'Ana lives in Lima', 'world'),
    fact(SLUG, 2, 'Ana keeps bees tapirheld', 'private'),
    fact(SLUG, 4, 'Ana paints', 'world'),
    fact(SLUG, 5, 'Ana sings opera', 'private'),
    fact(SLUG, 6, 'Ana paints', 'private'),
    fact(SLUG, 7, 'Ana walks dogs daily', 'private'),
    fact(SLUG, 8, 'Ana rode horses', 'private'),
    fact(OTHER, 3, 'Ana lives in Lima', 'private'),
  ] as never, { source_id: SRC });
  await engine.expireFact(ids[6]!);
}

const TEXT = ['Profile prose.', line(1, 'Ana lives in Lima'), line(2, 'Ana keeps bees tapirheld'), line(3, 'Ana sings opera'),
  line(4, 'Ana paints'), line(8, 'Ana rode horses'), line(10, 'Ana walks'), line(9, 'Ana walks')].join('\n');

describe('engine parity: the held fence cells of a world-only fact read', () => {
  parityTest('dropHeldFenceRows removes only the held fence row lines', {
    methods: ['insertFacts', 'expireFact', 'listHeldFenceCells'],
  }, async (engine) => {
    await seed(engine);
    const kept = await dropHeldFenceRows(engine, [
      { source_id: SRC, slug: SLUG, chunk_text: TEXT },
      { source_id: SRC, slug: OTHER, chunk_text: ['Other prose.', line(3, 'Ana lives in Lima'), line(2, 'Ana keeps bees tapirheld'), 'Tail.'].join('\n') },
      { source_id: SRC, slug: SLUG, chunk_text: line(2, 'Ana keeps bees tapirheld') },
    ]);
    const texts = kept.map((k) => k.chunk_text);
    expect(texts).toEqual([
      ['Profile prose.', line(1, 'Ana lives in Lima'), line(4, 'Ana paints'), line(8, 'Ana rode horses'), line(10, 'Ana walks')].join('\n'),
      ['Other prose.', line(2, 'Ana keeps bees tapirheld'), 'Tail.'].join('\n'),
    ]);
    return texts;
  });

  parityTest('listHeldFenceCells names each held cell once, by row number, restatement and cut claim', {
    methods: ['insertFacts', 'expireFact', 'listHeldFenceCells'],
  }, async (engine) => {
    await seed(engine);
    const key = (slug: string, rowNum: number, claim: string, partial = false) => ({ sourceId: SRC, slug, rowNum, claim, partial });
    const found = await engine.listHeldFenceCells([
      key(SLUG, 1, 'Ana lives in Lima'),
      key(SLUG, 2, 'Ana keeps bees tapirheld'),
      key(SLUG, 2, 'Ana keeps bees tapirheld', true),
      key(SLUG, 3, 'Ana sings opera'),
      key(SLUG, 4, 'Ana paints'),
      key(SLUG, 8, 'Ana rode horses'),
      key(SLUG, 10, 'Ana walks'),
      key(SLUG, -1, 'Ana walks', true),
      key(SLUG, -1, 'sings', true),
      key(OTHER, 2, 'Ana keeps bees tapirheld'),
      key(OTHER, 3, 'Ana lives in Lima'),
      { sourceId: 'source-b', slug: SLUG, rowNum: 2, claim: 'Ana keeps bees tapirheld', partial: false },
    ]);
    const cells = sorted(found.map((f) => `${f.source_id}|${f.slug}|${f.row_num}|${f.claim}`));
    expect(cells).toEqual(sorted([
      `${SRC}|${SLUG}|2|Ana keeps bees tapirheld`,
      `${SRC}|${SLUG}|3|Ana sings opera`,
      `${SRC}|${SLUG}|-1|Ana walks`,
      `${SRC}|${SLUG}|-1|sings`,
      `${SRC}|${OTHER}|3|Ana lives in Lima`,
    ]));
    expect(await engine.listHeldFenceCells([])).toEqual([]);
    return cells;
  });

  // A member caller: its own member page's private facts are admitted (memberFactAdmitSql), only while it may read that
  // live page; another member's page and an ordinary page stay held.
  const OWN = 'memory/members/alice-example';
  const BOB = 'memory/members/bob-example';
  const ALICE = { hidePrivate: true, identity: ['member:alice-example'] };
  const memberPage = (engine: BrainEngine, slug: string, readers: string[]) =>
    engine.putPage(slug, { type: 'note', title: 'Member memory', compiled_truth: 'body', timeline: '', frontmatter: { readable_by: readers } });
  const memberFacts = (engine: BrainEngine) => engine.insertFacts([
    { fact: 'Alice drinks tea', entity_slug: OWN, source_markdown_slug: OWN, row_num: 1, kind: 'fact', visibility: 'private', source: 'fence' },
    { fact: 'Bob drinks tea', entity_slug: BOB, source_markdown_slug: BOB, row_num: 1, kind: 'fact', visibility: 'private', source: 'fence' },
  ] as never, { source_id: SRC });
  const memberKeys = [
    { sourceId: SRC, slug: OWN, rowNum: 1, claim: 'Alice drinks tea', partial: false },
    { sourceId: SRC, slug: OWN, rowNum: -1, claim: 'drinks', partial: true },
    { sourceId: SRC, slug: BOB, rowNum: 1, claim: 'Bob drinks tea', partial: false },
    { sourceId: SRC, slug: SLUG, rowNum: 2, claim: 'Ana keeps bees tapirheld', partial: false },
  ];
  const cellsOf = (found: { source_id: string; slug: string; row_num: number; claim: string }[]) =>
    sorted(found.map((f) => `${f.source_id}|${f.slug}|${f.row_num}|${f.claim}`));

  parityTest('a member caller sees the fence rows of its own member page facts', {
    methods: ['putPage', 'insertFacts', 'expireFact', 'listHeldFenceCells'],
  }, async (engine) => {
    await seed(engine);
    await memberPage(engine, OWN, ['alice-example']);
    await memberPage(engine, BOB, ['bob-example']);
    await memberFacts(engine);
    const cells = cellsOf(await withCallerAccess(ALICE, () => engine.listHeldFenceCells(memberKeys)));
    expect(cells).toEqual(sorted([
      `${SRC}|${BOB}|1|Bob drinks tea`,
      `${SRC}|${SLUG}|2|Ana keeps bees tapirheld`,
    ]));
    // The same keys with no member caller hold every private cell.
    const plain = cellsOf(await engine.listHeldFenceCells(memberKeys));
    expect(plain).toEqual(sorted([
      `${SRC}|${OWN}|1|Alice drinks tea`,
      `${SRC}|${OWN}|-1|drinks`,
      `${SRC}|${BOB}|1|Bob drinks tea`,
      `${SRC}|${SLUG}|2|Ana keeps bees tapirheld`,
    ]));
    return [cells, plain];
  });

  parityTest('a member caller whose own page does not name it, or is soft-deleted, sees those rows held', {
    methods: ['putPage', 'insertFacts', 'softDeletePage', 'listHeldFenceCells'],
  }, async (engine) => {
    await memberPage(engine, OWN, ['bob-example']);
    await memberPage(engine, BOB, ['bob-example']);
    await memberFacts(engine);
    const unnamed = cellsOf(await withCallerAccess(ALICE, () => engine.listHeldFenceCells(memberKeys.slice(0, 2))));
    await memberPage(engine, OWN, ['alice-example']);
    const named = cellsOf(await withCallerAccess(ALICE, () => engine.listHeldFenceCells(memberKeys.slice(0, 2))));
    await engine.softDeletePage(OWN);
    const deleted = cellsOf(await withCallerAccess(ALICE, () => engine.listHeldFenceCells(memberKeys.slice(0, 2))));
    const held = sorted([`${SRC}|${OWN}|1|Alice drinks tea`, `${SRC}|${OWN}|-1|drinks`]);
    expect(unnamed).toEqual(held);
    expect(named).toEqual([]);
    expect(deleted).toEqual(held);
    return [unnamed, named, deleted];
  });

  // A caller with a private-facts grant (privateFactSources): a private fact in a granted source on a live, open page
  // is admitted (grantedPrivateFactSql); a private page, a transcript-lane fact, a grant on another source and a
  // soft-deleted page stay held.
  const GRANTED = 'notes/granted-example';
  const SECRET = 'notes/secret-example';
  const grantPage = (engine: BrainEngine, slug: string, frontmatter: Record<string, unknown>) =>
    engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body', timeline: '', frontmatter });
  const grantFacts = (engine: BrainEngine) => engine.insertFacts([
    { fact: 'Ana grows figs', entity_slug: GRANTED, source_markdown_slug: GRANTED, row_num: 1, kind: 'fact', visibility: 'private', source: 'fence' },
    { fact: 'Ana lives in Quito', entity_slug: GRANTED, source_markdown_slug: GRANTED, row_num: 2, kind: 'fact', visibility: 'world', source: 'fence' },
    { fact: 'Ana naps daily', entity_slug: GRANTED, source_markdown_slug: GRANTED, row_num: 3, kind: 'fact', visibility: 'private', source: 'transcript:chat' },
    { fact: 'Ana hides gold', entity_slug: SECRET, source_markdown_slug: SECRET, row_num: 1, kind: 'fact', visibility: 'private', source: 'fence' },
  ] as never, { source_id: SRC });
  const grantKeys = [
    { sourceId: SRC, slug: GRANTED, rowNum: 1, claim: 'Ana grows figs', partial: false },
    { sourceId: SRC, slug: GRANTED, rowNum: -1, claim: 'figs', partial: true },
    { sourceId: SRC, slug: GRANTED, rowNum: 2, claim: 'Ana lives in Quito', partial: false },
    { sourceId: SRC, slug: GRANTED, rowNum: 3, claim: 'Ana naps daily', partial: false },
    { sourceId: SRC, slug: SECRET, rowNum: 1, claim: 'Ana hides gold', partial: false },
  ];
  const GRANT = { hidePrivate: true, privateFactSources: [SRC] };
  const OTHER_GRANT = { hidePrivate: true, privateFactSources: ['other-source'] };

  parityTest('a caller with a private-facts grant sees the fence rows its grant admits', {
    methods: ['putPage', 'insertFacts', 'softDeletePage', 'listHeldFenceCells'],
  }, async (engine) => {
    await grantPage(engine, GRANTED, {});
    await grantPage(engine, SECRET, { visibility: 'private' });
    await grantFacts(engine);
    const granted = cellsOf(await withCallerAccess(GRANT, () => engine.listHeldFenceCells(grantKeys)));
    const plain = cellsOf(await engine.listHeldFenceCells(grantKeys));
    const other = cellsOf(await withCallerAccess(OTHER_GRANT, () => engine.listHeldFenceCells(grantKeys)));
    await engine.softDeletePage(GRANTED);
    const deleted = cellsOf(await withCallerAccess(GRANT, () => engine.listHeldFenceCells(grantKeys)));
    const everyPrivate = sorted([
      `${SRC}|${GRANTED}|1|Ana grows figs`,
      `${SRC}|${GRANTED}|-1|figs`,
      `${SRC}|${GRANTED}|3|Ana naps daily`,
      `${SRC}|${SECRET}|1|Ana hides gold`,
    ]);
    expect(granted).toEqual(sorted([`${SRC}|${GRANTED}|3|Ana naps daily`, `${SRC}|${SECRET}|1|Ana hides gold`]));
    expect(plain).toEqual(everyPrivate);
    expect(other).toEqual(everyPrivate);
    expect(deleted).toEqual(everyPrivate);
    return [granted, plain, other, deleted];
  });
});
