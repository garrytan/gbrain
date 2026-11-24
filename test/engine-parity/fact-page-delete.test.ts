/**
 * BrainEngine parity: what deleting a page does to the facts about it.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: facts hold no foreign key to pages. A hard `deletePage` leaves every fact about the
 *    page live: a fence fact written on the page itself, a fence fact on another page and a loose
 *    remembered fact. A soft delete hides them from reads while the page is deleted, and
 *    `purgeDeletedPages` then expires the page's own fence fact and the loose fact about it and
 *    keeps the fence fact another page wrote. Every engine does the same.
 *  - Regression: an engine that drops or expires facts on a hard delete (lost memory), or keeps a
 *    purged page's facts live (a forgotten page answering recall), differs from the others.
 *  - Why existing coverage misses it: the fact purge parity files start from a purge plan, and the
 *    page delete parity cases read pages and chunks, not facts.
 *  - Seam: none. Real engines, typed members only.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const PAGE = 'people/deleted-example';
const OTHER = 'notes/other-example';

type Row = { fact: string; expired_at: Date | null; valid_until: Date | null };
const view = (rows: Row[]) =>
  rows.map((r) => `${r.fact} expired=${r.expired_at instanceof Date} until=${r.valid_until instanceof Date}`).sort();

/** The facts about the page as recall reads them: every row, active rows, and rows by the page that wrote them. */
async function factsAbout(engine: BrainEngine) {
  return {
    all: view(await engine.listFactsByEntity(SRC, PAGE, { activeOnly: false, limit: 100 })),
    active: view(await engine.listFactsByEntity(SRC, PAGE, { limit: 100 })),
    writtenOnPage: view(await engine.listFactsSince(SRC, new Date(0), { sourceMarkdownSlug: PAGE, activeOnly: false, limit: 100 })),
    writtenOnOther: view(await engine.listFactsSince(SRC, new Date(0), { sourceMarkdownSlug: OTHER, activeOnly: false, limit: 100 })),
  };
}

async function seed(engine: BrainEngine): Promise<void> {
  await engine.putPage(PAGE, { type: 'person' as never, title: 'Deleted Example', compiled_truth: 'About the deleted example.', timeline: '' });
  await engine.putPage(OTHER, { type: 'note' as never, title: 'Other Example', compiled_truth: 'Another page.', timeline: '' });
  const own = await engine.insertFacts([{ fact: 'fence fact on its own page', entity_slug: PAGE, source_markdown_slug: PAGE, row_num: 1, source: 'fence' }], { source_id: SRC });
  const other = await engine.insertFacts([{ fact: 'fence fact on another page', entity_slug: PAGE, source_markdown_slug: OTHER, row_num: 2, source: 'fence' }], { source_id: SRC });
  const loose = await engine.insertFact({ fact: 'loose remembered fact', entity_slug: PAGE, source: 'mcp:remember' }, { source_id: SRC });
  expect([own.inserted, other.inserted, loose.status]).toEqual([1, 1, 'inserted']);
}

parityTest(
  'a hard page delete leaves every fact about the page live',
  { methods: ['deletePage', 'insertFacts', 'insertFact', 'listFactsByEntity', 'listFactsSince'] },
  async (engine) => {
    await seed(engine);
    const before = await factsAbout(engine);
    await engine.deletePage(PAGE, { sourceId: SRC });
    const after = await factsAbout(engine);
    // Not vacuous: all three facts are there before, and the delete really removed the page.
    expect(before.active).toHaveLength(3);
    expect(await engine.getPage(PAGE, { sourceId: SRC })).toBeNull();
    return { before, after };
  },
);

parityTest(
  'a soft delete hides the facts and a purge expires the page-owned ones',
  { methods: ['softDeletePage', 'purgeDeletedPages', 'listFactsByEntity', 'listFactsSince'] },
  async (engine) => {
    await seed(engine);
    await engine.softDeletePage(PAGE, { sourceId: SRC });
    const softDeleted = await factsAbout(engine);
    const purged = await engine.purgeDeletedPages(0);
    const after = await factsAbout(engine);
    expect(purged.slugs).toEqual([PAGE]);
    expect(after.all).toHaveLength(3);
    return { softDeleted, purged: purged.slugs, after };
  },
);
